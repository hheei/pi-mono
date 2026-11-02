import { describe, expect, test, vi } from "vitest";
import { editorState } from "./fixtures/fake-host";
import { isolateAgentDir, press, runPrompt } from "./fixtures/harness";

vi.mock("@earendil-works/pi-coding-agent", async () =>
	(await import("./fixtures/fake-host")).piCodingAgentModule(),
);
vi.mock("@earendil-works/pi-tui", async () => (await import("./fixtures/fake-host")).piTuiModule());
vi.mock("typebox", async () => (await import("./fixtures/fake-host")).typeboxModule());

isolateAgentDir();

const params = {
	question: "Which option should we use?",
	options: ["A", "B"],
	allowFreeform: true,
};

describe("ask prompt", () => {
	test("enters freeform mode without editor theme crashes", async () => {
		const { result } = await runPrompt(params, (component) =>
			press(component, "down", "down", "enter"),
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.cancelled).toBe(true);
	});

	test("forwards ctrl+enter to the editor instead of submitting freeform mode", async () => {
		editorState.inputs = [];
		editorState.text = "draft answer";
		const { result } = await runPrompt(params, (component) =>
			press(component, "down", "down", "enter", "ctrl+enter"),
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.cancelled).toBe(true);
		expect(editorState.inputs).toEqual(["ctrl+enter"]);
	});

	test("shows the remapped cancel key in freeform help text", async () => {
		const { frameOf, result } = await runPrompt(
			params,
			(component, record) => {
				press(component, "down", "down", "enter");
				record("frame", 120);
			},
			{ keybindings: { "tui.select.cancel": ["q"] } },
		);
		const frame = frameOf("frame");

		expect(result.isError).not.toBe(true);
		expect(frame).toContain("q cancel");
		expect(frame).not.toContain("ctrl+c cancel");
	});
});
