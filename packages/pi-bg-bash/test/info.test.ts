import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type MessageViewSpec, messageViewPoint, registerExtensionHook } from "@hheei/pi-ext-core";
import { expect, test, vi } from "vitest";
import { appendBashInfo, BASH_INFO_TYPE, registerBashInfo } from "../src/info.js";
import { toolHost } from "./fixtures/harness.js";

const theme = { fg: (_tone: string, text: string) => text };
const event = {
	id: "bash-demo-1",
	purpose: "pnpm test",
	status: "completed" as const,
	output: "done",
	truncated: false,
	exitCode: 0,
};

test("appends terminal and reminder entries with distinct kinds", () => {
	const appendEntry = vi.fn<ExtensionAPI["appendEntry"]>();
	appendBashInfo({ appendEntry }, event, "done");
	appendBashInfo(
		{ appendEntry },
		{
			kind: "idle",
			job: {
				...event,
				status: "running",
				logPath: "/tmp/job.log",
				command: "pnpm test",
				cwd: "/tmp",
				startedAt: 1,
				timedOut: false,
			},
		},
		"still running",
	);
	expect(appendEntry).toHaveBeenNthCalledWith(
		1,
		BASH_INFO_TYPE,
		expect.objectContaining({ id: event.id, kind: "terminal", status: "completed" }),
	);
	expect(appendEntry).toHaveBeenNthCalledWith(
		2,
		BASH_INFO_TYPE,
		expect.objectContaining({ id: event.id, kind: "idle", status: "running" }),
	);
});

test("uses MessageView when available and keeps fallback rows width-safe", async () => {
	const registerEntryRenderer = vi.fn<ExtensionAPI["registerEntryRenderer"]>();
	const pi = Object.assign(toolHost().pi, { registerEntryRenderer });
	registerBashInfo(pi);
	const specs: MessageViewSpec[] = [];
	const hook = registerExtensionHook(pi, messageViewPoint, (value) => {
		specs.push(value);
		return { render: () => ["view"], invalidate() {} };
	});
	const renderer = registerEntryRenderer.mock.calls[0]![1];
	const entry = {
		type: "custom" as const,
		id: "entry-1",
		parentId: null,
		timestamp: "2026-10-19T00:00:00.000Z",
		customType: BASH_INFO_TYPE,
		data: {
			id: event.id,
			status: "completed",
			kind: "terminal",
			message: "done\n\u001b[31mfull output\u001b[0m\u0007",
		},
	};
	expect(
		renderer(
			entry,
			{ expanded: true, keyText: () => "", keyHint: (_keybinding, description) => description },
			theme as Theme,
		)?.render(40),
	).toEqual(["view"]);
	expect(specs[0]?.header).toEqual({
		kind: "bg-bash",
		summary: "󰄴 bash-demo-1 · terminal · completed",
		tone: "success",
	});
	expect(specs[0]?.body).toBe("done\nfull output");
	await hook.dispose();
	const fallback = renderer(
		{ ...entry, id: "entry-2" },
		{ expanded: true, keyText: () => "", keyHint: (_keybinding, description) => description },
		theme as Theme,
	);
	expect(fallback?.render(80).join("\n")).toContain("full output");
	const collapsed = renderer(
		{ ...entry, id: "entry-3" },
		{ expanded: false, keyText: () => "", keyHint: (_keybinding, description) => description },
		theme as Theme,
	);
	expect(collapsed?.render(80).join("\n")).not.toContain("full output");
	for (const width of [20, 80])
		for (const row of fallback?.render(width) ?? [])
			expect(visibleWidth(row)).toBeLessThanOrEqual(width);
});
