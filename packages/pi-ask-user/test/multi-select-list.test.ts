import { describe, expect, test, vi } from "vitest";
import {
	createKeybindings,
	createTheme,
	customUI,
	isolateAgentDir,
	setupTool,
} from "./fixtures/harness";

vi.mock("@earendil-works/pi-coding-agent", async () =>
	(await import("./fixtures/fake-host")).piCodingAgentModule(),
);
vi.mock("@earendil-works/pi-tui", async () => (await import("./fixtures/fake-host")).piTuiModule());
vi.mock("typebox", async () => (await import("./fixtures/fake-host")).typeboxModule());

isolateAgentDir();

function mountMultiSelect(tool: any, params: Record<string, unknown>, keys: string[]) {
	return tool.execute(
		"tool-call-id",
		{ question: "Which options should we use?", allowMultiple: true, ...params },
		undefined,
		undefined,
		{
			hasUI: true,
			mode: "tui",
			ui: {
				custom: customUI(async (factory: any) => {
					let resolved: any;
					const component = factory(
						{ requestRender() {}, terminal: { rows: 24 } },
						createTheme(),
						createKeybindings(),
						(value: any) => {
							resolved = value;
						},
					);
					for (const key of keys) component.handleInput(key);
					return resolved ?? null;
				}),
			},
		},
	);
}

describe("multi-select", () => {
	test("moves with the down arrow and toggles with space", async () => {
		const tool = await setupTool();
		const result = await mountMultiSelect(tool, { options: ["Alpha", "Beta", "Gamma"] }, [
			"down",
			"space",
			"enter",
		]);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({ kind: "selection", selections: ["Beta"] });
		expect(result.details.cancelled).toBe(false);
	});

	test("a digit toggles that option without submitting", async () => {
		const tool = await setupTool();
		const result = await mountMultiSelect(tool, { options: ["Alpha", "Beta", "Gamma"] }, [
			"3",
			"enter",
		]);

		expect(result.details.response).toEqual({ kind: "selection", selections: ["Gamma"] });
	});

	test("collects several ticked options in list order", async () => {
		const tool = await setupTool();
		const result = await mountMultiSelect(tool, { options: ["Alpha", "Beta", "Gamma"] }, [
			"3",
			"1",
			"enter",
		]);

		expect(result.details.response).toEqual({
			kind: "selection",
			selections: ["Alpha", "Gamma"],
		});
	});
});
