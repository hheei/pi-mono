import type { ExtensionAPI, ExtensionUIContext, Skill } from "@earendil-works/pi-coding-agent";
import {
	type BackgroundDelivery,
	createRenderThrottle,
	DEFAULT_MAX_BYTES,
	errorMessage,
	fitsOutputBudget,
	getBackgroundDelivery,
	provideService,
	registerExtensionLifecycle,
	truncateWithSpill,
} from "@hheei/pi-ext-core";
import { discoverAgents, type SkillCatalogEntry } from "./agent-resolver.js";
import { registerChildBridge } from "./child-bridge.js";
import { registerParentCommands } from "./commands.js";
import { activeControllerRole } from "./controller-role.js";
import type { ChildIdentity, PanelHost, RuntimeAttachment, SubagentRecord } from "./domain.js";
import { BRIDGE_ENVIRONMENT_KEYS, isOperationError, isThinkingLevel } from "./domain.js";
import {
	createCmuxHostAdapter,
	createHerdrHostAdapter,
	createRexHostAdapter,
	type HostAttachment,
	type HostAttachmentIdentity,
	listCmuxAttachments,
	listHerdrAttachments,
	listRexAttachments,
	rebindCmuxSurface,
	rebindHerdrTab,
	rebindRexBlock,
	selectHostAdapter,
	systemHostCommandRunner,
} from "./host-adapter.js";
import { appendSubagentInfo, displaySubagentText, registerSubagentInfo } from "./info.js";
import type { HostList } from "./lease.js";
import { createMailboxTransport } from "./mailbox.js";
import { type ParentChannel, type ParentChannelReport, SubagentManager } from "./manager.js";
import { transformSubagentsMarkdown } from "./markdown.js";
import { createSubagentOwnership, SUBAGENT_OWNERSHIP_SERVICE } from "./ownership.js";
import { sweepUncertainDispatch } from "./receipts.js";
import { createSubagentRegistry } from "./registry.js";
import { launchChild, openChildPanel, prepareRuntimeDirectory } from "./runtime.js";
import { persistSubagentIntent, resolveSubagentLaunch } from "./session-bootstrap.js";
import { createSubagentStatus } from "./status.js";
import { registerInteractiveToolActivation } from "./tool-activation.js";
import { registerParentTools } from "./tools.js";

const CHILD_ENV_KEYS = Object.values(BRIDGE_ENVIRONMENT_KEYS);

/** How long startup waits for a child that survived a parent restart to reconnect its bridge. */
const ADOPT_WINDOW_MS = 5_000;
const START_WINDOW_MS = 20_000;

function diagnose(message: string): void {
	if (process.env.DEBUG || process.env.PI_SUBAGENTS_DEBUG) {
		console.error(`pi-subagents: ${message}`);
	}
}

/** Parent channel plus the teardown its owner must call. */
export interface ParentChannelHandle extends ParentChannel {
	/** Unregisters delivery and appends anything still held without waking the parent. */
	dispose(): void;
}

function requiredBridgeValue(env: NodeJS.ProcessEnv, key: string): string {
	const value = env[key];
	if (typeof value !== "string" || value === "") {
		throw new Error("Invalid partial pi-subagents child identity environment");
	}
	return value;
}

function childIdentityFromEnv(env: NodeJS.ProcessEnv): ChildIdentity | undefined {
	const present = CHILD_ENV_KEYS.filter((key) => env[key] !== undefined);
	if (present.length === 0) return undefined;
	return {
		parentSessionId: requiredBridgeValue(env, BRIDGE_ENVIRONMENT_KEYS.parentSessionId),
		subagentId: requiredBridgeValue(env, BRIDGE_ENVIRONMENT_KEYS.childId),
		runtimeIdentity: requiredBridgeValue(env, BRIDGE_ENVIRONMENT_KEYS.runtimeId),
		endpoint: requiredBridgeValue(env, BRIDGE_ENVIRONMENT_KEYS.endpoint),
	};
}

/**
 * How child reports reach the parent conversation.
 *
 * Busy parents receive a steer into the next model step. Idle parents get one new turn per
 * microtask batch; the shared coordinator makes this channel and the Bash one agree on which
 * message requests it.
 */
/**
 * The host's own listing of what still exists. Recovery asks one question — is this attachment still
 * there? — and each host answers it with its own inventory.
 */
function listHostAttachments(
	host: PanelHost,
	env: NodeJS.ProcessEnv = process.env,
): Promise<HostList> {
	switch (host) {
		case "herdr":
			return listHerdrAttachments(systemHostCommandRunner, 10_000, { env });
		case "cmux":
			return listCmuxAttachments(systemHostCommandRunner, 10_000);
		case "rex":
			return listRexAttachments(systemHostCommandRunner, 10_000, { env });
	}
}

/** A panel that survived a parent reload is watched, never reopened: the child owns its own TUI. */
function rebindHostAttachment(options: {
	readonly host: PanelHost;
	readonly attachmentId: string;
	readonly ownerId: string;
	readonly ownsAttachment: (identity: HostAttachmentIdentity) => boolean;
}): HostAttachment {
	switch (options.host) {
		case "herdr":
			return rebindHerdrTab({
				tabId: options.attachmentId,
				ownerId: options.ownerId,
				ownsAttachment: options.ownsAttachment,
			});
		case "cmux":
			return rebindCmuxSurface({
				surfaceId: options.attachmentId,
				ownerId: options.ownerId,
				ownsAttachment: options.ownsAttachment,
			});
		case "rex":
			return rebindRexBlock({
				blockId: options.attachmentId,
				ownerId: options.ownerId,
				ownsAttachment: options.ownsAttachment,
			});
	}
}

export function createParentChannel(
	pi: Pick<ExtensionAPI, "sendMessage" | "on" | "appendEntry">,
	deps: {
		readonly isIdle: () => boolean;
		readonly ui: Pick<ExtensionUIContext, "notify">;
		readonly delivery: BackgroundDelivery;
		readonly signal?: AbortSignal;
	},
): ParentChannelHandle {
	const held: ParentChannelReport[] = [];
	let disposed = false;

	const flush = (triggerTurn: boolean): void => {
		if (held.length === 0) return;
		const reports = [...held];
		held.length = 0;
		try {
			pi.sendMessage(
				{
					customType: "subagent-report",
					content: reports.map(reportText).join("\n\n"),
					display: false,
					details: { reports },
				},
				{ triggerTurn, deliverAs: "steer" },
			);
		} catch (error) {
			held.unshift(...reports);
			throw error;
		}
		for (const report of reports) {
			try {
				appendSubagentInfo(pi, report);
			} catch (error) {
				// The model already received this batch; an entry failure must not resend it.
				deps.ui.notify(
					displaySubagentText(
						`Could not display subagent report for ${report.childId}: ${errorMessage(error)}`,
					),
					"error",
				);
			}
		}
	};

	const registration = deps.delivery.registerChannel({
		isIdle: deps.isIdle,
		hasPending: () => !deps.signal?.aborted && held.length > 0,
		flush,
	});
	const stopWatching = pi.on("agent_start", () => registration.request());
	const stopSettled = pi.on("agent_settled", () => registration.request());

	return {
		async deliver(report: ParentChannelReport): Promise<void> {
			if (disposed) throw new Error("Parent report channel is disposed");
			// A report that already fits stays on the synchronous path: a batch is flushed in the same
			// microtask, and awaiting a spill that will not happen would delay every ordinary report.
			held.push(
				fitsOutputBudget(report.message, REPORT_LIMITS) ? report : await cappedReport(report),
			);
			registration.request();
		},
		dispose(): void {
			disposed = true;
			registration.dispose();
			stopWatching();
			stopSettled();
			// The session is going away, so the held reports are appended for the record without
			// starting a run in a parent that is being torn down.
			flush(false);
		},
	};
}

/**
 * Pi publishes the skills it loaded with every prompt; a definition names them the same way, so
 * the launch path needs exactly the name and the file path from that list.
 */
export function skillCatalogFromLoaded(skills: readonly Skill[]): readonly SkillCatalogEntry[] {
	return skills.map((skill) => ({ name: skill.name, path: skill.filePath }));
}

function reportText(report: ParentChannelReport): string {
	return `[Subagent ${report.agent} ${report.childId}: ${report.reason}]\n${report.message}`;
}

/**
 * A child's final answer is a result the parent reads, so it obeys the shared budget. It is stored
 * as plain text rather than pointing back at the child's transcript: a transcript is JSONL that must
 * be parsed to find the one message, which costs more than the copy.
 */
const REPORT_LIMITS = { maxBytes: DEFAULT_MAX_BYTES, maxLines: Number.POSITIVE_INFINITY };

async function cappedReport(report: ParentChannelReport): Promise<ParentChannelReport> {
	const spilled = await truncateWithSpill(report.message, `sub-${report.childId}`, REPORT_LIMITS);
	return spilled.truncated ? { ...report, message: spilled.text } : report;
}

export default function piSubagentsExtension(pi: ExtensionAPI): void {
	const child = childIdentityFromEnv(process.env);
	if (child !== undefined) {
		registerChildBridge(pi, child);
		return;
	}
	registerSubagentInfo(pi);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-subagents",
		async start(runtime): Promise<void> {
			const context = runtime.extension;
			const parentSessionId = context.sessionManager.getSessionId();
			const registry = createSubagentRegistry({ parentSessionId });
			sweepUncertainDispatch(registry.path, parentSessionId);
			// Presentation is chosen once per parent session: herdr first, then cmux, and a parent with
			// neither runs every child in the background. Successful selection stays silent; only actual
			// failures and fallback diagnostics are reported by the launch path.
			const ownerId = parentSessionId;
			const ownsAttachment = (identity: HostAttachmentIdentity): boolean =>
				identity.createdBy === ownerId;
			const controller = activeControllerRole();
			const hostSelection = controller
				? {
						available: false as const,
						selectedHost: null,
						reason: "standalone controller keeps children in the background",
					}
				: await selectHostAdapter({
						adapters: {
							herdr: createHerdrHostAdapter({ ownerId, ownsAttachment }),
							cmux: createCmuxHostAdapter({ ownerId, ownsAttachment }),
							rex: createRexHostAdapter({ ownerId, ownsAttachment }),
						},
					});
			const parentChannel =
				controller ??
				createParentChannel(pi, {
					isIdle: () => context.isIdle(),
					ui: context.ui,
					delivery: getBackgroundDelivery(pi),
					signal: runtime.signal,
				});
			runtime.resources.add("parent-channel", () => parentChannel.dispose());
			let manager!: SubagentManager;
			// Owned work belongs to its owner: an owned child's report never reaches this
			// conversation, so a consumer's review cannot wake the parent by itself. The claim is
			// durable, so a provider that dies first leaves evidence instead of an ordinary child.
			const ownership = createSubagentOwnership({
				parentSessionId,
				statePath: registry.path,
				async stop(id) {
					// A claim can outlive the record it was written before; nothing to end then.
					if ((await registry.get(id)) === undefined) return undefined;
					const stopped = await manager.stop(id);
					return isOperationError(stopped) ? `${id}: ${stopped.reason}` : undefined;
				},
			});
			const channel: ParentChannel = {
				deliver(report) {
					return ownership.guard.deliver(report)
						? Promise.resolve()
						: parentChannel.deliver(report);
				},
			};
			if (controller !== undefined) {
				controller.applied = true;
				const model = context.model;
				if (model !== undefined && model.id !== "unknown") {
					controller.provider = model.provider;
					controller.modelId = model.id;
					const key = await context.modelRegistry.getApiKeyForProvider(model.provider);
					controller.credential = typeof key === "string" && key !== "" ? "present" : "missing";
				}
			}
			// One sqlite file is the ledger and the mailbox. Presence is not liveness.
			const mailbox = createMailboxTransport({
				filePath: registry.path,
				parentSessionId,
				handleRequest: (request) =>
					manager.handleChildRequest(request.childId, request.operation, request.payload),
				diagnose,
			});
			await prepareRuntimeDirectory(diagnose);
			runtime.resources.add("subagent-bridge", () => mailbox.close());
			// A definition names skills the way Pi lists them, so the parent's loaded skill set is
			// the only name → path catalog; Pi hands it over before every prompt of this session.
			let skillCatalog: readonly SkillCatalogEntry[] = controller?.skills ?? [];
			if (controller === undefined) {
				const unsubscribeSkillCatalog = pi.on("before_agent_start", (event) => {
					const skills =
						(event.systemPromptOptions as { skills?: readonly Skill[] } | undefined)?.skills ?? [];
					skillCatalog = skillCatalogFromLoaded(skills);
				});
				runtime.resources.add("subagent-skill-catalog", unsubscribeSkillCatalog);
			}
			const closeOldAttachment = (record: SubagentRecord) => {
				const old = record.runtime?.attachment;
				if (old?.kind !== "panel") return undefined;
				return async () => {
					try {
						const handle = rebindHostAttachment({
							host: old.host,
							attachmentId: old.id,
							ownerId,
							ownsAttachment,
						});
						await handle.cleanup();
					} catch {}
				};
			};

			manager = new SubagentManager({
				parentSessionId,
				registry,
				channel,
				async resolve(input) {
					const model = context.model;
					if (model === undefined) throw new Error("No parent model is selected");
					const thinking = context.thinkingLevel ?? pi.getThinkingLevel();
					if (!isThinkingLevel(thinking)) {
						throw new Error(`Unsupported parent thinking level: ${thinking}`);
					}
					const records = await registry.list().catch(() => []);
					const existingSubagentIds = records.map((record) => record.subagentId);
					return resolveSubagentLaunch({
						input,
						cwd: context.cwd,
						modelRegistry: context.modelRegistry,
						skillCatalog,
						existingSubagentIds,
						enforceEnabled: true,
						parent: {
							model: { provider: model.provider, id: model.id },
							thinking,
						},
					});
				},
				bootstrap(input) {
					return persistSubagentIntent({ registry, ...input });
				},
				bridge: mailbox,
				ownership: ownership.guard,
				launch(record) {
					return launchChild({
						registry,
						record,
						waitForBridge: (childId, signal) =>
							mailbox.waitUntilSeen(childId, {
								timeoutMs: START_WINDOW_MS,
								...(signal === undefined ? {} : { signal }),
							}),
						signal: runtime.signal,
						diagnose,
					});
				},
				presentation: {
					reason: hostSelection.reason,
					...(hostSelection.available
						? {
								openPanel: (record) =>
									openChildPanel({
										registry,
										record,
										host: hostSelection.adapter,
										waitForBridge: (childId, signal) =>
											mailbox.waitUntilSeen(childId, {
												timeoutMs: START_WINDOW_MS,
												...(signal === undefined ? {} : { signal }),
											}),
										closeOldAttachment: closeOldAttachment(record),
										signal: runtime.signal,
										diagnose,
									}),
							}
						: {}),
				},
				// Adoption is a wait, never a spawn: a child that survived this parent reconnects on
				// its own, and one that did not stays recorded until a send starts it again.
				connect(record) {
					return mailbox.waitUntilSeen(record.subagentId, {
						timeoutMs: ADOPT_WINDOW_MS,
						signal: runtime.signal,
					});
				},
				...(hostSelection.available
					? {
							directory: {
								host: hostSelection.selectedHost,
								list: () => listHostAttachments(hostSelection.selectedHost),
								open: async (record: SubagentRecord) => {
									const launch = await openChildPanel({
										registry,
										record,
										host: hostSelection.adapter,
										waitForBridge: (childId: string, signal?: AbortSignal) =>
											mailbox.waitUntilSeen(childId, {
												timeoutMs: START_WINDOW_MS,
												...(signal === undefined ? {} : { signal }),
											}),
										closeOldAttachment: closeOldAttachment(record),
										signal: runtime.signal,
										diagnose,
									});
									if (launch.handle !== undefined) {
										manager.holdAttachment(record.subagentId, launch.handle);
									}
									if (launch.handle === undefined || launch.failure !== undefined) {
										return { failure: launch.failure ?? "panel did not open" };
									}
									return { id: launch.handle.identity.attachmentId };
								},
								rebind: (attachment: RuntimeAttachment) =>
									attachment.kind === "panel"
										? rebindHostAttachment({
												host: attachment.host,
												attachmentId: attachment.id,
												ownerId,
												ownsAttachment,
											})
										: undefined,
							},
						}
					: {}),
			});
			controller?.bindManager(manager);
			provideService(runtime, SUBAGENT_OWNERSHIP_SERVICE, ownership.service);
			// Recovery must never take the extension down with it: a registry this version cannot
			// read (for example records written by an older release) is reported in the session and
			// the user is told how to reset it.
			const recovery = await manager.reconcile().catch((error: unknown) => {
				context.ui.notify(
					`Subagent recovery failed: ${errorMessage(error)}. Delete the stale records (or the whole registry file) to reset this parent session's subagent state.`,
					"error",
				);
				return undefined;
			});
			if (recovery?.ok === false) {
				context.ui.notify(
					"Subagent panels could not be listed, so none were reopened. No second runtime was started.",
					"warning",
				);
			}
			if (recovery?.ok === true && recovery.ownedFailures !== undefined) {
				context.ui.notify(
					`Agents owned by a review scope could not be confirmed stopped: ${recovery.ownedFailures.join("; ")}. They stay unavailable until a stop is confirmed.`,
					"warning",
				);
			}
			pi.on("before_agent_start", async () => {
				await manager.ready();
			});
			registerParentTools(pi, manager, await discoverAgents(context.cwd));
			if (typeof pi.registerMarkdownTransformer === "function") {
				pi.registerMarkdownTransformer(transformSubagentsMarkdown);
			}
			const activation = registerInteractiveToolActivation({
				pi,
				manager,
				context,
			});
			runtime.resources.add("interactive-tool-activation", () => activation.dispose());
			registerParentCommands(pi, manager);
			const status = createSubagentStatus(context.ui, runtime.signal);
			let refreshVersion = 0;
			// The manager notifies on every lifecycle transition, and each notification costs an async
			// list plus a full footer rebuild. The footer follows the shared streaming window instead;
			// the first change still paints immediately and the last state is never dropped.
			const repaintStatus = createRenderThrottle(() => {
				if (runtime.signal.aborted) return;
				const version = ++refreshVersion;
				void manager
					.list()
					.then((children) => {
						if (runtime.signal.aborted || version !== refreshVersion) return;
						status.refresh(children);
					})
					.catch((error: unknown) => diagnose(`Subagent status failed: ${errorMessage(error)}`));
			});
			const refreshStatus = (): void => repaintStatus.request();
			const unsubscribe = manager.onChange(refreshStatus);
			refreshStatus();
			runtime.resources.add("subagent-status", () => {
				unsubscribe();
				repaintStatus.dispose();
				status.dispose();
			});
			// One teardown owner for the two, so owned children are stopped while their transport is
			// still reachable no matter how the extension's resources are ordered.
			runtime.resources.add("subagent-manager", async () => {
				const failures = await ownership.dispose("parent shutdown");
				manager.closeLocalConnections();
				if (failures.length > 0) {
					throw new AggregateError(
						failures.map((failure) => new Error(failure)),
						`Owned subagent cleanup failed: ${failures.join(", ")}`,
					);
				}
			});
		},
	});
}
