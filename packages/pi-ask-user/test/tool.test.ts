import { describe, expect, test, vi } from "vitest";
import {
	customUI,
	emittedEvents,
	isolateAgentDir,
	rejectedError,
	setupTool,
} from "./fixtures/harness";

vi.mock("@earendil-works/pi-coding-agent", async () =>
	(await import("./fixtures/fake-host")).piCodingAgentModule(),
);
vi.mock("@earendil-works/pi-tui", async () => (await import("./fixtures/fake-host")).piTuiModule());
vi.mock("typebox", async () => (await import("./fixtures/fake-host")).typeboxModule());

isolateAgentDir();

describe("ask_user", () => {
	test("registers with executionMode 'sequential' so the agent loop awaits the user's answer before other tool calls run", async () => {
		const tool = await setupTool();
		expect(tool.executionMode).toBe("sequential");
	});

	test("emits Herdr blocked lifecycle while awaiting a structured answer", async () => {
		const tool = await setupTool();

		await tool.execute(
			"tool-call-id",
			{ question: "Continue?", options: ["Yes"] },
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "tui",
				ui: { custom: customUI(async () => ({ kind: "selection", selections: ["Yes"] })) },
			},
		);

		expect(emittedEvents.filter((event) => event.name === "herdr:blocked")).toEqual([
			{ name: "herdr:blocked", payload: { active: true, label: "Waiting for user response" } },
			{ name: "herdr:blocked", payload: { active: false } },
		]);
	});

	test("emits Herdr blocked lifecycle while awaiting a freeform answer", async () => {
		const tool = await setupTool();

		await tool.execute("tool-call-id", { question: "Why?", options: [] }, undefined, undefined, {
			hasUI: true,
			mode: "tui",
			ui: { input: async () => "Because" },
		});

		expect(emittedEvents.filter((event) => event.name === "herdr:blocked")).toEqual([
			{ name: "herdr:blocked", payload: { active: true, label: "Waiting for user response" } },
			{ name: "herdr:blocked", payload: { active: false } },
		]);
	});

	test("throws and clears Herdr blocked lifecycle when structured UI rejects", async () => {
		const tool = await setupTool();

		const error = await rejectedError(
			tool.execute(
				"tool-call-id",
				{ question: "Continue?", options: ["Yes"] },
				undefined,
				undefined,
				{
					hasUI: true,
					mode: "tui",
					ui: {
						custom: customUI(async () => {
							throw new Error("UI failed");
						}),
					},
				},
			),
		);

		expect(error.message).toBe("UI failed");
		expect(emittedEvents.filter((event) => event.name === "herdr:blocked")).toEqual([
			{ name: "herdr:blocked", payload: { active: true, label: "Waiting for user response" } },
			{ name: "herdr:blocked", payload: { active: false } },
		]);
	});

	test("throws when interactive UI is unavailable", async () => {
		const tool = await setupTool();

		const error = await rejectedError(
			tool.execute(
				"tool-call-id",
				{ question: "Continue?", options: ["Yes", "No"] },
				undefined,
				undefined,
				{ hasUI: false },
			),
		);

		expect(error.message).toContain("Ask requires interactive mode");
		expect(error.message).toContain("Continue?");
		expect(error.message).toContain("1. Yes");
		expect(error.message).toContain("2. No");
	});

	test("clears Herdr blocked lifecycle when freeform input is cancelled", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{ question: "Why?", options: [] },
			undefined,
			undefined,
			{ hasUI: true, mode: "tui", ui: { input: async () => undefined } },
		);

		expect(result.details.cancelled).toBe(true);
		expect(emittedEvents.filter((event) => event.name === "herdr:blocked")).toEqual([
			{ name: "herdr:blocked", payload: { active: true, label: "Waiting for user response" } },
			{ name: "herdr:blocked", payload: { active: false } },
		]);
	});
});

describe("tool result rendering", () => {});
