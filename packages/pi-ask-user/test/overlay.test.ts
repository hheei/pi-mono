import { describe, expect, test, vi } from "vitest";
import { customUI, isolateAgentDir, setupTool } from "./fixtures/harness";

vi.mock("@earendil-works/pi-coding-agent", async () =>
	(await import("./fixtures/fake-host")).piCodingAgentModule(),
);
vi.mock("@earendil-works/pi-tui", async () => (await import("./fixtures/fake-host")).piTuiModule());
vi.mock("typebox", async () => (await import("./fixtures/fake-host")).typeboxModule());

isolateAgentDir();

describe("surface mode", () => {
	test("overlay mode asks the host for a centered popup", async () => {
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute("tool-call-id", { question: "Q", options: ["A"] }, undefined, undefined, {
			hasUI: true,
			mode: "tui",
			ui: {
				custom: customUI(async (_factory: any, options: any) => {
					capturedOptions = options;
					return null;
				}),
			},
		});

		expect(capturedOptions.overlay).toBe(true);
		expect(capturedOptions.overlayOptions).toMatchObject({ anchor: "center", maxHeight: "85%" });
	});

	test("inline mode asks the host for the editor dock", async () => {
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute(
			"tool-call-id",
			{ question: "Q", options: ["A"], displayMode: "inline" },
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

		expect(capturedOptions.overlay).toBeUndefined();
	});

	test("no terminal input listener is registered for the prompt", async () => {
		const tool = await setupTool();
		let registered = false;

		await tool.execute("tool-call-id", { question: "Q", options: ["A"] }, undefined, undefined, {
			hasUI: true,
			mode: "tui",
			ui: {
				custom: customUI(async () => null),
				onTerminalInput: () => {
					registered = true;
					return () => {};
				},
			},
		});

		expect(registered).toBe(false);
	});
});
