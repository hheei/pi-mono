import { describe, expect, test, vi } from "vitest";
import { editorState } from "./fixtures/fake-host";
import { emittedEvents, isolateAgentDir, press, runPrompt } from "./fixtures/harness";

vi.mock("@earendil-works/pi-coding-agent", async () =>
	(await import("./fixtures/fake-host")).piCodingAgentModule(),
);
vi.mock("@earendil-works/pi-tui", async () => (await import("./fixtures/fake-host")).piTuiModule());
vi.mock("typebox", async () => (await import("./fixtures/fake-host")).typeboxModule());

isolateAgentDir();

const question = "Which option should we use?";

test.each([
	{
		name: "the shared confirm keybinding",
		options: ["A", "B"],
		keys: ["x"],
		keybindings: { "tui.select.confirm": ["x"] },
		selection: "A",
	},
	{
		name: "the down arrow and enter",
		options: ["Alpha", "Beta", "Gamma"],
		keys: ["down", "enter"],
		selection: "Beta",
	},
	{
		name: "tab as down",
		options: ["Alpha", "Beta", "Gamma"],
		keys: ["tab", "enter"],
		selection: "Beta",
	},
	{
		name: "a digit that jumps to the option",
		options: ["Alpha", "Beta", "Gamma"],
		keys: ["3", "enter"],
		selection: "Gamma",
	},
	{
		name: "a digit beyond the list being ignored",
		options: ["Alpha", "Beta", "Gamma"],
		keys: ["7", "enter"],
		selection: "Alpha",
	},
	{
		name: "ctrl+k doing nothing",
		options: ["Alpha", "Beta", "Gamma"],
		params: { allowFreeform: false },
		keys: ["ctrl+k", "enter"],
		selection: "Alpha",
	},
	{
		name: "typing letters doing nothing",
		options: ["Alpha", "Beta", "Gamma"],
		keys: ["b", "enter"],
		selection: "Alpha",
	},
])("selects with $name", async ({ options, params, keys, keybindings, selection }) => {
	const { result } = await runPrompt(
		{ question, options, ...params },
		(component) => press(component, ...keys),
		{ ...(keybindings ? { keybindings } : {}) },
	);

	expect(result.isError).not.toBe(true);
	expect(result.details.response).toEqual({ kind: "selection", selections: [selection] });
	expect(result.details.cancelled).toBe(false);
});

test("opens the editor from the freeform row", async () => {
	editorState.inputs = [];
	const { result } = await runPrompt(
		{ question, options: ["Alpha", "Beta"], allowFreeform: true },
		(component) => {
			press(component, "down", "down", "enter");
			editorState.text = "custom from editor";
			press(component, "enter");
		},
	);

	expect(result.isError).not.toBe(true);
	expect(result.details.response).toEqual({ kind: "freeform", text: "custom from editor" });
	expect(result.details.cancelled).toBe(false);
	expect(emittedEvents.find((event) => event.name === "ask:answered")?.payload).toEqual({
		question,
		response: { kind: "freeform" },
	});
	expect(editorState.inputs).toEqual(["enter"]);
});

describe("single-select layout", () => {
	test("keeps descriptions under their option in one column", async () => {
		const { frameOf } = await runPrompt(
			{
				question,
				options: [
					{ title: "Alpha", description: "The alpha option stays below its title." },
					{ title: "Beta", description: "The beta option stays below its title." },
				],
			},
			(_component, record) => record("frame", 120),
		);
		const rows = frameOf("frame").split("\n");
		const listRow = rows.findIndex((row) => row.includes("1. Alpha"));

		expect(rows[listRow + 1]).toContain("The alpha option stays below its title.");
	});

	test.each([
		{ width: 40, rows: 12 },
		{ width: 60, rows: 20 },
	])("keeps the question, collapsed context, and a choice visible at $width x $rows", async ({
		width,
		rows,
	}) => {
		const { frameOf } = await runPrompt(
			{
				question: "Which deployment strategy should we use?",
				context: "Decision-critical context detail. ".repeat(80),
				options: ["Alpha", "Beta"],
			},
			(_component, record) => record("frame", width),
			{ rows },
		);
		const joined = frameOf("frame").replace(/\s+/g, " ");

		expect(joined).toContain("Which deployment strategy should we");
		expect(joined).toContain("use?");
		expect(joined).toContain("\u2192 1. Alpha");
		expect(joined).toContain("Context (");
		expect(joined).toContain("ctrl+e");
		expect(joined).not.toContain("Decision-critical context detail.");
	});
});
