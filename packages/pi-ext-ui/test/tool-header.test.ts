import type { ExtensionAPI, Theme, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import {
	setCapabilityOverrides,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { createToolPresentationRenderers, textToolResult } from "@hheei/pi-ext-core";
import { describe, expect, test, vi } from "vitest";
import {
	formatToolHeaderText,
	registerCollapsibleToolRenderer,
	type ToolRenderContext,
	ToolView,
} from "../src/index.js";
import { ToolUiRuntime } from "../src/runtime.js";

/** The state this test's runtime owns; the extension builds the same one per Pi runtime. */
const runtime = new ToolUiRuntime();

/** A theme that spells out every token, so a color that changes shows up as a changed string. */
const theme = {
	fg: (token: string, text: string) => `[${token}]${text}[/]`,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => `*${text}*`,
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
		keyText: () => "",
		keyHint: (_keybinding, description) => description,
		...overrides,
	};
}

function host() {
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
		register() {
			registerCollapsibleToolRenderer(pi, runtime, { copyToClipboard: vi.fn(async () => {}) });
		},
		resolve(name: string, native?: never) {
			if (resolver === undefined) throw new Error("no UI registered");
			return resolver(name, () => native)!;
		},
	};
}

describe("formatToolHeaderText", () => {
	test("gives the name the title token and the summary the muted one", () => {
		expect(formatToolHeaderText({ status: "ok", title: "read", summary: "a.ts" }, theme)).toBe(
			"[success]✓[/] [toolTitle]*read*[/] [dim]a.ts[/]",
		);
	});

	test("states bash's command as the row's content, the way the native shell row does", () => {
		// The command is what the row is about; dimming it would bury the only thing it says.
		expect(formatToolHeaderText({ status: "ok", title: "bash", summary: "pnpm test" }, theme)).toBe(
			"[success]✓[/] [toolTitle]*bash*[/] [toolTitle]*pnpm test*[/]",
		);
	});

	test("keeps a summary the tool layer already themed and dims the meta facts after it", () => {
		expect(
			formatToolHeaderText(
				{
					status: "ok",
					title: "read",
					summary: "[accent]src/a.ts[/][warning]:1-40[/]",
					summaryStyled: true,
					meta: "1.2s",
				},
				theme,
			),
		).toBe(
			"[success]✓[/] [toolTitle]*read*[/] [accent]src/a.ts[/][warning]:1-40[/][dim] · [/][dim]1.2s[/]",
		);
	});

	test("omits the glyph slot entirely when the row reports no status", () => {
		expect(formatToolHeaderText({ status: "none", title: "codemode" }, theme)).toBe(
			"[toolTitle]*codemode*[/]",
		);
	});
});

describe("a container board row", () => {
	const cases = [
		{
			toolName: "write",
			args: { path: "src/app.ts" },
			isError: false,
			summary: "src/app.ts (+12 -3)",
		},
		{ toolName: "bash", args: { command: "pnpm test" }, isError: false, summary: "pnpm test" },
		{ toolName: "edit", args: { path: "src/other.ts" }, isError: true, summary: "src/other.ts" },
	];

	test.each(cases)("colors a nested $toolName exactly like that tool colors its own header", ({
		toolName,
		args,
		isError,
		summary,
	}) => {
		const h = host();
		h.register();
		const native = createToolPresentationRenderers(h.pi, toolName, () => ({
			summary,
			output: "payload",
		}));
		const own = h.resolve(toolName, native as never);
		const ownRow = (
			own.renderResult!(
				textToolResult("model payload", undefined),
				{ expanded: false, isPartial: false },
				theme,
				context({ toolCallId: "child", args, isError }),
			) as ToolView
		).render(120)[0];
		expect(ownRow).toBeDefined();

		const parent = h.resolve("codemode").renderResult!(
			textToolResult("", {
				__piExtUiCapturedCalls: [
					{
						toolCallId: "child",
						toolName,
						args,
						result: textToolResult("model payload", undefined),
						durationMs: 120,
						isError,
					},
				],
			}),
			{ expanded: false, isPartial: false },
			theme,
			context(),
		) as ToolView;
		const boardRow = parent.render(120)[1];
		expect(boardRow).toBeDefined();

		// The only intended difference is the fold pin: a nested row hangs off the parent's rail.
		const ownHeader = stripTerminalSequences(ownRow ?? "")
			.replace(/^\[dim\][▸▾]\[\/\] /, "")
			.trimEnd();
		const boardHeader = stripTerminalSequences(boardRow ?? "").replace(/^\[dim\]▎\[\/\] /, "");
		expect(boardHeader.slice(0, ownHeader.length)).toBe(ownHeader);
	});
});

describe("a tool row's semantic tokens", () => {
	function readRow(
		width: number,
		args: unknown = { path: "/repo/src/a.ts", offset: 10, limit: 5 },
	) {
		const h = host();
		h.register();
		const view = h.resolve("read").renderResult!(
			textToolResult("file body", undefined),
			{ expanded: false, isPartial: false },
			theme,
			context({ args }),
		) as ToolView;
		const row = view.render(width)[0];
		if (row === undefined) throw new Error("no header row");
		return row;
	}

	test("read states an accent path, its warning line range, and a dim duration", () => {
		const row = readRow(120);
		expect(row).toContain("[toolTitle]*read*[/]");
		expect(row).toContain("[accent]/repo/src/a.ts[/]");
		expect(row).toContain("[warning]:10-14[/]");
		expect(row).toContain("[dim]120ms[/]");
	});

	test("read keeps its path and range on one row at narrow and wide widths", () => {
		// The tagged theme spells its tokens as visible text, so a 30-cell row is cut inside them;
		// width safety is what the narrow layout owes, and the tokens are asserted where they fit.
		for (const width of [30, 80, 120]) {
			const row = readRow(width);
			expect(row).not.toMatch(/[\r\n]/);
			expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
		expect(readRow(80)).toContain("[toolTitle]*read*[/]");
		expect(readRow(80)).toContain("[accent]/repo/src/a.ts[/]");
		expect(readRow(120)).toContain("[warning]:10-14[/]");
	});

	test("read shows no range when the call reads the whole file", () => {
		const row = readRow(120, { path: "src/a.ts" });
		expect(row).toContain("[accent]src/a.ts[/]");
		expect(row).not.toContain("[warning]");
	});

	test("bash states the command as content and its timeout and duration as secondary", () => {
		const h = host();
		h.register();
		const view = h.resolve("bash").renderResult!(
			textToolResult("ok", undefined),
			{ expanded: false, isPartial: false },
			theme,
			context({ args: { command: "pnpm test", timeout: 30 } }),
		) as ToolView;
		const row = view.render(120)[0] ?? "";
		expect(row).toContain("[toolTitle]*bash*[/] [toolTitle]*pnpm test*[/]");
		expect(row).toContain("[dim](timeout 30s) · 120ms[/]");
		expect(row).not.toContain("[dim]pnpm test");
	});
});

describe("theme-dependent cache", () => {
	test("repaints a cached header once the host invalidates it", () => {
		const palette: Record<string, string> = { toolTitle: "cyan" };
		const mutable = {
			fg: (token: string, value: string) => `<${palette[token] ?? token}>${value}`,
			bg: (_token: string, value: string) => value,
			bold: (value: string) => value,
			italic: (value: string) => value,
		} as unknown as Theme;
		const view = new ToolView({ theme: mutable, header: { title: "read", status: "ok" } });
		const before = view.render(60)[0];
		palette.toolTitle = "magenta";
		// The cache is keyed by width and fold state; Pi invalidates every component on a theme change.
		expect(view.render(60)[0]).toBe(before);
		view.invalidate();
		expect(view.render(60)[0]).toContain("<magenta>read");
	});
});

describe("read's path link", () => {
	function row(): string {
		const h = host();
		h.register();
		const view = h.resolve("read").renderResult!(
			textToolResult("file body", undefined),
			{ expanded: false, isPartial: false },
			theme,
			context({ args: { path: "/repo/src/a.ts" } }),
		) as ToolView;
		return view.render(120)[0] ?? "";
	}

	test("links the accent path to the file only when the terminal draws OSC 8 links", () => {
		try {
			setCapabilityOverrides({ hyperlinks: true });
			expect(row()).toContain("\u001b]8;;file:///repo/src/a.ts\u001b\\");
			expect(row()).toContain("[accent]/repo/src/a.ts[/]");
			setCapabilityOverrides({ hyperlinks: false });
			expect(row()).not.toContain("]8;;");
			expect(row()).toContain("[accent]/repo/src/a.ts[/]");
		} finally {
			setCapabilityOverrides({});
		}
	});
});
