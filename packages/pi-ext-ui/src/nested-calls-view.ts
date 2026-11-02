import {
	copyToClipboard as copyToSystemClipboard,
	getLanguageFromPath,
	highlightCode,
	type Theme,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ToolPresentationProvider } from "@hheei/pi-ext-core";
import { extractChildToolCopyText, inlinePresentation, nativeRequestCopy } from "./native-tools.js";
import type { NestedCallRecord, ToolRenderContext } from "./renderer.js";
import {
	type Collapsible,
	type FoldLevel,
	formatToolHeaderText,
	TOOL_SPINNER_INTERVAL_MS,
	ToolView,
	toContentRows,
	toolSpinnerFrame,
	transitionFoldLevel,
} from "./tool-view.js";
import type { CapturedToolCall } from "./tracker.js";

function truncate(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A call without a final result is still running: its row carries the live spinner frame. A persisted
 * record states its own status, so a recovered board never animates a call that already ended.
 */
function isLiveCall(call: CapturedToolCall | NestedCallRecord): boolean {
	return "status" in call
		? call.status === "running"
		: (call as CapturedToolCall).result === undefined;
}

/**
 * A copy keeps the request half byte-exact and strips only what follows it: the result is display
 * text, while the request is what the model sent and may legitimately contain escapes.
 */
function copyText(text: string, request: string | undefined): string {
	if (request === undefined || request === "" || !text.startsWith(request)) {
		return stripTerminalSequences(text);
	}
	return request + stripTerminalSequences(text.slice(request.length));
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "";
	return ms < 1000 ? `${String(Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;
}

interface LineMapEntry {
	readonly callIndex: number;
	readonly isHeader: boolean;
	readonly copyRegion?: { readonly startX: number; readonly endX: number } | undefined;
}

export interface NestedCallsViewProps {
	readonly resolvePresentation?:
		| ((toolName: string) => ToolPresentationProvider | undefined)
		| undefined;
	readonly calls: readonly (CapturedToolCall | NestedCallRecord)[];
	readonly theme: Theme;
	readonly context: ToolRenderContext;
	readonly resolveChildRenderer?: ((toolName: string) => ToolRenderers | undefined) | undefined;
	/**
	 * The owning layer's themed summary for a child call. A board cannot recover a child's semantic
	 * tokens from text, so the layer that owns that tool states them here.
	 */
	readonly headerSummary?:
		| ((toolName: string, args: unknown, theme: Theme) => string | undefined)
		| undefined;
	readonly copyToClipboard?: ((text: string) => Promise<void>) | undefined;
	readonly stateHolder?: Record<string, unknown> | undefined;
	readonly invalidate?: (() => void) | undefined;
}

export const NESTED_CALLS_EXPANDED_KEY = "__pi_ext_ui_nested_expanded__";
export const NESTED_CALLS_COPIED_KEY = "__pi_ext_ui_nested_copied__";

export class NestedCallsView implements Component, Collapsible {
	readonly #props: NestedCallsViewProps;
	readonly #inMemoryLevels = new Map<number, FoldLevel>();
	#copiedIndex: number | undefined = undefined;
	#failedIndex: number | undefined = undefined;
	#copiedTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	#liveTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	#lineMapping: LineMapEntry[] = [];
	#renderCache:
		| {
				readonly width: number;
				readonly copiedIndex: number | undefined;
				readonly failedIndex: number | undefined;
				readonly levelsKey: string;
				/** Spinner frame the rows were drawn with; a live child glyph invalidates the cache. */
				readonly frame: string;
				readonly lines: string[];
				readonly lineMapping: LineMapEntry[];
		  }
		| undefined;

	constructor(props: NestedCallsViewProps) {
		this.#props = props;
		const state = props.stateHolder;
		if (state !== undefined) {
			const stored = state[NESTED_CALLS_EXPANDED_KEY];
			if (isRecord(stored)) {
				for (const [k, v] of Object.entries(stored)) {
					const idx = Number(k);
					if (!Number.isNaN(idx) && (v === 1 || v === 2)) {
						this.#inMemoryLevels.set(idx, v);
					}
				}
			} else if (Array.isArray(stored)) {
				for (const item of stored) {
					if (typeof item === "number") {
						this.#inMemoryLevels.set(item, 1);
					}
				}
			}

			const copiedState = state[NESTED_CALLS_COPIED_KEY];
			if (
				isRecord(copiedState) &&
				typeof copiedState.index === "number" &&
				typeof copiedState.until === "number"
			) {
				const remaining = copiedState.until - Date.now();
				if (remaining > 0) {
					const failed = copiedState.failed === true;
					this.#copiedIndex = failed ? undefined : copiedState.index;
					this.#failedIndex = failed ? copiedState.index : undefined;
					this.#copiedTimer = setTimeout(() => {
						this.#clearCopyFeedback();
						this.#props.invalidate?.();
					}, remaining);
					this.#copiedTimer.unref?.();
				} else {
					delete state[NESTED_CALLS_COPIED_KEY];
				}
			}
		}
	}

	#getExpansionLevel(index: number): FoldLevel {
		const state = this.#props.stateHolder;
		if (state !== undefined) {
			const stored = state[NESTED_CALLS_EXPANDED_KEY];
			if (isRecord(stored)) {
				const val = stored[String(index)];
				if (val === 1 || val === 2) return val;
			} else if (Array.isArray(stored)) {
				if (stored.includes(index)) return 1;
			}
		}
		return this.#inMemoryLevels.get(index) ?? 0;
	}

	#getLevelsKey(): string {
		const parts: string[] = [];
		for (let i = 0; i < this.#props.calls.length; i++) {
			const level = this.#getExpansionLevel(i);
			if (level !== 0) parts.push(`${i}:${level}`);
		}
		return parts.join(",");
	}

	#setExpansionLevel(index: number, level: FoldLevel): void {
		if (level === 0) {
			this.#inMemoryLevels.delete(index);
		} else {
			this.#inMemoryLevels.set(index, level);
		}
		this.#renderCache = undefined;
		const state = this.#props.stateHolder;
		if (state !== undefined) {
			const record: Record<string, number> = {};
			for (const [k, v] of this.#inMemoryLevels.entries()) {
				record[String(k)] = v;
			}
			state[NESTED_CALLS_EXPANDED_KEY] = record;
		}
	}

	/**
	 * The render context of one nested call. A nested call has no host-mounted component, so its
	 * context is the parent's with the child's own args, id, duration and failure state.
	 */
	#callContext(call: CapturedToolCall | NestedCallRecord): ToolRenderContext {
		const { context } = this.#props;
		// A captured call carries its own id. A persisted record has none, so it falls back to the
		// parent's id — the only identity the host offers, and never a child's guess.
		const toolCallId = ("id" in call ? call.id : undefined) ?? context.toolCallId;
		return {
			...context,
			lastComponent: undefined,
			args: "args" in call ? (call as { args?: unknown }).args : undefined,
			toolCallId,
			// The container frame already indented these rows by the output pad; a child body that
			// applied it again would count the same setting twice.
			outputPad: 0,
			durationMs: call.durationMs,
			isError: Boolean(call.isError || ("status" in call && call.status === "error")),
			isPartial: false,
			argsComplete: true,
		};
	}

	#triggerCopy(callIndex: number, full: boolean): void {
		const call = this.#props.calls[callIndex];
		if (!call) return;
		const provider = this.#props.resolvePresentation?.(call.toolName);
		const presentation = provider?.(
			"args" in call ? call.args : undefined,
			"result" in call ? call.result : undefined,
			this.#props.theme,
			this.#callContext(call),
		);
		const chosen = full ? presentation?.copy?.full : presentation?.copy?.primary;
		const text = chosen ?? copyText(extractChildToolCopyText(call, full), nativeRequestCopy(call));
		const durationMs = 1500;
		if (text === "") {
			// Nothing was recorded to copy. A summary is not the request, so the copy reports failure.
			this.#showCopyFeedback(callIndex, durationMs, true);
			return;
		}

		const writeClip = this.#props.copyToClipboard ?? copyToSystemClipboard;
		// Feedback starts when the write settles: a rejected clipboard write is not a copy.
		void writeClip(text).then(
			() => this.#showCopyFeedback(callIndex, durationMs, false),
			() => this.#showCopyFeedback(callIndex, durationMs, true),
		);
	}

	/** One feedback window on one row: ✓ when the text reached the clipboard, ✗ when it did not. */
	#showCopyFeedback(callIndex: number, durationMs: number, failed: boolean): void {
		const until = Date.now() + durationMs;
		this.#copiedIndex = failed ? undefined : callIndex;
		this.#failedIndex = failed ? callIndex : undefined;
		this.#renderCache = undefined;

		const state = this.#props.stateHolder;
		if (state !== undefined) {
			state[NESTED_CALLS_COPIED_KEY] = {
				index: callIndex,
				until,
				...(failed ? { failed: true } : {}),
			};
		}

		if (this.#copiedTimer !== undefined) {
			clearTimeout(this.#copiedTimer);
		}
		this.#copiedTimer = setTimeout(() => {
			this.#clearCopyFeedback();
			this.#props.invalidate?.();
		}, durationMs);
		this.#copiedTimer.unref?.();

		this.#props.invalidate?.();
	}

	/** Drops the copy marker, its timer, and the shared record it left behind. */
	#clearCopyFeedback(): void {
		if (this.#copiedTimer !== undefined) {
			clearTimeout(this.#copiedTimer);
			this.#copiedTimer = undefined;
		}
		this.#copiedIndex = undefined;
		this.#failedIndex = undefined;
		this.#renderCache = undefined;
		const state = this.#props.stateHolder;
		if (state !== undefined) delete state[NESTED_CALLS_COPIED_KEY];
	}

	/** A live child row owns the next frame; a settled board asks for none. */
	#requestNextFrame(): void {
		if (this.#liveTimer !== undefined) return;
		this.#liveTimer = setTimeout(() => {
			this.#liveTimer = undefined;
			this.#props.invalidate?.();
		}, TOOL_SPINNER_INTERVAL_MS);
		this.#liveTimer.unref?.();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const levelsKey = this.#getLevelsKey();
		// A live child row draws the shared spinner, so a cached board would freeze that glyph.
		const frame = this.#props.calls.some(isLiveCall) ? toolSpinnerFrame() : "";
		// A live child row draws the glyph, so this board owns the next frame for as long as it does.
		if (frame !== "") this.#requestNextFrame();
		if (
			this.#renderCache !== undefined &&
			this.#renderCache.width === safeWidth &&
			this.#renderCache.copiedIndex === this.#copiedIndex &&
			this.#renderCache.failedIndex === this.#failedIndex &&
			this.#renderCache.levelsKey === levelsKey &&
			this.#renderCache.frame === frame
		) {
			this.#lineMapping = this.#renderCache.lineMapping;
			return this.#renderCache.lines;
		}
		this.#lineMapping = [];
		const { calls, theme } = this.#props;
		const lines: string[] = [];
		const rightMargin = 1;

		for (let i = 0; i < calls.length; i++) {
			const call = calls[i];
			if (!call) continue;
			const toolName = "toolName" in call ? call.toolName : (call as { name: string }).name;
			const isError = Boolean(call.isError || ("status" in call && call.status === "error"));
			const isRunning = isLiveCall(call);
			const expansionLevel = this.#getExpansionLevel(i);
			const isExpanded = expansionLevel !== 0;

			const rawSummary = "summary" in call ? call.summary : undefined;
			const rawArgs = "args" in call ? (call as { args?: unknown }).args : undefined;
			// A record's summary is the fact its owner stated; the arguments only fill in for a capture.
			const inline = inlinePresentation(
				toolName,
				rawSummary ?? rawArgs,
				"result" in call ? call.result?.details : undefined,
				isError,
			);

			const argText =
				typeof rawArgs === "string" ? rawArgs : typeof rawSummary === "string" ? rawSummary : "";
			const provider = this.#props.resolvePresentation?.(toolName);
			const presentation = provider?.(
				rawArgs,
				"result" in call ? call.result : undefined,
				theme,
				this.#callContext(call),
			);
			// The child row is the child's own header minus the fold pin, so it carries the same token
			// assignment as the row the same call would draw at top level.
			const ownSummary =
				presentation?.summary === undefined
					? this.#props.headerSummary?.(toolName, rawArgs ?? rawSummary, theme)
					: undefined;
			const childSummary =
				ownSummary === undefined || ownSummary === ""
					? stripTerminalSequences(presentation?.summary ?? inline?.summary ?? argText)
					: ownSummary;
			const leftContent = formatToolHeaderText(
				{
					status: isRunning ? "running" : isError ? "error" : "ok",
					title: toolName,
					summary: childSummary,
					...(ownSummary === undefined || ownSummary === "" ? {} : { summaryStyled: true }),
					meta: formatDuration(call.durationMs),
				},
				theme,
			);

			const isCopied = this.#copiedIndex === i;
			const copyIcon =
				this.#failedIndex === i
					? theme.fg("error", "✗")
					: isCopied
						? theme.fg("success", "✓")
						: theme.fg("dim", "󰆏");
			const copySlotWidth = 2 + rightMargin;

			const maxLeft = Math.max(1, width - copySlotWidth);
			const truncatedLeft = truncate(leftContent, maxLeft);
			const leftVis = visibleWidth(truncatedLeft);
			const gap = " ".repeat(Math.max(1, width - leftVis - rightMargin - 1));
			const headerLine = truncate(truncatedLeft + gap + copyIcon + " ".repeat(rightMargin), width);

			const headerLineIdx = lines.length;
			lines.push(headerLine);
			this.#lineMapping[headerLineIdx] = {
				callIndex: i,
				isHeader: true,
				copyRegion: { startX: width - copySlotWidth - 1, endX: width },
			};

			if (isExpanded) {
				const childWidth = Math.max(1, width - 2);
				const bodyLines = this.#renderChildBody(call, childWidth, expansionLevel);
				for (const rawLine of bodyLines) {
					for (const bodyLine of toContentRows(rawLine)) {
						const wrapped = wrapTextWithAnsi(bodyLine, childWidth);
						const chunks = wrapped.length > 0 ? wrapped : [""];
						for (const chunk of chunks) {
							const bodyLineIdx = lines.length;
							lines.push(truncate(`  ${chunk}`, width));
							this.#lineMapping[bodyLineIdx] = {
								callIndex: i,
								isHeader: false,
							};
						}
					}
				}
			}
		}

		this.#renderCache = {
			width: safeWidth,
			copiedIndex: this.#copiedIndex,
			failedIndex: this.#failedIndex,
			levelsKey,
			frame,
			lines,
			lineMapping: this.#lineMapping,
		};
		return lines;
	}

	#renderChildBody(
		call: CapturedToolCall | NestedCallRecord,
		width: number,
		expansionLevel: FoldLevel = 1,
	): string[] {
		const { theme, resolveChildRenderer } = this.#props;
		const toolName = "toolName" in call ? call.toolName : (call as { name: string }).name;
		const result = "result" in call ? (call as CapturedToolCall).result : undefined;
		const args = "args" in call ? (call as { args?: unknown }).args : undefined;

		if (result && resolveChildRenderer) {
			const renderer = resolveChildRenderer(toolName);
			if (renderer?.renderResult) {
				const childContext: ToolRenderContext = {
					...this.#callContext(call),
					state: undefined,
				};
				const comp = renderer.renderResult(
					result,
					{ expanded: expansionLevel === 2, isPartial: false },
					theme,
					childContext,
				);
				if (comp instanceof ToolView) {
					comp.setFoldLevel(expansionLevel);
					// Render body cleanly via deep headless interface without outer rail or header row
					return comp.renderBody(width, { noRail: true });
				}
				return comp.render(width);
			}
		}

		// Fallback rendering
		if (result && Array.isArray(result.content)) {
			const text = result.content
				.filter(
					(c): c is { type: "text"; text: string } =>
						isRecord(c) && c.type === "text" && typeof c.text === "string",
				)
				.map((c) => c.text)
				.join("\n")
				.trim();
			if (text) {
				let lines: string[];
				const filePath =
					typeof args === "object" &&
					args !== null &&
					"path" in args &&
					typeof (args as { path: unknown }).path === "string"
						? (args as { path: string }).path
						: "";
				const lang = filePath ? getLanguageFromPath(filePath) : undefined;
				if (lang) {
					try {
						lines = highlightCode(text, lang);
					} catch {
						lines = text.split("\n");
					}
				} else {
					lines = text.split("\n");
				}
				if (expansionLevel === 2) {
					if (lines.length <= 500) return lines;
					return [...lines.slice(0, 500), `... (${lines.length - 500} more lines)`];
				}
				if (lines.length <= 20) {
					return lines;
				}
				return [...lines.slice(0, 20), `... (${lines.length - 20} more lines)`];
			}
		}

		if ("error" in call && typeof call.error === "string" && call.error) {
			return call.error.split("\n").map((l) => theme.fg("error", l));
		}

		if ("argsTruncated" in call && call.argsTruncated === true) {
			const bytes = "argsBytes" in call && typeof call.argsBytes === "number" ? call.argsBytes : 0;
			return [
				theme.fg(
					"dim",
					bytes > 0 ? `(request not recorded: ${String(bytes)} bytes)` : "(request not recorded)",
				),
			];
		}

		// The request as the model sent it: the command or source, not a JSON wrapper around it.
		const request = nativeRequestCopy(call);
		if (request !== undefined) {
			return stripTerminalSequences(request)
				.split("\n")
				.map((line) => theme.fg("dim", line));
		}

		if (args !== undefined) {
			const text =
				typeof args === "string" ? stripTerminalSequences(args) : JSON.stringify(args, null, 2);
			return text.split("\n").map((l) => theme.fg("dim", l));
		}

		// A persisted record keeps a summary, not its request: say so instead of implying an empty call.
		return [
			theme.fg(
				"dim",
				"summary" in call && typeof call.summary === "string" && call.summary !== ""
					? "(request not recorded; summary only)"
					: "(no output)",
			),
		];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const mapping = this.#lineMapping[event.y];
		if (!mapping) return { handled: true };

		if (mapping.isHeader) {
			if (mapping.copyRegion && event.x >= mapping.copyRegion.startX) {
				this.#triggerCopy(mapping.callIndex, event.shift === true);
				return { handled: true, render: true };
			}

			const isCtrl = event.ctrl === true;
			const currentLevel = this.#getExpansionLevel(mapping.callIndex);
			const nextLevel = transitionFoldLevel(currentLevel, isCtrl);
			this.#setExpansionLevel(mapping.callIndex, nextLevel);
			this.#props.invalidate?.();
			return { handled: true, render: true };
		}

		return { handled: true };
	}

	dispose(): void {
		this.#clearCopyFeedback();
		this.#renderCache = undefined;
	}

	collapseAll(): void {
		// The marker points at a row that is no longer on screen; leaving it behind would bring a
		// permanent checkmark back when the same view expands again.
		this.#clearCopyFeedback();
		this.#inMemoryLevels.clear();
		const state = this.#props.stateHolder;
		if (state !== undefined) {
			state[NESTED_CALLS_EXPANDED_KEY] = {};
		}
		this.#lineMapping = [];
		this.#renderCache = undefined;
	}

	invalidate(): void {
		this.#lineMapping = [];
		this.#renderCache = undefined;
	}
}
