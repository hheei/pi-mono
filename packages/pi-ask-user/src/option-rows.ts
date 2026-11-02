/**
 * Row model shared by the single- and multi-select lists: option rows followed
 * by the optional freeform row, plus the selection cursor and the row budget.
 */
export class OptionRows {
	readonly allowFreeform: boolean;
	selected = 0;
	private maxVisibleRows: number;

	constructor(allowFreeform: boolean, maxVisibleRows: number) {
		this.allowFreeform = allowFreeform;
		this.maxVisibleRows = maxVisibleRows;
	}

	get visibleRows(): number {
		return this.maxVisibleRows;
	}

	/** Rows shown for `optionCount` options: the options plus the trailing freeform row. */
	count(optionCount: number): number {
		return optionCount + (this.allowFreeform ? 1 : 0);
	}

	freeformIndex(optionCount: number): number {
		return optionCount;
	}

	isFreeformRow(index: number, optionCount: number): boolean {
		return this.allowFreeform && index === this.freeformIndex(optionCount);
	}

	setMaxVisibleRows(rows: number): boolean {
		const next = Math.max(1, Math.floor(rows));
		if (next === this.maxVisibleRows) return false;
		this.maxVisibleRows = next;
		return true;
	}

	/** Move the cursor by `delta` rows, wrapping around `count` rows. */
	moveSelection(delta: number, count: number): boolean {
		if (count <= 0) return false;
		const next = (this.selected + delta + count) % count;
		if (next === this.selected) return false;
		this.selected = next;
		return true;
	}

	/** Keep the cursor inside `count` rows after the row set changed. */
	clampSelection(count: number): boolean {
		const next = count > 0 ? Math.max(0, Math.min(this.selected, count - 1)) : 0;
		if (next === this.selected) return false;
		this.selected = next;
		return true;
	}
}

/** One item's rendered rows: an option or the freeform row. */
export interface RowBlock<T = string> {
	itemIndex: number;
	lines: T[];
}

/**
 * The blocks that fit in `maxRows`, keeping the selected block visible and
 * filling the budget with following blocks first and preceding ones after
 * that. The last row is reserved for the caller's overflow indicator, so the
 * selected block is cut when it alone exceeds the budget. Returns the input
 * array unchanged when everything fits.
 */
export function visibleBlockWindow<T>(
	blocks: RowBlock<T>[],
	selectedIndex: number,
	maxRows: number,
): RowBlock<T>[] {
	const totalRows = blocks.reduce((sum, block) => sum + block.lines.length, 0);
	if (totalRows <= maxRows) return blocks;

	const availableRows = maxRows > 1 ? maxRows - 1 : 1;
	const selected = blocks[selectedIndex] ?? blocks[0];
	if (!selected) return [];
	if (selected.lines.length >= availableRows) {
		return [{ itemIndex: selected.itemIndex, lines: selected.lines.slice(0, availableRows) }];
	}

	let startIndex = selectedIndex;
	let endIndex = selectedIndex + 1;
	let usedRows = selected.lines.length;

	while (true) {
		const nextBlock = blocks[endIndex];
		if (nextBlock && usedRows + nextBlock.lines.length <= availableRows) {
			usedRows += nextBlock.lines.length;
			endIndex += 1;
			continue;
		}

		const previousBlock = blocks[startIndex - 1];
		if (previousBlock && usedRows + previousBlock.lines.length <= availableRows) {
			startIndex -= 1;
			usedRows += previousBlock.lines.length;
			continue;
		}

		break;
	}

	return blocks.slice(startIndex, endIndex);
}
