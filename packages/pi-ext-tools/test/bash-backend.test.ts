import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { expect, test } from "vitest";
import { BashInput, registerBashTool } from "../src/bash.js";
import { DEFAULT_BASH_SETTINGS } from "../src/bash-settings.js";
import { toolContextFor, toolFor, toolHost } from "./fixtures/harness.js";
import { roleTheme } from "./fixtures/theme.js";

initTheme(undefined, false);

test("bash uses one flat object schema for strict tool providers", (): void => {
	expect(BashInput).toMatchObject({ type: "object", additionalProperties: false });
	expect(BashInput).not.toHaveProperty("anyOf");
	expect(BashInput.properties).toHaveProperty("command");
	expect(BashInput.properties).not.toHaveProperty("blocking");
	expect(BashInput.properties).not.toHaveProperty("async");
	expect(Value.Check(BashInput, { command: "pwd" })).toBe(true);
	expect(Value.Check(BashInput, { command: "pwd", blocking: false })).toBe(false);
	// The legacy `async` parameter is rejected instead of being silently reinterpreted.
	expect(Value.Check(BashInput, { command: "pwd", async: true })).toBe(false);
	expect(Value.Check(BashInput, {})).toBe(false);
	expect(Value.Check(BashInput, { command: "" })).toBe(false);
});

/** The render context Pi passes for a bash result, plus whatever a test needs on top. */
function bashContext(
	command: string,
	isPartial = false,
	extra: Record<string, unknown> = {},
): never {
	return {
		args: { command },
		isError: false,
		isPartial,
		lastComponent: undefined,
		state: {},
		keyText: () => "ctrl+o",
		...extra,
	} as never;
}

/** Registers bash on a capturing host and returns it, optionally framed by a ToolTui. */
function bashTool(getSettings?: () => typeof DEFAULT_BASH_SETTINGS): ToolDefinition {
	const host = toolHost();
	registerBashTool(host.pi, getSettings === undefined ? undefined : { getSettings });
	return toolFor(host.tools, "bash");
}

test("bash executes through Pi host original backend", async (): Promise<void> => {
	const bash = bashTool();

	const result = await bash.execute(
		"bash-original-backend",
		{ command: "printf restored-backend" },
		new AbortController().signal,
		() => undefined,
		toolContextFor({ sessionId: "bash-backend-test" }),
	);

	expect(result.content).toEqual([{ type: "text", text: "restored-backend" }]);
});

test("bash never streams Pi host temporary output paths", async (): Promise<void> => {
	const bash = bashTool();
	const updates: unknown[] = [];
	await bash.execute(
		"bash-streamed-path-redaction",
		{ command: "yes x | head -c 1100000" },
		undefined,
		(update): void => {
			updates.push(update);
		},
		toolContextFor({ sessionId: "bash-streamed-path-redaction" }),
	);
	expect(updates.length).toBeGreaterThan(0);
	expect(updates.map((update) => JSON.stringify(update)).join("\n")).not.toContain(
		"fullOutputPath",
	);
});

test("bash rejects unknown fields before any command starts", async (): Promise<void> => {
	const bash = bashTool();
	await expect(
		bash.execute(
			"bash-invalid-parameters",
			{ command: "printf unavailable", unsupported: true },
			undefined,
			undefined,
			toolContextFor({ mode: "print" }),
		),
	).rejects.toThrow("Invalid bash parameters");
});

test("bash accepts null strict optional fields as omitted", async (): Promise<void> => {
	const bash = bashTool();
	const result = await bash.execute(
		"bash-null-optional-fields",
		{ command: "printf normalized", timeout: null },
		undefined,
		undefined,
		toolContextFor({ mode: "print" }),
	);
	expect(result.content).toEqual([{ type: "text", text: "normalized" }]);
});

test("aborted signal skips foreground Bash spawn", async (): Promise<void> => {
	const bash = bashTool();
	const controller = new AbortController();
	controller.abort();
	const result = await bash.execute(
		"bash-aborted-prespawn",
		{ command: "printf spawned" },
		controller.signal,
		() => undefined,
		toolContextFor(),
	);
	// Nothing ran, so there is no elapsed time to report.
	expect(result).toMatchObject({
		content: [{ type: "text", text: "Bash aborted" }],
		details: { error: "aborted" },
	});
});

test("bash reports the elapsed time and keeps partial output when cancelled", async (): Promise<void> => {
	const bash = bashTool();
	const controller = new AbortController();
	const command = "printf partial; sleep 5";
	// The stop comes from the first streamed chunk, matching what the host does when a user
	// cancels a command that is already producing output.
	const result = await bash.execute(
		"bash-aborted-running",
		{ command },
		controller.signal,
		() => {
			controller.abort();
		},
		toolContextFor(),
	);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	expect(text).toMatch(/^partial\n\nBash aborted after \d+(\.\d+)?(ms|s)$/);
	expect(result.details).toMatchObject({ error: "aborted" });
});

test("bash names the expired budget when a command times out", async (): Promise<void> => {
	const bash = bashTool();
	const result = await bash.execute(
		"bash-timed-out",
		{ command: "printf started; sleep 5", timeout: 0.2 },
		undefined,
		() => undefined,
		toolContextFor(),
	);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	expect(text).toBe("started\n\nCommand timed out after 0.2s");
	expect(result.details).toMatchObject({ timedOut: true, exitCode: 124 });
	expect(result.isError).toBe(true);
});

test("bash exposes description and snippet", (): void => {
	const bash = bashTool();
	expect(bash.description).toBe("Run one shell command or short pipeline in the foreground.");
	expect(bash.promptSnippet).toBe("Run one shell command or short pipeline in the foreground.");
	expect(bash.promptGuidelines).not.toContain(
		"Remote `target` is an authorized SSH host and always runs in the foreground.",
	);
});

test("bash removes renderer padding around short newline-terminated output", (): void => {
	const bash = bashTool();
	const theme = roleTheme;
	for (const isPartial of [true, false]) {
		const lines = bash
			.renderResult?.(
				{ content: [{ type: "text", text: "one\ntwo\n" }], details: {} },
				{ expanded: false, isPartial },
				theme,
				bashContext("printf 'one\\ntwo\\n'", isPartial),
			)
			.render(40);
		const body = lines?.filter((line) => !line.includes("─") && !line.includes("exit "));
		expect(body).toHaveLength(2);
		expect(body?.[0]).toContain("one");
		expect(body?.[1]).toContain("two");
	}
});

test("bash compacts and dims its collapsed earlier-lines hint", (): void => {
	const bash = bashTool();
	const theme = roleTheme;
	const text = bash
		.renderResult?.(
			{
				content: [
					{
						type: "text",
						text: Array.from({ length: 25 }, (_, index) => `line ${index}`).join("\n"),
					},
				],
				details: {},
			},
			{ expanded: false, isPartial: false },
			theme,
			bashContext("printf many"),
		)
		.render(120)
		.join("\n");
	expect(text).toMatch(/<dim>… \(\d+ earlier lines,/);
});

test("bash keeps its unexpanded body to the shared ToolTui height cap", (): void => {
	const bash = bashTool();
	const theme = roleTheme;
	const component = bash.renderResult?.(
		{
			content: [
				{
					type: "text",
					text: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"),
				},
			],
			details: {},
		},
		{ expanded: false, isPartial: true },
		theme,
		bashContext("printf many", true),
	);
	if (component === undefined) throw new Error("Expected bash result renderer");
	const rendered = component.render(120).filter((line) => !line.includes("─"));
	expect(rendered).toHaveLength(10);
	expect(rendered[0]).toContain("… (21 earlier lines, ctrl+o to expand)");
	expect(rendered[0]).toContain("<dim>");
	expect(rendered.at(-1)).toContain("line 30");
	expect(rendered.join("\n")).not.toContain("exit ?");
	const completed = bash.renderResult?.(
		{
			content: [
				{
					type: "text",
					text: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"),
				},
			],
			details: {},
		},
		{ expanded: true, isPartial: false },
		theme,
		bashContext("printf many"),
	);
	if (completed === undefined) throw new Error("Expected completed bash result renderer");
	const completedLines = completed
		.render(120)
		.filter((line) => !line.includes("─") && !line.includes("exit ?"));
	expect(completedLines).toHaveLength(30);
	expect(completedLines.at(-1)).toContain("line 30");
});

test("bash reports the duration Pi measured for a finished call", (): void => {
	const bash = bashTool();
	const theme = roleTheme;
	const body = bash
		.renderResult?.(
			{ content: [{ type: "text", text: "done" }], details: { totalLines: 1 } },
			{ expanded: false, isPartial: false },
			theme,
			bashContext("printf done", false, { durationMs: 12_340 }),
		)
		.render(80)
		.join("\n");
	// The body carries no footer while running: only a finished call has a measured duration.
	expect(body).toContain("<dim>Took 12.3s</dim>");
	const running = bash
		.renderResult?.(
			{ content: [{ type: "text", text: "done" }], details: { totalLines: 1 } },
			{ expanded: false, isPartial: true },
			theme,
			bashContext("printf done", true),
		)
		.render(80)
		.join("\n");
	expect(running).not.toContain("Took");
});

test("bash omitted-line count uses logical lines, not wraps or the tail window", (): void => {
	const bash = bashTool();
	const theme = roleTheme;
	const long = Array.from({ length: 30 }, (_, index) => `line ${index + 1} ${"x".repeat(80)}`).join(
		"\n",
	);
	const body = bash.renderResult?.(
		{ content: [{ type: "text", text: long }], details: {} },
		{ expanded: false, isPartial: true },
		theme,
		bashContext("printf long", true),
	);
	if (body === undefined) throw new Error("Expected wrapped bash body");
	const narrow = body.render(20).filter((line) => !line.includes("─"));
	const wide = body.render(120).filter((line) => !line.includes("─"));
	expect(narrow).toHaveLength(10);
	expect(wide).toHaveLength(10);
	expect(wide[0]).toContain("… (21 earlier lines, ctrl+o to expand)");
	const tail = bash
		.renderResult?.(
			{
				content: [{ type: "text", text: "tail-a\ntail-b\ntail-c" }],
				details: { totalLines: 80 },
			},
			{ expanded: false, isPartial: true },
			theme,
			bashContext("printf tail", true),
		)
		?.render(120)
		.filter((line) => !line.includes("─"));
	if (tail === undefined) throw new Error("Expected tailed bash body");
	expect(tail[0]).toContain("… (77 earlier lines, ctrl+o to expand)");
});

test("bash reads its live settings for output tail and shell path", async (): Promise<void> => {
	// The foreground tool owns the `bash` settings group, so a change applies to the next call
	// instead of needing a session restart.
	const bash = bashTool(() => ({ ...DEFAULT_BASH_SETTINGS, bashOutputTailKiB: 1 }));
	const result = await bash.execute(
		"bash-settings-applied",
		{ command: "printf '0123456789abcdef'" },
		undefined,
		undefined,
		toolContextFor(),
	);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	expect(text.endsWith("0123456789abcdef")).toBe(true);
});

test("bash collapses a burst of streamed chunks into few updates", async (): Promise<void> => {
	const bash = bashTool();
	let updates = 0;
	const command = "i=1; while [ $i -le 200 ]; do echo line $i; i=$((i + 1)); done";
	const result = await bash.execute(
		"bash-stream-window",
		{ command },
		undefined,
		() => {
			updates += 1;
		},
		toolContextFor(),
	);
	// 200 lines used to cost one update per stdout chunk. The streaming window rebuilds the tail
	// snapshot on the shared 100ms repaint instead, so the count stays far below the line count.
	expect(updates).toBeGreaterThan(0);
	expect(updates).toBeLessThan(20);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	expect(text).toContain("line 200");
});

test("bash refuses a command carrying a NUL byte instead of rewriting it", async (): Promise<void> => {
	const bash = bashTool();
	// Rewriting NUL to `\0` only means an escape to programs that parse escapes: `printf "%s" a\0b`
	// prints `a0b`, and a command that writes files would act on different arguments than it was given.
	await expect(
		bash.execute(
			"bash-null-byte",
			{ command: 'printf "a\0b"' },
			undefined,
			() => undefined,
			toolContextFor(),
		),
	).rejects.toThrow(/NUL byte \(U\+0000\)/u);
});
