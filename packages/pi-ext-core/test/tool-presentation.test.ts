import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
	createToolPresentationRenderers,
	getRegisteredToolPresentationProvider,
	getToolPresentationProvider,
	textToolResult,
} from "../src/index.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
type Context = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
const context: Context = {
	args: {},
	state: {},
	toolCallId: "call",
	cwd: "/repo",
	invalidate() {},
	executionStarted: true,
	argsComplete: true,
	isPartial: false,
	expanded: false,
	showImages: false,
	isError: false,
	lastComponent: undefined,
	durationMs: undefined,
	outputPad: 0,
	keyText: () => "",
	keyHint: (_keybinding, description) => description,
};
function host(): ExtensionAPI {
	return { events: {} } as unknown as ExtensionAPI;
}

describe("tool-owned presentation", () => {
	test("native renderers preserve full request/result while fitting narrow terminal widths", () => {
		const pi = host();
		const provider = () => ({
			summary: "scout 你好",
			request: `inspect \u001b[2J${"代码".repeat(20)}`,
			output: "path: /sessions/child.jsonl",
		});
		const native = createToolPresentationRenderers(pi, "delegate", provider);
		expect(native.renderShell).toBeUndefined();
		expect(getToolPresentationProvider(native)).toBe(provider);
		expect(getRegisteredToolPresentationProvider(pi, "delegate")).toBe(provider);
		for (const width of [12, 80]) {
			const call = native.renderCall!({}, theme, context).render(width);
			const result = native.renderResult!(
				textToolResult("model result", undefined),
				{ expanded: false, isPartial: false },
				theme,
				context,
			).render(width);
			expect(call.join("")).toContain("inspect");
			expect(call.join("")).not.toContain("\u001b");
			expect(result.join("")).toContain("child.jsonl");
			expect([...call, ...result].every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	test("nested lookup is isolated by runtime and follows replacement renderer", () => {
		const first = host();
		const second = host();
		const oldProvider = () => ({ summary: "old" });
		const currentProvider = () => ({ summary: "current" });
		const retained = createToolPresentationRenderers(first, "same", oldProvider);
		const replacement = createToolPresentationRenderers(first, "same", currentProvider);
		expect(getToolPresentationProvider(retained)).toBe(oldProvider);
		expect(getToolPresentationProvider(replacement)).toBe(currentProvider);
		expect(getRegisteredToolPresentationProvider(first, "same")).toBe(currentProvider);
		expect(getRegisteredToolPresentationProvider(second, "same")).toBeUndefined();
		expect(getToolPresentationProvider({})).toBeUndefined();
	});

	test("native errors use original content instead of success presentation", () => {
		const native = createToolPresentationRenderers(host(), "delegate", () => ({
			summary: "scout",
			output: "success",
		}));
		const result = textToolResult("Permission denied\nbridge disconnected", undefined);
		const rendered = native.renderResult!(result, { expanded: false, isPartial: false }, theme, {
			...context,
			isError: true,
		}).render(80);
		expect(rendered.map((line) => line.trimEnd()).join("\n")).toBe(
			"Permission denied\nbridge disconnected",
		);
	});

	test("native renderers fallback cleanly displays diff text for diff presentation", () => {
		const pi = host();
		const diffText = "@@ -1,2 +1,2 @@\n-old\n+new";
		const native = createToolPresentationRenderers(pi, "edit", () => ({
			kind: "diff",
			path: "foo.txt",
			summary: "foo.txt (+1 -1)",
			diff: diffText,
			stats: { additions: 1, deletions: 1 },
		}));
		const res = native.renderResult!(
			textToolResult("ok", undefined),
			{ expanded: false, isPartial: false },
			theme,
			context,
		).render(80);
		expect(res.join("\n")).toContain("-old");
		expect(res.join("\n")).toContain("+new");
	});
});
