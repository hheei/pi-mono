import { describe, expect, it } from "vitest";

import {
	normalizeSourceEntryIds,
	ObserverStreamError,
	runObserver,
} from "../src/agents/observer/agent.js";
import { captureLoopConfig, fakeAgentLoop, itClampsMaxTokens } from "./fixtures/agent-loop.js";

function assistantEndEvent(stopReason: string, errorMessage?: string): any {
	return { type: "message_end", message: { role: "assistant", stopReason, errorMessage } };
}

describe("runObserver maxTokens clamping", () => {
	const args = {
		modelRegistry: { streamSimple: (() => undefined) as any },
		apiKey: "test",
		priorReflections: [],
		priorObservations: [],
		chunk: "[Source entry id: entry-a]\\nUser asked for a memory update.",
		allowedSourceEntryIds: ["entry-a"],
		resolveTimestamp: () => "2026-05-02 10:30",
	};

	itClampsMaxTokens((overrides) => runObserver({ ...args, ...overrides }));
});

describe("runObserver prompt cache identity", () => {
	const args = {
		model: {} as any,
		modelRegistry: { streamSimple: (() => undefined) as any },
		apiKey: "test",
		priorReflections: [],
		priorObservations: [],
		chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
		allowedSourceEntryIds: ["entry-a"],
		resolveTimestamp: () => "2026-05-02 10:30",
	};

	it("passes the parent session id so the provider can key caching and routing on it", async () => {
		const { loop, config } = captureLoopConfig();

		await runObserver({ ...args, sessionId: "session-1", agentLoop: loop });

		expect(config().sessionId).toBe("session-1");
	});

	it("omits sessionId when the caller has no session identity", async () => {
		const { loop, config } = captureLoopConfig();

		await runObserver({ ...args, agentLoop: loop });

		expect(config()).not.toHaveProperty("sessionId");
	});
});

describe("runObserver", () => {
	const baseArgs = {
		model: {} as any,
		modelRegistry: { streamSimple: (() => undefined) as any },
		apiKey: "test",
		priorReflections: [],
		priorObservations: [],
		chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
		allowedSourceEntryIds: ["entry-a"],
		resolveTimestamp: () => "2026-05-02 10:30",
	};

	it("keeps core observer prompt rules", async () => {
		let systemPrompt = "";
		const loop = fakeAgentLoop((_prompts, context) => {
			systemPrompt = context.messages[0]?.role === "system" ? context.messages[0].content : "";
		});

		await runObserver({ ...baseArgs, agentLoop: loop });

		expect(systemPrompt).toContain("Preserve user assertions exactly");
		expect(systemPrompt).toContain("Detail preservation");
		expect(systemPrompt).toContain("Frame state changes as supersession");
		expect(systemPrompt).toContain("sourceEntryIds");
		expect(systemPrompt).toContain("zero observations");
		expect(systemPrompt).toContain("The dropper will drop these first");
		expect(systemPrompt).toContain("highest-resistance, load-bearing observations");
		expect(systemPrompt).toContain(
			"Give every observation a kind: user | decision | fact | progress",
		);
		expect(systemPrompt).toContain("kind: progress");
		expect(systemPrompt).toContain("Relevance is durability");
		expect(systemPrompt).not.toContain("will NEVER be dropped");
		expect(systemPrompt).not.toContain("pruner");
	});

	it("records V3 observations with source ids and code-computed tokenCount", async () => {
		const content = "User asked for a memory update.";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				observations: [
					{
						content,
						relevance: "high",
						kind: "user",
						sourceEntryIds: ["entry-a"],
					},
				],
			});
		});

		const observations = await runObserver({ ...baseArgs, agentLoop: loop });

		expect(observations).toHaveLength(1);
		expect(observations?.[0]).toMatchObject({
			content,
			timestamp: "2026-05-02 10:30",
			relevance: "high",
			// The recorded kind is kept verbatim; the rank reads it back with a
			// "fact" fallback for entries that predate the field.
			kind: "user",
			sourceEntryIds: ["entry-a"],
			// tokenCount is code-computed from the full rendered line (id + timestamp + relevance + content).
			tokenCount: 18,
		});
		expect(observations?.[0]?.id).toMatch(/^[a-f0-9]{12}$/);
	});

	it("puts current local time after prior memory to preserve prompt cache prefix", async () => {
		let userText = "";
		const loop = fakeAgentLoop((prompts) => {
			const block = prompts[0]?.content?.[0];
			userText = block && typeof block === "object" && "text" in block ? String(block.text) : "";
		});

		await runObserver({
			...baseArgs,
			priorReflections: ["reflection-marker"],
			priorObservations: ["observation-marker"],
			agentLoop: loop,
		});

		expect(userText.startsWith("CURRENT REFLECTIONS:")).toBe(true);
		const timeAt = userText.indexOf("Current local time:");
		expect(timeAt).toBeGreaterThan(userText.indexOf("observation-marker"));
		expect(timeAt).toBeLessThan(userText.indexOf("NEW CONVERSATION CHUNK:"));
	});

	it("derives the timestamp from the cited source entries and ignores a model-supplied one", async () => {
		const seen: string[][] = [];
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				observations: [
					{
						// A legacy-shaped payload: the schema no longer declares a timestamp,
						// and whatever the model sends must not reach the ledger.
						timestamp: "1999-01-01 00:00",
						content: "User asked for a memory update.",
						relevance: "high",
						kind: "user",
						sourceEntryIds: ["entry-a"],
					},
				],
			});
		});

		const observations = await runObserver({
			...baseArgs,
			agentLoop: loop,
			resolveTimestamp: (ids) => {
				seen.push([...ids]);
				return "2026-06-01 08:15";
			},
		});

		expect(seen).toEqual([["entry-a"]]);
		expect(observations?.[0]?.timestamp).toBe("2026-06-01 08:15");
	});

	it("rejects invented source ids and returns no observations", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				observations: [
					{
						content: "Bad source",
						relevance: "medium",
						kind: "progress",
						sourceEntryIds: ["missing"],
					},
				],
			});
		});

		await expect(runObserver({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("dedupes deterministic ids", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				observations: [
					{
						content: "Same content",
						relevance: "medium",
						kind: "fact",
						sourceEntryIds: ["entry-a"],
					},
					{
						content: "Same content",
						relevance: "high",
						kind: "progress",
						sourceEntryIds: ["entry-a"],
					},
				],
			});
		});

		const observations = await runObserver({ ...baseArgs, agentLoop: loop });

		expect(observations).toHaveLength(1);
		expect(observations?.[0]?.content).toBe("Same content");
	});

	it("returns undefined when no tool call records observations", async () => {
		const loop = fakeAgentLoop(() => {});
		await expect(runObserver({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("throws ObserverStreamError when the stream errors with nothing recorded", async () => {
		for (const stopReason of ["error", "aborted"]) {
			const loop = fakeAgentLoop(() => {}, [assistantEndEvent(stopReason, "prompt is too long")]);
			const error = await runObserver({ ...baseArgs, agentLoop: loop }).catch((e) => e);
			expect(error).toBeInstanceOf(ObserverStreamError);
			expect(error.stopReason).toBe(stopReason);
			expect(error.message).toContain("prompt is too long");
		}
	});

	it("keeps partial observations when the stream errors after recording", async () => {
		const loop = fakeAgentLoop(
			async (_prompts, context) => {
				await context.tools[0].execute("tool-1", {
					observations: [
						{
							content: "Kept despite later error",
							relevance: "high",
							kind: "progress",
							sourceEntryIds: ["entry-a"],
						},
					],
				});
			},
			[assistantEndEvent("error", "gateway timeout")],
		);

		const observations = await runObserver({ ...baseArgs, agentLoop: loop });

		expect(observations).toHaveLength(1);
		expect(observations?.[0]?.content).toBe("Kept despite later error");
	});

	it("uses finishTurn as an observer turn cap without overriding hard exits", async () => {
		let finishTurn: any;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			finishTurn = config.finishTurn;
		});

		await runObserver({ ...baseArgs, agentLoop: loop, maxTurns: 2 });

		expect(finishTurn).toBeTypeOf("function");
		expect(finishTurn({ message: { stopReason: "error" } })).toBeUndefined();
		expect(finishTurn({ message: { stopReason: "aborted" } })).toBeUndefined();
		expect(finishTurn({ message: { stopReason: "toolUse" } })).toBeUndefined();
		expect(finishTurn({ message: { stopReason: "stop" } })).toEqual({ action: "end" });
	});

	it("uses configured observer thinking level for reasoning models", async () => {
		let seenReasoning: unknown;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			seenReasoning = config.reasoning;
		});

		await runObserver({
			...baseArgs,
			model: { reasoning: true } as any,
			agentLoop: loop,
			thinkingLevel: "minimal",
		});

		expect(seenReasoning).toBe("minimal");
	});

	it("omits observer reasoning when thinkingLevel is off", async () => {
		let seenReasoning: unknown = "unset";
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			seenReasoning = config.reasoning;
		});

		await runObserver({
			...baseArgs,
			model: { reasoning: true } as any,
			agentLoop: loop,
			thinkingLevel: "off",
		});

		expect(seenReasoning).toBeUndefined();
	});
});

describe("normalizeSourceEntryIds", () => {
	const allowed = ["entry-a", "entry-b", "entry-c"];

	it("accepts source ids from the allowed chunk and orders them by branch order", () => {
		expect(normalizeSourceEntryIds(["entry-c", "entry-a"], allowed)).toEqual([
			"entry-a",
			"entry-c",
		]);
	});

	it("dedupes repeated source ids", () => {
		expect(normalizeSourceEntryIds(["entry-b", "entry-b", "entry-a"], allowed)).toEqual([
			"entry-a",
			"entry-b",
		]);
	});

	it("rejects missing, empty, or hallucinated source ids", () => {
		expect(normalizeSourceEntryIds(undefined, allowed)).toBeUndefined();
		expect(normalizeSourceEntryIds([], allowed)).toBeUndefined();
		expect(normalizeSourceEntryIds(["entry-a", "not-in-the-chunk"], allowed)).toBeUndefined();
		expect(normalizeSourceEntryIds(["entry-a"], [])).toBeUndefined();
	});
});
