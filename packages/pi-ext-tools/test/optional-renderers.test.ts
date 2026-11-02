import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	createOptionalToolRenderers,
	createToolPresentationRenderers,
	registerExtensionHook,
	textToolResult,
	toolRendererPoint,
} from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import patchExtension from "../../pi-apply-patch/src/extension.js";
import bgBashExtension from "../../pi-bg-bash/src/extension.js";
import {
	createCollapsibleToolRendererResolver,
	createOptionalToolRendererFactory,
} from "../../pi-ext-ui/src/renderer.js";
import { ToolUiRuntime } from "../../pi-ext-ui/src/runtime.js";

/** The state this test's runtime owns; the extension builds the same one per Pi runtime. */
const runtime = new ToolUiRuntime();

import pythonExtension from "../../pi-python-eval/src/extension.js";
import todoExtension from "../../pi-todo/src/extension.js";
import filesExtension from "../src/extension.js";
import { toolFor, toolHost } from "./fixtures/harness.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_token: string, text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

function context(args: unknown, overrides: Partial<RenderContext> = {}): RenderContext {
	return {
		args,
		state: {},
		toolCallId: "call",
		cwd: "/repo",
		invalidate: () => undefined,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		lastComponent: undefined,
		durationMs: 12,
		outputPad: 0,
		keyText: () => "",
		keyHint: (_keybinding, description) => description,
		...overrides,
	} as RenderContext;
}

/** ToolView is the only renderer that owns folding; a native fallback is plain text. */
interface Foldable extends Component {
	setFoldLevel?(level: 0 | 1 | 2): void;
}

function rows(component: Component, width: number): string[] {
	return component.render(width).map((line) => stripTerminalSequences(line));
}

/**
 * One tool execution is one header row, then body rows that each carry the single shared rail.
 * A second header means a doubled frame; a body row without its rail means the host shell leaked
 * through the package renderer.
 */
function expectSingleFrame(lines: readonly string[], width: number): void {
	expect(lines[0]).toMatch(/^[▸▾] /);
	for (const line of lines.slice(1)) {
		// A body row may be rail-only when its content line is empty.
		expect(line === "▎" || line.startsWith("▎ ")).toBe(true);
		expect(line.split("▎")).toHaveLength(2);
	}
	expect(lines.filter((line) => /^[▸▾] /.test(line))).toHaveLength(1);
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

const packages = [
	filesExtension,
	bgBashExtension,
	patchExtension,
	pythonExtension,
	todoExtension,
] as const;

/** The tool packages that already own their renderers, over one host. */
function combinedHost(): ReturnType<typeof toolHost> {
	const host = toolHost(["read", "bash", "edit", "write", "todo"]);
	for (const extension of packages) extension(host.pi);
	return host;
}

/** The UI session over the same host, so every later render reads the live hook. */
async function withUi(host: ReturnType<typeof toolHost>): Promise<() => Promise<void>> {
	const hook = registerExtensionHook(
		host.pi,
		toolRendererPoint,
		createOptionalToolRendererFactory(host.pi, runtime),
	);
	await hook.ready;
	return () => hook.dispose();
}

const catalog: readonly { readonly name: string; readonly args: unknown }[] = [
	{ name: "read", args: { path: "notes.md" } },
	{ name: "grep", args: { pattern: "alpha" } },
	{ name: "find", args: { pattern: "a" } },
	{ name: "edit", args: { path: "a.ts", edits: [{ oldText: "alpha", newText: "beta" }] } },
	{ name: "write", args: { path: "b.ts", content: "gamma" } },
	{ name: "bash", args: { command: "echo hi" } },
	{ name: "tool_search", args: { query: "agent" } },
	{ name: "bg_bash_spawn", args: { command: "sleep 1" } },
	{ name: "bg_bash_get", args: { id: "bash-1" } },
	{ name: "bg_bash_stop", args: { id: "bash-1" } },
	{
		name: "apply_patch",
		args: { patch: "*** Begin Patch\n*** Add File: n.ts\n+x\n*** End Patch" },
	},
	{ name: "python_eval", args: { code: "print(1)" } },
	{ name: "todo", args: { operations: [{ action: "create", subject: "task one" }] } },
];

const frames: readonly {
	readonly name: string;
	readonly args: unknown;
	readonly result: ReturnType<typeof textToolResult>;
	readonly callText: string;
	readonly resultText: string;
}[] = [
	{
		name: "read",
		args: { path: "notes.md" },
		result: textToolResult("alpha line\nbeta line", {
			__piExtToolsRead: { characters: 20, lines: 2 },
		}),
		callText: "notes.md",
		resultText: "read notes.md",
	},
	{
		name: "grep",
		args: { pattern: "alpha" },
		result: textToolResult("a.ts:1:alpha", {
			format: "canonical-grep",
			engine: "rg",
			events: [],
			display: [
				{ type: "text", text: "a.ts" },
				{
					type: "match",
					lineNumber: 1,
					text: "alpha",
					source: "alpha",
					visibleStart: 0,
					visibleEnd: 5,
					truncatedLeft: false,
					truncatedRight: false,
					submatches: [],
				},
			],
			totalMatched: 1,
			totalFiles: 1,
			totalLines: 1,
			cap: { rows: 1, bytes: 10, maxRows: 100, maxBytes: 1000, truncated: false },
			recovery: { message: "" },
		}),
		callText: "alpha",
		resultText: "alpha",
	},
	{
		name: "find",
		args: { pattern: "a" },
		result: textToolResult("a.ts", {
			format: "canonical-find",
			candidates: [{ path: "a.ts" }],
			totalMatched: 1,
			totalFiles: 1,
		}),
		callText: "find a",
		resultText: "a.ts",
	},
	{
		name: "edit",
		args: { path: "a.ts", edits: [{ oldText: "alpha", newText: "beta" }] },
		result: textToolResult("ok", {
			__piExtToolsEdit: { replacements: 1, added: 1, removed: 1 },
			__piExtToolsEditView: { kind: "diff", lines: [] },
			patch: "@@ -1 +1 @@\n-alpha\n+beta",
		}),
		callText: "a.ts",
		resultText: "beta",
	},
	{
		name: "write",
		args: { path: "b.ts", content: "gamma" },
		result: textToolResult("ok", { __piExtToolsWriteView: { kind: "new", lines: 1 } }),
		callText: "b.ts",
		resultText: "b.ts",
	},
	{
		name: "bash",
		args: { command: "echo hi" },
		result: textToolResult("hi", undefined),
		callText: "$ echo hi",
		resultText: "hi",
	},
	{
		name: "bg_bash_spawn",
		args: { command: "sleep 1" },
		result: textToolResult('{"id":"bash-1","path":"/tmp/bash-1.log"}', {
			id: "bash-1",
			path: "/tmp/bash-1.log",
		}),
		callText: "sleep 1",
		resultText: "/tmp/bash-1.log",
	},
	{
		name: "bg_bash_get",
		args: { id: "bash-1" },
		result: textToolResult('{"status":"running"}', {
			status: "running",
			progress: { command: "sleep 1", cwd: "/repo", elapsedSeconds: 3, path: "/tmp/bash-1.log" },
		}),
		callText: "bash-1",
		resultText: "status: running",
	},
	{
		name: "apply_patch",
		args: { patch: "*** Begin Patch\n*** Add File: n.ts\n+x\n*** End Patch" },
		result: textToolResult("ok", {
			status: "success",
			operations: [
				{
					operationIndex: 0,
					kind: "add",
					path: "n.ts",
					addedLines: 1,
					removedLines: 0,
					status: "applied",
				},
			],
			changedPaths: ["n.ts"],
			addedLines: 1,
			removedLines: 0,
			applied: [],
			rejected: [],
			unconfirmed: [],
			notApplied: [],
			target: "local",
		}),
		callText: "n.ts",
		resultText: "create n.ts",
	},
	{
		name: "python_eval",
		args: { code: "print(1)" },
		result: textToolResult("1", {
			format: "pi-ext-tools-python-eval",
			rows: [
				{ kind: "text", text: "1" },
				{ kind: "state", text: "state: 0 names" },
			],
			durationMs: 12,
		}),
		callText: "print(1)",
		resultText: "state: 0 names",
	},
	{
		name: "tool_search",
		args: { query: "agent" },
		result: textToolResult("Loaded for next call:\n- agent_spawn: spawn", {
			loaded: ["agent_spawn"],
			alreadyAvailable: [],
		}),
		callText: "agent",
		resultText: "agent_spawn",
	},
	{
		name: "todo",
		args: { operations: [{ action: "create", subject: "task one" }] },
		result: textToolResult("created #1", {
			snapshot: { tasks: [{ id: 1, subject: "task one", status: "pending" }], nextId: 2 },
			operations: [{ index: 0, action: "create", changed: true, id: 1 }],
		}),
		callText: "task one",
		resultText: "task one",
	},
];

describe("package-owned tool renderers", () => {
	test.each(catalog)("$name supplies its own call and result renderers", ({ name }) => {
		const tool = toolFor(combinedHost().tools, name);
		expect(tool.renderCall).toBeTypeOf("function");
		expect(tool.renderResult).toBeTypeOf("function");
		expect(tool.renderShell).toBe("self");
	});

	test("each package registers only its own catalog", () => {
		const files = toolHost();
		filesExtension(files.pi);
		expect(files.tools.map((tool) => tool.name)).toEqual([
			"read",
			"grep",
			"find",
			"edit",
			"write",
			"bash",
			"tool_search",
		]);
		const background = toolHost();
		bgBashExtension(background.pi);
		// Background bash owns only its three tools; foreground bash stays with the files package.
		expect(background.tools.map((tool) => tool.name)).toEqual([
			"bg_bash_spawn",
			"bg_bash_get",
			"bg_bash_stop",
		]);
		const patch = toolHost();
		patchExtension(patch.pi);
		expect(patch.tools.map((tool) => tool.name)).toEqual(["apply_patch"]);
		const python = toolHost();
		pythonExtension(python.pi);
		expect(python.tools.map((tool) => tool.name)).toEqual(["python_eval"]);
		const todo = toolHost(["todo"]);
		todoExtension(todo.pi);
		expect(todo.tools.map((tool) => tool.name)).toEqual(["todo"]);
	});

	// read hands its whole native definition to the renderer wiring, so it is the case where a
	// leaked field would replace the package schema or re-import Pi's description.
	test("wiring the optional frame keeps each package's own schema and description", () => {
		const host = combinedHost();
		const schemaOf = (name: string): readonly string[] =>
			Object.keys(
				(toolFor(host.tools, name).parameters as { properties?: object }).properties ?? {},
			);
		expect(schemaOf("read")).toEqual(["path", "offset", "limit"]);
		expect(schemaOf("find")).toEqual(["pattern", "path", "exclude", "limit", "cursor"]);
		expect(schemaOf("bash")).toEqual(["command", "timeout"]);
		expect(schemaOf("tool_search")).toEqual(["query", "limit"]);
		expect(schemaOf("bg_bash_spawn")).toEqual(["command", "timeout"]);
		expect(schemaOf("bg_bash_get")).toEqual(["id", "keys"]);
		expect(schemaOf("bg_bash_stop")).toEqual(["id"]);
		expect(toolFor(host.tools, "bash").description).toBe(
			"Run one shell command or short pipeline in the foreground.",
		);
		for (const { name } of catalog) {
			const tool = toolFor(host.tools, name);
			expect(tool.execute).toBeTypeOf("function");
			expect(tool.renderShell).toBe("self");
		}
	});

	test("the global resolver never re-wraps a package-owned definition", async () => {
		const host = combinedHost();
		const dispose = await withUi(host);
		try {
			const resolve = createCollapsibleToolRendererResolver(runtime);
			for (const { name } of catalog) {
				const tool = toolFor(host.tools, name);
				expect(resolve(name, () => tool)).toBe(tool);
			}
		} finally {
			await dispose();
		}
	});
});

describe("package-owned frames through the real UI factory", () => {
	test.each(frames)("$name draws one frame with input and result at 24 and 100 cells", async ({
		name,
		args,
		result,
		callText,
		resultText,
	}) => {
		const host = combinedHost();
		const dispose = await withUi(host);
		try {
			const tool = toolFor(host.tools, name);
			const call = tool.renderCall!(args as never, theme, context(args)) as Foldable;
			call.setFoldLevel?.(2);
			const outcome = tool.renderResult!(
				result as never,
				{ expanded: false, isPartial: false },
				theme,
				context(args),
			) as Foldable;
			outcome.setFoldLevel?.(2);
			for (const width of [24, 100]) {
				const resultRows = rows(outcome, width);
				expectSingleFrame(rows(call, width), width);
				expectSingleFrame(resultRows, width);
				expect(resultRows.join("\n")).toContain(resultText);
			}
			// Narrow terminals truncate the row; only the wide frame must carry the whole input.
			expect(rows(call, 100).join("\n")).toContain(callText);
		} finally {
			await dispose();
		}
	});

	test.each([
		{
			name: "read",
			args: { path: "missing.md" },
			result: textToolResult("ENOENT: no such file", undefined),
			message: "ENOENT: no such file",
		},
		{
			name: "edit",
			args: { path: "a.ts", edits: [{ oldText: "alpha", newText: "beta" }] },
			result: textToolResult("oldText not found", {
				__piExtToolsEditView: { kind: "diff", lines: [] },
			}),
			message: "oldText not found",
		},
		{
			name: "write",
			args: { path: "b.ts", content: "gamma" },
			result: textToolResult("Permission denied", undefined),
			message: "Permission denied",
		},
		{
			name: "bash",
			args: { command: "exit 3" },
			result: textToolResult("command failed: exit 3", undefined),
			message: "command failed: exit 3",
		},
		{
			name: "bg_bash_spawn",
			args: { command: "sleep 1" },
			result: textToolResult("Unable to start background job: EACCES", undefined),
			message: "Unable to start background job: EACCES",
		},
		{
			name: "bg_bash_get",
			args: { id: "bash-1" },
			result: textToolResult("Background Bash task bash-1 not found", undefined),
			message: "Background Bash task bash-1 not found",
		},
		{
			name: "bg_bash_stop",
			args: { id: "bash-1" },
			result: textToolResult("Unable to confirm stop of bash-1.", undefined),
			message: "Unable to confirm stop of bash-1.",
		},
		{
			name: "apply_patch",
			args: { patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch" },
			result: textToolResult("rejected", {
				status: "failed",
				operations: [
					{
						operationIndex: 0,
						kind: "update",
						path: "a.ts",
						addedLines: 0,
						removedLines: 0,
						status: "rejected",
					},
				],
				changedPaths: [],
				addedLines: 0,
				removedLines: 0,
				applied: [],
				rejected: [
					{
						operationIndices: [0],
						paths: ["a.ts"],
						error: "context not found",
						diagnostics: [],
					},
				],
				unconfirmed: [],
				notApplied: [],
				target: "local",
			}),
			message: "context not found",
		},
		{
			name: "python_eval",
			args: { code: "raise SystemExit('boom')" },
			result: textToolResult("Traceback: boom", {
				format: "pi-ext-tools-python-eval",
				rows: [{ kind: "text", text: "Traceback: boom" }],
				durationMs: 3,
				error: "boom",
			}),
			message: "Traceback: boom",
		},
		{
			name: "todo",
			args: { operations: [{ action: "list" }] },
			result: textToolResult("Todo runtime is not active", undefined),
			message: "Todo runtime is not active",
		},
	])("$name keeps its failure message in one error frame", async ({
		name,
		args,
		result,
		message,
	}) => {
		const host = combinedHost();
		const dispose = await withUi(host);
		try {
			const tool = toolFor(host.tools, name);
			const outcome = tool.renderResult!(
				result as never,
				{ expanded: false, isPartial: false },
				theme,
				context(args, { isError: true }),
			) as Foldable;
			outcome.setFoldLevel?.(2);
			for (const width of [24, 100]) {
				const lines = rows(outcome, width);
				expectSingleFrame(lines, width);
				expect(lines[0]).toContain("✗");
			}
			expect(rows(outcome, 100).join("\n")).toContain(message);
		} finally {
			await dispose();
		}
	});

	test.each([
		"read",
		"python_eval",
		"todo",
		"bash",
		"bg_bash_spawn",
	])("%s streams its call row without inventing a result", async (name) => {
		const host = combinedHost();
		const dispose = await withUi(host);
		try {
			const args = frames.find((frame) => frame.name === name)!.args;
			const tool = toolFor(host.tools, name);
			const call = tool.renderCall!(
				args as never,
				theme,
				context(args, { isPartial: true, argsComplete: false }),
			) as Foldable;
			call.setFoldLevel?.(2);
			for (const width of [24, 100]) expectSingleFrame(rows(call, width), width);
			expect(rows(call, 100)[0]).toMatch(/[·✢✳✶✻✽]/);
		} finally {
			await dispose();
		}
	});

	test("a partial result keeps its running status instead of a finished glyph", async () => {
		const host = combinedHost();
		const dispose = await withUi(host);
		try {
			const tool = toolFor(host.tools, "write");
			const outcome = tool.renderResult!(
				textToolResult("partial transcript", undefined),
				{ expanded: false, isPartial: true },
				theme,
				context({ path: "b.ts", content: "gamma" }),
			) as Foldable;
			outcome.setFoldLevel?.(2);
			const lines = rows(outcome, 100);
			expectSingleFrame(lines, 100);
			expect(lines[0]).toMatch(/[·✢✳✶✻✽]/);
			expect(lines.join("\n")).toContain("partial transcript");
		} finally {
			await dispose();
		}
	});

	test("the factory is driven by the tool's provider, not a UI name catalog", async () => {
		const host = toolHost();
		const dispose = await withUi(host);
		try {
			const name = "custom_flow_probe";
			const native = createToolPresentationRenderers(host.pi, name, () => ({
				summary: "one flow",
				sections: [{ railToken: "dim", content: ["step one", "step two"] }],
				output: "flow finished",
			}));
			const wrapped = createOptionalToolRenderers(host.pi, name, native);
			const call = wrapped.renderCall!({}, theme, context({})) as Foldable;
			call.setFoldLevel?.(2);
			const outcome = wrapped.renderResult!(
				textToolResult("flow finished", undefined),
				{ expanded: false, isPartial: false },
				theme,
				context({}),
			) as Foldable;
			outcome.setFoldLevel?.(2);
			for (const width of [24, 100]) {
				expectSingleFrame(rows(call, width), width);
				expectSingleFrame(rows(outcome, width), width);
			}
			expect(rows(call, 100).join("\n")).toContain("one flow");
			expect(rows(outcome, 100).join("\n")).toContain("step two");
		} finally {
			await dispose();
		}
	});

	test("the same definition falls back to its native rows once the UI session is disposed", async () => {
		const host = combinedHost();
		const dispose = await withUi(host);
		const tool = toolFor(host.tools, "write");
		const args = { path: "b.ts", content: "gamma" };
		const before = tool.renderResult!(
			textToolResult("ok", { __piExtToolsWriteView: { kind: "new", lines: 1 } }) as never,
			{ expanded: false, isPartial: false },
			theme,
			context(args),
		);
		await dispose();
		const after = tool.renderResult!(
			textToolResult("ok", { __piExtToolsWriteView: { kind: "new", lines: 1 } }) as never,
			{ expanded: false, isPartial: false },
			theme,
			context(args),
		);
		expect(rows(before, 100)[0]).toMatch(/^[▸▾] /);
		expect(rows(after, 100).join("\n")).not.toMatch(/[▸▾▎]/);
	});
});
