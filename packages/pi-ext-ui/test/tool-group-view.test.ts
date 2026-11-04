import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type Member, TailUnit, ToolGroupView } from "../src/tool-group-view.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function ui(themeOverride: Theme = theme): ExtensionUIContext {
	return { theme: themeOverride, getToolsExpanded: () => false } as ExtensionUIContext;
}

/** A theme that marks every background it paints, so a row states which surface owns it. */
function markedTheme(): Theme {
	return { ...theme, bg: (token: string, text: string) => `[${token}]${text}[/]` } as Theme;
}

function settledMember(): Member {
	return {
		kind: "tool",
		component: { render: () => ["row"], invalidate() {} },
		status: "ok",
		completed: true,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("TailUnit total height minimum", () => {
	test("one row pads, two or more pass through, and tall frames leave no reservation", () => {
		let rows = ["head"];
		const tail = new TailUnit(
			{
				kind: "tool",
				component: { render: () => rows, invalidate() {} },
			},
			() => false,
		);
		for (const content of [["head"], ["head", "body"], ["head", "", "body"], ["head"]]) {
			rows = content;
			const expected = ["", ...content, ...(content.length === 1 ? [""] : [])];
			expect(tail.render(20)).toEqual(expected);
			expect(tail.render(20)).toEqual(expected);
		}
		rows = [];
		expect(tail.render(20)).toEqual([]);
	});

	test("counts surface padding and leaves the trailing row outside hit areas", () => {
		const handleMouse = vi.fn(() => ({ handled: true }));
		const render = vi.fn(() => {
			return ["", "SURFACE TOP", "head", "SURFACE BOTTOM"];
		});
		const tail = new TailUnit(
			{
				kind: "tool",
				component: { render, handleMouse, invalidate() {} },
			},
			() => true,
		);
		expect(tail.render(20)).toEqual(["", "SURFACE TOP", "head", "SURFACE BOTTOM", ""]);
		expect(render).toHaveBeenCalledTimes(1);
		const event = {
			type: "click",
			button: "left",
			x: 0,
			y: 4,
			screenX: 0,
			screenY: 4,
			width: 20,
			height: 5,
			shift: false,
			alt: false,
			ctrl: false,
		} as const;
		expect(tail.handleMouse(event)).toBeUndefined();
		expect(handleMouse).not.toHaveBeenCalled();
		expect(tail.handleMouse({ ...event, y: 2 })).toEqual({ handled: true });
		expect(handleMouse).toHaveBeenCalledWith({ ...event, y: 2, height: 4 });
	});

	test("preserves OSC markers without counting the leading marker row as content", () => {
		const start = "\x1b]133;A\x07";
		const end = "\x1b]133;B\x07\x1b]133;C\x07";
		const tail = new TailUnit(
			{
				kind: "thinking",
				component: { render: () => [start, `${end}thought`], invalidate() {} },
			},
			() => false,
		);
		expect(tail.render(20)).toEqual([start, `${end}thought`, ""]);
	});

	test("does not pad individual parts of a continuous thinking tail", () => {
		const one = { render: () => ["", "first"], invalidate() {} };
		const two = { render: () => ["", "second"], invalidate() {} };
		const tail = new TailUnit({ kind: "thinking", component: one, parts: [one, two] }, () => false);
		expect(tail.render(20)).toEqual(["", "first", "", "second"]);
	});

	test.each([
		"tool",
		"thinking",
	] as const)("colored %s tails use four total rows and track background toggles", (kind) => {
		let colored = true;
		let rows = ["head"];
		const tail = new TailUnit(
			{ kind, component: { render: () => rows, invalidate() {} } },
			() => colored,
		);
		for (const count of [1, 2, 3, 4, 6, 1]) {
			rows = Array.from({ length: count }, () => "body");
			const expected = ["", ...rows, ...Array.from({ length: Math.max(0, 4 - count) }, () => "")];
			expect(tail.render(30)).toEqual(expected);
			expect(tail.render(120)).toEqual(expected);
		}
		colored = false;
		expect(tail.render(30)).toEqual(["", "body", ""]);
		rows = [];
		colored = true;
		expect(tail.render(30)).toEqual([]);
	});

	test.each([
		["tool", { completed: true }],
		["thinking", { thinkingHidden: true }],
		["notice", {}],
	] as const)("a %s tail that cannot grow gets no floor", (kind, extra) => {
		let colored = true;
		const rows = ["head"];
		const tail = new TailUnit(
			{ kind, component: { render: () => rows, invalidate() {} }, ...extra },
			() => colored,
		);
		expect(tail.render(30)).toEqual(["", "head"]);
		colored = false;
		expect(tail.render(30)).toEqual(["", "head"]);
	});
});

describe("ToolGroupView lifetime", () => {
	test("group content shrinks naturally instead of retaining surface padding", () => {
		const group = new ToolGroupView(
			ui(),
			() => undefined,
			() => false,
			() => 0,
		);
		const component = { render: () => [], invalidate() {} };
		const notice = (rows: string[]): Member => ({ kind: "notice", component, content: () => rows });
		const clock = { startedAt: 0 };
		group.update([notice(["a"])], undefined, [], clock);
		group.render(40);
		group.children[1]?.handleMouse?.({
			type: "click",
			button: "left",
			x: 1,
			y: 2,
			screenX: 1,
			screenY: 2,
			width: 40,
			height: 20,
			shift: false,
			alt: false,
			ctrl: false,
		});
		const short = group.render(40);
		group.update([notice(["a", "b", "c"])], undefined, [], clock);
		expect(group.render(40)).toHaveLength(short.length + 2);
		group.update([notice(["a"])], undefined, [], clock);
		expect(group.render(40)).toEqual(short);
		group.dispose();
	});

	test("surface fade requests one repaint without changing group height", () => {
		vi.useFakeTimers();
		const redraw = vi.fn();
		const group = new ToolGroupView(
			ui(),
			redraw,
			() => true,
			() => 0,
		);
		group.update([settledMember()], undefined, [], undefined);
		const height = group.render(40).length;
		vi.advanceTimersByTime(5_000);
		expect(redraw).toHaveBeenCalledTimes(1);
		expect(group.render(40)).toHaveLength(height);
		group.dispose();
	});

	test("a transparent block owns no surface, so it never asks for a fade", () => {
		vi.useFakeTimers();
		const redraw = vi.fn();
		const group = new ToolGroupView(
			ui(),
			redraw,
			() => false,
			() => 0,
		);
		group.update([settledMember()], undefined, [], undefined);
		const rows = group.render(40);
		vi.advanceTimersByTime(5_000);
		expect(redraw).not.toHaveBeenCalled();
		// No fill means no breathing rows either: the block is exactly its own rows.
		const filled = new ToolGroupView(
			ui(markedTheme()),
			() => undefined,
			() => true,
			() => 0,
		);
		filled.update([settledMember()], undefined, [], undefined);
		expect(filled.render(40)).toHaveLength(rows.length + 2);
		filled.dispose();
		group.dispose();
	});

	test("a later call keeps the settled surface instead of re-tinting the block", () => {
		vi.useFakeTimers();
		let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		const group = new ToolGroupView(
			ui(markedTheme()),
			() => undefined,
			() => true,
			() => 0,
		);
		const settled = settledMember();
		group.update([settled], undefined, [], undefined);
		expect(group.render(40).join("\n")).toContain("[toolSuccessBg]");
		// A call that starts later must not flip the block back to the neutral surface.
		now = 1_000;
		const live = { ...settledMember(), status: "running" as const };
		group.update([settled, live], undefined, [], undefined);
		expect(group.render(40).join("\n")).toContain("[toolSuccessBg]");
		// The hold counts from the block's first settle, so it still ends on time.
		now = 5_001;
		vi.advanceTimersByTime(5_001);
		expect(group.render(40).join("\n")).toContain("[toolPendingBg]");
		group.dispose();
		clock.mockRestore();
		vi.useRealTimers();
	});

	test("dispose cancels the pending surface hold, and is idempotent", () => {
		vi.useFakeTimers();
		const redraw = vi.fn();
		const group = new ToolGroupView(
			ui(),
			redraw,
			() => false,
			() => 0,
		);
		group.update([settledMember()], undefined, [], undefined);
		group.render(40);
		group.dispose();
		group.dispose();
		vi.advanceTimersByTime(5_000);
		expect(redraw).not.toHaveBeenCalled();
	});
});

describe("ToolGroupView expanded layout", () => {
	test("the title keeps the surface and the totals, and the members stay transparent", () => {
		const expanded = {
			theme: markedTheme(),
			getToolsExpanded: () => true,
		} as ExtensionUIContext;
		const group = new ToolGroupView(
			expanded,
			() => undefined,
			() => true,
			() => 0,
		);
		group.update([settledMember()], undefined, [{}], { startedAt: 0 });
		const rows = group.render(120);
		const title = rows.findIndex((row) => row.includes("collapse views"));
		// The totals live in the title, so nothing trails the last member.
		expect(rows[title]).toContain("requests ×1");
		expect(rows.at(-1)).not.toContain("requests ×1");
		// The title is its own filled surface: one breathing row above and below.
		expect(rows[title - 1]).toContain("[toolSuccessBg]");
		expect(rows[title + 1]).toContain("[toolSuccessBg]");
		// One plain blank row separates the title from the first member.
		expect(rows[title + 2]?.trim()).toBe("");
		expect(rows[title + 2]).not.toContain("[toolSuccessBg]");
		// The members below keep only the styling they draw themselves.
		expect(rows.slice(title + 2).every((row) => !row.includes("[toolSuccessBg]"))).toBe(true);
		group.dispose();
	});

	test("a transparent expanded title has no breathing rows but keeps the gap", () => {
		const expanded = { theme, getToolsExpanded: () => true } as ExtensionUIContext;
		const group = new ToolGroupView(
			expanded,
			() => undefined,
			() => false,
			() => 0,
		);
		group.update([settledMember()], undefined, [{}], { startedAt: 0 });
		const rows = group.render(40);
		const title = rows.findIndex((row) => row.includes("collapse views"));
		expect(rows[title - 1]?.trim()).toBe("");
		expect(rows[title + 1]?.trim()).toBe("");
		expect(rows[title + 2]).toContain("row");
		group.dispose();
	});
});

describe("ToolGroupView output padding", () => {
	test("frame rows take Pi's output padding, so they line up with the tool rows they wrap", () => {
		const rows = (pad: number): string[] => {
			const group = new ToolGroupView(
				ui(),
				() => undefined,
				() => false,
				() => pad,
			);
			group.update([settledMember()], undefined, [], { startedAt: 0 });
			const rendered = group.render(20).filter((row) => row.trim() !== "");
			group.dispose();
			return rendered;
		};
		const flush = rows(0);
		expect(flush.every((row) => !row.startsWith(" "))).toBe(true);
		const padded = rows(1);
		expect(padded).toHaveLength(flush.length);
		expect(padded.every((row) => row.startsWith(" ") && !row.startsWith("  "))).toBe(true);
	});
});
