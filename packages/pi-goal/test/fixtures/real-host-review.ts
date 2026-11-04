import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { provideService, registerExtensionLifecycle } from "@hheei/pi-ext-core";
import {
	type OwnedScope,
	SUBAGENT_OWNERSHIP_SERVICE,
	type SubagentOwnershipService,
} from "@hheei/pi-subagents/ownership";
import { GOAL_CONTINUATION_MESSAGE_TYPE, GOAL_REVIEW_MESSAGE_TYPE } from "../../src/document.js";
import piGoalExtension from "../../src/extension.js";

interface Scripted {
	readonly calls: number;
	releaseSecond(): void;
}

function assistant(
	model: { api: AssistantMessage["api"]; provider: AssistantMessage["provider"]; id: string },
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

/**
 * A real Pi provider: the first turn calls goal complete, the second stays streaming until the
 * test releases it (so the rejection arrives while the parent request is active), and later turns
 * answer the review feedback.
 */
function scriptedProvider(pi: ExtensionAPI, holdSecond: boolean): Scripted {
	const state = { calls: 0, releaseSecond: () => {} };
	pi.registerProvider("goal-test", {
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "goal-test-key",
		models: [
			{
				id: "scripted",
				name: "Scripted",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple(model, _context, options) {
			state.calls += 1;
			const stream = createAssistantMessageEventStream();
			if (state.calls === 1) {
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistant(
						model,
						[
							{
								type: "toolCall",
								id: "goal-complete-1",
								name: "goal",
								arguments: { action: "complete", text: "tests passed" },
							},
						],
						"toolUse",
					),
				});
				return stream;
			}
			if (state.calls === 2 && !holdSecond) {
				stream.push({
					type: "done",
					reason: "stop",
					message: assistant(model, [{ type: "text", text: "done" }], "stop"),
				});
				return stream;
			}
			if (state.calls === 2) {
				const message = assistant(model, [{ type: "text", text: "waiting" }], "pending");
				stream.push({ type: "start", partial: message });
				let finished = false;
				const finish = (): void => {
					if (finished) return;
					finished = true;
					stream.push({
						type: "done",
						reason: "stop",
						message: assistant(model, [{ type: "text", text: "done" }], "stop"),
					});
				};
				state.releaseSecond = finish;
				options?.signal?.addEventListener("abort", finish, { once: true });
				return stream;
			}
			stream.push({
				type: "done",
				reason: "stop",
				message: assistant(model, [{ type: "text", text: "feedback received" }], "stop"),
			});
			return stream;
		},
	});
	return {
		get calls() {
			return state.calls;
		},
		releaseSecond: () => state.releaseSecond(),
	};
}

/** Provides the owned-review capability the goal tool expects, with an immediate rejection. */
function rejectingOwnership(pi: ExtensionAPI, delayRejection: boolean): () => void {
	let settleExternal: () => void = () => {};
	const delayedSettlement = new Promise<
		Awaited<ReturnType<OwnedScope["delegate"]>>["settlement"] extends Promise<infer T> ? T : never
	>((resolve) => {
		settleExternal = () =>
			resolve({
				childId: "review-child",
				agent: "reviewer",
				status: "completed",
				message: "VERDICT: REJECTED\nmissing caller check",
			});
	});
	const scope: OwnedScope = {
		ownerId: "review",
		async delegate() {
			const childId = "review-child";
			return {
				childId,
				revision: 1,
				settlement: delayRejection
					? delayedSettlement
					: Promise.resolve({
							childId,
							agent: "reviewer",
							status: "completed" as const,
							message: "VERDICT: REJECTED\nmissing caller check",
						}),
			};
		},
		async close() {
			return { closed: true, failures: [] };
		},
	};
	const service: SubagentOwnershipService = { openScope: () => scope };
	registerExtensionLifecycle(pi, {
		key: "goal-test-ownership",
		start(context) {
			if (!provideService(context, SUBAGENT_OWNERSHIP_SERVICE, service))
				throw new Error("the test ownership service was already provided");
		},
	});
	return () => settleExternal();
}

export async function waitUntil(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

export interface BootedReviewHost {
	readonly session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	readonly provider: Scripted;
	readonly notices: string[];
	readonly invokeGoal: (verb: string) => Promise<void>;
	readonly settleRejection: () => void;
	readonly reviewMessages: () => number;
	setPauseOnSettled(value: boolean): void;
	readonly continuationMessages: () => number;
	setPauseOnFeedback(value: boolean): void;
	setInvalidBoundary(value: boolean): void;
	dispose(): Promise<void>;
}

export async function bootReviewHost(
	options: { readonly holdSecond?: boolean; readonly delayRejection?: boolean } = {},
): Promise<BootedReviewHost> {
	const savedChildEnv = process.env.PI_SUBAGENTS_CHILD_ID;
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	const dir = await mkdtemp(join(tmpdir(), "pi-goal-review-host-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.PI_SUBAGENTS_CHILD_ID;
	await writeFile(
		join(dir, "ext_settings.json"),
		JSON.stringify({ goal: { review: true, continuations: 1, reviews: 1 } }),
	);
	let scripted: Scripted | undefined;
	let pauseOnFeedback = false;
	let pauseOnSettled = false;
	let invalidBoundary = false;
	let invoke: ((verb: string) => Promise<void>) | undefined;
	let settleReviewer: (() => void) | undefined;
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				scripted = scriptedProvider(pi, options.holdSecond ?? true);
			},
			(pi) => {
				settleReviewer = rejectingOwnership(pi, options.delayRejection ?? false);
			},
			piGoalExtension,
			// Registered after Goal: a later boundary handler that can pause or corrupt the frame.
			(pi) =>
				registerExtensionLifecycle(pi, {
					key: "goal-test-late-boundary",
					start({ pi: runtimePi, resources }) {
						resources.add(
							"late-settled",
							runtimePi.on("agent_settled", async () => {
								if (pauseOnSettled) {
									pauseOnSettled = false;
									await invoke?.("pause");
								}
							}),
						);
						resources.add(
							"late-boundary",
							runtimePi.on("agent_before_settle", async (event) => {
								const hasFeedback = event.entries.some(
									(entry) =>
										entry.type === "custom_message" &&
										entry.customType === GOAL_REVIEW_MESSAGE_TYPE,
								);
								if (!hasFeedback) return undefined;
								if (pauseOnFeedback) {
									pauseOnFeedback = false;
									await invoke?.("pause");
								}
								if (invalidBoundary) {
									invalidBoundary = false;
									return {
										entries: [
											...event.entries,
											{
												type: "context_edit",
												targetId: "missing-entry",
												replacement: { content: [] },
											},
										],
										continue: true,
									};
								}
								return undefined;
							}),
						);
					},
				}),
		],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(dir),
	});
	await session.bindExtensions({ mode: "print" });
	const model = session.modelRuntime.getModel("goal-test", "scripted");
	if (model === undefined) throw new Error("the scripted test provider was not registered");
	await session.setModel(model);
	const command = session.extensionRunner.getCommand("goal");
	if (command === undefined) throw new Error("the goal command was not registered");
	if (scripted === undefined) throw new Error("the scripted provider was not loaded");
	const provider = scripted;
	const base = session.extensionRunner.createCommandContext();
	const notices: string[] = [];
	const ctx = {
		...base,
		ui: {
			...base.ui,
			notify(message: string) {
				notices.push(message);
			},
		},
	};
	const invokeGoal = async (verb: string): Promise<void> => {
		await command.handler(verb, ctx);
	};
	invoke = invokeGoal;
	const dispose = async (): Promise<void> => {
		session.dispose();
		await rm(dir, { recursive: true, force: true });
		if (savedChildEnv === undefined) delete process.env.PI_SUBAGENTS_CHILD_ID;
		else process.env.PI_SUBAGENTS_CHILD_ID = savedChildEnv;
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	};
	return {
		session,
		provider,
		notices,
		invokeGoal,
		settleRejection: () => settleReviewer?.(),
		reviewMessages: () =>
			session.sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "custom_message" && entry.customType === GOAL_REVIEW_MESSAGE_TYPE,
				).length,
		continuationMessages: () =>
			session.sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "custom_message" && entry.customType === GOAL_CONTINUATION_MESSAGE_TYPE,
				).length,
		setPauseOnFeedback(value) {
			pauseOnFeedback = value;
		},
		setPauseOnSettled(value) {
			pauseOnSettled = value;
		},
		setInvalidBoundary(value) {
			invalidBoundary = value;
		},
		dispose,
	};
}

export async function waitForRejection(booted: BootedReviewHost): Promise<void> {
	await waitUntil(
		() => booted.provider.calls >= 2 && booted.session.isStreaming,
		"the review request to stream",
	);
	await waitUntil(() => {
		void booted.invokeGoal("status");
		const status = booted.notices[booted.notices.length - 1] ?? "";
		return status.includes("attempt 1 rejected");
	}, "the rejection to be recorded while streaming");
}
