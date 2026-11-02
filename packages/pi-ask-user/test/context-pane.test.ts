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

test("scrolls the prompt pane without hiding answers or help", async () => {
	const context = Array.from({ length: 8 }, (_, index) => `Context line ${index}`).join("\n");
	const { frameOf, result } = await runPrompt(
		{ question: questionLines(18), context, options: ["Alpha", "Beta"] },
		(component, record) => {
			record("initial");
			press(component, "ctrl+e");
			record("expanded");
			press(component, "end");
			record("scrolled");
			press(component, "home");
			record("restored");
		},
		{ rows: 12 },
	);

	expect(result.isError).not.toBe(true);
	expect(frameOf("initial")).toContain("Question line 0");
	expect(frameOf("scrolled")).toContain("Context line 7");
	expect(frameOf("scrolled")).toContain("Alpha");
	expect(frameOf("scrolled")).toContain("ctrl+e context");
	expect(frameOf("scrolled")).toContain("PgUp/P");
	expect(frameOf("restored")).toContain("Question line 0");
});

test("keeps multiple freeform editor rows visible in a constrained overlay", async () => {
	const { frameOf, rowsOf, result } = await runPrompt(
		{
			question: "Which option should we use?",
			context: "Short context that should give way to the editor once freeform mode is active.",
			options: ["Alpha", "Beta"],
		},
		(component, record) => {
			press(component, "down", "down", "enter");
			editorState.text = Array.from({ length: 6 }, (_, index) => `editor line ${index}`).join("\n");
			record("frame");
		},
		{ rows: 12 },
	);

	const joined = frameOf("frame");
	expect(result.isError).not.toBe(true);
	expect(rowsOf("frame").length).toBeLessThanOrEqual(10);
	expect(joined).toContain("Custom response");
	expect(joined).toContain("editor line 4");
	expect(joined).toContain("editor line 5");
	expect(joined).toContain("\u21b5 submit");
});

test("routes PageUp/PageDown to the editor in freeform mode instead of prompt scrolling", async () => {
	editorState.inputs = [];
	const { result } = await runPrompt(
		{
			question: questionLines(18),
			context: "Long overlay context so the prompt pane has scrollable overflow.",
			options: ["Alpha", "Beta"],
		},
		(component) => {
			// Render once so the prompt pane computes a scrollable overflow, then open the editor.
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

test("does not apply overlay viewport clipping in inline mode", async () => {
	const { rowsOf } = await runPrompt(
		{
			question: "This is a very long question. ".repeat(80),
			context: longContext,
			options: ["Alpha", "Beta"],
			displayMode: "inline",
		},
		(_component, record) => record("frame"),
		{ rows: 12 },
	);

	expect(rowsOf("frame").length).toBeGreaterThan(10);
});

test("collapses oversized inline context but leaves short context expanded", async () => {
	const renderInline = async (context: string) => {
		const { frameOf } = await runPrompt(
			{ question: "Pick one", context, options: ["Alpha", "Beta"], displayMode: "inline" },
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

test("toggles inline context open and closed", async () => {
	const context = Array.from({ length: 6 }, (_, index) => `Medium context line ${index}`).join(
		"\n",
	);
	const { frameOf } = await runPrompt(
		{ question: "Pick one", context, options: ["Alpha", "Beta"], displayMode: "inline" },
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
				press(component, "end");
				record("scrolled");
				press(component, "ctrl+e");
				record("recollapsed");
				press(component, "enter");
			},
			{ rows: 12 },
		);

		expect(frameOf("collapsed")).toContain("Context (");
		expect(frameOf("expanded")).not.toContain("Context detail.");
		expect(frameOf("scrolled")).toContain("Context detail.");
		expect(frameOf("scrolled")).toContain("Beta");
		expect(frameOf("recollapsed")).not.toContain("Context detail.");
		expect(result.details.response).toEqual({ kind: "selection", selections: ["Beta"] });
		expect(result.details.context).toContain("Context detail.");
	});
});
