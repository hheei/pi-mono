import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { textToolResult } from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { debugLog } from "../../debug-log.js";
import { hashId } from "../../ids.js";
import { truncateRecordContent } from "../../serialize.js";
import {
	type Observation,
	type Reflection,
	reflectionToSummaryLine,
} from "../../session-ledger/index.js";
import { estimateStringTokens, reflectionLineTokenCount } from "../../tokens.js";
import {
	coverageTierForObservation,
	type ReflectionCoverageTier,
	reflectionCoverageMap,
	summarizeCoverageByRelevance,
	summarizeCoverageTransitionsByRelevance,
} from "../dropper/coverage.js";
import { runWorkerAgent, type WorkerLoopArgs } from "../run-agent.js";
import { REFLECTOR_SYSTEM } from "./prompts.js";

export class ReflectorStreamError extends Error {
	readonly stopReason: string;
	constructor(stopReason: string, errorMessage?: string) {
		super(
			`reflector stream ended with stopReason "${stopReason}"${errorMessage ? `: ${errorMessage}` : ""}`,
		);
		this.name = "ReflectorStreamError";
		this.stopReason = stopReason;
	}
}

interface RunReflectorArgs extends WorkerLoopArgs {
	reflections: Reflection[];
	observations: Observation[];
	/**
	 * Reflection ids retired earlier in this ledger. Their tombstones are permanent, so a proposal
	 * that restates one can never become active and must not retire anything.
	 */
	droppedReflectionIds: ReadonlySet<string>;
	/** Tokens the rendered memory budget leaves for reflections, when known. */
	reflectionBudgetTokens?: number;
	/**
	 * The real active reflection pool, which is larger than {@link reflections} when
	 * the view trims: the merge decision has to be about the pool, not the view.
	 */
	reflectionPool?: { count: number; tokens: number };
}

export type ReflectorResult = {
	/** New reflections accepted this run, in the order they were recorded. */
	reflections: Reflection[];
	/** Active reflections those reflections replace (merged or upgraded). */
	supersededReflectionIds: string[];
};

const RecordReflectionsSchema = Type.Object({
	reflections: Type.Array(
		Type.Object({
			content: Type.String({ minLength: 1 }),
			// Required for a reflection that derives new meaning. A pure merge may omit it and inherits
			// the evidence of the reflections it replaces, which is what keeps the reflection pool
			// shrinkable when the observation pool has already been reclaimed.
			supportingObservationIds: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description:
						"Ids of the current observations this reflection preserves. Omit only for a merge that derives nothing new.",
				}),
			),
			supersedes: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description:
						"Ids of current reflections this reflection merges or upgrades. They leave active memory but stay in the ledger. Only list reflections this proposal preserves the meaning of.",
				}),
			),
		}),
		{ minItems: 1 },
	),
});

type RecordReflectionsArgs = Static<typeof RecordReflectionsSchema>;

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export function observationToReflectorLine(
	observation: Observation,
	coverage: ReflectionCoverageTier,
): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`;
}

export function summarizeSupportIdCounts(reflections: readonly Reflection[]): {
	reflectionCount: number;
	totalSupportIds: number;
	minSupportIds: number;
	maxSupportIds: number;
	averageSupportIds: number;
	histogram: Record<string, number>;
} {
	if (reflections.length === 0) {
		return {
			reflectionCount: 0,
			totalSupportIds: 0,
			minSupportIds: 0,
			maxSupportIds: 0,
			averageSupportIds: 0,
			histogram: {},
		};
	}
	const counts = reflections.map((reflection) => reflection.supportingObservationIds.length);
	const totalSupportIds = counts.reduce((sum, count) => sum + count, 0);
	const histogram: Record<string, number> = {};
	for (const count of counts) histogram[String(count)] = (histogram[String(count)] ?? 0) + 1;
	return {
		reflectionCount: reflections.length,
		totalSupportIds,
		minSupportIds: Math.min(...counts),
		maxSupportIds: Math.max(...counts),
		averageSupportIds: totalSupportIds / reflections.length,
		histogram,
	};
}

export function normalizeSupportingObservationIds(
	supportingObservationIds: readonly string[] | undefined,
	allowedObservationIds: readonly string[],
): string[] | undefined {
	if (!supportingObservationIds || supportingObservationIds.length === 0) return undefined;
	const allowedOrder = new Map<string, number>();
	for (const [i, id] of allowedObservationIds.entries()) {
		if (!allowedOrder.has(id)) allowedOrder.set(id, i);
	}

	const seen = new Set<string>();
	for (const id of supportingObservationIds) {
		if (!allowedOrder.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

/**
 * Reflection ids a proposal replaces, restricted to reflections the reflector
 * could actually see. An unknown id is dropped rather than failing the whole
 * reflection: superseding is a follow-up cleanup, and a stale id must never
 * cost the memory the proposal carries.
 */
export function normalizeSupersededReflectionIds(
	supersedes: readonly string[] | undefined,
	allowedReflectionIds: readonly string[],
): string[] {
	if (!supersedes || supersedes.length === 0) return [];
	const allowed = new Set(allowedReflectionIds);
	const accepted = new Set<string>();
	for (const id of supersedes) {
		if (allowed.has(id)) accepted.add(id);
	}
	return [...accepted];
}

/** What the reflector sees when it decides whether to merge before it adds. */
export function reflectionBudgetLine(args: {
	visibleReflections: number;
	activeReflections: number;
	activeReflectionTokens: number;
	budgetTokens: number | undefined;
}): string {
	if (args.budgetTokens === undefined) return "";
	const hidden = Math.max(0, args.activeReflections - args.visibleReflections);
	const shown = hidden > 0 ? ` — ${args.visibleReflections} shown here, ${hidden} not shown` : "";
	const over = args.activeReflectionTokens > args.budgetTokens;
	return `REFLECTION BUDGET: active reflections ~${args.activeReflectionTokens} tokens (${args.activeReflections} total${shown}); the rendered memory leaves ~${args.budgetTokens} tokens for reflections.${over ? " Over budget: merge near-duplicate reflections (supersedes) before adding new ones." : ""}`;
}

function normalizeReflectionContent(content: string): string | undefined {
	const normalized = truncateRecordContent(content.trim());
	if (!normalized || /\r|\n/.test(normalized)) return undefined;
	return normalized;
}

/**
 * The evidence a merge inherits from the reflections it replaces: their own supporting ids, as they
 * were recorded. Some of them may name observations that have since been dropped, and that is the
 * point — the ids are provenance rather than a claim about the active pool, and refusing them would
 * make a merge impossible exactly when the observation pool has been reclaimed while the reflection
 * pool still needs to shrink.
 */
function inheritedSupportingObservationIds(
	supersedes: readonly string[],
	reflections: readonly Reflection[],
): string[] | undefined {
	if (supersedes.length === 0) return undefined;
	const byId = new Map(reflections.map((reflection) => [reflection.id, reflection]));
	const inherited: string[] = [];
	const seen = new Set<string>();
	for (const reflectionId of supersedes) {
		for (const id of byId.get(reflectionId)?.supportingObservationIds ?? []) {
			if (seen.has(id)) continue;
			seen.add(id);
			inherited.push(id);
		}
	}
	return inherited.length > 0 ? inherited : undefined;
}

export async function runReflector(args: RunReflectorArgs): Promise<ReflectorResult | undefined> {
	const { reflections, observations } = args;
	// Merging is the one thing a reflector can do without observations, and it is also the only thing
	// that shrinks the reflection pool: the enforcer can reclaim every observation while reflections
	// alone still fill the budget.
	if (observations.length === 0 && reflections.length === 0) return undefined;

	const coverageById = reflectionCoverageMap(observations, reflections);
	debugLog("reflector.agent_start", {
		activeObservationCount: observations.length,
		reflectionCount: reflections.length,
		coverageSummaryByRelevance: summarizeCoverageByRelevance(observations, coverageById),
	});

	const allowedObservationIds = observations.map((observation) => observation.id);
	const allowedReflectionIds = reflections.map((reflection) => reflection.id);
	const existingReflectionIds = new Set(reflections.map((reflection) => reflection.id));
	const accumulated = new Map<string, Reflection>();
	// A reflection may only leave active memory next to its replacement, so ids
	// proposed as replacements are never tombstoned.
	const replacementIds = new Set<string>();
	const supersedeCandidates = new Set<string>();
	const resurrectedIds = new Set<string>();
	let toolCallCount = 0;
	let rawProposedReflectionCount = 0;
	let acceptedReflectionCount = 0;
	let duplicateReflectionCount = 0;
	let rejectedReflectionCount = 0;

	const recordReflections: AgentTool<typeof RecordReflectionsSchema> = {
		name: "record_reflections",
		label: "Record reflections",
		description: "Record new durable reflections with supporting observation ids.",
		parameters: RecordReflectionsSchema,
		execute: async (_id, params: RecordReflectionsArgs) => {
			toolCallCount++;
			rawProposedReflectionCount += params.reflections.length;
			let added = 0;
			let duplicates = 0;
			let rejected = 0;
			for (const proposal of params.reflections) {
				const content = normalizeReflectionContent(proposal.content);
				if (!content) {
					rejected++;
					continue;
				}
				const supersedes = normalizeSupersededReflectionIds(
					proposal.supersedes,
					allowedReflectionIds,
				);
				const id = hashId(content);
				if (args.droppedReflectionIds.has(id)) {
					// Retired ids never come back, so this proposal stands in for nothing and retires
					// nothing. Only this proposal is refused: another merge in the same round is unaffected.
					resurrectedIds.add(id);
					rejected++;
					continue;
				}
				const supportingObservationIds =
					normalizeSupportingObservationIds(
						proposal.supportingObservationIds,
						allowedObservationIds,
					) ?? inheritedSupportingObservationIds(supersedes, reflections);
				if (!supportingObservationIds) {
					rejected++;
					continue;
				}
				if (existingReflectionIds.has(id) || accumulated.has(id)) {
					// Already recorded, so nothing new lands — but it still stands as the
					// replacement for whatever it merges, which is how merging into an
					// existing wording works.
					duplicates++;
					for (const reflectionId of supersedes) supersedeCandidates.add(reflectionId);
					replacementIds.add(id);
					continue;
				}
				accumulated.set(id, {
					id,
					content,
					supportingObservationIds,
					tokenCount: estimateStringTokens(content),
				});
				for (const reflectionId of supersedes) supersedeCandidates.add(reflectionId);
				replacementIds.add(id);
				added++;
			}
			acceptedReflectionCount += added;
			duplicateReflectionCount += duplicates;
			rejectedReflectionCount += rejected;
			return textToolResult(
				`Recorded ${added} reflection${added === 1 ? "" : "s"}; ${duplicates} duplicate${duplicates === 1 ? "" : "s"}; ${rejected} rejected. Total this run: ${accumulated.size}.`,
				{ added, duplicates, rejected, total: accumulated.size },
			);
		},
	};

	const budgetLine = reflectionBudgetLine({
		visibleReflections: reflections.length,
		activeReflections: args.reflectionPool?.count ?? reflections.length,
		activeReflectionTokens:
			args.reflectionPool?.tokens ??
			reflections.reduce((total, reflection) => total + reflectionLineTokenCount(reflection), 0),
		budgetTokens: args.reflectionBudgetTokens,
	});
	const userText = `CURRENT REFLECTIONS (id — content):\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\n${budgetLine ? `${budgetLine}\n\n` : ""}CURRENT OBSERVATIONS:\n${joinOrEmpty(observations.map((observation) => observationToReflectorLine(observation, coverageTierForObservation(observation, coverageById))))}\n\nCrystallize any missing durable facts or patterns into new reflections, merging near-duplicates with supersedes when the reflection pool needs to shrink. If nothing is stable enough, do not call the tool.`;
	const prompts: Message[] = [
		{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() },
	];
	const context: AgentContext = {
		messages: [{ role: "system", content: REFLECTOR_SYSTEM, timestamp: Date.now() }],
		tools: [recordReflections as unknown as AgentTool],
	};
	const streamError = await runWorkerAgent("reflector", args, prompts, context);
	if (resurrectedIds.size > 0) {
		debugLog("reflector.supersede_skipped", { resurrectedIds: [...resurrectedIds] });
	}
	const acceptedReflections = Array.from(accumulated.values());
	const supersededReflectionIds = [...supersedeCandidates].filter(
		(reflectionId) => !replacementIds.has(reflectionId),
	);
	// What the merge actually leaves behind: the replaced reflections are gone and the
	// accepted ones are in.
	const supersededIds = new Set(supersededReflectionIds);
	const afterCoverageById = reflectionCoverageMap(observations, [
		...reflections.filter((reflection) => !supersededIds.has(reflection.id)),
		...acceptedReflections,
	]);
	let reason = "all_filtered";
	if (acceptedReflections.length > 0) reason = "accepted_nonempty";
	else if (supersededReflectionIds.length > 0) reason = "merged_existing";
	else if (toolCallCount === 0) reason = "no_tool_call";
	debugLog("reflector.result", {
		reason,
		toolCallCount,
		rawProposedReflectionCount,
		acceptedReflectionCount,
		duplicateReflectionCount,
		rejectedReflectionCount,
		supersededReflectionCount: supersededReflectionIds.length,
		acceptedSupportIdCounts: summarizeSupportIdCounts(acceptedReflections),
		coverageTransitionsByRelevance: summarizeCoverageTransitionsByRelevance(
			observations,
			coverageById,
			afterCoverageById,
		),
	});
	if (
		acceptedReflections.length === 0 &&
		supersededReflectionIds.length === 0 &&
		streamError !== undefined
	) {
		throw new ReflectorStreamError(streamError.stopReason, streamError.errorMessage);
	}
	if (acceptedReflections.length === 0 && supersededReflectionIds.length === 0) return undefined;
	return { reflections: acceptedReflections, supersededReflectionIds };
}
