import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	decodeKittyPrintable,
	Key,
	type KeybindingsManager,
	matchesKey,
	type TUI,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { AskComponent } from "./ask-prompt";
import { INLINE_DOCK_RESERVED_ROWS } from "./constants";
import { formatKeyList } from "./prompt-help";
import { getMaxRenderLinesForRows } from "./prompt-layout";
import {
	type AskResponse,
	type AskUIResult,
	type BatchAnswer,
	formatResponseSummary,
} from "./response";
import type { BatchQuestion } from "./schema";

/**
 * One prompt for a whole `questions` batch: a page per question plus a review
 * page. Each page is an AskComponent that stays alive, so drafts and checkboxes
 * survive moving between pages. Answers are recorded per page and only the
 * review page submits; esc that would cancel a page cancels the batch.
 */
export class BatchAskComponent implements Component {
	private pages: AskComponent[];
	private answers: Array<AskResponse | undefined>;
	private current = 0;
	private title = "";
	private confirmingSkips = false;
	private _focused = false;

	constructor(
		private questions: BatchQuestion[],
		private tui: TUI,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private onDone: (answers: BatchAnswer[] | null) => void,
		private heading?: string,
	) {
		this.answers = questions.map(() => undefined);
		this.pages = questions.map(
			(entry, index) =>
				new AskComponent(entry, tui, theme, keybindings, (result) =>
					this.handlePageDone(index, result),
				),
		);
		this.updateChrome();
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		const page = this.pages[this.current];
		if (page) page.focused = value;
	}

	invalidate(): void {
		for (const page of this.pages) page.invalidate();
	}

	render(width: number): string[] {
		const page = this.pages[this.current];
		return page ? page.render(width) : this.renderReview(width);
	}

	handleInput(data: string): void {
		const pageCount = this.questions.length + 1;
		// Tab and shift+tab move between pages here; inside a page, arrows still
		// move the option selection.
		if (matchesKey(data, Key.tab)) {
			this.goTo((this.current + 1) % pageCount);
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.goTo((this.current + pageCount - 1) % pageCount);
			return;
		}
		const page = this.pages[this.current];
		if (page) {
			page.handleInput(data);
			return;
		}
		this.handleReviewInput(data);
	}

	private handlePageDone(index: number, result: AskUIResult | null): void {
		if (result === null) {
			this.onDone(null);
			return;
		}
		this.answers[index] = result;
		const count = this.questions.length;
		for (let step = 1; step <= count; step++) {
			const next = (index + step) % count;
			if (!this.answers[next]) {
				this.goTo(next);
				return;
			}
		}
		this.goTo(count);
	}

	private goTo(target: number): void {
		const previous = this.pages[this.current];
		if (previous) previous.focused = false;
		this.current = target;
		this.confirmingSkips = false;
		const next = this.pages[target];
		if (next) next.focused = this._focused;
		this.updateChrome();
		this.tui.requestRender();
	}

	private updateChrome(): void {
		const labels = this.questions.map((_, index) => {
			const label = `${index + 1}${this.answers[index] ? "\u2713" : ""}`;
			return index === this.current ? `[${label}]` : label;
		});
		const review = this.current === this.questions.length ? "[review]" : "review";
		// The strip is one terminal row, so the heading's line breaks collapse here only.
		const heading = this.heading ? ` \u00b7 ${this.heading.replace(/\s+/g, " ").slice(0, 40)}` : "";
		this.title = `ask_user${heading} ${labels.join(" ")} \u00b7 ${review}`;
		const hint = "\u21e5 questions";
		for (const page of this.pages) page.setBatchChrome(this.title, hint);
	}

	/** Submit from the review page; with unanswered questions, the first submit asks to confirm. */
	private submitReview(): void {
		if (this.unansweredCount() > 0 && !this.confirmingSkips) {
			this.confirmingSkips = true;
			this.tui.requestRender();
			return;
		}
		this.onDone(
			this.answers.map(
				(response): BatchAnswer =>
					response ? { status: "answered", response } : { status: "skipped" },
			),
		);
	}

	private unansweredCount(): number {
		return this.answers.filter((answer) => !answer).length;
	}

	private handleReviewInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onDone(null);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.submitReview();
			return;
		}
		// Kitty's keyboard protocol can deliver digits as CSI-u sequences.
		const key = decodeKittyPrintable(data) ?? data;
		const jump = key.length === 1 ? Number.parseInt(key, 10) : Number.NaN;
		if (jump >= 1 && jump <= this.questions.length) this.goTo(jump - 1);
	}

	private renderReview(width: number): string[] {
		const theme = this.theme;
		const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(1, width - 1));
		const answerLines = this.questions.flatMap((entry, index) => {
			const response = this.answers[index];
			const marker = response ? theme.fg("success", "\u2713") : theme.fg("warning", "\u25cb");
			return [
				...wrap(`${marker} ${theme.fg("text", `${index + 1}. ${entry.question}`)}`),
				...wrap(
					response
						? `   ${theme.fg("dim", "\u2192")} ${theme.fg("accent", formatResponseSummary(response))}`
						: `   ${theme.fg("warning", "unanswered")}`,
				),
			];
		});

		const unanswered = this.unansweredCount();
		const confirmKey = formatKeyList(this.keybindings.getKeys("tui.select.confirm"));
		const cancelKey = formatKeyList(this.keybindings.getKeys("tui.select.cancel"));
		const hints = [
			`${confirmKey} ${unanswered > 0 ? "submit with skips" : "submit"}`,
			`1-${this.questions.length} edit`,
			"\u21e5 questions",
			`${cancelKey} cancel`,
		].join(" \u00b7 ");
		const warning = this.confirmingSkips
			? theme.fg("warning", `${unanswered} unanswered \u2014 press ${confirmKey} again to submit`)
			: undefined;
		const footerLines = [...(warning ? wrap(warning) : []), ...wrap(theme.fg("dim", hints))];

		// The title and the footer are fixed; the answers take what is left and are
		// cut from the end, so a short prompt still shows the first ones.
		const budget = Math.max(1, this.reviewLineCap() - 1 - footerLines.length);
		return [theme.fg("dim", this.title), ...answerLines.slice(0, budget), ...footerLines];
	}

	/** Rows the review page may use. */
	private reviewLineCap(): number {
		const rows = Number.isFinite(this.tui.terminal.rows) ? Math.floor(this.tui.terminal.rows) : 24;
		// Inline prompts sit in Pi's fullscreen input dock, which clips anything
		// taller than what remains after the transcript's minimum row, the
		// working status, and the 2-3 row footer. Components only learn their
		// width, so stay within that space instead of growing with the content.
		const cap = getMaxRenderLinesForRows(rows);
		return Math.max(4, Math.min(cap, rows - INLINE_DOCK_RESERVED_ROWS));
	}
}
