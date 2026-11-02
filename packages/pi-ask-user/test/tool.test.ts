import { describe, expect, test, vi } from "vitest";
import { customUI, isolateAgentDir, rejectedError, setupTool } from "./fixtures/harness";

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

	test("reports blocked program status while the custom prompt owns the surface", async () => {
		const tool = await setupTool();
		let blocked: unknown;

		await tool.execute(
			"tool-call-id",
			{ question: "Continue?", options: ["Yes"] },
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "tui",
				ui: {
					custom: customUI(async (_factory, options) => {
						blocked = options.blocked;
						return { kind: "selection", selections: ["Yes"] };
					}),
				},
			},
		);

		expect(blocked).toEqual({ kind: "question", message: "Waiting for user response" });
	});

	test("answers a freeform question through the host dialog", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{ question: "Why?", options: [] },
			undefined,
			undefined,
			{ hasUI: true, mode: "tui", ui: { input: async () => "Because" } },
		);

		expect(result.content).toEqual([{ type: "text", text: "User answered: Because" }]);
	});

	test("throws when structured UI rejects", async () => {
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

	test("cancels when freeform input is dismissed", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{ question: "Why?", options: [] },
			undefined,
			undefined,
			{ hasUI: true, mode: "tui", ui: { input: async () => undefined } },
		);

		expect(result.details.cancelled).toBe(true);
	});
});

describe("tool result rendering", () => {});
