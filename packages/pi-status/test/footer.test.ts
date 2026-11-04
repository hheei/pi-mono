import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
	CompactFooterComponent,
	type FooterTheme,
	formatCwdForFooter,
	formatFooterContext,
	formatFooterModel,
	formatFooterPath,
	layoutTwoColumnRow,
	type ReadonlyFooterDataProvider,
} from "../src/index.js";

const mockTheme = {
	fg(
		color: "dim" | "muted" | "success" | "warning" | "error" | "accent" | "text",
		text: string,
	): string {
		return `[${color}:${text}]`;
	},
};

describe("compact footer formatting", () => {
	test("formats cwd with tilde for home directory", () => {
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/var/log", "/home/user")).toBe("/var/log");
		expect(formatCwdForFooter("/some/path", undefined)).toBe("/some/path");
	});

	test("formats footer model with provider and thinking level", () => {
		expect(formatFooterModel({ id: "gemini-3.8-flash", provider: "gm" }, "high")).toBe(
			"gm/gemini-3.8-flash(high)",
		);

		// "off" thinking level is omitted for compactness
		expect(formatFooterModel({ id: "gemini-3.8-flash", provider: "gm" }, "off")).toBe(
			"gm/gemini-3.8-flash",
		);

		// undefined thinking level is omitted
		expect(formatFooterModel({ id: "gemini-3.8-flash", provider: "gm" }, undefined)).toBe(
			"gm/gemini-3.8-flash",
		);

		// without provider
		expect(formatFooterModel({ id: "claude-3.7-sonnet" }, "medium")).toBe(
			"claude-3.7-sonnet(medium)",
		);

		// without model
		expect(formatFooterModel(undefined, undefined)).toBe("no-model");

		// with theme: provider in dim, model in text, thinking in dim parens + accent
		expect(formatFooterModel({ id: "gemini-3.8-flash", provider: "gm" }, "high", mockTheme)).toBe(
			"[dim:gm/][text:gemini-3.8-flash][dim:(][accent:high][dim:)]",
		);

		expect(formatFooterModel({ id: "gemini-3.8-flash" }, "off", mockTheme)).toBe(
			"[text:gemini-3.8-flash]",
		);

		// with routedModel (e.g. virtual model mapped to physical model)
		expect(
			formatFooterModel({ id: "fast-router", provider: "virtual" }, "off", undefined, {
				model: { id: "gemini-3.8-flash", provider: "gm" },
				thinkingLevel: "high",
			}),
		).toBe("virtual/fast-router → gm/gemini-3.8-flash(high)");

		expect(
			formatFooterModel({ id: "fast-router", provider: "virtual" }, "off", mockTheme, {
				model: { id: "gemini-3.8-flash", provider: "gm" },
				thinkingLevel: "high",
			}),
		).toBe(
			"[dim:virtual/][text:fast-router] [dim:→] [dim:gm/][text:gemini-3.8-flash][dim:(][accent:high][dim:)]",
		);

		// identical routedModel is ignored
		expect(
			formatFooterModel({ id: "gemini-3.8-flash", provider: "gm" }, "off", undefined, {
				model: { id: "gemini-3.8-flash", provider: "gm" },
			}),
		).toBe("gm/gemini-3.8-flash");
	});

	test("formats footer path with muted cwd and accent branch in dim parens", () => {
		expect(formatFooterPath("/home/user/project", "main", mockTheme, "/home/user")).toBe(
			"[muted:~/project] [dim:(][accent:main][dim:)]",
		);
		expect(formatFooterPath("/home/user/project", undefined, mockTheme, "/home/user")).toBe(
			"[muted:~/project]",
		);
	});

	test("formats context ratio with semantic color thresholds", () => {
		// <= 70% is muted percent + dim window
		expect(
			formatFooterContext({ percent: 12, contextWindow: 1_000_000 }, 1_000_000, mockTheme),
		).toBe("[muted:12%][dim:/1M]");

		// 70% ~ 90% is warning
		expect(formatFooterContext({ percent: 75.4, contextWindow: 200_000 }, 200_000, mockTheme)).toBe(
			"[warning:75%/200K]",
		);

		// > 90% is error
		expect(formatFooterContext({ percent: 94.8, contextWindow: 100_000 }, 100_000, mockTheme)).toBe(
			"[error:95%/100K]",
		);

		// missing percent shows ?%
		expect(formatFooterContext(undefined, 128_000, mockTheme)).toBe("[muted:?%][dim:/128K]");
	});

	test("arranges two columns with left-priority truncation on narrow widths", () => {
		const left = "gm/gemini-3.8-flash(high) · 12%/1M";
		const right = "󰪠 #1 Task title";

		// 1. Ample space: left on left, right on right
		const wide = layoutTwoColumnRow(left, right, 80);
		expect(wide).toContain(left);
		expect(wide).toContain(right);
		expect(wide.endsWith(right)).toBe(true);

		// 2. Constrained space: right is truncated with ellipsis, left is preserved intact
		// left is 34 cols, minGap is 2, available for right is 44 - 36 = 8 cols
		const medium = layoutTwoColumnRow(left, right, 44);
		expect(medium.startsWith(left)).toBe(true);
		expect(medium).toContain("…");

		// 3. Narrow space: right is dropped entirely to keep left complete
		// available for right would be 37 - 34 - 2 = 1 col (< 4 cols), so dropped
		const narrow = layoutTwoColumnRow(left, right, 37);
		expect(narrow).toBe(left);

		// 4. Extremely narrow: left is truncated to fit width
		const extreme = layoutTwoColumnRow(left, right, 20);
		expect(visibleWidth(extreme)).toBe(20);
	});
});

describe("CompactFooterComponent", () => {
	test("renders two distinct lines with correct data integration", () => {
		const extensionStatuses = new Map<string, string>([["pi-ext-tools:todo", "󰪠 #1 Task title"]]);
		const footerData: ReadonlyFooterDataProvider = {
			getGitBranch: () => "main",
			getExtensionStatuses: () => extensionStatuses,
			onBranchChange: vi.fn(() => () => {}),
			getAvailableProviderCount: () => 1,
		};

		const ctx = {
			model: { id: "gemini-3.8-flash", provider: "gm", contextWindow: 1_000_000 },
			thinkingLevel: "high",
			getContextUsage: () => ({ percent: 12.3, contextWindow: 1_000_000, tokens: 123_000 }),
			sessionManager: {
				getCwd: () => "/home/user/pi-mono",
				getSessionName: () => "Optimize footer",
			},
		} as unknown as ExtensionContext;

		const tui = { requestRender: vi.fn() };
		const footer = new CompactFooterComponent(
			ctx,
			tui,
			mockTheme as unknown as FooterTheme,
			footerData,
		);

		const lines = footer.render(120);
		expect(lines).toHaveLength(2);

		// Line 1: cwd + branch on left, session name on right
		expect(lines[0]).toContain("pi-mono");
		expect(lines[0]).toContain("main");
		expect(lines[0]).toContain("Optimize footer");

		// Line 2: provider/model(level) · context on left, todo on right
		expect(lines[1]).toContain("gemini-3.8-flash");
		expect(lines[1]).toContain("high");
		expect(lines[1]).toContain("·");
		expect(lines[1]).toContain("12%");
		expect(lines[1]).toContain("/1M");
		expect(lines[1]).toContain("󰪠 #1 Task title");

		footer.dispose();
	});

	test("places auto-title generating status on Line 1 right and keeps Line 2 free for todo", () => {
		const extensionStatuses = new Map<string, string>([
			["auto-title", "✻ generating title..."],
			["pi-ext-tools:todo", "󰪠 #2 Review PR"],
		]);
		const footerData: ReadonlyFooterDataProvider = {
			getGitBranch: () => "main",
			getExtensionStatuses: () => extensionStatuses,
			onBranchChange: vi.fn(() => () => {}),
			getAvailableProviderCount: () => 1,
		};

		const ctx = {
			model: { id: "gemini-3.8-flash", provider: "gm", contextWindow: 1_000_000 },
			thinkingLevel: "high",
			getContextUsage: () => ({ percent: 5, contextWindow: 1_000_000, tokens: 50_000 }),
			sessionManager: {
				getCwd: () => "/home/user/pi-mono",
				getSessionName: () => undefined,
			},
		} as unknown as ExtensionContext;

		const tui = { requestRender: vi.fn() };
		const footer = new CompactFooterComponent(
			ctx,
			tui,
			mockTheme as unknown as FooterTheme,
			footerData,
		);

		const lines = footer.render(120);
		expect(lines).toHaveLength(2);

		// Line 1: auto-title generating status MUST be on line 1 right
		expect(lines[0]).toContain("✻ generating title...");

		// Line 2: todo status on line 2 right, not auto-title
		expect(lines[1]).toContain("󰪠 #2 Review PR");
		expect(lines[1]).not.toContain("generating title...");

		footer.dispose();
	});
});

/** No styling, so rows are measured in real terminal cells. */
const plainTheme = { fg: (_color: string, text: string): string => text } as FooterTheme;

/** Mounts the compact footer over a live extension status map so tests can mutate it between renders. */
function mountFooter(extensionStatuses: Map<string, string>): CompactFooterComponent {
	const footerData: ReadonlyFooterDataProvider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => extensionStatuses,
		onBranchChange: vi.fn(() => () => {}),
		getAvailableProviderCount: () => 1,
	};

	const ctx = {
		model: { id: "gemini-3.8-flash", provider: "gm", contextWindow: 1_000_000 },
		thinkingLevel: "high",
		getContextUsage: () => ({ percent: 12.3, contextWindow: 1_000_000, tokens: 123_000 }),
		sessionManager: {
			getCwd: () => "/home/user/pi-mono",
			getSessionName: () => "Optimize footer",
		},
	} as ExtensionContext;

	return new CompactFooterComponent(ctx, { requestRender: vi.fn() }, plainTheme, footerData);
}

const AGENT_SEGMENT = "agents x3";
const TODO_SEGMENT = "󰪠 #1 Task title";
const SEPARATOR = " ‧ ";

describe("CompactFooterComponent line 2 right", () => {
	test("joins running agents then TODO with a dim separator on wide terminals", () => {
		const footer = mountFooter(
			new Map([
				["pi-subagents", AGENT_SEGMENT],
				["pi-ext-tools:todo", TODO_SEGMENT],
			]),
		);

		const line2 = footer.render(120)[1] ?? "";
		expect(line2.endsWith(TODO_SEGMENT)).toBe(true);
		expect(line2).toContain(AGENT_SEGMENT);
		expect(line2.indexOf(AGENT_SEGMENT)).toBeLessThan(line2.indexOf(SEPARATOR));
		expect(line2.indexOf(SEPARATOR)).toBeLessThan(line2.indexOf(TODO_SEGMENT));

		footer.dispose();
	});

	test("drops the separator when only one segment is present", () => {
		const agentsOnly = mountFooter(new Map([["pi-subagents", AGENT_SEGMENT]]));
		const agentsLine = agentsOnly.render(120)[1] ?? "";
		expect(agentsLine).toContain(AGENT_SEGMENT);
		expect(agentsLine).not.toContain(SEPARATOR);
		expect(agentsLine).not.toContain(TODO_SEGMENT);
		agentsOnly.dispose();

		const todoOnly = mountFooter(new Map([["pi-ext-tools:todo", TODO_SEGMENT]]));
		const todoLine = todoOnly.render(120)[1] ?? "";
		expect(todoLine).toContain(TODO_SEGMENT);
		expect(todoLine).not.toContain(SEPARATOR);
		expect(todoLine).not.toContain(AGENT_SEGMENT);
		todoOnly.dispose();
	});

	test("removes the agent segment once the last child stops", () => {
		const statuses = new Map([
			["pi-subagents", AGENT_SEGMENT],
			["pi-ext-tools:todo", TODO_SEGMENT],
		]);
		const footer = mountFooter(statuses);

		expect(footer.render(120)[1] ?? "").toContain(AGENT_SEGMENT);

		statuses.delete("pi-subagents");
		const afterStop = footer.render(120)[1] ?? "";
		expect(afterStop).not.toContain(AGENT_SEGMENT);
		expect(afterStop).not.toContain(SEPARATOR);
		expect(afterStop).toContain(TODO_SEGMENT);

		statuses.clear();
		const afterClear = footer.render(120)[1] ?? "";
		expect(afterClear).not.toContain(TODO_SEGMENT);
		expect(afterClear).not.toContain(AGENT_SEGMENT);

		footer.dispose();
	});

	test("falls back to an unrelated extension status, never to auto-title or the owned keys", () => {
		const footer = mountFooter(
			new Map([
				["auto-title", "✻ generating title..."],
				["pi-subagents", "   "],
				["pi-ext-tools:todo", ""],
				["pi-ext-addon:other", "󰄴 indexing"],
			]),
		);

		const line2 = footer.render(120)[1] ?? "";
		expect(line2).toContain("󰄴 indexing");
		expect(line2).not.toContain("generating title...");

		// A live agent or TODO segment wins over the fallback.
		const owned = mountFooter(
			new Map([
				["pi-subagents", AGENT_SEGMENT],
				["pi-ext-addon:other", "󰄴 indexing"],
			]),
		);
		const ownedLine = owned.render(120)[1] ?? "";
		expect(ownedLine).toContain(AGENT_SEGMENT);
		expect(ownedLine).not.toContain("󰄴 indexing");

		footer.dispose();
		owned.dispose();
	});

	test("keeps line 2 inside narrow and extremely narrow widths", () => {
		const statuses = new Map([
			["pi-subagents", AGENT_SEGMENT],
			["pi-ext-tools:todo", TODO_SEGMENT],
		]);
		const footer = mountFooter(statuses);

		// 70 cols still fits both segments beside the left column
		const medium = footer.render(70)[1] ?? "";
		expect(medium).toContain(AGENT_SEGMENT);
		expect(medium).toContain(TODO_SEGMENT);

		// 50 cols keeps the left column intact and truncates the right column
		const narrow = footer.render(50)[1] ?? "";
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(50);
		expect(narrow).toContain("…");
		expect(narrow).not.toContain("\n");

		// 30 cols drops the right column and fits the left one
		const extreme = footer.render(30)[1] ?? "";
		expect(visibleWidth(extreme)).toBe(30);
		expect(extreme).not.toContain(AGENT_SEGMENT);

		footer.dispose();
	});
});
