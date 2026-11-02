import { describe, expect, test } from "vitest";
import { getMaxRenderLinesForRows } from "../src/prompt-layout";

describe("getMaxRenderLinesForRows", () => {
	test("falls back to a 24-row terminal", () => {
		expect(getMaxRenderLinesForRows(Number.NaN)).toBe(getMaxRenderLinesForRows(24));
		expect(getMaxRenderLinesForRows(24)).toBeGreaterThan(getMaxRenderLinesForRows(8));
	});
});
