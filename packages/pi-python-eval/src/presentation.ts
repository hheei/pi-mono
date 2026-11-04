import { type AgentToolResult, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	agentResultText,
	formatDuration,
	isRecord,
	type ToolPresentation,
	type ToolPresentationChild,
	type ToolPresentationContext,
	type ToolPresentationSection,
	type ToolPresentationStatus,
} from "@hheei/pi-ext-core";
import type { EvalNestedTrace } from "./bridge.js";

/** The details format this package persists and reads back; pi-ext-ui mirrors the same string. */
export const PYTHON_EVAL_DETAILS_FORMAT = "pi-ext-tools-python-eval" as const;
export const PYTHON_EVAL_TOOL_NAME = "python_eval";

const MAX_SUMMARY_CHARS = 72;
const MAX_FIRST_LINE_CHARS = 4_000;

/**
 * A nested call as the persisted details keep it: what a child row draws, and nothing it would only
 * carry. The arguments are summarized when the cell ends, so a row never has to reshape them.
 */
export interface EvalTrace {
	readonly name: EvalNestedTrace["name"];
	readonly text: string;
	readonly summary: string;
	readonly durationMs: number;
	readonly error?: string;
	readonly toolCallId?: string;
	/** Positive resolution fact recorded at the call boundary; absent means unknown. */
	readonly resolved?: boolean;
}

/** One row of the cell transcript: printed text, display value, nested call, value, or namespace. */
export type EvalRow =
	| { readonly kind: "text"; text: string }
	| { readonly kind: "display"; readonly text: string }
	| { readonly kind: "tool"; readonly trace: EvalTrace }
	| { readonly kind: "result"; readonly text: string }
	| { readonly kind: "state"; readonly text: string };

export interface EvalToolDetails {
	readonly format: typeof PYTHON_EVAL_DETAILS_FORMAT;
	/** The bounded preview the UI draws. */
	readonly rows: readonly EvalRow[];
	/** Nested calls as facts: the preview may drop their rows, this list and its counts stay true. */
	readonly calls: {
		readonly total: number;
		/** Failures among calls that resolved; an unknown call is not a failed execution. */
		readonly failed: number;
		/** Calls the host proved it resolved; only these count as tool calls. */
		readonly resolved: number;
		readonly items: readonly EvalCall[];
	};
	readonly durationMs: number;
	readonly error?: string;
}

/**
 * One nested call without its result text: enough to list it and count it, small enough to keep for
 * every call even when the preview that holds the text is bounded.
 */
export interface EvalCall {
	readonly id?: string;
	readonly name: EvalNestedTrace["name"];
	readonly summary: string;
	readonly durationMs: number;
	readonly failed: boolean;
	readonly resolved?: boolean;
}

export interface EvalFrameDetails {
	readonly rows: readonly EvalRow[];
	readonly calls: {
		readonly total: number;
		readonly failed: number;
		readonly resolved: number;
		readonly items: readonly EvalCall[];
	};
	readonly error: string | undefined;
}

/**
 * Reads the persisted details of one cell. Session restore and the UI both hand this package JSON
 * it did not build in this process, so every row is validated here and an unknown shape degrades to
 * plain output instead of a broken frame.
 */
export function readEvalDetails(details: unknown): EvalFrameDetails | undefined {
	if (!isRecord(details) || details.format !== PYTHON_EVAL_DETAILS_FORMAT) return undefined;
	const rawRows = Array.isArray(details.rows) ? details.rows : [];
	const rows: EvalRow[] = [];
	for (const entry of rawRows) {
		if (!isRecord(entry)) continue;
		if (
			(entry.kind === "text" ||
				entry.kind === "display" ||
				entry.kind === "result" ||
				entry.kind === "state") &&
			typeof entry.text === "string"
		) {
			rows.push({ kind: entry.kind, text: entry.text });
		} else if (entry.kind === "tool") {
			const trace = readTrace(entry.trace);
			if (trace !== undefined) rows.push({ kind: "tool", trace });
		}
	}
	return {
		rows,
		calls: readCalls(details.calls, rows),
		error: typeof details.error === "string" ? details.error : undefined,
	};
}

/** A detail written before the count became a fact reports what its rows still show. */
function readCalls(raw: unknown, rows: readonly EvalRow[]): EvalFrameDetails["calls"] {
	if (isRecord(raw) && typeof raw.total === "number" && typeof raw.failed === "number") {
		const resolved = typeof raw.resolved === "number" ? raw.resolved : 0;
		return {
			total: raw.total,
			// A record written before the fact existed has no proven calls, so no proven failure.
			failed: typeof raw.resolved === "number" ? raw.failed : 0,
			resolved,
			items: readCallItems(raw.items),
		};
	}
	// No count fact: the rows still state the resolution of each call they kept.
	const calls = rows.filter((row) => row.kind === "tool");
	const resolved = calls.filter((row) => row.trace.resolved === true);
	return {
		total: calls.length,
		failed: resolved.filter((row) => row.trace.error !== undefined).length,
		resolved: resolved.length,
		items: calls.map((row) => callFact(row.trace)),
	};
}

/** The compact fact for one nested call: what a row lists, without the result text. */
export function callFact(trace: EvalTrace): EvalCall {
	return {
		...(trace.toolCallId === undefined ? {} : { id: trace.toolCallId }),
		name: trace.name,
		summary: trace.summary,
		durationMs: trace.durationMs,
		failed: trace.error !== undefined,
		...(trace.resolved === true ? { resolved: true } : {}),
	};
}

function readCallItems(raw: unknown): EvalCall[] {
	if (!Array.isArray(raw)) return [];
	const items: EvalCall[] = [];
	for (const entry of raw) {
		if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.failed !== "boolean")
			continue;
		items.push({
			name: entry.name as EvalNestedTrace["name"],
			summary: typeof entry.summary === "string" ? entry.summary : "",
			durationMs: typeof entry.durationMs === "number" ? entry.durationMs : 0,
			failed: entry.failed,
			...(entry.resolved === true ? { resolved: true } : {}),
			...(typeof entry.id === "string" ? { id: entry.id } : {}),
		});
	}
	return items;
}

function readTrace(raw: unknown): EvalTrace | undefined {
	if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.text !== "string")
		return undefined;
	return {
		name: raw.name as EvalNestedTrace["name"],
		text: raw.text,
		summary: typeof raw.summary === "string" ? raw.summary : "",
		durationMs: typeof raw.durationMs === "number" ? raw.durationMs : 0,
		...(typeof raw.error === "string" ? { error: raw.error } : {}),
		...(typeof raw.toolCallId === "string" ? { toolCallId: raw.toolCallId } : {}),
		...(raw.resolved === true ? { resolved: true } : {}),
	};
}

/**
 * The rich frame of one python_eval execution, owned by this package.
 *
 * The call row carries the cell source; the result row carries the cell transcript, with the
 * kernel's namespace report muted, `display:`/`result:` prefixes on values, and one header row per
 * nested tool call. A generic UI shell draws the frame and interaction around these facts.
 */
export function createPythonEvalPresentation(
	args: unknown,
	result: AgentToolResult<unknown> | undefined,
	theme: Theme,
	context: ToolPresentationContext,
): ToolPresentation {
	const parsed = isRecord(args) ? args : undefined;
	// The request is copied as the model sent it; trimming and highlighting belong to the display.
	const rawCode = typeof parsed?.code === "string" ? parsed.code : "";
	const code = rawCode.trim();
	const facts = result === undefined ? undefined : readEvalDetails(result.details);
	// Calls come from the fact, not from the rows: the preview caps rows, and a cell that printed past
	// the cap must not report fewer calls than it made, nor list none of them.
	const calls = facts?.calls ?? { total: 0, failed: 0, resolved: 0, items: [] };
	const isError = context.isError || result?.isError === true;
	const selfFailed = (isError || facts?.error !== undefined) && calls.failed === 0;

	const status: ToolPresentationStatus | undefined =
		result === undefined
			? undefined
			: resolveContainerStatus({
					isError,
					isPartial: context.isPartial,
					hasChildren: calls.total > 0,
					selfFailed,
				});

	// The frame appends the duration, so the summary carries only what the cell itself says. The
	// deadline is not repeated here either: it is the same 180s for nearly every cell, and a row that
	// always names it costs the width a reader needs for the result.
	const options = parsed?.reset === true ? ["(reset)"] : [];
	// Before any result exists the row still has to say what the cell will run.
	const summary =
		result === undefined
			? [firstCodeLine(code) || "(empty)", ...options].join(" · ")
			: [
					...options,
					...callStats(calls.resolved, calls.failed),
					// An unresolved call stays visible but is not counted as a tool call.
					...(calls.total > calls.resolved
						? [`${String(calls.total - calls.resolved)} unknown`]
						: []),
					...(calls.total === 0 && facts !== undefined && facts.rows.length > 0
						? [`${String(facts.rows.length)} ${facts.rows.length === 1 ? "row" : "rows"}`]
						: []),
				]
					.filter((part): part is string => part !== undefined && part !== "")
					.join(" · ");

	const transcript = transcriptRows(facts, result, isError, theme);
	const source = inputSection(code, theme);
	const sections: ToolPresentationSection[] = [
		...(source === undefined ? [] : [source]),
		...(transcript.length === 0
			? []
			: [{ railToken: isError ? ("error" as const) : ("success" as const), content: transcript }]),
	];

	const children: ToolPresentationChild[] = calls.items
		.filter((call) => call.resolved === true)
		.map((call) => ({
			...(call.id === undefined ? {} : { id: call.id }),
			title: call.name,
			...(call.summary === "" ? {} : { summary: call.summary }),
			status: call.failed ? ("error" as const) : ("ok" as const),
			durationMs: call.durationMs,
			resolved: true,
		}));
	const output = result === undefined ? "" : stripTerminalSequences(agentResultText(result));
	return {
		summary,
		...(status === undefined ? {} : { status }),
		// A cell reports rows as soon as they exist, so its own frame replaces the call row.
		replaceCallOnPartial: true,
		request: code,
		sections,
		// Zero is a real answer: a cell whose calls all stayed unresolved made no proven tool call.
		...(calls.total === 0 ? {} : { childCount: calls.resolved }),
		// The frame draws the interactive board from these facts; this package still owns them.
		...(calls.items.length === 0 ? {} : { children }),
		...(code === ""
			? output === ""
				? {}
				: { copy: { primary: output } }
			: {
					copy: {
						primary: rawCode,
						full: output === "" ? rawCode : `${rawCode}\n---\n${output}`,
					},
				}),
		output,
	};
}

/** The cell source, highlighted as Python. Empty source yields no section at all. */
function inputSection(code: string, theme: Theme): ToolPresentationSection | undefined {
	if (code === "") return undefined;
	// Display only: the source is model-controlled, while its copy stays byte-exact.
	const clean = stripTerminalSequences(code).replace(/\r/g, "").replace(/\t/g, "  ");
	let lines: string[];
	try {
		lines = highlightCode(clean, "python");
	} catch {
		lines = clean.split("\n").map((line) => theme.fg("mdCode", line));
	}
	return { railToken: "muted", content: lines };
}

/**
 * The transcript the result row shows. A cell with persisted details renders its rows; one without
 * them (an interrupted call, an older session) falls back to the plain text it produced.
 */
function transcriptRows(
	facts: EvalFrameDetails | undefined,
	result: AgentToolResult<unknown> | undefined,
	isError: boolean,
	theme: Theme,
): readonly string[] {
	if (facts === undefined) {
		if (result === undefined) return [];
		const text = stripTerminalSequences(agentResultText(result));
		if (text === "") return [];
		return text.split("\n").map((line) => theme.fg(isError ? "error" : "dim", line));
	}
	const rows: string[] = [];
	for (const row of facts.rows) {
		switch (row.kind) {
			case "tool":
				rows.push(formatToolRow(callFact(row.trace), theme));
				break;
			case "state":
				// The namespace report is metadata about the cell, not its output, so it stays muted.
				rows.push(theme.fg("muted", row.text));
				break;
			case "display":
			case "result": {
				const prefix = theme.fg("dim", `${row.kind}:`);
				const lines = row.text.replace(/\r/g, "").split("\n");
				for (const [index, line] of lines.entries()) {
					const text = theme.fg("dim", line);
					rows.push(index === 0 ? `${prefix} ${text}` : `  ${text}`);
				}
				break;
			}
			default:
				if (row.text === "") break;
				rows.push(
					...row.text
						.replace(/\r/g, "")
						.split("\n")
						.map((line) => theme.fg(isError ? "error" : "dim", line)),
				);
		}
	}
	return rows;
}

/**
 * One nested call: status glyph, tool name, its argument summary, and its duration. This package
 * cannot depend on the UI frame, so it mirrors the shared semantic table: a bash command is the
 * row's content, a read summary is a path, and everything else is secondary text.
 */
function formatToolRow(call: EvalCall, theme: Theme): string {
	const glyph = call.failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const title = theme.fg("toolTitle", theme.bold(call.name));
	const summary =
		call.summary === ""
			? ""
			: call.name === "bash"
				? ` ${theme.fg("toolTitle", theme.bold(call.summary))}`
				: ` ${theme.fg(call.name === "read" ? "accent" : "dim", call.summary)}`;
	const duration = formatDuration(call.durationMs) ?? "";
	const meta =
		duration === ""
			? ""
			: `${summary === "" ? " " : theme.fg("dim", " · ")}${theme.fg("dim", duration)}`;
	return `${glyph} ${title}${summary}${meta}`;
}

/**
 * The part of a nested call's arguments that reads as a summary, bounded to one row. Computed once
 * when the cell ends, so the frame row and the child row in a group cannot summarize differently.
 */
export function summarizeTraceArgs(args: unknown): string {
	const raw = typeof args === "string" ? args : isRecord(args) ? firstArgumentText(args) : "";
	const clean = stripTerminalSequences(raw.trim().replace(/[\r\n\t]+/g, " "));
	return clean.length > MAX_SUMMARY_CHARS ? `${clean.slice(0, MAX_SUMMARY_CHARS - 3)}…` : clean;
}

function firstArgumentText(args: Record<string, unknown>): string {
	for (const key of ["command", "path", "file_path", "pattern", "query", "glob", "url"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return "";
}

/** A container reports no status of its own once it has child rows to speak for it. */
function resolveContainerStatus(params: {
	readonly isError: boolean;
	readonly isPartial: boolean;
	readonly hasChildren: boolean;
	readonly selfFailed: boolean;
}): ToolPresentationStatus {
	if (params.selfFailed) return "error";
	if (params.hasChildren) return "none";
	if (params.isPartial) return "running";
	return params.isError ? "error" : "ok";
}

function callStats(total: number, failures: number): string[] {
	if (total === 0) return [];
	if (failures > 0) return [`${String(total - failures)} ok`, `${String(failures)} failed`];
	return [`${String(total)} ${total === 1 ? "call" : "calls"}`];
}

/** One bounded line naming what a cell will run, used by the plain native call row. */
export function firstCodeLine(code: string): string {
	const [line = ""] = code.split("\n");
	const trimmed = line.trim();
	return trimmed.length <= MAX_FIRST_LINE_CHARS
		? trimmed
		: `${trimmed.slice(0, MAX_FIRST_LINE_CHARS)}…`;
}
