import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { createGoalDocument, GOAL_ENTRY_TYPE } from "../src/document.js";
import piGoalExtension from "../src/extension.js";

const hosts: Array<() => Promise<void>> = [];
const savedChildEnv = process.env.PI_SUBAGENTS_CHILD_ID;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
	for (const dispose of hosts.splice(0)) await dispose();
	if (savedChildEnv === undefined) delete process.env.PI_SUBAGENTS_CHILD_ID;
	else process.env.PI_SUBAGENTS_CHILD_ID = savedChildEnv;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

/** A real session with no model selected, which is what makes a kickoff send fail after the fact. */
async function bootNoModelHost(): Promise<{
	readonly session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	readonly notices: string[];
	readonly invokeGoal: (verb: string) => Promise<void>;
}> {
	const dir = await mkdtemp(join(tmpdir(), "pi-goal-no-model-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.PI_SUBAGENTS_CHILD_ID;
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [piGoalExtension],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(dir),
	});
	await session.bindExtensions({ mode: "print" });
	// Pi always resolves a default model, so the extension-visible "no model selected" state is the
	// empty live selection. Without it a kickoff send fails only asynchronously, after the goal write.
	(session.state as { model?: unknown }).model = undefined;
	const command = session.extensionRunner.getCommand("goal");
	if (command === undefined) throw new Error("the goal command was not registered");
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
	hosts.push(async () => {
		// Sessions in one process share the ext-core runtime identity; shut the lifecycle down so the
		// next boot does not see a duplicate settings provider.
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		await rm(dir, { recursive: true, force: true });
	});
	return {
		session,
		notices,
		invokeGoal: async (verb: string) => {
			await command.handler(verb, ctx);
		},
	};
}

function goalEntries(session: { sessionManager: { getEntries(): readonly unknown[] } }): number {
	return session.sessionManager
		.getEntries()
		.filter(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				"customType" in entry &&
				entry.customType === GOAL_ENTRY_TYPE,
		).length;
}

test("/goal start without a selected model authorizes and writes nothing", async () => {
	const booted = await bootNoModelHost();
	expect(booted.session.model).toBeUndefined();
	await booted.invokeGoal("start Ship goal");
	const notice = booted.notices[booted.notices.length - 1] ?? "";
	expect(notice).toContain("No model is selected");
	expect(goalEntries(booted.session)).toBe(0);
	expect(booted.session.getActiveToolNames()).not.toContain("goal");
	expect(booted.session.isStreaming).toBe(false);
});

test("/goal resume without a selected model leaves the paused goal untouched", async () => {
	const booted = await bootNoModelHost();
	// A paused goal from an earlier session is exactly a branch snapshot with no live run.
	const snapshot = createGoalDocument({
		objective: "Ship goal",
		reviewMode: "off",
		budgets: { continuations: 8, reviews: 3 },
		now: new Date("2026-01-01T00:00:00.000Z"),
	});
	booted.session.sessionManager.appendCustomEntry(GOAL_ENTRY_TYPE, snapshot);
	await booted.invokeGoal("resume");
	const notice = booted.notices[booted.notices.length - 1] ?? "";
	expect(notice).toContain("No model is selected");
	expect(goalEntries(booted.session)).toBe(1);
	await booted.invokeGoal("status");
	const status = booted.notices[booted.notices.length - 1] ?? "";
	expect(status).toContain("Ship goal");
	expect(status).toContain("paused");
});
