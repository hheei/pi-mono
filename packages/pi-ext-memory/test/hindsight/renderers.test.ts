import type { ExtensionAPI, Theme, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { registerHindsightRenderers } from "../../src/hindsight/renderers.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

function install(): ToolRendererResolver {
	let resolver: ToolRendererResolver | undefined;
	const pi = {
		registerToolRenderer(value: ToolRendererResolver) {
			resolver = value;
		},
	} as ExtensionAPI;
	registerHindsightRenderers(pi);
	if (resolver === undefined) throw new Error("Missing Hindsight renderer");
	return resolver;
}

function context(isError = false): never {
	return {
		toolCallId: "native-call",
		executionStarted: false,
		isPartial: false,
		isError,
		expanded: true,
		outputPad: 0,
		state: {},
		invalidate: () => {},
	} as never;
}

test("only overrides the reserved Hindsight namespace, including disconnected historical tools", () => {
	const resolve = install();
	const fallback = { renderResult: () => new Text("other tool", 0, 0) };
	const next = vi.fn(() => fallback);
	expect(resolve("mcp__other__read", next)).toBe(fallback);
	const native = resolve("mcp__hindsight__future_authoring_tool", () => undefined);
	expect(native?.renderShell).toBe("self");
	expect(
		native
			?.renderCall?.({ title: "Architecture", content: "persist this plan" }, theme, context())
			.render(80)
			.join("\n"),
	).toContain("persist this plan");
});

test("preserves readable query, optional arguments and output at narrow and wide widths", () => {
	const native = install()("mcp__hindsight__search_knowledge_base", () => undefined);
	const result = {
		content: [{ type: "text" as const, text: "记忆结果".repeat(30) }],
		details: undefined,
	};
	for (const width of [24, 100]) {
		const rows = [
			...(native
				?.renderCall?.({ query: "repo architecture", limit: 3 }, theme, context())
				.render(width) ?? []),
			...(native
				?.renderResult?.(result, { expanded: true, isPartial: false }, theme, context())
				.render(width) ?? []),
		];
		expect(rows.join("\n")).toContain("repo");
		expect(rows.join("\n")).toContain("architecture");
		expect(rows.join("\n")).toContain('"limit": 3');
		expect(rows.join("\n")).toContain("记忆结果");
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	}
});

test("renders structured errors without executing or changing the stored result", () => {
	const native = install()("mcp__hindsight__reflect", () => undefined);
	const result = {
		content: [],
		structuredContent: { content: [], structuredContent: { error: "bank unavailable" } },
		details: { server: "hindsight", tool: "reflect" },
	};
	const before = JSON.stringify(result);
	const rows =
		native
			?.renderResult?.(result, { expanded: true, isPartial: false }, theme, context(true))
			.render(80) ?? [];
	expect(rows.join("\n")).toContain("bank unavailable");
	expect(JSON.stringify(result)).toBe(before);
	expect(rows.join("\n")).not.toMatch(/\d+ms/);
});
