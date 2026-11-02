import { describe, expect, test } from "vitest";
import {
	contextShouldCollapse,
	getOverlayMaxRenderLinesForRows,
	modeMinRows,
	modePreferredRows,
	overlayHelpBudget,
	planOverlayBody,
} from "../src/prompt-layout";

const body = (overrides: Partial<Parameters<typeof planOverlayBody>[0]> = {}) =>
	planOverlayBody({
		maxRenderLines: 24,
		mode: "select",
		contextCollapsible: false,
		promptRows: 2,
		helpRows: 1,
		...overrides,
	});

describe("planOverlayBody", () => {
	test("keeps prompt and mode inside the frame body", () => {
		const plan = body();
		expect(plan.bodyCapacity).toBe(24);
		expect(
			plan.promptBudget + plan.modeBudget + plan.separatorRows + plan.helpBudget,
		).toBeLessThanOrEqual(plan.bodyCapacity);
	});

	test("gives select mode its preferred height when rows allow", () => {
		expect(body().modeBudget).toBe(modePreferredRows("select"));
		expect(body().separatorRows).toBe(1);
	});

	test("shrinks the mode body before the prompt on short terminals", () => {
		const plan = body({ maxRenderLines: 8, promptRows: 6 });
		expect(plan.modeBudget).toBeGreaterThanOrEqual(1);
		expect(plan.promptBudget).toBeGreaterThanOrEqual(1);
		expect(plan.promptBudget + plan.modeBudget).toBeLessThanOrEqual(plan.contentRows);
	});

	test("the freeform editor budgets the rows it asks for", () => {
		expect(body({ mode: "freeform" }).modeBudget).toBe(modePreferredRows("freeform"));
	});

	test("keeps one content row and the help row on a two-row overlay", () => {
		const plan = body({ maxRenderLines: 2, promptRows: 5, helpRows: 2 });
		expect(plan).toEqual({
			bodyCapacity: 2,
			helpBudget: 1,
			contentRows: 1,
			promptBudget: 1,
			modeBudget: 0,
			separatorRows: 0,
		});
	});
});

describe("contextShouldCollapse", () => {
	const input = {
		displayMode: "overlay" as const,
		mode: "select" as const,
		contextCollapsible: true,
		questionRows: 1,
		contextRows: 2,
		bodyCapacity: 22,
		helpRows: 1,
	};

	test("inline mode follows the row budget", () => {
		expect(
			contextShouldCollapse({ ...input, displayMode: "inline", contextCollapsible: true }),
		).toBe(true);
		expect(
			contextShouldCollapse({ ...input, displayMode: "inline", contextCollapsible: false }),
		).toBe(false);
	});

	test("overlay keeps context open while the prompt still fits", () => {
		expect(contextShouldCollapse(input)).toBe(false);
	});

	test("overlay collapses context when the prompt would not fit", () => {
		expect(contextShouldCollapse({ ...input, contextRows: 40 })).toBe(true);
	});

	test("no context never collapses", () => {
		expect(contextShouldCollapse({ ...input, contextRows: 0, contextCollapsible: false })).toBe(
			false,
		);
	});

	test("editor modes follow the row budget", () => {
		expect(contextShouldCollapse({ ...input, mode: "freeform", contextCollapsible: true })).toBe(
			true,
		);
	});
});

describe("row budgets", () => {
	test("mode rows grow with the mode", () => {
		expect(modeMinRows("select")).toBeLessThan(modeMinRows("freeform"));
		expect(modePreferredRows("select")).toBeLessThan(modePreferredRows("freeform"));
	});

	test("help keeps at most two rows and only when there is body room", () => {
		expect(overlayHelpBudget(0, 2)).toBe(0);
		expect(overlayHelpBudget(20, 0)).toBe(0);
		expect(overlayHelpBudget(6, 3)).toBe(1);
		expect(overlayHelpBudget(20, 3)).toBe(2);
	});

	test("overlay height falls back to a 24-row terminal", () => {
		expect(getOverlayMaxRenderLinesForRows(Number.NaN)).toBe(getOverlayMaxRenderLinesForRows(24));
		expect(getOverlayMaxRenderLinesForRows(24)).toBeGreaterThan(getOverlayMaxRenderLinesForRows(8));
	});
});
