import { describe, expect, it } from "vitest";

import {
	type Observation,
	observationToSummaryLine,
	type Reflection,
	reflectionToSummaryLine,
	renderSummary,
	selectVisibleMemory,
	summaryOverheadTokens,
} from "../src/session-ledger/index.js";
import { estimateStringTokens } from "../src/tokens.js";
import { observation, reflection } from "./fixtures/session.js";

const OVERHEAD = summaryOverheadTokens();

/** Content long enough that every line is worth several tokens. */
function line(width = 40): string {
	return "z".repeat(width * 4);
}

/**
 * A line's cost as the selector accounts it. Budgets below are expressed as
 * multiples of this, so the tests stay about which lines survive rather than
 * about the current estimator's rounding.
 */
function obsLineTokens(entry: Observation): number {
	return estimateStringTokens(`${observationToSummaryLine(entry)}\n`);
}

function reflLineTokens(entry: Reflection): number {
	return estimateStringTokens(`${reflectionToSummaryLine(entry)}\n`);
}

describe("visible memory selection", () => {
	it("returns the memory unchanged when it fits the budget", () => {
		const memory = {
			observations: [observation("aaaaaaaaaaaa")],
			reflections: [reflection("eeeeeeeeeeee")],
		};

		const visible = selectVisibleMemory(memory, {
			maxTokens: OVERHEAD + 200,
			observationTargetTokens: 100,
		});

		expect(visible.observations).toBe(memory.observations);
		expect(visible.reflections).toBe(memory.reflections);
		expect(visible.trimmedObservations).toBe(0);
		expect(visible.trimmedReflections).toBe(0);
	});

	it("keeps uncovered observations ahead of ones a reflection already carries", () => {
		const covered = observation("aaaaaaaaaaaa", { content: line() });
		const partial = observation("bbbbbbbbbbbb", { content: line() });
		const uncovered = observation("cccccccccccc", { content: line() });
		const memory = {
			observations: [covered, partial, uncovered],
			reflections: [
				reflection("e00000000000", ["aaaaaaaaaaaa", "aaaaaaaaaaaa"]),
				reflection("e10000000000", ["aaaaaaaaaaaa"]),
				reflection("e20000000000", ["bbbbbbbbbbbb"]),
			],
		};

		const visible = selectVisibleMemory(memory, {
			maxTokens: OVERHEAD + obsLineTokens(covered) + 5,
			observationTargetTokens: 170,
		});

		expect(visible.observations.map((entry) => entry.id)).toEqual(["cccccccccccc"]);
		expect(visible.trimmedObservations).toBe(2);
	});

	it("keeps durable kinds ahead of progress narration", () => {
		const progress = observation("aaaaaaaaaaaa", { content: line(), kind: "progress" });
		const fact = observation("bbbbbbbbbbbb", { content: line(), kind: "fact" });
		const decision = observation("cccccccccccc", { content: line(), kind: "decision" });
		const secondFact = observation("dddddddddddd", { content: line(), kind: "fact" });

		const visible = selectVisibleMemory(
			{ observations: [progress, secondFact, fact, decision], reflections: [] },
			{
				// Sized on three lines, so the kind order decides which three survive and
				// the progress narration is the one trimmed out.
				maxTokens: OVERHEAD + obsLineTokens(decision) * 3,
				observationTargetTokens: 300,
			},
		);

		expect(visible.trimmedObservations).toBe(1);
		expect(visible.observations.map((entry) => entry.id)).toEqual([
			"dddddddddddd",
			"bbbbbbbbbbbb",
			"cccccccccccc",
		]);
	});

	it("lets reflection coverage outrank kind", () => {
		// The same kind and relevance; one line is already carried by a reflection, so
		// it is the redundant one and goes first.
		const covered = observation("aaaaaaaaaaaa", { content: line(), kind: "decision" });
		const uncovered = observation("bbbbbbbbbbbb", { content: line(), kind: "decision" });

		const visible = selectVisibleMemory(
			{
				observations: [covered, uncovered],
				reflections: [reflection("e00000000000", ["aaaaaaaaaaaa", "aaaaaaaaaaaa"])],
			},
			{ maxTokens: OVERHEAD + obsLineTokens(covered), observationTargetTokens: 300 },
		);

		expect(visible.observations.map((entry) => entry.id)).toEqual(["bbbbbbbbbbbb"]);
	});

	it("hands budget a reflection could not use back to the observations it crowded out", () => {
		// The only reflection is larger than its share, so it is dropped whole. The room
		// it was promised must not sit idle while observations are being trimmed.
		const bigReflection = reflection("e00000000000", ["aaaaaaaaaaaa"], { content: line(500) });
		const observations = Array.from({ length: 20 }, (_value, index) =>
			observation(`a${index}`.padStart(12, "0"), { content: line() }),
		);
		// A budget that cannot hold the reflection at all, so its whole promise is free.
		const budget = reflLineTokens(bigReflection) - 20;

		const visible = selectVisibleMemory(
			{ observations, reflections: [bigReflection] },
			{ maxTokens: OVERHEAD + budget, observationTargetTokens: 40 },
		);

		expect(visible.reflections).toEqual([]);
		// Observations use everything reflections left behind, not just their target.
		expect(visible.observationTokens).toBeGreaterThan(40);
		expect(visible.observationTokens).toBeLessThanOrEqual(budget);
	});

	it("gives budget observations could not use back to the reflections", () => {
		const reflections = ["e00000000000", "e00000000001"].map((id) =>
			reflection(id, ["0000000000a0"], { content: line() }),
		);
		const reflectionCost = reflections.reduce((total, entry) => total + reflLineTokens(entry), 0);
		// One observation too big for the room the reflections leave, so its allowance goes unused:
		// the planned reflection share is a single token, which fits no line at all.
		const big = observation("aaaaaaaaaaaa", { content: line(200) });
		const budget = reflectionCost + 10;

		const visible = selectVisibleMemory(
			{ observations: [big], reflections },
			{ maxTokens: OVERHEAD + budget, observationTargetTokens: budget - 1 },
		);

		expect(obsLineTokens(big)).toBeGreaterThan(budget);
		expect(visible.observations).toEqual([]);
		// Room the observation could not use is what the trimmed reflections come back into.
		expect(visible.trimmedReflections).toBe(0);
		expect(visible.reflectionTokens).toBe(reflectionCost);
		expect(visible.reflectionBudgetTokens).toBe(budget);
	});

	it("renders observations in the order the preamble promises", () => {
		const late = observation("aaaaaaaaaaaa", { timestamp: "2026-05-02 12:00" });
		const early = observation("bbbbbbbbbbbb", { timestamp: "2026-05-02 09:00" });
		// Same minute as `early`, so ledger order decides between them.
		const tie = observation("cccccccccccc", { timestamp: "2026-05-02 09:00" });

		const summary = renderSummary([], [late, early, tie]);

		const order = [early.id, tie.id, late.id];
		const positions = order.map((id) => summary.indexOf(id));
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		expect(positions.every((position) => position >= 0)).toBe(true);
	});

	it("reports the room the budget leaves for reflections", () => {
		const roomy = selectVisibleMemory(
			{ observations: [], reflections: [reflection("e00000000000", ["aaaaaaaaaaaa"])] },
			{ maxTokens: OVERHEAD + 100, observationTargetTokens: 50 },
		);
		expect(roomy.reflectionBudgetTokens).toBe(100);

		const crowded = selectVisibleMemory(
			{
				observations: [observation("aaaaaaaaaaaa", { content: line() })],
				reflections: [reflection("e00000000000", ["aaaaaaaaaaaa"], { content: line() })],
			},
			{ maxTokens: OVERHEAD + 100, observationTargetTokens: 30 },
		);
		// Observations take their configured 30-token share first; the rest is the
		// reflection share even when reflections cannot fill it.
		expect(crowded.observationTokens + crowded.reflectionBudgetTokens).toBeLessThanOrEqual(100);
	});

	it("only counts reflections that survive the trim as coverage", () => {
		// The observation is critical and cited by a reflection, but the reflection has
		// no room in the render: it cannot make the observation redundant, so relevance
		// decides and the critical line stays.
		const covered = observation("aaaaaaaaaaaa", { content: line(), relevance: "critical" });
		const uncovered = observation("bbbbbbbbbbbb", { content: line(), relevance: "low" });
		const citing = reflection("e00000000000", ["aaaaaaaaaaaa", "aaaaaaaaaaaa"]);

		const visible = selectVisibleMemory(
			{ observations: [uncovered, covered], reflections: [citing] },
			{
				// One observation line and no reflection room: the reflection budget is
				// what is left of the total after the observation share.
				maxTokens: OVERHEAD + obsLineTokens(covered) + 1,
				observationTargetTokens: 400,
			},
		);

		expect(visible.reflections).toEqual([]);
		expect(visible.trimmedReflections).toBe(1);
		expect(visible.observations.map((entry) => entry.id)).toEqual(["aaaaaaaaaaaa"]);
	});

	it("keeps higher relevance ahead of lower relevance", () => {
		const low = observation("aaaaaaaaaaaa", { content: line(), relevance: "low" });
		const critical = observation("bbbbbbbbbbbb", { content: line(), relevance: "critical" });
		const high = observation("cccccccccccc", { content: line(), relevance: "high" });

		const visible = selectVisibleMemory(
			{ observations: [low, critical, high], reflections: [] },
			{
				// Sized on the longest line, so relevance alone decides.
				maxTokens: OVERHEAD + obsLineTokens(critical),
				observationTargetTokens: 200,
			},
		);

		expect(visible.observations.map((entry) => entry.id)).toEqual(["bbbbbbbbbbbb"]);
	});

	it("keeps the newest observation among equally valuable ones", () => {
		const older = observation("aaaaaaaaaaaa", {
			content: line(),
			timestamp: "2026-05-01T10:00:00.000Z",
		});
		const newest = observation("bbbbbbbbbbbb", {
			content: line(),
			timestamp: "2026-05-03T10:00:00.000Z",
		});
		const middle = observation("cccccccccccc", {
			content: line(),
			timestamp: "2026-05-02T10:00:00.000Z",
		});

		const visible = selectVisibleMemory(
			{ observations: [older, newest, middle], reflections: [] },
			{ maxTokens: OVERHEAD + obsLineTokens(older), observationTargetTokens: 200 },
		);

		expect(visible.observations.map((entry) => entry.id)).toEqual(["bbbbbbbbbbbb"]);
	});

	it("keeps ledger order in the result even when selection ran on values", () => {
		const low = observation("aaaaaaaaaaaa", { content: line(), relevance: "low" });
		const critical = observation("bbbbbbbbbbbb", { content: line(), relevance: "critical" });
		const high = observation("cccccccccccc", { content: line(), relevance: "high" });

		const visible = selectVisibleMemory(
			{ observations: [low, critical, high], reflections: [] },
			{
				maxTokens: OVERHEAD + 2 * obsLineTokens(low) + 5,
				observationTargetTokens: 200,
			},
		);

		expect(visible.observations.map((entry) => entry.id)).toEqual(["bbbbbbbbbbbb", "cccccccccccc"]);
	});

	it("keeps the session's first reflections as anchors, then the newest", () => {
		const reflections = Array.from({ length: 12 }, (_value, index) =>
			reflection(`e${index}`.padEnd(12, "0"), ["aaaaaaaaaaaa"], { content: line() }),
		);

		const visible = selectVisibleMemory(
			{ observations: [], reflections },
			{
				maxTokens: OVERHEAD + 10 * reflLineTokens(reflections[0] as Reflection) + 5,
				observationTargetTokens: 0,
			},
		);

		// The eight anchors survive ahead of the newest two; the reflections in
		// between are the ones that fall out.
		expect(visible.reflections.map((entry) => entry.id)).toEqual([
			"e00000000000",
			"e10000000000",
			"e20000000000",
			"e30000000000",
			"e40000000000",
			"e50000000000",
			"e60000000000",
			"e70000000000",
			"e10000000000",
			"e11000000000",
		]);
		expect(visible.trimmedReflections).toBe(2);
	});

	it("gives budget observations cannot use to reflections", () => {
		const single = observation("aaaaaaaaaaaa", { content: line(20) });
		const reflections = Array.from({ length: 6 }, (_value, index) =>
			reflection(`e${index}`.padEnd(12, "0"), ["aaaaaaaaaaaa"], { content: line() }),
		);

		const visible = selectVisibleMemory(
			{ observations: [single], reflections },
			{
				maxTokens:
					OVERHEAD + obsLineTokens(single) + 4 * reflLineTokens(reflections[0] as Reflection) + 5,
				observationTargetTokens: 3 * obsLineTokens(single),
			},
		);

		expect(visible.observations.map((entry) => entry.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(visible.reflections).toHaveLength(4);
		expect(visible.trimmedReflections).toBe(2);
	});

	it("keeps nothing when the budget cannot even hold the summary preamble", () => {
		const memory = {
			observations: [observation("aaaaaaaaaaaa", { content: line() })],
			reflections: [reflection("e00000000000", ["aaaaaaaaaaaa"], { content: line() })],
		};

		const visible = selectVisibleMemory(memory, {
			maxTokens: OVERHEAD - 10,
			observationTargetTokens: 100,
		});

		expect(visible.observations).toEqual([]);
		expect(visible.reflections).toEqual([]);
		expect(visible.trimmedObservations).toBe(1);
		expect(visible.trimmedReflections).toBe(1);
	});

	it("grows monotonically with the budget and never renders over it", () => {
		const observations = Array.from({ length: 8 }, (_value, index) =>
			observation(`a${index}`.padStart(12, "0"), { content: line() }),
		);
		const reflections = Array.from({ length: 4 }, (_value, index) =>
			reflection(`e${index}`.padEnd(12, "0"), ["a00000000000"], { content: line() }),
		);
		const memory = { observations, reflections };

		let previous = new Set<string>();
		for (const extra of [60, 150, 300, 600, 1_200]) {
			const budget = OVERHEAD + extra;
			const visible = selectVisibleMemory(memory, {
				maxTokens: budget,
				observationTargetTokens: Math.floor(extra / 2),
			});
			const kept = new Set([
				...visible.observations.map((entry) => entry.id),
				...visible.reflections.map((entry) => entry.id),
			]);

			for (const id of previous) expect(kept.has(id)).toBe(true);
			previous = kept;
			expect(
				estimateStringTokens(renderSummary(visible.reflections, visible.observations)),
			).toBeLessThanOrEqual(budget);
		}

		expect(previous.size).toBe(12);
	});

	it("prefers oldest observations when observationsFrom is 'oldest'", () => {
		const oldObs = observation("aaaaaaaaaaaa", {
			content: line(),
			timestamp: "2026-01-01T00:00:00.000Z",
		});
		const newObs = observation("bbbbbbbbbbbb", {
			content: line(),
			timestamp: "2026-06-01T00:00:00.000Z",
		});
		const memory = { observations: [oldObs, newObs], reflections: [] };

		const visibleOld = selectVisibleMemory(memory, {
			maxTokens: OVERHEAD + obsLineTokens(oldObs) + 5,
			observationTargetTokens: 1000,
			observationsFrom: "oldest",
		});
		expect(visibleOld.observations.map((o) => o.id)).toEqual(["aaaaaaaaaaaa"]);

		const visibleNew = selectVisibleMemory(memory, {
			maxTokens: OVERHEAD + obsLineTokens(newObs) + 5,
			observationTargetTokens: 1000,
		});
		expect(visibleNew.observations.map((o) => o.id)).toEqual(["bbbbbbbbbbbb"]);
	});
});
