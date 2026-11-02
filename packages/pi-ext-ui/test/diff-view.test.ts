import type {
	ExtensionAPI,
	Theme,
	ToolRendererResolver,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
	type DiffSource,
	DiffView,
	diffStats,
	inlinePresentation,
	registerCollapsibleToolRenderer,
	type ToolRenderContext,
	type ToolView,
} from "../src/index.js";
import { ToolUiRuntime } from "../src/runtime.js";

/** The state this test's runtime owns; the extension builds the same one per Pi runtime. */
const runtime = new ToolUiRuntime();

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	style: (text: string) => text,
} as unknown as Theme;

const PATCH = [
	"diff --git a/src/index.ts b/src/index.ts",
	"index 111..222 100644",
	"--- a/src/index.ts",
	"+++ b/src/index.ts",
	"@@ -12,3 +12,4 @@",
	" const a = 1;",
	'-const oldVal = "foo";',
	'+const newVal = "bar";',
	"+const extra = true;",
].join("\n");

function view(source: DiffSource, theme: Theme = plainTheme): DiffView {
	return new DiffView({ theme, source });
}

function createMockContext(overrides?: Partial<ToolRenderContext>): ToolRenderContext {
	return {
		args: { path: "src/index.ts" },
		toolCallId: "call-1",
		invalidate: vi.fn(),
		lastComponent: undefined,
		state: {},
		cwd: "/work",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 0,
		keyText: () => "",
		keyHint: (_keybinding, description) => description,
		...overrides,
	};
}

function setupResolver(copyToClipboard?: (text: string) => Promise<void>): ToolRendererResolver {
	let captured: ToolRendererResolver | undefined;
	const pi = {
		on: () => () => {},
		registerToolRenderer(resolver: ToolRendererResolver) {
			captured = resolver;
		},
	} as unknown as ExtensionAPI;
	registerCollapsibleToolRenderer(pi, runtime, copyToClipboard ? { copyToClipboard } : undefined);
	if (captured === undefined) throw new Error("Expected registerToolRenderer to be called");
	return captured;
}

describe("DiffView", () => {
	test("Wide unified patch: one-space separator, right-aligned numbers, single column", () => {
		const diff = view({ kind: "unifiedPatch", text: PATCH });

		expect(diff.render(80)).toEqual([
			" 12 const a = 1;",
			'-13 const oldVal = "foo";',
			'+13 const newVal = "bar";',
			"+14 const extra = true;",
		]);
		expect(diffStats({ kind: "unifiedPatch", text: PATCH })).toEqual({ added: 2, removed: 1 });
	});

	test("Multiple hunks separate with a dim omission row and share one number column", () => {
		const text = [
			"--- a/f.ts",
			"+++ b/f.ts",
			"@@ -1,2 +1,2 @@",
			"-a",
			"+b",
			" c",
			"@@ -120,1 +120,1 @@",
			"-d",
			"+e",
		].join("\n");
		const rows = view({ kind: "unifiedPatch", text }).render(40);

		expect(rows).toEqual(["-  1 a", "+  1 b", "   2 c", "   …", "-120 d", "+120 e"]);
	});

	test("Structured hunks render without a patch parser and keep the same layout", () => {
		const diff = view({
			kind: "hunks",
			hunks: [
				{
					lines: [
						{ kind: "ctx", line: 1, text: "keep" },
						{ kind: "del", line: 2, text: "old" },
						{ kind: "add", line: 2, text: "new" },
					],
				},
			],
		});

		expect(diff.render(40)).toEqual(["  1 keep", "- 2 old", "+ 2 new"]);
		expect(diffStats({ kind: "hunks", hunks: [{ lines: [] }] })).toBeUndefined();
	});

	test("Narrow width with Chinese text: wide chars wrap instead of overflowing, continuations repeat nothing", () => {
		const long = "中文宽度测试".repeat(6);
		const diff = view({
			kind: "hunks",
			hunks: [{ lines: [{ kind: "add", line: 7, text: long }] }],
		});

		for (const width of [10, 14, 21, 80]) {
			const rows = diff.render(width);
			for (const row of rows) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
			expect(rows[0]?.startsWith("+ 7 ")).toBe(true);
			for (const row of rows.slice(1)) {
				expect(row.startsWith("    ")).toBe(true);
				expect(row).not.toContain("+");
			}
			expect(rows.join("")).not.toContain("│");
		}
		expect(diff.render(10).join("").replace(/[\s│]/g, "")).toBe(`+7${long}`);
	});

	test("Unparseable patch falls back to the raw text behind a short diagnostic", () => {
		const diff = view({ kind: "unifiedPatch", text: "this is not a patch" });

		expect(diff.render(80)).toEqual([
			"! unexpected line before the first hunk: this is not a patch",
			"this is not a patch",
		]);
		expect(diffStats({ kind: "unifiedPatch", text: "this is not a patch" })).toBeUndefined();

		const empty = view({ kind: "unifiedPatch", text: "   " });
		expect(empty.render(80)[0]).toBe("! empty patch");
	});
});

describe("nested call rows and inline summaries", () => {
	test("Nested codemode summary is one compact line: edit <path> (+N -M) plus status", () => {
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined) as ToolRenderers;
		const ctx = createMockContext({ args: { code: "text(1);" } });
		const result = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.2 seconds\nOutput:\nok" }],
				details: {
					__piExtUiResolvedCalls: ["1", "2", "3"],
					calls: [
						{
							id: "1",
							name: "edit",
							args: '{"path":"src/index.ts"}',
							status: "ok",
							durationMs: 12,
						},
						{
							id: "2",
							name: "edit",
							args: '{"path":"src/other.ts"}',
							status: "error",
							error: "no match",
						},
						{ id: "3", name: "grep", args: '{"pattern":"x"}', status: "ok" },
					],
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		const rows = result.render(80);
		expect(rows[0]).toContain("▸ codemode 2 ok · 1 failed · 200ms");
		expect(rows[1]).toContain("▎ ✓ edit src/index.ts · 12ms");
		expect(rows[1]).toContain("󰆏");
		expect(rows[2]).toContain("▎ ✗ edit src/other.ts");
		expect(rows[3]).toContain("▎ ✓ grep x");
	});

	test.each([
		{ offset: undefined, limit: undefined, suffix: "" },
		{ offset: null, limit: null, suffix: "" },
		{ offset: undefined, limit: 3, suffix: ":1-3" },
		{ offset: "5", limit: "10", suffix: ":5-14" },
		{ offset: 5, limit: undefined, suffix: ":5" },
		{ offset: "", limit: 3, suffix: "" },
		{ offset: 2, limit: "invalid", suffix: "" },
		{ offset: Number.POSITIVE_INFINITY, limit: 3, suffix: "" },
		{ offset: false, limit: 3, suffix: "" },
	])("read summary preserves ranges on every supported host: $offset / $limit", ({
		offset,
		limit,
		suffix,
	}) => {
		expect(
			inlinePresentation("read", { path: "file.ts", offset, limit }, undefined, false)?.summary,
		).toBe(`file.ts${suffix}`);
	});

	test("inlinePresentation formats diverse tools into their folded single-line format", () => {
		// A summary never repeats the tool name: the row's title already carries it, and printing both
		// produced rows like "edit edit src/index.ts".
		// Truncated edit JSON string (200 chars preview from QuickJS)
		const truncatedEditArgs =
			'{"path":"packages/pi-subagents/test/tool-activation.test.ts","edits":[{"oldText":"export const A = 1;","newText":"export const A = 2;';
		expect(inlinePresentation("edit", truncatedEditArgs, undefined, false)?.summary).toBe(
			"packages/pi-subagents/test/tool-activation.test.ts",
		);

		// Shell command
		expect(inlinePresentation("bash", '{"command":"pnpm test"}', undefined, false)?.summary).toBe(
			"pnpm test",
		);
		expect(
			inlinePresentation("bg_bash_spawn", '{"command":"pnpm run build"}', undefined, false)
				?.summary,
		).toBe("pnpm run build");

		// Search tools
		expect(
			inlinePresentation("grep", '{"pattern":"tool_search","path":"src"}', undefined, false)
				?.summary,
		).toBe("tool_search src");
		expect(inlinePresentation("find", '{"pattern":"*.ts"}', undefined, false)?.summary).toBe(
			"*.ts",
		);

		// Read tool with range
		expect(
			inlinePresentation("read", '{"path":"file.ts","offset":5,"limit":10}', undefined, false)
				?.summary,
		).toBe("file.ts:5-14");

		// Task tools
		expect(
			inlinePresentation("agents_delegate", '{"agent":"reviewer"}', undefined, false)?.summary,
		).toBe("reviewer");
		expect(inlinePresentation("bg_bash_get", '{"id":"bash-1"}', undefined, false)?.summary).toBe(
			"bash-1",
		);

		// Unknown tool without key arg returns undefined for default rendering fallback
		expect(
			inlinePresentation("custom_tool", '{"unknownField":123}', undefined, false),
		).toBeUndefined();
	});
});
