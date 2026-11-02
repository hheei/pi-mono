import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AgentToolResult,
	getLanguageFromPath,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, stripTerminalSequences } from "@earendil-works/pi-tui";
import { isRecord } from "@hheei/pi-ext-core";
import { type DiffLine, type DiffSource, diffStats } from "./diff-view.js";
import { formatTimeoutFact, type NestedCallRecord, parseCallArgs } from "./payload-parser.js";
import type { ToolStatusKind } from "./tool-view.js";
import type { CapturedToolCall } from "./tracker.js";

/**
 * The single owner of Pi's own tool vocabulary in this UI. Concrete tool packages state their own
 * semantics through ext-core's presentation point; this module is the explicit adapter for the tools
 * Pi itself ships (read, write, edit, bash, grep, find, codemode, python_eval and the background and
 * subagent helpers), so a top-level row, a nested row and a restored row read the same facts.
 */

export const EDIT_TOOL_NAME = "edit";
export const WRITE_TOOL_NAME = "write";
export const CODEMODE_OPTIONS_PREFIX = "// @options:";

const CODEMODE_SCRIPT_HEADER =
	/^Script (?:completed|failed)\r?\nWall time ([\d.]+) seconds\r?\nOutput:\r?\n/;

// Pi <1.3 has no exported read-range formatter. Keep this UI summary independent of that export.
function readLineNumber(value: unknown): number | undefined {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim() !== ""
				? Number(value)
				: Number.NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** The read line range as the native row draws it (`:12`, `:12-40`), or empty. */
function readLineRange(args: unknown): string {
	const parsed = parseCallArgs(args);
	const offset = parsed?.offset;
	const limit = parsed?.limit;
	if (offset == null && limit == null) return "";
	const start = offset == null ? 1 : readLineNumber(offset);
	if (start === undefined) return "";
	if (limit == null) return `:${start}`;
	const count = readLineNumber(limit);
	if (count === undefined) return "";
	const end = start + count - 1;
	return `:${start}${end ? `-${end}` : ""}`;
}

function shortenHome(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function toolPath(args: unknown): string {
	const parsed = parseCallArgs(args);
	if (!parsed) return "";
	const val = parsed.path ?? parsed.file_path;
	return typeof val === "string" ? val.trim() : "";
}

/**
 * read's header summary with the tokens the native read row uses: the accent path, linked to the
 * file when the terminal draws OSC 8 links, followed by its warning line range.
 */
function readHeaderSummary(args: unknown, theme: Theme, cwd: string): string {
	const path = toolPath(args);
	if (path === "") return "";
	const label = theme.fg("accent", shortenHome(path));
	const linked = getCapabilities().hyperlinks
		? hyperlink(label, pathToFileURL(resolve(cwd, path)).href)
		: label;
	const range = readLineRange(args);
	return `${linked}${range === "" ? "" : theme.fg("warning", range)}`;
}

/**
 * A native tool's header summary. read states its own tokens, bash keeps its command as the row's
 * content, and the rest state their argument vocabulary; undefined means the frame falls back to the
 * generic argument line.
 */
export interface NativeHeaderSummary {
	readonly summary: string;
	/** Whether the summary already carries the tool's own colors. */
	readonly styled: boolean;
	/** Whether secondary facts stay in the summary or move to the dim meta slot. */
	readonly factsInSummary: boolean;
}

export function nativeHeaderSummary(
	toolName: string,
	args: unknown,
	theme: Theme,
	cwd: string,
): NativeHeaderSummary | undefined {
	if (toolName === "read") {
		const semantic = readHeaderSummary(args, theme, cwd);
		return semantic === "" ? undefined : { summary: semantic, styled: true, factsInSummary: false };
	}
	if (toolName === "bash") {
		return { summary: nativeSummaryArg(toolName, args), styled: false, factsInSummary: false };
	}
	const summary = nativeSummaryArg(toolName, args);
	return summary === "" ? undefined : { summary, styled: false, factsInSummary: true };
}

/** The syntax a tool's request is written in, for display only. */
export function nativeCodeLanguage(toolName: string): string | undefined {
	if (toolName === "bash") return "bash";
	if (toolName === "codemode") return "javascript";
	if (toolName === "python_eval") return "python";
	return undefined;
}

/** The language a tool's own output is written in, when the tool states it through its arguments. */
export function nativeOutputLanguage(toolName: string, args: unknown): string | undefined {
	if (toolName !== "read") return undefined;
	const path = toolPath(args);
	return path === "" ? undefined : getLanguageFromPath(path);
}

/** A deadline is a secondary fact about a call, not part of what the tool was asked to do. */
export function nativeTimeoutFact(toolName: string, args: unknown): string | undefined {
	if (toolName !== "bash") return undefined;
	const timeout = isRecord(args) ? args.timeout : undefined;
	if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return undefined;
	return formatTimeoutFact(timeout * 1000);
}

/** The request block a call is drawn from: its bytes, its syntax, and whether it is a shell command. */
export interface NativeRequestBlock {
	readonly text: string;
	readonly language: string | undefined;
	readonly shell: boolean;
}

export function nativeRequestBlock(
	toolName: string,
	args: unknown,
): NativeRequestBlock | undefined {
	const text = nativeHeavyRequest(toolName, args);
	if (text === undefined) return undefined;
	return { text, language: nativeCodeLanguage(toolName), shell: toolName === "bash" };
}

/**
 * The request a heavy-input tool received, byte for byte: a copy of it must not trim or sanitize
 * model-controlled text. Only an all-whitespace request has no body, so it reads as no request.
 */
export function nativeHeavyRequest(toolName: string, args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	const raw =
		toolName === "bash" && typeof args.command === "string"
			? args.command
			: toolName === "python_eval" && typeof args.code === "string"
				? args.code
				: toolName === "codemode" && typeof args.code === "string"
					? args.code
					: undefined;
	return raw === undefined || raw.trim() === "" ? undefined : raw;
}

export function nativeSummaryArg(toolName: string, args: unknown): string {
	if (toolName === "codemode") {
		return extractCodemodeHeaderFacts(args);
	}
	const parsed = parseCallArgs(args);
	if (!parsed) return "";

	const firstLine = (val: unknown): string => {
		if (typeof val !== "string" || val.trim() === "") return "";
		const clean = stripTerminalSequences(val.trim());
		return clean.split("\n")[0]?.trim() ?? clean;
	};

	switch (toolName) {
		case "bash":
		case "bg_bash_spawn":
			return firstLine(parsed.command);
		case "read":
		case "edit":
		case "write":
		case "ls": {
			const path =
				typeof parsed.path === "string"
					? parsed.path.trim()
					: typeof parsed.file_path === "string"
						? parsed.file_path.trim()
						: "";
			return stripTerminalSequences(path);
		}
		case "grep":
		case "find": {
			const pattern = typeof parsed.pattern === "string" ? parsed.pattern.trim() : "";
			const path = typeof parsed.path === "string" ? parsed.path.trim() : "";
			if (!pattern) return path ? stripTerminalSequences(path) : "";
			const target = path && path !== "." ? ` ${path}` : "";
			return `${pattern}${target}`;
		}
		case "python_eval":
			return firstLine(parsed.code);
		case "bg_bash_get":
		case "bg_bash_stop":
		case "agents_get":
		case "agents_stop":
			return typeof parsed.id === "string" ? parsed.id.trim() : "";
		case "agents_delegate": {
			const agent = typeof parsed.agent === "string" ? parsed.agent.trim() : "";
			const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
			const task = firstLine(parsed.task);
			if (agent && task) return `${agent}: ${task}`;
			return agent || id || task;
		}
		case "tool_search":
			return typeof parsed.query === "string" ? parsed.query.trim() : "";
		default:
			return "";
	}
}

/** codemode states its own options in the request's first line; they are header facts, not content. */
function extractCodemodeHeaderFacts(args: unknown): string {
	if (!isRecord(args)) return "";
	const options: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (key !== "code" && value !== undefined && value !== null) {
			options[key] = value;
		}
	}
	if (typeof args.code === "string") {
		const firstLine = args.code.split(/\r?\n/, 1)[0]?.trim() ?? "";
		if (firstLine.startsWith(CODEMODE_OPTIONS_PREFIX)) {
			try {
				const parsed: unknown = JSON.parse(firstLine.slice(CODEMODE_OPTIONS_PREFIX.length).trim());
				if (isRecord(parsed)) {
					Object.assign(options, parsed);
				}
			} catch {}
		}
	}
	const facts: string[] = [];
	const timeoutMs = typeof options.timeout_ms === "number" ? options.timeout_ms : undefined;
	if (timeoutMs !== undefined) facts.push(formatTimeoutFact(timeoutMs));
	if (typeof options.max_output_tokens === "number") {
		facts.push(`(tokens ${String(options.max_output_tokens)})`);
	}
	if (typeof options.target === "string" && options.target !== "local") {
		facts.push(`(${options.target})`);
	}
	return facts.join(" ");
}

/** The one-row result text a native tool reports, plus the wall time codemode states in its header. */
export function nativeResultText(
	toolName: string,
	result: AgentToolResult<unknown>,
): {
	readonly outputText: string;
	readonly wallTimeSeconds: number | undefined;
} {
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && block.text.trim() !== "") {
			parts.push(block.text);
		}
	}
	const joined = parts.join("\n");
	if (toolName === "codemode") {
		const stripped = stripTerminalSequences(joined);
		const match = CODEMODE_SCRIPT_HEADER.exec(stripped);
		const wallTimeSeconds = match?.[1] !== undefined ? Number.parseFloat(match[1]) : undefined;
		const cleaned = joined.replace(CODEMODE_SCRIPT_HEADER, "").trim();
		return { outputText: cleaned, wallTimeSeconds };
	}
	return { outputText: joined, wallTimeSeconds: undefined };
}

/** Compact nested-row result: a one-line summary plus the status it reports. */
export interface InlinePresentation {
	readonly summary: string;
	readonly status: ToolStatusKind;
}

function fileToolPresentation(
	toolName: string,
	args: unknown,
	_details: unknown,
	isError: boolean,
): InlinePresentation | undefined {
	const path = toolPath(args);
	if (toolName === "read") {
		if (path === "") return undefined;
		return { summary: `${path}${readLineRange(args)}`, status: isError ? "error" : "ok" };
	}
	if (toolName === WRITE_TOOL_NAME) {
		return path === "" ? undefined : { summary: path, status: isError ? "error" : "ok" };
	}
	return undefined;
}

/** Pi native edit persists a unified patch plus the same change as a numbered display diff. */
function nativeDiffSource(details: unknown): DiffSource | undefined {
	if (!isRecord(details)) return undefined;
	if (typeof details.patch === "string" && details.patch.trim() !== "") {
		return { kind: "unifiedPatch", text: details.patch };
	}
	if (typeof details.diff === "string" && details.diff.trim() !== "") {
		return displayDiffSource(details.diff);
	}
	return undefined;
}

function displayDiffSource(diff: string): DiffSource | undefined {
	const hunks: DiffLine[][] = [];
	let current: DiffLine[] = [];
	let pendingBreak = false;
	for (const raw of diff.split(/\r?\n/)) {
		if (raw === "") continue;
		const sign = raw.charAt(0);
		const match = /^ *(\d+)? ?(.*)$/.exec(raw.slice(1));
		const lineNumber = match?.[1];
		if (lineNumber === undefined) {
			pendingBreak = true;
			continue;
		}
		if (pendingBreak && current.length > 0) {
			hunks.push(current);
			current = [];
		}
		pendingBreak = false;
		const kind: DiffLine["kind"] = sign === "+" ? "add" : sign === "-" ? "del" : "ctx";
		current.push({ kind, line: Number(lineNumber), text: match?.[2] ?? "" });
	}
	if (current.length === 0) return undefined;
	hunks.push(current);
	return { kind: "hunks", hunks: hunks.map((lines) => ({ lines })) };
}

/**
 * The name-free part of a summary for tools whose call arguments read well on their own. The tool
 * name is the row's title, so repeating it here would print it twice.
 */
function formatArgumentSummary(
	toolName: string,
	parsed: Record<string, unknown>,
): string | undefined {
	const path =
		typeof parsed.path === "string"
			? parsed.path.trim()
			: typeof parsed.file_path === "string"
				? parsed.file_path.trim()
				: "";

	switch (toolName) {
		case "bash": {
			// The row states model-controlled text: strip before cutting so no half sequence survives.
			const cmd =
				typeof parsed.command === "string" ? stripTerminalSequences(parsed.command.trim()) : "";
			if (!cmd) return undefined;
			return cmd.length > 70 ? `${cmd.slice(0, 67)}…` : cmd;
		}
		case "grep":
		case "find": {
			const pattern = typeof parsed.pattern === "string" ? parsed.pattern.trim() : "";
			if (!pattern) return undefined;
			const target = path && path !== "." ? ` ${path}` : "";
			return `${pattern}${target}`;
		}
		default: {
			const keyArg = nativeSummaryArg(toolName, parsed);
			return keyArg ? keyArg : undefined;
		}
	}
}

/**
 * One compact nested summary for a tool call. Adopts the tool's standard collapsed
 * single-line format when recognized, degrading to undefined so callers can use
 * the default argument rendering.
 */
export function inlinePresentation(
	toolName: string,
	args: unknown,
	details: unknown,
	isError: boolean,
): InlinePresentation | undefined {
	const fileTool = fileToolPresentation(toolName, args, details, isError);
	if (fileTool !== undefined) return fileTool;

	const parsed = parseCallArgs(args);
	if (parsed === undefined) return undefined;

	if (toolName === EDIT_TOOL_NAME) {
		const path = toolPath(parsed);
		const source = isError ? undefined : nativeDiffSource(details);
		const stats = source === undefined ? undefined : diffStats(source);
		if (path === "" && stats === undefined) return undefined;
		return {
			summary:
				stats === undefined
					? path
					: `${path} (+${String(stats.added)} -${String(stats.removed)})`.trim(),
			status: isError ? "error" : "ok",
		};
	}

	const baseSummary = formatArgumentSummary(toolName, parsed);
	if (baseSummary === undefined) return undefined;

	return {
		summary: baseSummary,
		status: isError ? "error" : "ok",
	};
}

/**
 * The request bytes one call carries. A record whose request the session truncated has none: copying
 * the size-limited preview or the summary would present a partial request as the full one.
 */
export function nativeRequestCopy(call: CapturedToolCall | NestedCallRecord): string | undefined {
	if ("argsTruncated" in call && call.argsTruncated === true) return undefined;
	const args = "args" in call ? (call as { args?: unknown }).args : undefined;
	if (!isRecord(args)) return undefined;
	const toolName = "toolName" in call ? call.toolName : (call as { name: string }).name;
	if (toolName === "write" && typeof args.content === "string") return args.content;
	if (toolName === "bash" && typeof args.command === "string") return args.command;
	if ((toolName === "codemode" || toolName === "python_eval") && typeof args.code === "string") {
		return args.code;
	}
	return undefined;
}

function resultText(result: AgentToolResult<unknown> | undefined): string | undefined {
	if (result === undefined || !Array.isArray(result.content)) return undefined;
	const texts = result.content
		.filter(
			(c): c is { type: "text"; text: string } =>
				isRecord(c) && c.type === "text" && typeof c.text === "string",
		)
		.map((c) => c.text);
	return texts.length === 0 ? undefined : texts.join("\n");
}

/** What a child row copies: its own request when it has one, otherwise the result it produced. */
export function extractChildToolCopyText(
	call: CapturedToolCall | NestedCallRecord,
	full?: boolean,
): string {
	const toolName = "toolName" in call ? call.toolName : (call as { name: string }).name;
	const result = "result" in call ? (call as CapturedToolCall).result : undefined;
	const args = "args" in call ? (call as CapturedToolCall).args : undefined;

	const request = nativeRequestCopy(call);
	if (request !== undefined) {
		// write's request is the whole file: its result only confirms the write.
		if (full !== true || toolName === WRITE_TOOL_NAME) return request;
		const output = resultText(result);
		return output === undefined ? request : `${request}\n---\n${output}`;
	}

	if (result !== undefined) {
		const text = resultText(result);
		if (text !== undefined) return text;
	}

	if (args !== undefined) {
		if (typeof args === "string") return args;
		try {
			return JSON.stringify(args, null, 2);
		} catch {
			return String(args);
		}
	}

	// A summary is a summary: without arguments or a result there is no request to copy.
	return "";
}
