import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type MessageViewSpec, messageViewPoint, registerExtensionHook } from "@hheei/pi-ext-core";
import { expect, test } from "vitest";
import { createMemoryInfo, type MemoryInfoDetails, renderMemoryInfo } from "../src/info.js";

type Renderer = Parameters<ExtensionAPI["registerEntryRenderer"]>[1];
type Entry = Parameters<Renderer>[0];
type Theme = Parameters<Renderer>[2];

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

const page = (pageId: string, title: string, snippet: string) => ({
	pageId,
	page: title,
	snippet,
});

function host(): {
	readonly info: ReturnType<typeof createMemoryInfo>;
	readonly entries: Array<{ readonly type: string; readonly data: unknown }>;
	readonly renderer: Renderer;
	readonly pi: ExtensionAPI;
} {
	const entries: Array<{ readonly type: string; readonly data: unknown }> = [];
	let renderer: Renderer | undefined;
	const pi = {
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		registerEntryRenderer: (_type: string, value: Renderer) => {
			renderer = value;
		},
	} as unknown as ExtensionAPI;
	const info = createMemoryInfo(pi);
	if (renderer === undefined) throw new Error("memory entry renderer missing");
	return { info, entries, renderer, pi };
}

function entry(data: unknown): Entry {
	return { data } as Entry;
}

const injected: MemoryInfoDetails = {
	pages: [
		page("kp-1", "Conventions", "Paths resolve through the publish layer."),
		page("kp-2", "Decisions", "Auto-background promotion uses 60 seconds."),
	],
	truncated: false,
};

test("reports an injected memory as a resumable entry", () => {
	const { info, entries } = host();
	info("memory guide + recalled 1 page", {
		pages: [page("kp-1", "Conventions", "Paths resolve through the publish layer.")],
		truncated: false,
	});
	expect(entries).toEqual([
		{
			type: "memory-info",
			data: {
				summary: "memory guide + recalled 1 page",
				details: {
					pages: [
						{
							pageId: "kp-1",
							page: "Conventions",
							snippet: "Paths resolve through the publish layer.",
						},
					],
					truncated: false,
				},
			},
		},
	]);
});

test("shows the recalled page titles and expands to their ids and snippets", () => {
	const collapsed = renderMemoryInfo(
		{ summary: "recalled 2 pages", details: injected },
		false,
		theme,
	);
	expect(collapsed).toContain("<dim>info · memory · recalled 2 pages</dim>");
	expect(collapsed).toContain("<success>󰄴</success> <text>Conventions</text>");
	expect(collapsed).toContain("<text>Decisions</text>");
	expect(collapsed).not.toContain("kp-1");
	expect(collapsed).not.toContain("publish layer");

	const expanded = renderMemoryInfo(
		{ summary: "recalled 2 pages", details: injected },
		true,
		theme,
	);
	expect(expanded).toContain("<dim>kp-1</dim>");
	expect(expanded).toContain("    <muted>Paths resolve through the publish layer.</muted>");
	expect(expanded).toContain("    <muted>Auto-background promotion uses 60 seconds.</muted>");

	// A recalled markdown excerpt keeps one indented row per line.
	const multiLine = renderMemoryInfo(
		{
			summary: "recalled 1 page",
			details: { pages: [page("kp-3", "Notes", "# Head\n\nbody")], truncated: false },
		},
		true,
		theme,
	);
	expect(multiLine).toContain(
		"    <muted># Head</muted>\n    <muted></muted>\n    <muted>body</muted>",
	);
});

test("says when the injected memory was cut to its budget", () => {
	expect(
		renderMemoryInfo(
			{ summary: "recalled 1 page", details: { ...injected, truncated: true } },
			false,
			theme,
		),
	).toContain("<warning>󰀪 the injected memory was cut to its character budget</warning>");
	expect(
		renderMemoryInfo({ summary: "recalled 1 page", details: injected }, false, theme),
	).not.toContain("character budget");
});

test("renders the guide entry without pages and unknown payloads not at all", () => {
	const guide = renderMemoryInfo(
		{ summary: "memory guide", details: { pages: [], truncated: false } },
		true,
		theme,
	);
	expect(guide).toBe("<dim>info · memory · memory guide</dim>");

	// An entry from another extension's payload renders nothing rather than throwing.
	expect(renderMemoryInfo({ summary: 42 }, false, theme)).toBeUndefined();
	expect(renderMemoryInfo(undefined, false, theme)).toBeUndefined();
	// Recalled text is remote data: control sequences never reach the row.
	expect(
		renderMemoryInfo(
			{
				summary: "recalled 1 page",
				details: {
					pages: [page("kp-1", "\u001b[31mRed\u001b[0m", "\u001b[42mbody\u001b[0m")],
					truncated: false,
				},
			},
			true,
			theme,
		),
	).toContain("<text>Red</text>");
});

test("keeps rendering entries that predate the page payload", () => {
	const legacy = { summary: "recalled 1 page", details: ["kp-1 — Conventions"] };
	expect(renderMemoryInfo(legacy, false, theme)).toBe("<dim>info · memory · recalled 1 page</dim>");
	expect(renderMemoryInfo(legacy, true, theme)).toContain('"kp-1 — Conventions"');
});

test("renders a stored entry through the registered renderer", () => {
	const { info, entries, renderer } = host();
	info("recalled 1 page", {
		pages: [page("kp-1", "Conventions", "Paths resolve.")],
		truncated: false,
	});
	const rendered = renderer(
		entry(entries[0]?.data),
		{ expanded: true, keyText: () => "", keyHint: (_keybinding, description) => description },
		theme,
	)
		?.render(48)
		.join("\n");
	expect(rendered).toContain("kp-1");
	expect(rendered).toContain("Paths resolve.");
});

test("keeps every row inside the terminal width", () => {
	const { info, entries, renderer } = host();
	info("recalled 2 pages", {
		pages: [
			page(
				"kp-1",
				"A page title that is far too long to fit into a narrow terminal row",
				"word ".repeat(60),
			),
			page("kp-2", "Second", "line one\nline two"),
		],
		truncated: true,
	});
	const component = renderer(
		entry(entries[0]?.data),
		{ expanded: true, keyText: () => "", keyHint: (_keybinding, description) => description },
		theme,
	);
	for (const width of [40, 80]) {
		for (const row of component?.render(width) ?? [])
			expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	}
});

test("uses the optional message view when one is published", async () => {
	const { renderer, pi } = host();
	let spec: MessageViewSpec | undefined;
	const hook = registerExtensionHook(pi, messageViewPoint, (value) => {
		spec = value;
		return { render: () => ["view"], invalidate() {} };
	});
	const stored = entry({
		summary: "recalled 2 pages",
		details: { ...injected, truncated: true },
	});
	expect(
		renderer(
			stored,
			{ expanded: false, keyText: () => "", keyHint: (_keybinding, description) => description },
			theme,
		)
			?.render(40)
			.join("\n"),
	).toBe("view");
	expect(spec?.header).toEqual({ kind: "memory", summary: "recalled 2 pages" });
	expect(spec?.forcedExpanded).toBe(false);
	expect(spec?.stateHolder).toBe(stored);
	const preview = Array.isArray(spec?.preview) ? spec.preview.join("\n") : "";
	expect(preview).toContain("<text>Conventions</text>");
	expect(preview).toContain("character budget");
	expect(preview).not.toContain("kp-1");
	const body = Array.isArray(spec?.body) ? spec.body.join("\n") : "";
	expect(body).toContain("<dim>kp-1</dim>");
	expect(body).toContain("Paths resolve through the publish layer.");
	await hook.dispose();
});
