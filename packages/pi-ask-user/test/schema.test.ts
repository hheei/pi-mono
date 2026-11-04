import { describe, expect, test, vi } from "vitest";
import { normalizeLineTerminators, prepareAskArguments } from "../src/schema";
import { customUI, isolateAgentDir, rejectedError, setupTool } from "./fixtures/harness";

vi.mock("@earendil-works/pi-coding-agent", async () =>
	(await import("./fixtures/fake-host")).piCodingAgentModule(),
);
vi.mock("@earendil-works/pi-tui", async () => (await import("./fixtures/fake-host")).piTuiModule());
vi.mock("typebox", async () => (await import("./fixtures/fake-host")).typeboxModule());

isolateAgentDir();

describe("issue #22 option normalization", () => {
	test("salvages common option title aliases when schema proxies mangle the shape", async () => {
		const tool = await setupTool();
		let selectOptions: string[] = [];

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Pick one",
				options: [{ label: "A" }, { text: "B" }, { value: "C" }, { name: "D" }, { option: "E" }],
				allowFreeform: false,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "rpc",
				ui: {
					custom: customUI(async () => undefined),
					select: async (_title: string, opts: string[]) => {
						selectOptions = opts;
						return "C";
					},
					input: async () => undefined,
				},
			},
		);

		expect(selectOptions).toEqual(["A", "B", "C", "D", "E"]);
		expect(result.details.response).toEqual({ kind: "selection", selections: ["C"] });
		expect(result.details.options.map((option: { title: string }) => option.title)).toEqual([
			"A",
			"B",
			"C",
			"D",
			"E",
		]);
	});

	test("filters blank labels, coerces primitive options, and keeps only non-blank descriptions", async () => {
		const tool = await setupTool();
		let selectOptions: string[] = [];

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Pick one",
				options: [
					"  ",
					"",
					42,
					true,
					"Real",
					{ title: "A", description: "  " },
					{ label: "B", description: "why" },
				],
				allowFreeform: false,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "rpc",
				ui: {
					custom: customUI(async () => undefined),
					select: async (_title: string, opts: string[]) => {
						selectOptions = opts;
						return "B";
					},
					input: async () => undefined,
				},
			},
		);

		expect(selectOptions).toEqual(["42", "true", "Real", "A", "B"]);
		expect(result.details.options).toEqual([
			{ title: "42" },
			{ title: "true" },
			{ title: "Real" },
			{ title: "A" },
			{ title: "B", description: "why" },
		]);
	});

	test("throws instead of opening UI when every supplied option is malformed", async () => {
		const tool = await setupTool();
		let calls = 0;

		const error = await rejectedError(
			tool.execute(
				"tool-call-id",
				{
					question: "Pick one",
					options: [{}, { foo: "x" }, "   "],
				},
				undefined,
				undefined,
				{
					hasUI: true,
					mode: "tui",
					ui: {
						custom: customUI(async () => {
							calls += 1;
							return undefined;
						}),
						select: async () => {
							calls += 1;
							return undefined;
						},
						input: async () => {
							calls += 1;
							return undefined;
						},
					},
				},
			),
		);

		expect(error.message).toContain("option(s) were malformed");
		expect(error.message).toContain('{ "title": "Short label", "description": "Optional detail" }');
		expect(calls).toBe(0);
	});

	test("un-double-encodes stringified JSON parameters", () => {
		const raw = {
			question: "Which database?",
			options: '[{"title": "Postgres"}, {"title": "SQLite"}]',
			questions: '[{"question": "Q1?"}]',
		};
		const prepared = prepareAskArguments(raw) as any;
		expect(Array.isArray(prepared.options)).toBe(true);
		expect(prepared.options).toEqual([{ title: "Postgres" }, { title: "SQLite" }]);
		expect(Array.isArray(prepared.questions)).toBe(true);
	});

	test("normalizes lone carriage returns and CRLF line terminators", () => {
		expect(normalizeLineTerminators("hello\r\nworld")).toBe("hello\nworld");
		expect(normalizeLineTerminators("hello\rworld")).toBe("helloworld");
	});

	test("rejects reserved option titles like Other, Next, Type something.", async () => {
		const tool = await setupTool();
		const error = await rejectedError(
			tool.execute(
				"tool-call-id",
				{ question: "Pick", options: ["A", "Other"] },
				undefined,
				undefined,
				{ hasUI: true, mode: "tui", ui: {} } as any,
			),
		);
		expect(error.message).toContain('Option title "Other" is reserved');
	});

	test("rejects duplicate option titles within the same question", async () => {
		const tool = await setupTool();
		const error = await rejectedError(
			tool.execute(
				"tool-call-id",
				{ question: "Pick", options: ["Option A", "option a"] },
				undefined,
				undefined,
				{ hasUI: true, mode: "tui", ui: {} } as any,
			),
		);
		expect(error.message).toContain('Option title "option a" is duplicated');
	});
});
