import { describe, expect, test, vi } from "vitest";
import type { RegisteredTool } from "./fixtures/harness";
import {
	createKeybindings,
	createTheme,
	customUI,
	emittedEvents,
	isolateAgentDir,
	setupTool,
} from "./fixtures/harness";

vi.mock("@earendil-works/pi-coding-agent", async () =>
	(await import("./fixtures/fake-host")).piCodingAgentModule(),
);
vi.mock("@earendil-works/pi-tui", async () => (await import("./fixtures/fake-host")).piTuiModule());
vi.mock("typebox", async () => (await import("./fixtures/fake-host")).typeboxModule());

isolateAgentDir();

describe("issue #51 event payload redaction", () => {
	const answerFreeform = (tool: RegisteredTool) =>
		tool.execute(
			"tool-call-id",
			{ question: "Why?", context: "secret context", options: [] },
			undefined,
			undefined,
			{ hasUI: true, mode: "tui", ui: { input: async () => "my private answer" } },
		);
	const cancelStructured = (tool: RegisteredTool) =>
		tool.execute(
			"tool-call-id",
			{ question: "Pick", context: "secret context", options: ["A", "B"] },
			undefined,
			undefined,
			{ hasUI: true, mode: "tui", ui: { custom: customUI(async () => null) } },
		);

	test("ask:answered carries only the question and response kind by default", async () => {
		const tool = await setupTool();
		const result = await answerFreeform(tool);

		expect(result.details.response).toEqual({ kind: "freeform", text: "my private answer" });
		expect(emittedEvents.filter((event) => event.name === "ask:answered")).toEqual([
			{ name: "ask:answered", payload: { question: "Why?", response: { kind: "freeform" } } },
		]);
	});

	test("ask:cancelled carries only the question by default", async () => {
		const tool = await setupTool();
		const result = await cancelStructured(tool);

		expect(result.details.cancelled).toBe(true);
		expect(emittedEvents.filter((event) => event.name === "ask:cancelled")).toEqual([
			{ name: "ask:cancelled", payload: { question: "Pick" } },
		]);
	});
});

test("opens the prompt as an inline custom surface", async () => {
	const tool = await setupTool();
	let capturedOptions: any;

	const result = await tool.execute(
		"tool-call-id",
		{
			question: "Which option should we use?",
			options: ["A", "B"],
		},
		undefined,
		undefined,
		{
			hasUI: true,
			mode: "tui",
			ui: {
				custom: customUI(async (_factory: any, options: any) => {
					capturedOptions = options;
					return null;
				}),
			},
		},
	);

	expect(capturedOptions?.overlay).toBeUndefined();
	expect(result.details.cancelled).toBe(true);
});

test("resolves with the user's selection", async () => {
	const tool = await setupTool();

	const result = await tool.execute(
		"tool-call-id",
		{
			question: "Which option should we use?",
			options: ["A", "B"],
		},
		undefined,
		undefined,
		{
			hasUI: true,
			mode: "tui",
			ui: {
				custom: customUI(async (factory: any) => {
					const component = factory(
						{ requestRender() {}, terminal: { rows: 24 } },
						createTheme(),
						createKeybindings(),
						() => {},
					);
					component.handleInput("enter");
					return { kind: "selection", selections: ["A"] };
				}),
			},
		},
	);

	expect(result.details.cancelled).toBe(false);
	expect(result.details.response).toEqual({ kind: "selection", selections: ["A"] });
});

test("still respects timeout cancellation", async () => {
	const tool = await setupTool();

	const result = await tool.execute(
		"tool-call-id",
		{
			question: "Which option should we use?",
			options: ["A", "B"],
			timeout_ms: 5,
		},
		undefined,
		undefined,
		{
			hasUI: true,
			mode: "tui",
			ui: {
				custom: customUI(async (factory: any) => {
					factory(
						{ requestRender() {}, terminal: { rows: 24 } },
						createTheme(),
						createKeybindings(),
						() => {},
					);
					return new Promise(() => {});
				}),
			},
		},
	);

	expect(result.details.cancelled).toBe(true);
	expect(result.details.response).toBeNull();
});
