import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type MessageViewSpec, messageViewPoint, registerExtensionHook } from "@hheei/pi-ext-core";
import { expect, test, vi } from "vitest";
import { appendSubagentInfo, registerSubagentInfo, renderSubagentInfo } from "../src/info.js";

const theme = { fg: (_color: string, text: string) => text };
const report = {
	parentSessionId: "parent",
	childId: "agent-21",
	agent: "worker",
	task: "inspect",
	status: "running" as const,
	reason: "success",
	message: "Complete report\nwith details.",
};

test.each([
	["success", "done", "✓"],
	["error", "error", "✗"],
	["blocked", "blocked", "!"],
])("records a confirmed %s report as a compact info entry", (reason, status, glyph) => {
	const appendEntry = vi.fn<ExtensionAPI["appendEntry"]>();
	appendSubagentInfo({ appendEntry }, { ...report, reason });
	const data = appendEntry.mock.calls[0]?.[1];
	expect(appendEntry).toHaveBeenCalledWith("subagent-info", {
		id: "agent-21",
		agent: "worker",
		status,
		message: report.message,
	});
	expect(renderSubagentInfo(data, false, theme)).toBe(
		`info · agents · ${glyph} #21 worker · ${status}`,
	);
	expect(renderSubagentInfo(data, true, theme)).toContain(report.message);
});

test("renders stored info entries safely at narrow and wide widths", () => {
	const registerEntryRenderer = vi.fn<ExtensionAPI["registerEntryRenderer"]>();
	registerSubagentInfo({ registerEntryRenderer });
	const renderer = registerEntryRenderer.mock.calls[0]![1];
	const data = {
		id: "agent-21",
		agent: "worker\b\u0007\nwith a long title",
		status: "error",
		message: `\u001b[31mFai\b\u0007\u0085lure\u001b[0m\n\t${"详细报告 ".repeat(30)}`,
	};
	expect(renderSubagentInfo(data, false, theme)).toContain("worker with a long title · error");
	expect(renderSubagentInfo(data, true, theme)).toContain("\nFailure\n    详细报告");
	const entry = {
		type: "custom" as const,
		id: "entry-1",
		parentId: null,
		timestamp: "2026-10-13T00:00:00.000Z",
		customType: "subagent-info",
		data,
	};
	// This renderer only calls Theme.fg; the fixture supplies that method.
	for (const expanded of [false, true]) {
		const component = renderer(
			entry,
			{ expanded, keyText: () => "", keyHint: (_keybinding, description) => description },
			theme as Theme,
		);
		for (const width of [24, 80]) {
			for (const row of component?.render(width) ?? []) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
				expect(row).not.toMatch(/[\r\n]/u);
				expect(row).not.toContain("\b");
				expect(row).not.toContain("\u0007");
				expect(row).not.toContain("\u0085");
			}
		}
	}
	expect(renderSubagentInfo({ ...data, status: "invalid" }, false, theme)).toBeUndefined();
});

test("uses the optional message view and keeps an empty report collapsed", async () => {
	const registerEntryRenderer = vi.fn<ExtensionAPI["registerEntryRenderer"]>();
	const pi = { registerEntryRenderer };
	registerSubagentInfo(pi);
	const specs: MessageViewSpec[] = [];
	const hook = registerExtensionHook(pi as unknown as ExtensionAPI, messageViewPoint, (value) => {
		specs.push(value);
		return { render: () => ["view"], invalidate() {} };
	});
	const renderer = registerEntryRenderer.mock.calls[0]![1];
	const entry = {
		type: "custom" as const,
		id: "entry-1",
		parentId: null,
		timestamp: "2026-10-13T00:00:00.000Z",
		customType: "subagent-info",
		data: { id: "agent-21", agent: "worker", status: "done", message: "Complete report" },
	};
	expect(
		renderer(
			entry,
			{ expanded: true, keyText: () => "", keyHint: (_keybinding, description) => description },
			theme as Theme,
		)
			?.render(40)
			.join("\n"),
	).toBe("view");
	expect(specs[0]?.header).toEqual({
		kind: "agents",
		summary: "✓ #21 worker · done",
		tone: "success",
	});
	expect(specs[0]?.body).toBe("Complete report");
	const empty = { ...entry, id: "entry-2", data: { ...entry.data, message: "  " } };
	renderer(
		empty,
		{ expanded: false, keyText: () => "", keyHint: (_keybinding, description) => description },
		theme as Theme,
	);
	expect(specs[1]?.body).toBeUndefined();
	expect(specs[1]?.header.tone).toBe("success");
	await hook.dispose();
});
