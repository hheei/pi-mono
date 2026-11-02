import type {
	ExtensionAPI,
	Theme,
	ToolRendererResolver,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { createToolPresentationRenderers } from "@hheei/pi-ext-core";
import { describe, expect, test, vi } from "vitest";
import { backgroundFill } from "../src/background.js";
import extension from "../src/extension.js";
import {
	type Collapsible,
	isCollapsible,
	registerCollapsibleToolRenderer,
	SPECIALIZED_TOOL_RENDERERS,
	type ToolRenderContext,
	ToolView,
	transitionFoldLevel,
} from "../src/index.js";
import { ToolUiRuntime } from "../src/runtime.js";

/** The state this test's runtime owns; the extension builds the same one per Pi runtime. */
const runtime = new ToolUiRuntime();

import {
	NESTED_CALLS_COPIED_KEY,
	NESTED_CALLS_EXPANDED_KEY,
	NestedCallsView,
} from "../src/nested-calls-view.js";
import {
	formatStatusGlyph,
	TOOL_SPINNER_FRAMES,
	TOOL_SPINNER_INTERVAL_MS,
} from "../src/tool-view.js";

/**
 * The host emits its `tool_call` hook (the resolution fact) before it runs a nested call, so a test
 * that models a real execution records both; a test that wants an unresolved call records only the
 * start, the way the host does for a name it cannot dispatch.
 */
function recordNestedStart(event: {
	toolCallId: string;
	toolName: string;
	args: unknown;
	parentToolCallId: string;
}): void {
	runtime.tracker.recordStart(event);
	runtime.tracker.recordResolved({
		toolCallId: event.toolCallId,
		parentToolCallId: event.parentToolCallId,
	});
}

/** Rows carry the frame's background to the full width; assertions read their content. */
function rowsOf(lines: readonly string[]): string[] {
	return lines
		.filter((line) => !line.includes("[borderMuted:") && !/^─+$/.test(line))
		.map((line) => line.trimEnd());
}

const taggedTheme = {
	fg: (color: string, text: string) => `[${color}:${text}]`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	style: (text: string) => text,
} as unknown as Theme;

const ansiTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => `\u001b[48;2;1;2;3m${text}\u001b[49m`,
	bold: (text: string) => text,
	italic: (text: string) => text,
	style: (text: string) => text,
} as unknown as Theme;

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	style: (text: string) => text,
} as unknown as Theme;

function createMockContext(overrides?: Partial<ToolRenderContext>): ToolRenderContext {
	return {
		args: { query: "pi tui collapsible" },
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

function createMouseClick(
	x: number,
	y: number,
	options?: { width?: number; height?: number; ctrl?: boolean; shift?: boolean },
): TuiMouseEvent {
	const width = options?.width ?? 80;
	const height = options?.height ?? 5;
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: options?.shift ?? false,
		alt: false,
		ctrl: options?.ctrl ?? false,
	};
}

describe("ToolView Deep Module Interface", () => {
	test.each([
		0, 1, 2,
	] as const)("global expansion overrides level %i without replacing it", (level) => {
		const spec = {
			theme: plainTheme,
			header: { title: "read", status: "ok" as const },
			sections: [
				{ railToken: "dim" as const, content: Array.from({ length: 20 }, (_, i) => `line-${i}`) },
			],
			stateHolder: {},
			defaultLevel: level,
		};
		const forced = new ToolView({ ...spec, globalExpanded: true });
		expect(forced.effectiveLevel).toBe(2);
		expect(forced.foldLevel).toBe(level);
		expect(forced.render(80).join("\n")).toContain("line-19");
		expect(new ToolView({ ...spec, globalExpanded: false }).effectiveLevel).toBe(level);
		forced.toggle();
		expect(forced.foldLevel).toBe(0);
		expect(forced.effectiveLevel).toBe(2);
		expect(new ToolView({ ...spec, globalExpanded: false }).effectiveLevel).toBe(0);
	});

	test("transitionFoldLevel satisfies the 6-path Click & Ctrl+Click matrix", () => {
		expect(transitionFoldLevel(0, false)).toBe(1);
		expect(transitionFoldLevel(0, true)).toBe(2);
		expect(transitionFoldLevel(1, false)).toBe(0);
		expect(transitionFoldLevel(1, true)).toBe(2);
		expect(transitionFoldLevel(2, false)).toBe(0);
		expect(transitionFoldLevel(2, true)).toBe(0);
	});

	test("Level 1 defaults to a 9-line section cap", () => {
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "codemode", status: "none", summary: "1 call" },
			sections: [
				{ railToken: "dim", content: Array.from({ length: 40 }, (_, i) => `out ${String(i)}`) },
			],
			stateHolder: {},
		});
		view.setFoldLevel(1);

		const level1 = view.render(80);
		expect(level1).toHaveLength(11);
		expect(level1[9]).toContain("out 8");
		expect(level1[10]).toContain("… (31 more lines)");
	});

	test("Level 0 renders all collapsed board rows without artificial truncation cap", () => {
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "codemode", status: "none", summary: "30 calls" },
			collapsedRows: Array.from({ length: 30 }, (_, i) => `✓ read a${String(i)}.ts`),
			stateHolder: {},
		});

		const level0 = view.render(80);
		expect(level0).toHaveLength(31);
		expect(level0[1]).toContain("✓ read a0.ts");
		expect(level0[30]).toContain("✓ read a29.ts");
	});

	test("Level 0 / Level 1 / Level 2 state machine via mouse clicks and section capping", () => {
		const state = {};
		const invalidate = vi.fn();
		const twentyLines = Array.from({ length: 20 }, (_, i) => `line-${String(i + 1)}`);

		const view = new ToolView({
			theme: plainTheme,
			header: { title: "web_search", status: "ok", summary: "query" },
			sections: [{ railToken: "dim", content: twentyLines, maxLines: 3 }],
			stateHolder: state,
			invalidate,
		});

		expect(view.foldLevel).toBe(0);
		const level0Lines = view.render(80);
		expect(rowsOf(level0Lines)).toEqual(["▸ ✓ web_search query"]);

		view.handleMouse(createMouseClick(2, 0));
		expect(view.foldLevel).toBe(1);
		expect(invalidate).toHaveBeenCalledTimes(1);
		const level1Lines = view.render(80);
		expect(rowsOf(level1Lines)).toEqual([
			"▾ ✓ web_search query",
			"▎ line-1",
			"▎ line-2",
			"▎ line-3",
			"▎ … (17 more lines)",
		]);

		view.handleMouse(createMouseClick(2, 0, { ctrl: true }));
		expect(view.foldLevel).toBe(2);
		const level2Lines = view.render(80);
		expect(level2Lines.length).toBe(21);
		expect(rowsOf(level2Lines)[0]).toBe("▾ ✓ web_search query");
		expect(rowsOf(level2Lines)[20]).toBe("▎ line-20");

		view.handleMouse(createMouseClick(2, 0));
		expect(view.foldLevel).toBe(0);

		view.handleMouse(createMouseClick(2, 0, { ctrl: true }));
		expect(view.foldLevel).toBe(2);

		view.handleMouse(createMouseClick(2, 0, { ctrl: true }));
		expect(view.foldLevel).toBe(0);
	});

	test("Seamless two-compartment heavy-input layout: no dashed line, no padding, segmented rail colors", () => {
		const view = new ToolView({
			theme: taggedTheme,
			defaultLevel: 1,
			header: { title: "bash", status: "ok", summary: "exit 0 · 1.2s" },
			sections: [
				{ railToken: "muted", content: ["$ pnpm build && pnpm test"] },
				{ railToken: "dim", content: ["> building...", "✓ Built in 820ms"] },
			],
		});

		const rendered = view.render(80);
		expect(rendered.length).toBe(4);
		expect(rendered[1]).toContain("[muted:▎] $ pnpm build && pnpm test");
		expect(rendered[2]).toContain("[dim:▎] > building...");
		expect(rendered[3]).toContain("[dim:▎] ✓ Built in 820ms");
	});

	test("Meta-tool layout: Level 0 shows collapsedRows without top ✓, Level 1 shows input & output sections", () => {
		const state = {};
		const view = new ToolView({
			theme: plainTheme,
			stateHolder: state,
			header: { title: "codemode", status: "none", summary: "4 calls · 2.1s" },
			collapsedRows: ["✓ grep · 14 matches (80ms)", "✗ write · Permission denied (15ms)"],
			sections: [
				{ railToken: "muted", content: ["$ await Promise.all([...])"] },
				{ railToken: "dim", content: ["Summary: 1 passed, 1 failed"] },
			],
		});

		const collapsedRender = view.render(80);
		expect(rowsOf(collapsedRender)).toEqual([
			"▸ codemode 4 calls · 2.1s",
			"▎ ✓ grep · 14 matches (80ms)",
			"▎ ✗ write · Permission denied (15ms)",
		]);

		view.toggle(false);
		const expandedRender = view.render(80);
		expect(rowsOf(expandedRender)).toEqual([
			"▾ codemode 4 calls · 2.1s",
			"▎ $ await Promise.all([...])",
			"▎ Summary: 1 passed, 1 failed",
		]);
	});

	test("Right-edge copy icon: Click copies primary, Shift+Click copies full, feedback expires via the timer", async () => {
		vi.useFakeTimers();
		try {
			const copiedTexts: string[] = [];
			const invalidate = vi.fn();

			const view = new ToolView({
				theme: plainTheme,
				stateHolder: {},
				invalidate,
				copyToClipboard: async (text: string) => {
					copiedTexts.push(text);
				},
				copyFeedbackDurationMs: 5000,
				header: { title: "bash", status: "ok", summary: "exit 0" },
				copy: {
					primary: "pnpm test",
					full: "pnpm test\n---\nPASS",
				},
			});

			expect(view.render(40)[0]!.endsWith("󰆏 ")).toBe(true);

			const wheelResult = view.handleMouse({
				type: "wheel",
				button: "none",
				x: 10,
				y: 0,
				screenX: 10,
				screenY: 0,
				width: 40,
				height: 1,
				shift: false,
				alt: false,
				ctrl: false,
				wheelDelta: 3,
			});
			expect(wheelResult).toBeUndefined();

			const copyClick = view.handleMouse(createMouseClick(38, 0, { width: 40, height: 1 }));
			expect(copyClick).toMatchObject({ handled: true, render: true });
			expect(view.foldLevel).toBe(0);
			expect(copiedTexts).toEqual(["pnpm test"]);
			// The check mark appears only once the clipboard write resolves.
			await Promise.resolve();
			expect(view.render(40)[0]!.endsWith("✓ ")).toBe(true);

			vi.advanceTimersByTime(5000);
			expect(view.render(40)[0]!.endsWith("󰆏 ")).toBe(true);
			expect(invalidate).toHaveBeenCalled();

			view.handleMouse(createMouseClick(38, 0, { width: 40, height: 1, shift: true }));
			expect(copiedTexts).toEqual(["pnpm test", "pnpm test\n---\nPASS"]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a rejected clipboard write shows failure instead of the success mark", async () => {
		vi.useFakeTimers();
		try {
			const view = new ToolView({
				theme: plainTheme,
				stateHolder: {},
				copyToClipboard: async () => {
					throw new Error("Clipboard unavailable");
				},
				copyFeedbackDurationMs: 5000,
				header: { title: "bash", status: "ok", summary: "exit 0" },
				copy: { primary: "pnpm test" },
			});
			view.render(40);
			view.handleMouse(createMouseClick(38, 0, { width: 40, height: 1 }));
			await Promise.resolve();

			// The copy slot is the last cell; the row's own status glyph is a check mark of its own.
			expect(view.render(40)[0]!.endsWith("✗ ")).toBe(true);

			vi.advanceTimersByTime(5000);
			expect(view.render(40)[0]!.endsWith("󰆏 ")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("registerCollapsibleToolRenderer & formatTurnFlow", () => {
	function setupResolver(
		options?: Parameters<typeof registerCollapsibleToolRenderer>[2],
	): ToolRendererResolver {
		let captured: ToolRendererResolver | undefined;
		const pi = {
			registerFlag() {},
			registerToolRenderer(resolver: ToolRendererResolver) {
				captured = resolver;
			},
			on: () => () => {},
		} as unknown as ExtensionAPI;

		// The extension installs its own runtime; the test registers again so its captures reach this one.
		if (options === undefined) extension(pi);
		registerCollapsibleToolRenderer(pi, runtime, options);
		if (captured === undefined) {
			throw new Error("Expected registerToolRenderer to be called");
		}
		return captured;
	}

	test("a native tool surface fills every row and drops the leading rail", () => {
		const view = new ToolView({
			theme: ansiTheme,
			header: { title: "bash", status: "error", summary: "boom" },
			collapsedRows: ["line"],
			background: () => true,
		});
		const rows = view.render(40);
		// One padding row above and below, and no ▎ gutter anywhere.
		expect(rows).toHaveLength(4);
		for (const row of rows) expect(row.startsWith("\u001b[48;2;")).toBe(true);
		for (const row of rows) expect(row).not.toContain("▎");
		for (const row of rows) expect(visibleWidth(row)).toBe(40);
		// The padding row carries the fill and nothing else.
		expect(rows[0]?.replace(/\u001b\[[0-9;]*m/g, "").trim()).toBe("");
	});

	test("a nested reset cannot punch a hole in the fill", () => {
		const fill = backgroundFill(ansiTheme, "toolSuccessBg");
		const filled = fill("a\u001b[0mb");
		expect(filled.match(/\u001b\[48;2;1;2;3m/g)).toHaveLength(2);
	});

	test("an inner surface that ended is not resurrected by the outer fill", () => {
		const fill = backgroundFill(ansiTheme, "toolSuccessBg");
		const outer = "\u001b[48;2;1;2;3m";
		const inner = "\u001b[48;2;9;9;9m";
		const filled = fill(`${inner}tool\u001b[0mtail`);
		// After the inner surface's reset the row belongs to the surface painting it, not to the inner one.
		expect(filled).toContain(`\u001b[0m${outer}tail`);
		expect(filled).not.toContain(`\u001b[0m${inner}`);
	});

	test("a compound reset re-asserts the fill, a style-only sequence does not", () => {
		const fill = backgroundFill(ansiTheme, "toolSuccessBg");
		const outer = "\u001b[48;2;1;2;3m";
		expect(fill("a\u001b[0;31mb")).toContain(`\u001b[0;31m${outer}b`);
		expect(fill("a\u001b[49mb")).toContain(`\u001b[49m${outer}b`);
		expect(fill("a\u001b[1mb")).toContain("a\u001b[1mb");
		expect(fill("a\u001b[mb")).toContain(`\u001b[m${outer}b`);
	});

	test("a cached frame never freezes a live glyph: the same view repaints on the next tick", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "bash", status: "running" },
			stateHolder: {},
		});
		const first = view.render(40)[0] ?? "";
		now.mockReturnValue(TOOL_SPINNER_INTERVAL_MS * 4);
		const second = view.render(40)[0] ?? "";
		expect(first).not.toBe(second);
		now.mockReturnValue(TOOL_SPINNER_INTERVAL_MS * TOOL_SPINNER_FRAMES.length);
		expect(view.render(40)[0]).toBe(first);
		now.mockRestore();
	});

	test("a container board follows the same clock for a live child and keeps a settled board cached", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		const live = new NestedCallsView({
			calls: [{ id: "c1", toolName: "bash", args: { command: "ls" }, status: "running" }] as never,
			theme: plainTheme,
			context: { args: {}, toolCallId: "p1", invalidate: () => undefined } as never,
		});
		const firstRow = live.render(40)[0] ?? "";
		now.mockReturnValue(TOOL_SPINNER_INTERVAL_MS * 3);
		expect(live.render(40)[0]).not.toBe(firstRow);

		const settled = new NestedCallsView({
			calls: [{ id: "c2", toolName: "read", args: { path: "a.ts" }, status: "ok" }] as never,
			theme: plainTheme,
			context: { args: {}, toolCallId: "p1", invalidate: () => undefined } as never,
		});
		const settledRows = settled.render(40);
		now.mockReturnValue(TOOL_SPINNER_INTERVAL_MS * 4);
		// Nothing in a settled board animates, so a repaint still hits its cache.
		expect(settled.render(40)).toBe(settledRows);
		now.mockRestore();
	});

	test("a container keeps repainting its child board after its own row returns to the fold pin", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		const board = new NestedCallsView({
			calls: [{ id: "c1", toolName: "bash", args: { command: "ls" }, status: "running" }] as never,
			theme: plainTheme,
			context: { args: {}, toolCallId: "p1", invalidate: () => undefined } as never,
		});
		// The container already lists a child, so its own slot is the settled pin.
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "codemode", status: "none" },
			collapsedRows: board,
			stateHolder: {},
		});
		const first = view.render(40).join("\n");
		expect(first).toContain("▸ codemode");
		now.mockReturnValue(TOOL_SPINNER_INTERVAL_MS * 3);
		expect(view.render(40).join("\n")).not.toBe(first);
		now.mockRestore();
	});

	test("a live row asks for the next frame and a settled row stops asking", () => {
		vi.useFakeTimers();
		let live = true;
		const invalidate = vi.fn(() => {
			// The host repaint renders the row again, which asks for the frame after this one.
			if (live) view.render(40);
		});
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "bash", status: "running" },
			stateHolder: {},
			invalidate,
		});
		view.render(40);
		expect(invalidate).not.toHaveBeenCalled();
		vi.advanceTimersByTime(TOOL_SPINNER_INTERVAL_MS * 3);
		expect(invalidate).toHaveBeenCalledTimes(3);
		live = false;
		vi.advanceTimersByTime(TOOL_SPINNER_INTERVAL_MS * 5);
		expect(invalidate).toHaveBeenCalledTimes(4);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("a settled tool never asks for a frame", () => {
		vi.useFakeTimers();
		const invalidate = vi.fn();
		new ToolView({
			theme: plainTheme,
			header: { title: "bash", status: "ok" },
			stateHolder: {},
			invalidate,
		}).render(40);
		vi.advanceTimersByTime(TOOL_SPINNER_INTERVAL_MS * 5);
		expect(invalidate).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	test("a live child board asks for the next frame even when its own row is settled", () => {
		vi.useFakeTimers();
		const invalidate = vi.fn();
		new NestedCallsView({
			calls: [{ id: "c1", toolName: "bash", args: { command: "ls" }, status: "running" }] as never,
			theme: plainTheme,
			context: { args: {}, toolCallId: "p1" } as never,
			invalidate,
		}).render(40);
		vi.advanceTimersByTime(TOOL_SPINNER_INTERVAL_MS);
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	test("live tools animate one shared 200ms phase and only change color", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		const tagged = {
			fg: (token: string, text: string) => `[${token}]${text}[/]`,
			bg: (_token: string, text: string) => text,
			bold: (text: string) => text,
			italic: (text: string) => text,
		} as Theme;
		// Streaming args and a running execution draw the same frame: the clock never restarts.
		expect(formatStatusGlyph("streaming", tagged)).toBe("[muted]·[/]");
		expect(formatStatusGlyph("running", tagged)).toBe("[accent]·[/]");
		now.mockReturnValue(TOOL_SPINNER_INTERVAL_MS * 4);
		expect(formatStatusGlyph("running", tagged)).toBe("[accent]✻[/]");
		now.mockRestore();
	});

	test("Streaming planning phase puts the live spinner in the prefix of tool_name · XX tokens", () => {
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const ctx = createMockContext({
			args: { code: "1234567890123456" },
			isPartial: true,
			argsComplete: false,
			executionStarted: false,
		});

		const callView = renderers.renderCall!(ctx.args, plainTheme, ctx);
		const lines = callView.render(80);
		expect(lines.length).toBe(1);
		expect(lines[0]).toMatch(/^[·✢✳✶✻✽] codemode · /);
		expect(lines[0]).toContain("tokens");
	});

	test("codemode renderCall shows raw input code", () => {
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const ctx = createMockContext({
			args: { code: "const a = 1;\nconst b = 2;" },
			executionStarted: false,
			isPartial: false,
			argsComplete: true,
		});
		const callView = renderers.renderCall!(ctx.args, plainTheme, ctx) as ToolView;
		callView.handleMouse(createMouseClick(2, 0, { width: 80 }));
		const rendered = callView.render(80);
		expect(rendered.join("\n")).toContain("const a = 1;");
	});

	test("leaves ordinary tools to Pi when catchAll is false", () => {
		const resolve = setupResolver({ catchAll: false });
		const upstream: ToolRenderers = { renderCall: () => new Text("native", 0, 0) };
		expect(resolve("grep", () => upstream)).toBe(upstream);
		const optedIn = setupResolver({ catchAll: false, tools: ["grep"] })("grep", () => undefined);
		expect(optedIn?.renderShell).toBe("self");
	});

	test("intercepts all unowned tools by default with generic ToolView fallback", () => {
		const resolve = setupResolver();
		const otherUpstream: ToolRenderers = {
			renderCall: () => new Text("other call", 0, 0),
		};
		expect(resolve("bash", () => otherUpstream)?.renderShell).toBe("self");

		for (const toolName of SPECIALIZED_TOOL_RENDERERS) {
			const renderers = resolve(toolName, () => undefined);
			expect(renderers?.renderShell).toBe("self");
		}
		expect(resolve("read", () => undefined)?.renderShell).toBe("self");
		expect(resolve("custom_random_tool", () => undefined)?.renderShell).toBe("self");
	});

	test("codemode adapter: Level 0 shows nested calls without top ✓, Level 1 shows script & cleaned output", () => {
		const copied: string[] = [];
		const resolve = setupResolver({
			copyToClipboard: async (t) => {
				copied.push(t);
			},
		});
		const renderers = resolve("codemode", () => undefined)!;
		const state = {};
		const ctx = createMockContext({
			state,
			args: {
				code: '// @options: {"timeout_ms": 30000}\nconst res = await tools.read({ path: "a.ts" });\ntext(res);',
			},
		});

		const resultView = renderers.renderResult!(
			{
				content: [
					{
						type: "text",
						text: "Script completed\nWall time 0.2 seconds\nOutput:\nfile content line 1\nfile content line 2",
					},
				],
				details: {
					__piExtUiResolvedCalls: ["1"],
					calls: [{ id: "1", name: "read", args: 'path: "a.ts"', status: "ok", durationMs: 18 }],
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		const level0 = resultView.render(80);
		expect(level0[0]).toContain("▸ codemode (timeout 30s) · 1 call · 200ms");
		expect(level0[0]).not.toContain("✓");
		expect(level0[1]).toContain('▎ ✓ read path: "a.ts" · 18ms');
		expect(level0[1]).toContain("󰆏");

		// A persisted record keeps only a summary, so there is no request to copy and none is written.
		resultView.handleMouse(createMouseClick(78, 1, { width: 80 }));
		expect(copied).toEqual([]);
		const refusedRender = resultView.render(80);
		expect(refusedRender[1]).not.toContain("󰆏");
		expect(refusedRender[1]).toContain("✗");

		// Clicking row 1 body toggles child tool expansion (select mechanism)
		resultView.handleMouse(createMouseClick(10, 1, { width: 80 }));
		const childExpanded = resultView.render(80);
		expect(childExpanded[1]).toContain('▎ ✓ read path: "a.ts" · 18ms');

		// Expanding codemode view itself
		resultView.handleMouse(createMouseClick(2, 0, { width: 80 }));
		const level1 = resultView.render(80);
		expect(level1[0]).toContain("▾ codemode (timeout 30s) · 1 call · 200ms");
		expect(level1.join("\n")).toContain("// @options:");
		expect(level1.join("\n")).toContain("file content line 1");
		expect(level1.join("\n")).not.toContain("Script completed");
	});

	test("a container tool keeps its call row visible until a result exists", () => {
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const running = createMockContext({
			state: {},
			args: { code: "const a = 1;" },
			isPartial: true,
			argsComplete: true,
			executionStarted: true,
		});
		// Execution started and no result yet: the call row is the only thing on screen, so
		// hiding it here would leave the whole tool block blank.
		const lines = renderers.renderCall!(running.args, plainTheme, running).render(80);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("codemode");
	});

	test("codemode keeps one header: the fold pin returns once child calls exist", () => {
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const state = {};
		const running = createMockContext({
			state,
			args: { code: "await tools.agents_get({ id: 'agent-1' });" },
			isPartial: true,
			argsComplete: true,
			executionStarted: true,
		});
		// Host order: the call renderer runs first and stores its view, then the result renderer
		// hides it in place, so one updateDisplay pass shows one header.
		const runningCall = renderers.renderCall!(running.args, plainTheme, running);
		const partial = renderers.renderResult!(
			{
				content: [{ type: "text", text: "" }],
				details: {
					__piExtUiResolvedCalls: ["1"],
					calls: [{ id: "1", name: "agents_get", args: '{"id":"agent-1"}', status: "running" }],
				},
			},
			{ expanded: false, isPartial: true },
			plainTheme,
			running,
		);
		const runningLines = [...runningCall.render(80), ...partial.render(80)];
		expect(runningLines.filter((line) => line.includes("codemode"))).toEqual([
			expect.stringContaining("codemode 1 call"),
		]);
		expect(runningLines.join("\n")).not.toMatch(/[·✢✳✶✻✽] codemode/);
		expect(runningLines.join("\n")).toMatch(/[·✢✳✶✻✽] agents_get/);

		const failedCall = renderers.renderCall!(running.args, plainTheme, running);
		const failed = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script failed\nWall time 0.0 seconds\nOutput:\nboom" }],
				details: { calls: [] },
				isError: true,
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			createMockContext({ state, isError: true }),
		);
		const failedLines = [...failedCall.render(80), ...failed.render(80)];
		expect(failedLines.filter((line) => line.includes("✗ codemode"))).toEqual([
			expect.stringContaining("✗ codemode 0ms"),
		]);

		const toolFailed = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script failed\nWall time 0.0 seconds\nOutput:\nboom" }],
				details: {
					calls: [
						{ id: "1", name: "edit", args: '{"path":"a.ts"}', status: "error", error: "boom" },
					],
				},
				isError: true,
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			createMockContext({ state: {}, isError: true }),
		);
		const toolFailedLines = toolFailed.render(80);
		expect(toolFailedLines[0]).not.toContain("✗ codemode");
		expect(toolFailedLines.join("\n")).toContain("✗ edit");

		const reloaded = {};
		const reloadedContext = createMockContext({
			state: reloaded,
			args: { code: "await tools.edit({ path: 'a.ts' });" },
			executionStarted: false,
			isPartial: false,
			argsComplete: true,
		});
		const reloadedCall = renderers.renderCall!(reloadedContext.args, plainTheme, reloadedContext);
		const reloadedResult = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.0 seconds\nOutput:\ndone" }],
				details: {
					__piExtUiResolvedCalls: ["1"],
					calls: [{ id: "1", name: "edit", args: 'path: "a.ts"', status: "ok", durationMs: 2 }],
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			reloadedContext,
		);
		const reloadedLines = [...reloadedCall.render(80), ...reloadedResult.render(80)];
		expect(reloadedLines.filter((line) => line.includes("codemode"))).toEqual([
			expect.stringContaining("codemode 1 call"),
		]);
		expect(reloadedLines.join("\n")).toContain("✓ edit");
	});

	test("nested file-tool rows keep their tool name when codemode records JSON args", () => {
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const resultView = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\nok" }],
				details: {
					calls: [
						{
							id: "1",
							name: "read",
							args: '{"path":"/repo/x/renderer.ts"}',
							status: "ok",
							durationMs: 1,
						},
						{
							id: "2",
							name: "write",
							args: '{"path":"b.ts","content":"x"}',
							status: "ok",
							durationMs: 2,
						},
					],
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			createMockContext({ state: {} }),
		) as ToolView;

		// The path keeps the native link, so its OSC 8 wrapper is not part of the text comparison.
		const lines = resultView
			.render(80)
			.map((line) =>
				line.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\]8;;[^\u001b]*\u001b\\/g, ""),
			);
		expect(lines.join("\n")).toContain("▎ ✓ read /repo/x/renderer.ts · 1ms");
		expect(lines.join("\n")).toContain("▎ ✓ write b.ts · 2ms");
	});

	test("a nested read row keeps the accent path and warning range of its own row", () => {
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const resultView = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\nok" }],
				details: {
					calls: [
						{
							id: "1",
							name: "read",
							args: '{"path":"/repo/src/a.ts","offset":3,"limit":2}',
							status: "ok",
							durationMs: 1,
						},
					],
				},
			},
			{ expanded: false, isPartial: false },
			taggedTheme,
			createMockContext({ state: {} }),
		) as ToolView;
		const board = resultView.render(120)[1] ?? "";
		expect(board).toContain("[accent:/repo/src/a.ts]");
		expect(board).toContain("[warning::3-4]");
	});

	test("expands tab characters to two spaces in rendered view while preserving copy text", async () => {
		const copied: string[] = [];
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "codemode" },
			sections: [
				{
					railToken: "muted",
					content: ["\tconst x = 1;", "function foo() {\n\t\treturn true;\n}"],
				},
			],
			copy: {
				primary: "\tconst x = 1;",
				full: "\tconst x = 1;\n\t\treturn true;",
			},
			copyToClipboard: async (text) => {
				copied.push(text);
			},
			defaultLevel: 1,
		});
		const rendered = view.render(80);
		expect(rendered.join("\n")).toContain("  const x = 1;");
		expect(rendered.join("\n")).toContain("    return true;");
		expect(rendered.join("\n")).not.toContain("\t");

		// Click copy icon (width 80 -> copy icon at x = 77)
		view.handleMouse(createMouseClick(77, 0, { width: 80 }));
		expect(copied).toEqual(["\tconst x = 1;"]);

		// Shift+Click copy icon for full text
		view.handleMouse(createMouseClick(77, 0, { width: 80, shift: true }));
		expect(copied).toEqual(["\tconst x = 1;", "\tconst x = 1;\n\t\treturn true;"]);
	});

	test("applies outputPad horizontal padding to rendered lines and mouse clicks", () => {
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "bash", summary: "echo ok" },
			outputPad: 2,
			defaultLevel: 0,
		});
		const rendered = view.render(80);
		expect(rendered[0]).toMatch(/^ {2}▸ ✓ bash echo ok/);

		// Clicking inside padding (x < 2) should not toggle
		expect(view.handleMouse(createMouseClick(1, 0, { width: 80 }))).toBeUndefined();
		expect(view.foldLevel).toBe(0);

		// Clicking past padding (x >= 2) should toggle
		expect(view.handleMouse(createMouseClick(5, 0, { width: 80 }))).toEqual({
			handled: true,
			render: true,
		});
		expect(view.foldLevel).toBe(1);
	});

	test("a started child call reports running until its result lands", () => {
		runtime.clear();
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const parentCallId = "call-live-parent";
		const parent = () =>
			createMockContext({
				toolCallId: parentCallId,
				args: { code: 'await tools.bash({ command: "sleep 5" });' },
				isPartial: true,
			});

		recordNestedStart({
			toolCallId: "child-live",
			toolName: "bash",
			args: { command: "sleep 5" },
			parentToolCallId: parentCallId,
		});
		const running = renderers.renderResult!(
			{ content: [{ type: "text", text: "" }], details: {} },
			{ expanded: false, isPartial: true },
			plainTheme,
			parent(),
		) as ToolView;
		expect(running.children?.map((child) => child.status)).toEqual(["running"]);

		runtime.tracker.recordEnd({
			toolCallId: "child-live",
			toolName: "bash",
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
			durationMs: 5,
			parentToolCallId: parentCallId,
		});
		const done = renderers.renderResult!(
			{ content: [{ type: "text", text: "" }], details: {} },
			{ expanded: false, isPartial: true },
			plainTheme,
			parent(),
		) as ToolView;
		expect(done.children?.map((child) => child.status)).toEqual(["ok"]);
	});

	test("a cancelled nested call keeps its warning in the child list", () => {
		runtime.clear();
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const view = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
				details: {
					__piExtUiResolvedCalls: ["1"],
					calls: [{ id: "1", name: "bash", args: '{"command":"sleep 9"}', status: "cancelled" }],
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			createMockContext({ args: { code: "await tools.bash({ command: 'sleep 9' });" } }),
		) as ToolView;
		expect(view.children?.map((child) => child.status)).toEqual(["warn"]);
		expect(view.render(80).join("\n")).toContain("sleep 9");
	});

	test("bash copy keeps the request bytes while the body strips escapes and keeps the tail", () => {
		const copied: string[] = [];
		const resolve = setupResolver({
			copyToClipboard: async (text) => {
				copied.push(text);
			},
		});
		// Quotes, a glob, a pipe, Unicode, a >120-column line, a tail marker, and a control sequence.
		const command =
			"  rg --glob '**/*.ts' 'a|b' src | head -3\n" +
			`  echo ${"x".repeat(130)} ZZ_TAIL_07 中文 \u001b[31mred\u001b[0m  \n`;
		const renderers = resolve("bash", () => undefined)!;
		const ctx = createMockContext({ args: { command } });
		const view = renderers.renderResult!(
			{ content: [{ type: "text", text: "done" }], details: undefined },
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		// The collapsed header states the first line only; the request body carries the rest.
		expect(view.render(80).join("\n")).not.toContain("ZZ_TAIL_07");
		view.handleMouse(createMouseClick(2, 0, { width: 80 }));
		const body = view.render(80).join("\n");
		expect(body).toContain("$ rg --glob '**/*.ts' 'a|b' src | head -3");
		expect(body).toContain("ZZ_TAIL_07 中文 red");
		expect(body.indexOf("$ rg --glob")).toBeLessThan(body.indexOf("ZZ_TAIL_07"));
		expect(body).not.toContain("\u001b");
		for (const row of body.split("\n")) expect(visibleWidth(row)).toBeLessThanOrEqual(80);

		view.handleMouse(createMouseClick(78, 0, { width: 80 }));
		expect(copied.at(-1)).toBe(command);
		view.handleMouse(createMouseClick(78, 0, { width: 80, shift: true }));
		expect(copied.at(-1)).toBe(`${command}\n---\ndone`);
	});

	test("a clipped body names the real copy path and a cut line says it continues", () => {
		const resolve = setupResolver();
		const renderers = resolve("bash", () => undefined)!;
		const render = (command: string): string => {
			const view = renderers.renderResult!(
				{ content: [{ type: "text", text: "done" }], details: undefined },
				{ expanded: false, isPartial: false },
				plainTheme,
				createMockContext({ args: { command } }),
			) as ToolView;
			view.setFoldLevel(1);
			return view.render(80).join("\n");
		};

		const manyLines = Array.from({ length: 30 }, (_, i) => `  echo ${String(i)}`).join("\n");
		expect(render(manyLines)).toContain("more lines, shift+click copies all");

		// One long line is cut inside its own wrap: no logical line is hidden, the rest of it is.
		const oneLine = `  echo ${"y".repeat(1200)}`;
		const single = render(oneLine);
		expect(single).toContain("current line continues, shift+click copies all");
		expect(single).not.toMatch(/more lines/);
	});

	test("nested bash copy keeps the captured request exact and strips only its result", () => {
		runtime.clear();
		const copied: string[] = [];
		const resolve = setupResolver({
			copyToClipboard: async (text) => {
				copied.push(text);
			},
		});
		const renderers = resolve("codemode", () => undefined)!;
		const parentCallId = "call-live-request";
		// Longer than the 70-character row summary, so the tail marker exists only in the body.
		const command = `  echo nested\n  echo ${"a".repeat(70)} ZZ_TAIL_07 \u001b[31mred\u001b[0m \n`;
		recordNestedStart({
			toolCallId: "child-1",
			toolName: "bash",
			args: { command },
			parentToolCallId: parentCallId,
		});
		runtime.tracker.recordEnd({
			toolCallId: "child-1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "out \u001b[32mgreen\u001b[0m" }],
				details: {},
			},
			isError: false,
			durationMs: 5,
			parentToolCallId: parentCallId,
		});
		const ctx = createMockContext({
			toolCallId: parentCallId,
			args: { code: "await tools.bash({ command: 'x' });" },
		});
		const view = renderers.renderResult!(
			{ content: [{ type: "text", text: "" }], details: {} },
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		expect(view.render(80)[1]).not.toContain("ZZ_TAIL_07");
		view.handleMouse(createMouseClick(10, 1, { width: 80 }));
		const body = view.render(80).join("\n");
		expect(body).toContain("$ echo nested");
		expect(body).toContain("ZZ_TAIL_07 red");
		// The request's own escape is stripped; the tool's colored output keeps its ANSI.
		expect(body).not.toContain("[31m");
		expect(body).toContain("\u001b[32mgreen\u001b[0m");

		view.handleMouse(createMouseClick(78, 1, { width: 80 }));
		expect(copied.at(-1)).toBe(command);
		view.handleMouse(createMouseClick(78, 1, { width: 80, shift: true }));
		expect(copied.at(-1)).toBe(`${command}\n---\nout green`);
	});

	test("a persisted call without arguments refuses to copy its summary and says why", () => {
		const copied: string[] = [];
		const resolve = setupResolver({
			copyToClipboard: async (text) => {
				copied.push(text);
			},
		});
		const renderers = resolve("codemode", () => undefined)!;
		const ctx = createMockContext({
			toolCallId: "call-resumed",
			args: { code: "await tools.bash({ command: 'ls' });" },
		});
		const view = renderers.renderResult!(
			{
				content: [{ type: "text", text: "done" }],
				details: { calls: [{ name: "bash", args: '{"command":"ls"}', status: "ok" }] },
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		// The row has to be drawn before its right-edge copy slot has a hit region.
		expect(view.render(80)[1]).toContain("󰆏");
		view.handleMouse(createMouseClick(78, 1, { width: 80 }));
		expect(copied).toEqual([]);
		const refused = view.render(80);
		expect(refused[1]).not.toContain("󰆏");
		expect(refused[1]).toContain("✗");
		view.handleMouse(createMouseClick(10, 1, { width: 80 }));
		expect(view.render(80).join("\n")).toContain("(request not recorded; summary only)");
	});

	test("codemode nested calls: individual tool copy and click-to-expand without extra rail", () => {
		runtime.clear();
		const copied: string[] = [];
		const resolve = setupResolver({
			copyToClipboard: async (text) => {
				copied.push(text);
			},
		});
		const renderers = resolve("codemode", () => undefined)!;
		const parentCallId = "call-code-parent";

		// Simulate live execution events captured for two child tools
		recordNestedStart({
			toolCallId: "child-1",
			toolName: "bash",
			args: { command: "echo hello" },
			parentToolCallId: parentCallId,
		});
		runtime.tracker.recordEnd({
			toolCallId: "child-1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "hello output\nline 2" }],
				details: {},
			},
			isError: false,
			durationMs: 45,
			parentToolCallId: parentCallId,
		});

		recordNestedStart({
			toolCallId: "child-2",
			toolName: "write",
			args: { path: "src/new.ts", content: "export const x = 42;" },
			parentToolCallId: parentCallId,
		});
		runtime.tracker.recordEnd({
			toolCallId: "child-2",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "wrote 20 bytes" }],
				details: {},
			},
			isError: false,
			durationMs: 12,
			parentToolCallId: parentCallId,
		});

		const ctx = createMockContext({
			toolCallId: parentCallId,
			args: { code: 'await tools.bash({ command: "echo hello" });' },
		});

		const resultView = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\ndone" }],
				details: {},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		const rows = resultView.render(80);
		// Header has NO copy button
		expect(rows[0]).not.toContain("󰆏");
		expect(rows[0]).toContain("▸ codemode 2 calls");

		// Child rows have individual copy icons and no arrow prefix
		expect(rows[1]).toContain("▎ ✓ bash echo hello · 45ms");
		expect(rows[1]).toContain("󰆏");
		expect(rows[2]).toContain("▎ ✓ write src/new.ts · 12ms");
		expect(rows[2]).toContain("󰆏");

		// Click child 1 copy button (row 1, x=78)
		resultView.handleMouse(createMouseClick(78, 1, { width: 80 }));
		expect(copied.at(-1)).toBe("echo hello");

		// Shift-click child 1 copy button: command plus output
		resultView.handleMouse(createMouseClick(78, 1, { width: 80, shift: true }));
		expect(copied.at(-1)).toBe("echo hello\n---\nhello output\nline 2");

		// Click child 2 copy button (row 2, x=78)
		resultView.handleMouse(createMouseClick(78, 2, { width: 80 }));
		expect(copied.at(-1)).toBe("export const x = 42;");

		// Click child 1 row body (row 1, x=10) to expand it
		resultView.handleMouse(createMouseClick(10, 1, { width: 80 }));
		const expandedRows = resultView.render(80);

		// Child 1 header has no arrow prefix
		expect(expandedRows[1]).toContain("▎ ✓ bash echo hello · 45ms");
		// Child 1 uses ext-ui upper room ($ echo hello) and lower room (output lines)
		expect(expandedRows[2]).toContain("▎   $ echo hello");
		expect(expandedRows[3]).toContain("▎   hello output");
		expect(expandedRows[4]).toContain("▎   line 2");
		// Confirm NO duplicate rail glyphs
		expect(expandedRows[2]).not.toMatch(/▎.*▎/);
		expect(expandedRows[3]).not.toMatch(/▎.*▎/);
	});
	test("success tools and codemode use success rail color when expanded and collapsed", () => {
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const parentCallId = "call-code-success-test";

		// Child tool failed, but script itself caught it or completed without error (isError: false)
		recordNestedStart({
			toolCallId: "child-err",
			toolName: "read",
			args: { path: "nonexistent.ts" },
			parentToolCallId: parentCallId,
		});
		runtime.tracker.recordEnd({
			toolCallId: "child-err",
			toolName: "read",
			result: { content: [{ type: "text", text: "file not found" }], details: {} },
			isError: true,
			durationMs: 10,
			parentToolCallId: parentCallId,
		});

		const ctx = createMockContext({
			toolCallId: parentCallId,
			args: { code: 'await tools.read({ path: "nonexistent.ts" }).catch(() => null);' },
			isError: false,
		});

		// 1. Successful codemode (isError: false)
		const successView = renderers.renderResult!(
			{
				content: [
					{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\nhandled" },
				],
				details: {},
				isError: false,
			},
			{ expanded: false, isPartial: false },
			taggedTheme,
			ctx,
		) as ToolView;

		// Level 0: collapsed state rail keeps theme default (dim), not success
		const level0 = successView.render(80);
		expect(level0[1]).toContain("[dim:▎]");

		// Level 1: expand codemode -> upper room (code) is muted, lower room (output) is success
		successView.setFoldLevel(1);
		const level1 = successView.render(80);
		expect(level1[1]).toContain("[muted:▎]");
		expect(level1.some((line) => line.includes("[success:▎]"))).toBe(true);

		// 2. Failed codemode (script itself crashed, isError: true)
		const failedCtx = createMockContext({
			toolCallId: "call-code-fail-test",
			args: { code: 'throw new Error("boom");' },
			isError: true,
		});
		const failedView = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script failed\nOutput:\nboom" }],
				details: {},
				isError: true,
			},
			{ expanded: false, isPartial: false },
			taggedTheme,
			failedCtx,
		) as ToolView;

		failedView.setFoldLevel(1);
		const failedLevel1 = failedView.render(80);
		expect(failedLevel1[1]).toContain("[muted:▎]");
		expect(failedLevel1.some((line) => line.includes("[error:▎]"))).toBe(true);
	});

	test("expanding codemode folds any previously expanded child tools first", () => {
		runtime.clear();
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const parentCallId = "call-code-fold-test";

		recordNestedStart({
			toolCallId: "child-step1",
			toolName: "bash",
			args: { command: "echo step1" },
			parentToolCallId: parentCallId,
		});
		runtime.tracker.recordEnd({
			toolCallId: "child-step1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "line A\nline B" }],
				details: {},
			},
			isError: false,
			durationMs: 25,
			parentToolCallId: parentCallId,
		});

		const ctx = createMockContext({
			toolCallId: parentCallId,
			args: { code: 'await tools.bash({ command: "echo step1" });' },
		});

		const resultView = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.1s\nOutput:\nok" }],
				details: {},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		// Level 0: initial render
		const initial = resultView.render(80);
		expect(initial[1]).toContain("▎ ✓ bash echo step1");

		// 1. Expand child tool first at Level 0
		resultView.handleMouse(createMouseClick(10, 1, { width: 80 }));
		const childExpanded = resultView.render(80);
		expect(childExpanded[1]).toContain("▎ ✓ bash echo step1");
		expect(childExpanded[2]).toContain("▎   $ echo step1");
		expect(childExpanded[3]).toContain("▎   line A");

		// 2. Now expand codemode itself (clicking codemode header at y=0)
		resultView.handleMouse(createMouseClick(2, 0, { width: 80 }));
		const codemodeExpanded = resultView.render(80);

		// In expanded codemode: codemode header is ▾
		expect(codemodeExpanded[0]).toContain("▾ codemode");
		// Child nested tool calls are hidden when parent is expanded
		expect(codemodeExpanded.join("\n")).not.toContain("bash echo step1");
		expect(codemodeExpanded.join("\n")).not.toContain("line A");

		// 3. Fold codemode back to Level 0
		resultView.handleMouse(createMouseClick(2, 0, { width: 80 }));
		const foldedBack = resultView.render(80);
		expect(foldedBack[0]).toContain("▸ codemode");
		expect(foldedBack[1]).toContain("▎ ✓ bash echo step1");
		expect(foldedBack.join("\n")).not.toContain("line A");
	});
	test("heavy inputs in codemode and bash apply syntax highlighting in Level 1", () => {
		const resolve = setupResolver({ tools: ["codemode", "bash"] });
		const codemodeRenderers = resolve("codemode", () => undefined)!;
		const bashRenderers = resolve("bash", () => undefined)!;

		// 1. codemode: script code highlighted as javascript
		const cmCtx = createMockContext({
			args: { code: "const val = 123;\nreturn val > 0;" },
		});
		const cmView = codemodeRenderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.1s\nOutput:\ntrue" }],
				details: { calls: [] },
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			cmCtx,
		) as ToolView;

		cmView.setFoldLevel(1);
		const cmRendered = cmView.render(80);
		expect(cmRendered.join("\n")).toContain("const val = 123;");
		expect(cmRendered.join("\n")).toContain("return val > 0;");

		// 2. bash: shell command highlighted with $ prefix
		const bashCtx = createMockContext({
			args: { command: 'echo "hello world"' },
		});
		const bashView = bashRenderers.renderResult!(
			{
				content: [{ type: "text", text: "hello world" }],
				details: {},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			bashCtx,
		) as ToolView;

		bashView.setFoldLevel(1);
		const bashRendered = bashView.render(80);
		expect(bashRendered.join("\n")).toContain('$ echo "hello world"');

		// 3. bash with taggedTheme: header and input command are unstyled (no themes), while output is dim
		const taggedBashView = bashRenderers.renderResult!(
			{
				content: [{ type: "text", text: "hello world" }],
				details: {},
			},
			{ expanded: false, isPartial: false },
			taggedTheme,
			bashCtx,
		) as ToolView;
		taggedBashView.setFoldLevel(1);
		const taggedRendered = taggedBashView.render(80);
		// Upper room command has plain $ prefix without accent theme
		expect(taggedRendered.join("\n")).toContain('$ echo "hello world"');
		expect(taggedRendered.join("\n")).not.toContain("[accent:$]");
		// Header summary is unstyled for bash
		expect(taggedRendered[0]).not.toContain('[dim:echo "hello world"]');
		// Lower room output is dim
		expect(taggedRendered.join("\n")).toContain("[dim:hello world]");
	});

	test("ToolView.invalidate on codemode result with nested calls does not trigger recursive host invalidate loop", () => {
		const resolve = setupResolver({ tools: ["codemode"] });
		const codemodeRenderers = resolve("codemode", () => undefined)!;

		let viewInstance: ToolView | undefined;
		let hostInvalidateCallCount = 0;

		const ctx = createMockContext({
			args: { code: 'await tools.read({ path: "a.ts" });' },
			invalidate: () => {
				hostInvalidateCallCount++;
				// Simulates Pi host ToolExecutionComponent: calling context.invalidate()
				// causes the host component to invalidate its children downward.
				viewInstance?.invalidate();
			},
		});

		const resultView = codemodeRenderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed" }],
				details: {
					__piExtUiResolvedCalls: ["1"],
					calls: [{ id: "1", name: "read", args: '{"path":"a.ts"}', status: "ok" }],
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;
		viewInstance = resultView;

		// Downward invalidation from host must not trigger upward context.invalidate() recursion
		expect(() => {
			resultView.invalidate();
		}).not.toThrow();
		expect(hostInvalidateCallCount).toBe(0);
	});

	test("stateHolder persists expanded nested tools across re-render cycles", () => {
		runtime.clear();
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const parentCallId = "call-persist-test";

		recordNestedStart({
			toolCallId: "child-persist-1",
			toolName: "read",
			args: { path: "src/file.ts" },
			parentToolCallId: parentCallId,
		});
		runtime.tracker.recordEnd({
			toolCallId: "child-persist-1",
			toolName: "read",
			result: {
				content: [{ type: "text", text: "line 100\nline 200" }],
				details: {},
			},
			isError: false,
			durationMs: 15,
			parentToolCallId: parentCallId,
		});

		const sharedState: Record<string, unknown> = {};
		const ctx1 = createMockContext({
			toolCallId: parentCallId,
			args: { code: 'await tools.read({ path: "src/file.ts" });' },
			state: sharedState,
		});

		// Turn 1: initial render
		const view1 = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.1s\nOutput:\nok" }],
				details: {},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx1,
		) as ToolView;

		const lines1 = view1.render(80);
		expect(lines1.join("\n")).not.toContain("line 100");

		// Click child 1 body at row 1 to expand
		view1.handleMouse(createMouseClick(10, 1, { width: 80 }));
		const lines1Expanded = view1.render(80);
		expect(lines1Expanded.join("\n")).toContain("line 100");

		// Turn 2: Pi re-renders transcript (new component instance with same stateHolder)
		const ctx2 = createMockContext({
			toolCallId: parentCallId,
			args: { code: 'await tools.read({ path: "src/file.ts" });' },
			state: sharedState,
		});
		const view2 = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.1s\nOutput:\nok" }],
				details: {},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx2,
		) as ToolView;

		// Expanded state survived across component re-creation!
		const lines2 = view2.render(80);
		expect(lines2.join("\n")).toContain("line 100");
	});

	test("ctrl+click on child tool fully expands it to Level 2", () => {
		runtime.clear();
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const parentCallId = "call-ctrl-test";

		const manyLines = Array.from({ length: 40 }, (_, i) => `output line ${String(i + 1)}`).join(
			"\n",
		);
		recordNestedStart({
			toolCallId: "child-ctrl-1",
			toolName: "bash",
			args: { command: "generate-lines" },
			parentToolCallId: parentCallId,
		});
		runtime.tracker.recordEnd({
			toolCallId: "child-ctrl-1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: manyLines }],
				details: {},
			},
			isError: false,
			durationMs: 30,
			parentToolCallId: parentCallId,
		});

		const ctx = createMockContext({
			toolCallId: parentCallId,
			args: { code: 'await tools.bash({ command: "generate-lines" });' },
		});

		const view = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed" }],
				details: {},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		// Initial render populates layout line map
		view.render(80);

		// 1. Normal click expands to Level 1
		view.handleMouse(createMouseClick(10, 1, { width: 80 }));
		const level1Lines = view.render(80);
		expect(level1Lines.join("\n")).toContain("output line 1");
		// In level 1, sections or output are capped with omission hint
		expect(level1Lines.join("\n")).toMatch(/(omitted|more lines)/);

		// 2. Ctrl+click expands to Level 2 (unlimited lines)
		view.handleMouse(createMouseClick(10, 1, { width: 80, ctrl: true }));
		const level2Lines = view.render(80);
		expect(level2Lines.join("\n")).toContain("output line 1");
		expect(level2Lines.join("\n")).toContain("output line 40");
		expect(level2Lines.join("\n")).not.toMatch(/(omitted|more lines)/);
	});

	test("ToolView.renderBody renders body lines headless without header and supports noRail option", () => {
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "bash", status: "ok", summary: "echo test" },
			sections: [
				{
					railToken: "success",
					content: ["hello line 1", "hello line 2"],
				},
			],
			defaultLevel: 1,
		});

		// 1. Full render includes the header row and the section's own rail
		const full = view.render(80);
		expect(full[0]).toContain("▾ ✓ bash");
		expect(full[1]).toContain("▎ hello line 1");

		// 2. renderBody without options renders the body, but NO header row
		const bodyWithRail = view.renderBody(80);
		expect(bodyWithRail).toHaveLength(2);
		expect(bodyWithRail[0]).not.toContain("bash");
		expect(bodyWithRail[0]).toContain("▎ hello line 1");
		expect(bodyWithRail[1]).toContain("▎ hello line 2");

		// 3. renderBody with noRail: true omits rail glyphs cleanly
		const headlessNoRail = view.renderBody(80, { noRail: true });
		expect(headlessNoRail).toHaveLength(2);
		expect(headlessNoRail[0]).toBe("hello line 1");
		expect(headlessNoRail[1]).toBe("hello line 2");
		expect(headlessNoRail[0]).not.toContain("▎");
	});

	test("ToolView supports controlledLevel and safe stateHolder: undefined memory mode", () => {
		const state: Record<string, unknown> = { __piExtUiFoldLevel: 0 };
		const controlledView = new ToolView({
			theme: plainTheme,
			header: { title: "read", status: "ok" },
			sections: [{ railToken: "dim", content: ["data line"] }],
			controlledLevel: 2,
			stateHolder: state,
		});

		// 1. controlledLevel takes precedence over stateHolder
		expect(controlledView.foldLevel).toBe(2);
		expect(controlledView.effectiveLevel).toBe(2);

		// 2. setFoldLevel in controlled mode does NOT overwrite stateHolder
		controlledView.setFoldLevel(1);
		expect(state.__piExtUiFoldLevel).toBe(0);

		// 3. stateHolder: undefined operates purely in-memory without error
		const memoryView = new ToolView({
			theme: plainTheme,
			header: { title: "read", status: "ok" },
			sections: [{ railToken: "dim", content: ["memory line"] }],
			defaultLevel: 0,
			stateHolder: undefined,
		});
		expect(memoryView.foldLevel).toBe(0);
		memoryView.setFoldLevel(1);
		expect(memoryView.foldLevel).toBe(1);
	});

	test("isCollapsible type-guard and collapsibleChildren explicit composite hierarchy", () => {
		expect(isCollapsible(null)).toBe(false);
		expect(isCollapsible(undefined)).toBe(false);
		expect(isCollapsible("string")).toBe(false);
		expect(isCollapsible({})).toBe(false);
		expect(isCollapsible({ collapseAll: 123 })).toBe(false);

		const dummyCollapsible: Collapsible = { collapseAll: vi.fn() };
		expect(isCollapsible(dummyCollapsible)).toBe(true);

		const child1: Collapsible = { collapseAll: vi.fn() };
		const child2: Collapsible = { collapseAll: vi.fn() };

		const parent = new ToolView({
			theme: plainTheme,
			header: { title: "parent", status: "ok" },
			collapsedRows: child1 as unknown as Component,
			collapsibleChildren: [child2],
			defaultLevel: 0,
		});

		// Expanding parent from 0 to 1 collapses both registered children
		parent.setFoldLevel(1);
		expect(child1.collapseAll).toHaveBeenCalledTimes(1);
		expect(child2.collapseAll).toHaveBeenCalledTimes(1);
	});

	test("NestedCallsView fold transitions follow shared state machine (2 -> 0 on normal click) and dispose cleans up timer", () => {
		const state: Record<string, unknown> = {};
		const ncv = new NestedCallsView({
			calls: [
				{
					id: "call-1",
					toolName: "bash",
					args: { command: "ls -la" },
					result: { content: [{ type: "text", text: "file.txt" }], details: {} },
				},
			],
			theme: plainTheme,
			context: createMockContext(),
			stateHolder: state,
		});

		// Render to generate lineMapping
		ncv.render(80);

		// 1. Click row 0 -> transitions from Level 0 to Level 1
		const res1 = ncv.handleMouse(createMouseClick(10, 0, { width: 80 }));
		expect(res1?.handled).toBe(true);
		expect((state[NESTED_CALLS_EXPANDED_KEY] as Record<string, number>)["0"]).toBe(1);

		// 2. Click row 0 again -> transitions from Level 1 to Level 0
		ncv.render(80);
		const res2 = ncv.handleMouse(createMouseClick(10, 0, { width: 80 }));
		expect(res2?.handled).toBe(true);
		expect((state[NESTED_CALLS_EXPANDED_KEY] as Record<string, number>)["0"]).toBeUndefined();

		// 3. Ctrl-click row 0 -> transitions from Level 0 to Level 2
		ncv.render(80);
		const res3 = ncv.handleMouse(createMouseClick(10, 0, { width: 80, ctrl: true }));
		expect(res3?.handled).toBe(true);
		expect((state[NESTED_CALLS_EXPANDED_KEY] as Record<string, number>)["0"]).toBe(2);

		// 4. Normal click row 0 while at Level 2 -> MUST transition to Level 0 (not 1)
		ncv.render(80);
		const res4 = ncv.handleMouse(createMouseClick(10, 0, { width: 80, ctrl: false }));
		expect(res4?.handled).toBe(true);
		expect((state[NESTED_CALLS_EXPANDED_KEY] as Record<string, number>)["0"]).toBeUndefined();

		// 5. Calling dispose is safe and cleans up resources
		expect(() => ncv.dispose()).not.toThrow();
	});

	test("collapsing a nested view drops the copy marker instead of leaving it behind", async () => {
		vi.useFakeTimers();
		try {
			const state: Record<string, unknown> = {};
			const ncv = new NestedCallsView({
				calls: [
					{
						id: "call-1",
						toolName: "bash",
						args: { command: "ls -la" },
						result: { content: [{ type: "text", text: "file.txt" }], details: {} },
					},
				],
				theme: plainTheme,
				context: createMockContext(),
				stateHolder: state,
				copyToClipboard: async () => {},
			});
			ncv.render(80);
			ncv.handleMouse(createMouseClick(78, 0, { width: 80 }));
			await Promise.resolve();
			expect(ncv.render(80)[0]!.endsWith("✓ ")).toBe(true);

			ncv.collapseAll();
			expect(state[NESTED_CALLS_COPIED_KEY]).toBeUndefined();
			ncv.render(80);
			ncv.handleMouse(createMouseClick(10, 0, { width: 80 }));
			// Expanding again must not resurrect a check mark whose timer is already gone.
			expect(ncv.render(80)[0]!.endsWith("󰆏 ")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	test("each nested child renderer sees its own call id, not the parent's", () => {
		const providerIds: string[] = [];
		const childIds: string[] = [];
		const ncv = new NestedCallsView({
			calls: [
				{
					id: "child-a",
					toolName: "bash",
					args: { command: "echo a" },
					result: { content: [{ type: "text", text: "A" }], details: {} },
				},
				{
					id: "child-b",
					toolName: "bash",
					args: { command: "echo b" },
					result: { content: [{ type: "text", text: "B" }], details: {} },
				},
			],
			theme: plainTheme,
			context: createMockContext({ toolCallId: "parent-call" }),
			stateHolder: { [NESTED_CALLS_EXPANDED_KEY]: { 0: 1, 1: 1 } },
			resolvePresentation: () => (_args, _result, _theme, ctx) => {
				providerIds.push(ctx.toolCallId);
				return { summary: "child", copy: { primary: "text" } };
			},
			resolveChildRenderer: () => ({
				renderCall: () => new Text("", 0, 0),
				renderResult: (_result, _options, _theme, ctx) => {
					childIds.push(ctx.toolCallId);
					return new Text("body", 0, 0);
				},
			}),
		});
		ncv.render(80);

		expect(new Set(providerIds)).toEqual(new Set(["child-a", "child-b"]));
		expect(childIds).toEqual(["child-a", "child-b"]);
	});

	test("NestedCallsView retains ANSI escape colors and syntax highlights file reads", () => {
		const state: Record<string, unknown> = {};
		const ncv = new NestedCallsView({
			calls: [
				{
					id: "call-ansi",
					toolName: "bash",
					args: { command: "npm test" },
					result: {
						content: [{ type: "text", text: "\x1b[32mPASS\x1b[0m test/suite.js" }],
						details: {},
					},
				},
				{
					id: "call-read",
					toolName: "read",
					args: { path: "server.ts" },
					result: {
						content: [{ type: "text", text: "const port = 3000;" }],
						details: {},
					},
				},
			],
			theme: plainTheme,
			context: createMockContext(),
			stateHolder: state,
		});

		// Expand row 0 (bash)
		ncv.render(80);
		ncv.handleMouse(createMouseClick(10, 0, { width: 80 }));
		const linesWithAnsi = ncv.render(80);
		// Output line should preserve the ANSI color escape sequence
		expect(linesWithAnsi.some((l) => l.includes("\x1b[32mPASS\x1b[0m"))).toBe(true);

		// Expand row 1 (read server.ts)
		ncv.handleMouse(createMouseClick(10, 2, { width: 80 }));
		const linesWithRead = ncv.render(80);
		// Output lines should contain the code line
		expect(linesWithRead.some((l) => l.includes("const port = 3000;"))).toBe(true);
	});

	test("NestedCallsView absorbs clicks on body and unmapped lines without bubbling undefined", () => {
		const state: Record<string, unknown> = {};
		const ncv = new NestedCallsView({
			calls: [
				{
					id: "call-1",
					toolName: "bash",
					args: { command: "seq 1 5" },
					result: {
						content: [{ type: "text", text: "1\n2\n3\n4\n5" }],
						details: {},
					},
				},
				{
					id: "call-2",
					toolName: "bash",
					args: { command: "echo hello" },
					result: {
						content: [{ type: "text", text: "hello" }],
						details: {},
					},
				},
			],
			theme: plainTheme,
			context: createMockContext(),
			stateHolder: state,
		});

		// 1. Initial collapsed render has 2 lines: header for call-1, header for call-2
		const initLines = ncv.render(80);
		expect(initLines).toHaveLength(2);

		// 2. Expand call-1 by clicking row 0
		ncv.handleMouse(createMouseClick(10, 0, { width: 80 }));
		const expLines = ncv.render(80);
		expect(expLines.length).toBeGreaterThan(2);

		// 3. Click on a body line (e.g. row 2 which is part of call-1 body)
		// MUST return handled: true so it never bubbles to outer container MouseRegion
		const bodyClickRes = ncv.handleMouse(createMouseClick(10, 2, { width: 80 }));
		expect(bodyClickRes).toEqual({ handled: true });

		// 4. Click on an out-of-bounds / unmapped row
		const outClickRes = ncv.handleMouse(createMouseClick(10, 99, { width: 80 }));
		expect(outClickRes).toEqual({ handled: true });

		// 5. Collapse call-1 by clicking row 0 again
		const collapseRes = ncv.handleMouse(createMouseClick(10, 0, { width: 80 }));
		expect(collapseRes?.handled).toBe(true);

		// 6. After collapsing call-1, call-2 remains cleanly visible at row 1
		const collapsedLines = ncv.render(80);
		expect(collapsedLines).toHaveLength(2);
		expect(collapsedLines[0]).toContain("seq 1 5");
		expect(collapsedLines[1]).toContain("echo hello");
	});

	test("ToolView absorbs clicks within its rendered boundaries without bubbling to outer MouseRegion", () => {
		const invalidate = vi.fn();
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "codemode", summary: "2 calls" },
			sections: [{ railToken: "dim", content: ["output line 1", "output line 2"] }],
			invalidate,
		});

		view.setFoldLevel(1);
		const lines = view.render(80);
		expect(lines).toHaveLength(3);

		// Click on body line (row 1)
		const bodyClick = view.handleMouse(createMouseClick(10, 2, { width: 80 }));
		expect(bodyClick).toEqual({ handled: true });

		// Click outside vertical bounds (row 10)
		const outsideClick = view.handleMouse(createMouseClick(10, 10, { width: 80 }));
		expect(outsideClick).toBeUndefined();
	});

	test("NestedCallsView and ToolView sanitize multiline commands into strict single-line elements", () => {
		const multilineCommand =
			"ssh dcu-cluster '\n  export PATH=/opt/bin:$PATH\n  cmake --build build\n'";
		const ncv = new NestedCallsView({
			calls: [
				{
					id: "call-multi",
					toolName: "bash",
					args: { command: multilineCommand },
					result: {
						content: [{ type: "text", text: "done" }],
						details: {},
					},
				},
				{
					id: "call-next",
					toolName: "bash",
					args: { command: "ls -l" },
					result: {
						content: [{ type: "text", text: "bin" }],
						details: {},
					},
				},
			],
			theme: plainTheme,
			context: createMockContext(),
		});

		const rendered = ncv.render(80);
		expect(rendered).toHaveLength(2);
		for (const line of rendered) {
			expect(line).not.toContain("\n");
			expect(line).not.toContain("\r");
		}

		const tv = new ToolView({
			theme: plainTheme,
			header: { title: "codemode", summary: "multiline\nheader\r\ntest" },
			collapsedRows: ncv,
		});

		const tvLines = tv.render(80);
		expect(tvLines).toHaveLength(3);
		for (const line of tvLines) {
			expect(line).not.toContain("\n");
			expect(line).not.toContain("\r");
		}
	});

	test("A board row stays one row: breaks collapse, they do not split the element", () => {
		// Pi writes one array element as one terminal row, so a break inside a label would silently
		// push the frame past the rows it reports. It is one row, one label.
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "bash", status: "ok", summary: "progress 10%\rprogress 90%" },
			collapsedRows: ["a\rb", "c\r\nd", "e\nf"],
			defaultLevel: 0,
		});

		const rows = view.render(80);
		expect(rows).toHaveLength(4);
		expect(rows[0]).toContain("progress 10% progress 90%");
		expect(rows[1]).toContain("a b");
		expect(rows[2]).toContain("c d");
		expect(rows[3]).toContain("e f");
		for (const row of rows) {
			expect(row).not.toMatch(/[\r\n]/);
		}
	});

	test("Section content splits into rows and a lone CR is dropped, not treated as a break", () => {
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "bash", status: "ok", summary: "exit 0" },
			sections: [{ railToken: "dim", content: ["progress 10%\rprogress 90%", "next"] }],
			defaultLevel: 1,
		});

		const rows = view.render(80);
		expect(rows).toHaveLength(3);
		// A lone CR returns to column 0; dropping it keeps the row instead of overwriting its start.
		expect(rows[1]).toContain("progress 10%progress 90%");
		expect(rows[2]).toContain("next");
		for (const row of rows) {
			expect(row).not.toMatch(/[\r\n]/);
		}
	});

	test("Component rows keep their own indentation while losing their breaks", () => {
		// A component already laid its rows out; only the breaks are removed, so the indent inside a
		// collapsed board survives and the section does not re-trim it.
		const inner = new NestedCallsView({
			calls: [
				{
					id: "call-indent",
					toolName: "bash",
					args: { command: "echo step1" },
					result: { content: [{ type: "text", text: "  $ echo step1\n  line A" }], details: {} },
				},
			],
			theme: plainTheme,
			context: createMockContext(),
			stateHolder: {},
		});
		inner.render(80);
		inner.handleMouse(createMouseClick(10, 0, { width: 80 }));

		const view = new ToolView({
			theme: plainTheme,
			header: { title: "codemode", status: "none", summary: "1 call" },
			collapsedRows: inner,
			defaultLevel: 0,
		});

		// Row 1 is the nested row's own header; its body keeps the two-space indent the component
		// rendered, on top of the shared rail.
		const rows = view.render(80);
		expect(rows).toHaveLength(4);
		expect(rows[2]).toContain("▎   $ echo step1");
		expect(rows[3]).toContain("line A");
		expect(rows[3]).toContain("▎     line A");
	});

	test("A hidden view rejects clicks instead of toggling from stale geometry", () => {
		const invalidate = vi.fn();
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "codemode", status: "none", summary: "1 call" },
			sections: [{ railToken: "dim", content: ["output line 1"] }],
			defaultLevel: 1,
			invalidate,
		});

		view.render(80);
		view.hide();
		expect(view.render(80)).toHaveLength(0);

		// The call view stays mounted under its result view, so a click now belongs to the result
		// renderer, and the hidden view must not consume it or flip its own fold state.
		expect(view.handleMouse(createMouseClick(5, 0, { width: 80 }))).toBeUndefined();
		expect(view.foldLevel).toBe(1);
		expect(invalidate).not.toHaveBeenCalled();
	});

	test("A normalized header stays one row and keeps the copy icon in its slot at any width", () => {
		// The copy icon is positioned from the row's measured width, so a break smuggled into the
		// header used to shorten the measured row and let the icon drift into the body's columns.
		const multiLine =
			"ssh dcu-cluster '\n  export PATH=/opt/bin:$PATH\n  srun -p fast bash -c \"hy-smi\"\n'";
		for (const width of [6, 7, 12, 20, 41, 42, 80, 120, 190, 200]) {
			const view = new ToolView({
				theme: plainTheme,
				header: { title: "bash", summary: multiLine },
				sections: [{ railToken: "dim", content: [multiLine] }],
				defaultLevel: 1,
				copy: { primary: "cmd" },
				outputPad: 1,
			});

			const rows = view.render(width);
			for (const row of rows) {
				expect(row).not.toMatch(/[\r\n]/);
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
		}

		const header = new ToolView({
			theme: plainTheme,
			header: { title: "bash", summary: "a\nb" },
			copy: { primary: "cmd" },
		}).render(40)[0]!;
		expect(visibleWidth(header)).toBe(40);
		expect(header).toContain("bash a b");
		expect(header.trimEnd().endsWith("󰆏")).toBe(true);
	});

	test("safely truncates massive 5MB multi-line output to 64KB hard limit in Level 2", () => {
		const fiveMbString = `${"x".repeat(100)}\n`;
		const hugeContent = fiveMbString.repeat(50000); // 50,000 lines, ~5MB

		const view = new ToolView({
			theme: plainTheme,
			header: { title: "bash", status: "ok", summary: "cat massive.log" },
			sections: [{ railToken: "dim", content: hugeContent }],
			defaultLevel: 2,
		});

		const rows = view.render(80);
		expect(rows.length).toBeLessThanOrEqual(504);
		expect(rows[0]).toContain("bash cat massive.log");
		expect(rows[rows.length - 1]).toMatch(/Output truncated: showing 64KB of/);
	});

	test("a provider-owned tool spins while pending and folds on its own verdict", () => {
		const resolve = setupResolver();
		const pi = { registerFlag() {}, on: () => () => {} } as unknown as ExtensionAPI;
		const native = createToolPresentationRenderers(pi, "python_eval", () => ({
			kind: "text",
			summary: "cell",
		}));
		const renderers = resolve("python_eval", () => native)!;
		const spinner = /^[·✢✳✶✻✽] /;

		const streaming = createMockContext({ argsComplete: false, isPartial: true });
		const row = renderers.renderCall!(streaming.args, plainTheme, streaming) as ToolView;
		expect(row.render(80)[0]).toMatch(spinner);

		const partial = renderers.renderResult!(
			{ content: [{ type: "text", text: "half" }], details: {} },
			{ expanded: false, isPartial: true },
			plainTheme,
			createMockContext({ isPartial: true }),
		) as ToolView;
		expect(partial.render(80)[0]).toMatch(spinner);

		const settled = renderers.renderResult!(
			{ content: [{ type: "text", text: "done" }], details: {} },
			{ expanded: false, isPartial: false },
			plainTheme,
			createMockContext(),
		) as ToolView;
		expect(settled.render(80)[0]).toMatch(/^[▸▾] /);
	});

	test.each([
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"find",
		"codemode",
		"python_eval",
		"subagent",
		"agents_delegate",
		"bg_bash",
		"todo",
		"web_search",
		"fetch_content",
		"apply_patch",
		"mcp__hindsight__recall",
	])("%s spins while it generates and while it runs, and only folds once it settles", (toolName) => {
		const resolve = setupResolver();
		const renderers = resolve(toolName, () => undefined)!;
		const spinner = /^[·✢✳✶✻✽] /;

		const streaming = createMockContext({ argsComplete: false, isPartial: true });
		const streamingRow = (
			renderers.renderCall!(streaming.args, plainTheme, streaming) as ToolView
		).render(80)[0]!;
		expect(streamingRow).toMatch(spinner);
		expect(streamingRow).not.toContain("▸");
		expect(streamingRow).not.toContain("▾");

		const running = createMockContext({ argsComplete: true, isPartial: true });
		const runningRow = (
			renderers.renderCall!(running.args, plainTheme, running) as ToolView
		).render(80)[0]!;
		expect(runningRow).toMatch(spinner);
		expect(runningRow).not.toContain("▸");

		const partial = renderers.renderResult!(
			{ content: [{ type: "text", text: "half" }], details: {} },
			{ expanded: false, isPartial: true },
			plainTheme,
			createMockContext({ isPartial: true }),
		) as ToolView;
		expect(partial.render(80)[0]).toMatch(spinner);

		const settled = renderers.renderResult!(
			{ content: [{ type: "text", text: "done" }], details: {} },
			{ expanded: false, isPartial: false },
			plainTheme,
			createMockContext(),
		) as ToolView;
		expect(settled.render(80)[0]).toMatch(/^[▸▾] /);
	});

	test("intercepts and frames MCP tools with ToolView generic fallback", () => {
		const resolve = setupResolver();
		const renderers = resolve("mcp__hindsight__recall", () => ({
			renderCall: (args, _t, _c) => new Text(`upstream call ${JSON.stringify(args)}`, 0, 0),
			renderResult: (res, _o, _t, _c) => {
				const part = res.content[0];
				return new Text(`upstream result: ${part && "text" in part ? part.text : ""}`, 0, 0);
			},
		}))!;

		const ctx = createMockContext({
			args: { query: "architectural decisions", budget: "high" },
			durationMs: 85,
		});

		// 1. Call view
		const callView = renderers.renderCall!(ctx.args, plainTheme, ctx) as ToolView;
		const callRows = callView.render(80);
		expect(callRows[0]).toMatch(/^[▸▾·✢✳✶✻✽] /);
		expect(callRows[0]).toContain("mcp__hindsight__recall");
		expect(callRows[0]).toContain("architectural decisions");

		// 2. Result view Level 0
		const resultView = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Found 3 memory records regarding architecture" }],
				details: { memoriesCount: 3 },
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		const level0 = resultView.render(120);
		expect(level0[0]).toContain("▸ ✓ mcp__hindsight__recall");
		expect(level0[0]).toContain("architectural decisions");
		expect(level0[0]).toContain("85ms");

		// 3. Level 1 toggle (preview upstream component)
		resultView.handleMouse(createMouseClick(2, 0, { width: 80 }));
		const level1 = resultView.render(80);
		expect(level1[0]).toContain("▾ ✓ mcp__hindsight__recall");
		expect(level1.join("\n")).toContain("upstream result: Found 3 memory records");
	});

	test("preserves raw arg preview for MCP tools without parameter guessing", () => {
		const resolve = setupResolver();
		const renderers = resolve("mcp__serena__serena_repl", () => undefined)!;

		const ctx = createMockContext({
			args: { code: "s.fs.read_file('src/index.ts', 0, 10)" },
		});
		const callView = renderers.renderCall!(ctx.args, plainTheme, ctx) as ToolView;
		callView.setFoldLevel(1);
		const rows = callView.render(80);
		expect(rows[0]).toContain("mcp__serena__serena_repl");
		expect(rows[0]).not.toContain("s.fs.read_file");
		expect(rows.join("\n")).toContain("s.fs.read_file");
	});

	test("frames resource MCP tools without guessing URI as summary", () => {
		const resolve = setupResolver();
		const renderers = resolve("read_mcp_resource", () => undefined)!;

		const ctx = createMockContext({
			args: { server: "sqlite", uri: "sqlite://data.db/tables" },
		});
		const callView = renderers.renderCall!(ctx.args, plainTheme, ctx) as ToolView;
		const rows = callView.render(80);
		expect(rows[0]).toContain("read_mcp_resource");

		// Regular unowned tools do NOT intercept when catchAll is false
		expect(
			setupResolver({ catchAll: false })("custom_random_tool", () => undefined),
		).toBeUndefined();
		// But with default catchAll, they are framed
		expect(resolve("custom_random_tool", () => undefined)?.renderShell).toBe("self");
	});

	test("preserves raw arguments in completed generic result Level 1", () => {
		const resolve = setupResolver();
		const renderers = resolve("mcp__server__operation", () => ({
			renderCall: (args) => new Text(`call ${JSON.stringify(args)}`, 0, 0),
			renderResult: (_res) => new Text("operation output", 0, 0),
		}))!;

		const ctx = createMockContext({
			args: { code: 404, query: "search terms", page_id: "p-1" },
		});
		const resultView = renderers.renderResult!(
			{
				content: [{ type: "text", text: "operation output" }],
				details: undefined,
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		// Level 1: must show raw arguments preview AND output
		resultView.setFoldLevel(1);
		const rows = resultView.render(100);
		const full = rows.join("\n");
		expect(full).toContain('"code": 404');
		expect(full).toContain('"query": "search terms"');
		expect(full).toContain("operation output");
	});

	test("preserves provider-owned collapsedRows over details.calls", () => {
		const customRow = "★ Custom Outcome Row";
		let captured: ToolRendererResolver | undefined;
		const pi = {
			registerToolRenderer(resolver: ToolRendererResolver) {
				captured = resolver;
			},
			on: () => () => {},
		} as unknown as ExtensionAPI;
		registerCollapsibleToolRenderer(pi, runtime);
		const native = createToolPresentationRenderers(pi, "custom_provider_tool", () => ({
			summary: "done",
			output: "ok",
			collapsedRows: [customRow],
		}));
		const renderers = captured!("custom_provider_tool", () => native)!;

		const ctx = createMockContext();
		const resultView = renderers.renderResult!(
			{
				content: [{ type: "text", text: "ok" }],
				details: {
					calls: [{ toolName: "nested_child", args: { q: 1 } }],
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		// Level 0: provider-owned row must NOT be replaced by nested calls
		const level0 = resultView.render(80);
		expect(level0.join("\n")).toContain(customRow);
	});

	test.each([
		{
			name: "a string array counts cumulative bytes",
			content: Array.from({ length: 100 }, () => "x".repeat(1024)),
			notice: "[Output truncated: showing 64KB of 100KB]",
		},
		{
			name: "a Unicode string counts UTF-8 bytes, not UTF-16 code units",
			content: "你".repeat(30_000),
			notice: "[Output truncated: showing 64KB of 88KB]",
		},
		{
			name: "a Unicode array counts UTF-8 bytes",
			content: ["你".repeat(30_000)],
			notice: "[Output truncated: showing 64KB of 88KB]",
		},
		{
			name: "a Component keeps its prefix and reports total bytes",
			content: {
				render: () => Array.from({ length: 100 }, () => "c".repeat(1024)),
				invalidate: () => {},
			},
			notice: "[Output truncated: showing 64KB of 100KB]",
		},
	])("bounds section content to the 64KB budget: $name", ({ content, notice }) => {
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "big_tool", status: "ok" },
			sections: [{ railToken: "dim", content }],
			defaultLevel: 2,
		});
		expect(view.render(80).join("\n")).toContain(notice);
	});

	test("wraps long line content across multiple rows in Level 1 with rail prefix", () => {
		const longText = "word ".repeat(30).trim();
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "wrap_tool", status: "ok" },
			sections: [{ railToken: "dim", content: longText }],
			defaultLevel: 1,
		});
		const rows = view.render(40);
		expect(rows.length).toBeGreaterThan(3);
		expect(rows[0]).toContain("wrap_tool");
		for (let i = 2; i < rows.length - 1; i++) {
			expect(rows[i]).toMatch(/^▎ /);
			expect(visibleWidth(rows[i] ?? "")).toBeLessThanOrEqual(40);
		}
	});

	test("wraps long lines and respects visual line cap with omitted hint in Level 1", () => {
		const longLines = Array.from({ length: 5 }, (_, i) => `line ${i} ${"data ".repeat(20)}`);
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "capped_wrap_tool", status: "ok" },
			sections: [{ railToken: "dim", content: longLines, maxLines: 6 }],
			defaultLevel: 1,
		});
		const rows = view.render(40);
		expect(rows.length).toBeLessThanOrEqual(10);
		const fullText = rows.join("\n");
		expect(fullText).toMatch(/… \(\d+ more lines/);
	});
	test("isolates lastComponent so upstream renderResult expecting Container.clear does not fail with ToolView", () => {
		const resolve = setupResolver();
		let clearCalls = 0;
		const mockContainer = {
			clear() {
				clearCalls += 1;
			},
			render: () => ["upstream output"],
			invalidate: () => {},
		};

		const renderers = resolve("mcp__test", () => ({
			renderCall: () => new Text("mcp__test call", 0, 0),
			renderResult: (_result, _options, _theme, context) => {
				const comp = (context.lastComponent as typeof mockContainer | undefined) ?? mockContainer;
				comp.clear();
				return comp;
			},
		}))!;

		const ctx = createMockContext();
		// Frame 1: creates ToolView
		const resultView1 = renderers.renderResult!(
			{ content: [{ type: "text", text: "output" }], details: undefined },
			{ expanded: true, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;
		resultView1.setFoldLevel(1);
		expect(resultView1.render(80).join("\n")).toContain("upstream output");
		expect(clearCalls).toBe(1);

		// Frame 2: host passes previous resultView1 as context.lastComponent
		const ctx2 = createMockContext({
			lastComponent: resultView1,
		});
		const resultView2 = renderers.renderResult!(
			{ content: [{ type: "text", text: "output" }], details: undefined },
			{ expanded: true, isPartial: false },
			plainTheme,
			ctx2,
		) as ToolView;
		resultView2.setFoldLevel(1);
		expect(resultView2.render(80).join("\n")).toContain("upstream output");
		expect(clearCalls).toBe(2);
	});
});
