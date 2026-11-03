import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	Container,
	MouseRegion,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { fitRow } from "@hheei/pi-ext-core";
import { backgroundFill } from "./background.js";
import {
	isCollapsible,
	type ToolStatusKind,
	type ToolViewChild,
	toContentRows,
	toSingleRow,
} from "./tool-view.js";

/** A settled block keeps its surface this long, then drops it so the transcript stays quiet. */
const SURFACE_HOLD_MS = 5_000;

export interface Usage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export type MemberKind = "thinking" | "tool" | "notice";
export type Category = "tools" | "thinking" | "notices";

/**
 * One model request the block owns, in transcript order. A block's requests are not the same set
 * as its displayed members: the assistant text that ends a loop is native content, but its usage
 * still belongs to the block whose work it answers.
 */
export interface RequestFact {
	readonly usage?: Usage;
}

/** One transcript entry a block owns, reduced to the facts the collapsed frame draws. */
export interface Member {
	readonly kind: MemberKind;
	readonly component: Component;
	/**
	 * Every original component this member stands for. A thinking member is one continuous run, so
	 * it can span several assistant messages; the raw view prints them in order.
	 */
	readonly parts?: readonly Component[];
	readonly title?: string;
	readonly summary?: string;
	readonly status?: ToolStatusKind;
	readonly children?: readonly ToolViewChild[];
	/** Nested calls the member made, when `children` is only what fits. */
	readonly childCount?: number;
	/** Full thinking text of the run, kept regardless of the host's hide preference. */
	readonly thinking?: string;
	/** Pi hides thinking by default: show one preview row that opens the full text. */
	readonly thinkingHidden?: boolean;
	/**
	 * A tool enters the block's counts only after its final result arrived. Streaming args, an
	 * execution start, and partial results are not completed calls; a cancelled or failed call that
	 * did receive its final result is.
	 */
	readonly completed?: boolean;
	/** Rows this member shows directly under its label: a notice body or a preview. */
	readonly content?: (width: number) => readonly string[];
	/** Rows opening this member reveals; its presence is what makes the item expandable. */
	readonly detail?: (width: number) => readonly string[];
}

/** Runtime duration of one continuous activity block. */
export interface ToolGroupClock {
	readonly startedAt: number;
	endedAt?: number;
}

interface Hit {
	readonly height: number;
	readonly action: Action;
}

type Action =
	| { readonly kind: "none" }
	| { readonly kind: "category"; readonly category: Category }
	| { readonly kind: "item"; readonly member: Component }
	| { readonly kind: "member"; readonly wrapper: Component };

/** Every original component of a member, in transcript order. */
export function memberParts(member: Member): readonly Component[] {
	return member.parts ?? [member.component];
}

/**
 * A row that draws nothing visible. A separator row is not always an empty string: Pi marks the start
 * of a message zone with an OSC 133 row that paints no cells, and counting it as content would add a
 * second blank row after the block.
 */
function isBlankRow(row: string | undefined): boolean {
	return row === undefined || visibleWidth(row) === 0;
}

/**
 * Whether this tail's own rows can still change. A tool earns the floor until its final result
 * arrives, and a thinking run while its text is streaming into a visible body; a settled tool, a
 * hidden thinking preview, and a notice have drawn their last frame, so padding them adds no
 * stability and only empty rows.
 */
function stillGrowing(member: Member): boolean {
	if (member.kind === "tool") return member.completed !== true;
	return member.kind === "thinking" && member.thinkingHidden !== true;
}

/**
 * The one visible unit a block keeps outside itself: the transcript's last top-level unit, drawn by
 * its original component so its own Level 0, copy, and fold state stay intact. It normalizes the
 * single blank row that separates it from the block and forwards mouse events to the real parts.
 */
interface PartOffset {
	readonly part: Component;
	readonly top: number;
	readonly height: number;
	/** Leading rows the part draws that the wrapper removed. */
	readonly skip: number;
}

export class TailUnit implements Component {
	readonly #parts: readonly Component[];
	readonly #background: () => boolean;
	readonly #floor: boolean;
	#offsets: PartOffset[] = [];

	constructor(member: Member, background: () => boolean) {
		this.#parts = memberParts(member);
		this.#background = background;
		this.#floor = stillGrowing(member);
	}

	render(width: number): string[] {
		const offsets: PartOffset[] = [];
		const rows: string[] = [];
		let contentRows = 0;
		for (const part of this.#parts) {
			const all = part.render(width);
			const skip = all[0] === "" ? 1 : 0;
			const own = all.slice(skip);
			if (own.length === 0) continue;
			if (rows.length > 0) {
				rows.push("");
				contentRows++;
			}
			// A leading OSC-only separator stays in the output, but is not a content row.
			contentRows += own.length - (isBlankRow(own[0]) ? 1 : 0);
			offsets.push({ part, top: rows.length, height: own.length, skip });
			rows.push(...own);
		}
		if (rows.length === 0) {
			this.#offsets = offsets;
			return rows;
		}
		const out = isBlankRow(rows[0]) ? rows : ["", ...rows];
		// The separator above is a row of this unit too, so every part offset moves down with it.
		const shift = out.length - rows.length;
		this.#offsets = offsets.map((offset) => ({ ...offset, top: offset.top + shift }));
		// Surface padding counts toward the minimum; added rows stay outside surfaces and hit areas.
		const minimum = this.#floor ? (this.#background() ? 4 : 2) : 0;
		if (contentRows > 0) {
			for (let row = contentRows; row < minimum; row++) out.push("");
		}
		return out;
	}

	handleMouse(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) {
		for (const { part, top, height, skip } of this.#offsets) {
			if (event.y < top || event.y >= top + height) continue;
			return part.handleMouse?.({
				...event,
				y: event.y - top + skip,
				height: height + skip,
			});
		}
		return undefined;
	}

	invalidate(): void {
		for (const part of this.#parts) part.invalidate?.();
	}
}

function formatElapsed(milliseconds: number): string {
	const total = Math.max(0, Math.floor(milliseconds / 1000));
	const seconds = total % 60;
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	if (hours > 0)
		return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

/** The same decimal steps the Pi footer uses, so two places never disagree about a token count. */
function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${String(Math.round(count / 1000))}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${String(Math.round(count / 1_000_000))}M`;
}

/**
 * The native footer's cache-hit rule: the last request that actually measured a prompt. A zeroed
 * streaming placeholder is not that request, and a measured prompt with no cache read is 0%, not
 * unknown — missing data and a real zero must not share one placeholder.
 */
function cacheHitRate(latestPrompt: Usage | undefined): string | undefined {
	if (latestPrompt === undefined) return undefined;
	const prompt = latestPrompt.input + latestPrompt.cacheRead + latestPrompt.cacheWrite;
	if (prompt <= 0) return undefined;
	return `${((latestPrompt.cacheRead / prompt) * 100).toFixed(1)}%`;
}

const PREVIEW_GRAPHEMES = 20;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The thinking preview: the first line's leading graphemes, and whether anything follows them. A
 * grapheme cap keeps emoji and CJK clusters whole; the frame still truncates to the cells it has.
 */
function thinkingPreview(text: string): { readonly head: string; readonly more: boolean } {
	const content = text.trim();
	const line = toSingleRow(content.split("\n").find((row) => row.trim() !== "") ?? "");
	let head = "";
	let count = 0;
	for (const { segment } of graphemes.segment(line)) {
		if (count === PREVIEW_GRAPHEMES) break;
		head += segment;
		count++;
	}
	return { head, more: content !== head };
}

/**
 * The collapsed frame of one activity block.
 *
 * The frame owns only layout and hit testing: tool rows keep their own component so their glyph,
 * colors, copy action, and fold level stay the ones the transcript already draws. Anything this
 * view synthesized itself would drift from those rows.
 */
export class ToolGroupView extends Container {
	readonly #header = new Text("", 0, 0);
	readonly #ui: ExtensionUIContext;
	readonly #redraw: () => void;
	/** Pi-native block backgrounds are opt-in; while they are on, the fill replaces the rails. */
	readonly #background: () => boolean;
	/** Pi's own output padding, so the frame lines up with the tool rows it wraps. */
	readonly #outputPad: () => number;
	/** The stable clock for this block; restored history stays unknown until live content joins. */
	#clock: ToolGroupClock | undefined;
	/** The block's own members, drawn inside the group. */
	#members: Member[] = [];
	/** The block's last visible unit, drawn outside the group by its own component. */
	#tail: Member | undefined;
	/** Every model request the block owns, in transcript order, including the tail's and native prose. */
	#requests: readonly RequestFact[] = [];
	#raw = false;
	#category: Category | undefined;
	#item: Component | undefined;
	#renderedExpanded = false;
	#shell: "collapsed" | "raw" = "collapsed";
	/** When the block last became quiet; the surface hold counts from here. */
	#settledAt: number | undefined;
	#holdTimer: ReturnType<typeof setTimeout> | undefined;
	#hits: Hit[] = [];
	readonly #heading: Component;
	readonly #body: Component;
	// One extra colored row above and below: the block needs breathing room inside its background.
	readonly #box = new Box(0, 1);
	readonly #spacer = new Spacer(1);

	constructor(
		ui: ExtensionUIContext,
		redraw: () => void,
		background: () => boolean,
		outputPad: () => number,
	) {
		super();
		this.#ui = ui;
		this.#redraw = redraw;
		this.#background = background;
		this.#outputPad = outputPad;
		this.#heading = new MouseRegion(this.#header, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			this.#toggleRaw();
			return { handled: true, render: true };
		});
		this.#body = {
			render: (width) => this.#renderBody(width),
			handleMouse: (event) => this.#hit(event),
			invalidate() {},
		};
		// The group background covers the header, categories, and footer. Zero padding keeps the rows
		// at the width they were laid out for; a tool's own outputPad must not be counted twice.
		this.#box.addChild(this.#heading);
		this.#box.addChild(this.#body);
		this.children = [this.#spacer, this.#box];
	}

	#toggleRaw(): void {
		this.#raw = this.#ui.getToolsExpanded() ? false : !this.#raw;
		if (this.#raw) {
			this.#category = undefined;
			this.#item = undefined;
			for (const member of this.#members) {
				if (isCollapsible(member.component)) member.component.collapseAll();
			}
		}
		this.#redraw();
	}

	#thinkingItems(): Member[] {
		return this.#members.filter(
			(member) => member.thinking !== undefined && member.thinking !== "",
		);
	}

	#noticeItems(): Member[] {
		return this.#members.filter((member) => member.kind === "notice");
	}

	/**
	 * Completed calls only: a container's final children replace its parent exactly once, and a call
	 * still streaming args or running has not produced that fact yet.
	 */
	#calls(): number {
		let total = 0;
		// The tail outside the group is still this block's work, so its calls belong to the header.
		for (const member of this.#block()) {
			if (member.kind !== "tool" || member.completed !== true) continue;
			// The count is a fact the tool reports; a bounded child list must not lower it.
			total += member.childCount ?? (member.children === undefined ? 1 : member.children.length);
		}
		return total;
	}

	/** The group's own members, then the unit it leaves outside. */
	#block(): Member[] {
		return this.#tail === undefined ? [...this.#members] : [...this.#members, this.#tail];
	}

	/** The block's own last fact: the newest member that states a status, tail included. */
	#lastStatus(): ToolStatusKind | undefined {
		const block = this.#block();
		for (let index = block.length - 1; index >= 0; index -= 1) {
			const status = block[index]?.status;
			if (status !== undefined) return status;
		}
		return undefined;
	}

	/**
	 * The surface states the block's last fact, not its worst one, so one old failure cannot tint a
	 * block forever. A settled block keeps that color for five seconds and then falls back to the
	 * neutral surface, because a transcript full of settled blocks is a transcript to read, not a wall
	 * of colored panels.
	 */
	#surfaceToken(): "toolErrorBg" | "toolPendingBg" | "toolSuccessBg" {
		const last = this.#lastStatus();
		if (last === "running" || last === "streaming") {
			this.#settledAt = undefined;
			this.#stopHold();
			return "toolPendingBg";
		}
		const now = performance.now();
		this.#settledAt ??= now;
		const held = now - this.#settledAt;
		if (last === undefined || held >= SURFACE_HOLD_MS) return "toolPendingBg";
		this.#hold(SURFACE_HOLD_MS - held);
		return last === "error" ? "toolErrorBg" : "toolSuccessBg";
	}

	/** One repaint when the hold expires; nothing keeps ticking after that. */
	#hold(delay: number): void {
		if (this.#holdTimer !== undefined) return;
		this.#holdTimer = setTimeout(() => {
			this.#holdTimer = undefined;
			this.#redraw();
		}, delay);
	}

	#stopHold(): void {
		if (this.#holdTimer === undefined) return;
		clearTimeout(this.#holdTimer);
		this.#holdTimer = undefined;
	}

	/**
	 * Release the block's own lifetime. The projection drops a block when it is evicted, when
	 * grouping is disabled, or when the patch unloads; an idempotent dispose keeps that path honest,
	 * so a removed block can never ask for a repaint.
	 */
	dispose(): void {
		this.#stopHold();
	}

	#usage(): {
		readonly requests: number;
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		/** The last assistant usage that measured a prompt: the only cache-hit fact. */
		readonly latestPrompt: Usage | undefined;
	} {
		let requests = 0;
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let latestPrompt: Usage | undefined;
		for (const fact of this.#requests) {
			requests += 1;
			const usage = fact.usage;
			if (usage === undefined) continue;
			input += usage.input;
			output += usage.output;
			cacheRead += usage.cacheRead;
			cacheWrite += usage.cacheWrite;
			// A streaming snapshot can arrive with every field zeroed; that is a placeholder, not a
			// measured prompt, so it must not overwrite the last known cache-hit fact.
			if (usage.input + usage.cacheRead + usage.cacheWrite > 0) latestPrompt = usage;
		}
		return { requests, input, output, cacheRead, cacheWrite, latestPrompt };
	}

	/**
	 * The block footer: the block's request count, then the same token facts and the same symbols
	 * Pi's own footer uses (`↑input ↓output RcacheRead WcacheWrite CHrate`). Pi totals the whole
	 * session; this totals one block, so the two never have to agree on the number.
	 */
	#footerRow(): string {
		const theme = this.#ui.theme;
		const usage = this.#usage();
		const parts = [`requests ×${usage.requests}`];
		if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) {
			parts.push("↑—", "↓—");
			return theme.fg("dim", parts.join(" · "));
		}
		if (usage.input > 0) parts.push(`↑${formatTokens(usage.input)}`);
		if (usage.output > 0) parts.push(`↓${formatTokens(usage.output)}`);
		if (usage.cacheRead > 0) parts.push(`R${formatTokens(usage.cacheRead)}`);
		if (usage.cacheWrite > 0) parts.push(`W${formatTokens(usage.cacheWrite)}`);
		if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
			const rate = cacheHitRate(usage.latestPrompt);
			if (rate !== undefined) parts.push(`CH${rate}`);
		}
		return theme.fg("dim", parts.join(" · "));
	}

	#categoryRow(category: Category, label: string, detail: string): string {
		const theme = this.#ui.theme;
		const open = this.#category === category;
		const pin = `${theme.fg("dim", open ? "▾" : "▸")} `;
		const tail = detail === "" ? "" : `${theme.fg("dim", " · ")}${theme.fg("dim", detail)}`;
		// The open category is the block's focus point; the arrow still carries the state alone.
		return `${pin}${theme.fg(open ? "accent" : "text", label)}${tail}`;
	}

	#renderBody(width: number): string[] {
		if (this.#renderedExpanded) return this.#renderRaw(width);
		return this.#renderFrame(width);
	}

	/**
	 * The whole block expanded: no group shell and no per-member fill, so every block shows only the
	 * styling its own component draws.
	 */
	#renderRaw(width: number): string[] {
		const lines: string[] = [];
		const hits: Hit[] = [];
		for (const member of this.#members) {
			const wrapper = this.#memberWrapper(member);
			const own = wrapper.render(Math.max(1, width));
			if (own.length === 0) continue;
			// One blank row between adjacent semantic blocks. A thinking run has no surface of its own,
			// so it keeps the plain separator even when tools paint their own padded surfaces.
			if (lines.length > 0) {
				lines.push("");
				hits.push({ height: 1, action: { kind: "none" } });
			}
			// The expanded group is transparent: every block keeps only the styling it draws itself.
			for (const row of own) lines.push(fitRow(row, Math.max(0, width), "…"));
			hits.push({ height: own.length, action: { kind: "member", wrapper } });
		}
		this.#hits = hits;
		return lines;
	}

	/** Header, the three categories, and the statistics footer; every row is one terminal row. */
	#renderFrame(width: number): string[] {
		const theme = this.#ui.theme;
		const lines: string[] = [];
		const hits: Hit[] = [];
		// The frame is the block's own row; a tool row inside it pads itself, so only these rows take
		// Pi's output padding.
		const pad = Math.max(0, this.#outputPad());
		const lead = " ".repeat(pad);
		const inner = Math.max(0, width - pad * 2);
		const push = (row: string, action: Action = { kind: "none" }) => {
			lines.push(fitRow(`${lead}${row}`, Math.max(0, width), "…"));
			hits.push({ height: 1, action });
		};
		/** Rows that belong to one component keep one hit so its own geometry stays correct. */
		const pushBlock = (rows: readonly string[], action: Action) => {
			if (rows.length === 0) return;
			for (const row of rows) lines.push(fitRow(row, Math.max(0, width), "…"));
			hits.push({ height: rows.length, action });
		};
		const tools: number[] = [];
		for (const [index, member] of this.#members.entries()) {
			if (member.kind === "tool") tools.push(index);
		}
		push(theme.fg("borderMuted", "─".repeat(inner)));

		const notices = this.#noticeItems();
		if (notices.length > 0) {
			const kinds = new Map<string, number>();
			for (const member of notices) {
				const kind = member.title ?? "notice";
				kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
			}
			const detail = [...kinds].map(([kind, count]) => `${kind} ×${count}`).join(" · ");
			push(this.#categoryRow("notices", "notice", detail), {
				kind: "category",
				category: "notices",
			});
			if (this.#category === "notices") this.#renderNotices(notices, inner, push);
		}

		const thinking = this.#thinkingItems();
		if (thinking.length > 0) {
			const tokens = Math.ceil(
				thinking.reduce((sum, member) => sum + (member.thinking?.length ?? 0), 0) / 4,
			);
			push(
				this.#categoryRow("thinking", `thinking x${thinking.length}`, `${String(tokens)} tokens`),
				{
					kind: "category",
					category: "thinking",
				},
			);
			if (this.#category === "thinking") this.#renderThinking(thinking, inner, push);
		}

		// Names and header calls share one eligibility: only completed calls are counted. A tool that
		// is still streaming or running stays listed and expandable, but adds no number.
		const counts = new Map<string, number>();
		let listed = 0;
		for (const index of tools) {
			const member = this.#members[index];
			if (member === undefined) continue;
			listed += 1;
			if (member.completed !== true) continue;
			if (member.children === undefined) {
				if (member.title !== undefined)
					counts.set(member.title, (counts.get(member.title) ?? 0) + 1);
				continue;
			}
			for (const child of member.children)
				counts.set(child.title, (counts.get(child.title) ?? 0) + 1);
		}
		if (listed > 0) {
			const names = [...counts]
				.map(
					([name, count]) =>
						`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("dim", `×${count}`)}`,
				)
				.join(theme.fg("dim", " · "));
			push(this.#categoryRow("tools", names === "" ? "tools" : names, ""), {
				kind: "category",
				category: "tools",
			});
			if (this.#category === "tools") this.#renderTools(tools, width, push, pushBlock);
		}

		// The rails bracket the header, categories, and any opened detail; the footer sits below them.
		push(theme.fg("borderMuted", "─".repeat(inner)));
		// The footer is always the block's request and token totals: one row, never a tool status.
		push(this.#footerRow());
		this.#hits = hits;
		return lines;
	}

	/**
	 * Every tool at its own fold level, one blank row between calls. A container is one tool here too:
	 * its component draws its own board, and `children`/childCount only feed the counts.
	 */
	#renderTools(
		tools: readonly number[],
		width: number,
		push: (row: string, action?: Action) => void,
		pushBlock: (rows: readonly string[], action: Action) => void,
	): void {
		let first = true;
		for (const memberIndex of tools) {
			const member = this.#members[memberIndex];
			if (member === undefined) continue;
			const wrapper = this.#offsetWrapper(member.component);
			const rows = wrapper.render(Math.max(1, width));
			if (rows.length === 0) continue;
			if (!first) push("");
			first = false;
			// One hit for the whole tool: its own rows carry the header, copy slot, and fold state.
			pushBlock(rows, { kind: "member", wrapper });
		}
	}

	/**
	 * Thinking items. While the host hides thinking, an item is one row: its 20-grapheme content
	 * preview, which opens the full text. While thinking is visible, the full text is already there.
	 */
	#renderThinking(
		thinking: readonly Member[],
		width: number,
		push: (row: string, action?: Action) => void,
	): void {
		for (const member of thinking) {
			const text = member.thinking;
			if (text === undefined) continue;
			if (member.thinkingHidden !== true) {
				for (const row of this.#thinkingRows(text, width)) push(row);
				continue;
			}
			const open = this.#item === member.component;
			if (!open) {
				push(this.#thinkingPreviewRow(text, width), { kind: "item", member: member.component });
				continue;
			}
			// The first row is still the item's own hit area, so a click folds it back.
			for (const [index, row] of this.#thinkingRows(text, width).entries())
				push(row, index === 0 ? { kind: "item", member: member.component } : { kind: "none" });
		}
	}

	/**
	 * The cells a thinking row starts with. Thinking has no surface of its own, so it keeps the same
	 * rail as a tool at every level; once a block is filled, the fill delimits it and the rail goes.
	 */
	#thinkingPrefix(): string {
		return this.#background() ? "  " : `${this.#ui.theme.fg("dim", "▎")} `;
	}

	/** One preview row: the grapheme head plus an ellipsis, then cut to the cells the rail leaves. */
	#thinkingPreviewRow(text: string, width: number): string {
		const theme = this.#ui.theme;
		const { head, more } = thinkingPreview(text);
		const room = Math.max(1, width - 2);
		const fitted = truncateToWidth(head, more ? Math.max(1, room - 1) : room, "…");
		const preview = more && fitted === head ? `${head}…` : fitted;
		return `${this.#thinkingPrefix()}${theme.fg("thinkingText", theme.italic(preview))}`;
	}

	/** Full thinking text: paragraphs keep their separation, every row wraps to the indent's width. */
	#thinkingRows(text: string, width: number): string[] {
		const theme = this.#ui.theme;
		const prefix = this.#thinkingPrefix();
		const inner = Math.max(1, width - 2);
		return toContentRows(text).flatMap((line) => {
			const wrapped = wrapTextWithAnsi(line, inner);
			return (wrapped.length > 0 ? wrapped : [""]).map((row) =>
				row === "" ? "" : `${prefix}${theme.fg("thinkingText", theme.italic(row))}`,
			);
		});
	}

	/**
	 * Notices print the content their own view lays out: the preview is directly visible, and only a
	 * real body adds a pin. A plain notify therefore appears once, indented, with no item action.
	 */
	#renderNotices(
		notices: readonly Member[],
		width: number,
		push: (row: string, action?: Action) => void,
	): void {
		const theme = this.#ui.theme;
		for (const member of notices) {
			const detail = member.detail;
			const open = detail !== undefined && this.#item === member.component;
			if (member.summary !== undefined) {
				const pin = detail === undefined ? "" : `${theme.fg("dim", open ? "▾" : "▸")} `;
				push(
					`${pin}${member.summary}`,
					detail === undefined ? { kind: "none" } : { kind: "item", member: member.component },
				);
			}
			if (member.content !== undefined) for (const row of member.content(width)) push(row);
			if (!open || detail === undefined) continue;
			for (const row of detail(width)) push(row);
		}
	}

	#hit(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) {
		let y = event.y;
		for (const hit of this.#hits) {
			if (y >= hit.height) {
				y -= hit.height;
				continue;
			}
			const action = hit.action;
			if (action.kind === "none") return undefined;
			if (event.type !== "click" || event.button !== "left") return undefined;
			if (action.kind === "category") {
				const open = this.#category === action.category;
				this.#category = open ? undefined : action.category;
				this.#item = undefined;
				this.#redraw();
				return { handled: true, render: true };
			}
			if (action.kind === "item") {
				this.#item = this.#item === action.member ? undefined : action.member;
				this.#redraw();
				return { handled: true, render: true };
			}
			return action.wrapper.handleMouse?.({ ...event, y, height: hit.height });
		}
		return undefined;
	}

	/**
	 * The member's own rows without Pi's leading separator. Built only for a member the current frame
	 * actually draws, so a collapsed category allocates nothing for the rows it hides.
	 */
	#offsetWrapper(component: Component): Component {
		let offset = 0;
		return {
			render(width) {
				const rows = component.render(width);
				// Pi adds one leading separator per tool; the group supplies its own spacing.
				offset = rows[0] === "" ? 1 : 0;
				return rows.slice(offset);
			},
			handleMouse(event) {
				return component.handleMouse?.({
					...event,
					y: event.y + offset,
					height: event.height + offset,
				});
			},
			invalidate() {},
		};
	}

	/**
	 * A member's rows for the raw view: every original part in order, without Pi's leading separator
	 * and with exactly one blank row between parts (a thinking run keeps its paragraph separation).
	 */
	#memberWrapper(member: Member): Component {
		const parts = memberParts(member);
		let offsets: PartOffset[] = [];
		return {
			render: (width) => {
				const rows: string[] = [];
				const next: PartOffset[] = [];
				for (const part of parts) {
					const all = part.render(width);
					const skip = all[0] === "" ? 1 : 0;
					const own = all.slice(skip);
					if (own.length === 0) continue;
					if (rows.length > 0) rows.push("");
					next.push({ part, top: rows.length, height: own.length, skip });
					rows.push(...own);
				}
				offsets = next;
				return rows;
			},
			handleMouse(event) {
				for (const { part, top, height, skip } of offsets) {
					if (event.y < top || event.y >= top + height) continue;
					return part.handleMouse?.({
						...event,
						y: event.y - top + skip,
						height: height + skip,
					});
				}
				return undefined;
			},
			invalidate() {},
		};
	}

	/**
	 * `clock` belongs to this continuous block. Restored history has none until live content joins it.
	 *
	 * `tail` is the block's last visible unit, which the projection draws outside the group; its calls,
	 * requests, and background state still belong to this block.
	 */
	update(
		members: Member[],
		tail: Member | undefined,
		requests: readonly RequestFact[],
		clock: ToolGroupClock | undefined,
	): void {
		this.#members = members;
		this.#tail = tail;
		this.#requests = requests;
		if (this.#clock === undefined) this.#clock = clock;
		if (this.#item !== undefined && !members.some((m) => m.component === this.#item))
			this.#item = undefined;
		if (this.#category === "thinking" && this.#thinkingItems().length === 0)
			this.#category = undefined;
		if (this.#category === "notices" && this.#noticeItems().length === 0)
			this.#category = undefined;
	}

	override invalidate(): void {
		// Original chatContainer.invalidate invalidates original members exactly once; only the header
		// text belongs to this view.
		this.#header.invalidate();
	}

	override render(width: number): string[] {
		const globalExpanded = this.#ui.getToolsExpanded();
		if (globalExpanded) {
			// The host's forced expansion owns the frame; closing it returns to a fully closed group.
			// A raw view the user opened by hand must not outlive it, or closing Ctrl+O would leave the
			// block expanded with no way back to the aggregate.
			this.#raw = false;
			this.#category = undefined;
			this.#item = undefined;
		}
		this.#renderedExpanded = this.#raw || globalExpanded;
		const theme = this.#ui.theme;
		this.#syncShell();
		this.#box.setBgFn(backgroundFill(theme, this.#surfaceToken()));
		const calls = this.#calls();
		const elapsed =
			this.#clock === undefined
				? "—"
				: formatElapsed((this.#clock.endedAt ?? performance.now()) - this.#clock.startedAt);
		const details = [
			theme.fg("text", "collapse views"),
			theme.fg("dim", elapsed),
			theme.fg("dim", `${calls} ${calls === 1 ? "call" : "calls"}`),
		].join(theme.fg("dim", " · "));
		const pad = Math.max(0, this.#outputPad());
		this.#header.setText(
			fitRow(
				`${" ".repeat(pad)}${theme.fg("dim", this.#renderedExpanded ? "▾" : "▸")} ${details}`,
				Math.max(0, width - pad * 2),
				"…",
			),
		);
		return super.render(width);
	}

	/**
	 * The group shell follows the fold state: a background block around the aggregate, or transparent
	 * rows when the whole block is expanded. Only the shell changes; members keep their components.
	 */
	#syncShell(): void {
		const shell = this.#renderedExpanded ? "raw" : "collapsed";
		if (this.#shell === shell) return;
		this.#shell = shell;
		this.children =
			shell === "raw" ? [this.#spacer, this.#heading, this.#body] : [this.#spacer, this.#box];
	}
}
