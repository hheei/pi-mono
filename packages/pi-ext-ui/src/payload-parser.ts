import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isRecord } from "@hheei/pi-ext-core";
import type { ToolStatusKind } from "./tool-view.js";

export const RESOLVED_CALLS_KEY = "__piExtUiResolvedCalls";

export interface NestedCallRecord {
	readonly toolName: string;
	/** The host's call id (`<parent>/<n>`); the key its saved arguments are indexed under. */
	readonly id?: string | undefined;
	/** The request bytes when this process or the session branch still has them. */
	readonly args?: unknown;
	/** The session saved the size of the request but not the request itself. */
	readonly argsTruncated?: boolean | undefined;
	readonly argsBytes?: number | undefined;
	/** Positive fact only: the host proved this call resolved to a real tool. */
	readonly resolved?: boolean | undefined;
	readonly summary?: string | undefined;
	readonly status?: "running" | "ok" | "error" | "cancelled" | undefined;
	readonly isError?: boolean | undefined;
	readonly isWarning?: boolean | undefined;
	readonly durationMs?: number | undefined;
	readonly cost?: number | undefined;
	readonly error?: string | undefined;
}

export function estimateStreamingTokens(args: unknown): number {
	if (args === undefined || args === null) return 0;
	try {
		const serialized = typeof args === "string" ? args : JSON.stringify(args);
		if (!serialized || serialized === "{}") return 0;
		return Math.max(1, Math.ceil(serialized.length / 4));
	} catch {
		return 0;
	}
}

export function formatDurationMs(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "";
	return ms < 1000 ? `${String(Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function formatCostUsd(cost: number | undefined): string {
	if (cost === undefined || !Number.isFinite(cost) || cost <= 0) return "";
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

/** One header fact for a deadline, in the same shape codemode's `timeout_ms` renders as. */
export function formatTimeoutFact(timeoutMs: number): string {
	const label =
		timeoutMs >= 1000 ? `${String(Math.round(timeoutMs / 1000))}s` : `${String(timeoutMs)}ms`;
	return `(timeout ${label})`;
}

export function parseCallArgs(raw: unknown): Record<string, unknown> | undefined {
	if (isRecord(raw)) return raw;
	if (typeof raw !== "string") return undefined;
	const text = raw.trim();
	if (text === "") return undefined;
	if (text.startsWith("{")) {
		try {
			const parsed = JSON.parse(text);
			if (isRecord(parsed)) return parsed;
		} catch {
			const record: Record<string, unknown> = {};
			const extractString = (key: string) => {
				const regex = new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`);
				const match = regex.exec(text);
				if (match?.[1]) {
					record[key] = match[1].replace(/\\"/g, '"');
				}
			};
			const extractNumber = (key: string) => {
				const regex = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`);
				const match = regex.exec(text);
				if (match?.[1]) {
					record[key] = Number(match[1]);
				}
			};

			extractString("path");
			extractString("file_path");
			extractString("command");
			extractString("pattern");
			extractString("glob");
			extractString("query");
			extractString("url");
			extractString("id");
			extractString("agent");
			extractString("topic");
			extractString("source");
			extractNumber("offset");
			extractNumber("limit");

			if (Object.keys(record).length > 0) return record;
		}
	}
	return undefined;
}

export function extractNestedCalls(
	result: AgentToolResult<unknown> | undefined,
): readonly NestedCallRecord[] {
	if (result === undefined || !isRecord(result.details)) return [];
	const rawList = Array.isArray(result.details.calls)
		? result.details.calls
		: Array.isArray(result.details.nestedCalls)
			? result.details.nestedCalls
			: undefined;
	if (rawList === undefined) return [];
	const rawResolved = result.details[RESOLVED_CALLS_KEY];
	const resolvedIds = Array.isArray(rawResolved)
		? new Set(rawResolved.filter((id): id is string => typeof id === "string"))
		: undefined;
	const items: NestedCallRecord[] = [];
	for (const entry of rawList) {
		if (!isRecord(entry)) continue;
		const name =
			typeof entry.name === "string"
				? entry.name
				: typeof entry.toolName === "string"
					? entry.toolName
					: undefined;
		if (name === undefined) continue;
		const rawStatus = entry.status;
		const status =
			rawStatus === "running" ||
			rawStatus === "ok" ||
			rawStatus === "error" ||
			rawStatus === "cancelled"
				? rawStatus
				: undefined;
		const summary =
			typeof entry.args === "string" && entry.args.trim() !== ""
				? entry.args
				: typeof entry.summary === "string"
					? entry.summary
					: undefined;
		const id = typeof entry.id === "string" ? entry.id : undefined;
		items.push({
			toolName: name,
			...(id === undefined ? {} : { id }),
			// Absent facts stay absent: a legacy record and an unresolved call are both unknown.
			...(id !== undefined && resolvedIds?.has(id) === true ? { resolved: true } : {}),
			summary,
			status,
			isError: entry.isError === true || status === "error",
			isWarning: entry.isWarning === true || status === "cancelled",
			durationMs: typeof entry.durationMs === "number" ? entry.durationMs : undefined,
			cost: typeof entry.cost === "number" ? entry.cost : undefined,
			error: typeof entry.error === "string" ? entry.error : undefined,
		});
	}
	return items;
}

export function callStatsParts(total: number, failCount: number): string[] {
	if (failCount > 0) {
		return [`${String(total - failCount)} ok`, `${String(failCount)} failed`];
	}
	return [`${String(total)} ${total === 1 ? "call" : "calls"}`];
}

export function resolveContainerStatus(params: {
	readonly isError: boolean;
	readonly isPartial: boolean;
	readonly hasChildren: boolean;
	readonly selfFailed: boolean;
}): ToolStatusKind {
	if (params.selfFailed) return "error";
	if (params.hasChildren) return "none";
	if (params.isPartial) return "running";
	return params.isError ? "error" : "ok";
}
