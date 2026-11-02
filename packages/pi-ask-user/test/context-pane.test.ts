import { describe, expect, test, vi } from "vitest";
import { editorState } from "./fixtures/fake-host";
import { isolateAgentDir, press, runPrompt } from "./fixtures/harness";

vi.mock("@earendil-works/pi-coding-agent", async () =>
	(await import("./fixtures/fake-host")).piCodingAgentModule(),
);
vi.mock("@earendil-works/pi-tui", async () => (await import("./fixtures/fake-host")).piTuiModule());
vi.mock("typebox", async () => (await import("./fixtures/fake-host")).typeboxModule());

isolateAgentDir();

const longContext = "Context detail. ".repeat(80);
const questionLines = (count: number) =>
	Array.from({ length: count }, (_, index) => `Question line ${index}`).join("\n");

test("routes PageUp/PageDown to the editor in freeform mode", async () => {
	editorState.inputs = [];
	const { result } = await runPrompt(
		{
			question: questionLines(18),
			context: "Long context so the prompt is taller than the terminal.",
			options: ["Alpha", "Beta"],
		},
		(component) => {
			component.render(50);
			press(component, "down", "down", "enter");
			component.render(50);
			press(component, "pageUp", "pageDown");
		},
		{ rows: 12 },
	);

	expect(result.isError).not.toBe(true);
	expect(editorState.inputs).toContain("pageUp");
	expect(editorState.inputs).toContain("pageDown");
});

test("does not clip a tall prompt to a viewport", async () => {
	const { rowsOf } = await runPrompt(
		{
			question: "This is a very long question. ".repeat(80),
			context: longContext,
			options: ["Alpha", "Beta"],
		},
		(_component, record) => record("frame"),
		{ rows: 12 },
	);

	expect(rowsOf("frame").length).toBeGreaterThan(10);
});

test("collapses oversized context but leaves short context expanded", async () => {
	const renderInline = async (context: string) => {
		const { frameOf } = await runPrompt(
			{ question: "Pick one", context, options: ["Alpha", "Beta"] },
			(_component, record) => record("frame"),
			{ rows: 12, width: 40 },
		);
		return frameOf("frame");
	};

	const shortOutput = await renderInline("Short context.");
	const longOutput = await renderInline("Long context detail. ".repeat(80));
	expect(shortOutput).toContain("Short context.");
	expect(shortOutput).not.toContain("Context (");
	expect(longOutput).toContain("Context (");
	expect(longOutput).not.toContain("Long context detail.");
});

test("toggles context open and closed", async () => {
	const context = Array.from({ length: 6 }, (_, index) => `Medium context line ${index}`).join(
		"\n",
	);
	const { frameOf } = await runPrompt(
		{ question: "Pick one", context, options: ["Alpha", "Beta"] },
		(component, record) => {
			record("initial");
			press(component, "ctrl+e");
			record("expanded");
			press(component, "ctrl+e");
			record("collapsed");
		},
		{ rows: 24, width: 60 },
	);

	expect(frameOf("initial")).toContain("Context (");
	expect(frameOf("expanded")).toContain("Medium context line 5");
	expect(frameOf("collapsed")).toContain("Context (");
	expect(frameOf("collapsed")).not.toContain("Medium context line 5");
});

describe("context pane", () => {
	test("expands and re-collapses long context without losing the selection", async () => {
		const { frameOf, result } = await runPrompt(
			{ question: "Which option should we use?", context: longContext, options: ["Alpha", "Beta"] },
			(component, record) => {
				press(component, "down");
				record("collapsed");
				press(component, "ctrl+e");
				record("expanded");
				press(component, "ctrl+e");
				record("recollapsed");
				press(component, "enter");
			},
			{ rows: 12 },
		);

		expect(frameOf("collapsed")).toContain("Context (");
		expect(frameOf("expanded")).toContain("Context detail.");
		expect(frameOf("recollapsed")).toContain("Context (");
		expect(frameOf("recollapsed")).not.toContain("Context detail.");
		expect(result.details.response).toEqual({ kind: "selection", selections: ["Beta"] });
		expect(result.details.context).toContain("Context detail.");
	});
});
