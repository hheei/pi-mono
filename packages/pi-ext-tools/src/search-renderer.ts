import type {
	AgentToolResult,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Keybinding,
	stripTerminalSequences,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { agentResultText } from "@hheei/pi-ext-core";

const DEFAULT_MAX_BODY_LINES = 20;

import type { GrepDisplayLine, GrepSubmatch, GrepToolDetails } from "./grep.js";

const DIM = "\x1b[2m";
const RST = "\x1b[0m";
const FG_LNUM = "\x1b[38;2;100;100;100m";
const FG_DIM = "\x1b[38;2;80;80;80m";
const FG_RULE = "\x1b[38;2;50;50;50m";
const BG_ADD = "\x1b[48;2;18;42;28m";

function renderDiffOmission(nw: number, signed = true): string {
	const width = Math.max(1, nw);
	const gap = signed ? "  " : " ";
	return ` ${FG_DIM}${"…".padStart(width)}${RST}${gap}${FG_RULE}┊ ${RST}`;
}

function renderCodeGutter(lineNumber: number, numberWidth: number, body: string): string {
	const num = String(lineNumber).padStart(Math.max(1, numberWidth));
	return ` ${FG_LNUM}${num}${RST} ${FG_RULE}│ ${RST}${body}`;
}

export type FindToolDetails = {
	readonly format: "canonical-find";
	readonly candidates: readonly { readonly path: string; readonly matchType?: string }[];
	readonly totalMatched: number;
	readonly totalFiles: number;
	readonly path?: string;
};

type RenderContext = {
	readonly isError: boolean;
	readonly lastComponent: Component | undefined;
	readonly keyText: (keybinding: Keybinding) => string;
};
const TRUNCATION_MARKER = "…";
const FIND_CURSOR = /^cursor:\s+/;
const EMPTY_FIND_BODY = /^(?:No files found matching pattern)?$/;

function grepDetails(value: unknown): GrepToolDetails | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const details = value as Partial<GrepToolDetails>;
	return details.format === "canonical-grep" && Array.isArray(details.display)
		? (details as GrepToolDetails)
		: undefined;
}

const ANSI_SGR = /^\[[0-9;]*m/;

/** One ANSI escape sequence, or one code point, starting at `cursor`. */
function chunkAt(
	text: string,
	cursor: number,
): { readonly text: string; readonly next: number; readonly ansi: boolean } {
	if (text.charCodeAt(cursor) === 0x1b) {
		const ansi = text.slice(cursor).match(ANSI_SGR);
		if (ansi) return { text: ansi[0], next: cursor + ansi[0].length, ansi: true };
	}
	const charLen = (text.codePointAt(cursor) ?? 0) > 0xffff ? 2 : 1;
	return { text: text.slice(cursor, cursor + charLen), next: cursor + charLen, ansi: false };
}

function utf8Boundaries(text: string): ReadonlyMap<number, number> {
	const boundaries = new Map<number, number>();
	let bytes = 0;
	boundaries.set(0, 0);
	for (let i = 0; i < text.length; ) {
		const code = text.codePointAt(i) ?? 0;
		const charLen = code > 0xffff ? 2 : 1;
		const byteLen = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
		bytes += byteLen;
		i += charLen;
		boundaries.set(bytes, i);
	}
	return boundaries;
}

function takeVisible(
	text: string,
	index: number,
	visibleChars: number,
): { readonly slice: string; readonly next: number } {
	let slice = "";
	let taken = 0;
	let cursor = index;
	while (taken < visibleChars && cursor < text.length) {
		const chunk = chunkAt(text, cursor);
		slice += chunk.text;
		cursor = chunk.next;
		taken += chunk.text.length;
	}
	return { slice, next: cursor };
}

function applySgrThroughout(text: string, sgr: string): string {
	if (text === "") return "";
	let out = sgr;
	let cursor = 0;
	while (cursor < text.length) {
		const chunk = chunkAt(text, cursor);
		out += chunk.ansi && chunk.text !== sgr ? `${chunk.text}${sgr}` : chunk.text;
		cursor = chunk.next;
	}
	return out;
}

function overlayGrepSource(
	highlighted: string,
	source: string,
	ranges: readonly { readonly start: number; readonly end: number }[],
	matchSgr: string,
): string {
	const colored =
		stripTerminalSequences(highlighted).length === source.length ? highlighted : source;
	const parts: string[] = [];
	let sourceIndex = 0;
	let colorIndex = 0;
	const push = (slice: string, sgr: string): void => {
		if (slice.length === 0) return;
		parts.push(`${RST}${applySgrThroughout(slice, sgr)}`);
	};
	for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
		if (range.end <= sourceIndex || range.end <= range.start) continue;
		const start = Math.max(range.start, sourceIndex);
		if (start > sourceIndex) {
			const taken = takeVisible(colored, colorIndex, start - sourceIndex);
			push(taken.slice, DIM);
			colorIndex = taken.next;
			sourceIndex = start;
		}
		const match = takeVisible(colored, colorIndex, range.end - sourceIndex);
		push(match.slice, matchSgr);
		colorIndex = match.next;
		sourceIndex = range.end;
	}
	if (sourceIndex < source.length)
		push(takeVisible(colored, colorIndex, source.length - sourceIndex).slice, DIM);
	return `${parts.join("")}${RST}`;
}

function submatchCharRanges(
	source: string,
	submatches: readonly GrepSubmatch[],
): readonly { readonly start: number; readonly end: number }[] {
	// ASCII byte offsets are char offsets, so the map is only needed for multibyte text.
	const boundaries =
		Buffer.byteLength(source, "utf8") === source.length ? undefined : utf8Boundaries(source);
	return submatches.flatMap((range) => {
		if (range.end <= range.start) return [];
		const start = boundaries?.get(range.start);
		const end = boundaries?.get(range.end);
		if (start !== undefined && end !== undefined) return [{ start, end }];
		return range.start >= 0 && range.end <= source.length
			? [{ start: range.start, end: range.end }]
			: [];
	});
}

function renderGrepSource(
	line: Extract<GrepDisplayLine, { type: "match" | "context" }>,
	_theme: Theme,
	lineNumberWidth: number,
	_path: string,
): string {
	const ranges = line.type === "match" ? submatchCharRanges(line.source, line.submatches) : [];
	const body = overlayGrepSource(line.source, line.source, ranges, BG_ADD);
	return renderCodeGutter(line.lineNumber, lineNumberWidth, body);
}

function renderGrepLine(
	line: GrepDisplayLine,
	theme: Theme,
	lineNumberWidth: number,
	path: string,
): string {
	switch (line.type) {
		case "path":
			return line.text.startsWith(TRUNCATION_MARKER)
				? `${theme.fg("dim", TRUNCATION_MARKER)}${theme.fg("text", line.text.slice(TRUNCATION_MARKER.length))}`
				: theme.fg("text", line.text);
		case "match":
		case "context":
			return renderGrepSource(line, theme, lineNumberWidth, path);
		case "omission":
			return `${renderDiffOmission(lineNumberWidth, false)}${theme.fg("dim", line.text)}`;
		case "text":
			return theme.fg("dim", line.text);
	}
}

class GrepResultComponent implements Component {
	private lines: readonly string[] = [];
	private theme: Theme;
	private cached: { readonly width: number; readonly rows: string[] } | undefined;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	set(lines: readonly string[], theme: Theme): void {
		this.lines = lines;
		this.theme = theme;
		this.cached = undefined;
	}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.rows;
		const truncation = this.theme.fg("dim", TRUNCATION_MARKER);
		const rows = this.lines.map((line) => truncateToWidth(line, Math.max(1, width), truncation));
		this.cached = { width, rows };
		return rows;
	}

	invalidate(): void {}
}

function grepLineNumberWidth(lines: readonly GrepDisplayLine[], start: number): number {
	let width = 0;
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line?.type === "path") break;
		if (line?.type === "match" || line?.type === "context")
			width = Math.max(width, String(line.lineNumber).length);
	}
	return width;
}

export function renderGrepResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const details = grepDetails(result.details);
	if (context.isError || details === undefined) {
		text.setText(
			context.isError ? theme.fg("error", agentResultText(result)) : agentResultText(result),
		);
		return text;
	}
	const display = details.display.filter(
		(line, index) =>
			!(line.type === "text" && /^No matches found\.?$/.test(line.text)) &&
			(index !== 0 ||
				line.type !== "text" ||
				!/^\d+(?: fuzzy)? matches in \d+ files$/.test(line.text)),
	);
	const collapsedLimit =
		display.length > DEFAULT_MAX_BODY_LINES ? DEFAULT_MAX_BODY_LINES - 1 : DEFAULT_MAX_BODY_LINES;
	const visible = options.expanded ? display : display.slice(0, collapsedLimit);
	let lineNumberWidth = 1;
	let path = "";
	const rendered = visible.map((line, index) => {
		if (line.type === "path") {
			lineNumberWidth = Math.max(1, grepLineNumberWidth(visible, index));
			path = line.text;
		}
		return renderGrepLine(line, theme, lineNumberWidth, path);
	});
	const lines = rendered;
	if (!options.expanded && display.length > visible.length)
		lines.push(
			theme.fg("dim", `… (${display.length - visible.length} more lines, expand to show)`),
		);
	const component =
		context.lastComponent instanceof GrepResultComponent
			? context.lastComponent
			: new GrepResultComponent(theme);
	component.set(lines, theme);
	return component;
}

function findDetails(value: unknown): FindToolDetails | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const details = value as Partial<FindToolDetails>;
	return details.format === "canonical-find" &&
		Array.isArray(details.candidates) &&
		typeof details.totalMatched === "number" &&
		typeof details.totalFiles === "number"
		? (details as FindToolDetails)
		: undefined;
}

function findGroup(matchType: string | undefined): "fuzzy files" | "fuzzy paths" {
	return matchType === "fuzzy_path" || matchType === "ffp" ? "fuzzy paths" : "fuzzy files";
}

type FindBodyLine =
	| { readonly kind: "heading"; readonly text: string }
	| { readonly kind: "directory"; readonly text: string }
	| { readonly kind: "path"; readonly text: string }
	| { readonly kind: "omission"; readonly text: string }
	| { readonly kind: "blank"; readonly text: "" };

function parentDirectory(path: string): string | undefined {
	const separator = path.lastIndexOf("/");
	return separator > 0 ? path.slice(0, separator) : undefined;
}

function findBodyLines(details: FindToolDetails): readonly FindBodyLine[] {
	const groups = new Map<"fuzzy files" | "fuzzy paths", FindToolDetails["candidates"]>();
	for (const group of ["fuzzy files", "fuzzy paths"] as const)
		groups.set(
			group,
			details.candidates.filter((candidate) => findGroup(candidate.matchType) === group),
		);
	const lines: FindBodyLine[] = [];
	for (const [group, candidates] of groups) {
		if (candidates.length === 0) continue;
		if (lines.length > 0) lines.push({ kind: "blank", text: "" });
		lines.push({ kind: "heading", text: `${group}:` });
		const byDirectory = new Map<string, string[]>();
		for (const candidate of candidates) {
			const directory = parentDirectory(candidate.path);
			if (directory === undefined) continue;
			const existing = byDirectory.get(directory);
			if (existing === undefined) byDirectory.set(directory, [candidate.path]);
			else existing.push(candidate.path);
		}
		const emittedDirectories = new Set<string>();
		for (const candidate of candidates) {
			const directory = parentDirectory(candidate.path);
			const grouped = directory === undefined ? undefined : byDirectory.get(directory);
			if (directory === undefined || grouped === undefined || grouped.length <= 1) {
				lines.push({ kind: "path", text: candidate.path });
				continue;
			}
			if (emittedDirectories.has(directory)) continue;
			emittedDirectories.add(directory);
			lines.push({ kind: "directory", text: `${directory}/` });
			for (const path of grouped)
				lines.push({ kind: "path", text: path.slice(directory.length + 1) });
		}
	}
	return lines;
}

function renderFindBody(lines: readonly FindBodyLine[], theme: Theme): string[] {
	return lines.map((line) => theme.fg(line.kind === "omission" ? "dim" : "text", line.text));
}

export function renderFindResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
	const details = findDetails(result.details);
	if (context.isError || details === undefined) {
		const text = context.isError
			? theme.fg("error", agentResultText(result))
			: agentResultText(result)
					.split("\n")
					.filter((line) => !FIND_CURSOR.test(line))
					.join("\n");
		if (!context.isError && EMPTY_FIND_BODY.test(text.trim())) {
			const empty = new GrepResultComponent(theme);
			empty.set([], theme);
			return empty;
		}
		return new Text(text, 0, 0);
	}
	const body = findBodyLines(details);
	const visible = options.expanded ? [...body] : body.slice(0, DEFAULT_MAX_BODY_LINES - 1);
	if (!options.expanded && body.length > visible.length)
		visible.push({
			kind: "omission",
			text: `… (${body.length - visible.length} more lines, ${context.keyText("app.tools.expand")} to expand)`,
		});
	const component = new GrepResultComponent(theme);
	component.set(renderFindBody(visible, theme), theme);
	return component;
}
