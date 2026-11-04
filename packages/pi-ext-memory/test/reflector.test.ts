import { describe, expect, it } from "vitest";

import {
	normalizeSupportingObservationIds,
	observationToReflectorLine,
	reflectionBudgetLine,
	runReflector,
	summarizeSupportIdCounts,
} from "../src/agents/reflector/agent.js";
import { hashId } from "../src/ids.js";
import { estimateStringTokens } from "../src/tokens.js";
import { captureLoopConfig, fakeAgentLoop, itClampsMaxTokens } from "./fixtures/agent-loop.js";
import { observation, reflection } from "./fixtures/session.js";

describe("runReflector maxTokens clamping", () => {
	const args = {
		modelRegistry: { streamSimple: (() => undefined) as any },
		apiKey: "test",
		reflections: [],
		observations: [observation("aaaaaaaaaaaa"), observation("bbbbbbbbbbbb")],
		droppedReflectionIds: new Set<string>(),
	};

	itClampsMaxTokens((overrides) => runReflector({ ...args, ...overrides }));

	it("uses finishTurn as a reflector turn cap without overriding hard exits", async () => {
		const { loop, config } = captureLoopConfig();

		await runReflector({ ...args, model: {} as any, agentLoop: loop, maxTurns: 2 });

		expect(config().finishTurn).toBeTypeOf("function");
		expect(config().finishTurn({ message: { stopReason: "error" } })).toBeUndefined();
		expect(config().finishTurn({ message: { stopReason: "aborted" } })).toBeUndefined();
		expect(config().finishTurn({ message: { stopReason: "toolUse" } })).toBeUndefined();
		expect(config().finishTurn({ message: { stopReason: "stop" } })).toEqual({ action: "end" });
	});
});

describe("V3 reflector agent", () => {
	const obsA = observation("aaaaaaaaaaaa");
	const obsB = observation("bbbbbbbbbbbb");
	const baseArgs = {
		model: {} as any,
		modelRegistry: { streamSimple: (() => undefined) as any },
		apiKey: "test",
		reflections: [],
		observations: [obsA, obsB],
		droppedReflectionIds: new Set<string>(),
	};

	it("keeps core reflector prompt guidance in V3 terms", async () => {
		let systemPrompt = "";
		const loop = fakeAgentLoop((_prompts, context) => {
			systemPrompt = context.messages[0]?.role === "system" ? context.messages[0].content : "";
		});

		await runReflector({ ...baseArgs, agentLoop: loop });

		expect(systemPrompt).toContain("Your task is different from the observer");
		expect(systemPrompt).toContain("User assertions are authoritative");
		expect(systemPrompt).toContain("supportingObservationIds");
		expect(systemPrompt).toContain("coverage/provenance set");
		expect(systemPrompt).toContain("Do not lightly reword existing reflections");
		expect(systemPrompt).toContain("Reflections are scarce, expensive durable orientation anchors");
		expect(systemPrompt).toContain("not a second observation layer");
		expect(systemPrompt).toContain("Over-reflection is also memory distortion");
		expect(systemPrompt).toContain("makes transient details look durable");
		expect(systemPrompt).toContain("Decision procedure:");
		expect(systemPrompt).toContain(
			"First reject observations that are transient, low-level, partial, routine, or only useful as current working state",
		);
		expect(systemPrompt).toContain("future-agent utility test");
		expect(systemPrompt).toContain(
			"avoid a wrong decision, repeated work, or user-preference violation",
		);
		expect(systemPrompt).toContain(
			"If the candidate fails that future-agent utility test, leave it as an observation",
		);
		expect(systemPrompt).toContain("If unsure, emit no reflection");
		// A pure merge is work even though it adds no new line.
		expect(systemPrompt).toContain("or a merge of current ones");
		expect(systemPrompt).toContain("a pure merge that adds nothing new is a valid proposal");
		expect(systemPrompt).toContain(
			"High and critical observations deserve careful review, not automatic reflection",
		);
		expect(systemPrompt).toContain("Do not turn each observation into a reflection");
		expect(systemPrompt).toContain(
			"Observations are evidence; reflections are compressed durable conclusions",
		);
		expect(systemPrompt).toContain("Single-observation reflections are allowed");
		expect(systemPrompt).toContain(
			"durable user preference, constraint, correction, decision, invariant, completed outcome, or long-lived blocker",
		);
		expect(systemPrompt).toContain("Do not copy or lightly paraphrase observation lines");
		expect(systemPrompt).toContain("Prefer fewer, higher-value reflections");
		expect(systemPrompt).toContain(
			"zero reflections than to create one reflection per observation",
		);
		expect(systemPrompt).toContain("Most transient task-log observations");
		expect(systemPrompt).toContain(
			"files inspected, commands run, failed attempts, partial implementation, and current working state",
		);
		expect(systemPrompt).toContain("[coverage: none|partial|strong]");
		expect(systemPrompt).toContain("Coverage tiers are review context");
		expect(systemPrompt).toContain(
			"Coverage is not a quota, target, priority score, or instruction to emit reflections",
		);
		expect(systemPrompt).toContain("Support ids and coverage stewardship");
		expect(systemPrompt).toContain(
			"First decide whether the reflection content passes the durable-value bar",
		);
		expect(systemPrompt).toContain(
			"include all current observation ids whose durable meaning is preserved",
		);
		expect(systemPrompt).toContain("supportingObservationIds are not a checklist");
		expect(systemPrompt).toContain("Do not add ids merely to improve coverage counts");
		expect(systemPrompt).toContain(
			"False or inflated support ids can cause unsafe downstream dropper pruning",
		);
		expect(systemPrompt).toContain(
			"emit zero reflections even when observations have coverage: none",
		);
		expect(systemPrompt).toContain("BAD: completed: edited src/hooks/reflect-drop-trigger.ts");
		expect(systemPrompt).toContain(
			"GOOD: completed: V3 reflect/drop coverage now uses raw progress watermarks",
		);
		expect(systemPrompt).toContain("BAD: npm test passed");
		expect(systemPrompt).toContain(
			"GOOD: completed: V3 package namespace migration passed full tests and typecheck",
		);
		expect(systemPrompt).toContain(
			"ZERO REFLECTIONS: The only new observations are files inspected, commands run, failed attempts, partial implementation, transient debugging, or current working state with no durable conclusion yet",
		);
		expect(systemPrompt).toContain("Focus on:");
		expect(systemPrompt).toContain("User identity, role, preferences, constraints");
		expect(systemPrompt).toContain("Project goals, architecture, technical decisions");
		expect(systemPrompt).toContain("Recurring user behavior or preferences");
		expect(systemPrompt).toContain("Completed outcomes future runs must not redo");
		expect(systemPrompt).toContain("Durable blockers, invariants, and open decisions");
		expect(systemPrompt).toContain("Reflection content rules");
		expect(systemPrompt).toContain("Lead with the fact or pattern");
		expect(systemPrompt).not.toContain("legacy/no-provenance");
		expect(systemPrompt).not.toContain("pruner");
		expect(systemPrompt).not.toContain("Pass strategy");
	});

	it("renders coverage tiers in every active observation line for the reflector", async () => {
		const none = observation("aaaaaaaaaaaa", { content: "Uncovered durable fact" });
		const partial = observation("bbbbbbbbbbbb", { content: "Partially covered fact" });
		const strong = observation("cccccccccccc", { content: "Strongly covered fact" });
		let userText = "";
		const loop = fakeAgentLoop((prompts) => {
			userText = prompts[0].content[0].text;
		});

		await runReflector({
			...baseArgs,
			observations: [none, partial, strong],
			reflections: [
				reflection("rrrrrrrrrrr1", ["bbbbbbbbbbbb", "cccccccccccc"]),
				reflection("rrrrrrrrrrr2", ["cccccccccccc"]),
			],
			agentLoop: loop,
		});

		expect(userText).toContain("[aaaaaaaaaaaa]");
		expect(userText).toContain("[coverage: none] Uncovered durable fact");
		expect(userText).toContain("[coverage: partial] Partially covered fact");
		expect(userText).toContain("[coverage: strong] Strongly covered fact");
		expect(userText).not.toContain("drop-priority");
		expect(userText).not.toContain("drop-resistance");
	});

	it("renders reflector observation lines with coverage evidence only", () => {
		const line = observationToReflectorLine(
			observation("aaaaaaaaaaaa", { relevance: "critical", content: "Important reflected fact" }),
			"partial",
		);

		expect(line).toContain("[aaaaaaaaaaaa]");
		expect(line).toContain("[critical]");
		expect(line).toContain("[coverage: partial]");
		expect(line).toContain("Important reflected fact");
		expect(line).not.toContain("drop-priority");
		expect(line).not.toContain("drop-resistance");
	});

	it("summarizes accepted reflection support-id counts without exposing ids", () => {
		expect(summarizeSupportIdCounts([])).toEqual({
			reflectionCount: 0,
			totalSupportIds: 0,
			minSupportIds: 0,
			maxSupportIds: 0,
			averageSupportIds: 0,
			histogram: {},
		});
		expect(
			summarizeSupportIdCounts([
				reflection("rrrrrrrrrrr1", ["aaaaaaaaaaaa"]),
				reflection("rrrrrrrrrrr2", ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]),
			]),
		).toEqual({
			reflectionCount: 2,
			totalSupportIds: 4,
			minSupportIds: 1,
			maxSupportIds: 3,
			averageSupportIds: 2,
			histogram: { "1": 1, "3": 1 },
		});
	});

	it("normalizes supporting observation ids by active observation order", () => {
		expect(
			normalizeSupportingObservationIds(
				["bbbbbbbbbbbb", "aaaaaaaaaaaa", "aaaaaaaaaaaa"],
				["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
			),
		).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(
			normalizeSupportingObservationIds(["aaaaaaaaaaaa", "missing"], ["aaaaaaaaaaaa"]),
		).toBeUndefined();
		expect(normalizeSupportingObservationIds([], ["aaaaaaaaaaaa"])).toBeUndefined();
	});

	it("records one-line V3 reflections with code-computed ids and token counts", async () => {
		const content = "User prefers source-backed memory.";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				reflections: [{ content, supportingObservationIds: ["bbbbbbbbbbbb", "aaaaaaaaaaaa"] }],
			});
		});

		const result = await runReflector({ ...baseArgs, agentLoop: loop });

		expect(result).toEqual({
			reflections: [
				{
					id: hashId(content),
					content,
					supportingObservationIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
					tokenCount: estimateStringTokens(content),
				},
			],
			supersededReflectionIds: [],
		});
	});

	it("rejects invented support ids and multiline content", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				reflections: [
					{ content: "Bad support", supportingObservationIds: ["missing"] },
					{ content: "Two\nlines", supportingObservationIds: ["aaaaaaaaaaaa"] },
				],
			});
		});

		await expect(runReflector({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("dedupes proposals and skips existing reflection ids", async () => {
		const content = "User prefers terse updates.";
		const existing = reflection(hashId(content), ["aaaaaaaaaaaa"], { content });
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				reflections: [
					{ content, supportingObservationIds: ["aaaaaaaaaaaa"] },
					{ content: "New durable fact.", supportingObservationIds: ["aaaaaaaaaaaa"] },
					{ content: "New durable fact.", supportingObservationIds: ["bbbbbbbbbbbb"] },
				],
			});
		});

		const result = await runReflector({ ...baseArgs, reflections: [existing], agentLoop: loop });

		expect(result?.reflections.map((item) => item.content)).toEqual(["New durable fact."]);
	});

	it("retires the reflections a new reflection supersedes", async () => {
		const refA = reflection("aaaaaaaaaaaa", ["dddddddddddd"]);
		const merged = "User prefers terse updates without preamble.";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				reflections: [
					{
						content: merged,
						supportingObservationIds: ["dddddddddddd"],
						supersedes: ["aaaaaaaaaaaa"],
					},
				],
			});
		});

		const result = await runReflector({
			...baseArgs,
			observations: [{ ...obsA, id: "dddddddddddd" }],
			reflections: [refA],
			agentLoop: loop,
		});

		expect(result?.reflections.map((item) => item.content)).toEqual([merged]);
		expect(result?.supersededReflectionIds).toEqual(["aaaaaaaaaaaa"]);
	});

	it("merges into an existing wording and still retires the replaced reflections", async () => {
		const keep = "User prefers terse updates.";
		const drop = "User likes short answers.";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				// Same content as the reflection that stays, so nothing new lands — the
				// merge is the tombstone, not a new line.
				reflections: [
					{
						content: keep,
						supportingObservationIds: ["aaaaaaaaaaaa"],
						supersedes: ["eeeeeeeeeeee"],
					},
				],
			});
		});

		const result = await runReflector({
			...baseArgs,
			reflections: [
				reflection(hashId(keep), ["aaaaaaaaaaaa"], { content: keep }),
				reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: drop }),
			],
			agentLoop: loop,
		});

		expect(result?.reflections).toEqual([]);
		expect(result?.supersededReflectionIds).toEqual(["eeeeeeeeeeee"]);
	});

	it("ignores unknown supersede ids", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				reflections: [
					{
						content: "User prefers terse updates and no preamble.",
						supportingObservationIds: ["aaaaaaaaaaaa"],
						supersedes: ["ffffffffffff"],
					},
				],
			});
		});

		const result = await runReflector({ ...baseArgs, agentLoop: loop });

		expect(result?.reflections).toHaveLength(1);
		expect(result?.supersededReflectionIds).toEqual([]);
	});

	it("never retires the replacement itself", async () => {
		const existing = "User prefers terse updates.";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				reflections: [
					{
						content: existing,
						supportingObservationIds: ["aaaaaaaaaaaa"],
						supersedes: [hashId(existing)],
					},
				],
			});
		});

		const result = await runReflector({
			...baseArgs,
			reflections: [reflection(hashId(existing), ["aaaaaaaaaaaa"], { content: existing })],
			agentLoop: loop,
		});

		// Nothing new to record and nothing to retire: the line already stands for the
		// merged content.
		expect(result).toBeUndefined();
	});

	it("refuses a proposal that restates a permanently retired reflection", async () => {
		const content = "User prefers terse updates.";
		const other = "User prefers short updates.";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				reflections: [
					{
						content,
						supportingObservationIds: ["aaaaaaaaaaaa"],
						supersedes: [hashId(other)],
					},
				],
			});
		});

		const result = await runReflector({
			...baseArgs,
			droppedReflectionIds: new Set([hashId(content)]),
			reflections: [reflection(hashId(other), ["aaaaaaaaaaaa"], { content: other })],
			agentLoop: loop,
		});

		// The tombstone is permanent, so this proposal can never become active: retiring its target
		// would leave neither reflection in active memory.
		expect(result).toBeUndefined();
	});

	it("retires only the merges whose replacement can become active", async () => {
		const retired = "User prefers terse updates.";
		const other = "User prefers short updates.";
		const active = reflection(hashId(other), ["aaaaaaaaaaaa"], { content: other });
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				reflections: [
					{ content: retired, supportingObservationIds: ["aaaaaaaaaaaa"], supersedes: [active.id] },
					{
						content: "User prefers compact summaries.",
						supportingObservationIds: ["aaaaaaaaaaaa"],
						supersedes: [active.id],
					},
				],
			});
		});

		const result = await runReflector({
			...baseArgs,
			droppedReflectionIds: new Set([hashId(retired)]),
			reflections: [active],
			agentLoop: loop,
		});

		// One proposal stands in for nothing, so it retires nothing — while the merge in the same
		// round that really replaces the line still retires it.
		expect(result?.reflections.map((entry) => entry.content)).toEqual([
			"User prefers compact summaries.",
		]);
		expect(result?.supersededReflectionIds).toEqual([active.id]);
	});

	it("merges without observations and inherits the evidence of what it replaces", async () => {
		const first = reflection("cccccccccccc", ["dddddddddddd", "eeeeeeeeeeee"], {
			content: "User prefers terse updates.",
		});
		const second = reflection("ffffffffffff", ["aaaaaaaaaaaa"], {
			content: "User prefers no preamble.",
		});
		const merged = "User prefers terse updates and no preamble.";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				reflections: [{ content: merged, supersedes: [first.id, second.id] }],
			});
		});

		const result = await runReflector({
			...baseArgs,
			observations: [],
			reflections: [first, second],
			agentLoop: loop,
		});

		// The observation pool can be empty while the reflection pool still has to shrink — that is
		// exactly what the enforcer leaves behind — so a merge inherits the evidence it merged.
		expect(result?.reflections).toEqual([
			{
				id: hashId(merged),
				content: merged,
				supportingObservationIds: ["dddddddddddd", "eeeeeeeeeeee", "aaaaaaaaaaaa"],
				tokenCount: estimateStringTokens(merged),
			},
		]);
		expect(result?.supersededReflectionIds).toEqual([first.id, second.id]);
	});

	it("omits the budget line when the reflection share is unknown", () => {
		expect(
			reflectionBudgetLine({
				visibleReflections: 0,
				activeReflections: 0,
				activeReflectionTokens: 0,
				budgetTokens: undefined,
			}),
		).toBe("");
		expect(
			reflectionBudgetLine({
				visibleReflections: 0,
				activeReflections: 0,
				activeReflectionTokens: 0,
				budgetTokens: 100,
			}),
		).toBe(
			"REFLECTION BUDGET: active reflections ~0 tokens (0 total); the rendered memory leaves ~100 tokens for reflections.",
		);
	});

	it("tells the reflector when the reflection pool is over its budget", async () => {
		let userText = "";
		const loop = fakeAgentLoop((prompts) => {
			const content = prompts[0]?.content;
			userText = typeof content === "string" ? content : (content?.[0]?.text ?? "");
		});

		await runReflector({
			...baseArgs,
			reflections: [
				reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "x".repeat(400), tokenCount: 10 }),
			],
			// The view shows one of five reflections: the pool, not the view, decides.
			reflectionPool: { count: 5, tokens: 400 },
			reflectionBudgetTokens: 100,
			agentLoop: loop,
		});

		expect(userText).toContain("REFLECTION BUDGET: active reflections ~400 tokens (5 total");
		expect(userText).toContain("1 shown here, 4 not shown");
		expect(userText).toContain("leaves ~100 tokens for reflections");
		expect(userText).toContain("Over budget: merge near-duplicate reflections (supersedes)");
	});

	it("returns undefined when no tool call records reflections", async () => {
		const loop = fakeAgentLoop(() => {});
		await expect(runReflector({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("throws ReflectorStreamError on stream failure when no reflections were accepted", async () => {
		for (const stopReason of ["error", "aborted"]) {
			const loop = fakeAgentLoop(() => {}, [
				{
					type: "message_end",
					message: { role: "assistant", stopReason, errorMessage: "network failure" },
				},
			]);
			await expect(runReflector({ ...baseArgs, agentLoop: loop })).rejects.toThrow(
				/reflector stream ended with stopReason/,
			);
		}
	});
});
