import { isRecord } from "@hheei/pi-ext-core";
import type { SubagentState, UsageSummary } from "./domain.js";
export interface StateSnapshot {
	readonly state: SubagentState;
	readonly summary?: string;
	readonly interrupted?: string;
	readonly activeTool?: string;
	readonly usage: UsageSummary;
}
export interface TranscriptFacts {
	readonly usage: UsageSummary;
	readonly summary?: string;
	readonly resultText?: string;
	readonly stopReason?: string;
	readonly interrupted?: string;
	readonly containsInput: boolean;
	readonly contextTokens?: number;
}

export interface StateProjector {
	applyEvent(event: unknown): StateSnapshot;
	rebuild(entries: readonly unknown[]): StateSnapshot;
	applyTranscriptFacts(facts: TranscriptFacts): StateSnapshot;
	/**
	 * Puts the projected state back in step with a state the child itself reported. Without it a
	 * transcript that still ends in a tool result keeps projecting "running" over a child that has
	 * answered that it is idle, and the next state-less event writes that back onto the record.
	 */
	syncState(state: SubagentState): StateSnapshot;
	snapshot(): StateSnapshot;
}
const EMPTY_USAGE: UsageSummary = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	costUsd: 0,
	turns: 0,
};
function record(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}
function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function assistant(entry: unknown): { id: string; message: Record<string, unknown> } | undefined {
	const item = record(entry);
	const message = record(item?.message);
	return item?.type === "message" && typeof item.id === "string" && message?.role === "assistant"
		? { id: item.id, message }
		: undefined;
}
function text(message: Record<string, unknown>): string | undefined {
	if (!Array.isArray(message.content)) return undefined;
	const value = message.content
		.map((part) => {
			const item = record(part);
			return item?.type === "text" && typeof item.text === "string" ? item.text : "";
		})
		.join("")
		.trim();
	return value === "" ? undefined : value;
}

/** Activity lines stay short. The full answer lives on the receipt, not in the dashboard summary. */
const ACTIVITY_SUMMARY_LIMIT = 240;

function activitySummary(value: string): string {
	const flat = value.replace(/\s+/g, " ").trim();
	if (flat.length <= ACTIVITY_SUMMARY_LIMIT) return flat;
	return `${flat.slice(0, ACTIVITY_SUMMARY_LIMIT - 1)}…`;
}
function completed(message: Record<string, unknown>): boolean {
	return message.stopReason !== "pending" && message.stopReason !== "deferred";
}
function diagnostic(message: Record<string, unknown>): string | undefined {
	if (message.stopReason === "aborted") return "Assistant turn was interrupted";
	if (message.stopReason !== "error") return undefined;
	return typeof message.errorMessage === "string" && message.errorMessage !== ""
		? message.errorMessage
		: "Assistant turn failed";
}
function messageUsage(message: Record<string, unknown>): Omit<UsageSummary, "turns"> | undefined {
	const usage = record(message.usage);
	const inputTokens = finite(usage?.input);
	const outputTokens = finite(usage?.output);
	const cacheReadTokens = finite(usage?.cacheRead);
	const cacheWriteTokens = finite(usage?.cacheWrite);
	if (
		inputTokens === undefined ||
		outputTokens === undefined ||
		cacheReadTokens === undefined ||
		cacheWriteTokens === undefined
	)
		return undefined;
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		costUsd: finite(record(usage?.cost)?.total) ?? null,
	};
}
function add(total: UsageSummary, next: Omit<UsageSummary, "turns">): UsageSummary {
	return {
		inputTokens: total.inputTokens + next.inputTokens,
		outputTokens: total.outputTokens + next.outputTokens,
		cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
		cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
		costUsd: total.costUsd === null || next.costUsd === null ? null : total.costUsd + next.costUsd,
		turns: total.turns + 1,
	};
}
export function lastAssistantText(entries: readonly unknown[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry === undefined) continue;
		const item = assistant(entry);
		if (item === undefined || !completed(item.message)) continue;
		const value = text(item.message);
		if (value !== undefined) return value;
	}
	return undefined;
}
export function summarizeCurrentBranch(entries: readonly unknown[]): string | undefined {
	const value = lastAssistantText(entries);
	return value === undefined ? undefined : activitySummary(value);
}
export function aggregateUsage(entries: readonly unknown[]): UsageSummary {
	let total = EMPTY_USAGE;
	const seen = new Set<string>();
	for (const entry of entries) {
		const item = assistant(entry);
		if (item === undefined || seen.has(item.id) || !completed(item.message)) continue;
		seen.add(item.id);
		const usage = messageUsage(item.message);
		if (usage !== undefined) total = add(total, usage);
	}
	return total;
}

function userText(message: Record<string, unknown>): string | undefined {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return undefined;
	return message.content
		.map((part) => {
			const content = record(part);
			return content?.type === "text" && typeof content.text === "string" ? content.text : "";
		})
		.join("");
}

function lastCompletedAssistant(entries: readonly unknown[]): Record<string, unknown> | undefined {
	let last: Record<string, unknown> | undefined;
	for (const entry of entries) {
		const item = assistant(entry);
		if (item === undefined || !completed(item.message)) continue;
		last = item.message;
	}
	return last;
}

function lastAssistantContextTokens(
	message: Record<string, unknown> | undefined,
): number | undefined {
	if (message === undefined) return undefined;
	const usage = record(message.usage);
	if (usage === undefined) return undefined;
	const input = finite(usage.input) ?? 0;
	const output = finite(usage.output) ?? 0;
	const cacheRead = finite(usage.cacheRead) ?? 0;
	const cacheWrite = finite(usage.cacheWrite) ?? 0;
	const total = input + output + cacheRead + cacheWrite;
	return total > 0 ? total : undefined;
}

/** What the parent projects from a session. The transcript itself never crosses the bridge. */
export function transcriptFacts(
	entries: readonly unknown[],
	expectedInput?: string,
): TranscriptFacts {
	const last = lastCompletedAssistant(entries);
	const resultText = lastAssistantText(entries);
	const summary = resultText === undefined ? undefined : activitySummary(resultText);
	const stopReason = typeof last?.stopReason === "string" ? last.stopReason : undefined;
	const interrupted = last === undefined ? undefined : diagnostic(last);
	const contextTokens = lastAssistantContextTokens(last);
	const containsInput =
		expectedInput !== undefined &&
		entries.some((entry) => {
			const value = record(entry);
			const message = record(value?.message);
			return message?.role === "user" && userText(message) === expectedInput;
		});
	return {
		usage: aggregateUsage(entries),
		...(resultText === undefined ? {} : { resultText }),
		...(summary === undefined ? {} : { summary }),
		...(stopReason === undefined ? {} : { stopReason }),
		...(interrupted === undefined ? {} : { interrupted }),
		...(contextTokens === undefined ? {} : { contextTokens }),
		containsInput,
	};
}

function usageNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A mailbox answer is untrusted. Anything that is not these fields is not facts. */
export function parseTranscriptFacts(value: unknown): TranscriptFacts | undefined {
	if (!isRecord(value) || typeof value.containsInput !== "boolean" || !isRecord(value.usage)) {
		return undefined;
	}
	const usage = value.usage;
	const inputTokens = usageNumber(usage.inputTokens);
	const outputTokens = usageNumber(usage.outputTokens);
	const cacheReadTokens = usageNumber(usage.cacheReadTokens);
	const cacheWriteTokens = usageNumber(usage.cacheWriteTokens);
	const turns = usageNumber(usage.turns);
	const costUsd = usage.costUsd === null ? null : usageNumber(usage.costUsd);
	if (
		inputTokens === undefined ||
		outputTokens === undefined ||
		cacheReadTokens === undefined ||
		cacheWriteTokens === undefined ||
		turns === undefined ||
		costUsd === undefined
	) {
		return undefined;
	}
	const resultText = typeof value.resultText === "string" ? value.resultText : undefined;
	const summary = typeof value.summary === "string" ? activitySummary(value.summary) : undefined;
	const stopReason = typeof value.stopReason === "string" ? value.stopReason : undefined;
	const interrupted = typeof value.interrupted === "string" ? value.interrupted : undefined;
	const contextTokens = usageNumber(value.contextTokens);
	return {
		usage: {
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			costUsd,
			turns,
		},
		...(resultText === undefined ? {} : { resultText }),
		...(summary === undefined ? {} : { summary }),
		...(stopReason === undefined ? {} : { stopReason }),
		...(interrupted === undefined ? {} : { interrupted }),
		...(contextTokens === undefined ? {} : { contextTokens }),
		containsInput: value.containsInput,
	};
}

/** The phase a streaming assistant update is in: what the parent shows as the child's activity. */
export type AssistantPhaseKind = "thinking" | "generating" | "toolcall";

export interface AssistantPhase {
	readonly kind: AssistantPhaseKind;
	/** The tool being streamed, when the phase is a tool call. */
	readonly toolName?: string;
}

/**
 * Categorizes a streaming assistant update into the phase the parent projects. The child throttles
 * duplicate deltas with the same answer, so both ends of the bridge agree on what "still thinking"
 * means instead of each re-deriving it from a different subset of the event.
 */
export function assistantUpdatePhase(
	assistantMessageEvent: unknown,
	message: unknown,
): AssistantPhase | undefined {
	const update = record(assistantMessageEvent);
	const type = typeof update?.type === "string" ? update.type : undefined;
	const current = record(message);
	const currentText = current === undefined ? undefined : text(current);
	if (type === undefined) {
		return currentText === undefined ? undefined : { kind: "generating" };
	}
	if (type.startsWith("thinking_")) return { kind: "thinking" };
	if (type.startsWith("toolcall_")) {
		const index = typeof update?.contentIndex === "number" ? update.contentIndex : undefined;
		const part =
			current !== undefined && Array.isArray(current.content) && index !== undefined
				? record(current.content[index])
				: undefined;
		return {
			kind: "toolcall",
			...(typeof part?.name === "string" ? { toolName: part.name } : {}),
		};
	}
	if (type.startsWith("text_") || currentText !== undefined) return { kind: "generating" };
	return undefined;
}

export function createStateProjector(initialState: SubagentState = "running"): StateProjector {
	let state = initialState;
	let summary: string | undefined;
	let interrupted: string | undefined;
	let activeTool: string | undefined;
	let usage: UsageSummary = EMPTY_USAGE;
	const snapshot = (): StateSnapshot => ({
		state,
		...(summary === undefined ? {} : { summary }),
		...(interrupted === undefined ? {} : { interrupted }),
		...(activeTool === undefined ? {} : { activeTool }),
		usage,
	});
	const applyFacts = (facts: TranscriptFacts): StateSnapshot => {
		activeTool = undefined;
		summary = facts.summary;
		usage = facts.usage;
		interrupted = facts.interrupted;
		if (facts.stopReason === "error") state = "error";
		else if (facts.stopReason !== undefined && state === "error") state = "done";
		return snapshot();
	};
	return {
		applyEvent(event) {
			const value = record(event);
			if (value === undefined) return snapshot();
			if (
				value.type === "agent_start" ||
				value.type === "turn_start" ||
				value.type === "auto_retry_start" ||
				value.type === "auto_retry"
			) {
				state = "running";
				summary = "thinking...";
				interrupted = undefined;
				activeTool = undefined;
			} else if (value.type === "tool_execution_start" || value.type === "tool_execution_update") {
				activeTool = typeof value.toolName === "string" ? value.toolName : undefined;
			} else if (value.type === "tool_execution_end") {
				activeTool = undefined;
				summary = "thinking...";
			} else if (value.type === "message_update") {
				const message = record(value.message);
				if (message?.role === "assistant") {
					const phase = assistantUpdatePhase(value.assistantMessageEvent, message);
					if (phase?.kind === "thinking") {
						summary = "thinking...";
						activeTool = undefined;
					} else if (phase?.kind === "toolcall") {
						activeTool = phase.toolName;
					} else if (phase?.kind === "generating") {
						summary = "generating...";
						activeTool = undefined;
					}
				}
			} else if (value.type === "agent_end" || value.type === "agent_settled") {
				activeTool = undefined;
				const messages = Array.isArray(value.messages) ? value.messages : [];
				const message = record(messages.length > 0 ? messages[messages.length - 1] : value.message);
				if (message?.role === "assistant") {
					const spoken = text(message);
					summary = spoken === undefined ? summary : activitySummary(spoken);
					if (value.type === "agent_end" && message.stopReason === "error") {
						state = "error";
						interrupted = diagnostic(message);
					}
				}
				if (value.type === "agent_settled") {
					if (value.aborted === true) {
						state = "blocked";
						interrupted = "Assistant turn was interrupted";
					} else if (message?.stopReason === "error") {
						state = "error";
						interrupted = diagnostic(message);
					} else {
						state = "done";
						interrupted = undefined;
					}
				}
			} else if (value.type === "compaction_start") {
				summary = "compacting...";
				activeTool = undefined;
			} else if (value.type === "compaction_end") {
				if (summary === "compacting...") {
					summary = undefined;
				}
			} else if (value.type === "error") {
				state = "error";
				interrupted =
					typeof value.message === "string" ? value.message : "Runner reported an error";
			}
			return snapshot();
		},
		rebuild(entries) {
			return applyFacts(transcriptFacts(entries));
		},
		applyTranscriptFacts(facts) {
			return applyFacts(facts);
		},
		syncState(next) {
			state = next;
			return snapshot();
		},
		snapshot,
	};
}
