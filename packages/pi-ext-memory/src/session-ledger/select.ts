import {
	coverageTierForObservation,
	type ReflectionCoverageTier,
	reflectionCoverageMap,
} from "../agents/dropper/coverage.js";
import { estimateStringTokens } from "../tokens.js";
import type { Projection } from "./projection.js";
import {
	observationToSummaryLine,
	reflectionToSummaryLine,
	summaryOverheadTokens,
} from "./render-summary.js";
import type { Observation, ObservationKind, Reflection, Relevance } from "./types.js";

/**
 * Bounds rendered memory to a token budget.
 *
 * Selection is deterministic and value-ordered: the lines a future run needs
 * most survive, the rest stay in the session ledger (and remain recallable by
 * id) without occupying the compaction summary. The rendered order is always
 * ledger order — trimming changes which lines are present, never their order.
 */

/**
 * Reflections recorded at the start of a session are orientation anchors
 * (project, goals, where the plan lives). They are kept ahead of the rest so
 * "newest first" trimming cannot erase the entry point of a long session.
 */
export const FOUNDATION_REFLECTIONS = 8;

const RELEVANCE_KEEP_RANK: Record<Relevance, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

/**
 * Coverage is redundancy, not value: an observation a reflection already
 * carries can be trimmed without losing the memory, so uncovered observations
 * are kept first. Mirror image of the dropper's drop rank.
 */
const COVERAGE_KEEP_RANK: Record<ReflectionCoverageTier, number> = {
	none: 0,
	partial: 1,
	strong: 2,
};

/** Mirror of the dropper's kind rank: durable kinds survive, narration goes first. */
const KIND_KEEP_RANK: Record<ObservationKind, number> = {
	decision: 0,
	user: 1,
	fact: 2,
	progress: 3,
};

export type VisibleMemoryOptions = {
	/** Token budget for the rendered memory. */
	maxTokens: number;
	/** Preferred share of the budget for observations (`observationsPoolTargetTokens`). */
	observationTargetTokens: number;
	/** Whether to prefer newest (default) or oldest observations when budget is tight. */
	observationsFrom?: "newest" | "oldest" | undefined;
};

export type VisibleMemory = {
	observations: Observation[];
	reflections: Reflection[];
	/** Tokens of the kept observation lines, metadata included. */
	observationTokens: number;
	/** Tokens of the kept reflection lines. */
	reflectionTokens: number;
	/**
	 * Tokens the budget leaves for reflections once observations take their
	 * share. The reflector reads it to decide whether to merge before it adds.
	 */
	reflectionBudgetTokens: number;
	trimmedObservations: number;
	trimmedReflections: number;
};

type TokenLines<T> = { items: T[]; tokens: number[]; total: number };

function measureLines<T>(items: T[], toLine: (item: T) => string): TokenLines<T> {
	// Count the line together with its separator: the render joins every line,
	// and only then is the accounted total a ceiling for the rendered one.
	const tokens = items.map((item) => estimateStringTokens(`${toLine(item)}\n`));
	return { items, tokens, total: tokens.reduce((sum, value) => sum + value, 0) };
}

function timestampRank(timestamp: string): number {
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * Keep-first order for observations: unique knowledge before redundant
 * knowledge, then durable kinds before narration, then relevance, then the most
 * recent line.
 */
function observationKeepOrder(
	observations: Observation[],
	reflections: Reflection[],
	from: "newest" | "oldest" = "newest",
): number[] {
	const coverageById = reflectionCoverageMap(observations, reflections);
	return observations
		.map((observation, index) => ({
			index,
			observation,
			coverage: coverageTierForObservation(observation, coverageById),
		}))
		.sort(
			(a, b) =>
				COVERAGE_KEEP_RANK[a.coverage] - COVERAGE_KEEP_RANK[b.coverage] ||
				KIND_KEEP_RANK[a.observation.kind] - KIND_KEEP_RANK[b.observation.kind] ||
				RELEVANCE_KEEP_RANK[a.observation.relevance] -
					RELEVANCE_KEEP_RANK[b.observation.relevance] ||
				(from === "oldest"
					? timestampRank(a.observation.timestamp) - timestampRank(b.observation.timestamp)
					: timestampRank(b.observation.timestamp) - timestampRank(a.observation.timestamp)) ||
				b.index - a.index,
		)
		.map((candidate) => candidate.index);
}

/** Keep-first order for reflections: the session's anchors, then the newest. */
function reflectionKeepOrder(reflections: Reflection[]): number[] {
	const indexes = reflections.map((_reflection, index) => index);
	return [
		...indexes.slice(0, FOUNDATION_REFLECTIONS),
		...indexes.slice(FOUNDATION_REFLECTIONS).reverse(),
	];
}

/**
 * Take lines in value order until the budget is spent. The first line that no
 * longer fits ends the scan: everything behind it ranks lower, so stopping
 * there keeps the result stable and monotone in the budget.
 */
function keepWithinBudget<T>(lines: TokenLines<T>, order: number[], budget: number): Set<number> {
	const kept = new Set<number>();
	let used = 0;
	for (const index of order) {
		const tokens = lines.tokens[index] ?? 0;
		if (used + tokens > budget) break;
		used += tokens;
		kept.add(index);
	}
	return kept;
}

function sumTokens<T>(lines: TokenLines<T>, kept: Set<number>): number {
	let total = 0;
	for (const index of kept) total += lines.tokens[index] ?? 0;
	return total;
}

export function selectVisibleMemory(
	memory: Projection,
	options: VisibleMemoryOptions,
): VisibleMemory {
	const observationLines = measureLines(memory.observations, observationToSummaryLine);
	const reflectionLines = measureLines(memory.reflections, reflectionToSummaryLine);
	const budget = Math.max(0, Math.floor(options.maxTokens) - summaryOverheadTokens());

	if (observationLines.total + reflectionLines.total <= budget) {
		return {
			observations: memory.observations,
			reflections: memory.reflections,
			observationTokens: observationLines.total,
			reflectionTokens: reflectionLines.total,
			reflectionBudgetTokens: Math.max(0, budget - observationLines.total),
			trimmedObservations: 0,
			trimmedReflections: 0,
		};
	}

	// Observations get their configured share, reflections take the rest of
	// theirs, and whichever section cannot fill its share hands the leftover back
	// to the other one — so a small observation target only costs the second
	// section room when reflections genuinely need it.
	let observationBudget = Math.min(
		observationLines.total,
		Math.max(0, options.observationTargetTokens),
		budget,
	);
	const reflectionBudget = Math.min(reflectionLines.total, budget - observationBudget);

	const keptReflectionIndexes = keepWithinBudget(
		reflectionLines,
		reflectionKeepOrder(memory.reflections),
		reflectionBudget,
	);
	const keptReflections = memory.reflections.filter((_reflection, index) =>
		keptReflectionIndexes.has(index),
	);
	// Hand back what reflections were allowed but did not use — an oversized reflection
	// that does not fit its share must not leave the rest of the budget idle.
	observationBudget = Math.min(
		observationLines.total,
		budget - sumTokens(reflectionLines, keptReflectionIndexes),
	);
	// Coverage is only redundancy if the reflection carrying it is rendered too:
	// a trimmed reflection cannot speak for the observation, so it must not mark
	// the observation as safe to trim.
	const keptObservationIndexes = keepWithinBudget(
		observationLines,
		observationKeepOrder(memory.observations, keptReflections, options.observationsFrom),
		observationBudget,
	);

	// …and the other way round: observations that cannot use their allowance leave room for
	// reflections the planned share had trimmed away. Only reflections can be added here, so the
	// observations already chosen are unaffected and the render still fits the budget.
	if (sumTokens(observationLines, keptObservationIndexes) < observationBudget) {
		const room = Math.max(0, budget - sumTokens(observationLines, keptObservationIndexes));
		for (const index of keepWithinBudget(
			reflectionLines,
			reflectionKeepOrder(memory.reflections),
			room,
		)) {
			keptReflectionIndexes.add(index);
		}
	}
	const observations = memory.observations.filter((_observation, index) =>
		keptObservationIndexes.has(index),
	);
	const keptReflectionsFinal = memory.reflections.filter((_reflection, index) =>
		keptReflectionIndexes.has(index),
	);

	return {
		observations,
		reflections: keptReflectionsFinal,
		observationTokens: sumTokens(observationLines, keptObservationIndexes),
		reflectionTokens: sumTokens(reflectionLines, keptReflectionIndexes),
		// The room reflections actually had: what observations did not render.
		reflectionBudgetTokens: Math.max(
			0,
			budget - sumTokens(observationLines, keptObservationIndexes),
		),
		trimmedObservations: observationLines.items.length - observations.length,
		trimmedReflections: reflectionLines.items.length - keptReflectionsFinal.length,
	};
}
