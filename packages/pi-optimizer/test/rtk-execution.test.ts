import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createBashTool,
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, test, vi } from "vitest";
import { createOptimizerInfo } from "../src/info.js";
import { createRtkRuntime } from "../src/rtk.js";

// A deterministic provider response exercises the real Pi agent/tool execution
// pipeline without credentials or a network request. Bash itself is not mocked.
const model: Model<"openai-completions"> = {
	id: "optimizer-execution-test",
	name: "Optimizer execution test",
	api: "openai-completions",
	provider: "optimizer-test",
	baseUrl: "http://unused.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
};

const inputSchema = Type.Object({ command: Type.String() });

test("the real Pi agent executes rewritten native Bash arguments without extra info", async () => {
	const sessionManager = SessionManager.inMemory(tmpdir());
	const info = createOptimizerInfo({
		appendEntry: (type, data) => sessionManager.appendCustomEntry(type, data),
		registerEntryRenderer: () => undefined,
	});
	const exec = vi.fn(async (_command: string, args: string[]) => ({
		code: 0,
		stdout: args[0] === "--version" ? "rtk 0.45.0" : "printf optimizer-rewritten",
		stderr: "",
		killed: false,
		truncated: false,
	}));
	// A temporary cache keeps the test out of the agent directory it would otherwise persist to.
	const cachePath = join(await mkdtemp(join(tmpdir(), "pi-optimizer-rtk-")), "rtk-rewrites.json");
	const runtime = createRtkRuntime({ exec } as Pick<ExtensionAPI, "exec">, info, { cachePath });
	const response: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [
			{
				type: "toolCall",
				id: "optimizer-bash-call",
				name: "bash",
				arguments: { command: "printf optimizer-original" },
			},
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
	const agent = new Agent({
		initialState: { model, tools: [createBashTool(tmpdir())] },
		streamFn: () => {
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "toolUse", message: response });
			return stream;
		},
		beforeToolCall: async ({ toolCall, args }, signal) => {
			if (!Value.Check(inputSchema, args)) throw new Error("Invalid Bash arguments");
			await runtime.rewrite(
				{ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args },
				{ signal } as ExtensionContext,
				{ enabled: true, path: "configured-rtk" },
			);
			expect(args.command).toBe("printf optimizer-rewritten");
			expect(sessionManager.getEntries()).toEqual([]);
			return undefined;
		},
		finishTurn: () => ({ action: "end" }),
	});
	await agent.prompt("Exercise the deterministic Bash call");
	const result = agent.state.messages.find((message) => message.role === "toolResult");
	expect(result).toMatchObject({
		role: "toolResult",
		toolCallId: "optimizer-bash-call",
		isError: false,
		content: [{ type: "text", text: "optimizer-rewritten" }],
	});
	expect(exec.mock.calls.filter(([, args]) => args[0] === "rewrite")).toHaveLength(1);
	expect(JSON.stringify(sessionManager.buildSessionContext().messages)).not.toContain(
		"optimizer-info",
	);
	runtime.reset();
});
