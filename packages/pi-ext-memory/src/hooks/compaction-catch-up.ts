import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runObserver } from "../agents/observer/agent.js";
import type { StreamableModelRegistry } from "../agents/worker-stream.js";
import { resolveObserverChunkMaxTokens, resolveWorkerMemoryMaxTokens } from "../config.js";
import { debugLog } from "../debug-log.js";
import type { Runtime } from "../runtime.js";
import {
	earliestSourceTimestamp,
	serializeSourceAddressedBranchEntries,
	sourceTimestamps,
} from "../serialize.js";
import {
	buildObservationsRecordedData,
	type Entry,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	type Observation,
	OM_OBSERVATIONS_RECORDED,
	observationToSummaryLine,
	reflectionToSummaryLine,
	selectVisibleMemory,
	type UnobservedSourceSpan,
} from "../session-ledger/index.js";

export type CatchUpResult = {
	/** Observer chunks that recorded observations. */
	chunksRecorded: number;
	/** Why catch-up stopped before covering the whole gap, if it did. */
	stoppedBecause?: "max_chunks" | "empty" | "error" | "model_unavailable" | "aborted";
};

export type CatchUpArgs = {
	pi: ExtensionAPI;
	runtime: Runtime;
	ctx: ExtensionContext;
	entries: Entry[];
	gap: UnobservedSourceSpan;
	maxChunks: number;
	signal?: AbortSignal;
};

/**
 * Observe unobserved source entries before Pi's proposed cut, one chunk at a time.
 * Runs inside `session_before_compact`, where Pi waits for the hook and no session
 * request is in flight. Each recorded chunk advances the observation frontier.
 */
export async function catchUpObserver(args: CatchUpArgs): Promise<CatchUpResult> {
	const { pi, runtime, ctx, entries, gap, maxChunks, signal } = args;
	const result: CatchUpResult = { chunksRecorded: 0 };
	if (maxChunks <= 0) return result;

	const resolved = await runtime.resolveModel({
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
	});
	if (!resolved.ok) {
		debugLog("compaction.catch_up.model_unavailable", { reason: resolved.reason });
		return { ...result, stoppedBecause: "model_unavailable" };
	}

	const contextWindow = (resolved.model as { contextWindow?: number }).contextWindow;
	const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, contextWindow);
	const frontierIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	let remaining = entries.slice(frontierIndex + 1, gap.lastIndex + 1).filter(isSourceEntry);
	let branch = entries;

	for (let chunkIndex = 0; chunkIndex < maxChunks && remaining.length > 0; chunkIndex++) {
		if (signal?.aborted) return { ...result, stoppedBecause: "aborted" };

		const {
			text: chunk,
			sourceEntryIds,
			estimatedTokens,
		} = serializeSourceAddressedBranchEntries(remaining, { maxTokens: maxChunkTokens });
		const coversUpToId = sourceEntryIds.at(-1);
		if (!chunk.trim() || !coversUpToId) break;
		const timeline = sourceTimestamps(remaining, sourceEntryIds);

		const fullMemory = fullProjection(branch);
		const workerMemoryBudget = resolveWorkerMemoryMaxTokens(runtime.config, contextWindow);
		const visible = selectVisibleMemory(fullMemory, {
			maxTokens: workerMemoryBudget,
			observationTargetTokens: runtime.config.observationsPoolTargetTokens,
		});

		if (runtime.config.showWorkerNotifications && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(
				`om: observing ${sourceEntryIds.length} unobserved source entr${sourceEntryIds.length === 1 ? "y" : "ies"} (~${estimatedTokens.toLocaleString()} tokens) before compacting`,
				"info",
			);
		}
		debugLog("compaction.catch_up.chunk", {
			chunkIndex,
			sourceEntryCount: sourceEntryIds.length,
			estimatedTokens,
			coversUpToId,
		});

		let observations: Observation[] | undefined;
		try {
			observations = await runObserver({
				model: resolved.model as Model<Api>,
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				env: resolved.env,
				priorReflections: visible.reflections.map(reflectionToSummaryLine),
				priorObservations: visible.observations.map(observationToSummaryLine),
				chunk,
				allowedSourceEntryIds: sourceEntryIds,
				resolveTimestamp: (cited) => earliestSourceTimestamp(timeline, cited),
				signal,
				maxTurns: runtime.config.agentMaxTurns,
				maxOutputTokens: runtime.config.agentMaxTokens,
				thinkingLevel: runtime.config.model?.thinking ?? "low",
				modelRegistry: ctx.modelRegistry as unknown as StreamableModelRegistry,
			});
		} catch (error) {
			if (signal?.aborted) return { ...result, stoppedBecause: "aborted" };
			const errorMessage = error instanceof Error ? error.message : String(error);
			debugLog("compaction.catch_up.error", { chunkIndex, errorMessage });
			if (ctx.hasUI && ctx.ui) {
				ctx.ui.notify(`om: catch-up observer failed: ${errorMessage}`, "warning");
			}
			return { ...result, stoppedBecause: "error" };
		}

		const data =
			observations && observations.length > 0
				? buildObservationsRecordedData(observations, coversUpToId)
				: undefined;
		if (!data) {
			debugLog("compaction.catch_up.empty", { chunkIndex, coversUpToId });
			return { ...result, stoppedBecause: "empty" };
		}

		pi.appendEntry(OM_OBSERVATIONS_RECORDED, data);
		result.chunksRecorded++;
		debugLog("compaction.catch_up.recorded", {
			chunkIndex,
			count: observations ? observations.length : 0,
			coversUpToId,
		});

		const coveredIndex = entries.findIndex((entry) => entry.id === coversUpToId);
		remaining = remaining.filter((entry) => entries.indexOf(entry) > coveredIndex);
		branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? branch;
	}

	if (remaining.length > 0 && !result.stoppedBecause) result.stoppedBecause = "max_chunks";
	return result;
}
