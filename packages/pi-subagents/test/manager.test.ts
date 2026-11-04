import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "@hheei/pi-ext-core";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { EffectiveLaunchConfig, SpawnSubagentInput, SubagentRecord } from "../src/domain.js";
import type { HostAttachment, HostObservation } from "../src/host-adapter.js";
import { assembleChildPrompt } from "../src/launch-spec.js";
import type { HostDirectory } from "../src/lease.js";
import {
	type ChildBridgeTransport,
	extractLastAssistantText,
	type ParentChannelReport,
	SubagentManager,
} from "../src/manager.js";
import { holdProcessLock, processLockPath } from "../src/process-lock.js";
import { BridgeError, type BridgeOperation } from "../src/protocol.js";
import {
	latestReceiptForChild,
	listReceipts,
	readReceiptRevision,
	readStoredReceipt,
	reserveReceipt,
	settleReceipts,
	updateReceipt,
} from "../src/receipts.js";
import { createSubagentRegistry } from "../src/registry.js";
import type { LaunchOutcome } from "../src/runtime.js";
import { transcriptFacts } from "../src/state.js";
import { openStateDb } from "../src/state-db.js";
import { advanceFakeTime, turn, until, useFakeClock, useRealClock } from "./helpers/fake-clock.js";
import { createTemporaryDirectory } from "./helpers/tmp-dir.js";

const PARENT_SESSION_ID = "01J7-parent";

/**
 * Every parent shares one state file, exactly as production does, and is isolated by its own
 * `parentSessionId` column instead of a file per test: opening a real SQLite file costs tens of
 * milliseconds of fsync, and a harness used to pay that once per test. All the files this suite
 * writes live under one temp root that `afterAll` removes.
 */
const WORK_ROOT = await createTemporaryDirectory("pi-subagents-manager-");
const STATE_DB_PATH = join(WORK_ROOT, "state.sqlite");
let parentSequence = 0;

beforeEach(() => {
	useFakeClock();
});

afterEach(() => {
	vi.restoreAllMocks();
	useRealClock();
});

afterAll(async () => {
	await rm(WORK_ROOT, { recursive: true, force: true });
});

function assistantEntry(text: string, usage?: Record<string, unknown>): unknown {
	return {
		type: "message",
		id: "assistant-1",
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text }],
			...(usage !== undefined ? { usage } : {}),
		},
	};
}

async function writeSession(entries: readonly unknown[]): Promise<string> {
	parentSequence += 1;
	const sessionPath = join(WORK_ROOT, `reply-${parentSequence}.jsonl`);
	await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return sessionPath;
}

interface FakeRuntime {
	readonly pid: number;
	alive: boolean;
	readonly exited: Promise<number | null>;
	terminate(graceMs?: number): Promise<void>;
	terminated: number;
	/** Makes the next terminate() leave the process running, as a kill it did not win would. */
	refuseToDie: boolean;
	/** Ends the process outside terminate(), as a crash or a self-exit would. */
	exit(code: number): void;
}

/** The panel this parent opened for a child, with the two answers the manager acts on. */
class FakeAttachment implements HostAttachment {
	readonly identity: {
		host: "herdr";
		attachmentId: string;
		createdBy: string;
	};
	readonly launch = { stdout: "", stderr: "", exitCode: 0, timedOut: false };
	readonly reportsFocus: boolean;
	public alive = true;
	public focused: boolean | undefined = false;
	/** Makes cleanup() fail and leave the panel standing, as a refusing host would. */
	public refuseToClose = false;
	/** Makes observation time out, which is not the same answer as "the panel is gone". */
	public unknown = false;
	public cleanups = 0;
	readonly #closeWaiters: Array<() => void> = [];

	public constructor(reportsFocus: boolean, ownerId: string) {
		this.identity = { host: "herdr", attachmentId: "wG:tH", createdBy: ownerId };
		this.reportsFocus = reportsFocus;
	}

	public async observe(): Promise<HostObservation> {
		return {
			identity: this.identity,
			alive: this.unknown ? false : this.alive,
			known: !this.unknown,
			...(this.focused === undefined ? {} : { focused: this.focused }),
			detail: "",
		};
	}

	/** Resolves once this panel's cleanup ran, so a countdown assertion binds to the close itself. */
	public closed(): Promise<void> {
		if (this.cleanups > 0) return Promise.resolve();
		return new Promise((resolve) => {
			this.#closeWaiters.push(resolve);
		});
	}

	public async cleanup(): Promise<HostAttachment["launch"]> {
		this.cleanups += 1;
		for (const resolve of this.#closeWaiters.splice(0)) resolve();
		if (this.refuseToClose) {
			return { stdout: "", stderr: "close denied", exitCode: 1, timedOut: false };
		}
		this.alive = false;
		return this.launch;
	}
}

interface Harness {
	readonly manager: SubagentManager;
	readonly bridge: FakeBridge;
	readonly launch: ReturnType<typeof vi.fn>;
	readonly openPanel: ReturnType<typeof vi.fn>;
	/** The background process handles this harness's launches created, by child id. */
	readonly runtimes: Map<string, FakeRuntime>;
	readonly panels: Map<string, FakeAttachment>;
	readonly connect: ReturnType<typeof vi.fn>;
	readonly reports: ParentChannelReport[];
	/** Resolves once this many reports reached the parent channel; the delivery is the event. */
	reportsArrived(count: number): Promise<void>;
	readonly registry: ReturnType<typeof createSubagentRegistry>;
	/** This harness's parent session id; its children and bridge events are scoped to it. */
	readonly parentSessionId: string;
	readonly cwd: string;
	addChild(id: string, overrides?: Partial<SubagentRecord>): SubagentRecord;
}

class FakeBridge implements ChildBridgeTransport {
	readonly connected = new Set<string>();
	readonly requests: Array<{ childId: string; operation: string; payload: unknown }> = [];
	#events = new Set<(childId: string, event: unknown) => void>();
	#connections = new Set<(childId: string, connected: boolean) => void>();
	public responses = new Map<string, () => Promise<unknown>>();
	public fallbackResponse: (childId: string, operation: BridgeOperation) => Promise<unknown> =
		async () => undefined;

	public isConnected(childId: string): boolean {
		return this.connected.has(childId);
	}

	public async request(
		childId: string,
		operation: BridgeOperation,
		payload?: unknown,
	): Promise<unknown> {
		this.requests.push({ childId, operation, payload });
		if (!this.connected.has(childId)) {
			throw new BridgeError("child_not_connected", `Child ${childId} is not connected`);
		}
		const responder = this.responses.get(`${childId}:${operation}`);
		if (responder !== undefined) return responder();
		if (operation === "session_facts") {
			const entriesResponder = this.responses.get(`${childId}:get_entries`);
			if (entriesResponder !== undefined) {
				const body = await entriesResponder();
				if (!isRecord(body) || !Array.isArray(body.entries)) return body;
				const expected = isRecord(payload) ? payload.expectedInput : undefined;
				return transcriptFacts(body.entries, typeof expected === "string" ? expected : undefined);
			}
		}
		return this.fallbackResponse(childId, operation);
	}

	public onEvent(listener: (childId: string, event: unknown) => void): () => void {
		this.#events.add(listener);
		return () => {
			this.#events.delete(listener);
		};
	}

	public onConnectionChange(listener: (childId: string, connected: boolean) => void): () => void {
		this.#connections.add(listener);
		return () => {
			this.#connections.delete(listener);
		};
	}

	public connect(childId: string): void {
		this.connected.add(childId);
		for (const listener of [...this.#connections]) listener(childId, true);
	}

	public disconnect(childId: string): void {
		this.connected.delete(childId);
		for (const listener of [...this.#connections]) listener(childId, false);
	}

	public emit(childId: string, event: unknown): void {
		for (const listener of [...this.#events]) listener(childId, event);
	}

	/** Waits until the child's per-transition chain has applied everything queued so far. */
	public async settle(): Promise<void> {
		for (let index = 0; index < 20; index++) await Promise.resolve();
	}
}

function launchConfig(subagentId: string, cwd: string): EffectiveLaunchConfig {
	return {
		subagentId,
		invocation: { command: process.execPath, args: ["-e", "process.stdin.resume()"] },
		cwd,
		sessionId: `${subagentId}-session`,
		sessionDir: join(cwd, "sessions"),
		agent: {
			name: "worker",
			hidden: false,
			sourcePath: join(cwd, "worker.md"),
			instructions: "Do the work.",
		},
		model: { provider: "anthropic", id: "claude-sonnet-4", source: "parent" },
		thinking: { level: "medium", source: "parent" },
		tools: ["contact_parent"],
		excludeTools: [],
		extensions: { discovery: false, paths: ["/pkg/dist/extension.js"] },
		skills: { discovery: true, paths: [] },
		mcp: { enabled: true },
		prompt: assembleChildPrompt("Do the work."),
		bridgeExtensionPath: "/pkg/dist/extension.js",
	};
}

async function harness(
	options: {
		idleTimeoutMs?: number;
		deadlineMs?: number;
		failedPanelCloseTimeoutMs?: number;
		/** Set when this parent has a presentation host and spawns into panels by default. */
		host?: boolean;
		/** Set when the host cannot report focus, which is how cmux behaves today. */
		blindHost?: boolean;
		/** Set to exercise the host-listing restore path instead of the bridge-only one. */
		directory?: HostDirectory;
		parentSessionId?: string;
	} = {},
): Promise<Harness> {
	const cwd = process.cwd();
	parentSequence += 1;
	const parentSessionId = options.parentSessionId ?? `${PARENT_SESSION_ID}-${parentSequence}`;
	const registry = createSubagentRegistry({ parentSessionId, filePath: STATE_DB_PATH });
	const bridge = new FakeBridge();
	bridge.fallbackResponse = async (id, operation) => {
		if (operation === "get_entries") return { entries: [] };
		if (operation === "session_facts") return transcriptFacts([]);
		if (operation === "prompt" || operation === "steer") {
			return { accepted: true, path: join(cwd, "sessions", `${id}-session.jsonl`) };
		}
		if (operation !== "get_state") return undefined;
		const record = await registry.get(id);
		return {
			idle: record?.state !== "running",
			pendingMessages: false,
		};
	};
	const reports: ParentChannelReport[] = [];
	const reportWaiters: Array<{ count: number; resolve: () => void }> = [];
	let sequence = 0;
	const runtimes = new Map<string, FakeRuntime>();
	const panels = new Map<string, FakeAttachment>();
	/** Whatever starts a child's runtime also records it and lets the bridge connect, as Pi does. */
	const startRuntime = async (record: SubagentRecord): Promise<FakeRuntime> => {
		let exit: (code: number) => void = () => {};
		const runtime: FakeRuntime = {
			pid: 1000 + sequence,
			alive: true,
			// A real process exits on its own schedule, so the exit promise is resolved explicitly.
			exited: new Promise<number>((resolve) => {
				exit = resolve;
			}),
			terminated: 0,
			refuseToDie: false,
			async terminate(): Promise<void> {
				runtime.terminated += 1;
				if (runtime.refuseToDie) return;
				runtime.alive = false;
				bridge.connect(record.subagentId);
				bridge.disconnect(record.subagentId);
				exit(0);
			},
			exit,
		};
		runtimes.set(record.subagentId, runtime);
		// The real launcher records which runtime it started before the child connects.
		await registry.update(record.subagentId, (current) => ({
			...current,
			runtime: { runtimeIdentity: `runtime-${sequence}`, endpoint: "/tmp/parent.sock" },
		}));
		bridge.connect(record.subagentId);
		return runtime;
	};
	const launch = vi.fn(async (record: SubagentRecord): Promise<LaunchOutcome<FakeRuntime>> => {
		return { handle: await startRuntime(record) };
	});
	const openPanel = vi.fn(
		async (record: SubagentRecord): Promise<LaunchOutcome<FakeAttachment>> => {
			await startRuntime(record);
			const attachment = new FakeAttachment(options.blindHost !== true, parentSessionId);
			panels.set(record.subagentId, attachment);
			return { handle: attachment };
		},
	);
	const connect = vi.fn(async (record: SubagentRecord) => bridge.isConnected(record.subagentId));
	const recordFactory = (id: string, overrides: Partial<SubagentRecord> = {}): SubagentRecord => {
		const config = launchConfig(id, cwd);
		return {
			subagentId: id,
			parentSessionId,
			revision: 1,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionId: config.sessionId,
			cwd,
			initialTask: "Do the work.",
			intent: "active",
			state: "running",
			presentation: "background",
			persistence: "never_flushed",
			launchConfig: config,
			...overrides,
		};
	};
	const manager = new SubagentManager({
		parentSessionId,
		registry,
		bridge,
		launch,
		connect,
		...(options.host === true
			? { presentation: { reason: "default host herdr is available", openPanel } }
			: {}),
		...(options.directory === undefined ? {} : { directory: options.directory }),
		channel: {
			async deliver(report): Promise<void> {
				reports.push(report);
				for (const waiter of [...reportWaiters]) {
					if (reports.length < waiter.count) continue;
					reportWaiters.splice(reportWaiters.indexOf(waiter), 1);
					waiter.resolve();
				}
			},
		},
		deadlineMs: options.deadlineMs ?? 1_000,
		...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
		...(options.failedPanelCloseTimeoutMs === undefined
			? {}
			: { failedPanelCloseTimeoutMs: options.failedPanelCloseTimeoutMs }),
		async resolve(input: SpawnSubagentInput): Promise<EffectiveLaunchConfig> {
			sequence += 1;
			return launchConfig(`sa_child${sequence}`, input.cwd ?? cwd);
		},
		async bootstrap({ task, launchConfig: config, presentation }): Promise<SubagentRecord> {
			const record = recordFactory(config.subagentId, {
				state: "running",
				initialTask: task,
				launchConfig: config,
				presentation,
			});
			return await registry.create(record);
		},
	});
	return {
		manager,
		bridge,
		launch,
		openPanel,
		panels,
		runtimes,
		connect,
		reports,
		reportsArrived(count: number): Promise<void> {
			if (reports.length >= count) return Promise.resolve();
			return new Promise<void>((resolve) => {
				reportWaiters.push({ count, resolve });
			});
		},
		registry,
		parentSessionId,
		cwd,
		async addChild(id: string, overrides: Partial<SubagentRecord> = {}): Promise<SubagentRecord> {
			return await registry.create(recordFactory(id, overrides));
		},
	} as unknown as Harness;
}

/** Waits for the real registry commit; lease releases need not publish a UI notification. */
function recordMatches(
	harness: Harness,
	id: string,
	matches: (record: SubagentRecord) => boolean,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const update = harness.registry.update;
		const check = (record: SubagentRecord | undefined): void => {
			if (record?.subagentId !== id || !matches(record)) return;
			spy.mockRestore();
			resolve();
		};
		const spy = vi.spyOn(harness.registry, "update").mockImplementation(async (...args) => {
			const record = await update(...args);
			check(record);
			return record;
		});
		void harness.registry.get(id).then(check, (error: unknown) => {
			spy.mockRestore();
			reject(error);
		});
	});
}

function settledState(harness: Harness, id: string, state: SubagentRecord["state"]): Promise<void> {
	return recordMatches(harness, id, (record) => record.state === state);
}

/** Lets the dispatch chain reach the bridge without waiting for a timer. */
async function flush(): Promise<void> {
	for (let index = 0; index < 4; index += 1) await turn();
}

/** Delivers the success report that ends a delegated turn, which is what settles its revision. */
async function reportSuccess(harness: Harness, id: string, message: string): Promise<void> {
	const record = await harness.registry.get(id);
	await harness.manager.handleChildRequest(id, "contact_parent", {
		type: "pi_subagent_report",
		parentSessionId: harness.parentSessionId,
		childId: id,
		runtimeIdentity: record?.runtime?.runtimeIdentity,
		reason: "success",
		message,
	});
}

/** The child begins the turn the parent just dispatched, which binds it to a work version. */
async function startTurn(harness: Harness, id: string): Promise<void> {
	harness.bridge.emit(id, { type: "agent_start" });
	// The projection of that start runs on the child's own chain; let it finish before reporting.
	for (let index = 0; index < 4; index += 1) await harness.bridge.settle();
}

/** Answers the parent's next prompt with the compaction this child runs. */
function acknowledgeCompaction(harness: Harness, id: string, operation: string, controlId: string) {
	harness.bridge.responses.set(`${id}:${operation}`, async () => ({
		accepted: true,
		path: join(harness.cwd, "sessions", `${id}-session.jsonl`),
		compacting: true,
		controlId,
	}));
}

/** Delivers the report that ends one compaction operation. */
async function reportCompaction(
	harness: Harness,
	id: string,
	controlId: string,
	message: string,
	reason: "success" | "blocked" = "success",
): Promise<void> {
	const record = await harness.registry.get(id);
	await harness.manager.handleChildRequest(id, "contact_parent", {
		type: "pi_subagent_report",
		parentSessionId: harness.parentSessionId,
		childId: id,
		runtimeIdentity: record?.runtime?.runtimeIdentity,
		reason,
		message,
		controlId,
	});
}

describe("SubagentManager over the bridge", () => {
	test("delegation without an id spawns through the existing launch path", async () => {
		const current = await harness({ host: true });
		const submitted = await current.manager.submitDelegation({
			agent: "worker",
			task: "Implement the feature",
			cwd: current.cwd,
		});
		if ("reason" in submitted) throw new Error(submitted.reason);
		expect(submitted.action).toBe("spawn");
		expect(submitted.child.id).toBe("sa_child1");
		expect(submitted.child.presentation).toBe("panel");
		expect(current.bridge.requests.filter((request) => request.operation === "prompt")).toEqual([
			{
				childId: submitted.child.id,
				operation: "prompt",
				payload: { message: "Implement the feature" },
			},
		]);
		await current.manager.stop(submitted.child.id);
	});

	test("delegation with an id silently ignores agent and new-child options", async () => {
		const current = await harness();
		const initial = await current.manager.spawn({ agent: "worker", task: "First task" });
		if ("reason" in initial) throw new Error(initial.reason);
		const record = await current.registry.get(initial.child.id);
		if (record === undefined) throw new Error("Spawned child not persisted");
		const spawn = vi.spyOn(current.manager, "spawn");
		const send = vi.spyOn(current.manager, "send");
		const submitted = await current.manager.submitDelegation({
			id: record.subagentId,
			agent: "agent-that-does-not-exist",
			task: "Continue the tests",
			cwd: "/different/project",
		});
		if ("reason" in submitted) throw new Error(submitted.reason);
		expect(submitted).toMatchObject({
			action: "reuse",
			child: { id: record.subagentId, sessionId: record.sessionId, agent: "worker" },
		});
		expect(spawn).not.toHaveBeenCalled();
		expect(current.launch).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(record.subagentId, "Continue the tests");
		expect(current.bridge.requests.at(-1)).toMatchObject({
			childId: record.subagentId,
			operation: "steer",
			payload: { message: "Continue the tests" },
		});
		expect(await current.registry.get(record.subagentId)).toMatchObject({
			sessionId: record.sessionId,
			launchConfig: record.launchConfig,
		});
		await current.manager.stop(record.subagentId);
	});

	test("delegation resumes a disconnected child using its original session", async () => {
		const current = await harness();
		const record = await current.addChild("sa_resume", { state: "done" });
		const submitted = await current.manager.submitDelegation({
			id: record.subagentId,
			task: "Run the next task",
		});
		expect(submitted).toMatchObject({
			action: "reuse",
			child: { id: record.subagentId, sessionId: record.sessionId },
		});
		expect(current.launch).toHaveBeenCalledTimes(1);
		expect(current.bridge.requests.at(-1)).toMatchObject({
			childId: record.subagentId,
			operation: "prompt",
			payload: { message: "Run the next task" },
		});
		await current.manager.stop(record.subagentId);
	});

	test("delegation validates only the selected target and preserves native failures", async () => {
		const current = await harness();
		expect(await current.manager.submitDelegation({ task: "work" })).toMatchObject({
			operation: "delegate",
			reason: "Agent is required without an id",
			safeToRetry: false,
		});
		expect(
			await current.manager.submitDelegation({
				id: "",
				agent: "worker",
				task: "work",
			}),
		).toMatchObject({ operation: "delegate", reason: "Child id must not be empty" });
		expect(await current.manager.submitDelegation({ agent: "worker", task: "   " })).toMatchObject({
			operation: "delegate",
			reason: "Task must not be empty",
		});
		expect(
			await current.manager.submitDelegation({
				id: "not-found",
				agent: "worker",
				task: "continue",
			}),
		).toMatchObject({ operation: "send", reason: "Unknown child", childId: "not-found" });
		expect(current.launch).not.toHaveBeenCalled();
	});

	test("settles failed startup and reports persisted identity and retry safety", async () => {
		const test1 = await harness();
		test1.launch.mockImplementation(async () => ({ failure: "bridge startup failed" }));
		expect(await test1.manager.spawn({ agent: "worker", task: "work" })).toMatchObject({
			childId: "sa_child1",
			state: "error",
			safeToRetry: true,
			sideEffects: ["registry record persisted", "no runtime remains"],
		});
		expect(await test1.manager.get("sa_child1")).toMatchObject({
			state: "error",
			interrupted: "bridge startup failed",
		});
	});

	test("reserves the agent identity and first revision before the child is launched", async () => {
		const current = await harness();
		current.launch.mockImplementation(async () => ({ failure: "bridge startup failed" }));

		const delegated = await current.manager.delegate({
			agent: "worker",
			task: "work",
			wait: false,
		});

		expect(delegated).toMatchObject({
			id: "sa_child1",
			revision: 1,
			status: "failed",
			hasOutput: false,
			error: { reason: "bridge startup failed", safeToRetry: true },
		});
		// The identity and its revision were reserved before the launch, so the failure has a record.
		expect(
			latestReceiptForChild(STATE_DB_PATH, current.parentSessionId, "sa_child1"),
		).toMatchObject({ revision: 1, status: "failed", resultText: "bridge startup failed" });
	});

	test("accepts a delegation without waiting and settles its revision", async () => {
		const current = await harness();
		const accepted = await current.manager.delegate({
			agent: "worker",
			task: "work",
			wait: false,
		});
		if ("reason" in accepted) throw new Error(accepted.reason);
		expect(accepted).toMatchObject({
			id: "sa_child1",
			revision: 1,
			status: "accepted",
			hasOutput: false,
			progress: { runtimeState: "running" },
		});

		await startTurn(current, "sa_child1");
		await reportSuccess(current, "sa_child1", "the answer");

		expect(
			latestReceiptForChild(STATE_DB_PATH, current.parentSessionId, "sa_child1"),
		).toMatchObject({ revision: 1, status: "completed", resultText: "the answer" });
	});

	test("waiting returns the result of the revision it waited for", async () => {
		const current = await harness();
		const waiting = current.manager.delegate({ agent: "worker", task: "work" });
		await flush();

		await startTurn(current, "sa_child1");
		await reportSuccess(current, "sa_child1", "the answer");

		await expect(waiting).resolves.toMatchObject({
			id: "sa_child1",
			revision: 1,
			status: "completed",
			hasOutput: true,
			resultText: "the answer",
		});
	});

	test("a second waiting delegation is refused before it steers", async () => {
		const current = await harness();
		const waiting = current.manager.delegate({ agent: "worker", task: "first" });
		await flush();

		const conflict = await current.manager.delegate({ id: "sa_child1", task: "second" });

		expect(conflict).toMatchObject({
			operation: "delegate",
			reason: expect.stringContaining("already has a waiting delegation"),
			safeToRetry: true,
		});
		expect(current.bridge.requests.filter((request) => request.operation === "steer")).toEqual([]);

		await startTurn(current, "sa_child1");
		await reportSuccess(current, "sa_child1", "first answer");
		await expect(waiting).resolves.toMatchObject({ revision: 1, status: "completed" });
	});

	test("steers accepted into one turn keep separate revisions and share its settlement", async () => {
		const current = await harness();
		const first = await current.manager.delegate({
			agent: "worker",
			task: "one",
			wait: false,
		});
		if ("reason" in first) throw new Error(first.reason);
		await flush();
		current.bridge.emit("sa_child1", { type: "agent_start" });
		await current.bridge.settle();

		const second = await current.manager.delegate({ id: "sa_child1", task: "two", wait: false });
		if ("reason" in second) throw new Error(second.reason);
		expect([first.revision, second.revision]).toEqual([1, 2]);

		await reportSuccess(current, "sa_child1", "the shared answer");

		for (const revision of [1, 2]) {
			expect(
				readReceiptRevision(STATE_DB_PATH, current.parentSessionId, "sa_child1", revision),
			).toMatchObject({ status: "completed", resultText: "the shared answer" });
		}
	});

	test("validates the target before reserving anything", async () => {
		const current = await harness();

		expect(await current.manager.delegate({ task: "work" })).toMatchObject({
			reason: "Agent is required without an id",
		});
		expect(await current.manager.delegate({ agent: "worker", task: "   " })).toMatchObject({
			reason: "Task must not be empty",
		});
		expect(await current.manager.delegate({ id: "agent-9", task: "work" })).toMatchObject({
			reason: "Unknown child",
		});

		expect(listReceipts(STATE_DB_PATH, current.parentSessionId).receipts).toEqual([]);
		expect(current.launch).not.toHaveBeenCalled();
	});

	test("a compaction delegation settles through its own operation", async () => {
		const current = await harness();
		acknowledgeCompaction(current, "sa_child1", "prompt", "op-1");

		const waiting = current.manager.delegate({ agent: "worker", task: "/compact" });
		await flush();

		expect(
			latestReceiptForChild(STATE_DB_PATH, current.parentSessionId, "sa_child1"),
		).toMatchObject({ revision: 1, status: "accepted", controlId: "op-1" });
		expect(
			latestReceiptForChild(STATE_DB_PATH, current.parentSessionId, "sa_child1")?.runBoundary,
		).toBeUndefined();

		// A turn's answer is not a compaction result.
		await startTurn(current, "sa_child1");
		await reportSuccess(current, "sa_child1", "ordinary answer");
		expect(latestReceiptForChild(STATE_DB_PATH, current.parentSessionId, "sa_child1")?.status).toBe(
			"accepted",
		);

		await reportCompaction(current, "sa_child1", "op-1", "Context compacted (10 -> 4 tokens).");

		await expect(waiting).resolves.toMatchObject({
			revision: 1,
			status: "completed",
			hasOutput: true,
			resultText: "Context compacted (10 -> 4 tokens).",
		});
	});

	test("delegations joining one compaction settle with that single report", async () => {
		const current = await harness();
		acknowledgeCompaction(current, "sa_child1", "prompt", "op-1");
		const first = await current.manager.delegate({
			agent: "worker",
			task: "/compact",
			wait: false,
		});
		if ("reason" in first) throw new Error(first.reason);
		await flush();
		acknowledgeCompaction(current, "sa_child1", "steer", "op-1");
		const second = await current.manager.delegate({
			id: "sa_child1",
			task: "/compact",
			wait: false,
		});
		if ("reason" in second) throw new Error(second.reason);
		expect([first.revision, second.revision]).toEqual([1, 2]);

		await reportCompaction(current, "sa_child1", "op-1", "Context compacted (10 -> 4 tokens).");

		for (const revision of [1, 2]) {
			expect(
				readReceiptRevision(STATE_DB_PATH, current.parentSessionId, "sa_child1", revision),
			).toMatchObject({ status: "completed", controlId: "op-1" });
		}
	});

	test("a later compaction is a separate operation and ignores a late report", async () => {
		const current = await harness();
		acknowledgeCompaction(current, "sa_child1", "prompt", "op-1");
		const first = await current.manager.delegate({
			agent: "worker",
			task: "/compact",
			wait: false,
		});
		if ("reason" in first) throw new Error(first.reason);
		await flush();
		await reportCompaction(current, "sa_child1", "op-1", "first compaction");

		acknowledgeCompaction(current, "sa_child1", "steer", "op-2");
		const second = await current.manager.delegate({
			id: "sa_child1",
			task: "/compact",
			wait: false,
		});
		if ("reason" in second) throw new Error(second.reason);

		await reportCompaction(current, "sa_child1", "op-1", "duplicate report for the old operation");
		expect(
			readReceiptRevision(STATE_DB_PATH, current.parentSessionId, "sa_child1", 2),
		).toMatchObject({ status: "accepted", controlId: "op-2" });

		await reportCompaction(current, "sa_child1", "op-2", "second compaction");
		expect(
			readReceiptRevision(STATE_DB_PATH, current.parentSessionId, "sa_child1", 2),
		).toMatchObject({ status: "completed", resultText: "second compaction" });
	});

	test("a failed compaction settles its revision as blocked", async () => {
		const current = await harness();
		acknowledgeCompaction(current, "sa_child1", "prompt", "op-1");
		const waiting = current.manager.delegate({ agent: "worker", task: "/compact" });
		await flush();

		await reportCompaction(
			current,
			"sa_child1",
			"op-1",
			"Compaction failed: out of room",
			"blocked",
		);

		await expect(waiting).resolves.toMatchObject({
			status: "blocked",
			hasOutput: true,
			resultText: "Compaction failed: out of room",
		});
	});

	test("an unconfirmed compaction is recorded as uncertain after a restart", async () => {
		const current = await harness();
		acknowledgeCompaction(current, "sa_child1", "prompt", "op-1");
		const waiting = current.manager.delegate({ agent: "worker", task: "/compact" });
		await flush();

		await current.manager.recover();

		await expect(waiting).resolves.toMatchObject({ status: "uncertain" });
		expect(
			readReceiptRevision(STATE_DB_PATH, current.parentSessionId, "sa_child1", 1),
		).toMatchObject({ status: "uncertain", controlId: "op-1" });
	});

	test("a waiting delegation owns its turn's delivery", async () => {
		const current = await harness();
		current.bridge.responses.set("sa_child1:get_entries", async () => ({
			entries: [assistantEntry("the answer")],
		}));

		const waiting = current.manager.delegate({ agent: "worker", task: "work" });
		await flush();
		await startTurn(current, "sa_child1");
		current.bridge.emit("sa_child1", {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		// The turn settles through the automatic path, which runs on its own timer.
		await expect(until(waiting)).resolves.toMatchObject({
			status: "completed",
			hasOutput: true,
			resultText: "the answer",
		});
		// The tool result carried it, so the automatic path must not deliver it again.
		expect(current.reports).toEqual([]);
	});

	test("a cancelled wait leaves the turn to automatic delivery", async () => {
		const current = await harness();
		current.bridge.responses.set("sa_child1:get_entries", async () => ({
			entries: [assistantEntry("the answer")],
		}));
		const controller = new AbortController();

		const waiting = current.manager.delegate({ agent: "worker", task: "work" }, controller.signal);
		await flush();
		controller.abort();
		await expect(waiting).resolves.toMatchObject({
			id: "sa_child1",
			revision: 1,
			status: "accepted",
		});

		await startTurn(current, "sa_child1");
		current.bridge.emit("sa_child1", {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await until(current.reportsArrived(1));

		expect(current.reports.map((report) => report.message)).toContain("the answer");
		// Cancelling the wait never stops the work it was waiting for.
		expect(await current.manager.get("sa_child1")).toMatchObject({ state: "done" });
	});

	test("a turn that starts before its dispatch is acknowledged still settles", async () => {
		const current = await harness();
		// The child can announce its turn before the parent's own prompt acknowledgement lands.
		current.bridge.responses.set("sa_child1:prompt", async () => {
			current.bridge.emit("sa_child1", { type: "agent_start" });
			await current.bridge.settle();
			return { accepted: true, path: join(current.cwd, "sessions", "sa_child1-session.jsonl") };
		});

		const accepted = await current.manager.delegate({
			agent: "worker",
			task: "work",
			wait: false,
		});
		expect(accepted).toMatchObject({ id: "sa_child1", revision: 1 });
		await reportSuccess(current, "sa_child1", "the answer");

		// The receipt must be bound to the turn that actually ran, or it stays open forever.
		expect(
			readReceiptRevision(STATE_DB_PATH, current.parentSessionId, "sa_child1", 1),
		).toMatchObject({ status: "completed", resultText: "the answer" });
	});

	test("a settlement that cannot be recorded is reported, not delivered", async () => {
		const current = await harness();
		const waiting = current.manager.delegate({ agent: "worker", task: "work" });
		await flush();
		await startTurn(current, "sa_child1");
		const db = openStateDb(STATE_DB_PATH);
		db.exec("ALTER TABLE delegations RENAME TO delegations_unavailable");
		try {
			await expect(reportSuccess(current, "sa_child1", "the answer")).rejects.toThrow(
				"Settlement was not recorded",
			);
			// Nothing is durable, so nothing may be pushed: the child still holds the report.
			expect(current.reports).toEqual([]);
		} finally {
			db.exec("ALTER TABLE delegations_unavailable RENAME TO delegations");
		}
		current.manager.dispose();
		await expect(waiting).resolves.toMatchObject({ status: "accepted" });
	});

	test("a detached steer does not release the active wait's delivery claim", async () => {
		const current = await harness();
		current.bridge.responses.set("sa_child1:get_entries", async () => ({
			entries: [assistantEntry("the answer")],
		}));

		const waiting = current.manager.delegate({ agent: "worker", task: "work" });
		await flush();
		const steer = await current.manager.delegate({
			id: "sa_child1",
			task: "keep going",
			wait: false,
		});
		expect(steer).toMatchObject({ id: "sa_child1", revision: 2, status: "accepted" });

		await startTurn(current, "sa_child1");
		current.bridge.emit("sa_child1", {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await expect(until(waiting)).resolves.toMatchObject({
			status: "completed",
			hasOutput: true,
		});
		// The waiting tool call still owns this turn: the steer must not hand it back to the push.
		expect(current.reports).toEqual([]);
	});

	test("a blocker report during a wait is delivered once", async () => {
		const current = await harness();

		const waiting = current.manager.delegate({ agent: "worker", task: "work" });
		await flush();
		await startTurn(current, "sa_child1");
		const record = await current.registry.get("sa_child1");
		await current.manager.handleChildRequest("sa_child1", "contact_parent", {
			type: "pi_subagent_report",
			parentSessionId: current.parentSessionId,
			childId: "sa_child1",
			runtimeIdentity: record?.runtime?.runtimeIdentity,
			reason: "blocked",
			message: "need a decision",
		});

		await expect(until(waiting)).resolves.toMatchObject({
			status: "blocked",
			resultText: "need a decision",
		});
		expect(current.reports).toEqual([]);
	});

	test("dispose ends a pending wait instead of leaving it hanging", async () => {
		const current = await harness();
		const waiting = current.manager.delegate({ agent: "worker", task: "work" });
		await flush();

		current.manager.dispose();

		await expect(waiting).resolves.toMatchObject({ id: "sa_child1", status: "accepted" });
	});

	test("inspect reads the latest revision without its body by default", async () => {
		const current = await harness();
		const first = await current.manager.delegate({ agent: "worker", task: "one", wait: false });
		if ("reason" in first) throw new Error(first.reason);
		await flush();
		await startTurn(current, "sa_child1");
		await reportSuccess(current, "sa_child1", "first answer");
		const second = await current.manager.delegate({
			id: "sa_child1",
			task: "two",
			wait: false,
		});
		if ("reason" in second) throw new Error(second.reason);

		const latest = await current.manager.inspect({ id: "sa_child1" });
		if ("reason" in latest) throw new Error(latest.reason);
		expect(latest).toMatchObject({
			id: "sa_child1",
			revision: 2,
			status: "accepted",
			hasOutput: false,
		});
		expect(latest).not.toHaveProperty("resultText");
		expect(latest.progress?.runtimeState).toBeDefined();
	});

	test("inspect reads one historical revision and reports a missing one", async () => {
		const current = await harness();
		const first = await current.manager.delegate({ agent: "worker", task: "one", wait: false });
		if ("reason" in first) throw new Error(first.reason);
		await flush();
		await startTurn(current, "sa_child1");
		await reportSuccess(current, "sa_child1", "first answer");

		await expect(current.manager.inspect({ id: "sa_child1", revision: 1 })).resolves.toMatchObject({
			revision: 1,
			status: "completed",
			hasOutput: true,
		});
		await expect(current.manager.inspect({ id: "sa_child1", revision: 9 })).resolves.toMatchObject({
			operation: "get",
			reason: "This agent has no delegation revision 9",
		});
		await expect(current.manager.inspect({ id: "agent-9" })).resolves.toMatchObject({
			reason: "Unknown child",
		});
	});

	test("an explicit read returns the body and an empty result still counts as output", async () => {
		const current = await harness();
		const first = await current.manager.delegate({ agent: "worker", task: "one", wait: false });
		if ("reason" in first) throw new Error(first.reason);
		await flush();
		await startTurn(current, "sa_child1");
		await reportSuccess(current, "sa_child1", "the answer");

		await expect(
			current.manager.inspect({ id: "sa_child1", includeOutput: true }),
		).resolves.toMatchObject({ hasOutput: true, resultText: "the answer" });

		const empty = await current.manager.delegate({ id: "sa_child1", task: "two", wait: false });
		if ("reason" in empty) throw new Error(empty.reason);
		// An empty answer is a real result: the receipt records it and the projection reports it.
		settleReceipts(STATE_DB_PATH, current.parentSessionId, {
			childId: "sa_child1",
			status: "completed",
			message: "",
			workVersion: empty.revision === 2 ? 2 : 1,
		});
		await expect(
			current.manager.inspect({ id: "sa_child1", revision: 2, includeOutput: true }),
		).resolves.toMatchObject({ hasOutput: true, resultText: "" });
	});

	test("an oversized result is bounded with a reference to the full text", async () => {
		const current = await harness();
		const first = await current.manager.delegate({ agent: "worker", task: "one", wait: false });
		if ("reason" in first) throw new Error(first.reason);
		await flush();
		await startTurn(current, "sa_child1");
		const long = Array.from({ length: 2_000 }, (_, index) => `line ${index} of the answer`).join(
			"\n",
		);
		await reportSuccess(current, "sa_child1", long);

		const view = await current.manager.inspect({ id: "sa_child1", includeOutput: true });
		if ("reason" in view) throw new Error(view.reason);
		const text = view.resultText ?? "";
		expect(text.length).toBeLessThan(long.length);
		expect(text).toContain("omitted");
		expect(text).toContain("Full output");
	});

	test("the dashboard summarises every agent without any result body", async () => {
		const current = await harness();
		const first = await current.manager.delegate({ agent: "worker", task: "one", wait: false });
		if ("reason" in first) throw new Error(first.reason);
		await flush();
		await startTurn(current, "sa_child1");
		await reportSuccess(current, "sa_child1", "first answer");

		const dashboard = await current.manager.dashboard();
		expect(dashboard).toMatchObject({
			total: 1,
			running: 0,
			blocked: 0,
			completed: 1,
			failed: 0,
		});
		expect(dashboard.children[0]).toMatchObject({
			id: "sa_child1",
			revision: 1,
			status: "completed",
			hasOutput: true,
		});
		expect(dashboard.children[0]).not.toHaveProperty("resultText");
	});

	test("stop ends open revisions, keeps finished ones, and repeats safely", async () => {
		const current = await harness();
		const first = await current.manager.delegate({ agent: "worker", task: "one", wait: false });
		if ("reason" in first) throw new Error(first.reason);
		await flush();
		await startTurn(current, "sa_child1");
		await reportSuccess(current, "sa_child1", "first answer");
		const second = await current.manager.delegate({
			id: "sa_child1",
			task: "two",
			wait: false,
		});
		if ("reason" in second) throw new Error(second.reason);

		const stopped = await current.manager.stopAgent("sa_child1");
		if ("reason" in stopped) throw new Error(stopped.reason);
		expect(stopped).toMatchObject({ id: "sa_child1", revision: 2, status: "failed" });
		expect(stopped.progress?.runtimeState).not.toBe("running");
		// The finished delegation keeps its result; only the open one ends as failed.
		await expect(
			current.manager.inspect({ id: "sa_child1", revision: 1, includeOutput: true }),
		).resolves.toMatchObject({ status: "completed", resultText: "first answer" });

		const again = await current.manager.stopAgent("sa_child1");
		expect(again).toMatchObject({ revision: 2, status: "failed" });
	});

	test("a panel that cannot open degrades the child to the background", async () => {
		const test1 = await harness({ host: true });
		test1.openPanel.mockImplementation(async () => ({
			failure: "host timeout",
		}));
		const spawned = await test1.manager.spawn({ agent: "worker", task: "work" });
		if ("reason" in spawned) throw new Error(spawned.reason);
		expect(spawned.note).toBe(
			"Panel unavailable (host timeout), so this child runs in the background",
		);
		// The record says where the child actually runs, so nothing retries the panel later.
		expect(spawned.child.presentation).toBe("background");
		await expect(test1.manager.send("sa_child1", "continue")).resolves.toMatchObject({
			id: "sa_child1",
		});
		expect(test1.openPanel).toHaveBeenCalledTimes(1);
	});

	test("an explicit panel request fails instead of degrading", async () => {
		const test1 = await harness({ host: true });
		test1.openPanel.mockImplementation(async () => ({
			failure: "host timeout",
		}));
		expect(
			await test1.manager.spawn({ agent: "worker", task: "work", presentation: "panel" }),
		).toMatchObject({
			childId: "sa_child1",
			state: "error",
			safeToRetry: true,
			sideEffects: ["registry record persisted", "no runtime remains"],
		});
		expect(test1.openPanel).toHaveBeenCalledTimes(1);
	});

	test("discards an automatic report if a new turn starts during transcript inspection", async () => {
		const test1 = await harness({ host: true, idleTimeoutMs: 60_000 });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "work" });
		if ("reason" in spawned) throw new Error(spawned.reason);
		let resolveEntries: (entries: unknown) => void = () => {};
		const entries = new Promise<unknown>((resolve) => {
			resolveEntries = resolve;
		});
		let markRead: () => void = () => {};
		const transcriptRead = new Promise<void>((resolve) => {
			markRead = resolve;
		});
		const getEntries = vi.fn(() => {
			markRead();
			return entries;
		});
		test1.bridge.responses.set(`${spawned.child.id}:get_entries`, getEntries);
		test1.bridge.emit(spawned.child.id, { type: "agent_settled" });
		// The transcript read is held open by this test: the manager reaching for it is the event.
		await until(transcriptRead);
		test1.bridge.emit(spawned.child.id, { type: "agent_start" });
		resolveEntries({ entries: [{ message: { role: "assistant", content: "old answer" } }] });
		await until(settledState(test1, spawned.child.id, "running"));
		expect(test1.reports).toHaveLength(0);
		test1.bridge.emit(spawned.child.id, { type: "tool_execution_start", toolName: "bash" });
		await until(turn());
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({
			state: "running",
			activeTool: "bash",
		});
		expect(test1.reports).toHaveLength(0);
		expect(test1.panels.get(spawned.child.id)?.cleanups).toBe(0);
		await test1.manager.stop(spawned.child.id);
	});
	test("projects a compact streaming update into the child's activity", async () => {
		const test1 = await harness();
		const spawned = await test1.manager.spawn({ agent: "worker", task: "work" });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const id = spawned.child.id;

		test1.bridge.emit(id, {
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0 },
			message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
		});
		await until(turn());
		expect(await test1.manager.get(id)).toMatchObject({ activeTool: "read" });

		test1.bridge.emit(id, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta" },
			message: { role: "assistant", content: [] },
		});
		await until(turn());
		expect(await test1.manager.get(id)).toMatchObject({ summary: "generating..." });
		await test1.manager.stop(id);
	});

	test("spawns a child, delivers the task over the bridge, and reports it running", async () => {
		const test1 = await harness();
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);

		expect(spawned.child.state).toBe("running");
		expect(spawned.child.freshness).toBe("live");
		expect(spawned.path).toBe(join(test1.cwd, "sessions", `${spawned.child.id}-session.jsonl`));
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({ path: spawned.path });
		expect(await test1.registry.get(spawned.child.id)).toMatchObject({
			persistence: "never_flushed",
		});
		expect(await test1.registry.get(spawned.child.id)).not.toHaveProperty("sessionPath");
		expect(test1.launch).toHaveBeenCalledTimes(1);
		// The bridge connection also triggers adoption reads; the task itself is one prompt.
		expect(test1.bridge.requests.filter((request) => request.operation === "prompt")).toEqual([
			{ childId: spawned.child.id, operation: "prompt", payload: { message: "Do the work." } },
		]);
	});

	test("refuses a spawn acknowledgement without the actual session path", async () => {
		const current = await harness();
		current.bridge.fallbackResponse = async () => ({ accepted: true });
		const spawned = await current.manager.spawn({ agent: "worker", task: "Do the work." });
		expect(spawned).toMatchObject({
			operation: "spawn",
			reason: "Child did not confirm its session path",
			safeToRetry: false,
		});
	});

	test("send refreshes the display path without claiming session durability", async () => {
		const current = await harness();
		const spawned = await current.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		await current.manager.stop(spawned.child.id);
		const path = join(current.cwd, "sessions", "resumed-session.jsonl");
		current.bridge.responses.set(`${spawned.child.id}:prompt`, async () => ({
			accepted: true,
			path,
		}));
		const sent = await current.manager.send(spawned.child.id, "Continue");
		expect(sent).toMatchObject({ path });
		expect(await current.manager.get(spawned.child.id)).toMatchObject({ path });
		expect(await current.registry.get(spawned.child.id)).not.toHaveProperty("sessionPath");
	});

	test("persists an unconfirmed initial delivery as failed and not retryable", async () => {
		const test1 = await harness();
		test1.bridge.responses.set("sa_child1:prompt", async () => {
			// The started run is projected through the same per-child chain the failure update uses,
			// so emitting here settles the turn before the delivery failure is recorded.
			test1.bridge.emit("sa_child1", { type: "agent_start" });
			throw new BridgeError("timeout", "no answer");
		});
		test1.bridge.responses.set("sa_child1:get_state", async () => ({
			idle: false,
			pendingMessages: false,
		}));
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		expect(spawned).toMatchObject({
			operation: "spawn",
			reason: "no answer",
			state: "error",
			safeToRetry: false,
		});
		expect(await test1.manager.get("sa_child1")).toMatchObject({
			state: "error",
			freshness: "live",
		});
		// The started run is still in flight, so nothing is reported yet.
		expect(test1.reports).toHaveLength(0);
		test1.bridge.emit("sa_child1", { type: "agent_settled" });
		// The in-flight launch is only released once the child settles, and an empty transcript
		// leaves nothing to report.
		await until(settledState(test1, "sa_child1", "done"));
		expect(test1.reports).toHaveLength(0);
	});

	test("steers whatever the child is doing instead of guessing a mode", async () => {
		const test1 = await harness();
		await test1.addChild("sa_live", { state: "running" });
		test1.bridge.connect("sa_live");
		// Steer whatever the child is doing: on a running child it lands after the current turn's
		// tool calls, and on an idle one there is nothing to interrupt.
		await test1.manager.send("sa_live", "more");
		expect(test1.bridge.requests.at(-1)).toMatchObject({ operation: "steer" });

		await test1.addChild("sa_idle", { state: "done" });
		test1.bridge.connect("sa_idle");
		await test1.manager.send("sa_idle", "more");
		expect(test1.bridge.requests.at(-1)).toMatchObject({ operation: "steer" });
	});

	test("resumes a child whose runtime is gone instead of asking a dead socket", async () => {
		const test1 = await harness();
		await test1.addChild("sa_gone", { state: "done" });
		const sent = await test1.manager.send("sa_gone", "keep going");
		if ("reason" in sent) throw new Error(sent.reason);

		expect(test1.launch).toHaveBeenCalledTimes(1);
		expect(test1.bridge.requests.at(-1)).toMatchObject({
			childId: "sa_gone",
			operation: "prompt",
			payload: { message: "keep going" },
		});
	});

	test("refuses unknown children and resumes stopped children", async () => {
		const test1 = await harness();
		expect(await test1.manager.send("sa_nope", "x")).toMatchObject({ reason: "Unknown child" });
		await test1.addChild("sa_stop", { intent: "stopped", state: "error" });
		expect(await test1.manager.send("sa_stop", "x")).toMatchObject({
			id: "sa_stop",
			state: "running",
		});
		expect(await test1.registry.get("sa_stop")).toMatchObject({ intent: "active" });
	});

	test.each([
		"error",
		"done",
		"blocked",
	] as const)("resumes disconnected %s children with the same session", async (state) => {
		const test1 = await harness();
		const record = await test1.addChild("sa_resume", { state });
		expect(await test1.manager.send(record.subagentId, "try again")).toMatchObject({
			id: record.subagentId,
			state: "running",
			sessionId: record.sessionId,
		});
		expect(test1.launch).toHaveBeenCalledTimes(1);
		expect(test1.bridge.requests.at(-1)).toMatchObject({
			operation: "prompt",
			payload: { message: "try again" },
		});
	});

	test("reports liveness only while the bridge connection is up", async () => {
		const test1 = await harness();
		await test1.addChild("sa_quiet", { state: "done" });
		expect(await test1.manager.get("sa_quiet")).toMatchObject({ freshness: "last_known" });
		expect(await test1.manager.list()).toEqual([
			expect.objectContaining({ id: "sa_quiet", freshness: "last_known" }),
		]);
		test1.bridge.connect("sa_quiet");
		expect(await test1.manager.get("sa_quiet")).toMatchObject({ freshness: "live" });
	});

	test("a running record with no writer reads as blocked and is never written back", async () => {
		const test1 = await harness();
		const record = await test1.addChild("sa_orphan", { state: "running" });
		const before = await test1.registry.get(record.subagentId);
		expect(await test1.manager.get(record.subagentId)).toMatchObject({
			state: "blocked",
			freshness: "last_known",
		});
		expect(await test1.registry.get(record.subagentId)).toEqual(before);

		const lockPath = processLockPath(test1.registry.path, test1.parentSessionId, record.subagentId);
		if (lockPath === undefined) throw new Error("lock path");
		const held = holdProcessLock(lockPath);
		try {
			// Another parent process owns this child; its lock is the only evidence of life.
			expect(await test1.manager.get(record.subagentId)).toMatchObject({
				state: "running",
				freshness: "live",
			});
		} finally {
			held.release();
		}
		expect(await test1.registry.get(record.subagentId)).toEqual(before);
	});

	test("reports a panel child whose writer was already gone when the parent started", async () => {
		const test1 = await harness({
			directory: {
				host: "herdr",
				list: async () => ({ known: true, generation: "g1", present: new Set<string>() }),
				open: async () => ({ failure: "no panel" }),
			},
		});
		await test1.addChild("sa_gone", { state: "running", presentation: "panel" });
		expect(await test1.manager.ready()).toMatchObject({ ok: true });
		await until(test1.reportsArrived(1));
		expect(test1.reports[0]).toMatchObject({ childId: "sa_gone", reason: "blocked" });
		expect(test1.reports[0]?.message).toContain("runtime ended");
		expect(await test1.registry.get("sa_gone")).toMatchObject({
			state: "blocked",
			interrupted: expect.stringContaining("runtime ended"),
		});
	});

	test("leaves a background child the parent process ended to its own exit note", async () => {
		const test1 = await harness({
			directory: {
				host: "herdr",
				list: async () => ({ known: true, generation: "g1", present: new Set<string>() }),
				open: async () => ({ failure: "no panel" }),
			},
		});
		await test1.addChild("sa_bg", { state: "running", presentation: "background" });
		await test1.manager.ready();
		expect(await test1.registry.get("sa_bg")).toMatchObject({
			state: "done",
			interrupted: expect.stringContaining("parent process"),
		});
		expect(test1.reports).toEqual([]);
	});

	test("stops a child by writing the intent first and ending the process", async () => {
		const test1 = await harness();
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);

		const stopped = await test1.manager.stop(spawned.child.id);
		expect(stopped).toMatchObject({ id: spawned.child.id, state: "done" });
		const record = await test1.manager.get(spawned.child.id);
		expect(record).toMatchObject({ state: "done", freshness: "last_known" });
		// The runtime metadata goes with the process, so nothing is left that could hold the session.
		expect((await test1.registry.get(spawned.child.id))?.runtime).toBeUndefined();
		expect(test1.bridge.requests.some((request) => request.operation === "shutdown")).toBe(true);
		await expect(test1.manager.send(spawned.child.id, "continue")).resolves.toMatchObject({
			id: spawned.child.id,
			state: "running",
			sessionId: spawned.child.sessionId,
		});
		expect(test1.launch).toHaveBeenCalledTimes(2);
		expect(await test1.registry.get(spawned.child.id)).toMatchObject({ intent: "active" });
	});

	test("refuses to call a stop confirmed while the process is still alive", async () => {
		const test1 = await harness();
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const runtime = test1.runtimes.get(spawned.child.id);
		if (runtime === undefined) throw new Error("no runtime was started");
		runtime.refuseToDie = true;

		expect(await test1.manager.stop(spawned.child.id)).toMatchObject({
			state: "error",
			reason: expect.stringContaining("not confirmed"),
		});
		// The evidence stays behind: a process that ignored the kill may still own the session.
		expect((await test1.registry.get(spawned.child.id))?.runtime).toBeDefined();
	});

	test("hibernates an idle child: shutdown over the bridge, then the process, then done", async () => {
		const test1 = await harness({ idleTimeoutMs: 10 });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		test1.bridge.emit(spawned.child.id, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await test1.manager.get(spawned.child.id);

		await advanceFakeTime(1_000);
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "done" });
		expect((await test1.registry.get(spawned.child.id))?.runtime).toBeUndefined();
		expect(test1.bridge.requests.some((request) => request.operation === "shutdown")).toBe(true);
	});

	test("a failed idle close does not freeze the session", async () => {
		const test1 = await harness({ idleTimeoutMs: 10, host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		test1.bridge.emit(spawned.child.id, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		// The panel refuses to close and still reports the child running: the exit is unconfirmed.
		attachment.refuseToClose = true;

		await advanceFakeTime(1_000);
		expect(attachment.cleanups).toBeGreaterThan(0);
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "done" });
		// The close did not land. The leftover tab is the caller's, and the record is not marked failed.
		// A send starts another runtime instead of freezing the session.
		const sent = await test1.manager.send(spawned.child.id, "keep going");
		expect(sent).toMatchObject({ id: spawned.child.id, state: "running" });
		expect(test1.openPanel).toHaveBeenCalledTimes(2);
	});

	test("settles a background child whose process exits after its bridge dropped", async () => {
		const test1 = await harness();
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const runtime = test1.runtimes.get(spawned.child.id);
		if (runtime === undefined) throw new Error("no runtime was started");

		// A turn is in flight when the bridge goes away while the process is still running: nothing is
		// settled yet, because the process may reconnect.
		test1.bridge.emit(spawned.child.id, { type: "agent_start" });
		await test1.bridge.settle();
		test1.bridge.disconnect(spawned.child.id);
		await test1.bridge.settle();
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "running" });
		// The handle is still held, so nothing may start a second runtime for this session yet.
		expect(await test1.manager.send(spawned.child.id, "already?")).toMatchObject({
			reason: expect.stringContaining("still running"),
		});
		expect(test1.launch).toHaveBeenCalledTimes(1);

		// The process ends afterwards, with no second connection event to carry the news.
		const released = settledState(test1, spawned.child.id, "blocked");
		runtime.alive = false;
		runtime.exit(0);
		await released;
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({
			state: "blocked",
			freshness: "last_known",
		});
		// The handle goes with the process, so a later send starts a fresh runtime.
		expect(test1.runtimes.size).toBe(1);
		await expect(test1.manager.send(spawned.child.id, "again")).resolves.toMatchObject({
			id: spawned.child.id,
		});
		expect(test1.launch).toHaveBeenCalledTimes(2);
	});

	test("settles a background child whose process exits while the bridge still looks connected", async () => {
		const test1 = await harness();
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const runtime = test1.runtimes.get(spawned.child.id);
		if (runtime === undefined) throw new Error("no runtime was started");
		expect(test1.bridge.isConnected(spawned.child.id)).toBe(true);

		const released = settledState(test1, spawned.child.id, "blocked");
		runtime.alive = false;
		runtime.exit(0);
		await released;
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({
			state: "blocked",
			freshness: "last_known",
		});
		expect(test1.bridge.isConnected(spawned.child.id)).toBe(false);
		expect(await test1.manager.send(spawned.child.id, "again")).toMatchObject({
			id: spawned.child.id,
		});
		expect(test1.launch).toHaveBeenCalledTimes(2);
	});

	test("confirms unacknowledged input once the child's own transcript shows it", async () => {
		const test1 = await harness();
		await test1.addChild("sa_input", { state: "running", unacknowledgedInput: "keep going" });
		test1.bridge.connect("sa_input");
		test1.bridge.responses.set("sa_input:get_entries", async () => ({
			entries: [{ type: "message", message: { role: "user", content: "keep going" } }],
		}));
		test1.bridge.emit("sa_input", { type: "agent_end", messages: [] });
		await until(turn());
		expect(await test1.manager.get("sa_input")).toMatchObject({ state: "running" });
		expect((await test1.registry.get("sa_input"))?.unacknowledgedInput).toBeUndefined();
	});

	test("refreshes usage after each turn without settling the running child or double-counting", async () => {
		const current = await harness();
		const spawned = await current.manager.spawn({ agent: "worker", task: "work" });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const id = spawned.child.id;
		const entries = [
			{
				type: "message",
				id: "first",
				message: {
					role: "assistant",
					stopReason: "toolUse",
					usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.1 } },
				},
			},
		];
		current.bridge.responses.set(`${id}:get_entries`, async () => ({ entries }));
		current.bridge.emit(id, { type: "turn_end" });
		await until(turn());
		expect(await current.manager.get(id)).toMatchObject({
			state: "running",
			usage: { turns: 1, inputTokens: 2, outputTokens: 3, costUsd: 0.1 },
		});
		entries.push({ ...entries[0]!, id: "second" });
		current.bridge.emit(id, { type: "turn_end" });
		await until(turn());
		expect(await current.manager.get(id)).toMatchObject({ usage: { turns: 2, inputTokens: 4 } });
		current.bridge.emit(id, { type: "agent_end", messages: [] });
		await current.bridge.settle();
		expect(await current.manager.get(id)).toMatchObject({ state: "running", usage: { turns: 2 } });
		expect(current.reports).toHaveLength(0);
	});

	test("keeps a child running after agent_end until it settles, and never hibernates it early", async () => {
		const current = await harness({ idleTimeoutMs: 10 });
		const spawned = await current.manager.spawn({ agent: "worker", task: "work" });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const id = spawned.child.id;
		expect((await current.manager.get(id)).state).toBe("running");
		current.bridge.emit(id, { type: "agent_start" });
		current.bridge.emit(id, { type: "agent_end", messages: [] });
		// Long past the idle window: agent_end alone is not a settled turn.
		await advanceFakeTime(1_000);
		expect((await current.manager.get(id)).state).toBe("running");
		expect(current.bridge.requests.some((request) => request.operation === "shutdown")).toBe(false);
		current.bridge.emit(id, { type: "agent_settled" });
		await until(settledState(current, id, "done"));
		current.manager.closeLocalConnections();
	});

	test("does not clear new work when an older settled event is still queued", async () => {
		const current = await harness();
		const spawned = await current.manager.spawn({ agent: "worker", task: "work" });
		if ("reason" in spawned) throw new Error(spawned.reason);
		let changes = 0;
		const unsubscribe = current.manager.onChange(() => {
			changes += 1;
		});
		current.bridge.emit(spawned.child.id, { type: "agent_settled" });
		current.bridge.emit(spawned.child.id, { type: "agent_start" });
		await until(turn());
		expect(changes).toBeGreaterThanOrEqual(3);
		expect((await current.manager.get(spawned.child.id)).state).toBe("running");
		expect(current.reports).toHaveLength(0);
		current.bridge.emit(spawned.child.id, { type: "agent_settled" });
		await until(settledState(current, spawned.child.id, "done"));
		unsubscribe();
		current.manager.closeLocalConnections();
	});

	test("adopts actual work state even when transcript retrieval fails", async () => {
		const current = await harness();
		await current.addChild("sa_partial", { state: "running" });
		current.bridge.connected.add("sa_partial");
		current.bridge.responses.set("sa_partial:get_entries", async () => {
			throw new Error("entries unavailable");
		});
		current.bridge.responses.set("sa_partial:get_state", async () => ({
			idle: true,
			pendingMessages: false,
		}));
		expect(await current.manager.recover()).toMatchObject({
			recovered: ["sa_partial"],
			failures: [],
		});
		expect(await current.manager.get("sa_partial")).toMatchObject({ state: "done" });
		current.manager.closeLocalConnections();
	});

	test("restores a receipt work version after the parent manager is replaced", async () => {
		const first = await harness();
		await first.addChild("sa_live", {
			state: "running",
			runtime: { runtimeIdentity: "runtime-1", endpoint: "/tmp/parent.sock" },
		});
		const receipt = reserveReceipt(STATE_DB_PATH, {
			parentSessionId: first.parentSessionId,
			task: "keep going",
			childId: "sa_live",
			delivery: "pending",
		});
		updateReceipt(STATE_DB_PATH, first.parentSessionId, receipt.delegationId, {
			from: ["reserved"],
			status: "accepted",
			runBoundary: 4,
		});
		first.manager.closeLocalConnections();

		const second = await harness({
			parentSessionId: first.parentSessionId,
		});
		second.bridge.connected.add("sa_live");
		second.bridge.responses.set("sa_live:get_state", async () => ({
			idle: false,
			pendingMessages: false,
		}));
		expect(await second.manager.recover()).toMatchObject({ recovered: ["sa_live"] });
		await expect(
			second.manager.handleChildRequest("sa_live", "contact_parent", {
				type: "pi_subagent_report",
				parentSessionId: first.parentSessionId,
				childId: "sa_live",
				runtimeIdentity: "runtime-1",
				reason: "success",
				message: "done after restart",
			}),
		).resolves.toEqual({ delivered: true });
		expect(
			readStoredReceipt(STATE_DB_PATH, first.parentSessionId, receipt.delegationId),
		).toMatchObject({
			status: "completed",
			resultText: "done after restart",
			runBoundary: 4,
		});
		second.manager.closeLocalConnections();
	});

	test("reports an unavailable adoption state and converges on a later reconnect", async () => {
		const current = await harness();
		await current.addChild("sa_unknown", { state: "running" });
		current.bridge.connected.add("sa_unknown");
		current.bridge.responses.set("sa_unknown:get_state", async () => {
			throw new Error("state unavailable");
		});
		expect(await current.manager.recover()).toMatchObject({
			recovered: [],
			failures: [{ childId: "sa_unknown", reason: "state unavailable" }],
		});
		// The child could not say whether it works, so the record stays running until it does.
		expect((await current.manager.get("sa_unknown")).state).toBe("running");
		current.bridge.responses.set("sa_unknown:get_state", async () => ({
			idle: true,
			pendingMessages: false,
		}));
		current.bridge.connect("sa_unknown");
		await until(settledState(current, "sa_unknown", "done"));
		current.manager.closeLocalConnections();
	});

	test("reports a user interrupt to the parent and keeps it visible", async () => {
		const test1 = await harness();
		await test1.addChild("sa_int", {
			state: "running",
			runtime: { runtimeIdentity: "runtime-1", endpoint: "/tmp/parent.sock" },
		});
		test1.bridge.connect("sa_int");
		test1.bridge.emit("sa_int", {
			type: "child_lifecycle",
			parentSessionId: test1.parentSessionId,
			childId: "sa_int",
			runtimeIdentity: "runtime-1",
			kind: "user_interrupt",
			sessionId: "sa_int-session",
			message: "Task is unfinished and waiting for user intent.",
		});
		await until(test1.reportsArrived(1));
		expect(test1.reports.map((report) => report.reason)).toEqual(["user_interrupt"]);
		expect((await test1.registry.get("sa_int"))?.intent).toBe("active");
		expect((await test1.registry.get("sa_int"))?.interrupted).toBeUndefined();
	});

	test("ignores lifecycle notices that name another runtime", async () => {
		const test1 = await harness();
		await test1.addChild("sa_stale", {
			state: "running",
			runtime: { runtimeIdentity: "runtime-now", endpoint: "/tmp/parent.sock" },
		});
		test1.bridge.connect("sa_stale");
		test1.bridge.emit("sa_stale", {
			type: "child_lifecycle",
			parentSessionId: test1.parentSessionId,
			childId: "sa_stale",
			runtimeIdentity: "runtime-old",
			kind: "user_interrupt",
			sessionId: "sa_stale-session",
		});
		await test1.bridge.settle();
		expect(test1.reports).toEqual([]);
	});

	test("delivers a report the child sends and refuses a stale or repeated one", async () => {
		const test1 = await harness();
		await test1.addChild("sa_report", {
			state: "running",
			runtime: { runtimeIdentity: "runtime-1", endpoint: "/tmp/parent.sock" },
		});
		await expect(
			test1.manager.handleChildRequest("sa_report", "contact_parent", {
				type: "pi_subagent_report",
				parentSessionId: test1.parentSessionId,
				childId: "sa_report",
				runtimeIdentity: "runtime-1",
				reason: "blocked",
				message: "halfway",
			}),
		).resolves.toEqual({ delivered: true });
		expect(test1.reports).toHaveLength(1);

		await expect(
			test1.manager.handleChildRequest("sa_report", "contact_parent", {
				type: "pi_subagent_report",
				parentSessionId: test1.parentSessionId,
				childId: "sa_report",
				runtimeIdentity: "runtime-old",
				reason: "blocked",
				message: "halfway",
			}),
		).rejects.toMatchObject({ code: "stale_report" });
	});

	test("resumes a panel child whose runtime never reconnected after a restart", async () => {
		const test1 = await harness({ host: true });
		const record = await test1.addChild("sa_leftover", {
			state: "running",
			presentation: "panel",
			runtime: { runtimeIdentity: "runtime-before-restart", endpoint: "/tmp/parent.sock" },
		});

		// The bridge did not come back, so the ledger drops the writer. A send starts the same session.
		await expect(test1.manager.recover()).resolves.toMatchObject({ recovered: [] });
		expect((await test1.registry.get(record.subagentId))?.runtime).toBeUndefined();
		await expect(test1.manager.send(record.subagentId, "continue")).resolves.toMatchObject({
			id: record.subagentId,
			state: "running",
		});
		expect(test1.launch).not.toHaveBeenCalled();
		expect(test1.openPanel).toHaveBeenCalledTimes(1);

		// A later connect is the same runtime taking input, not a second recovery.
		test1.bridge.connect(record.subagentId);
		await test1.bridge.settle();
		await expect(test1.manager.send(record.subagentId, "continue")).resolves.toMatchObject({
			id: record.subagentId,
		});
		expect(
			test1.bridge.requests.some(
				(request) => request.childId === record.subagentId && request.operation === "steer",
			),
		).toBe(true);
	});

	test("resumes a stopped child after clearing an unconfirmed runtime", async () => {
		const test1 = await harness({ host: true });
		const record = await test1.addChild("sa_leftover_stopped", {
			state: "running",
			presentation: "panel",
			runtime: { runtimeIdentity: "runtime-before-restart", endpoint: "/tmp/parent.sock" },
		});

		// Stop clears the unconfirmed runtime before send restarts the existing session.
		await expect(test1.manager.recover()).resolves.toMatchObject({ recovered: [] });
		await expect(test1.manager.stop(record.subagentId)).resolves.toMatchObject({
			id: record.subagentId,
			state: "done",
		});
		await expect(test1.manager.send(record.subagentId, "continue")).resolves.toMatchObject({
			id: record.subagentId,
			state: "running",
			sessionId: record.sessionId,
		});
		expect(test1.launch).not.toHaveBeenCalled();
		expect(test1.openPanel).toHaveBeenCalledTimes(1);
	});

	test("clears the runtime a background child had before the parent restarted", async () => {
		const test1 = await harness();
		const record = await test1.addChild("sa_bg", {
			state: "running",
			runtime: { runtimeIdentity: "runtime-before-restart", endpoint: "/tmp/parent.sock" },
		});

		// A background child is held by this process's stdin pipe, so it died with the parent: the
		// evidence is stale and the next send starts it again from the same session.
		await test1.manager.recover();
		const settled = await test1.registry.get(record.subagentId);
		expect(settled?.runtime).toBeUndefined();
		expect(settled?.state).toBe("done");
		expect(settled?.interrupted).toContain("ended with the parent process");

		await expect(test1.manager.send(record.subagentId, "continue")).resolves.toMatchObject({
			id: record.subagentId,
		});
		expect(test1.launch).toHaveBeenCalledTimes(1);
	});

	test("keeps a record idle when a state-less event follows an adoption", async () => {
		const test1 = await harness({ host: true });
		const record = await test1.addChild("sa_adopted", { state: "running" });
		test1.bridge.responses.set("sa_adopted:get_entries", async () => ({ entries: [] }));
		test1.bridge.responses.set("sa_adopted:get_state", async () => ({
			idle: true,
			pendingMessages: false,
		}));

		test1.bridge.connect(record.subagentId);
		await until(settledState(test1, record.subagentId, "done"));

		// A tool event carries no durable fact, so it must not touch the registry or revive "running".
		const originalUpdate = test1.registry.update.bind(test1.registry);
		const writes: Array<Promise<unknown>> = [];
		vi.spyOn(test1.registry, "update").mockImplementation((id, revision, updater) => {
			const result = originalUpdate(id, revision, updater);
			writes.push(result);
			return result;
		});
		test1.bridge.emit(record.subagentId, {
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
		});
		await test1.bridge.settle();
		expect(writes).toEqual([]);
		expect(await test1.manager.get(record.subagentId)).toMatchObject({ state: "done" });
	});

	test("refuses a request from an unknown child and an operation the parent does not serve", async () => {
		const test1 = await harness();
		await expect(
			test1.manager.handleChildRequest("sa_ghost", "contact_parent", {}),
		).rejects.toMatchObject({ code: "unknown_child" });
		await test1.addChild("sa_ops", { state: "done" });
		await expect(test1.manager.handleChildRequest("sa_ops", "prompt", {})).rejects.toMatchObject({
			code: "unsupported_operation",
		});
	});

	test("adopts a child that reconnects and notices a runtime that went away", async () => {
		const test1 = await harness();
		await test1.addChild("sa_adopt", { state: "running" });
		test1.bridge.responses.set("sa_adopt:get_entries", async () => ({ entries: [] }));
		test1.bridge.responses.set("sa_adopt:get_state", async () => ({
			idle: false,
			pendingMessages: false,
			sessionId: "sa_adopt-session",
		}));
		test1.bridge.connect("sa_adopt");
		await until(turn());
		expect(await test1.manager.get("sa_adopt")).toMatchObject({
			state: "running",
			freshness: "live",
		});

		const released = settledState(test1, "sa_adopt", "blocked");
		test1.bridge.disconnect("sa_adopt");
		await released;
		expect(await test1.manager.get("sa_adopt")).toMatchObject({
			state: "blocked",
			freshness: "last_known",
		});
		expect((await test1.registry.get("sa_adopt"))?.interrupted).toContain("runtime ended");
	});

	test("adopts surviving children on recovery and never launches anything", async () => {
		const test1 = await harness();
		await test1.addChild("sa_alive", { state: "running" });
		await test1.addChild("sa_dead", { state: "running" });
		test1.bridge.connect("sa_alive");
		test1.bridge.responses.set("sa_alive:get_entries", async () => ({ entries: [] }));
		test1.bridge.responses.set("sa_alive:get_state", async () => ({
			idle: true,
			pendingMessages: false,
			sessionId: "sa_alive-session",
		}));

		const recovery = await test1.manager.recover();
		expect(recovery.recovered).toEqual(["sa_alive"]);
		// A child that does not reconnect is simply not running; that is not a recovery failure,
		// and nothing is launched on its behalf.
		expect(recovery.failures).toEqual([]);
		expect(test1.launch).not.toHaveBeenCalled();
		expect(await test1.manager.get("sa_alive")).toMatchObject({ state: "done" });
	});

	test("a dead background child drops its interrupted receipt and does not reuse its work boundary", async () => {
		const current = await harness();
		await current.addChild("sa_dead", { state: "running", presentation: "background" });
		const receipt = reserveReceipt(STATE_DB_PATH, {
			parentSessionId: current.parentSessionId,
			task: "keep going",
			childId: "sa_dead",
			delivery: "pending",
		});
		updateReceipt(STATE_DB_PATH, current.parentSessionId, receipt.delegationId, {
			from: ["reserved"],
			status: "accepted",
			runBoundary: 4,
		});
		await current.manager.recover();
		expect(
			readStoredReceipt(STATE_DB_PATH, current.parentSessionId, receipt.delegationId),
		).toMatchObject({
			status: "failed",
		});
		const next = await current.manager.delegate({ id: "sa_dead", task: "again", wait: false });
		if ("reason" in next) throw new Error(next.reason);
		expect(latestReceiptForChild(STATE_DB_PATH, current.parentSessionId, "sa_dead")).toMatchObject({
			runBoundary: 5,
			status: "accepted",
		});
		current.manager.closeLocalConnections();
	});

	test("stops listening to the transport when it is disposed", async () => {
		const test1 = await harness();
		await test1.addChild("sa_dispose", { state: "running" });
		test1.manager.dispose();
		test1.bridge.connect("sa_dispose");
		await test1.bridge.settle();
		expect(await test1.manager.get("sa_dispose")).toMatchObject({ state: "running" });
	});
	test("spawns into a panel when a host is available and says so when it is not", async () => {
		const withHost = await harness({ host: true });
		const panelChild = await withHost.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in panelChild) throw new Error(panelChild.reason);
		expect(panelChild.child.presentation).toBe("panel");
		expect(panelChild.note).toBeUndefined();
		expect(withHost.openPanel).toHaveBeenCalledTimes(1);
		expect(withHost.launch).not.toHaveBeenCalled();

		// No host: the same spawn runs headless, and the result says why instead of leaving the
		// caller to guess which presentation it got.
		const headless = await harness();
		const background = await headless.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in background) throw new Error(background.reason);
		expect(background.child.presentation).toBe("background");
		expect(background.note).toContain("runs in the background");
		expect(headless.launch).toHaveBeenCalledTimes(1);
	});

	test("runs a child in a panel when a host exists", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Do the work.",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		expect(spawned.child.presentation).toBe("panel");
		expect(spawned.note).toBeUndefined();
		expect(test1.openPanel).toHaveBeenCalledTimes(1);
		expect(test1.launch).not.toHaveBeenCalled();
	});

	test("stops a panel child by closing its panel, not by killing a process it does not own", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		expect(test1.launch).not.toHaveBeenCalled();

		const stopped = await test1.manager.stop(spawned.child.id);
		expect(stopped).toMatchObject({
			id: spawned.child.id,
			state: "done",
			presentation: "panel",
		});
		expect(attachment.cleanups).toBe(1);
		expect(test1.bridge.requests.some((request) => request.operation === "shutdown")).toBe(true);
		// The runtime evidence goes with the panel, so nothing is left that could hold the session.
		expect((await test1.registry.get(spawned.child.id))?.runtime).toBeUndefined();
	});

	test("refuses to call a panel stop confirmed while the panel is still there", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		attachment.refuseToClose = true;

		expect(await test1.manager.stop(spawned.child.id)).toMatchObject({
			state: "error",
			reason: expect.stringContaining("not confirmed gone"),
		});
		// The evidence stays behind: a panel the parent could not close may still run the child.
		expect((await test1.registry.get(spawned.child.id))?.runtime).toBeDefined();
		test1.bridge.disconnect(spawned.child.id);
		test1.bridge.connect(spawned.child.id);
		// The writer came back, so send delivers to it instead of starting another panel.
		await expect(test1.manager.send(spawned.child.id, "continue")).resolves.toMatchObject({
			id: spawned.child.id,
			state: "running",
		});
		expect(test1.openPanel).toHaveBeenCalledTimes(1);
	});

	test("treats an unobservable panel as unconfirmed rather than closed", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		attachment.unknown = true;

		expect(await test1.manager.stop(spawned.child.id)).toMatchObject({
			state: "error",
			reason: expect.stringContaining("not confirmed gone"),
		});
		expect((await test1.registry.get(spawned.child.id))?.runtime).toBeDefined();
	});

	test("retires a child that left its session: no control of the new one, and the panel is not closed", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		const record = await test1.registry.get(spawned.child.id);
		if (record?.runtime === undefined) throw new Error("no runtime was recorded");

		test1.bridge.emit(spawned.child.id, {
			type: "child_lifecycle",
			parentSessionId: test1.parentSessionId,
			childId: spawned.child.id,
			runtimeIdentity: record.runtime.runtimeIdentity,
			kind: "left_session",
			sessionId: "another-session",
		});
		await until(turn());
		expect((await test1.registry.get(spawned.child.id))?.runtime).toBeUndefined();
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({
			state: "done",
			freshness: "last_known",
		});
		// The panel now belongs to the session the human switched to.
		expect(attachment.cleanups).toBe(0);

		// A send starts a fresh runtime for the delegated session instead of typing into that session.
		const sent = await test1.manager.send(spawned.child.id, "keep going");
		if ("reason" in sent) throw new Error(sent.reason);
		expect(test1.openPanel).toHaveBeenCalledTimes(2);
		expect(test1.bridge.requests.at(-1)).toMatchObject({
			childId: spawned.child.id,
			operation: "prompt",
			payload: { message: "keep going" },
		});
	});

	test("idle reclaim leaves a focused panel alone, then closes it once nobody is watching", async () => {
		const test1 = await harness({ idleTimeoutMs: 10, host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		attachment.focused = true;
		test1.bridge.emit(spawned.child.id, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await test1.bridge.settle();

		// Four idle windows pass and the focused panel is still open.
		await advanceFakeTime(40);
		expect(attachment.cleanups).toBe(0);
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "done" });

		attachment.focused = false;
		await until(attachment.closed());
		expect(attachment.cleanups).toBeGreaterThan(0);
		expect(test1.bridge.requests.some((request) => request.operation === "shutdown")).toBe(true);
		// A disconnect arriving after idle reclaim is not a manual close. A later send still resumes
		// the same child and session rather than failing as stopped.
		test1.bridge.disconnect(spawned.child.id);
		await expect(test1.manager.send(spawned.child.id, "continue")).resolves.toMatchObject({
			id: spawned.child.id,
			state: "running",
		});
		expect(test1.openPanel).toHaveBeenCalledTimes(2);
		expect((await test1.registry.get(spawned.child.id))?.sessionId).toBe(spawned.child.sessionId);
	});

	test("idle observation of an already exited panel marks done without blocked and can be resumed", async () => {
		const test1 = await harness({ idleTimeoutMs: 10, host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		attachment.alive = false;
		attachment.focused = false;
		test1.bridge.emit(spawned.child.id, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		// An idle panel whose process exits is not blocked: it marks done and remains active
		await until(attachment.closed());
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "done" });
		test1.bridge.disconnect(spawned.child.id);
		expect(test1.bridge.requests.some((request) => request.operation === "shutdown")).toBe(false);
	});

	test("does not reclaim a panel that started being used while the check was in flight", async () => {
		const test1 = await harness({ idleTimeoutMs: 10, host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		attachment.focused = false;
		const realObserve = attachment.observe.bind(attachment);
		let entered: (() => void) | undefined;
		let release: (() => void) | undefined;
		const observing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		attachment.observe = async () => {
			// The answer is taken first, so what the host said cannot change while it is held.
			const answer = await realObserve();
			entered?.();
			await blocked;
			return answer;
		};
		test1.bridge.emit(spawned.child.id, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await test1.bridge.settle();
		await until(observing);
		// Someone started using the panel while the host was answering. The event is queued behind
		// the reclaim, so only the count of inbound signals can stop a decision already in flight.
		test1.bridge.emit(spawned.child.id, {
			type: "child_input",
			parentSessionId: test1.parentSessionId,
			childId: spawned.child.id,
			runtimeIdentity: "runtime-1",
			source: "interactive",
		});
		attachment.focused = true;
		release?.();
		await test1.bridge.settle();
		await advanceFakeTime(80);

		expect(attachment.cleanups).toBe(0);
		expect(test1.bridge.requests.some((request) => request.operation === "shutdown")).toBe(false);
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "done" });
	});

	test("never reclaims a panel whose host cannot report focus", async () => {
		const test1 = await harness({ idleTimeoutMs: 10, host: true, blindHost: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		test1.bridge.emit(spawned.child.id, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await test1.bridge.settle();

		await advanceFakeTime(40);
		expect(attachment.cleanups).toBe(0);
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "done" });
	});

	test("human input in the panel cancels the countdown but a parent message does not", async () => {
		const test1 = await harness({ idleTimeoutMs: 30, host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		const settled = {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		};
		const input = (source: string): unknown => ({
			type: "child_input",
			parentSessionId: test1.parentSessionId,
			childId: spawned.child.id,
			runtimeIdentity: "runtime-1",
			source,
		});
		test1.bridge.emit(spawned.child.id, settled);
		test1.bridge.emit(spawned.child.id, input("interactive"));
		await test1.bridge.settle();
		await advanceFakeTime(120);
		expect(attachment.cleanups).toBe(0);

		// A message the parent sent over the bridge says nothing about the panel, so the countdown
		// that follows the next finished turn still closes it.
		test1.bridge.emit(spawned.child.id, settled);
		test1.bridge.emit(spawned.child.id, input("rpc"));
		await test1.bridge.settle();
		await until(attachment.closed());
		expect(attachment.cleanups).toBeGreaterThan(0);
	});

	test("manual panel close while running can resume the same session", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");

		await test1.registry.update(spawned.child.id, (current) => ({
			...current,
			state: "running",
		}));
		const released = settledState(test1, spawned.child.id, "blocked");
		attachment.alive = false;
		test1.bridge.disconnect(spawned.child.id);
		await released;
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({
			state: "blocked",
			freshness: "last_known",
		});
		await expect(test1.manager.send(spawned.child.id, "continue")).resolves.toMatchObject({
			id: spawned.child.id,
			state: "running",
		});
		expect(attachment.cleanups).toBe(1);
		expect(test1.openPanel).toHaveBeenCalledTimes(2);
		expect(await test1.registry.get(spawned.child.id)).toMatchObject({
			intent: "active",
			sessionId: spawned.child.sessionId,
		});
	});

	test("compaction after settle still delivers the reply", async () => {
		const test1 = await harness();
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;
		test1.bridge.responses.set(`${childId}:get_entries`, async () => ({
			entries: [assistantEntry("The answer.")],
		}));
		await test1.manager.handleEvent(childId, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await test1.bridge.settle();
		await test1.manager.handleEvent(childId, { type: "compaction_start" });
		await until(test1.reportsArrived(1));
		expect(test1.reports[0]).toMatchObject({ reason: "success", message: "The answer." });
	});

	test("a signal during delivery reschedules a settled reply", async () => {
		const test1 = await harness();
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;
		let bumped = false;
		test1.bridge.responses.set(`${childId}:session_facts`, async () => {
			if (!bumped) {
				bumped = true;
				await test1.manager.handleEvent(childId, { type: "compaction_end" });
			}
			return transcriptFacts([assistantEntry("The answer.")]);
		});
		await test1.manager.handleEvent(childId, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await until(test1.reportsArrived(1));
		expect(test1.reports[0]).toMatchObject({ reason: "success", message: "The answer." });
	});

	test("appends compact reminder notice when completed turn exceeds 100k context tokens", async () => {
		const test1 = await harness();
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do heavy work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;
		test1.bridge.responses.set(`${childId}:session_facts`, async () => {
			return transcriptFacts([
				assistantEntry("All heavy work finished.", {
					input: 95_000,
					output: 6_000,
					cacheRead: 10_000,
				}),
			]);
		});
		await test1.manager.handleEvent(childId, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await until(test1.reportsArrived(1));
		expect(test1.reports[0]?.message).toContain("[Context: ~111k tokens.");
		expect(test1.reports[0]?.message).toContain('send "/compact" via agents_delegate');
	});

	test("closing a panel after a finished reply delivers that reply, not blocked", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const sessionPath = await writeSession([assistantEntry("The answer.")]);
		await test1.registry.update(spawned.child.id, (current) => ({
			...current,
			state: "running",
			persistence: "flushed",
			sessionPath,
			launchConfig: { ...current.launchConfig, sessionPath },
		}));
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		const finished = settledState(test1, spawned.child.id, "done");
		attachment.alive = false;
		test1.bridge.disconnect(spawned.child.id);
		await finished;
		await advanceFakeTime(500);
		await test1.reportsArrived(1);
		expect(test1.reports[0]).toMatchObject({ reason: "success", message: "The answer." });
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({
			state: "done",
			freshness: "last_known",
		});
		expect((await test1.registry.get(spawned.child.id))?.interrupted).toBeUndefined();
	});

	test("closing a panel mid-turn stays blocked when the prompt has not been answered", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const sessionPath = await writeSession([
			assistantEntry("Earlier."),
			{ type: "message", id: "user-1", message: { role: "user", content: "continue" } },
		]);
		await test1.registry.update(spawned.child.id, (current) => ({
			...current,
			state: "running",
			persistence: "flushed",
			sessionPath,
			launchConfig: { ...current.launchConfig, sessionPath },
		}));
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		const blocked = settledState(test1, spawned.child.id, "blocked");
		attachment.alive = false;
		test1.bridge.disconnect(spawned.child.id);
		await blocked;
		await advanceFakeTime(500);
		await test1.reportsArrived(1);
		expect(test1.reports[0]?.reason).toBe("blocked");
		expect(test1.reports[0]?.message).toContain("turn was in flight");
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "blocked" });
	});

	test("manual panel close while idle is done and not blocked", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");

		await test1.registry.update(spawned.child.id, (current) => ({
			...current,
			state: "done",
		}));
		attachment.alive = false;
		test1.bridge.disconnect(spawned.child.id);
		await until(attachment.closed());
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({
			state: "done",
			freshness: "last_known",
		});
		expect(attachment.cleanups).toBe(1);
		expect(await test1.registry.get(spawned.child.id)).toMatchObject({
			intent: "active",
			sessionId: spawned.child.sessionId,
		});
	});

	test("send detecting a closed panel resumes in that same call", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		attachment.alive = false;
		// The socket is already gone, but its disconnect notification has not been handled yet.
		test1.bridge.connected.delete(spawned.child.id);
		await expect(test1.manager.send(spawned.child.id, "continue")).resolves.toMatchObject({
			id: spawned.child.id,
			state: "running",
		});
		expect(test1.openPanel).toHaveBeenCalledTimes(2);
	});

	test("an adopted panel losing its bridge can be sent to again", async () => {
		const test1 = await harness({ host: true });
		const record = await test1.addChild("sa_adopted_closed", {
			state: "running",
			presentation: "panel",
			runtime: { runtimeIdentity: "runtime-before-restart", endpoint: "/tmp/parent.sock" },
		});
		test1.bridge.connect(record.subagentId);
		await test1.manager.recover();
		test1.bridge.disconnect(record.subagentId);
		await until(
			recordMatches(test1, record.subagentId, (current) => current.runtime === undefined),
		);
		await expect(test1.manager.send(record.subagentId, "continue")).resolves.toMatchObject({
			id: record.subagentId,
			state: "running",
		});
		expect(test1.openPanel).toHaveBeenCalledTimes(1);
	});

	test("keeps a panel standing when its child's bridge drops but the process lives", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");

		// A live process behind a missing bridge may be serving the session the human switched to, and
		// nobody asked for that panel to be closed.
		test1.bridge.disconnect(spawned.child.id);
		await test1.bridge.settle();
		expect(attachment.cleanups).toBe(0);
		// Closing it stays possible on request: stop is an instruction, not an inference.
		expect(await test1.manager.stop(spawned.child.id)).toMatchObject({ state: "done" });
		expect(attachment.cleanups).toBe(1);
	});

	test("gives no idle countdown to a child whose runtime this process does not own", async () => {
		const test1 = await harness({ idleTimeoutMs: 10, host: true });
		await test1.addChild("sa_orphan", { state: "done", presentation: "panel" });
		test1.bridge.connect("sa_orphan");
		test1.bridge.emit("sa_orphan", {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await test1.bridge.settle();

		await advanceFakeTime(40);
		expect(test1.bridge.requests.some((request) => request.operation === "shutdown")).toBe(false);
		expect((await test1.registry.get("sa_orphan"))?.runtime).toBeUndefined();
	});

	test("extractLastAssistantText extracts string or structured text from the trailing assistant message", () => {
		const emptyEntries: unknown[] = [];
		expect(extractLastAssistantText(emptyEntries)).toBeUndefined();

		const noAssistant = [{ message: { role: "user", content: "hello" } }];
		expect(extractLastAssistantText(noAssistant)).toBeUndefined();

		const singleText = [
			{ message: { role: "user", content: "hello" } },
			{ message: { role: "assistant", content: "Hi there!" } },
		];
		expect(extractLastAssistantText(singleText)).toBe("Hi there!");

		const multiParts = [
			{ message: { role: "user", content: "hello" } },
			{ message: { role: "assistant", content: "Older reply" } },
			{ message: { role: "user", content: "next" } },
			{
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Part 1" },
						{ type: "toolCall", name: "read" },
						{ type: "text", text: "Part 2" },
					],
				},
			},
		];
		expect(extractLastAssistantText(multiParts)).toBe("Part 1\nPart 2");
	});

	test("reports blocked through the parent channel and records the blocker", async () => {
		const test1 = await harness();

		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Investigate database performance",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		await test1.manager.contactParent(childId, "blocked", "Missing credentials to access DB");
		expect(test1.reports).toHaveLength(1);
		expect(test1.reports[0]?.reason).toBe("blocked");
		expect(test1.reports[0]?.message).toBe("Missing credentials to access DB");
		expect(await test1.manager.get(childId)).toMatchObject({
			state: "blocked",
			interrupted: "Missing credentials to access DB",
		});
	});

	test("preserves an error through automatic delivery", async () => {
		const test1 = await harness();

		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Investigate database performance",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		test1.bridge.responses.set(`${childId}:get_entries`, async () => ({
			entries: [
				{
					type: "message",
					id: "msg-1",
					message: {
						role: "assistant",
						stopReason: "error",
						errorMessage: "Rate limit exceeded",
						content: [{ type: "text", text: "Attempting to query..." }],
					},
				},
			],
		}));

		await test1.manager.handleEvent(childId, {
			type: "agent_end",
		});
		await test1.manager.handleEvent(childId, {
			type: "agent_settled",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "Rate limit exceeded",
			},
		});

		await until(test1.reportsArrived(1));

		expect(test1.reports[0]?.reason).toBe("error");
		expect(test1.reports[0]?.status).toBe("error");
		expect(test1.reports[0]?.message).toBe("Rate limit exceeded");
		expect(await test1.manager.get(childId)).toMatchObject({ state: "error" });
		expect(await test1.manager.send(childId, "continue")).toMatchObject({
			id: childId,
			state: "running",
		});
	}, 15_000);

	test("does not report error while retrying and reports success after successful retry", async () => {
		const test1 = await harness();

		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Investigate database performance",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		await test1.manager.handleEvent(childId, {
			type: "agent_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "Rate limit exceeded",
			},
		});
		await test1.manager.handleEvent(childId, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
		});

		expect(test1.reports).toHaveLength(0);

		await test1.manager.handleEvent(childId, {
			type: "agent_start",
		});
		test1.bridge.responses.set(`${childId}:get_entries`, async () => ({
			entries: [
				{
					type: "message",
					id: "msg-1",
					message: {
						role: "assistant",
						stopReason: "error",
						errorMessage: "Rate limit exceeded",
					},
				},
				{
					type: "message",
					id: "msg-2",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "Successfully completed after retry." }],
					},
				},
			],
		}));
		await test1.manager.handleEvent(childId, {
			type: "agent_end",
		});
		await test1.manager.handleEvent(childId, {
			type: "agent_settled",
			message: {
				role: "assistant",
				stopReason: "stop",
			},
		});

		await until(test1.reportsArrived(1));

		expect(test1.reports).toHaveLength(1);
		expect(test1.reports[0]?.reason).toBe("success");
		expect(test1.reports[0]?.message).toBe("Successfully completed after retry.");

		expect((await test1.manager.get(childId)).state).toBe("done");
	});

	test("automatically closes panel after failedPanelCloseTimeoutMs when child reports blocked", async () => {
		const test1 = await harness({ host: true, failedPanelCloseTimeoutMs: 50 });
		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Fix broken component",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		const panel = test1.panels.get(childId);
		expect(panel).toBeDefined();
		expect(panel?.cleanups).toBe(0);

		await test1.manager.contactParent(childId, "blocked", "Unrecoverable compile error");
		expect(test1.reports).toHaveLength(1);
		expect(test1.reports[0]?.reason).toBe("blocked");

		// Panel should not be closed immediately (it has a 50ms countdown)
		expect(panel?.cleanups).toBe(0);

		// The countdown is the only thing left: advancing the clock past it is the close.
		await until(panel?.closed() ?? Promise.resolve());
		expect(panel?.cleanups).toBe(1);

		const updatedRecord = await test1.manager.get(childId);
		expect(updatedRecord.state).toBe("blocked");
	});

	test("cancels panel close countdown if a new message is sent before timeout", async () => {
		const test1 = await harness({ host: true, failedPanelCloseTimeoutMs: 100 });
		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Fix broken component",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		const panel = test1.panels.get(childId);
		expect(panel).toBeDefined();
		expect(panel?.cleanups).toBe(0);

		await test1.manager.contactParent(childId, "blocked", "Need more info");
		expect(panel?.cleanups).toBe(0);

		// Send new instructions to resume work before the 100ms timer fires
		await test1.manager.send(childId, "Try using the alternative API instead");

		// The countdown would have fired by now if send had not cancelled it.
		await advanceFakeTime(150);
		expect(panel?.cleanups).toBe(0);
	});

	test("closing an idle panel marks state as done without interrupted, keeping intent active", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Initial background inspection",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		// Settle child into idle
		test1.manager.handleEvent(childId, {
			type: "agent_settled",
			message: {
				role: "assistant",
				stopReason: "stop",
			},
		});
		await until(settledState(test1, childId, "done"));

		const panel = test1.panels.get(childId);
		expect(panel).toBeDefined();

		// Simulate user closing the panel tab (panel observation reports alive = false)
		if (panel) panel.alive = false;
		test1.bridge.disconnect(childId);

		await until(settledState(test1, childId, "done"));
		const settledRecord = await test1.manager.get(childId);
		if ("reason" in settledRecord) throw new Error(settledRecord.reason);
		expect(settledRecord.state).toBe("done");
		expect(settledRecord.interrupted).toBeUndefined();

		expect((await test1.registry.get(childId))?.intent).toBe("active");

		// Re-awaken via send
		const resumed = await test1.manager.send(childId, "Follow-up task after panel close");
		if ("reason" in resumed) throw new Error(resumed.reason);
		expect(resumed.id).toBe(childId);
		expect(resumed.state).toBe("running");
	});

	test("blocked subagent panel closes after timeout and can be re-awakened via send", async () => {
		const test1 = await harness({ host: true, failedPanelCloseTimeoutMs: 50 });
		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Blocked panel reawaken test",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		const panel = test1.panels.get(childId);
		expect(panel).toBeDefined();

		// Report blocked
		await test1.manager.contactParent(childId, "blocked", "Waiting for auth token");

		const blockedRecord = await test1.manager.get(childId);
		expect(blockedRecord.state).toBe("blocked");

		// Wait out the 50ms close timeout
		await advanceFakeTime(80);

		// Panel should now be cleaned up and closed
		expect(panel?.cleanups).toBe(1);

		// Record state is still blocked
		const afterClose = await test1.manager.get(childId);
		expect(afterClose.state).toBe("blocked");

		// Can be re-awakened via send
		const sent = await test1.manager.send(childId, "Here is your token: secret123");
		if ("reason" in sent) throw new Error(sent.reason);
		expect(sent.id).toBe(childId);
		expect(sent.state).toBe("running");

		// A new panel was opened to resume the session
		expect(test1.openPanel).toHaveBeenCalledTimes(2);
	});

	test("error subagent reports error and accepts retry via send without a duplicate runtime", async () => {
		const test1 = await harness({ host: true, failedPanelCloseTimeoutMs: 50 });
		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Error report test",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		// Report fatal error
		await test1.manager.contactParent(childId, "error", "Fatal unrecoverable crash");

		const errorRecord = await test1.manager.get(childId);
		expect(errorRecord.state).toBe("error");

		const sent = await test1.manager.send(childId, "Try to continue anyway");
		expect(sent).toMatchObject({ id: childId, state: "running" });
		expect(test1.openPanel).toHaveBeenCalledTimes(1);
		// The runtime is still connected, so this is not a resume: the default steer is what the
		// caller asked for, and an errored child has no turn to interrupt anyway.
		expect(test1.bridge.requests.at(-1)).toMatchObject({ operation: "steer" });
		expect(await test1.registry.get(childId)).toMatchObject({ intent: "active" });
		expect((await test1.registry.get(childId))?.interrupted).toBeUndefined();
	});

	test("delivers a settled reply through the parent channel once", async () => {
		const test1 = await harness();

		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Concurrent work test",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		test1.bridge.responses.set(`${childId}:get_entries`, async () => ({
			entries: [
				{
					type: "message",
					id: "msg-1",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "Finished successfully" }],
					},
				},
			],
		}));
		await test1.manager.handleEvent(childId, {
			type: "agent_end",
		});
		await test1.manager.handleEvent(childId, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});

		await until(test1.reportsArrived(1));

		// The child's reply reaches the parent through its own channel, once.
		expect(test1.reports).toHaveLength(1);
		expect(test1.reports[0]?.message).toBe("Finished successfully");
		expect(test1.reports[0]?.reason).toBe("success");
		expect(await test1.manager.get(childId)).toMatchObject({ state: "done" });
	});

	test("delivers full multiline assistant text in auto-report without 240-char summary truncation", async () => {
		const test1 = await harness();
		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Long answer test",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;
		const fullAnswer = `Line 1 of answer\nLine 2 of answer\n${"detail ".repeat(59)}detail`;
		test1.bridge.responses.set(`${childId}:get_entries`, async () => ({
			entries: [
				{
					type: "message",
					id: "msg-full",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: fullAnswer }],
					},
				},
			],
		}));
		await test1.manager.handleEvent(childId, { type: "agent_end" });
		await test1.manager.handleEvent(childId, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await until(test1.reportsArrived(1));
		expect(test1.reports[0]?.message).toBe(fullAnswer);
	});

	test("batches auto-reports when multiple children settle together and exposes task in get", async () => {
		const test1 = await harness();
		const c1 = await test1.manager.spawn({ agent: "worker", task: "Task 1" });
		const c2 = await test1.manager.spawn({ agent: "worker", task: "Task 2" });
		if ("reason" in c1 || "reason" in c2) throw new Error("spawn failed");

		// 1. Check get exposes initialTask as task
		const g1 = await test1.manager.get(c1.child.id);
		if ("operation" in g1) throw new Error("get failed");
		expect(g1.task).toBe("Task 1");

		// 2. Both settle shortly after each other with assistant entries
		for (const [id, msg] of [
			[c1.child.id, "Finished 1"],
			[c2.child.id, "Finished 2"],
		] as const) {
			test1.bridge.responses.set(`${id}:get_entries`, async () => ({
				entries: [
					{
						type: "message",
						id: "msg-1",
						message: {
							role: "assistant",
							stopReason: "stop",
							content: [{ type: "text", text: msg }],
						},
					},
				],
			}));
			await test1.manager.handleEvent(id, { type: "agent_end" });
			await test1.manager.handleEvent(id, {
				type: "agent_settled",
				message: { role: "assistant", stopReason: "stop" },
			});
		}

		// The batch window is 500ms of the manager's own clock; both deliveries are the event.
		await until(test1.reportsArrived(2));
		expect(test1.reports.map((r) => r.childId).sort()).toEqual([c1.child.id, c2.child.id].sort());
	});

	test("renegotiates presentation to panel on resume when presentation host is available", async () => {
		const test1 = await harness({ host: true });
		const record = await test1.addChild("sa_reneg", {
			state: "done",
			presentation: "background",
		});

		const resumed = await test1.manager.send(record.subagentId, "continue task");
		if ("reason" in resumed) throw new Error(resumed.reason);
		expect(resumed.state).toBe("running");
		expect(test1.openPanel).toHaveBeenCalledTimes(1);
		const stored = await test1.registry.get(record.subagentId);
		expect(stored?.presentation).toBe("panel");
	});

	test("degrades presentation to background on resume when parent has no presentation host", async () => {
		const test1 = await harness({ host: false });
		const record = await test1.addChild("sa_degrade", {
			state: "done",
			presentation: "panel",
		});

		const resumed = await test1.manager.send(record.subagentId, "continue task");
		if ("reason" in resumed) throw new Error(resumed.reason);
		expect(resumed.state).toBe("running");
		expect(test1.launch).toHaveBeenCalledTimes(1);
		const stored = await test1.registry.get(record.subagentId);
		expect(stored?.presentation).toBe("background");
	});

	test("resumes on current host when previous attachment was on a different host", async () => {
		const test1 = await harness({
			host: true,
			directory: {
				host: "rex",
				list: async () => ({ known: true, generation: "g1", present: new Set() }),
				open: async () => ({ failure: "not opened" }),
			},
		});
		const record = await test1.addChild("sa_cross_host", {
			state: "running",
			presentation: "panel",
			runtime: {
				runtimeIdentity: "rt-old",
				endpoint: "/tmp/old.sock",
				attachment: { kind: "panel", host: "herdr", id: "tab-old" },
			},
		});

		// Child has an attachment from herdr, but current parent directory host is rex.
		// Send detects panelDetached and opens a panel on rex.
		const resumed = await test1.manager.send(record.subagentId, "continue on new host");
		if ("reason" in resumed) throw new Error(resumed.reason);
		expect(test1.openPanel).toHaveBeenCalledTimes(1);
	});
});
