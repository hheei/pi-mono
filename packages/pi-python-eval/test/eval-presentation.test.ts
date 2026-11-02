import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ToolPresentationContext, ToolPresentationSection } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import {
	createPythonEvalPresentation,
	type EvalRow,
	type EvalToolDetails,
	PYTHON_EVAL_DETAILS_FORMAT,
	readEvalDetails,
	summarizeTraceArgs,
} from "../src/presentation.js";

/** A theme that keeps its tokens visible, so a test can assert which token painted what. */
const theme = {
	fg: (token: string, text: string) => `<${token}>${text}`,
	bold: (text: string) => text,
} as unknown as Theme;

function context(overrides: Partial<ToolPresentationContext> = {}): ToolPresentationContext {
	return {
		args: {},
		state: {},
		toolCallId: "call",
		cwd: "/repo",
		invalidate() {},
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		lastComponent: undefined,
		durationMs: 1500,
		outputPad: 0,
		...overrides,
	} as unknown as ToolPresentationContext;
}

function result(
	rows: readonly EvalRow[],
	extra: Partial<EvalToolDetails> = {},
): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: "plain transcript" }],
		details: { format: PYTHON_EVAL_DETAILS_FORMAT, rows, durationMs: 1500, ...extra },
	};
}

/** Every section's content as plain rows, so assertions read as what the frame shows. */
function sectionRows(sections: readonly ToolPresentationSection[] | undefined): string[] {
	const rows: string[] = [];
	for (const section of sections ?? []) {
		const content = section.content;
		if (typeof content === "string") rows.push(stripTerminalSequences(content));
		else if (Array.isArray(content))
			rows.push(...content.map((line) => stripTerminalSequences(line)));
	}
	return rows;
}

function railTokens(
	sections: readonly ToolPresentationSection[] | undefined,
): (string | undefined)[] {
	return (sections ?? []).map((section) => section.railToken);
}

const nestedTool = (name: "read" | "bash", args: unknown, durationMs: number, error?: string) =>
	({
		kind: "tool",
		trace: {
			name,
			text: "",
			summary: summarizeTraceArgs(args),
			durationMs,
			resolved: true,
			...(error === undefined ? {} : { error }),
		},
	}) as const;

describe("python_eval rich presentation", () => {
	test("the call row names the first code line and the options that change the cell", () => {
		const call = (args: unknown): string =>
			stripTerminalSequences(
				createPythonEvalPresentation(args, undefined, theme, context()).summary,
			);

		expect(call({ code: "x = 1\nprint(x)" })).toBe("x = 1");
		expect(call({ code: "x = 1", reset: true })).toBe("x = 1 · (reset)");
		// The deadline is a per-cell option with one value nearly every time, so it stays out of the
		// row: the frame already spends width on the duration.
		expect(call({ code: "x = 1", timeout_ms: 250 })).toBe("x = 1");
		expect(call({ code: "x = 1", reset: true, timeout_ms: 2000 })).toBe("x = 1 · (reset)");
		expect(call({ code: "   " })).toBe("(empty)");
	});

	test("the result row reports nested call stats and the cell duration", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "tools.read(path='a')" },
			result([
				nestedTool("read", { path: "a" }, 12),
				nestedTool("bash", { command: "ls" }, 30, "boom"),
			]),
			theme,
			context(),
		);
		// The frame appends the duration, so the summary must not carry a second copy of it.
		expect(stripTerminalSequences(presentation.summary)).toBe("1 ok · 1 failed");
		// A container with child rows speaks through them instead of claiming its own status.
		expect(presentation.status).toBe("none");
	});

	test("a cell without nested calls counts its rows and keeps its own status", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "print(1)" },
			result([{ kind: "text", text: "1" }]),
			theme,
			context(),
		);
		expect(stripTerminalSequences(presentation.summary)).toBe("1 row");
		expect(presentation.status).toBe("ok");
	});

	test("a running cell reports running and replaces its call row", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "print(1)" },
			result([{ kind: "text", text: "1" }]),
			theme,
			context({ isPartial: true }),
		);
		expect(presentation.status).toBe("running");
		expect(presentation.replaceCallOnPartial).toBe(true);
	});

	test("the transcript mutes the namespace report and prefixes display and result rows", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "x = 1" },
			result([
				{ kind: "state", text: "state: 1 name · +x" },
				{ kind: "display", text: "{'a': 1}" },
				{ kind: "result", text: "2\n3" },
				{ kind: "text", text: "printed" },
			]),
			theme,
			context(),
		);
		const rows = sectionRows(presentation.sections);
		expect(rows).toContain("<muted>state: 1 name · +x");
		expect(rows).toContain("<dim>display: <dim>{'a': 1}");
		expect(rows).toContain("<dim>result: <dim>2");
		expect(rows).toContain("  <dim>3");
		expect(rows).toContain("<dim>printed");
	});

	test("an error cell paints the transcript as error and the rail as error", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "raise ValueError('nope')" },
			result([{ kind: "text", text: "error: nope" }], { error: "nope" }),
			theme,
			context({ isError: true }),
		);
		expect(presentation.status).toBe("error");
		expect(railTokens(presentation.sections)).toContain("error");
		expect(sectionRows(presentation.sections)).toContain("<error>error: nope");
	});

	test("the code input is highlighted Python on a muted rail, and copied with the transcript", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "print(1)" },
			result([{ kind: "text", text: "1" }]),
			theme,
			context(),
		);
		const tokens = railTokens(presentation.sections);
		expect(tokens[0]).toBe("muted");
		expect(tokens[1]).toBe("success");
		expect(presentation.copy).toEqual({
			primary: "print(1)",
			full: "print(1)\n---\nplain transcript",
		});
	});

	test("copies the cell source as the model sent it and strips only its display", () => {
		const code = "  print(1)  # ZZ_TAIL_07\nprint('\u001b[31mred\u001b[0m')\n";
		const presentation = createPythonEvalPresentation(
			{ code },
			result([{ kind: "text", text: "1" }]),
			theme,
			context(),
		);
		expect(presentation.copy).toEqual({
			primary: code,
			full: `${code}\n---\nplain transcript`,
		});
		expect(presentation.copy?.primary).toContain("ZZ_TAIL_07");
		const rows = sectionRows(presentation.sections).join("\n");
		expect(rows).toContain("print('red')");
		expect(rows).toContain("ZZ_TAIL_07");
		expect(rows).not.toContain("\u001b");
	});

	test("a cell with no details degrades to the plain text the tool produced", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "print(1)" },
			{ content: [{ type: "text", text: "1\n2" }], details: {} },
			theme,
			context(),
		);
		expect(sectionRows(presentation.sections)).toEqual(["<mdCode>print(1)", "<dim>1", "<dim>2"]);
		expect(presentation.output).toBe("1\n2");
	});

	test("nested call rows carry the tool name, its argument summary, and its duration", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "tools.read(path='a.txt')" },
			result([
				nestedTool("read", { path: "a.txt" }, 12),
				nestedTool("bash", { command: "ls" }, 30, "boom"),
			]),
			theme,
			context(),
		);
		const rows = sectionRows(presentation.sections);
		// The row states the same semantics as the shared tool frame: a path is a location, a command
		// is content, and the duration is secondary.
		expect(rows).toContain("<success>✓ <toolTitle>read <accent>a.txt<dim> · <dim>12ms");
		expect(rows).toContain("<error>✗ <toolTitle>bash <toolTitle>ls<dim> · <dim>30ms");
		// The frame draws the interactive board from the facts; this package no longer ships rows.
		expect(presentation.collapsedRows).toBeUndefined();
		expect(presentation.children).toHaveLength(2);
	});

	test("a child call reads the same inside the group as in the frame", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "tools.read(glob='**/*.ts')" },
			result([
				nestedTool("read", { glob: "**/*.ts" }, 12),
				nestedTool("bash", { command: "ls\npiped" }, 30),
			]),
			theme,
			context(),
		);
		const children = presentation.children ?? [];
		// A glob, a url, or a multi-line command must summarize the same way in both views; only one
		// rule decides now, so this pins the rule rather than its two copies.
		expect(children.map((child) => child.summary)).toEqual(["**/*.ts", "ls piped"]);
		// The row text comes from the same summary, so the board cannot summarize differently.
		const frameRows = sectionRows(presentation.sections).filter((row) => row.includes("✓"));
		for (const [index, child] of children.entries()) {
			expect(frameRows[index]).toContain(child.summary ?? "");
		}
	});

	test("lists nested calls the preview no longer holds", () => {
		const details: EvalToolDetails = {
			format: PYTHON_EVAL_DETAILS_FORMAT,
			rows: [{ kind: "text", text: "row 0" }],
			calls: {
				total: 3,
				failed: 1,
				resolved: 3,
				items: [
					{ name: "read", summary: "a.txt", durationMs: 12, failed: false, resolved: true },
					{ name: "read", summary: "b.txt", durationMs: 13, failed: false, resolved: true },
					{ name: "bash", summary: "ls", durationMs: 14, failed: true, resolved: true },
				],
			},
			durationMs: 1500,
		};
		const presentation = createPythonEvalPresentation(
			{ code: "tools.read()" },
			{ content: [{ type: "text", text: "plain" }], details },
			theme,
			context(),
		);
		expect(presentation.childCount).toBe(3);
		expect(presentation.children?.map((child) => child.title)).toEqual(["read", "read", "bash"]);
		expect(presentation.children?.[2]?.status).toBe("error");
		expect(stripTerminalSequences(presentation.summary)).toBe("2 ok · 1 failed");
	});

	test("counts only calls the host proved it resolved and names the rest as unknown", () => {
		const details: EvalToolDetails = {
			format: PYTHON_EVAL_DETAILS_FORMAT,
			rows: [],
			calls: {
				total: 2,
				failed: 1,
				resolved: 1,
				items: [
					{ name: "bash", summary: "ls", durationMs: 5, failed: true, resolved: true },
					{ name: "read", summary: "a.txt", durationMs: 6, failed: false },
				],
			},
			durationMs: 10,
		};
		const presentation = createPythonEvalPresentation(
			{ code: "tools.bash()" },
			{ content: [{ type: "text", text: "plain" }], details },
			theme,
			context(),
		);
		// A failed call that resolved is a failed call; the unresolved one is not a call at all.
		expect(stripTerminalSequences(presentation.summary)).toBe("0 ok · 1 failed · 1 unknown");
		expect(presentation.childCount).toBe(1);
	});

	test("a legacy record without resolution facts reports no proven calls", () => {
		const details = {
			format: PYTHON_EVAL_DETAILS_FORMAT,
			rows: [],
			calls: {
				total: 1,
				failed: 0,
				items: [{ name: "read", summary: "a.txt", durationMs: 3, failed: false }],
			},
			durationMs: 10,
		} as unknown as EvalToolDetails;
		const presentation = createPythonEvalPresentation(
			{ code: "tools.read()" },
			{ content: [{ type: "text", text: "plain" }], details },
			theme,
			context(),
		);
		expect(stripTerminalSequences(presentation.summary)).toBe("1 unknown");
		expect(presentation.childCount).toBe(0);
	});
});

describe("python_eval persisted details", () => {
	test("reads only this package's details and drops rows it cannot trust", () => {
		expect(readEvalDetails({ format: "other", rows: [] })).toBeUndefined();
		expect(readEvalDetails(undefined)).toBeUndefined();
		const facts = readEvalDetails({
			format: PYTHON_EVAL_DETAILS_FORMAT,
			rows: [
				{ kind: "text", text: "ok" },
				{ kind: "text", text: 1 },
				{ kind: "tool", trace: { name: "read", text: "x", summary: "a", durationMs: 5 } },
				{ kind: "tool", trace: { name: "read" } },
			],
			error: "boom",
		});
		expect(facts?.rows).toEqual([
			{ kind: "text", text: "ok" },
			{ kind: "tool", trace: { name: "read", text: "x", summary: "a", durationMs: 5 } },
		]);
		expect(facts?.error).toBe("boom");
	});
});
