import type { ExtensionAPI, Theme, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { createOptionalToolRenderers } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import {
	NestedCallsView,
	registerCollapsibleToolRenderer,
	type ToolRenderContext,
} from "../src/index.js";
import { ToolUiRuntime } from "../src/runtime.js";

/** The state this test's runtime owns; the extension builds the same one per Pi runtime. */
const runtime = new ToolUiRuntime();

import { NESTED_CALLS_EXPANDED_KEY } from "../src/nested-calls-view.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	style: (text: string) => text,
} as unknown as Theme;

function context(overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
	return {
		args: {},
		toolCallId: "parent",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/repo",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 0,
		keyText: () => "",
		keyHint: (_keybinding, description) => description,
		...overrides,
	};
}

const throwing = () => {
	throw new Error("child renderer failed");
};

describe("renderer errors propagate to the caller", () => {
	test("a nested child renderer failure is not replaced with raw output", () => {
		const view = new NestedCallsView({
			calls: [
				{
					id: "parent/1",
					toolName: "bash",
					args: { command: "ls" },
					result: { content: [{ type: "text", text: "RAW_CHILD_OUTPUT" }], details: {} },
				},
			],
			theme,
			context: context(),
			stateHolder: { [NESTED_CALLS_EXPANDED_KEY]: [0] },
			resolveChildRenderer: () => ({ renderResult: throwing }),
		});
		expect(() => view.render(60)).toThrow("child renderer failed");
	});

	test("a native renderer failure is not replaced with raw output", () => {
		let resolver: ToolRendererResolver | undefined;
		const pi = {
			events: {},
			on: () => () => {},
			registerToolRenderer: (value: ToolRendererResolver) => {
				resolver = value;
			},
		} as unknown as ExtensionAPI;
		createOptionalToolRenderers(pi, "bash", { renderResult: throwing });
		registerCollapsibleToolRenderer(pi, runtime);
		if (resolver === undefined) throw new Error("UI not registered");
		const renderers = resolver("bash", () => undefined);
		if (renderers?.renderResult === undefined) throw new Error("no renderResult");
		const result = { content: [{ type: "text" as const, text: "RAW_OUTPUT" }], details: {} };
		const view = renderers.renderResult(
			result,
			{ expanded: true, isPartial: false },
			theme,
			context(),
		);
		expect(() => view.render(60)).toThrow("child renderer failed");
	});
});
