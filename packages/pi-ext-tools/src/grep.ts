import { relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import {
	createOptionalToolRenderers,
	errorMessage,
	isRecord,
	runCommand,
	SEARCH_TIMEOUT_MS,
	textToolResult,
	throwIfAborted,
} from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { renderGrepResult } from "./search-renderer.js";
import { GREP_TIMEOUT_RECOVERY } from "./search-timeout.js";

function accessDeniedDiagnostics(stderr: string): readonly string[] | undefined {
	const diagnostics = stderr
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
	if (diagnostics.length === 0) return undefined;
	return diagnostics.every((diagnostic) =>
		/(?:\bEACCES\b|\bEPERM\b|\(os error (?:1|13)\)|permission denied|operation not permitted)/iu.test(
			diagnostic,
		),
	)
		? diagnostics
		: undefined;
}

const DEFAULT_LIMIT = 100;
const MAX_ROWS = 2_000;
const MAX_BYTES = 50 * 1024;
const MAX_MATCHES_PER_FILE = 25;
const MAX_DISPLAY_MATCHES = 200;
const MAX_LINE_CHARS = 80;
const GREP_DESCRIPTION = "Search file contents with ripgrep.";
const GREP_PROMPT_SNIPPET = "Search file contents for patterns (respects .gitignore)";
const GREP_PROMPT_GUIDELINES: string[] = [
	"grep: if search times out, narrow path/glob or use a more specific pattern.",
];
const GREP_PARAMETER_DESCRIPTIONS = {
	pattern:
		"ripgrep regex after JSON decoding, same bytes as `rg PATTERN`. Exact text: set literal=true. `{` `(` `)` `.` need exactly one backslash in that decoded string.",
	path: "Directory or file to search (default: current directory)",
	glob: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
	ignoreCase: "Case-insensitive search (default: false)",
	literal: "Treat pattern as literal string instead of regex (default: false)",
	context: "Number of lines to show before and after each match (default: 0)",
	limit: "Maximum number of matches to return (default: 100)",
} as const;
const RG_REGEX_PARSE_HINT =
	"Hint: `{` starts a quantifier. For a literal brace, the decoded pattern needs exactly one backslash before `{`. Exact text: retry with literal=true.";

const schema = Type.Object({
	pattern: Type.String({ description: GREP_PARAMETER_DESCRIPTIONS.pattern }),
	path: Type.Optional(Type.String({ description: GREP_PARAMETER_DESCRIPTIONS.path })),
	glob: Type.Optional(Type.String({ description: GREP_PARAMETER_DESCRIPTIONS.glob })),
	ignoreCase: Type.Optional(Type.Boolean({ description: GREP_PARAMETER_DESCRIPTIONS.ignoreCase })),
	literal: Type.Optional(Type.Boolean({ description: GREP_PARAMETER_DESCRIPTIONS.literal })),
	context: Type.Optional(Type.Number({ description: GREP_PARAMETER_DESCRIPTIONS.context })),
	limit: Type.Optional(Type.Number({ description: GREP_PARAMETER_DESCRIPTIONS.limit })),
});

type GrepParams = {
	readonly pattern: string;
	readonly path?: string;
	readonly glob?: string;
	readonly ignoreCase?: boolean;
	readonly literal?: boolean;
	readonly context?: number;
	readonly limit?: number;
};

export type GrepSubmatch = {
	readonly start: number;
	readonly end: number;
	readonly text: string;
};

export type GrepEvent =
	| {
			readonly type: "match";
			readonly path: string;
			readonly lines: string;
			readonly lineNumber: number;
			readonly absoluteOffset?: number;
			readonly submatches: readonly GrepSubmatch[];
			readonly approximate?: boolean;
	  }
	| {
			readonly type: "context";
			readonly path: string;
			readonly lines: string;
			readonly lineNumber: number;
			readonly absoluteOffset?: number;
	  };

export type GrepDisplayLine =
	| { readonly type: "text" | "path" | "omission"; readonly text: string }
	| {
			readonly type: "match";
			readonly lineNumber: number;
			readonly text: string;
			readonly source: string;
			readonly visibleStart: number;
			readonly visibleEnd: number;
			readonly truncatedLeft: boolean;
			readonly truncatedRight: boolean;
			readonly submatches: readonly GrepSubmatch[];
			readonly approximate?: boolean;
	  }
	| {
			readonly type: "context";
			readonly lineNumber: number;
			readonly text: string;
			readonly source: string;
			readonly visibleStart: number;
			readonly visibleEnd: number;
			readonly truncatedLeft: boolean;
			readonly truncatedRight: boolean;
	  };

export type GrepIncomplete = {
	readonly reason: "access_denied";
	readonly diagnostics: readonly string[];
	readonly noSearchablePaths: boolean;
};

export type GrepToolDetails = {
	readonly format: "canonical-grep";
	readonly engine: "rg";
	readonly events: readonly GrepEvent[];
	readonly display: readonly GrepDisplayLine[];
	readonly totalMatched: number;
	readonly totalFiles: number;
	readonly totalLines: number;
	readonly cap: {
		readonly rows: number;
		readonly bytes: number;
		readonly maxRows: number;
		readonly maxBytes: number;
		readonly truncated: boolean;
	};
	readonly recovery: { readonly message: string };
	readonly timedOut?: boolean;
	readonly path?: string;
	readonly persistent?: boolean;
	readonly incomplete?: GrepIncomplete;
};

type CanonicalResult = {
	readonly events: readonly GrepEvent[];
	readonly totalMatched: number;
	readonly cap: GrepToolDetails["cap"];
	readonly timedOut?: boolean;
	readonly incomplete?: GrepIncomplete;
};

type FullOutput = {
	readonly text: string;
	readonly eventLines: ReadonlyMap<GrepEvent, number>;
};

function normalizedLimit(limit: number | undefined): number {
	return Math.max(1, Math.min(Math.floor(limit ?? DEFAULT_LIMIT), MAX_ROWS));
}

function normalizedContext(context: number | undefined): number {
	return Math.max(0, Math.floor(context ?? 0));
}

function normalizeGrepParams(params: GrepParams): GrepParams {
	return params.path?.trim() === "" ? { ...params, path: "." } : params;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function textAt(value: unknown): string | undefined {
	const record = object(value);
	return typeof record?.text === "string" ? record.text : undefined;
}

function grepIncomplete(value: unknown): GrepIncomplete | undefined {
	const incomplete = object(value)?.incomplete;
	const record = object(incomplete);
	if (record?.reason !== "access_denied" || typeof record.noSearchablePaths !== "boolean")
		return undefined;
	if (
		!Array.isArray(record.diagnostics) ||
		!record.diagnostics.every((line) => typeof line === "string")
	)
		return undefined;
	return {
		reason: "access_denied",
		diagnostics: record.diagnostics,
		noSearchablePaths: record.noSearchablePaths,
	};
}

export function grepHasNoSearchablePaths(value: unknown): boolean {
	return grepIncomplete(value)?.noSearchablePaths === true;
}

function numberAt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function rgEvent(value: unknown, fallbackPath: string): GrepEvent | undefined {
	const event = object(value);
	const type = event?.type;
	if (type !== "match" && type !== "context") return undefined;
	const data = object(event?.data);
	const rawPath = textAt(data?.path);
	const path = rawPath === undefined || rawPath === "<stdin>" ? fallbackPath : rawPath;
	const lines = textAt(data?.lines);
	const lineNumber = numberAt(data?.line_number);
	if (lines === undefined || lineNumber === undefined || lineNumber < 1) return undefined;
	const absoluteOffset = numberAt(data?.absolute_offset);
	if (type === "context") {
		return {
			type,
			path,
			lines: lines.replace(/\n$/, ""),
			lineNumber,
			...(absoluteOffset === undefined ? {} : { absoluteOffset }),
		};
	}
	const submatches = Array.isArray(data?.submatches)
		? data.submatches.flatMap((candidate) => {
				const item = object(candidate);
				const start = numberAt(item?.start);
				const end = numberAt(item?.end);
				const text = textAt(item?.match);
				return start === undefined || end === undefined || end < start || text === undefined
					? []
					: [{ start, end, text }];
			})
		: [];
	return {
		type,
		path,
		lines: lines.replace(/\n$/, ""),
		lineNumber,
		...(absoluteOffset === undefined ? {} : { absoluteOffset }),
		submatches,
	};
}

function searchedAnyFile(stdout: string): boolean {
	return stdout.split("\n").some((line) => {
		try {
			const event = object(JSON.parse(line) as unknown);
			if (event?.type !== "summary") return false;
			const stats = object(object(event.data)?.stats);
			return (numberAt(stats?.searches) ?? 0) > 0;
		} catch {
			return false;
		}
	});
}

function capEvents(events: readonly GrepEvent[], limit: number, context: number): CanonicalResult {
	const selectedMatches: GrepEvent[] = [];
	for (const event of events) {
		if (event.type === "match" && selectedMatches.length < limit) selectedMatches.push(event);
	}
	const matchLines = new Map<string, number[]>();
	for (const event of selectedMatches) {
		const lines = matchLines.get(event.path) ?? [];
		lines.push(event.lineNumber);
		matchLines.set(event.path, lines);
	}
	const selectedSet = new Set(selectedMatches);
	const relevant = events.filter((event) => {
		if (event.type === "match") return selectedSet.has(event);
		return (matchLines.get(event.path) ?? []).some(
			(lineNumber) => Math.abs(lineNumber - event.lineNumber) <= context,
		);
	});
	const capped: GrepEvent[] = [];
	let bytes = 0;
	for (const event of relevant) {
		const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
		if (capped.length >= MAX_ROWS || bytes + eventBytes > MAX_BYTES) break;
		capped.push(event);
		bytes += eventBytes;
	}
	return {
		events: capped,
		totalMatched: capped.filter((event) => event.type === "match").length,
		cap: {
			rows: capped.length,
			bytes,
			maxRows: MAX_ROWS,
			maxBytes: MAX_BYTES,
			truncated: capped.length < relevant.length,
		},
	};
}

function rgOrder(events: readonly GrepEvent[]): GrepEvent[] {
	const groups = new Map<string, GrepEvent[]>();
	for (const event of events) {
		const group = groups.get(event.path);
		if (group) group.push(event);
		else groups.set(event.path, [event]);
	}
	return [...groups.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.flatMap(([, group]) => group);
}

function incompleteSummary(incomplete: GrepIncomplete): string {
	return `Results may be incomplete: skipped ${incomplete.diagnostics.length} inaccessible path${
		incomplete.diagnostics.length === 1 ? "" : "s"
	}.`;
}

function fullOutput(
	events: readonly GrepEvent[],
	incomplete: GrepIncomplete | undefined,
): FullOutput {
	const lines: string[] = [];
	const eventLines = new Map<GrepEvent, number>();
	const groups = new Map<string, GrepEvent[]>();
	for (const event of events) {
		const group = groups.get(event.path);
		if (group) group.push(event);
		else groups.set(event.path, [event]);
	}
	for (const [index, [path, group]] of [...groups.entries()].entries()) {
		if (index > 0) lines.push("");
		lines.push(path);
		for (const event of group) {
			lines.push(`${event.lineNumber}${event.type === "match" ? ":" : "-"}${event.lines}`);
			eventLines.set(event, lines.length);
		}
	}
	if (incomplete !== undefined) {
		if (lines.length > 0) lines.push("");
		lines.push(incompleteSummary(incomplete), ...incomplete.diagnostics);
	}
	return {
		text: lines.length === 0 ? "No matches found" : lines.join("\n"),
		eventLines,
	};
}

function compactPath(path: string): string {
	if (Array.from(path).length <= MAX_LINE_CHARS) return path;
	const parts = path.split("/");
	let tail = parts.pop() ?? path;
	while (parts.length > 0 && Array.from(`…/${parts.at(-1)}/${tail}`).length <= MAX_LINE_CHARS) {
		tail = `${parts.pop()}/${tail}`;
	}
	return `…/${tail}`;
}

function pathRelativeToSearch(eventPath: string, from: string, cwd: string): string {
	const rel = relative(from, resolve(cwd, eventPath)).split(sep).join("/");
	if (rel === "" || rel === ".") return "";
	if (rel === ".." || rel.startsWith("../")) return eventPath.replaceAll("\\", "/");
	return rel;
}

function displayEvent(event: GrepEvent): GrepDisplayLine {
	const bytes = Buffer.byteLength(event.lines, "utf8");
	if (event.type === "context")
		return {
			type: "context",
			lineNumber: event.lineNumber,
			text: event.lines,
			source: event.lines,
			visibleStart: 0,
			visibleEnd: bytes,
			truncatedLeft: false,
			truncatedRight: false,
		};
	return {
		type: "match",
		lineNumber: event.lineNumber,
		text: event.lines,
		source: event.lines,
		visibleStart: 0,
		visibleEnd: bytes,
		truncatedLeft: false,
		truncatedRight: false,
		submatches: event.submatches,
		...(event.approximate ? { approximate: true } : {}),
	};
}

function rangeFor(
	events: readonly GrepEvent[],
	full: FullOutput,
): { start: number; end: number } | undefined {
	const lines = events.flatMap((event) => {
		const line = full.eventLines.get(event);
		return line === undefined ? [] : [line];
	});
	if (lines.length === 0) return undefined;
	return { start: Math.min(...lines), end: Math.max(...lines) };
}

function compactOutput(
	canonical: CanonicalResult,
	full: FullOutput,
	context: number,
	searchPath: string | undefined,
	cwd: string,
): readonly GrepDisplayLine[] {
	if (canonical.totalMatched === 0) {
		const empty = canonical.timedOut
			? [{ type: "text" as const, text: GREP_TIMEOUT_RECOVERY }]
			: [];
		return canonical.incomplete === undefined
			? empty
			: [
					...empty,
					{ type: "text" as const, text: incompleteSummary(canonical.incomplete) },
					...canonical.incomplete.diagnostics.map((text) => ({ type: "text" as const, text })),
				];
	}
	const fuzzy = canonical.events.some((event) => event.type === "match" && event.approximate);
	const files = new Set(canonical.events.map((event) => event.path)).size;
	const display: GrepDisplayLine[] = [
		{
			type: "text",
			text: `${canonical.totalMatched}${fuzzy ? " fuzzy" : ""} matches in ${files} files`,
		},
	];
	const groups = new Map<string, GrepEvent[]>();
	for (const event of canonical.events) {
		const group = groups.get(event.path);
		if (group) group.push(event);
		else groups.set(event.path, [event]);
	}
	let shown = 0;
	const searchFrom = resolve(cwd, searchPath?.trim() ? searchPath.trim() : ".");
	const entries = [...groups.entries()];
	for (let fileIndex = 0; fileIndex < entries.length; fileIndex += 1) {
		const [path, events] = entries[fileIndex] ?? [];
		if (path === undefined || events === undefined) continue;
		const matches = events.filter((event) => event.type === "match");
		if (shown >= MAX_DISPLAY_MATCHES) {
			const omitted = entries.slice(fileIndex).flatMap(([, remaining]) => remaining);
			const range = rangeFor(omitted, full);
			const files = entries.length - fileIndex;
			if (range)
				display.push({
					type: "omission",
					text: `+${files} files omitted; narrow the path or increase the limit to inspect them`,
				});
			break;
		}
		const allowed = Math.min(MAX_MATCHES_PER_FILE, MAX_DISPLAY_MATCHES - shown);
		const visibleMatches = matches.slice(0, allowed);
		if (visibleMatches.length === 0) continue;
		const heading = compactPath(pathRelativeToSearch(path, searchFrom, cwd));
		if (heading !== "") display.push({ type: "path", text: heading });
		const matchSet = new Set(visibleMatches);
		const matchLineNumbers = visibleMatches.map((match) => match.lineNumber);
		const visibleLines = new Set<number>();
		for (const event of events) {
			for (const lineNumber of matchLineNumbers) {
				if (Math.abs(lineNumber - event.lineNumber) <= context) {
					visibleLines.add(event.lineNumber);
					break;
				}
			}
		}
		for (const event of events) {
			if (event.type === "match" ? matchSet.has(event) : visibleLines.has(event.lineNumber))
				display.push(displayEvent(event));
		}
		shown += visibleMatches.length;
		if (matches.length > visibleMatches.length) {
			const omitted = events.filter((event) => event.type === "match" && !matchSet.has(event));
			const range = rangeFor(omitted, full);
			if (range)
				display.push({
					type: "omission",
					text: `+${matches.length - visibleMatches.length} matches omitted; narrow the path or increase the limit to inspect them`,
				});
		}
	}
	if (canonical.incomplete !== undefined)
		display.push(
			{ type: "text", text: incompleteSummary(canonical.incomplete) },
			...canonical.incomplete.diagnostics.map((text) => ({ type: "text" as const, text })),
		);
	return display;
}

function displayText(display: readonly GrepDisplayLine[]): string {
	return display
		.map((line) =>
			line.type === "match"
				? `${line.lineNumber}:${line.text}`
				: line.type === "context"
					? `${line.lineNumber}-${line.text}`
					: line.text,
		)
		.join("\n");
}

function annotateRgRegexError(error: unknown): unknown {
	if (!(error instanceof Error) || !error.message.includes("regex parse error")) return error;
	if (error.message.includes(RG_REGEX_PARSE_HINT)) return error;
	error.message = `${error.message}\n${RG_REGEX_PARSE_HINT}`;
	return error;
}

async function runRg(
	params: GrepParams,
	cwd: string,
	outputText: string | undefined,
	signal: AbortSignal | undefined,
): Promise<CanonicalResult> {
	const context = normalizedContext(params.context);
	// ponytail: require rg on PATH; add Pi's pinned resolver only if extension must run without system rg.
	const args = ["--json", "--line-number", "--color=never", "--hidden"];
	if (params.ignoreCase) args.push("--ignore-case");
	if (params.literal) args.push("--fixed-strings");
	if (params.glob) args.push("--glob", params.glob);
	if (context > 0) args.push("--context", String(context));
	args.push("--", params.pattern);
	if (outputText === undefined) args.push(params.path ?? ".");
	const collected = await runCommand("rg", args, {
		cwd,
		...(outputText === undefined ? {} : { input: outputText }),
		...(signal === undefined ? {} : { signal }),
		timeoutMs: SEARCH_TIMEOUT_MS,
	}).catch((error: unknown) => {
		throwIfAborted(signal);
		throw new Error(`Failed to run ripgrep: ${errorMessage(error)}`);
	});
	throwIfAborted(signal);
	const stdout = collected.stdout.toString("utf8");
	let incomplete: GrepIncomplete | undefined;
	if (!collected.timedOut && collected.code !== 0 && collected.code !== 1) {
		const stderr = collected.stderr.toString("utf8");
		const diagnostics = collected.code === 2 ? accessDeniedDiagnostics(stderr) : undefined;
		if (diagnostics === undefined)
			throw new Error(stderr.trim() || `ripgrep exited with code ${collected.code}`);
		incomplete = {
			reason: "access_denied",
			diagnostics,
			noSearchablePaths: !searchedAnyFile(stdout),
		};
	}
	throwIfAborted(signal);
	const fallbackPath = params.path ?? ".";
	const events: GrepEvent[] = [];
	let lineStart = 0;
	while (lineStart < stdout.length) {
		const lineEnd = stdout.indexOf("\n", lineStart);
		const line = (
			lineEnd === -1 ? stdout.slice(lineStart) : stdout.slice(lineStart, lineEnd)
		).trim();
		lineStart = lineEnd === -1 ? stdout.length : lineEnd + 1;
		if (line === "") continue;
		try {
			const event = rgEvent(JSON.parse(line) as unknown, fallbackPath);
			if (event !== undefined) events.push(event);
		} catch {
			// Skip unparseable line
		}
	}
	return {
		...capEvents(rgOrder(events), normalizedLimit(params.limit), context),
		...(collected.timedOut ? { timedOut: true } : {}),
		...(incomplete === undefined ? {} : { incomplete }),
	};
}

export function registerGrepTool(pi: ExtensionAPI): ToolDefinition {
	const tool = {
		name: "grep",
		label: "grep",
		description: GREP_DESCRIPTION,
		promptSnippet: GREP_PROMPT_SNIPPET,
		promptGuidelines: GREP_PROMPT_GUIDELINES,
		parameters: schema,
		annotations: {
			readOnlyHint: true,
			idempotentHint: true,
		},
		...createOptionalToolRenderers(pi, "grep", {
			renderCall(args, theme) {
				return new Text(
					`${theme.fg("toolTitle", "grep")} ${isRecord(args) && typeof args.pattern === "string" ? stripTerminalSequences(args.pattern) : ""}`,
					0,
					0,
				);
			},
			renderResult: renderGrepResult,
		}),
		async execute(
			_toolCallId: string,
			params: GrepParams,
			signal: AbortSignal | undefined,
			_onUpdate: undefined,
			context: { cwd: string },
		) {
			params = normalizeGrepParams(params);
			try {
				throwIfAborted(signal);
				const engine: GrepToolDetails["engine"] = "rg";
				const canonical = await runRg(params, context.cwd, undefined, signal);
				if (canonical === undefined) throw new Error("Grep execution did not produce a result.");
				const full = fullOutput(canonical.events, canonical.incomplete);
				const recoveryMessage =
					"Narrow the search path or increase the result limit to inspect more matches.";

				const display = compactOutput(
					canonical,
					full,
					normalizedContext(params.context),
					params.path,
					context.cwd,
				);
				const body = displayText(display);
				const isNoSearchablePaths = canonical.incomplete?.noSearchablePaths === true;
				const resultText = isNoSearchablePaths
					? `Search could not inspect any files due to permission denied.\n${canonical.incomplete?.diagnostics.join("\n") ?? ""}`
					: canonical.timedOut === true && canonical.totalMatched > 0
						? `${body}\n\n${GREP_TIMEOUT_RECOVERY}`
						: body.length > 0
							? body
							: canonical.timedOut
								? GREP_TIMEOUT_RECOVERY
								: "No matches found";
				return {
					...textToolResult(resultText, {
						format: "canonical-grep" as const,
						engine,
						events: canonical.events,
						display,
						totalMatched: canonical.totalMatched,
						totalFiles: new Set(canonical.events.map((event) => event.path)).size,
						totalLines: canonical.events.length,
						cap: canonical.cap,
						recovery: { message: recoveryMessage },
						...(params.path === undefined ? {} : { path: params.path }),
						...(canonical.timedOut ? { timedOut: true } : {}),
						...(canonical.incomplete === undefined ? {} : { incomplete: canonical.incomplete }),
					} satisfies GrepToolDetails),
					...(isNoSearchablePaths ? { isError: true } : {}),
				};
			} catch (error) {
				throw annotateRgRegexError(error);
			}
		},
	};
	pi.registerTool(tool as ToolDefinition);
	return tool as ToolDefinition;
}
