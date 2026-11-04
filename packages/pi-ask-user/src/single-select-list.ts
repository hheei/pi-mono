import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager } from "@earendil-works/pi-tui";
import { fitRow } from "@hheei/pi-ext-core";
import { OptionRows } from "./option-rows";
import { digitKey, matchesSelectDown, matchesSelectUp } from "./shortcuts";
import {
	type AnnotatedRow,
	type QuestionOption,
	renderSingleSelectRows,
} from "./single-select-layout";

export class WrappedSingleSelectList implements Component {
	private options: QuestionOption[];
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private readonly rows: OptionRows;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	public onCancel?: () => void;
	public onSubmit?: (result: string) => void;
	public onEnterFreeform?: () => void;

	constructor(
		options: QuestionOption[],
		allowFreeform: boolean,
		theme: Theme,
		keybindings: KeybindingsManager,
	) {
		this.options = options;
		this.theme = theme;
		this.keybindings = keybindings;
		this.rows = new OptionRows(allowFreeform, 12);
	}

	setMaxVisibleRows(count: number): void {
		if (this.rows.setMaxVisibleRows(count)) this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private styleListLine(row: AnnotatedRow, width: number): string {
		const text = row.line;
		if (row.kind === "indicator") return fitRow(this.theme.fg("dim", text), width, "");
		if (row.selected) return fitRow(this.theme.fg("accent", this.theme.bold(text)), width, "");
		if (row.kind === "description") return fitRow(this.theme.fg("muted", text), width, "");
		return fitRow(this.theme.fg("text", text), width, "");
	}

	private buildLines(width: number): string[] {
		const count = this.rows.count(this.options.length);
		if (count === 0) return [fitRow(this.theme.fg("warning", "No options"), width, "")];

		const optionRows = renderSingleSelectRows({
			options: this.options,
			selectedIndex: this.rows.selected,
			width,
			allowFreeform: this.rows.allowFreeform,
			maxRows: this.rows.visibleRows,
		});
		return optionRows.map((row) => this.styleListLine(row, width));
	}

	/** Enter on the selected row: open the custom response, or choose the option. */
	private confirm(): void {
		const index = this.rows.selected;
		if (this.rows.isFreeformRow(index, this.options.length)) {
			this.onEnterFreeform?.();
			return;
		}

		const result = this.options[index]?.title;
		if (result) this.onSubmit?.(result);
		else this.onCancel?.();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}

		const count = this.rows.count(this.options.length);
		if (matchesSelectUp(data, this.keybindings) && this.rows.moveSelection(-1, count)) {
			this.invalidate();
			return;
		}

		if (matchesSelectDown(data, this.keybindings) && this.rows.moveSelection(1, count)) {
			this.invalidate();
			return;
		}

		const digit = digitKey(data);
		if (digit !== null) {
			if (digit <= this.options.length) {
				this.rows.selected = digit - 1;
				this.invalidate();
				return;
			}
			if (this.rows.allowFreeform && digit === this.options.length + 1) {
				this.onEnterFreeform?.();
				return;
			}
		}

		if (this.keybindings.matches(data, "tui.select.confirm") && count > 0) {
			this.confirm();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const count = this.rows.count(this.options.length);
		this.rows.clampSelection(count);
		const lines = this.buildLines(width);

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
