import { Buffer } from "node:buffer";
import {
	copyToClipboard as copyToSystemClipboard,
	type Theme,
	type ThemeBg,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { isRecord } from "@hheei/pi-ext-core";
import { surfaceBlock } from "./background.js";

export type FoldLevel = 0 | 1 | 2;

/** Pi native tool surfaces: a failure outranks work in progress, which outranks a settled tool. */
function nativeSurface(status: ToolStatusKind | undefined): ThemeBg {
	if (status === "error") return "toolErrorBg";
	if (status === "running" || status === "streaming") return "toolPendingBg";
	return "toolSuccessBg";
}

export type ToolStatusKind = "streaming" | "running" | "ok" | "warn" | "error" | "none";

export type RailColorToken = "muted" | "dim" | "accent" | "success" | "warning" | "error";

export interface RailSection {
	readonly railToken: RailColorToken;
	readonly content: string | readonly string[] | Component;
	readonly maxLines?: number | undefined;
}

export interface ToolViewHeaderSpec {
	readonly title: string;
	readonly status?: ToolStatusKind | undefined;
	/** The call's own text. Plain unless `summaryStyled` says the tool layer themed it already. */
	readonly summary?: string | undefined;
	/** The summary already carries its semantic tokens; the frame must not recolor it. */
	readonly summaryStyled?: boolean | undefined;
	/** Secondary facts after the summary: duration, timeout. Always dim. */
	readonly meta?: string | undefined;
}

export interface ToolViewCopySpec {
	readonly primary: string;
	readonly full?: string | undefined;
}

/** Micro-contract for child views that can reset their internal expansion. */
export interface Collapsible {
	collapseAll(): void;
}

export function isCollapsible(value: unknown): value is Collapsible {
	return (
		typeof value === "object" &&
		value !== null &&
		"collapseAll" in value &&
		typeof (value as Collapsible).collapseAll === "function"
	);
}

/** One nested call inside a container, reduced to what a summary row and its count need. */
export interface ToolViewChild {
	readonly title: string;
	readonly summary?: string | undefined;
	readonly status?: ToolStatusKind | undefined;
	readonly durationMs?: number | undefined;
}

export interface ToolViewSpec {
	readonly theme: Theme;
	readonly header: ToolViewHeaderSpec;
	readonly collapsedRows?: readonly string[] | Component | (Component & Collapsible) | undefined;
	readonly sections?: readonly RailSection[] | undefined;
	readonly children?: readonly ToolViewChild[] | undefined;
	/** Nested calls the tool made, when the list above is only what fits. */
	readonly childCount?: number | undefined;
	readonly collapsibleChildren?: readonly Collapsible[] | undefined;
	/**
	 * Copy payload, or a getter when the caller owns the decision. Read per render, so a settings
	 * change that hides the control reaches a view the host already holds.
	 */
	readonly copy?: ToolViewCopySpec | (() => ToolViewCopySpec | undefined) | undefined;
	readonly stateHolder?: unknown;
	readonly outputPad?: number | undefined;
	readonly defaultLevel?: FoldLevel | undefined;
	readonly controlledLevel?: FoldLevel | undefined;
	readonly globalExpanded?: boolean | undefined;
	readonly invalidate?: (() => void) | undefined;
	readonly copyToClipboard?: ((text: string) => Promise<void>) | undefined;
	readonly copyFeedbackDurationMs?: number | undefined;
	readonly noRail?: boolean | undefined;
	readonly railToken?: RailColorToken | undefined;
	/**
	 * Pi-native surface: success/error fill plus one padding row, and no leading rail. Read per render,
	 * so a settings change reaches a view the host already holds.
	 */
	readonly background?: (() => boolean) | undefined;
}

/** Public composition entry point for extensions that need the shared view behavior. */
export function createToolView(spec: ToolViewSpec): ToolView {
	return new ToolView(spec);
}

const FOLD_LEVEL_STATE_KEY = "__piExtUiFoldLevel";
const COPIED_UNTIL_STATE_KEY = "__piExtUiCopiedUntil";
const COPY_FAILED_STATE_KEY = "__piExtUiCopyFailed";
const COPY_FEEDBACK_TIMER_KEY = "__piExtUiCopyTimer";
const DEFAULT_MAX_SECTION_LINES = 9;
export const MAX_LEVEL2_SECTION_LINES = 500;
export const MAX_LEVEL2_BYTES = 64 * 1024;
const DEFAULT_COPY_FEEDBACK_MS = 1200;

export function transitionFoldLevel(current: FoldLevel, ctrlKey: boolean): FoldLevel {
	if (current === 0) {
		return ctrlKey ? 2 : 1;
	}
	if (current === 1) {
		return ctrlKey ? 2 : 0;
	}
	return 0;
}

function readFoldLevel(stateHolder: unknown, fallback: FoldLevel): FoldLevel {
	if (!isRecord(stateHolder)) return fallback;
	const raw = stateHolder[FOLD_LEVEL_STATE_KEY];
	return raw === 0 || raw === 1 || raw === 2 ? raw : fallback;
}

function writeFoldLevel(stateHolder: unknown, level: FoldLevel): void {
	if (!isRecord(stateHolder)) return;
	stateHolder[FOLD_LEVEL_STATE_KEY] = level;
}

function isCopiedActive(stateHolder: unknown, localCopiedUntil: number): boolean {
	const now = Date.now();
	if (localCopiedUntil > now) return true;
	if (!isRecord(stateHolder)) return false;
	const until = stateHolder[COPIED_UNTIL_STATE_KEY];
	return typeof until === "number" && until > now;
}

/** A rejected write is feedback of its own; it must not leave the success mark on screen. */
function isCopyFailed(stateHolder: unknown, localFailed: boolean): boolean {
	if (localFailed) return true;
	return isRecord(stateHolder) && stateHolder[COPY_FAILED_STATE_KEY] === true;
}

export const TOOL_SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"] as const;
export const TOOL_SPINNER_INTERVAL_MS = 200;

/**
 * One clock for every live tool, so the phase is shared and never restarts: streaming args and a
 * running execution draw the same frame and differ only in color.
 */
export function toolSpinnerFrame(now = performance.now()): string {
	const at = Math.floor(now / TOOL_SPINNER_INTERVAL_MS) % TOOL_SPINNER_FRAMES.length;
	return TOOL_SPINNER_FRAMES[at] ?? "·";
}

export function formatStatusGlyph(status: ToolStatusKind | undefined, theme: Theme): string {
	switch (status ?? "ok") {
		case "streaming":
			return theme.fg("muted", toolSpinnerFrame());
		case "running":
			return theme.fg("accent", toolSpinnerFrame());
		case "ok":
			return theme.fg("success", "✓");
		case "warn":
			return theme.fg("warning", "!");
		case "error":
			return theme.fg("error", "✗");
		case "none":
			return "";
	}
}

/**
 * The glyph, name, and summary of one tool execution, colored the way every tool row colors them.
 *
 * A container tool draws one of these per child call, and so does the row of a tool that ran on its
 * own. Both must agree, so the token assignment lives here rather than in each board: a board that
 * assembled its own row painted the child's summary as a title, which read as one bright run and
 * made a nested call look unlike the same call at top level. The caller owns the fold pin, the
 * right-aligned action, and the width budget, which are the parts that actually differ.
 */
export function formatToolHeaderText(
	parts: {
		readonly status?: ToolStatusKind | undefined;
		readonly title: string;
		readonly summary?: string | undefined;
		readonly summaryStyled?: boolean | undefined;
		readonly meta?: string | undefined;
	},
	theme: Theme,
): string {
	const statusPart = formatStatusGlyph(parts.status, theme);
	const title = toSingleRow(parts.title);
	const titlePart = theme.fg("toolTitle", theme.bold(title));
	const summaryRaw = parts.summary === undefined ? "" : toSingleRow(parts.summary);
	// A command is the row's content, not its caption: bash states it the way the native shell row
	// does. A summary the tool layer already themed keeps its own tokens.
	const summaryPart =
		summaryRaw === ""
			? ""
			: parts.summaryStyled === true
				? ` ${summaryRaw}`
				: title === "bash"
					? ` ${theme.fg("toolTitle", theme.bold(summaryRaw))}`
					: ` ${theme.fg("dim", summaryRaw)}`;
	const metaRaw = parts.meta === undefined ? "" : toSingleRow(parts.meta);
	const metaPart =
		metaRaw === ""
			? ""
			: `${summaryPart === "" ? " " : theme.fg("dim", " · ")}${theme.fg("dim", metaRaw)}`;
	return `${statusPart === "" ? "" : `${statusPart} `}${titlePart}${summaryPart}${metaPart}`;
}

const truncate = (text: string, width: number): string => truncateToWidth(text, width, "…");

/**
 * Collapses text that must occupy one row: header titles and summaries, board rows, and inline
 * labels. A break inside one of them is a contract violation, because Pi writes one array element
 * as one terminal row: `\n` moves to the next row without clearing it, and a lone `\r` returns to
 * column 0 so later text overwrites the row's start. `visibleWidth` counts both as zero-width, so
 * the host's per-row width guard cannot catch either, and the frame would silently grow taller
 * than the rows it reports.
 */
export function toSingleRow(text: string): string {
	if (!text.includes("\r") && !text.includes("\n") && !text.includes("\t")) {
		return text.trim();
	}
	return text.replace(/[\r\n\t]+/g, " ").trim();
}

/**
 * Splits multi-line content into rows. A lone `\r` is dropped rather than treated as a break so
 * CRLF and progress-style output stay cell-safe, and tabs expand to two spaces so indentation does
 * not depend on the terminal's tab stops.
 */
export function toContentRows(text: string): readonly string[] {
	if (!text.includes("\r") && !text.includes("\t") && !text.includes("\n")) {
		return [text];
	}
	return text.replace(/\r/g, "").replace(/\t/g, "  ").split("\n");
}

/**
 * Resolves a row source into rows that are safe to hand to the host. A string element is one
 * caller-provided label, so `normalize` decides whether it stays a single row or becomes several. A
 * component returns rows it already laid out, so only its breaks are removed and its indentation is
 * preserved.
 */
interface ResolvedRowsResult {
	readonly rows: readonly string[];
	readonly isByteTruncated: boolean;
	readonly totalBytes: number;
}

function truncateUtf8(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf8");
	if (buf.length <= maxBytes) return str;
	let end = maxBytes;
	while (end > 0) {
		const b = buf[end];
		if (b !== undefined && (b & 0xc0) === 0x80) {
			end--;
		} else {
			break;
		}
	}
	if (end > 0) {
		const lead = buf[end - 1];
		if (lead !== undefined) {
			let seqLen = 1;
			if ((lead & 0xe0) === 0xc0) seqLen = 2;
			else if ((lead & 0xf0) === 0xe0) seqLen = 3;
			else if ((lead & 0xf8) === 0xf0) seqLen = 4;
			if (seqLen > 1 && end - 1 + seqLen > maxBytes) {
				end = end - 1;
			}
		}
	}
	return buf.subarray(0, end).toString("utf8");
}

function resolveRows(
	source: string | readonly string[] | Component,
	width: number,
	normalize: (text: string) => readonly string[],
): ResolvedRowsResult {
	if (typeof source === "string") {
		if (source === "") return { rows: [], isByteTruncated: false, totalBytes: 0 };
		const totalBytes = Buffer.byteLength(source, "utf8");
		const isByteTruncated = totalBytes > MAX_LEVEL2_BYTES;
		const bounded = isByteTruncated ? truncateUtf8(source, MAX_LEVEL2_BYTES) : source;
		return { rows: normalize(bounded), isByteTruncated, totalBytes };
	}
	if (Array.isArray(source)) {
		const totalBytes = source.reduce(
			(acc, item) => (typeof item === "string" ? acc + Buffer.byteLength(item, "utf8") : acc),
			0,
		);
		const isByteTruncated = totalBytes > MAX_LEVEL2_BYTES;
		const rows: string[] = [];
		let currentBytes = 0;
		for (const item of source) {
			if (typeof item !== "string") continue;
			if (currentBytes >= MAX_LEVEL2_BYTES) continue;
			const itemBytes = Buffer.byteLength(item, "utf8");
			if (currentBytes + itemBytes > MAX_LEVEL2_BYTES) {
				const remaining = MAX_LEVEL2_BYTES - currentBytes;
				if (remaining > 0) {
					for (const row of normalize(truncateUtf8(item, remaining))) rows.push(row);
				}
				currentBytes = MAX_LEVEL2_BYTES;
			} else {
				currentBytes += itemBytes;
				for (const row of normalize(item)) rows.push(row);
			}
		}
		return { rows, isByteTruncated, totalBytes };
	}
	const rendered = (source as Component).render(width);
	const totalBytes = rendered.reduce((acc, row) => acc + Buffer.byteLength(row, "utf8"), 0);
	const isByteTruncated = totalBytes > MAX_LEVEL2_BYTES;
	const rows: string[] = [];
	let currentBytes = 0;
	for (const row of rendered) {
		if (currentBytes >= MAX_LEVEL2_BYTES) continue;
		const rowBytes = Buffer.byteLength(row, "utf8");
		if (currentBytes + rowBytes > MAX_LEVEL2_BYTES) {
			const remaining = MAX_LEVEL2_BYTES - currentBytes;
			if (remaining > 0) {
				for (const norm of toContentRows(truncateUtf8(row, remaining))) rows.push(norm);
			}
			currentBytes = MAX_LEVEL2_BYTES;
		} else {
			currentBytes += rowBytes;
			for (const norm of toContentRows(row)) rows.push(norm);
		}
	}
	return { rows, isByteTruncated, totalBytes };
}

export class ToolView implements Component {
	readonly #spec: ToolViewSpec;
	#localLevel: FoldLevel;
	#localCopiedUntil = 0;
	#localCopyFailed = false;
	#localTimer: ReturnType<typeof setTimeout> | undefined;
	#liveTimer: ReturnType<typeof setTimeout> | undefined;
	#lastWidth = 80;
	#lastHeight = 0;
	#lastNoRail = false;
	/** Rows the native surface adds above the header. */
	#lastTopPad = 0;
	#cache:
		| {
				readonly width: number;
				readonly level: FoldLevel;
				readonly copied: boolean;
				readonly noRail: boolean;
				readonly surface: string | undefined;
				/** The copy control is drawn from a getter, so hiding it changes the rows it caches. */
				readonly copyVisible: boolean;
				/** Spinner frame the rows were drawn with; a live glyph invalidates the cache. */
				readonly glyph: string;
				readonly lines: string[];
		  }
		| undefined;

	constructor(spec: ToolViewSpec) {
		this.#spec = spec;
		const initial = spec.controlledLevel ?? spec.defaultLevel ?? 0;
		this.#localLevel =
			spec.controlledLevel !== undefined
				? spec.controlledLevel
				: readFoldLevel(spec.stateHolder, initial);

		if (isRecord(spec.stateHolder)) {
			const until = spec.stateHolder[COPIED_UNTIL_STATE_KEY];
			if (typeof until === "number" && until > Date.now()) {
				this.#localCopiedUntil = until;
				this.#localCopyFailed = spec.stateHolder[COPY_FAILED_STATE_KEY] === true;
				const remaining = until - Date.now();
				if (!spec.stateHolder[COPY_FEEDBACK_TIMER_KEY]) {
					const timer = setTimeout(() => {
						this.#localCopiedUntil = 0;
						this.#localCopyFailed = false;
						if (isRecord(this.#spec.stateHolder)) {
							this.#spec.stateHolder[COPIED_UNTIL_STATE_KEY] = 0;
							this.#spec.stateHolder[COPY_FAILED_STATE_KEY] = false;
							this.#spec.stateHolder[COPY_FEEDBACK_TIMER_KEY] = undefined;
						}
						this.#localTimer = undefined;
						this.#cache = undefined;
						this.#spec.invalidate?.();
					}, remaining);
					timer.unref?.();
					this.#localTimer = timer;
					spec.stateHolder[COPY_FEEDBACK_TIMER_KEY] = timer;
				}
			}
		}
	}

	get foldLevel(): FoldLevel {
		if (this.#spec.controlledLevel !== undefined) {
			return this.#spec.controlledLevel;
		}
		return readFoldLevel(this.#spec.stateHolder, this.#localLevel);
	}

	get effectiveLevel(): FoldLevel {
		return this.#spec.globalExpanded === true ? 2 : this.foldLevel;
	}

	get collapsed(): boolean {
		return this.foldLevel === 0;
	}

	/** Current semantic header, without fold/copy controls or body; hidden slots have no summary. */
	get summary(): string | undefined {
		return this.#hidden ? undefined : formatToolHeaderText(this.#spec.header, this.#spec.theme);
	}

	/** Nested calls this tool reported; a hidden slot reports none. */
	get children(): readonly ToolViewChild[] | undefined {
		return this.#hidden ? undefined : this.#spec.children;
	}

	/** How many nested calls the tool made, even when `children` lists only what fits. */
	get childCount(): number | undefined {
		return this.#hidden ? undefined : this.#spec.childCount;
	}

	#collapseChildren(): void {
		const { collapsedRows, collapsibleChildren } = this.#spec;
		if (collapsibleChildren !== undefined) {
			for (const child of collapsibleChildren) {
				child.collapseAll();
			}
		}
		if (isCollapsible(collapsedRows)) {
			collapsedRows.collapseAll();
		}
	}

	setFoldLevel(next: FoldLevel): void {
		const prev = this.foldLevel;
		this.#localLevel = next;
		if (this.#spec.controlledLevel === undefined) {
			writeFoldLevel(this.#spec.stateHolder, next);
		}
		if (prev !== next) {
			this.#cache = undefined;
			this.#collapseChildren();
			this.#spec.invalidate?.();
		}
	}

	setCollapsed(collapsed: boolean): void {
		this.setFoldLevel(collapsed ? 0 : 1);
	}

	toggle(ctrlKey = false): void {
		this.setFoldLevel(transitionFoldLevel(this.effectiveLevel, ctrlKey));
	}

	#copy(): ToolViewCopySpec | undefined {
		const copy = this.#spec.copy;
		return typeof copy === "function" ? copy() : copy;
	}

	#triggerCopy(shiftKey: boolean): void {
		const copySpec = this.#copy();
		if (copySpec === undefined) return;
		const payload =
			shiftKey && copySpec.full !== undefined && copySpec.full !== ""
				? copySpec.full
				: copySpec.primary;
		const writeClip = this.#spec.copyToClipboard ?? copyToSystemClipboard;
		const durationMs = this.#spec.copyFeedbackDurationMs ?? DEFAULT_COPY_FEEDBACK_MS;
		// Feedback starts when the write settles. Marking it before the promise made a rejected
		// clipboard write look exactly like a successful copy.
		void writeClip(payload).then(
			() => this.#showCopyFeedback(durationMs, false),
			() => this.#showCopyFeedback(durationMs, true),
		);
	}

	/** One feedback window in the copy slot: ✓ when the text reached the clipboard, ✗ when it did not. */
	#showCopyFeedback(durationMs: number, failed: boolean): void {
		const until = Date.now() + durationMs;
		this.#localCopiedUntil = failed ? 0 : until;
		this.#localCopyFailed = failed;

		if (isRecord(this.#spec.stateHolder)) {
			const prevTimer = this.#spec.stateHolder[COPY_FEEDBACK_TIMER_KEY];
			if (prevTimer !== undefined) {
				clearTimeout(prevTimer as ReturnType<typeof setTimeout>);
			}
			this.#spec.stateHolder[COPIED_UNTIL_STATE_KEY] = this.#localCopiedUntil;
			this.#spec.stateHolder[COPY_FAILED_STATE_KEY] = failed;
		}
		if (this.#localTimer !== undefined) {
			clearTimeout(this.#localTimer);
		}
		this.#cache = undefined;
		this.#spec.invalidate?.();

		const timer = setTimeout(() => {
			this.#localCopiedUntil = 0;
			this.#localCopyFailed = false;
			if (isRecord(this.#spec.stateHolder)) {
				this.#spec.stateHolder[COPIED_UNTIL_STATE_KEY] = 0;
				this.#spec.stateHolder[COPY_FAILED_STATE_KEY] = false;
				this.#spec.stateHolder[COPY_FEEDBACK_TIMER_KEY] = undefined;
			}
			this.#localTimer = undefined;
			this.#cache = undefined;
			this.#spec.invalidate?.();
		}, durationMs);
		timer.unref?.();
		this.#localTimer = timer;
		if (isRecord(this.#spec.stateHolder)) {
			this.#spec.stateHolder[COPY_FEEDBACK_TIMER_KEY] = timer;
		}
	}

	/**
	 * A live glyph needs someone to ask for the next frame, and no host event says "still running".
	 * The frame that drew one owns that timer: it fires once, the repaint renders again, and a settled
	 * row simply stops asking.
	 */
	#requestNextFrame(): void {
		if (this.#liveTimer !== undefined) return;
		this.#liveTimer = setTimeout(() => {
			this.#liveTimer = undefined;
			this.#spec.invalidate?.();
		}, TOOL_SPINNER_INTERVAL_MS);
		this.#liveTimer.unref?.();
	}

	#renderHeader(width: number, level: FoldLevel): string {
		const { theme, header } = this.#spec;
		const copy = this.#copy();
		const safeWidth = Math.max(1, width);
		// A live tool says so in its leading slot: one glyph, no `▸` in front of a second status mark.
		// A container that already lists child calls is not live any more, so it keeps the fold pin.
		const live = level === 0 && (header.status === "streaming" || header.status === "running");
		const pin = live
			? formatStatusGlyph(header.status, theme)
			: theme.fg("dim", level === 0 ? "▸" : "▾");
		const leftContent = `${pin} ${formatToolHeaderText(live ? { ...header, status: "none" } : header, theme)}`;

		if (copy === undefined || safeWidth < 6) {
			return truncate(leftContent, safeWidth);
		}

		const failed = isCopyFailed(this.#spec.stateHolder, this.#localCopyFailed);
		const copied = !failed && isCopiedActive(this.#spec.stateHolder, this.#localCopiedUntil);
		const copyIcon = failed
			? theme.fg("error", "✗")
			: copied
				? theme.fg("success", "✓")
				: theme.fg("dim", "󰆏");
		// Leave 1 column on the right for Pi's fullscreen scrollbar so the copy icon doesn't collide
		const rightMargin = 1;
		const copySlotWidth = 2 + rightMargin;
		const maxLeftWidth = Math.max(1, safeWidth - copySlotWidth);
		const truncatedLeft = truncate(leftContent, maxLeftWidth);
		const leftVis = visibleWidth(truncatedLeft);
		const gap = " ".repeat(Math.max(1, safeWidth - leftVis - rightMargin - 1));
		return truncate(truncatedLeft + gap + copyIcon + " ".repeat(rightMargin), safeWidth);
	}

	#hidden = false;

	/** The result renderer of the same tool execution hides this row in place. */
	hide(): void {
		this.#hidden = true;
		this.#cache = undefined;
	}

	/**
	 * Renders only the interior content of the view without the header row.
	 * When `noRail: true` is specified, outer rail glyphs are omitted, allowing
	 * clean embedding inside composite parent components without regex text scraping.
	 */
	renderBody(width: number, options?: { noRail?: boolean }): string[] {
		if (this.#hidden) return [];
		const pad = Math.max(0, this.#spec.outputPad ?? 0);
		const safeWidth = Math.max(1, width - pad * 2);
		const level = this.effectiveLevel;
		const { theme, collapsedRows, sections } = this.#spec;
		const noRail =
			options?.noRail ?? (this.#spec.noRail === true || this.#spec.background?.() === true);
		const innerWidth = noRail ? safeWidth : Math.max(1, safeWidth - 2);
		const output: string[] = [];

		if (level === 0) {
			if (collapsedRows !== undefined) {
				const railColor: RailColorToken = this.#spec.header.status === "error" ? "error" : "dim";
				const rail = noRail ? "" : `${theme.fg(railColor, "▎")} `;
				const { rows } = resolveRows(collapsedRows, innerWidth, (row) => [toSingleRow(row)]);
				for (const row of rows) {
					output.push(truncate(rail + row, safeWidth));
				}
			}
			return output;
		}

		if (sections === undefined || sections.length === 0) {
			return output;
		}

		for (const section of sections) {
			const sectionOutput: string[] = [];
			const rail = noRail ? "" : `${theme.fg(section.railToken, "▎")} `;
			const {
				rows: rawLines,
				isByteTruncated,
				totalBytes,
			} = resolveRows(section.content, innerWidth, toContentRows);
			const cap =
				level === 1 ? (section.maxLines ?? DEFAULT_MAX_SECTION_LINES) : MAX_LEVEL2_SECTION_LINES;

			const sectionRows: string[] = [];
			let logicalLinesCount = 0;
			// Wrapped rows the last shown line still has: a single long line is not "1 more line".
			let cutChunks = 0;
			for (const line of rawLines) {
				const wrapped = wrapTextWithAnsi(line, innerWidth);
				const chunks = wrapped.length > 0 ? wrapped : [""];
				if (Number.isFinite(cap) && sectionRows.length + chunks.length > cap) {
					const canTake = Math.max(0, cap - sectionRows.length);
					for (let i = 0; i < canTake; i++) {
						const chunk = chunks[i];
						if (chunk !== undefined) {
							sectionRows.push(chunk);
						}
					}
					// Only a line that started showing is "continues"; a fully omitted one is a whole line.
					cutChunks = canTake > 0 ? chunks.length - canTake : 0;
					break;
				}
				sectionRows.push(...chunks);
				logicalLinesCount++;
			}
			// The line that broke the cap is not an omitted whole line: its hidden part is `cutChunks`.
			const omittedCount = rawLines.length - logicalLinesCount - (cutChunks > 0 ? 1 : 0);
			// The hint names the real way to the hidden text; without a copy it must not promise one.
			const copySpec = this.#copy();
			const copyHint =
				copySpec?.full !== undefined && copySpec.full !== "" ? ", shift+click copies all" : "";

			for (const row of sectionRows) {
				sectionOutput.push(truncate(rail + row, safeWidth));
			}
			if (omittedCount > 0 || cutChunks > 0 || isByteTruncated) {
				let text: string;
				if (isByteTruncated) {
					text = `… [Output truncated: showing 64KB of ${Math.round(totalBytes / 1024)}KB${copyHint}]`;
				} else if (omittedCount > 0) {
					text = `… (${String(omittedCount)} more lines${cutChunks > 0 ? ", current line continues" : ""}${copyHint})`;
				} else {
					text = `… (current line continues${copyHint})`;
				}
				sectionOutput.push(truncate(rail + theme.fg("dim", text), safeWidth));
			}
			output.push(...sectionOutput);
		}

		return output;
	}

	render(width: number): string[] {
		if (this.#hidden) return [];
		const level = this.effectiveLevel;
		const copied = isCopiedActive(this.#spec.stateHolder, this.#localCopiedUntil);
		const native = this.#spec.background?.() === true;
		const surface = native ? nativeSurface(this.#spec.header.status) : undefined;
		const noRail = this.#spec.noRail === true || native;
		const copyVisible = this.#copy() !== undefined;
		// The glyph of a live tool changes on its own clock, so a cached frame would freeze it.
		const status = this.#spec.header.status;
		const glyph = status === "streaming" || status === "running" ? toolSpinnerFrame() : "";
		// A live row at level 0 draws the glyph, so this frame owns the next one.
		if (glyph !== "" && level === 0) this.#requestNextFrame();
		// A component body draws on a clock of its own: a container's child board animates a live child
		// while the container itself already shows its fold pin, so a cached frame would freeze the
		// child's glyph. Only a body of literal rows is fully known here.
		const bodyOwnsItsClock =
			this.#spec.collapsedRows !== undefined && !Array.isArray(this.#spec.collapsedRows);
		if (
			!bodyOwnsItsClock &&
			this.#cache !== undefined &&
			this.#cache.width === width &&
			this.#cache.level === level &&
			this.#cache.noRail === noRail &&
			this.#cache.surface === surface &&
			this.#cache.copyVisible === copyVisible &&
			this.#cache.copied === copied &&
			this.#cache.glyph === glyph
		) {
			return this.#cache.lines;
		}

		const pad = Math.max(0, this.#spec.outputPad ?? 0);
		const safeWidth = Math.max(1, width - pad * 2);
		this.#lastWidth = width;
		this.#lastNoRail = noRail;
		if (level !== 0) {
			this.#collapseChildren();
		}

		const rawLines = [this.#renderHeader(safeWidth, level), ...this.renderBody(width)];
		const safeLines: string[] = [];
		const leftPad = pad > 0 ? " ".repeat(pad) : "";
		for (const rawLine of rawLines) {
			if (rawLine.includes("\r") || rawLine.includes("\n")) {
				for (const line of toContentRows(rawLine)) {
					const truncated = truncate(line, safeWidth);
					safeLines.push(leftPad !== "" ? `${leftPad}${truncated}` : truncated);
				}
			} else {
				safeLines.push(leftPad !== "" ? `${leftPad}${rawLine}` : rawLine);
			}
		}
		this.#lastTopPad = surface === undefined ? 0 : 1;
		const lines =
			surface === undefined ? safeLines : surfaceBlock(this.#spec.theme, surface, safeLines, width);
		this.#lastHeight = lines.length;
		this.#cache = bodyOwnsItsClock
			? undefined
			: { width, level, copied, noRail, surface, copyVisible, glyph, lines };
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" || this.#hidden) {
			return undefined;
		}
		if (event.type !== "click" || event.button !== "left") {
			return undefined;
		}

		const effectiveWidth = event.width > 0 ? event.width : this.#lastWidth;
		const pad = Math.max(0, this.#spec.outputPad ?? 0);
		const innerX = event.x - pad;
		const innerWidth = Math.max(1, effectiveWidth - pad * 2);
		if (innerX < 0 || innerX >= innerWidth) {
			return undefined;
		}
		// The last render's row count bounds the clickable area; a view that has not rendered yet has no
		// extent to test against, and Pi always renders before it dispatches a mouse event.
		if (this.#lastHeight > 0 && (event.y < 0 || event.y >= this.#lastHeight)) {
			return undefined;
		}

		const row = event.y - this.#lastTopPad;
		if (row === 0) {
			if (
				this.#copy() !== undefined &&
				innerWidth >= 6 &&
				innerX >= innerWidth - 3 &&
				innerX < innerWidth
			) {
				this.#triggerCopy(event.shift === true);
				return { handled: true, render: true };
			}

			this.toggle(event.ctrl === true);
			return { handled: true, render: true };
		}

		const level = this.effectiveLevel;
		if (level === 0 && this.#spec.collapsedRows !== undefined) {
			const rows = this.#spec.collapsedRows;
			if (
				typeof rows === "object" &&
				rows !== null &&
				"handleMouse" in rows &&
				typeof (rows as { handleMouse?: unknown }).handleMouse === "function"
			) {
				const handler = (
					rows as { handleMouse: (e: TuiMouseEvent) => TuiMouseEventResult | undefined }
				).handleMouse;
				const railOffset = this.#lastNoRail ? 0 : 2;
				const subEvent: TuiMouseEvent = {
					...event,
					y: row - 1,
					x: Math.max(0, innerX - railOffset),
					width: Math.max(1, innerWidth - railOffset),
				};
				const res = handler.call(rows, subEvent);
				if (res?.handled) {
					this.#cache = undefined;
					return res;
				}
			}
		}

		return { handled: true };
	}

	invalidate(): void {
		this.#cache = undefined;
		const { collapsedRows, sections } = this.#spec;
		if (
			collapsedRows !== undefined &&
			typeof collapsedRows === "object" &&
			"invalidate" in collapsedRows
		) {
			collapsedRows.invalidate();
		}
		if (sections !== undefined) {
			for (const section of sections) {
				if (typeof section.content === "object" && "invalidate" in section.content) {
					section.content.invalidate();
				}
			}
		}
	}
}
