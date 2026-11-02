import type {
	ExtensionAPI,
	Theme,
	ToolRendererResolver,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createToolPresentationRenderers, textToolResult } from "@hheei/pi-ext-core";
import { describe, expect, test, vi } from "vitest";
import {
	registerCollapsibleToolRenderer,
	type ToolRenderContext,
	type ToolView,
} from "../src/index.js";
import { ToolUiRuntime } from "../src/runtime.js";

/** The state this test's runtime owns; the extension builds the same one per Pi runtime. */
const runtime = new ToolUiRuntime();

const theme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
function context(overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
	return {
		args: {},
		state: {},
		toolCallId: "parent",
		cwd: "/repo",
		invalidate: vi.fn(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		lastComponent: undefined,
		durationMs: 120,
		outputPad: 0,
		...overrides,
	};
}
function host(copyToClipboard = vi.fn(async (_text: string) => {})) {
	let resolver: ToolRendererResolver | undefined;
	const pi = {
		events: {},
		on: () => () => {},
		registerToolRenderer(value: ToolRendererResolver) {
			resolver = value;
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		register(overrides?: import("../src/renderer.js").CollapsibleToolRendererOptions) {
			registerCollapsibleToolRenderer(pi, runtime, { copyToClipboard, ...overrides });
		},
		resolve(name: string, native?: ToolRenderers) {
			if (resolver === undefined) throw new Error("UI not registered");
			return resolver(name, () => native)!;
		},
		copyToClipboard,
	};
}
function provider() {
	return {
		summary: "owner format",
		request: `full request\n${"source\n".repeat(20)}`,
		output: "id: work-1\npath: /sessions/child.jsonl",
		collapsedRows: ["work-1", "/sessions/child.jsonl"],
		copy: { primary: "raw request", full: "raw request\nfull result" },
	};
}

describe("optional owner presentation consumer", () => {
	test.each(["owner first", "UI first"])("wraps tools without a UI name catalog: %s", (order) => {
		const h = host();
		if (order === "UI first") h.register();
		const native = createToolPresentationRenderers(h.pi, "custom_owner", provider);
		if (order === "owner first") h.register();
		const renderer = h.resolve("custom_owner", native);
		expect(renderer.renderShell).toBe("self");
		const ctx = context();
		const call = renderer.renderCall!(ctx.args, theme, ctx) as ToolView;
		const result = renderer.renderResult!(
			textToolResult("model payload", undefined),
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		) as ToolView;
		expect(call.render(80)).toEqual([]);
		expect(result.render(80).join("\n")).toContain("/sessions/child.jsonl");
		expect(result.render(80)[0]).toContain("owner format · 120ms");
		for (const width of [12, 120]) {
			result.setFoldLevel(2);
			const lines = result.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		result.setFoldLevel(2);
		expect(result.render(120).join("\n")).toContain("full request");
	});

	test("a running container folds and lets the child it is waiting for animate", () => {
		const h = host();
		h.register();
		const native = createToolPresentationRenderers(h.pi, "container_owner", () => ({
			summary: "cell running",
		}));
		const renderer = h.resolve("container_owner", native);
		const ctx = context({ toolCallId: "live-parent", isPartial: true, durationMs: undefined });
		// The host reports the nested call before the container reports anything about it.
		runtime.tracker.recordStart({
			toolCallId: "live-parent/1",
			toolName: "bash",
			args: { command: "ls" },
			parentToolCallId: "live-parent",
		});
		const rows = (renderer.renderCall!(ctx.args, theme, ctx) as ToolView).render(80);
		// The container only folds; the child row is the one that carries the live glyph.
		expect(rows[0]).toContain("▸");
		expect(rows[0]).not.toMatch(/[·✢✳✶✻✽]/);
		expect(rows.join("\n")).toMatch(/[·✢✳✶✻✽] bash/);
	});

	test.each([
		"top-level",
		"nested",
	])("preserves owner copy bytes through the %s UI path", (path) => {
		const h = host();
		h.register();
		const request = "  print('末尾')\n\u001b[31mZZ_TAIL_OWNER\u001b[0m  ";
		const full = `${request}\n---\nclean output`;
		const native = createToolPresentationRenderers(h.pi, "custom_owner", () => ({
			...provider(),
			request,
			copy: { primary: request, full },
		}));
		const child = {
			toolCallId: "parent/1",
			toolName: "custom_owner",
			args: {},
			result: textToolResult("model payload", undefined),
			durationMs: 25,
			isError: false,
		};
		const renderer = path === "nested" ? h.resolve("codemode") : h.resolve("custom_owner", native);
		const view = renderer.renderResult!(
			textToolResult(
				"model payload",
				path === "nested" ? { __piExtUiCapturedCalls: [child] } : undefined,
			),
			{ expanded: false, isPartial: false },
			theme,
			context(),
		) as ToolView;
		view.render(80);
		const click = {
			type: "click",
			button: "left",
			x: 77,
			y: path === "nested" ? 1 : 0,
			screenX: 77,
			screenY: 0,
			width: 80,
			height: 10,
			ctrl: false,
			shift: false,
			alt: false,
		} as const;
		view.handleMouse(click);
		expect(h.copyToClipboard).toHaveBeenLastCalledWith(request);
		view.handleMouse({ ...click, shift: true });
		expect(h.copyToClipboard).toHaveBeenLastCalledWith(full);
	});

	test("preserves failing content and leaves unrelated native renderers alone", () => {
		const h = host();
		h.register();
		const native = createToolPresentationRenderers(h.pi, "custom_owner", provider);
		const renderer = h.resolve("custom_owner", native);
		const view = renderer.renderResult!(
			textToolResult("Bridge denied", undefined),
			{ expanded: false, isPartial: false },
			theme,
			context({ isError: true }),
		) as ToolView;
		expect(view.render(80).join("\n")).toContain("✗ custom_owner");
		view.setFoldLevel(2);
		expect(view.render(80).join("\n")).toContain("Bridge denied");
		expect(view.render(80).join("\n")).not.toContain("id: work-1");
		const unrelated: ToolRenderers = { renderCall: () => native.renderCall!({}, theme, context()) };
		expect(h.resolve("unrelated", unrelated).renderShell).toBe("self");

		const optOutHost = host();
		optOutHost.register({ catchAll: false });
		expect(optOutHost.resolve("unrelated", unrelated)).toBe(unrelated);
	});

	test("nested calls use owner summary, full body and copy payload", () => {
		const h = host();
		h.register();
		const native = createToolPresentationRenderers(h.pi, "custom_owner", provider);
		const child = {
			toolCallId: "parent/1",
			toolName: "custom_owner",
			args: { message: "original" },
			result: textToolResult("model payload", undefined),
			durationMs: 25,
			isError: false,
		};
		const ctx = context();
		const parent = h.resolve("codemode").renderResult!(
			textToolResult("", { __piExtUiCapturedCalls: [child] }),
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		) as ToolView;
		expect(parent.render(80).join("\n")).toContain("custom_owner owner format");
		const click = {
			type: "click",
			button: "left",
			x: 5,
			y: 1,
			screenX: 5,
			screenY: 1,
			width: 80,
			height: 10,
			ctrl: true,
			shift: false,
			alt: false,
		} as const;
		parent.handleMouse(click);
		expect(parent.render(80).join("\n")).toContain("full request");
		parent.handleMouse({ ...click, ctrl: false, x: 77 });
		expect(h.copyToClipboard).toHaveBeenCalledWith("raw request");
		parent.handleMouse({ ...click, ctrl: false, x: 77, shift: true });
		expect(h.copyToClipboard).toHaveBeenCalledWith("raw request\nfull result");
		expect(native.renderShell).toBeUndefined();
	});

	test("an owner's multi-line summary, request and board rows each stay one row", () => {
		const h = host();
		h.register();
		// A provider owns its text, so the shared frame is what keeps a break out of the row Pi writes.
		const native = createToolPresentationRenderers(h.pi, "custom_owner", () => ({
			summary: "first\nsecond\rthird",
			request: "req\nline2",
			output: "out\nline2",
			collapsedRows: ["a\nb"],
		}));
		const renderer = h.resolve("custom_owner", native);
		const ctx = context();

		for (const level of [0, 1, 2] as const) {
			const view = renderer.renderResult!(
				textToolResult("payload", undefined),
				{ expanded: level === 2, isPartial: false },
				theme,
				ctx,
			) as ToolView;
			view.setFoldLevel(level);
			const lines = view.render(80);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(line).not.toMatch(/[\r\n]/);
				expect(visibleWidth(line)).toBeLessThanOrEqual(80);
			}
			expect(lines[0]).toContain("custom_owner first second third");
		}
	});

	test("renders DiffToolPresentation using DiffView and default copy spec", () => {
		const copied: string[] = [];
		const h = host(
			vi.fn(async (text) => {
				copied.push(text);
			}),
		);
		h.register();

		const diffText = ["@@ -1,3 +1,3 @@", " line1", "-old", "+new", " line3"].join("\n");

		const native = createToolPresentationRenderers(h.pi, "edit", () => ({
			kind: "diff",
			path: "test.txt",
			diff: diffText,
			stats: { additions: 1, deletions: 1 },
			summary: "test.txt (+1 -1)",
		}));
		const renderer = h.resolve("edit", native);
		const ctx = context();
		const view = renderer.renderResult!(
			textToolResult("ok", undefined),
			{ expanded: true, isPartial: false },
			theme,
			ctx,
		) as ToolView;
		view.setFoldLevel(1);
		const lines = view.render(80);
		expect(lines[0]).toContain("edit test.txt (+1 -1)");
		expect(lines.join("\n")).toContain("- 2 old");
		expect(lines.join("\n")).toContain("+ 2 new");
	});
});
