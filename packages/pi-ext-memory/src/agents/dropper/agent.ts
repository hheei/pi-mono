import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { debugLog } from "../../debug-log.js";
import {
	OBSERVATION_KIND_DROP_RANK,
	type Observation,
	type Reflection,
	reflectionToSummaryLine,
} from "../../session-ledger/index.js";
import { runWorkerAgent, type WorkerLoopArgs } from "../run-agent.js";
import {
	coverageTierForObservation,
	observationToDropperLine,
	REFLECTION_COVERAGE_DROP_RANK,
	reflectionCoverageMap,
	summarizeCoverageByRelevance,
	summarizeCoverageByRelevanceForIds,
} from "./coverage.js";
import { observationPoolFullness, observationPoolMetrics } from "./pool.js";
import { DROPPER_SYSTEM } from "./prompts.js";

export type {
	CoverageSummaryByRelevance,
	CoverageTransitionSummaryByRelevance,
	ReflectionCoverageTier,
} from "./coverage.js";
export {
	coverageTierForObservation,
	emptyCoverageSummaryByRelevance,
	observationToDropperLine,
	REFLECTION_COVERAGE_TIERS,
	reflectionCoverageMap,
	reflectionCoverageTierForCount,
	reflectionSupportCounts,
	summarizeCoverageByRelevance,
	summarizeCoverageByRelevanceForIds,
	summarizeCoverageTransitionsByRelevance,
} from "./coverage.js";
export type { ObservationPoolMetrics } from "./pool.js";
export {
	maxDropCountForPool,
	observationPoolFullness,
	observationPoolMetrics,
} from "./pool.js";

export class DropperStreamError extends Error {
	readonly stopReason: string;
	constructor(stopReason: string, errorMessage?: string) {
		super(
			`dropper stream ended with stopReason "${stopReason}"${errorMessage ? `: ${errorMessage}` : ""}`,
		);
		this.name = "DropperStreamError";
		this.stopReason = stopReason;
	}
}

import { textToolResult } from "@hheei/pi-ext-core";

interface RunDropperArgs extends WorkerLoopArgs {
	reflections: Reflection[];
	observations: Observation[];
	targetTokens: number;
	/**
	 * Tokens of the real active pool when `observations` is a bounded view of it.
	 * The agent can only propose lines it was shown, but it has to be told how far
	 * the pool it belongs to is over target.
	 */
	activePoolTokens?: number | undefined;
}

const RELEVANCE_DROP_RANK: Record<Observation["relevance"], number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

const DropObservationsSchema = Type.Object({
	ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	reason: Type.Optional(Type.String()),
});

type DropObservationsArgs = Static<typeof DropObservationsSchema>;

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

function relevanceCounts(
	observations: readonly Observation[],
): Record<Observation["relevance"], number> {
	return observations.reduce<Record<Observation["relevance"], number>>(
		(counts, observation) => {
			counts[observation.relevance]++;
			return counts;
		},
		{ low: 0, medium: 0, high: 0, critical: 0 },
	);
}

export function normalizeDropObservationIds(
	ids: readonly string[] | undefined,
	observations: readonly Observation[],
): string[] | undefined {
	if (!ids || ids.length === 0) return undefined;
	const allowed = new Map(observations.map((observation) => [observation.id, observation]));
	const result: string[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		const observation = allowed.get(id);
		if (!observation) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result.length > 0 ? result : undefined;
}

function timestampRank(timestamp: string): number {
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * Deterministic drop order for a set of proposed ids: least valuable first.
 *
 * Shared by the dropper (which proposes) and the enforcer (which decides on its
 * own). Ordering is kind, then reflection coverage, then relevance, then age,
 * then the order the ids were proposed in, so the result is stable.
 */
export function selectDropCandidates(
	ids: readonly string[],
	observations: readonly Observation[],
	maxDrops: number,
	reflections: readonly Reflection[] = [],
): string[] {
	if (maxDrops <= 0 || ids.length === 0) return [];

	const byId = new Map(observations.map((observation) => [observation.id, observation]));
	const coverageById = reflectionCoverageMap(observations, reflections);
	const firstProposalIndex = new Map<string, number>();
	for (const [i, id] of ids.entries()) {
		if (!firstProposalIndex.has(id)) firstProposalIndex.set(id, i);
	}

	return Array.from(firstProposalIndex.entries())
		.map(([id, index]) => ({ id, index, observation: byId.get(id) }))
		.filter(
			(candidate): candidate is { id: string; index: number; observation: Observation } =>
				candidate.observation !== undefined,
		)
		.sort((a, b) => {
			// Kind first: process narration is the cheapest thing to lose, and it is
			// the one judgement the model does not have to make.
			const kindDelta =
				OBSERVATION_KIND_DROP_RANK[a.observation.kind] -
				OBSERVATION_KIND_DROP_RANK[b.observation.kind];
			const coverageDelta =
				REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(a.observation, coverageById)] -
				REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(b.observation, coverageById)];
			const relevanceDelta =
				RELEVANCE_DROP_RANK[a.observation.relevance] - RELEVANCE_DROP_RANK[b.observation.relevance];
			const ageDelta =
				timestampRank(a.observation.timestamp) - timestampRank(b.observation.timestamp);
			return kindDelta || coverageDelta || relevanceDelta || ageDelta || a.index - b.index;
		})
		.slice(0, maxDrops)
		.map((candidate) => candidate.id);
}

export async function runDropper(args: RunDropperArgs): Promise<string[] | undefined> {
	const { reflections, observations, targetTokens } = args;
	if (observations.length === 0) return undefined;

	const metrics = observationPoolMetrics(observations, targetTokens);
	const observationTokens = args.activePoolTokens ?? metrics.observationTokens;
	const fullness = observationPoolFullness(observationTokens, targetTokens);
	const tokensOverTarget = Math.max(0, observationTokens - targetTokens);
	// Sized from the real excess against the average size of the lines the agent can
	// see, and capped by how many of them there are: dropping the visible lines has to
	// be enough to matter, and the agent cannot propose ids it was not shown.
	const averageLineTokens = metrics.observationTokens / observations.length;
	const maxDropsAllowed =
		tokensOverTarget <= 0 || averageLineTokens <= 0
			? 0
			: Math.min(observations.length, Math.max(1, Math.ceil(tokensOverTarget / averageLineTokens)));
	const coverageById = reflectionCoverageMap(observations, reflections);
	const coverageSummaryByRelevance = summarizeCoverageByRelevance(observations, coverageById);
	debugLog("dropper.agent_start", {
		activeObservationCount: observations.length,
		reflectionCount: reflections.length,
		observationTokens,
		targetTokens,
		tokensOverTarget,
		fullness,
		maxDropsAllowed,
		relevanceCounts: relevanceCounts(observations),
		coverageSummaryByRelevance,
	});
	if (maxDropsAllowed <= 0) {
		debugLog("dropper.result", {
			reason: "not_over_target",
			toolCallCount: 0,
			rawRequestedIdsCount: 0,
			acceptedCandidateCount: 0,
			selectedDropsCount: 0,
			selectedDropTokens: 0,
			selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds(
				[],
				observations,
				coverageById,
			),
			maxDropsAllowed,
		});
		return undefined;
	}

	const proposedDropIds: string[] = [];
	const proposed = new Set<string>();
	const allowed = new Map(observations.map((observation) => [observation.id, observation]));
	let toolCallCount = 0;
	let rawRequestedIdsCount = 0;
	let missingIdsCount = 0;
	let criticalCandidateIdsCount = 0;
	let duplicateInRequestCount = 0;
	let duplicateInRunCount = 0;

	const dropObservations: AgentTool<typeof DropObservationsSchema> = {
		name: "drop_observations",
		label: "Drop observations",
		description: "Propose active observation ids that are safe to remove from compacted memory.",
		parameters: DropObservationsSchema,
		execute: async (_id, params: DropObservationsArgs) => {
			toolCallCount++;
			rawRequestedIdsCount += params.ids.length;
			const seenInRequest = new Set<string>();
			let added = 0;
			let requestMissingIds = 0;
			let requestCriticalCandidateIds = 0;
			let requestDuplicateIds = 0;
			let requestDuplicateInRunIds = 0;
			for (const id of params.ids) {
				const observation = allowed.get(id);
				if (!observation) {
					missingIdsCount++;
					requestMissingIds++;
					continue;
				}
				if (seenInRequest.has(id)) {
					duplicateInRequestCount++;
					requestDuplicateIds++;
					continue;
				}
				seenInRequest.add(id);
				if (proposed.has(id)) {
					duplicateInRunCount++;
					requestDuplicateInRunIds++;
					continue;
				}
				proposed.add(id);
				proposedDropIds.push(id);
				if (observation.relevance === "critical") {
					criticalCandidateIdsCount++;
					requestCriticalCandidateIds++;
				}
				added++;
			}
			debugLog("dropper.tool_call", {
				toolCallCount,
				rawRequestedIdsCount: params.ids.length,
				acceptedIdsCount: added,
				missingIdsCount: requestMissingIds,
				criticalCandidateIdsCount: requestCriticalCandidateIds,
				duplicateInRequestCount: requestDuplicateIds,
				duplicateInRunCount: requestDuplicateInRunIds,
				totalCandidates: proposedDropIds.length,
				maxDropsAllowed,
			});
			return textToolResult(
				`Queued ${added} drop candidate${added === 1 ? "" : "s"}. Candidates this run: ${proposedDropIds.length}. Maximum drops allowed: ${maxDropsAllowed}.`,
				{ added, totalCandidates: proposedDropIds.length, maxDropsAllowed },
			);
		},
	};

	const fullnessPercent = Math.round(fullness * 100);
	const userText = `CURRENT REFLECTIONS:\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\nCURRENT OBSERVATIONS:\n${joinOrEmpty(observations.map((observation) => observationToDropperLine(observation, coverageTierForObservation(observation, coverageById))))}\n\nActive observation pool: ~${observationTokens.toLocaleString()} tokens; target: ~${targetTokens.toLocaleString()} tokens; fullness against target: ~${fullnessPercent.toLocaleString()}%; over target by ~${tokensOverTarget.toLocaleString()} tokens.\nMaximum drops allowed this run: ${maxDropsAllowed.toLocaleString()} observation${maxDropsAllowed === 1 ? "" : "s"}. This maximum is sized to move the active pool toward the target if every proposed drop is clearly safe.\nThis maximum is a hard upper bound, not a target. Drop fewer or none if fewer observations are clearly safe.`;
	const prompts: Message[] = [
		{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() },
	];
	const context: AgentContext = {
		messages: [{ role: "system", content: DROPPER_SYSTEM, timestamp: Date.now() }],
		tools: [dropObservations as unknown as AgentTool],
	};
	const streamError = await runWorkerAgent("dropper", args, prompts, context);
	const droppedIds = selectDropCandidates(
		proposedDropIds,
		observations,
		maxDropsAllowed,
		reflections,
	);
	const reason =
		droppedIds.length > 0
			? "selected_nonempty"
			: toolCallCount === 0
				? "no_tool_call"
				: proposedDropIds.length === 0
					? "all_filtered"
					: "selected_empty";
	const selectedDropTokens = droppedIds.reduce(
		(sum, id) => sum + (allowed.get(id)?.tokenCount ?? 0),
		0,
	);
	debugLog("dropper.result", {
		reason,
		toolCallCount,
		rawRequestedIdsCount,
		missingIdsCount,
		criticalCandidateIdsCount,
		duplicateInRequestCount,
		duplicateInRunCount,
		acceptedCandidateCount: proposedDropIds.length,
		selectedDropsCount: droppedIds.length,
		selectedDropTokens,
		selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds(
			droppedIds,
			observations,
			coverageById,
		),
		maxDropsAllowed,
	});
	if (droppedIds.length === 0 && streamError !== undefined) {
		throw new DropperStreamError(streamError.stopReason, streamError.errorMessage);
	}
	return droppedIds.length > 0 ? droppedIds : undefined;
}
