import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import {
	hasOptionalToolRenderers,
	registerExtensionHook,
	type ToolPresentationContext,
	textToolResult,
	toolRendererPoint,
} from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import {
	createFetchContentPresentation,
	createGetSearchContentPresentation,
	createSourceCheckPresentation,
	createWebSearchPresentation,
	createWebToolRenderers,
} from "../src/presentation.ts";

const plainTheme = {
	bg: (_role: string, text: string): string => text,
	fg: (_role: string, text: string): string => text,
	bold: (text: string): string => text,
} as Theme;

const plainContext = {
	args: {},
	isError: false,
	isPartial: false,
	keyText: () => "ctrl+o",
} as unknown as ToolPresentationContext;

describe("Web search presentation", () => {
	test("formats call presentation for single and multi-query", () => {
		const single = createWebSearchPresentation(
			{ query: "vitest mock" },
			undefined,
			plainTheme,
			plainContext,
		);
		expect(single.summary).toBe('"vitest mock"');
		expect(single.request).toBeUndefined();

		const multi = createWebSearchPresentation(
			{ queries: ["vitest mock", "vitest spy"], recencyFilter: "week", provider: "brave" },
			undefined,
			plainTheme,
			plainContext,
		);
		expect(multi.summary).toBe('"vitest mock" (+1 queries) · past week · brave');
		expect(multi.request).toBe('1. "vitest mock"\n2. "vitest spy"');
	});

	test("formats result presentation on success and error", () => {
		const successResult = textToolResult("1. Vitest docs https://vitest.dev", {
			queryCount: 2,
			successfulQueries: 2,
			totalResults: 10,
		});
		const pres = createWebSearchPresentation(
			{ query: "vitest" },
			successResult,
			plainTheme,
			plainContext,
		);
		expect(pres.status).toBe("ok");
		expect(pres.summary).toBe("2/2 queries · 10 results");
		expect(pres.output).toBe("1. Vitest docs https://vitest.dev");

		const errorResult = textToolResult("Error: rate limited", {
			error: "rate limited",
		});
		const errPres = createWebSearchPresentation({ query: "vitest" }, errorResult, plainTheme, {
			...plainContext,
			isError: true,
		});
		expect(errPres.status).toBe("error");
		expect(errPres.summary).toBe("rate limited");
	});

	test("leaves status undefined while streaming partial results", () => {
		const partialResult = textToolResult("1. Vitest docs", {
			queryCount: 1,
			successfulQueries: 1,
			totalResults: 1,
		});
		const pres = createWebSearchPresentation({ query: "vitest" }, partialResult, plainTheme, {
			...plainContext,
			isPartial: true,
		});
		expect(pres.status).toBeUndefined();
	});
});

describe("Fetch content presentation", () => {
	test("formats single and multi-url fetch calls", () => {
		const single = createFetchContentPresentation(
			{ url: "https://example.com", mode: "raw" },
			undefined,
			plainTheme,
			plainContext,
		);
		expect(single.summary).toBe("https://example.com · raw");

		const multi = createFetchContentPresentation(
			{ urls: ["https://a.com", "https://b.com"] },
			undefined,
			plainTheme,
			plainContext,
		);
		expect(multi.summary).toBe("https://a.com (+1 URLs)");
		expect(multi.request).toBe("1. https://a.com\n2. https://b.com");
	});

	test("formats single page and multi-url result", () => {
		const singleRes = textToolResult("Hello world", {
			urlCount: 1,
			title: "Example Domain",
			totalChars: 1200,
		});
		const singlePres = createFetchContentPresentation(
			{ url: "https://example.com" },
			singleRes,
			plainTheme,
			plainContext,
		);
		expect(singlePres.status).toBe("ok");
		expect(singlePres.summary).toBe("Example Domain (1200 chars)");

		const multiRes = textToolResult("Batch results", {
			urlCount: 3,
			successful: 2,
		});
		const multiPres = createFetchContentPresentation(
			{ urls: ["a", "b", "c"] },
			multiRes,
			plainTheme,
			plainContext,
		);
		expect(multiPres.status).toBe("ok");
		expect(multiPres.summary).toBe("2/3 URLs");
	});
});

describe("Get search content presentation", () => {
	test("formats query and findText calls and results", () => {
		const call = createGetSearchContentPresentation(
			{ responseId: "resp-123456", findText: "API key", offset: 100 },
			undefined,
			plainTheme,
			plainContext,
		);
		expect(call.summary).toBe('find "API key" @ 100');

		const res = textToolResult("matches here", {
			matchCount: 5,
			returnedMatches: 3,
		});
		const pres = createGetSearchContentPresentation(
			{ responseId: "resp-123456" },
			res,
			plainTheme,
			plainContext,
		);
		expect(pres.status).toBe("ok");
		expect(pres.summary).toBe("5 matches (3 shown)");
	});
});

describe("Source check presentation", () => {
	test("formats claim call and citations result", () => {
		const call = createSourceCheckPresentation(
			{ claim: "Pi is an AI coding agent harness" },
			undefined,
			plainTheme,
			plainContext,
		);
		expect(call.summary).toBe('"Pi is an AI coding agent harness"');
		expect(call.request).toBe("claim: Pi is an AI coding agent harness");

		const res = textToolResult("Verified", {
			artifact: {
				citations: ["c1", "c2"],
				sources: ["s1"],
			},
		});
		const pres = createSourceCheckPresentation(
			{ claim: "Pi is an AI coding agent harness" },
			res,
			plainTheme,
			plainContext,
		);
		expect(pres.status).toBe("ok");
		expect(pres.summary).toBe("2 citations · 1 sources");
	});
});

describe("createWebToolRenderers integration", () => {
	test("registers optional renderers with fallback Text rendering", () => {
		const fakePi = {
			events: {},
			on: () => () => {},
		} as unknown as ExtensionAPI;

		const renderers = createWebToolRenderers(fakePi, "web_search", createWebSearchPresentation);

		expect(hasOptionalToolRenderers(renderers)).toBe(true);

		const callComponent = renderers.renderCall!({ query: "TypeScript" }, plainTheme, plainContext);
		expect(stripTerminalSequences(callComponent.render(80).join("\n"))).toContain(
			'web_search "TypeScript"',
		);

		const resultComponent = renderers.renderResult!(
			textToolResult("Found 5 items", { queryCount: 1, totalResults: 5 }),
			{ expanded: false, isPartial: false },
			plainTheme,
			{ ...plainContext, args: { query: "TypeScript" } },
		);
		expect(stripTerminalSequences(resultComponent.render(80).join("\n")).trim()).toBe(
			"Found 5 items",
		);
	});

	test("decorates with UI hook when toolRendererPoint is registered", () => {
		const fakePi = {
			events: {},
			on: () => () => {},
		} as unknown as ExtensionAPI;

		let decorated = false;
		const hook = registerExtensionHook(fakePi, toolRendererPoint, (name, native) => {
			decorated = true;
			return {
				renderCall: () => new Text(`decorated-${name}`, 0, 0),
				renderResult: native.renderResult ?? (() => new Text("", 0, 0)),
			};
		});

		try {
			const renderers = createWebToolRenderers(fakePi, "web_search", createWebSearchPresentation);
			const call = renderers.renderCall!({ query: "test" }, plainTheme, plainContext);
			expect(decorated).toBe(true);
			expect(stripTerminalSequences(call.render(80).join("\n")).trim()).toBe(
				"decorated-web_search",
			);
		} finally {
			void hook.dispose();
		}
	});
});
