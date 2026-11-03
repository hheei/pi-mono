import { describe, expect, test, vi } from "vitest";
import { customUI, isolateAgentDir, setupTool } from "./fixtures/harness";

vi.mock("@earendil-works/pi-coding-agent", async () =>
	(await import("./fixtures/fake-host")).piCodingAgentModule(),
);
vi.mock("@earendil-works/pi-tui", async () => (await import("./fixtures/fake-host")).piTuiModule());
vi.mock("typebox", async () => (await import("./fixtures/fake-host")).typeboxModule());

isolateAgentDir();

describe("RPC fallback (custom() returns undefined)", () => {
	test("single-select falls back to ctx.ui.select()", async () => {
		const tool = await setupTool();
		let selectTitle = "";
		let selectOptions: string[] = [];

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Pick a color",
				options: ["Red", "Blue"],
				allowFreeform: false,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "rpc",
				ui: {
					custom: customUI(async () => undefined),
					select: async (title: string, opts: string[]) => {
						selectTitle = title;
						selectOptions = opts;
						return "Blue";
					},
					input: async () => undefined,
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({ kind: "selection", selections: ["Blue"] });
		expect(result.details.cancelled).toBe(false);
		expect(selectTitle).toContain("Pick a color");
		expect(selectOptions).toEqual(["Red", "Blue"]);
	});

	test("single-select with freeform appends sentinel option", async () => {
		const tool = await setupTool();
		let selectOptions: string[] = [];

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Pick a color",
				options: ["Red", "Blue"],
				allowFreeform: true,
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
						return "Red";
					},
					input: async () => undefined,
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({ kind: "selection", selections: ["Red"] });
		// Last option should be the freeform sentinel
		expect(selectOptions).toHaveLength(3);
		expect(selectOptions[2]).toContain("Type custom response");
	});

	test("selecting freeform sentinel follows up with input()", async () => {
		const tool = await setupTool();
		let inputCalled = false;
		const sentinel = "\u270f\ufe0f Type custom response...";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Pick a color",
				options: ["Red", "Blue"],
				allowFreeform: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "rpc",
				ui: {
					custom: customUI(async () => undefined),
					select: async () => sentinel,
					input: async () => {
						inputCalled = true;
						return "Purple";
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(inputCalled).toBe(true);
		expect(result.details.response).toEqual({ kind: "freeform", text: "Purple" });
	});

	test("multi-select degrades to input() with options in prompt", async () => {
		const tool = await setupTool();
		let inputTitle = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Pick colors",
				options: ["Red", "Blue", "Green"],
				allowMultiple: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "rpc",
				ui: {
					custom: customUI(async () => undefined),
					select: async () => undefined,
					input: async (title: string) => {
						inputTitle = title;
						return "Red, Green";
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({ kind: "selection", selections: ["Red", "Green"] });
		// Prompt should list the options for the user
		expect(inputTitle).toContain("1. Red");
		expect(inputTitle).toContain("2. Blue");
		expect(inputTitle).toContain("3. Green");
	});

	test("returns cancelled when select() returns undefined", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Pick a color",
				options: ["Red", "Blue"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "rpc",
				ui: {
					custom: customUI(async () => undefined),
					select: async () => undefined,
					input: async () => undefined,
				},
			},
		);

		expect(result.details.cancelled).toBe(true);
		expect(result.details.response).toBeNull();
	});

	test("passes context into the dialog prompt", async () => {
		const tool = await setupTool();
		let selectTitle = "";

		await tool.execute(
			"tool-call-id",
			{
				question: "Pick a color",
				context: "The sky is blue today.",
				options: ["Red", "Blue"],
				allowFreeform: false,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "rpc",
				ui: {
					custom: async () => undefined,
					select: async (title: string) => {
						selectTitle = title;
						return "Blue";
					},
					input: async () => undefined,
				},
			},
		);

		expect(selectTitle).toContain("Pick a color");
		expect(selectTitle).toContain("The sky is blue today.");
	});

	test("passes timeout to dialog methods", async () => {
		const tool = await setupTool();
		let capturedOpts: any;

		await tool.execute(
			"tool-call-id",
			{
				question: "Pick a color",
				options: ["Red", "Blue"],
				allowFreeform: false,
				timeout_ms: 5000,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "rpc",
				ui: {
					custom: customUI(async () => undefined),
					select: async (_title: string, _opts: string[], opts: any) => {
						capturedOpts = opts;
						return "Red";
					},
					input: async () => undefined,
				},
			},
		);

		// The dialog gets what the deadline has left, which a slow runner shaves by a millisecond.
		expect(capturedOpts.timeout).toBeGreaterThan(0);
		expect(capturedOpts.timeout).toBeLessThanOrEqual(5000);
		expect(capturedOpts.signal).toBeInstanceOf(AbortSignal);
	});
});
