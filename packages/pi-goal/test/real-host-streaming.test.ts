import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import piGoalExtension from "../src/extension.js";

const dirs: string[] = [];
const savedChildEnv = process.env.PI_SUBAGENTS_CHILD_ID;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
	if (savedChildEnv === undefined) delete process.env.PI_SUBAGENTS_CHILD_ID;
	else process.env.PI_SUBAGENTS_CHILD_ID = savedChildEnv;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

/**
 * A real Pi provider whose stream stays open until the host aborts it. This makes the pause /
 * resume sequence exercise the actual AgentSession operation handoff instead of synthetic events.
 */
function stalledProvider(pi: ExtensionAPI): void {
	pi.registerProvider("goal-test", {
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "goal-test-key",
		models: [
			{
				id: "stalled",
				name: "Stalled",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple(model, _context, options) {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "working" }],
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
				stopReason: "pending",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: message });
			const abort = (): void => {
				message.stopReason = "aborted";
				stream.push({ type: "error", reason: "aborted", error: message });
				stream.end(message);
			};
			if (options?.signal?.aborted === true) abort();
			else options?.signal?.addEventListener("abort", abort, { once: true });
			return stream;
		},
	});
}

async function waitUntil(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("a real streaming pause followed by resume hands off the old operation first", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-goal-real-host-"));
	dirs.push(dir);
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.PI_SUBAGENTS_CHILD_ID;
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		extensionFactories: [stalledProvider, piGoalExtension],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(dir),
	});
	try {
		await session.bindExtensions({ mode: "print" });
		const model = session.modelRuntime.getModel("goal-test", "stalled");
		if (model === undefined) throw new Error("the stalled test provider was not registered");
		await session.setModel(model);
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

		await command.handler("start Ship goal", ctx);
		await waitUntil(() => session.isStreaming, "the kickoff turn to stream");
		await command.handler("pause", ctx);
		// The old aborted operation may not have settled yet; resume must wait for that handoff.
		await command.handler("resume", ctx);
		await waitUntil(() => session.isStreaming, "the resumed kickoff to stream");
		await command.handler("status", ctx);
		const status = notices.reverse().find((message) => message.startsWith("Goal"));
		expect(status).toContain("Ship goal");
		expect(status).toContain("working");
		await command.handler("pause", ctx);
	} finally {
		session.dispose();
	}
});
