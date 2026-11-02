import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
	createOptionalToolRenderers,
	createToolPresentationRenderers,
	getRegisteredToolPresentationProvider,
	getToolPresentationProvider,
	hasOptionalToolRenderers,
	registerExtensionHook,
	textToolResult,
	toolRendererPoint,
} from "../src/index.js";
import { createFakePiHost } from "./fixtures.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

type Context = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

function context(overrides: Partial<Context> = {}): Context {
	return {
		args: { path: "src/app.ts" },
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
		durationMs: 12,
		outputPad: 0,
		keyText: () => "",
		keyHint: (_keybinding, description) => description,
		...overrides,
	};
}

const result = textToolResult("payload line", undefined);

/** Pi writes one array element per terminal row; padding is not content. */
const rows = (component: { render(width: number): string[] }): string[] =>
	component.render(80).map((line) => line.trimEnd());

describe("optional tool renderers", () => {
	test("native renderers serve both phases while no UI hook is registered", () => {
		const host = createFakePiHost();
		const native = createToolPresentationRenderers(host.pi, "probe", () => ({
			summary: "native summary",
			output: "native output",
		}));
		const wrapped = createOptionalToolRenderers(host.pi, "probe", native);

		expect(wrapped.renderShell).toBe("self");
		expect(wrapped.renderCall).not.toBe(native.renderCall);
		expect(rows(wrapped.renderCall!({}, theme, context())).join("\n")).toContain(
			"probe native summary",
		);
		expect(
			rows(
				wrapped.renderResult!(result, { expanded: false, isPartial: false }, theme, context()),
			).join("\n"),
		).toContain("native output");
	});

	test("a native renderer set without a call renderer still names the tool", () => {
		const host = createFakePiHost();
		const wrapped = createOptionalToolRenderers(host.pi, "result_only", {
			renderResult: () => new Text("own result", 0, 0),
		});
		expect(rows(wrapped.renderCall!({}, theme, context())).join("\n")).toContain("result_only");
		expect(
			rows(
				wrapped.renderResult!(result, { expanded: false, isPartial: false }, theme, context()),
			).join("\n"),
		).toBe("own result");
	});

	test("a late UI hook owns the next render and disposal returns to the native renderers", async () => {
		const host = createFakePiHost();
		const native = createToolPresentationRenderers(host.pi, "probe", () => ({
			summary: "native summary",
			output: "native output",
		}));
		const wrapped = createOptionalToolRenderers(host.pi, "probe", native);
		const seen: ToolRenderers[] = [];

		const first = rows(wrapped.renderCall!({}, theme, context())).join("\n");
		expect(first).toContain("native summary");

		const hook = registerExtensionHook(host.pi, toolRendererPoint, (_name, received) => {
			seen.push(received);
			return {
				renderCall: () => new Text("ui call", 0, 0),
				renderResult: () => new Text("ui result", 0, 0),
			};
		});
		await hook.ready;

		expect(rows(wrapped.renderCall!({}, theme, context())).join("\n")).toBe("ui call");
		expect(
			rows(
				wrapped.renderResult!(result, { expanded: false, isPartial: false }, theme, context()),
			).join("\n"),
		).toBe("ui result");
		expect(seen.length).toBe(2);
		expect(seen.every((received) => received === native)).toBe(true);

		await hook.dispose();
		expect(rows(wrapped.renderCall!({}, theme, context())).join("\n")).toContain("native summary");
	});

	test("a UI hook that omits one phase keeps the native renderer for it", async () => {
		const host = createFakePiHost();
		const native = createToolPresentationRenderers(host.pi, "probe", () => ({
			summary: "native summary",
			output: "native output",
		}));
		const wrapped = createOptionalToolRenderers(host.pi, "probe", native);
		const hook = registerExtensionHook(host.pi, toolRendererPoint, () => ({
			renderCall: () => new Text("ui call", 0, 0),
		}));
		await hook.ready;

		expect(rows(wrapped.renderCall!({}, theme, context())).join("\n")).toBe("ui call");
		expect(
			rows(
				wrapped.renderResult!(result, { expanded: false, isPartial: false }, theme, context()),
			).join("\n"),
		).toContain("native output");
		await hook.dispose();
	});

	test("hooks stay scoped to the runtime that registered them", async () => {
		const first = createFakePiHost();
		const second = createFakePiHost();
		const native = createToolPresentationRenderers(first.pi, "probe", () => ({
			summary: "native",
		}));
		const wrappedFirst = createOptionalToolRenderers(first.pi, "probe", native);
		const wrappedSecond = createOptionalToolRenderers(
			second.pi,
			"probe",
			createToolPresentationRenderers(second.pi, "probe", () => ({ summary: "other runtime" })),
		);
		const hook = registerExtensionHook(first.pi, toolRendererPoint, () => ({
			renderCall: () => new Text("ui call", 0, 0),
		}));
		await hook.ready;

		expect(rows(wrappedFirst.renderCall!({}, theme, context())).join("\n")).toBe("ui call");
		expect(rows(wrappedSecond.renderCall!({}, theme, context())).join("\n")).toContain(
			"other runtime",
		);
		await hook.dispose();
	});

	test("a native renderer set without a result renderer still reports the model text", () => {
		const host = createFakePiHost();
		const wrapped = createOptionalToolRenderers(host.pi, "call_only", {
			renderCall: () => new Text("own call", 0, 0),
		});
		const rendered = rows(
			wrapped.renderResult!(
				textToolResult("first line\nsecond line", undefined),
				{ expanded: false, isPartial: false },
				theme,
				context(),
			),
		);
		expect(rendered).toContain("first line");
		expect(rendered).toContain("second line");
		expect(rendered.join("")).not.toContain("\u001b");
	});

	test("a rejected result keeps its own text through the fallback", () => {
		const host = createFakePiHost();
		const wrapped = createOptionalToolRenderers(host.pi, "call_only", {
			renderCall: () => new Text("own call", 0, 0),
		});
		const rendered = rows(
			wrapped.renderResult!(
				{ ...textToolResult("Permission denied", undefined), isError: true },
				{ expanded: false, isPartial: false },
				theme,
				context({ isError: true }),
			),
		).join("");
		expect(rendered).toBe("Permission denied");
	});

	test("two API facades over one host event bus share the registered hook", async () => {
		const events = { emit: () => true, on: () => undefined };
		const first = { events } as unknown as Parameters<typeof createOptionalToolRenderers>[0];
		const second = { events } as unknown as Parameters<typeof createOptionalToolRenderers>[0];
		const native = createToolPresentationRenderers(first, "probe", () => ({ summary: "native" }));
		const wrapped = createOptionalToolRenderers(second, "probe", native);
		const hook = registerExtensionHook(first, toolRendererPoint, () => ({
			renderCall: () => new Text("ui call", 0, 0),
		}));
		await hook.ready;

		expect(rows(wrapped.renderCall!({}, theme, context())).join("\n")).toBe("ui call");
		await hook.dispose();
		expect(rows(wrapped.renderCall!({}, theme, context())).join("\n")).toContain("native");
	});

	test("wrapping a full tool definition exposes only renderers, never its schema or execute", () => {
		const host = createFakePiHost();
		const definition = {
			name: "full",
			label: "full",
			description: "original description",
			parameters: { type: "object" },
			annotations: { readOnlyHint: true },
			execute: () => undefined,
			renderResult: () => new Text("own result", 0, 0),
		};
		const wrapped = createOptionalToolRenderers(
			host.pi,
			"full",
			definition as unknown as ToolRenderers,
		);
		// A caller spreads this over its own definition, so any leaked field would replace its schema.
		expect(Object.keys(wrapped).sort()).toEqual(["renderCall", "renderResult", "renderShell"]);
		expect(wrapped).not.toHaveProperty("parameters");
		expect(wrapped).not.toHaveProperty("execute");
		expect(wrapped).not.toHaveProperty("description");
	});

	test("wrapping preserves the tool presentation metadata of the native renderers", () => {
		const host = createFakePiHost();
		const provider = () => ({ summary: "owner summary" });
		const native = createToolPresentationRenderers(host.pi, "probe", provider);
		const wrapped = createOptionalToolRenderers(host.pi, "probe", native);

		expect(getToolPresentationProvider(native)).toBe(provider);
		expect(getToolPresentationProvider(wrapped)).toBe(provider);
		expect(getRegisteredToolPresentationProvider(host.pi, "probe")).toBe(provider);
		expect(hasOptionalToolRenderers(wrapped)).toBe(true);
		expect(hasOptionalToolRenderers(native)).toBe(false);
		expect(hasOptionalToolRenderers(undefined)).toBe(false);
	});

	test("wrapped renderers stay cell-width safe at narrow and wide terminals", () => {
		const host = createFakePiHost();
		const native = createToolPresentationRenderers(host.pi, "probe", () => ({
			summary: "summary 你好",
			request: "inspect ".repeat(20),
			output: "path: /sessions/child.jsonl",
		}));
		const wrapped = createOptionalToolRenderers(host.pi, "probe", native);
		for (const width of [12, 24, 100]) {
			for (const line of [
				...wrapped.renderCall!({}, theme, context()).render(width),
				...wrapped.renderResult!(
					result,
					{ expanded: false, isPartial: false },
					theme,
					context(),
				).render(width),
			]) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});
