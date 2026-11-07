import { readFile, rm } from "node:fs/promises";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
	budgetMultiplier,
	CHARS_PER_TOKEN,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_TOKENS,
	fitsOutputBudget,
	limitsForCalls,
	MAX_BUDGET_MULTIPLIER,
	SPILL_NOTE_PREFIX,
	truncateWithSpill,
} from "../src/tool-output.js";
import { capToolResult, outputPrefixFor } from "../src/tool-output-cap.js";

function textEvent(toolName: string, text: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "call",
		toolName,
		input: {},
		content: [{ type: "text", text }],
		isError: false,
	} as ToolResultEvent;
}

describe("tool output budget", () => {
	test("defaults every tool to the same 5000 token budget", () => {
		expect(DEFAULT_MAX_TOKENS).toBe(5_000);
		expect(CHARS_PER_TOKEN).toBe(4);
		expect(DEFAULT_MAX_BYTES).toBe(20_000);
	});

	test("keeps the multiplier at 1 for a single call and caps it at the ceiling", () => {
		expect(budgetMultiplier(1)).toBe(1);
		expect(budgetMultiplier(0)).toBe(1);
		expect(budgetMultiplier(2)).toBe(1.5);
		expect(budgetMultiplier(7)).toBe(2);
		expect(budgetMultiplier(8)).toBe(MAX_BUDGET_MULTIPLIER);
		expect(budgetMultiplier(10_000)).toBe(MAX_BUDGET_MULTIPLIER);
	});

	test("scales the byte budget with the call count and keeps Pi's line bound", () => {
		expect(limitsForCalls(1).maxBytes).toBe(DEFAULT_MAX_BYTES);
		expect(limitsForCalls(2).maxBytes).toBe(DEFAULT_MAX_BYTES * 1.5);
		expect(limitsForCalls(8).maxBytes).toBe(DEFAULT_MAX_BYTES * MAX_BUDGET_MULTIPLIER);
		expect(limitsForCalls(8).maxLines).toBe(limitsForCalls(1).maxLines);
	});

	test("reports whether text fits without touching the disk", () => {
		expect(fitsOutputBudget("short output")).toBe(true);
		expect(fitsOutputBudget("x".repeat(DEFAULT_MAX_BYTES))).toBe(true);
		expect(fitsOutputBudget("x".repeat(DEFAULT_MAX_BYTES + 1))).toBe(false);
	});

	test("returns text unchanged when it fits", async () => {
		const result = await truncateWithSpill("short output", "tt", limitsForCalls(1));
		expect(result.truncated).toBe(false);
		expect(result.text).toBe("short output");
		expect(result.fullOutputPath).toBeUndefined();
	});

	test("keeps both the head and the tail and puts the middle on disk", async () => {
		const head = "HEAD-MARKER\n";
		const tail = "\nTAIL-MARKER";
		const middle = "m".repeat(DEFAULT_MAX_BYTES * 2);
		const result = await truncateWithSpill(`${head}${middle}${tail}`, "tt", limitsForCalls(1));
		expect(result.truncated).toBe(true);
		// Both ends are what the model acts on, so neither may be dropped.
		expect(result.text).toContain("HEAD-MARKER");
		expect(result.text).toContain("TAIL-MARKER");
		expect(result.text).toContain(SPILL_NOTE_PREFIX);
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThan(DEFAULT_MAX_BYTES * 2);
		const path = result.fullOutputPath ?? "";
		expect(await readFile(path, "utf8")).toBe(`${head}${middle}${tail}`);
		await rm(path, { force: true });
	});

	test("cuts a single oversized line at a character boundary", async () => {
		const text = "界".repeat(DEFAULT_MAX_BYTES);
		const result = await truncateWithSpill(text, "tt", limitsForCalls(1));
		expect(result.truncated).toBe(true);
		// A cut inside a multi-byte character would show up as the replacement character.
		expect(result.text).not.toContain("\uFFFD");
		await rm(result.fullOutputPath ?? "", { force: true });
	});

	test("names spilled files in one shared directory with a short prefix", async () => {
		const text = "y".repeat(DEFAULT_MAX_BYTES * 2);
		const first = await truncateWithSpill(text, "tt", limitsForCalls(1));
		const second = await truncateWithSpill(text, "tt", limitsForCalls(1));
		const firstPath = first.fullOutputPath ?? "";
		const secondPath = second.fullOutputPath ?? "";
		expect(firstPath).toMatch(/\/pi-output\/tt-[0-9a-f]{6}\.txt$/);
		expect(secondPath).toMatch(/\/pi-output\/tt-[0-9a-f]{6}\.txt$/);
		expect(firstPath).not.toBe(secondPath);
		await rm(firstPath, { force: true });
		await rm(secondPath, { force: true });
	});
});

describe("tool result cap", () => {
	test("leaves a fitting result alone", async () => {
		expect(await capToolResult(textEvent("read", "small"))).toBeUndefined();
	});

	test("caps a result that no tool bounded, keeping head and tail", async () => {
		const text = `START\n${"z".repeat(DEFAULT_MAX_BYTES * 3)}\nEND`;
		const capped = await capToolResult(textEvent("read", text));
		const first = capped?.content[0];
		const cappedText = first?.type === "text" ? first.text : "";
		expect(cappedText).toContain("START");
		expect(cappedText).toContain("END");
		expect(cappedText).toContain(SPILL_NOTE_PREFIX);
		const path = /\[Full output: (\S+)\]/.exec(cappedText)?.[1] ?? "";
		expect(await readFile(path, "utf8")).toBe(text);
		await rm(path, { force: true });
	});

	test("does not cut a result its owner already truncated to a justified budget", async () => {
		const own = `head\n${SPILL_NOTE_PREFIX} /tmp/pi-output/py-1.txt]\ntail`;
		expect(await capToolResult(textEvent("python_eval", own))).toBeUndefined();
	});

	test("leaves image results alone because their text is a caption", async () => {
		const event = {
			type: "tool_result",
			toolCallId: "call",
			toolName: "read",
			input: {},
			content: [
				{ type: "text", text: "caption" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			isError: false,
		} as ToolResultEvent;
		expect(await capToolResult(event)).toBeUndefined();
	});

	test("gives each tool its own spill prefix and shares one for unknown tools", () => {
		expect(outputPrefixFor("python_eval")).toBe("py");
		expect(outputPrefixFor("apply_patch")).toBe("patch");
		expect(outputPrefixFor("mcp__hindsight__recall")).toBe("tool");
	});
});
