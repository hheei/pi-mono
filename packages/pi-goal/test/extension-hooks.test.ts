import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionManager as SessionManagerType,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getBackgroundDelivery } from "@hheei/pi-ext-core";
import { afterEach, describe, expect, test } from "vitest";
import piGoalExtension from "../src/extension.js";
import { boundaryEvent } from "./fixtures/fake-goal.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Runtime {
	readonly pi: ExtensionAPI;
	readonly session: SessionManagerType;
	readonly handlers: Map<string, Handler[]>;
	readonly sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }>;
	readonly notices: Array<{ message: string; level: string | undefined }>;
	readonly activeTools: string[];
	readonly commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
	readonly tools: string[];
	readonly aborts: { count: number };
}

const tempDirs: string[] = [];
// The test runner itself may be a pi-subagents child; the runtime tests need a parent identity.
const savedChildEnv = process.env.PI_SUBAGENTS_CHILD_ID;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-hooks-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (savedChildEnv === undefined) delete process.env.PI_SUBAGENTS_CHILD_ID;
	else process.env.PI_SUBAGENTS_CHILD_ID = savedChildEnv;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

function createRuntime(session: SessionManagerType): Runtime {
	const handlers = new Map<string, Handler[]>();
	const sent: Runtime["sent"] = [];
	const notices: Runtime["notices"] = [];
	const activeTools: string[] = [];
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const tools: string[] = [];
	const aborts = { count: 0 };
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const current = handlers.get(event) ?? [];
				handlers.set(
					event,
					current.filter((entry) => entry !== handler),
				);
			};
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		registerCommand(
			name: string,
			options: { handler: (args: string, ctx: unknown) => Promise<void> },
		) {
			commands.set(name, options.handler);
		},
		registerEntryRenderer() {},
		appendEntry(customType: string, data: unknown) {
			session.appendCustomEntry(customType, data);
		},
		sendMessage(message: Record<string, unknown>, options: Record<string, unknown>) {
			sent.push({ message, options });
		},
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) {
			activeTools.splice(0, activeTools.length, ...names);
		},
	} as unknown as ExtensionAPI;
	return { pi, session, handlers, sent, notices, activeTools, commands, tools, aborts };
}

function contextFor(
	runtime: Runtime,
	options: { idle?: boolean | undefined } = {},
): ExtensionContext {
	return {
		sessionManager: runtime.session,
		hasUI: true,
		ui: {
			notify(message: string, level?: string) {
				runtime.notices.push({ message, level });
			},
			async confirm() {
				return true;
			},
			async editor() {
				return "typed objective";
			},
		},
		isIdle: () => options.idle ?? true,
		waitForIdle: async () => {},
		model: { provider: "test", id: "fake-model" },
		abort: () => {
			runtime.aborts.count += 1;
		},
		cwd: process.cwd(),
	} as unknown as ExtensionContext;
}

async function emit(
	runtime: Runtime,
	event: string,
	payload: unknown,
	ctx?: unknown,
): Promise<unknown> {
	let result: unknown;
	for (const handler of runtime.handlers.get(event) ?? []) {
		result = await handler(payload, ctx ?? contextFor(runtime));
	}
	return result;
}

async function boot(options: { session?: SessionManagerType; idle?: boolean } = {}): Promise<{
	runtime: ReturnType<typeof createRuntime>;
	ctx: ExtensionContext;
}> {
	const dir = tempDir();
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.PI_SUBAGENTS_CHILD_ID;
	const session = options.session ?? SessionManager.create(process.cwd(), join(dir, "sessions"));
	const runtime = createRuntime(session);
	piGoalExtension(runtime.pi);
	const ctx = contextFor(runtime, { idle: options.idle });
	await emit(runtime, "session_start", { type: "session_start", reason: "startup" }, ctx);
	return { runtime, ctx };
}

async function command(runtime: Runtime, args: string, ctx: ExtensionContext): Promise<void> {
	const handler = runtime.commands.get("goal");
	if (handler === undefined) throw new Error("goal command was not registered");
	await handler(args, ctx);
}

function statusText(runtime: Runtime): string {
	const notice = [...runtime.notices].reverse().find((entry) => entry.message.startsWith("Goal"));
	return notice?.message ?? "";
}

function flushDelivery(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

async function startGoal(args = "start Ship goal"): Promise<{
	runtime: Runtime;
	ctx: ExtensionContext;
}> {
	const booted = await boot();
	await command(booted.runtime, args, booted.ctx);
	await flushDelivery();
	return booted;
}

describe("goal extension hooks", () => {
	test("start authorizes a run, activates the tool, and delivers one inspectable kickoff", async () => {
		const { runtime } = await startGoal();
		expect(runtime.tools).toContain("goal");
		expect(runtime.activeTools).toContain("goal");
		expect(runtime.sent).toHaveLength(1);
		const sent = runtime.sent[0];
		expect(sent?.message.customType).toBe("pi-goal-kickoff");
		expect(sent?.message.display).toBe(true);
		expect(String(sent?.message.content)).toContain("Ship goal");
		expect(sent?.options.triggerTurn).toBe(true);
	});

	test("a stale held delivery does not steal the final wakeup from another channel", async () => {
		const dir = tempDir();
		process.env.PI_CODING_AGENT_DIR = dir;
		delete process.env.PI_SUBAGENTS_CHILD_ID;
		const session = SessionManager.create(process.cwd(), join(dir, "sessions"));
		const runtime = createRuntime(session);
		// The other producer is registered first, so the Goal channel would be the final one.
		const flushes: boolean[] = [];
		let otherPending = true;
		const registration = getBackgroundDelivery(runtime.pi).registerChannel({
			isIdle: () => true,
			hasPending: () => otherPending,
			flush(triggerTurn) {
				flushes.push(triggerTurn);
				otherPending = false;
			},
		});
		try {
			piGoalExtension(runtime.pi);
			const ctx = contextFor(runtime, { idle: false });
			await emit(runtime, "session_start", { type: "session_start", reason: "startup" }, ctx);
			await command(runtime, "start Ship goal", ctx);
			await command(runtime, "pause", ctx);
			await command(runtime, "status", ctx);
			expect(statusText(runtime)).toContain("paused");
			expect(runtime.notices.some((n) => n.message.includes("paused"))).toBe(true);
			// The kickoff is still held because the fake parent reported itself busy; it is now stale.
			expect(runtime.sent).toHaveLength(0);
			// Simulate a fresh message from the other producer now that the Goal item is stale.
			flushes.length = 0;
			otherPending = true;
			registration.request();
			await flushDelivery();
			expect(flushes).toEqual([true]);
			expect(runtime.sent).toHaveLength(0);
		} finally {
			registration.dispose();
		}
	});

	test("a kickoff that starts after its run was paused is cancelled at agent_start", async () => {
		const { runtime, ctx } = await startGoal();
		const kickoff = runtime.sent[0];
		if (kickoff === undefined) throw new Error("the kickoff was not sent");
		await command(runtime, "pause", ctx);
		const aborts = runtime.aborts.count;
		// Pi defers an extension send issued during agent_settled, so the message can start its run
		// after the pause that revoked it. The host awaits agent_start before the first request.
		await emit(
			runtime,
			"before_agent_start",
			{
				type: "before_agent_start",
				messageType: "custom",
				message: kickoff.message,
				systemPrompt: "",
				systemPromptOptions: { sections: {} },
			},
			ctx,
		);
		await emit(runtime, "agent_start", { type: "agent_start" }, ctx);
		expect(runtime.aborts.count).toBe(aborts + 1);
		expect(runtime.activeTools).not.toContain("goal");
	});

	test("a completed tree navigation rebuilds paused facts from the current branch", async () => {
		const { runtime, ctx } = await startGoal();
		await emit(runtime, "session_before_tree", { type: "session_before_tree" }, ctx);
		await emit(runtime, "session_tree", { type: "session_tree" }, ctx);
		expect(runtime.activeTools).not.toContain("goal");
		await command(runtime, "status", ctx);
		expect(statusText(runtime)).toContain("Ship goal");
		expect(statusText(runtime)).toContain("paused");
		await expect(command(runtime, "resume", ctx)).resolves.toBeUndefined();
		await flushDelivery();
		expect(
			runtime.sent.filter((entry) => entry.message.customType === "pi-goal-kickoff"),
		).toHaveLength(2);
	});

	test("a settle boundary proposes a continuation with an assistant-final context", async () => {
		const { runtime, ctx } = await startGoal();
		const result = (await emit(
			runtime,
			"agent_before_settle",
			boundaryEvent({ canContinue: false }),
			ctx,
		)) as { continue?: boolean; entries?: Array<Record<string, unknown>> } | undefined;
		expect(result?.continue).toBe(true);
		const drafts = result?.entries ?? [];
		expect(drafts).toHaveLength(2);
		for (const draft of drafts) {
			if (draft.type === "custom") {
				runtime.session.appendCustomEntry(String(draft.customType), draft.data);
			} else {
				runtime.session.appendCustomMessageEntry(
					String(draft.customType),
					draft.content as string,
					draft.display === true,
				);
			}
		}
		await command(runtime, "status", ctx);
		expect(statusText(runtime)).toContain("continuations 1/8");
	});

	test("tree navigation revokes before moving and a canceled navigation stays paused", async () => {
		const { runtime, ctx } = await startGoal();
		await emit(runtime, "session_before_tree", { type: "session_before_tree" }, ctx);
		expect(runtime.activeTools).not.toContain("goal");
		// Canceled navigation: no session_tree event, so the pause written before navigation stands.
		await command(runtime, "status", ctx);
		expect(statusText(runtime)).toContain("paused");
		expect(statusText(runtime)).toContain("paused before tree navigation");
		await command(runtime, "resume", ctx);
		await flushDelivery();
		expect(runtime.activeTools).toContain("goal");
	});

	test("an aborted parent turn pauses and leaves the goal resumable", async () => {
		const { runtime, ctx } = await startGoal();
		await emit(runtime, "agent_start", { type: "agent_start" }, ctx);
		await emit(runtime, "agent_settled", { type: "agent_settled", aborted: true }, ctx);
		expect(runtime.activeTools).not.toContain("goal");
		expect(runtime.aborts.count).toBe(1);
		expect(statusText(runtime)).toContain("turn was aborted");
	});

	test("a goal started before the first message is not durable until Pi writes the session", async () => {
		const { runtime, ctx } = await startGoal();
		const file = runtime.session.getSessionFile();
		expect(file).toBeDefined();
		if (file === undefined) return;
		expect(existsSync(file)).toBe(false);
		await command(runtime, "status", ctx);
		expect(statusText(runtime)).toContain("Durability:");

		runtime.session.appendMessage({ role: "user", content: "go", timestamp: 0 });
		expect(existsSync(file)).toBe(true);
		const reopened = SessionManager.open(file, dirname(file));
		await boot({ session: reopened });
		const resumedRuntime = createRuntime(reopened);
		piGoalExtension(resumedRuntime.pi);
		const resumedCtx = contextFor(resumedRuntime);
		await emit(
			resumedRuntime,
			"session_start",
			{ type: "session_start", reason: "reload" },
			resumedCtx,
		);
		await command(resumedRuntime, "status", resumedCtx);
		expect(statusText(resumedRuntime)).toContain("Ship goal");
		expect(statusText(resumedRuntime)).toContain("paused");
	});

	test("a pi-subagents child session does not register the goal runtime", () => {
		const dir = tempDir();
		process.env.PI_CODING_AGENT_DIR = dir;
		const session = SessionManager.create(process.cwd(), join(dir, "sessions"));
		const runtime = createRuntime(session);
		process.env.PI_SUBAGENTS_CHILD_ID = "child-1";
		try {
			piGoalExtension(runtime.pi);
		} finally {
			delete process.env.PI_SUBAGENTS_CHILD_ID;
		}
		expect(runtime.tools).toEqual([]);
		expect(runtime.commands.size).toBe(0);
		expect(runtime.handlers.size).toBe(0);
		expect(readdirSync(dir)).toEqual(["sessions"]);
	});
});
