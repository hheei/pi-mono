import { describe, expect, test } from "vitest";
import {
	aggregateUsage,
	assistantUpdatePhase,
	createStateProjector,
	lastAssistantText,
	summarizeCurrentBranch,
	transcriptFacts,
} from "../src/state.js";

function turn(id: string, text: string, stopReason = "stop", cost: number | null = 0): unknown {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason,
			usage: {
				input: 2,
				output: 3,
				cacheRead: 4,
				cacheWrite: 5,
				cost: cost === null ? {} : { total: cost },
			},
		},
	};
}

describe("assistant update phase", () => {
	test("categorizes thinking, generating, and tool call deltas", () => {
		expect(assistantUpdatePhase({ type: "thinking_delta" }, undefined)).toEqual({
			kind: "thinking",
		});
		expect(assistantUpdatePhase({ type: "text_delta" }, undefined)).toEqual({ kind: "generating" });
		expect(
			assistantUpdatePhase(
				{ type: "toolcall_delta", contentIndex: 0 },
				{ content: [{ type: "toolCall", name: "read" }] },
			),
		).toEqual({ kind: "toolcall", toolName: "read" });
	});

	test("reads generating from the message text when the update names no type", () => {
		expect(assistantUpdatePhase(undefined, { content: [{ type: "text", text: "hi" }] })).toEqual({
			kind: "generating",
		});
		expect(assistantUpdatePhase(undefined, { content: [] })).toBeUndefined();
	});

	test("omits the tool name until the streamed call has one", () => {
		expect(
			assistantUpdatePhase({ type: "toolcall_start", contentIndex: 3 }, { content: [] }),
		).toEqual({ kind: "toolcall" });
	});
});

describe("state projection", () => {
	test("uses the current branch last assistant and deduplicates replayed usage", () => {
		const entries = [
			turn("a", "old", "stop", 0.2),
			turn("a", "old", "stop", 0.2),
			turn("b", "latest", "stop", 0.3),
		];
		expect(summarizeCurrentBranch(entries)).toBe("latest");
		expect(summarizeCurrentBranch([turn("c", "x".repeat(500), "stop", 0.1)])?.length).toBe(240);
		const longTurn = [turn("d", `line1\nline2\n${"x".repeat(300)}`, "stop", 0.1)];
		expect(lastAssistantText(longTurn)).toBe(`line1\nline2\n${"x".repeat(300)}`);
		const facts = transcriptFacts(longTurn);
		expect(facts.resultText).toBe(`line1\nline2\n${"x".repeat(300)}`);
		expect(facts.summary?.length).toBe(240);
		expect(facts.summary).not.toContain("\n");
		expect(aggregateUsage(entries)).toEqual({
			inputTokens: 4,
			outputTokens: 6,
			cacheReadTokens: 8,
			cacheWriteTokens: 10,
			costUsd: 0.5,
			turns: 2,
		});
	});
	test("marks invalid provider cost unavailable rather than inventing billing", () =>
		expect(aggregateUsage([turn("a", "ok", "stop", null)]).costUsd).toBeNull());
	test("distinguishes interrupted from failed without another public state", () => {
		const projector = createStateProjector("running");
		projector.rebuild([turn("a", "partial", "aborted")]);
		expect(projector.snapshot()).toMatchObject({
			state: "running",
			interrupted: "Assistant turn was interrupted",
		});
		projector.applyEvent({ type: "error", message: "boom" });
		expect(projector.snapshot()).toMatchObject({ state: "error", interrupted: "boom" });
	});
	test("tracks tool streaming and labels assistant generation", () => {
		const projector = createStateProjector("running");
		projector.applyEvent({ type: "tool_execution_start", toolName: "git status" });
		expect(projector.snapshot().activeTool).toBe("git status");
		projector.applyEvent({ type: "tool_execution_update", toolName: "git status" });
		expect(projector.snapshot().activeTool).toBe("git status");

		projector.applyEvent({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "streaming reply..." }] },
		});
		expect(projector.snapshot().summary).toBe("generating...");
		expect(projector.snapshot().activeTool).toBeUndefined();

		projector.applyEvent({ type: "tool_execution_start", toolName: "read" });
		expect(projector.snapshot().activeTool).toBe("read");

		projector.applyEvent({ type: "tool_execution_end" });
		expect(projector.snapshot().activeTool).toBeUndefined();
		expect(projector.snapshot().summary).toBe("thinking...");
		projector.applyEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1 },
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Reading" },
					{ type: "toolCall", name: "read" },
				],
			},
		});
		expect(projector.snapshot().activeTool).toBe("read");
	});

	test("follows a turn from agent_start to agent_settled", () => {
		const projector = createStateProjector("running");
		projector.rebuild([turn("old", "previous answer")]);
		projector.applyEvent({ type: "turn_start" });
		expect(projector.snapshot()).toMatchObject({ state: "running", summary: "thinking..." });
		projector.applyEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta" },
			message: { role: "assistant", content: [{ type: "text", text: "earlier text" }] },
		});
		expect(projector.snapshot().summary).toBe("thinking...");
		projector.applyEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta" },
			message: { role: "assistant", content: [{ type: "text", text: "new answer" }] },
		});
		expect(projector.snapshot().summary).toBe("generating...");
	});

	test("settles after agent_end", () => {
		const projector = createStateProjector("running");
		projector.applyEvent({ type: "agent_start" });
		expect(projector.snapshot().state).toBe("running");
		projector.applyEvent({ type: "agent_end", messages: [] });
		expect(projector.snapshot().state).toBe("running");
		projector.applyEvent({
			type: "agent_settled",
			message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		});
		expect(projector.snapshot()).toMatchObject({ state: "done", summary: "done" });
	});
	test("successful settlement replaces a stale error even without a retry-start event", () => {
		const projector = createStateProjector("running");
		projector.applyEvent({ type: "error", message: "upstream timeout" });
		projector.applyEvent({
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
		});
		expect(projector.snapshot()).toMatchObject({ state: "done", summary: "done" });
		expect(projector.snapshot().interrupted).toBeUndefined();
	});
	test("settled interruption is blocked before delivery", () => {
		const projector = createStateProjector("running");
		projector.applyEvent({
			type: "agent_settled",
			aborted: true,
		});
		expect(projector.snapshot()).toMatchObject({
			state: "blocked",
			interrupted: "Assistant turn was interrupted",
		});
	});
	test("clears interrupted on auto_retry_start and on successful agent_settled", () => {
		const projector = createStateProjector("running");
		projector.applyEvent({ type: "error", message: "504 upstream timeout" });
		expect(projector.snapshot().interrupted).toBe("504 upstream timeout");
		expect(projector.snapshot().state).toBe("error");

		projector.applyEvent({ type: "auto_retry_start" });
		expect(projector.snapshot().state).toBe("running");
		expect(projector.snapshot().interrupted).toBeUndefined();

		projector.applyEvent({
			type: "agent_settled",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "recovered" }],
				stopReason: "stop",
			},
		});
		expect(projector.snapshot().state).toBe("done");
		expect(projector.snapshot().interrupted).toBeUndefined();
	});

	test("reflects compacting in summary during compaction and clears on completion", () => {
		const projector = createStateProjector("done");
		projector.applyEvent({ type: "compaction_start", reason: "threshold" });
		expect(projector.snapshot().summary).toBe("compacting...");
		expect(projector.snapshot().activeTool).toBeUndefined();

		projector.applyEvent({ type: "compaction_end", reason: "threshold" });
		expect(projector.snapshot().summary).toBeUndefined();
	});
});
