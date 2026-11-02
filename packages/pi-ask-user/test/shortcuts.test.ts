import type { KeybindingsManager } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { digitKey, matchesSelectDown, matchesSelectUp } from "../src/shortcuts";

/** Only the binding lookup matters here; key sequences are matched by pi-tui itself. */
const bindings = (...accepted: string[]): KeybindingsManager =>
	({
		matches: (_data: string, binding: string) => accepted.includes(binding),
	}) as KeybindingsManager;

describe("select navigation", () => {
	test("follows the configured select bindings", () => {
		expect(matchesSelectUp("x", bindings("tui.select.up"))).toBe(true);
		expect(matchesSelectDown("x", bindings("tui.select.down"))).toBe(true);
		expect(matchesSelectUp("x", bindings("tui.select.down"))).toBe(false);
	});

	test("keeps shift+tab and tab, and nothing else", () => {
		expect(matchesSelectUp("\u001b[Z", bindings())).toBe(true);
		expect(matchesSelectDown("\t", bindings())).toBe(true);
		expect(matchesSelectUp("\u000b", bindings())).toBe(false);
		expect(matchesSelectDown("\n", bindings())).toBe(false);
	});
});

describe("digitKey", () => {
	test("reads 1-9 and rejects everything else", () => {
		expect(digitKey("3")).toBe(3);
		expect(digitKey("0")).toBeNull();
		expect(digitKey("12")).toBeNull();
		expect(digitKey("\u001b")).toBeNull();
	});
});
