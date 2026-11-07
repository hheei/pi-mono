import { describe, expect, test, vi } from "vitest";
import type { RegisteredTool } from "./fixtures/harness";
import {
	createKeybindings,
	createTheme,
	customUI,
	emitEvent,
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

	test("emits pi-ask-user:blocked active:true on prompt open and active:false on close", async () => {
		const tool = await setupTool();
		await answerFreeform(tool);

		const blockedEvents = emittedEvents.filter((event) => event.name === "pi-ask-user:blocked");
		expect(blockedEvents).toHaveLength(2);
		expect(blockedEvents[0]?.payload).toEqual({ active: true, question: "Why?" });
		expect(blockedEvents[1]?.payload).toEqual({ active: false });
	});

	test("resolves when pi-ask-user:answer event provides external response", async () => {
		const tool = await setupTool();
		const execution = tool.execute(
			"tool-call-id",
			{ question: "Choose one", options: ["A", "B"] },
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "tui",
				ui: {
					custom: customUI(async (factory: any) => {
						let finish: (() => void) | undefined;
						const pending = new Promise<void>((resolve) => {
							finish = resolve;
						});
						factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {
								finish?.();
							},
						);
						emitEvent("pi-ask-user:answer", {
							response: { kind: "selection", selections: ["B"] },
						});
						return pending;
					}),
				},
			},
		);

		const result = await execution;
		expect(result.details.response).toEqual({ kind: "selection", selections: ["B"] });
		expect(result.details.cancelled).toBe(false);
	});

	test("announces the open question with its options, then closes it", async () => {
		const tool = await setupTool();
		await tool.execute(
			"tool-call-id",
			{ question: "Pick", context: "ctx", options: ["A", "B"] },
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "tui",
				ui: { custom: customUI(async () => ({ kind: "selection", selections: ["A"] })) },
			},
		);

		const opened = emittedEvents.filter((event) => event.name === "pi-ask-user:question");
		expect(opened).toHaveLength(2);
		const payload = opened[0]?.payload as any;
		expect(payload.questions).toEqual([
			{
				index: 0,
				total: 1,
				question: "Pick",
				context: "ctx",
				options: [{ title: "A" }, { title: "B" }],
				allowMultiple: false,
				allowFreeform: true,
			},
		]);
		expect(opened[1]?.payload).toEqual({ questions: null });
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
