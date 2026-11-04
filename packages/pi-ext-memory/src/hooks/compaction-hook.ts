import {
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

import { resolveCompactionMaxRetainedTokens } from "../config.js";
import { debugLog } from "../debug-log.js";
import type { Runtime } from "../runtime.js";
import {
	buildCompactionProjection,
	compactionRangeStartIndex,
	type Entry,
	entryIndexForId,
	latestCoverageIndex,
	latestCoverageMarkerId,
	latestGateEnabled,
	type MemoryDetails,
	memoryPreamble,
	OM_OBSERVATIONS_RECORDED,
	rawTokensAfterIndex,
	renderSummary,
	resolveMemoryBudget,
	retainedTailTokens,
	selectVisibleMemory,
	type UnobservedSourceSpan,
	unobservedSourceSpanBefore,
} from "../session-ledger/index.js";
import { estimateStringTokens } from "../tokens.js";
import { catchUpObserver } from "./compaction-catch-up.js";

/**
 * Share of memory lines that must be trimmed before the user is told. Routine
 * trimming is reported by `details.budget` and `/om status` instead of a toast
 * on every compaction of a long session.
 */
const TRIM_NOTICE_ITEM_RATIO = 0.25;

/** Smallest trim worth a notice, so a tiny memory list cannot produce one per line. */
const TRIM_NOTICE_MIN_ITEMS = 5;

export type CompactionCut = {
	/** First entry Pi keeps in context. */
	firstKeptEntryId: string;
	/** Entry through which the memory ledger is folded into the rendered summary. */
	foldThroughEntryId: string;
};

export type CompactionCutResolution =
	| { kind: "cut"; cut: CompactionCut; gap?: UnobservedSourceSpan; retainedTokens?: number }
	| { kind: "delegate"; reason: string; gap: UnobservedSourceSpan };

const CUT_POINT_ROLES = new Set([
	"user",
	"assistant",
	"bashExecution",
	"custom",
	"branchSummary",
	"compactionSummary",
]);

function isCutPointEntry(entry: Entry): boolean {
	if (entry.type === "compaction") return false;
	try {
		return sessionEntryToContextMessages(entry as unknown as SessionEntry).some((message) =>
			CUT_POINT_ROLES.has(message.role),
		);
	} catch {
		return false;
	}
}

function findCutPointAtOrBefore(entries: Entry[], index: number, startIndex: number): number {
	for (let i = Math.min(index, entries.length - 1); i >= startIndex && i >= 0; i--) {
		const entry = entries[i];
		if (entry && isCutPointEntry(entry)) return i;
	}
	return -1;
}

export function resolveCompactionCut(
	entries: Entry[],
	firstKeptEntryId: string,
	options: { maxRetainedTokens: number; reason?: string },
): CompactionCutResolution {
	const cutIndex = entryIndexForId(entries, firstKeptEntryId);
	if (cutIndex === -1) {
		return { kind: "cut", cut: { firstKeptEntryId, foldThroughEntryId: firstKeptEntryId } };
	}

	const gap = unobservedSourceSpanBefore(entries, cutIndex);
	if (!gap) {
		return { kind: "cut", cut: { firstKeptEntryId, foldThroughEntryId: firstKeptEntryId } };
	}

	if (options.reason === "overflow") {
		return { kind: "delegate", reason: "overflow recovery", gap };
	}

	const coverageMarkerId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!coverageMarkerId) {
		return { kind: "delegate", reason: "no observation coverage", gap };
	}

	const rangeStart = compactionRangeStartIndex(entries);
	const coverageIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	if (coverageIndex < rangeStart) {
		return { kind: "delegate", reason: "nothing observed can be compacted", gap };
	}

	const safeCutIndex = findCutPointAtOrBefore(entries, gap.firstIndex, rangeStart);
	if (safeCutIndex <= rangeStart) {
		return { kind: "delegate", reason: "nothing observed can be compacted", gap };
	}
	const freedTokens =
		rawTokensAfterIndex(entries, rangeStart - 1) - rawTokensAfterIndex(entries, safeCutIndex - 1);
	if (freedTokens <= 0) {
		return { kind: "delegate", reason: "nothing observed can be compacted", gap };
	}

	const retainedTokens = rawTokensAfterIndex(entries, safeCutIndex - 1);
	if (retainedTokens > options.maxRetainedTokens) {
		return {
			kind: "delegate",
			reason: `retaining ~${retainedTokens.toLocaleString()} tokens exceeds the ~${options.maxRetainedTokens.toLocaleString()}-token budget`,
			gap,
		};
	}

	const cutEntry = entries[safeCutIndex];
	if (!cutEntry) return { kind: "delegate", reason: "nothing observed can be compacted", gap };
	return {
		kind: "cut",
		cut: { firstKeptEntryId: cutEntry.id, foldThroughEntryId: coverageMarkerId },
		gap,
		retainedTokens,
	};
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on(
		"session_before_compact",
		async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
			const sessionGeneration = runtime.sessionGeneration;
			const lifecycleSignal = runtime.lifecycleSignal;
			// Gate off: memory is not driving this session, so leave compaction to Pi's
			// own summarizer rather than answering on its behalf.
			if (!latestGateEnabled(event.branchEntries as Entry[])) return;
			if (runtime.compactHookInFlight) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"om: another compaction is already in progress; cancelling duplicate",
						"warning",
					);
				}
				return { cancel: true };
			}

			runtime.compactHookInFlight = true;
			try {
				await runtime.ensureConfig(ctx.cwd, lifecycleSignal);
				const isCurrent =
					typeof runtime.isSessionCurrent === "function"
						? runtime.isSessionCurrent(sessionGeneration)
						: true;
				if (!isCurrent || lifecycleSignal?.aborted) {
					return { cancel: true };
				}
				const { preparation, branchEntries } = event;
				const { firstKeptEntryId, tokensBefore } = preparation;
				let entries = branchEntries as Entry[];
				const contextWindow = ctx.model?.contextWindow;
				const maxRetainedTokens = resolveCompactionMaxRetainedTokens(runtime.config, contextWindow);
				let resolution = resolveCompactionCut(entries, firstKeptEntryId, {
					maxRetainedTokens,
					reason: event.reason,
				});

				if (
					resolution.gap &&
					runtime.config.compactionCatchUpMaxChunks > 0 &&
					!runtime.consolidationInFlight &&
					latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED) !== undefined
				) {
					const catchUp = await catchUpObserver({
						pi,
						runtime,
						ctx,
						entries,
						gap: resolution.gap,
						maxChunks: runtime.config.compactionCatchUpMaxChunks,
						signal: event.signal,
					});
					debugLog("compaction.catch_up", {
						...catchUp,
						gapEntries: resolution.gap.entryCount,
						gapTokens: resolution.gap.tokens,
					});
					if (catchUp.chunksRecorded > 0) {
						entries = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? entries;
						resolution = resolveCompactionCut(entries, firstKeptEntryId, {
							maxRetainedTokens,
							reason: event.reason,
						});
					}
				}

				if (resolution.kind === "delegate") {
					debugLog("compaction.delegate", {
						reason: resolution.reason,
						gapEntries: resolution.gap.entryCount,
						gapTokens: resolution.gap.tokens,
					});
					if (ctx.hasUI && ctx.ui) {
						ctx.ui.notify(
							`om: observer has not reached ${resolution.gap.entryCount} source entries (~${resolution.gap.tokens.toLocaleString()} tokens) before compaction cut (${resolution.reason}); delegating to Pi's native summarizer`,
							"warning",
						);
					}
					if (runtime.idleCompactInFlight) return { cancel: true };
					return;
				}

				const effectiveFirstKeptEntryId = resolution.cut.firstKeptEntryId;
				const foldThroughEntryId = resolution.cut.foldThroughEntryId;

				// Optional call: hosts older than this extension's minimum Pi version may
				// not report a system prompt, and the budget falls back to a constant.
				const systemPrompt = ctx.getSystemPrompt?.();
				const budget = resolveMemoryBudget({
					config: runtime.config,
					contextWindow,
					tailTokens: retainedTailTokens(entries, effectiveFirstKeptEntryId),
					reserveTokens: preparation.settings?.reserveTokens,
					systemTokens:
						typeof systemPrompt === "string" && systemPrompt.length > 0
							? estimateStringTokens(systemPrompt)
							: undefined,
					reason: event.reason,
				});
				const projection = buildCompactionProjection(entries, foldThroughEntryId, {
					observationsPoolMaxTokens: runtime.config.observationsPoolMaxTokens,
				});
				// Memory is bounded to what fits beside the retained tail: an unbounded
				// summary can exceed the model window, which makes compaction impossible
				// to converge on.
				const visible = selectVisibleMemory(projection, {
					maxTokens: budget.render,
					observationTargetTokens: runtime.config.observationsPoolTargetTokens,
				});
				const memoryItems = projection.observations.length + projection.reflections.length;
				let summary = renderSummary(visible.reflections, visible.observations);
				if (summary.length === 0 && memoryItems === 0) {
					if (runtime.idleCompactInFlight) {
						// Idle compaction must never fallback to slow/expensive native LLM summarizer
						return { cancel: true };
					}
					// Decline ownership so Pi's native summarizer preserves the pre-cut context.
					return;
				}
				// Memory exists but no line fits the budget. Answer with the framing text
				// alone — bounded, and it points at the recall tool — instead of handing the
				// compaction to a summarizer that respects no budget at all.
				if (summary.length === 0) summary = memoryPreamble();

				// Check if retained tail + summary fits
				if (resolution.gap && resolution.retainedTokens !== undefined) {
					const summaryTokens = estimateStringTokens(summary);
					const afterTokens = resolution.retainedTokens + summaryTokens;
					if (afterTokens > maxRetainedTokens) {
						debugLog("compaction.retained_plus_summary_overflow", {
							retainedTokens: resolution.retainedTokens,
							summaryTokens,
							afterTokens,
							maxRetainedTokens,
						});
						if (ctx.hasUI && ctx.ui) {
							ctx.ui.notify(
								`om: retaining ~${resolution.retainedTokens.toLocaleString()} tokens plus ~${summaryTokens.toLocaleString()} tokens memory summary exceeds budget; delegating to Pi's native summarizer`,
								"warning",
							);
						}
						if (runtime.idleCompactInFlight) return { cancel: true };
						return;
					}
				}

				if (resolution.gap && ctx.hasUI && ctx.ui) {
					ctx.ui.notify(
						`om: observer has not reached ${resolution.gap.entryCount} source entries (~${resolution.gap.tokens.toLocaleString()} tokens) before compaction cut; keeping them in context until observed`,
						"info",
					);
				}

				const details: MemoryDetails = {
					...projection.details,
					observations: visible.observations,
					reflections: visible.reflections,
					foldThroughEntryId,
					budget: {
						maxTokens: budget.render,
						renderedTokens: estimateStringTokens(summary),
						tailTokens: budget.tailTokens,
						softLimit: budget.softLimit,
						trimmedObservations: visible.trimmedObservations,
						trimmedReflections: visible.trimmedReflections,
					},
				};
				const trimmedItems = visible.trimmedObservations + visible.trimmedReflections;
				const nothingVisible = trimmedItems > 0 && trimmedItems === memoryItems;
				if (
					ctx.hasUI &&
					(nothingVisible ||
						trimmedItems >= Math.max(TRIM_NOTICE_MIN_ITEMS, memoryItems * TRIM_NOTICE_ITEM_RATIO))
				) {
					const tailNote =
						budget.tailTokens * 2 >= budget.softLimit
							? `; retained tail ${budget.tailTokens.toLocaleString()} tokens is close to the ${budget.softLimit.toLocaleString()} token trigger`
							: "";
					const message = nothingVisible
						? `om: memory budget (${budget.render.toLocaleString()} tokens) cannot hold a memory line — the summary carries instructions only and memory stays recallable by id${tailNote}`
						: `om: trimmed memory to its ${budget.render.toLocaleString()} token budget (${visible.observations.length} obs, ${visible.reflections.length} refl visible; ${trimmedItems.toLocaleString()} lines archived${tailNote})`;
					ctx.ui.notify(
						message,
						nothingVisible || event.reason === "overflow" ? "warning" : "info",
					);
				}

				return {
					compaction: {
						summary,
						firstKeptEntryId: effectiveFirstKeptEntryId,
						tokensBefore,
						details,
					},
				};
			} finally {
				const isCurrent =
					typeof runtime.isSessionCurrent === "function"
						? runtime.isSessionCurrent(sessionGeneration)
						: true;
				if (isCurrent) runtime.compactHookInFlight = false;
			}
		},
	);
}
