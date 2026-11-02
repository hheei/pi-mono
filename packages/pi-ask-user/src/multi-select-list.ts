import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	type KeybindingsManager,
	matchesKey,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { fitRow } from "@hheei/pi-ext-core";
import { FREEFORM_HINT, FREEFORM_LABEL } from "./constants";
import { OptionRows, type RowBlock, visibleBlockWindow } from "./option-rows";
import { digitKey, matchesSelectDown, matchesSelectUp } from "./shortcuts";
import type { QuestionOption } from "./single-select-layout";

export class MultiSelectList implements Component {
	private options: QuestionOption[];
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private readonly rows: OptionRows;
	private checked = new Set<number>();
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	public onCancel?: () => void;
	public onSubmit?: (result: string[]) => void;
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
		this.rows = new OptionRows(allowFreeform, 10);
	}

	setMaxVisibleRows(count: number): void {
		if (this.rows.setMaxVisibleRows(count)) this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private toggle(index: number): void {
		if (index < 0 || index >= this.options.length) return;
		if (this.checked.has(index)) this.checked.delete(index);
		else this.checked.add(index);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}

		const optionCount = this.options.length;
		const count = this.rows.count(optionCount);
		if (count === 0) {
			this.onCancel?.();
			return;
		}

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
			if (digit <= optionCount) {
				this.toggle(digit - 1);
				this.rows.selected = Math.min(digit - 1, count - 1);
				this.invalidate();
			}
			return;
		}

		if (matchesKey(data, Key.space)) {
			this.activate();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (this.rows.isFreeformRow(this.rows.selected, optionCount)) {
				this.activate();
				return;
			}
			this.submit();
		}
	}

	/** Space on the selected row: tick the option, or open the custom response. */
	private activate(): void {
		const index = this.rows.selected;
		if (this.rows.isFreeformRow(index, this.options.length)) {
			this.onEnterFreeform?.();
			return;
		}
		this.toggle(index);
		this.invalidate();
	}

	/** Submit the ticked options, or the selected one when none is ticked. */
	submit(): void {
		const selectedTitles = Array.from(this.checked)
			.sort((a, b) => a - b)
			.map((i) => this.options[i]?.title)
			.filter((title): title is string => !!title);

		const fallback = this.options[this.rows.selected]?.title;
		const result = selectedTitles.length > 0 ? selectedTitles : fallback ? [fallback] : [];

		if (result.length > 0) this.onSubmit?.(result);
		else this.onCancel?.();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const theme = this.theme;
		const optionCount = this.options.length;
		const count = this.rows.count(optionCount);

		if (count === 0) {
			this.cachedLines = [theme.fg("warning", "No options")];
			this.cachedWidth = width;
			return this.cachedLines;
		}

		this.rows.clampSelection(count);
		const blocks: RowBlock[] = [];

		for (let i = 0; i < count; i++) {
			const isSelected = i === this.rows.selected;
			const prefix = isSelected ? theme.fg("accent", "→") : " ";
			const block: string[] = [];

			if (this.rows.isFreeformRow(i, optionCount)) {
				const label = theme.fg("text", theme.bold(FREEFORM_LABEL));
				const desc = theme.fg("muted", FREEFORM_HINT);
				block.push(fitRow(`${prefix}   ${label} ${theme.fg("dim", "—")} ${desc}`, width, ""));
			} else {
				const option = this.options[i];
				if (option) {
					const checkbox = this.checked.has(i)
						? theme.fg("success", "[✓]")
						: theme.fg("dim", "[ ]");
					const num = theme.fg("dim", `${i + 1}.`);
					const title = isSelected
						? theme.fg("accent", theme.bold(option.title))
						: theme.fg("text", theme.bold(option.title));

					block.push(fitRow(`${prefix} ${num} ${checkbox} ${title}`, width, ""));

					if (option.description) {
						const indent = "      ";
						for (const line of wrapTextWithAnsi(
							option.description,
							Math.max(8, width - indent.length),
						)) {
							block.push(fitRow(indent + theme.fg("muted", line), width, ""));
						}
					}
				}
			}

			blocks.push({ itemIndex: i, lines: block });
		}

		const maxRows = this.rows.visibleRows;
		const window = visibleBlockWindow(blocks, this.rows.selected, maxRows);
		const lines = window.flatMap((block) => block.lines);
		if (window !== blocks && maxRows > 1) {
			lines.push(theme.fg("dim", fitRow(`  (${this.rows.selected + 1}/${count})`, width, "")));
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
