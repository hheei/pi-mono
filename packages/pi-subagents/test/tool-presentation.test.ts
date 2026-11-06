import type {
	ExtensionAPI,
	Theme,
	ToolDefinition,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import {
	agentResultText,
	getToolPresentationProvider,
	hasOptionalToolRenderers,
	registerExtensionHook,
	textToolResult,
	toolRendererPoint,
} from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import type { SubagentManager } from "../src/manager.js";
import { registerChildTools, registerParentTools } from "../src/tools.js";

/** No styling, so rendered rows can be asserted as plain text. */
const plainTheme = {
	bg: (_role: string, text: string): string => text,
	fg: (_role: string, text: string): string => text,
	bold: (text: string): string => text,
} as Theme;

/** Providers receive the render context so a presentation can read the live call args. */
const plainContext = { args: {}, isError: false, isPartial: false } as never;

function createFakePi(): { pi: ExtensionAPI; tools: ToolDefinition[] } {
	const tools: ToolDefinition[] = [];
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		getAllTools() {
			return tools;
		},
		getActiveTools() {
			return tools.map((tool) => tool.name);
		},
		setActiveTools() {},
		on() {
			return () => {};
		},
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

function registeredTools(): ToolDefinition[] {
	const { pi, tools } = createFakePi();
	registerParentTools(pi, {} as unknown as SubagentManager, []);
	return tools;
}

function registeredChildTools(): { pi: ExtensionAPI; tools: ToolDefinition[] } {
	const { pi, tools } = createFakePi();
	registerChildTools(
		pi,
		{
			parentSessionId: "parent",
			subagentId: "agent-1",
			runtimeIdentity: "runtime",
			endpoint: "/bridge",
		},
		{ report: async () => undefined },
	);
	return { pi, tools };
}

function toolNamed(name: string): ToolDefinition {
	const tool = registeredTools().find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`${name} was not registered`);
	return tool;
}

function renderText(component: { render(width: number): string[] }): string {
	return component
		.render(200)
		.map((line) => line.trimEnd())
		.join("\n");
}

function renderCallText(tool: ToolDefinition, args: unknown): string {
	if (tool.renderCall === undefined) throw new Error("missing renderCall");
	return renderText(tool.renderCall(args as never, plainTheme, {} as never));
}

function renderResultText(
	tool: ToolDefinition,
	result: { content: readonly { type: string; text?: string }[]; details?: unknown },
	args: unknown,
): string {
	if (tool.renderResult === undefined) throw new Error("missing renderResult");
	return renderText(
		tool.renderResult(result as never, { expanded: false, isPartial: false }, plainTheme, {
			args,
			isError: false,
		} as never),
	);
}

const view = {
	id: "agent-9",
	revision: 3,
	status: "completed" as const,
	task: "Inspect the deck",
	hasOutput: true,
	agent: "scout",
	resultText: "Deck looks fine",
	progress: { runtimeState: "done" as const, summary: "finished" },
};

describe("agent tool presentation providers", () => {
	test("every tool exposes an owned provider", () => {
		for (const name of ["agents_delegate", "agents_get", "agents_stop", "agents_dashboard"]) {
			const renderers: ToolRenderers = toolNamed(name);
			expect(getToolPresentationProvider(renderers)).toBeTypeOf("function");
		}
	});

	test("delegate summary carries the agent and request the task", () => {
		const provider = getToolPresentationProvider(toolNamed("agents_delegate"))!;
		const presentation = provider(
			{ agent: "scout", task: "Inspect the deck" },
			undefined,
			plainTheme,
			plainContext,
		);
		expect(presentation.summary).toBe("scout");
		expect(presentation.request).toBe("Inspect the deck");
		expect(presentation.output).toBeUndefined();
	});

	test("delegate result names the agent, its id and the revision", () => {
		const provider = getToolPresentationProvider(toolNamed("agents_delegate"))!;
		const presentation = provider(
			{ agent: "scout", task: "Inspect the deck" },
			textToolResult(JSON.stringify(view), view),
			plainTheme,
			plainContext,
		);
		expect(presentation.summary).toBe("scout · agent-9 · rev 3");
		expect(presentation.output).toBe("Deck looks fine");
		expect(presentation.copy).toEqual({
			primary: "Inspect the deck",
			full: "Inspect the deck\n---\nDeck looks fine",
		});
	});

	test("a delegation without output still shows its state instead of a raw body", () => {
		const provider = getToolPresentationProvider(toolNamed("agents_delegate"))!;
		const presentation = provider(
			{ id: "agent-9", task: "keep going" },
			textToolResult("{}", { ...view, hasOutput: false, resultText: undefined }),
			plainTheme,
			plainContext,
		);
		expect(presentation.summary).toBe("scout · agent-9 · rev 3");
		expect(presentation.output).toBe(
			"status: completed\nrevision: 3\nruntime: done\nsummary: finished\nhasOutput: false",
		);
	});

	test("get renders delegation state instead of raw JSON", () => {
		const provider = getToolPresentationProvider(toolNamed("agents_get"))!;
		const presentation = provider(
			{ id: "agent-9" },
			textToolResult("", view),
			plainTheme,
			plainContext,
		);
		expect(presentation.summary).toBe("agent-9");
		expect(presentation.request).toBe("without output");
		expect(presentation.output).toContain("status: completed");
		expect(presentation.output).toContain("hasOutput: true");
		expect(presentation.collapsedRows).toEqual(["completed · scout · done · rev 3"]);
		expect(presentation.output).not.toContain("{");
	});

	test("get names the requested revision and whether the body was read", () => {
		const provider = getToolPresentationProvider(toolNamed("agents_get"))!;
		const presentation = provider(
			{ id: "agent-9", revision: 2, includeOutput: true },
			textToolResult("", { ...view, revision: 2, sessionPath: "/path/to/session.jsonl" }),
			plainTheme,
			plainContext,
		);
		expect(presentation.summary).toBe("agent-9 · rev 2");
		expect(presentation.request).toBe("with output");
		expect(presentation.output).toContain("sessionPath: /path/to/session.jsonl");
		expect(presentation.output).toContain("Deck looks fine");
		expect(presentation.copy).toEqual({ primary: "Deck looks fine" });
	});

	test("stop summary carries the id and the confirmation text", () => {
		const provider = getToolPresentationProvider(toolNamed("agents_stop"))!;
		const presentation = provider(
			{ id: "agent-9" },
			textToolResult("Agent agent-9 stopped; revision 3 is failed.", undefined),
			plainTheme,
			plainContext,
		);
		expect(presentation.summary).toBe("agent-9");
		expect(presentation.output).toBe("Agent agent-9 stopped; revision 3 is failed.");
	});

	test("dashboard summarises counts and every agent", () => {
		const provider = getToolPresentationProvider(toolNamed("agents_dashboard"))!;
		const presentation = provider(
			{},
			textToolResult("", {
				total: 2,
				running: 1,
				blocked: 0,
				completed: 1,
				failed: 0,
				children: [
					{
						id: "agent-9",
						agent: "scout",
						runtimeState: "done",
						revision: 3,
						status: "completed",
						hasOutput: true,
					},
					{
						id: "agent-10",
						agent: "worker",
						runtimeState: "running",
						revision: 1,
						status: "accepted",
						hasOutput: false,
						summary: "reading",
					},
				],
			}),
			plainTheme,
			plainContext,
		);
		expect(presentation.summary).toBe("2 agents · running 1 · blocked 0 · completed 1 · failed 0");
		expect(presentation.output).toBe(
			"- agent-9 (scout): done / completed · rev 3\n- agent-10 (worker): running / accepted · rev 1 — reading",
		);
	});

	test("unknown args narrow to a bare summary without throwing", () => {
		for (const name of ["agents_delegate", "agents_get", "agents_stop", "agents_dashboard"]) {
			const provider = getToolPresentationProvider(toolNamed(name))!;
			expect(() => provider("nonsense", undefined, plainTheme, plainContext)).not.toThrow();
			expect(() => provider(undefined, undefined, plainTheme, plainContext)).not.toThrow();
		}
	});
});

describe("native renderer fallback without pi-ext-ui", () => {
	test("delegate renderCall keeps the agent, summary and full task", () => {
		const text = renderCallText(toolNamed("agents_delegate"), {
			agent: "scout",
			task: "Inspect the deck",
		});
		expect(text).toContain("agents_delegate");
		expect(text).toContain("scout");
		expect(text).toContain("Inspect the deck");
	});

	test("delegate renderResult keeps the delegation identity and result", () => {
		const text = renderResultText(
			toolNamed("agents_delegate"),
			textToolResult(JSON.stringify(view), view),
			{ agent: "scout", task: "Inspect the deck" },
		);
		expect(text).toBe("Deck looks fine");
	});

	test("get renderResult prints readable delegation fields", () => {
		const text = renderResultText(
			toolNamed("agents_get"),
			textToolResult("", { ...view, hasOutput: false, resultText: undefined }),
			{ id: "agent-9" },
		);
		expect(text).toBe(
			"status: completed\nrevision: 3\nruntime: done\nsummary: finished\nhasOutput: false",
		);
	});

	test("errors keep their raw text through the native renderer", () => {
		const tool = toolNamed("agents_stop");
		const result = { content: [{ type: "text" as const, text: "Unknown child" }], isError: true };
		const text = renderText(
			tool.renderResult!(result as never, { expanded: false, isPartial: false }, plainTheme, {
				args: { id: "agent-9" },
				isError: true,
			} as never),
		);
		expect(text).toBe(agentResultText(result as never));
	});
});

describe("optional renderer point", () => {
	test("every tool is self-framed and owned, so a UI resolver never adds a second frame", () => {
		for (const name of ["agents_delegate", "agents_get", "agents_stop", "agents_dashboard"]) {
			const tool = toolNamed(name);
			expect(tool.renderShell).toBe("self");
			expect(hasOptionalToolRenderers(tool)).toBe(true);
		}
	});

	test("contact_parent is self-framed and owned too", () => {
		const { tools } = registeredChildTools();
		const tool = tools[0];
		expect(tool?.name).toBe("contact_parent");
		expect(tool?.renderShell).toBe("self");
		expect(hasOptionalToolRenderers(tool)).toBe(true);
		expect(getToolPresentationProvider(tool)).toBeTypeOf("function");
	});

	test("contact_parent header names the reason and keeps the message readable", () => {
		const { tools } = registeredChildTools();
		const tool = tools[0];
		const args = { message: "Which branch?", reason: "blocked" as const };
		expect(renderCallText(tool as ToolDefinition, args)).toBe(
			"contact_parent blocked\nWhich branch?",
		);
		expect(
			renderResultText(
				tool as ToolDefinition,
				textToolResult("Blocker report queued for the parent.", undefined),
				args,
			),
		).toBe("Blocker report queued for the parent.");
	});

	test("a loaded UI factory decorates the native renderers and disposing restores them", async () => {
		const { pi, tools } = createFakePi();
		registerParentTools(pi, {} as unknown as SubagentManager, []);
		const tool = tools.find((candidate) => candidate.name === "agents_delegate");
		if (tool === undefined) throw new Error("agents_delegate was not registered");

		let received: ToolRenderers | undefined;
		const handle = registerExtensionHook(pi, toolRendererPoint, (name, native) => {
			if (name !== "agents_delegate") return native;
			received = native;
			return { renderShell: "self", renderCall: () => new Text("rich agents_delegate", 0, 0) };
		});
		await handle.ready;

		expect(renderCallText(tool, { agent: "scout", task: "Inspect the deck" })).toBe(
			"rich agents_delegate",
		);
		// The factory receives the native renderers, so the typed presentation stays reachable.
		expect(getToolPresentationProvider(received)).toBeTypeOf("function");

		await handle.dispose();
		expect(
			stripTerminalSequences(renderCallText(tool, { agent: "scout", task: "Inspect the deck" })),
		).toBe("agents_delegate scout\nInspect the deck");
	});
});
