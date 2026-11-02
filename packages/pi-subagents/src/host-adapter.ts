import { statSync } from "node:fs";
import { errorMessage, runCommand, shellQuote } from "@hheei/pi-ext-core";
import type { LaunchSpec } from "./launch-spec.js";
import type { HostList } from "./lease.js";

export type HostKind = "herdr" | "cmux";

export interface HostCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
}

export interface HostCommandRunner {
	run(
		command: string,
		args: readonly string[],
		options?: { readonly timeoutMs?: number },
	): Promise<HostCommandResult>;
}

export interface HostCapability {
	readonly host: HostKind;
	readonly available: boolean;
	readonly reason: string;
}

export type HostSelection =
	| {
			readonly available: true;
			readonly selectedHost: HostKind;
			readonly adapter: HostAdapter;
			readonly reason: string;
	  }
	| {
			readonly available: false;
			readonly selectedHost: null;
			readonly reason: string;
	  };

export interface HostAttachmentIdentity {
	readonly host: HostKind;
	readonly attachmentId: string;
	readonly createdBy: string;
}

export interface HostObservation {
	readonly identity: HostAttachmentIdentity;
	readonly alive: boolean;
	readonly known: boolean;
	/** True when the underlying host container (tab, pane, or surface) no longer exists. */
	readonly containerGone?: boolean;
	/**
	 * Whether a human is looking at this panel. Absent when the host cannot say, which includes
	 * both hosts without the capability and a lookup that failed just now; the caller must treat
	 * an absent answer as "do not touch", because an unfocused answer lets it close the panel.
	 */
	readonly focused?: boolean;
	readonly detail: string;
}

export interface HostAttachment {
	readonly identity: HostAttachmentIdentity;
	readonly launch: HostCommandResult;
	/** True when `observe()` can report focus; idle reclaim needs it and fails open without it. */
	readonly reportsFocus: boolean;
	observe(): Promise<HostObservation>;
	cleanup(): Promise<HostCommandResult>;
}

export interface HostAdapter {
	readonly kind: HostKind;
	probe(): Promise<HostCapability>;
	/** Opens the child's panel and runs the LaunchSpec in it. */
	open(spec: LaunchSpec): Promise<HostAttachment>;
}

export interface SelectHostAdapterOptions {
	readonly adapters: Readonly<Record<HostKind, HostAdapter>>;
	readonly preferredHost?: HostKind;
}

const DEFAULT_HOST_ORDER: readonly HostKind[] = ["herdr", "cmux"];

/** Selects a presentation host visibly; an explicit unavailable host never falls back. */
export async function selectHostAdapter(options: SelectHostAdapterOptions): Promise<HostSelection> {
	const explicit = options.preferredHost !== undefined;
	const order = explicit ? [options.preferredHost] : DEFAULT_HOST_ORDER;
	const attempts: HostCapability[] = [];
	for (const host of order) {
		const adapter = options.adapters[host];
		const capability = await adapter.probe();
		attempts.push(capability);
		if (capability.available) {
			const priorFailures = attempts
				.slice(0, -1)
				.map((attempt) => `${attempt.host}: ${attempt.reason}`)
				.join("; ");
			return {
				available: true,
				selectedHost: host,
				adapter,
				reason:
					priorFailures === ""
						? `${explicit ? "explicit" : "default"} host ${host} is available`
						: `selected ${host} after ${priorFailures}`,
			};
		}
	}
	const failure = attempts.map((attempt) => `${attempt.host}: ${attempt.reason}`).join("; ");
	return {
		available: false,
		selectedHost: null,
		reason: explicit
			? `explicit host unavailable: ${failure}`
			: `no presentation host available: ${failure}`,
	};
}

const HOST_COMMAND_MAX_STDOUT_BYTES = 1024 * 1024;

function errnoCode(error: unknown): string | undefined {
	// Node's spawn errors are plain Errors carrying a `code` string; narrowing here
	// keeps the ENOENT decision below honest about the caught value being unknown.
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

export const systemHostCommandRunner: HostCommandRunner = {
	async run(command, args, options = {}): Promise<HostCommandResult> {
		try {
			const result = await runCommand(command, [...args], {
				...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
				maxStdoutBytes: HOST_COMMAND_MAX_STDOUT_BYTES,
			});
			return {
				stdout: result.stdout.toString("utf8"),
				stderr: result.stdoutTruncated
					? `output exceeded ${HOST_COMMAND_MAX_STDOUT_BYTES} bytes`
					: result.stderr.toString("utf8"),
				// A command killed by a signal reports no exit code; the kill still counts as
				// a failure through `timedOut` or `hostCleanupFailed`.
				exitCode: result.signal === null ? result.code : null,
				timedOut: result.timedOut,
			};
		} catch (error) {
			if (errnoCode(error) === "ENOENT") {
				return {
					stdout: "",
					stderr: `command not found: ${command}`,
					exitCode: 127,
					timedOut: false,
				};
			}
			return {
				stdout: "",
				stderr: errorMessage(error),
				exitCode: null,
				timedOut: false,
			};
		}
	},
};

export interface HostAdapterOptions {
	readonly runner?: HostCommandRunner;
	readonly ownerId: string;
	readonly ownsAttachment: (identity: HostAttachmentIdentity) => boolean;
	readonly timeoutMs?: number;
	readonly env?: NodeJS.ProcessEnv;
}

export function createHerdrHostAdapter(options: HostAdapterOptions): HostAdapter {
	const runner = options.runner ?? systemHostCommandRunner;
	const timeoutMs = options.timeoutMs ?? 10_000;
	const env = options.env ?? process.env;
	return {
		kind: "herdr",
		async probe(): Promise<HostCapability> {
			// Availability is a fact about this process, never about the environment it inherited:
			// `HERDR_ENV` and `HERDR_PANE_ID` outlive the pane that set them, so a host that inherits
			// them (a GUI app started from a herdr pane, a daemon that outlived its workspace) would
			// otherwise claim a panel it cannot draw. The pane has to prove it runs this process.
			const ancestry = await processAncestry(runner, timeoutMs);
			if (ancestry === undefined) {
				return {
					host: "herdr",
					available: false,
					reason: "could not read this process tree",
				};
			}
			const owned = await resolveHerdrOwnedPane(runner, timeoutMs, { ancestry, env });
			return owned.pane === undefined
				? {
						host: "herdr",
						available: false,
						reason: owned.reason ?? "no herdr pane runs this process",
					}
				: {
						host: "herdr",
						available: true,
						reason: `pane ${owned.pane.paneId} runs this process`,
					};
		},
		async open(spec): Promise<HostAttachment> {
			// A dedicated tab, not a split of the parent pane: the child TUI owns its own tab, the
			// parent session keeps its layout and focus, and the tab is labeled with the child id so
			// a human can tell whose panel it is.
			const ancestry = await processAncestry(runner, timeoutMs);
			if (ancestry === undefined) {
				throw new Error("herdr panel: could not read this process tree");
			}
			const owned = await resolveHerdrOwnedPane(runner, timeoutMs, { ancestry, env });
			if (owned.pane === undefined) {
				throw new Error(`herdr panel: ${owned.reason ?? "no herdr pane runs this process"}`);
			}
			const created = await runner.run("herdr", herdrTabCreateArgs(spec, owned.pane.workspaceId), {
				timeoutMs,
			});
			const failure = hostCommandFailure(created);
			if (failure !== undefined) {
				throw new Error(
					`herdr tab create failed: ${failure.code}${failure.message === "" ? "" : ` (${failure.message})`}`,
				);
			}
			const target = parseHerdrTab(created.stdout);
			if (target === undefined) {
				throw new Error(
					`herdr tab create returned no tab and root pane id (${created.timedOut ? "timed out" : created.stderr.trim() || "no error reported"})`,
				);
			}
			// pane run sends text+Enter to the tab's root shell. Timeout is not rollback: the tab
			// already exists and the process may still start after the CLI deadline.
			const launch = await runner.run(
				"herdr",
				["pane", "run", target.paneId, quotedArgv(spec.command, spec.argv)],
				{ timeoutMs },
			);
			return hostAttachment({
				identity: { host: "herdr", attachmentId: target.tabId, createdBy: options.ownerId },
				launch,
				noun: "tab",
				reportsFocus: true,
				observe: async () => {
					// Aliveness is the pane's foreground process; focus is a fact about the tab *and*
					// its workspace, so both listings are read together with it.
					const [process, tabs, workspaces] = await Promise.all([
						runner.run("herdr", ["pane", "process-info", "--pane", target.paneId], { timeoutMs }),
						runner.run("herdr", ["tab", "list"], { timeoutMs }),
						runner.run("herdr", ["workspace", "list"], { timeoutMs }),
					]);
					// A listing that did not answer says nothing about focus: reading it anyway turns a
					// failed command into "unfocused", and the caller closes a panel on that answer.
					const listed =
						herdrListingSucceeded(tabs) && herdrListingSucceeded(workspaces)
							? herdrPanelFocused(tabs.stdout, workspaces.stdout, target.tabId)
							: undefined;
					const code = herdrErrorCode(process.stderr) ?? herdrErrorCode(process.stdout);
					const containerGone = code === "pane_not_found" || code === "tab_not_found";
					const alive = herdrPaneAlive(process);
					return {
						process,
						...(alive === undefined ? {} : { alive }),
						...(containerGone ? { containerGone: true } : {}),
						...(listed === undefined ? {} : { focused: listed }),
					};
				},
				close: () => runner.run("herdr", ["tab", "close", target.tabId], { timeoutMs }),
				ownsAttachment: options.ownsAttachment,
			});
		},
	};
}

export function createCmuxHostAdapter(options: HostAdapterOptions): HostAdapter {
	const runner = options.runner ?? systemHostCommandRunner;
	const timeoutMs = options.timeoutMs ?? 10_000;
	return {
		kind: "cmux",
		async probe(): Promise<HostCapability> {
			const ping = await runner.run("cmux", ["ping"], { timeoutMs });
			if (ping.timedOut) return { host: "cmux", available: false, reason: "cmux ping timed out" };
			if (ping.exitCode !== 0 || hostCommandFailure(ping) !== undefined) {
				return { host: "cmux", available: false, reason: describeHostFailure(ping, "cmux ping") };
			}
			const capabilities = await runner.run("cmux", ["capabilities", "--json"], { timeoutMs });
			if (!herdrListingSucceeded(capabilities) || hostCommandFailure(capabilities) !== undefined) {
				return {
					host: "cmux",
					available: false,
					reason: describeHostFailure(capabilities, "cmux capabilities"),
				};
			}
			return { host: "cmux", available: true, reason: "cmux responded and exposed capabilities" };
		},
		async open(spec): Promise<HostAttachment> {
			const launch = await runner.run(
				"cmux",
				["--json", "new-surface", "--command", cmuxLaunchCommand(spec)],
				{ timeoutMs },
			);
			const failure = hostCommandFailure(launch);
			if (failure !== undefined) {
				throw new Error(
					`cmux new-surface failed: ${failure.code}${failure.message === "" ? "" : ` (${failure.message})`}`,
				);
			}
			const attachmentId = parseCmuxSurfaceId(launch.stdout);
			if (attachmentId === undefined) {
				throw new Error("cmux new-surface returned no surface id; process state is unknown");
			}
			return hostAttachment({
				identity: { host: "cmux", attachmentId, createdBy: options.ownerId },
				launch,
				noun: "surface",
				// TODO(cmux-focus): cmux does not report which surface a human is looking at, so
				// observation cannot answer `focused` and idle reclaim fails open here: a cmux child
				// is only ever closed by agents_stop.
				reportsFocus: false,
				observe: async () => {
					const process = await runner.run("cmux", ["--json", "list-panels"], { timeoutMs });
					if (process.timedOut || process.exitCode !== 0) return { process };
					const alive = containsString(process.stdout, attachmentId);
					return {
						process,
						alive,
						...(!alive ? { containerGone: true } : {}),
					};
				},
				close: () =>
					runner.run("cmux", ["--json", "close-surface", "--surface", attachmentId], {
						timeoutMs,
					}),
				ownsAttachment: options.ownsAttachment,
			});
		},
	};
}

interface HostAttachmentOptions {
	readonly identity: HostAttachmentIdentity;
	readonly launch: HostCommandResult;
	readonly noun: "pane" | "surface" | "tab";
	readonly reportsFocus: boolean;
	/** Reads the child's process state; `alive: undefined` means the host could not answer. */
	readonly observe: () => Promise<{
		readonly process: HostCommandResult;
		readonly alive?: boolean;
		readonly containerGone?: boolean;
		readonly focused?: boolean;
	}>;
	readonly close: () => Promise<HostCommandResult>;
	readonly ownsAttachment: (identity: HostAttachmentIdentity) => boolean;
}

function hostAttachment(options: HostAttachmentOptions): HostAttachment {
	const observe = async (): Promise<HostObservation> => {
		const result = await options.observe();
		const focused = options.reportsFocus ? result.focused : undefined;
		return {
			identity: options.identity,
			// A host that could not answer is not reporting a dead child: `alive: false` is what lets
			// the caller drop the panel and the runtime evidence, so it is only ever said on purpose.
			alive: result.alive === true,
			known: result.alive !== undefined,
			...(result.containerGone ? { containerGone: true } : {}),
			...(focused === undefined ? {} : { focused }),
			detail: result.process.stderr || result.process.stdout,
		};
	};
	return {
		identity: options.identity,
		launch: options.launch,
		reportsFocus: options.reportsFocus,
		observe,
		async cleanup(): Promise<HostCommandResult> {
			if (!options.ownsAttachment(options.identity)) {
				return failedResult(`${options.noun} ownership was revoked`);
			}
			const observed = await observe();
			if (!options.ownsAttachment(options.identity)) {
				return failedResult(`${options.noun} ownership was revoked during observation`);
			}
			if (!observed.known) {
				return failedResult(`${options.noun} observation timed out; not closing`);
			}
			return options.close();
		},
	};
}

/**
 * Herdr tab creation carries cwd, env, label, and explicit workspace id matching the parent
 * process, ensuring the child tab spawns in the workspace of the pane that provably runs this
 * process rather than whatever workspace happens to have user focus.
 */
export function herdrTabCreateArgs(spec: LaunchSpec, workspaceId?: string): string[] {
	const args = [
		"tab",
		"create",
		"--cwd",
		spec.cwd,
		"--label",
		spec.config.subagentId,
		"--no-focus",
	];
	if (workspaceId !== undefined && workspaceId !== "") {
		args.push("--workspace", workspaceId);
	}
	for (const [key, value] of Object.entries(spec.env)) {
		args.push("--env", `${key}=${value}`);
	}
	return args;
}

/** One pane as `herdr pane list` reports it. */
interface HerdrPaneEntry {
	readonly paneId: string;
	readonly tabId: string;
	readonly workspaceId: string;
}

interface HerdrOwnership {
	readonly pane?: HerdrPaneEntry;
	readonly reason?: string;
}

/**
 * The kernel is the only source that ties this process to a pane: herdr reports the pane's
 * foreground processes, and an inherited environment variable cannot fake a kernel answer. This
 * process is included because a wrapper (`pnpm exec`, a supervisor) runs it as a child while the
 * pane's foreground job is still the Pi above it.
 */
export async function processAncestry(
	runner: HostCommandRunner,
	timeoutMs: number,
): Promise<ReadonlySet<number> | undefined> {
	const result = await runner.run("ps", ["-A", "-o", "pid=,ppid="], { timeoutMs });
	if (!herdrListingSucceeded(result)) return undefined;
	const parents = new Map<number, number>();
	for (const line of result.stdout.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 2) continue;
		const pid = Number.parseInt(fields[0] ?? "", 10);
		const ppid = Number.parseInt(fields[1] ?? "", 10);
		if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
		parents.set(pid, ppid);
	}
	const pids = new Set<number>();
	let current: number | undefined = process.pid;
	for (let depth = 0; current !== undefined && current > 0 && depth < 64; depth++) {
		pids.add(current);
		const parent: number | undefined = parents.get(current);
		if (parent === undefined || parent === current) break;
		current = parent;
	}
	return pids.size === 0 ? undefined : pids;
}

/**
 * Finds the pane that is running this process. `HERDR_PANE_ID` only orders the candidates — the
 * pane still has to prove it owns this process group — so an id inherited from a closed pane costs
 * one query instead of a wrong answer.
 */
export async function resolveHerdrOwnedPane(
	runner: HostCommandRunner,
	timeoutMs: number,
	options: { readonly ancestry: ReadonlySet<number>; readonly env?: NodeJS.ProcessEnv },
): Promise<HerdrOwnership> {
	const listed = await runner.run("herdr", ["pane", "list"], { timeoutMs });
	if (!hostCommandSucceeded(listed)) {
		return { reason: describeHostFailure(listed, "herdr pane list") };
	}
	const panes = herdrPaneEntries(listed.stdout);
	if (panes.length === 0) return { reason: "herdr listed no panes" };
	const hint = options.env?.HERDR_PANE_ID?.trim();
	const ordered =
		hint === undefined || hint === ""
			? panes
			: [
					...panes.filter((pane) => pane.paneId === hint),
					...panes.filter((pane) => pane.paneId !== hint),
				];
	let failure: string | undefined;
	for (const pane of ordered) {
		const info = await runner.run("herdr", ["pane", "process-info", "--pane", pane.paneId], {
			timeoutMs,
		});
		if (!hostCommandSucceeded(info)) {
			failure = describeHostFailure(info, `herdr pane process-info ${pane.paneId}`);
			continue;
		}
		if (herdrPaneRunsProcess(info.stdout, options.ancestry)) return { pane };
	}
	const mismatch = "no herdr pane runs this process";
	return { reason: failure === undefined ? mismatch : `${mismatch} (${failure})` };
}

/**
 * Focus is answered from two listings: `tab list` says whether the child's tab is focused and
 * which workspace owns it, `workspace list` says whether that workspace is the rendered one. A
 * child is being watched only when both are focused. Anything missing — a failed listing, an absent
 * field, a tab that is not there — is unknown, never "unfocused", because the caller closes a panel
 * on an unfocused answer.
 */
export function herdrPanelFocused(
	tabList: string,
	workspaceList: string,
	tabId: string,
): boolean | undefined {
	const tab = herdrListEntry(tabList, "tabs", "tab_id", tabId);
	if (tab === undefined) return undefined;
	const tabFocused = tab.focused;
	if (typeof tabFocused !== "boolean") return undefined;
	if (!tabFocused) return false;
	const workspaceId = tab.workspace_id;
	if (typeof workspaceId !== "string" || workspaceId === "") return undefined;
	const workspace = herdrListEntry(workspaceList, "workspaces", "workspace_id", workspaceId);
	const workspaceFocused = workspace?.focused;
	return typeof workspaceFocused === "boolean" ? workspaceFocused : undefined;
}

export async function listHerdrAttachments(
	runner: HostCommandRunner,
	timeoutMs: number,
): Promise<HostList> {
	const status = await runner.run("herdr", ["status", "server"], { timeoutMs });
	if (status.timedOut || status.exitCode !== 0) return { known: false };
	const socket = statusField(status.stdout, "socket");
	if (socket === undefined) return { known: false };
	let generation: string;
	try {
		const stat = statSync(socket);
		generation = `${stat.dev}:${stat.ino}`;
	} catch {
		return { known: false };
	}
	const tabs = await runner.run("herdr", ["tab", "list"], { timeoutMs });
	if (tabs.timedOut || tabs.exitCode !== 0) return { known: false };
	const present = herdrTabIds(tabs.stdout);
	if (present === undefined) return { known: false };
	return { known: true, generation, present };
}

export function herdrTabIds(output: string): ReadonlySet<string> | undefined {
	const entries = herdrCollection(output, "tabs");
	if (entries === undefined) return undefined;
	const ids = new Set<string>();
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const id = (entry as Record<string, unknown>).tab_id;
		if (typeof id === "string" && id !== "") ids.add(id);
	}
	return ids;
}

export async function listCmuxAttachments(
	runner: HostCommandRunner,
	timeoutMs: number,
): Promise<HostList> {
	const panels = await runner.run("cmux", ["--json", "list-panels"], { timeoutMs });
	if (panels.timedOut || panels.exitCode !== 0) return { known: false };
	const present = cmuxSurfaceIds(panels.stdout);
	if (present === undefined) return { known: false };
	return { known: true, generation: "cmux", present };
}

export function cmuxSurfaceIds(output: string): ReadonlySet<string> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output) as unknown;
	} catch {
		return undefined;
	}
	const panels = findNamedObject(parsed, "result")?.panels ?? findNamedObject(parsed, "panels");
	const list = Array.isArray(panels) ? panels : Array.isArray(parsed) ? parsed : undefined;
	if (list === undefined) return undefined;
	const ids = new Set<string>();
	for (const entry of list) {
		if (typeof entry === "string" && entry !== "") ids.add(entry);
		else if (typeof entry === "object" && entry !== null) {
			const id = (entry as Record<string, unknown>).surface_id;
			if (typeof id === "string" && id !== "") ids.add(id);
		}
	}
	return ids;
}

export function rebindHerdrTab(options: {
	readonly runner?: HostCommandRunner;
	readonly tabId: string;
	readonly ownerId: string;
	readonly timeoutMs?: number;
	readonly ownsAttachment: (identity: HostAttachmentIdentity) => boolean;
}): HostAttachment {
	const runner = options.runner ?? systemHostCommandRunner;
	const timeoutMs = options.timeoutMs ?? 10_000;
	return hostAttachment({
		identity: { host: "herdr", attachmentId: options.tabId, createdBy: options.ownerId },
		launch: { stdout: "", stderr: "", exitCode: 0, timedOut: false },
		noun: "tab",
		reportsFocus: true,
		observe: async () => {
			const tabs = await runner.run("herdr", ["tab", "list"], { timeoutMs });
			if (tabs.timedOut || tabs.exitCode !== 0) return { process: tabs };
			const ids = herdrTabIds(tabs.stdout);
			if (ids === undefined) return { process: tabs };
			return { process: tabs, alive: ids.has(options.tabId) };
		},
		close: () => runner.run("herdr", ["tab", "close", options.tabId], { timeoutMs }),
		ownsAttachment: options.ownsAttachment,
	});
}

export function rebindCmuxSurface(options: {
	readonly runner?: HostCommandRunner;
	readonly surfaceId: string;
	readonly ownerId: string;
	readonly timeoutMs?: number;
	readonly ownsAttachment: (identity: HostAttachmentIdentity) => boolean;
}): HostAttachment {
	const runner = options.runner ?? systemHostCommandRunner;
	const timeoutMs = options.timeoutMs ?? 10_000;
	return hostAttachment({
		identity: { host: "cmux", attachmentId: options.surfaceId, createdBy: options.ownerId },
		launch: { stdout: "", stderr: "", exitCode: 0, timedOut: false },
		noun: "surface",
		reportsFocus: false,
		observe: async () => {
			const process = await runner.run("cmux", ["--json", "list-panels"], { timeoutMs });
			if (process.timedOut || process.exitCode !== 0) return { process };
			const ids = cmuxSurfaceIds(process.stdout);
			if (ids === undefined) return { process };
			return { process, alive: ids.has(options.surfaceId) };
		},
		close: () =>
			runner.run("cmux", ["--json", "close-surface", "--surface", options.surfaceId], {
				timeoutMs,
			}),
		ownsAttachment: options.ownsAttachment,
	});
}

function herdrCollection(output: string, collection: string): readonly unknown[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output) as unknown;
	} catch {
		return undefined;
	}
	const list = findNamedObject(parsed, "result")?.[collection];
	return Array.isArray(list) ? list : undefined;
}

function statusField(output: string, name: string): string | undefined {
	for (const line of output.split("\n")) {
		const separator = line.indexOf(":");
		if (separator < 0) continue;
		if (line.slice(0, separator).trim() !== name) continue;
		const value = line.slice(separator + 1).trim();
		if (value !== "") return value;
	}
	return undefined;
}

function herdrListEntry(
	output: string,
	collection: string,
	key: string,
	id: string,
): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output) as unknown;
	} catch {
		return undefined;
	}
	const list = findNamedObject(parsed, "result")?.[collection];
	if (!Array.isArray(list)) return undefined;
	for (const entry of list) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (record[key] === id) return record;
	}
	return undefined;
}

/**
 * `herdr tab create` answers with the tab and its root pane: the pane runs the LaunchSpec and is
 * what observation watches, while the tab is what cleanup closes.
 */
function parseHerdrTab(
	output: string,
): { readonly tabId: string; readonly paneId: string } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output) as unknown;
	} catch {
		return undefined;
	}
	const tabId = findNamedObject(parsed, "tab")?.tab_id;
	const paneId = findNamedObject(parsed, "root_pane")?.pane_id;
	if (typeof tabId !== "string" || typeof paneId !== "string") return undefined;
	return { tabId, paneId };
}

function herdrPaneEntries(output: string): readonly HerdrPaneEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output) as unknown;
	} catch {
		return [];
	}
	const list = findNamedObject(parsed, "result")?.panes;
	if (!Array.isArray(list)) return [];
	const entries: HerdrPaneEntry[] = [];
	for (const entry of list) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const paneId = record.pane_id;
		const tabId = record.tab_id;
		const workspaceId = record.workspace_id;
		if (typeof paneId !== "string") continue;
		if (typeof tabId !== "string") continue;
		if (typeof workspaceId !== "string") continue;
		entries.push({ paneId, tabId, workspaceId });
	}
	return entries;
}

/**
 * True when the pane's foreground job is this process or one it descends from. The pane's shell is
 * excluded: it is the idle fallback, so counting it would make every descendant of a pane — a
 * backgrounded `pi &`, an app started from that terminal — claim the pane it was started from.
 */
function herdrPaneRunsProcess(output: string, ancestry: ReadonlySet<number>): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output) as unknown;
	} catch {
		return false;
	}
	const info = findNamedObject(parsed, "process_info");
	if (info === undefined) return false;
	const shellPid = info.shell_pid;
	const foreground = info.foreground_processes;
	if (!Array.isArray(foreground)) return false;
	return foreground.some((entry) => {
		if (typeof entry !== "object" || entry === null) return false;
		const pid = (entry as { pid?: unknown }).pid;
		return typeof pid === "number" && pid !== shellPid && ancestry.has(pid);
	});
}

interface HostCommandFailure {
	readonly code: string;
	readonly message: string;
}

/**
 * Both hosts answer an API error as JSON with exit code 0, so the exit code is not a verdict and
 * the error body is the only thing that says what went wrong.
 */
function hostCommandFailure(result: HostCommandResult): HostCommandFailure | undefined {
	return hostCommandFailureFrom(result.stdout) ?? hostCommandFailureFrom(result.stderr);
}

function hostCommandFailureFrom(output: string): HostCommandFailure | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output) as unknown;
	} catch {
		return undefined;
	}
	const error = findNamedObject(parsed, "error");
	if (error === undefined) return undefined;
	const code = typeof error.code === "string" ? error.code : "error";
	const message = typeof error.message === "string" ? error.message : "";
	return { code, message };
}

function describeHostFailure(result: HostCommandResult, what: string): string {
	if (result.timedOut) return `${what} timed out`;
	const failure = hostCommandFailure(result);
	if (failure !== undefined) {
		return `${what} failed: ${failure.code}${failure.message === "" ? "" : ` (${failure.message})`}`;
	}
	const detail = result.stderr.trim() || result.stdout.trim();
	return detail === "" ? `${what} failed` : `${what} failed: ${detail}`;
}

/** Herdr `pane run` concatenates extra argv with spaces, so quoting happens here once. */
function quotedArgv(command: string, argv: readonly string[]): string {
	return [command, ...argv].map(shellQuote).join(" ");
}

/**
 * cmux `new-surface --command` is shell text. Encode cwd + env + argv without inventing Pi flags.
 * A surface is cmux's own name for a panel: attaching adds one to the current pane instead of
 * splitting the parent's layout, and cleanup closes exactly that surface.
 */
function cmuxLaunchCommand(spec: LaunchSpec): string {
	const directory = `cd ${shellQuote(spec.cwd)}`;
	const environment = Object.entries(spec.env)
		.map(([key, value]) => `${key}=${shellQuote(value)}`)
		.join(" ");
	return [directory, "&&", environment, quotedArgv(spec.command, spec.argv)]
		.filter((part) => part.length > 0)
		.join(" ");
}

function containsString(output: string, target: string): boolean {
	try {
		return valueContainsString(JSON.parse(output) as unknown, target);
	} catch {
		return false;
	}
}

function valueContainsString(value: unknown, target: string): boolean {
	if (value === target) return true;
	if (typeof value !== "object" || value === null) return false;
	return Object.values(value).some((child) => valueContainsString(child, target));
}

function parseCmuxSurfaceId(output: string): string | undefined {
	const named = parseJsonId(output, ["surface_id", "surfaceId"]);
	if (named !== undefined) return named;
	const generic = parseJsonId(output, ["id"], (value) => !value.startsWith("cli:"));
	return generic;
}

function parseJsonId(
	output: string,
	keys: readonly string[],
	accept: (value: string) => boolean = () => true,
): string | undefined {
	try {
		return findString(JSON.parse(output) as unknown, keys, accept);
	} catch {
		return undefined;
	}
}

function findString(
	value: unknown,
	keys: readonly string[],
	accept: (value: string) => boolean,
): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	for (const key of keys) {
		const candidate = (value as Record<string, unknown>)[key];
		if (typeof candidate === "string" && candidate.length > 0 && accept(candidate)) {
			return candidate;
		}
	}
	for (const child of Object.values(value as Record<string, unknown>)) {
		const found = findString(child, keys, accept);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** A listing that failed or timed out is not evidence, whatever its stdout happens to contain. */
function herdrListingSucceeded(result: HostCommandResult): boolean {
	return !result.timedOut && result.exitCode === 0;
}

/**
 * A host command succeeded only when it exited zero *and* answered without an error body: herdr
 * reports API errors as JSON with exit code 0, so the exit code alone is not a verdict.
 */
function hostCommandSucceeded(result: HostCommandResult): boolean {
	return herdrListingSucceeded(result) && hostCommandFailure(result) === undefined;
}

/**
 * Reads the pane's process state. A pane that no longer exists is a definite "not alive" — that is
 * how a closed panel looks — while a query that never ran or failed for any other reason is
 * unknown, because the caller closes the panel on "not alive".
 */
export function herdrPaneAlive(result: HostCommandResult): boolean | undefined {
	const failure = hostCommandFailure(result);
	if (failure !== undefined) {
		// A container that no longer exists is a definite "not alive" — that is how a closed panel
		// looks — while any other rejection says nothing about the child.
		return failure.code === "pane_not_found" || failure.code === "tab_not_found"
			? false
			: undefined;
	}
	if (herdrListingSucceeded(result)) return herdrChildProcessIsRunning(result.stdout);
	return undefined;
}

/** The error code of a herdr CLI failure, which reports it as JSON. */
function herdrErrorCode(output: string): string | undefined {
	return hostCommandFailureFrom(output)?.code;
}

function herdrChildProcessIsRunning(output: string): boolean {
	try {
		const info = findNamedObject(JSON.parse(output) as unknown, "process_info");
		if (info === undefined) return false;
		const shellPid = typeof info.shell_pid === "number" ? info.shell_pid : undefined;
		const foreground = info.foreground_processes;
		if (!Array.isArray(foreground)) return false;
		return foreground.some((proc) => {
			if (typeof proc !== "object" || proc === null) return false;
			const pid = (proc as { pid?: unknown }).pid;
			return typeof pid === "number" && pid !== shellPid;
		});
	} catch {
		return false;
	}
}

function findNamedObject(value: unknown, name: string): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const direct = record[name];
	if (typeof direct === "object" && direct !== null) return direct as Record<string, unknown>;
	for (const child of Object.values(record)) {
		const found = findNamedObject(child, name);
		if (found !== undefined) return found;
	}
	return undefined;
}

function failedResult(message: string): HostCommandResult {
	return { stdout: "", stderr: message, exitCode: null, timedOut: false };
}
