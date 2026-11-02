import { describe, expect, test } from "vitest";
import { OptionRows, type RowBlock, visibleBlockWindow } from "../src/option-rows";

const block = (itemIndex: number, ...lines: string[]): RowBlock => ({ itemIndex, lines });

describe("OptionRows", () => {
	test("maps the option rows and the trailing freeform row", () => {
		const withFreeform = new OptionRows(true, 10);
		expect(withFreeform.count(3)).toBe(4);
		expect(withFreeform.freeformIndex(3)).toBe(3);
		expect(withFreeform.isFreeformRow(3, 3)).toBe(true);
		expect(withFreeform.isFreeformRow(2, 3)).toBe(false);

		const withoutFreeform = new OptionRows(false, 10);
		expect(withoutFreeform.count(3)).toBe(3);
		expect(withoutFreeform.isFreeformRow(3, 3)).toBe(false);
	});

	test("moves the cursor with wraparound and clamps it into the row set", () => {
		const rows = new OptionRows(false, 10);
		expect(rows.moveSelection(-1, 3)).toBe(true);
		expect(rows.selected).toBe(2);
		expect(rows.moveSelection(1, 3)).toBe(true);
		expect(rows.selected).toBe(0);
		expect(rows.moveSelection(1, 0)).toBe(false);

		rows.selected = 7;
		expect(rows.clampSelection(3)).toBe(true);
		expect(rows.selected).toBe(2);
		expect(rows.clampSelection(3)).toBe(false);
		expect(rows.clampSelection(0)).toBe(true);
		expect(rows.selected).toBe(0);
	});

	test("never shrinks the row budget below one", () => {
		const rows = new OptionRows(false, 10);
		expect(rows.setMaxVisibleRows(0)).toBe(true);
		expect(rows.visibleRows).toBe(1);
		expect(rows.setMaxVisibleRows(1)).toBe(false);
	});
});

describe("visibleBlockWindow", () => {
	const blocks = [block(0, "a"), block(1, "b1", "b2", "b3"), block(2, "c")];

	test("returns every block when they fit", () => {
		expect(visibleBlockWindow(blocks, 1, 10)).toBe(blocks);
	});

	test("keeps the selected block visible and reserves the indicator row", () => {
		const window = visibleBlockWindow(blocks, 1, 4);
		expect(window).not.toBe(blocks);
		expect(window).toEqual([block(1, "b1", "b2", "b3")]);
		expect(window.flatMap((entry) => entry.lines).length).toBeLessThan(4);
	});

	test("cuts a selected block that alone exceeds the budget", () => {
		expect(visibleBlockWindow(blocks, 1, 3)).toEqual([block(1, "b1", "b2")]);
	});

	test("fills the remaining budget with following blocks first", () => {
		const paired = [block(0, "a1", "a2"), block(1, "b"), block(2, "c", "c2")];
		expect(visibleBlockWindow(paired, 0, 4).flatMap((entry) => entry.lines)).toEqual([
			"a1",
			"a2",
			"b",
		]);
	});
});
