import type {
	ExtensionAPI,
	Theme,
	ToolRendererResolver,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { createToolPresentationRenderers, textToolResult } from "@hheei/pi-ext-core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	registerCollapsibleToolRenderer,
	type ToolRenderContext,
	type ToolView,
} from "../src/index.js";
import { ToolUiRuntime } from "../src/runtime.js";

/** The state this test's runtime owns; the extension builds the same one per Pi runtime. */
const runtime = new ToolUiRuntime();

beforeEach(() => {
	runtime.clear();
	runtime.nestedCalls.setSource(undefined);
});

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	style: (text: string) => text,
} as unknown as Theme;

function context(overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
	return {
		args: { code: "text(1)" },
		toolCallId: "parent",
		invalidate: vi.fn(),
		lastComponent: undefined,
		state: {},
		cwd: "/repo",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 0,
		keyText: () => "",
		keyHint: (_keybinding, description) => description,
		...overrides,
	};
}

interface FakeEntry {
	readonly id: string;
	readonly parentId: string | null;
	readonly type: string;
	readonly message?: unknown;
}

/** The read-only session view the lifecycle hands an extension, with a movable leaf. */
function fakeSession(entries: readonly FakeEntry[], initialLeaf: string) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const state = { leaf: initialLeaf };
	const manager = {
		getLeafId: () => state.leaf,
		getEntry: (id: string) => byId.get(id),
		getBranch: (fromId?: string) => {
			const branch: FakeEntry[] = [];
			let current: string | null = fromId ?? state.leaf;
			while (current !== null) {
				const entry = byId.get(current);
				if (entry === undefined) break;
				branch.push(entry);
				current = entry.parentId;
			}
			return branch.reverse();
		},
	};
	return {
		manager: manager as unknown as Parameters<typeof runtime.nestedCalls.setSource>[0],
		switchLeaf(leaf: string): void {
			state.leaf = leaf;
		},
	};
}

function messageEntry(
	id: string,
	parentId: string | null,
	toolCallId: string,
	nestedCalls: unknown,
): FakeEntry {
	return {
		id,
		parentId,
		type: "message",
		message: { role: "toolResult", toolCallId, content: [], nestedCalls },
	};
}

function host(copyToClipboard = vi.fn(async (_text: string) => {})) {
	let resolver: ToolRendererResolver | undefined;
	const handlers = new Map<string, (event: unknown) => unknown>();
	const pi = {
		events: {},
		on(event: string, handler: (event: unknown) => unknown) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		registerToolRenderer(value: ToolRendererResolver) {
			resolver = value;
		},
	} as unknown as ExtensionAPI;
	registerCollapsibleToolRenderer(pi, runtime, { copyToClipboard });
	return {
		pi,
		handlers,
		copyToClipboard,
		resolve(name: string, native?: ToolRenderers) {
			if (resolver === undefined) throw new Error("UI not registered");
			return resolver(name, () => native)!;
		},
	};
}

/** The persisted codemode shape: a bounded argument preview plus the host's resolution facts. */
function codemodeResult(
	calls: readonly { id?: string; name: string; args?: string; status?: string; error?: string }[],
	resolved?: readonly string[],
) {
	return {
		content: [
			{ type: "text" as const, text: "Script completed\nWall time 0.1 seconds\nOutput:\nok" },
		],
		details: {
			calls,
			...(resolved === undefined ? {} : { __piExtUiResolvedCalls: resolved }),
		},
	};
}

describe("resumed nested requests", () => {
	test("a saved nested request is shown and copied byte for byte", () => {
		const command = "  ls -la\n  echo ZZ_TAIL_07 \u001b[31mred\u001b[0m";
		const session = fakeSession(
			[
				messageEntry("e1", null, "parent", {
					complete: true,
					calls: [
						{
							id: "parent/1",
							name: "bash",
							arguments: { command },
							status: "ok",
							durationMs: 5,
						},
					],
				}),
			],
			"e1",
		);
		runtime.nestedCalls.setSource(session.manager);
		try {
			const h = host();
			const view = h.resolve("codemode").renderResult!(
				codemodeResult(
					[{ id: "parent/1", name: "bash", args: '{"command":"ls', status: "ok" }],
					["parent/1"],
				),
				{ expanded: false, isPartial: false },
				theme,
				context(),
			) as ToolView;
			view.render(80);
			view.handleMouse(click(10, 1));
			const body = view.render(80).join("\n");
			expect(body).toContain("ls -la");
			expect(body).toContain("ZZ_TAIL_07");
			expect(body).not.toContain("[31m");

			view.handleMouse(click(78, 1));
			expect(h.copyToClipboard).toHaveBeenLastCalledWith(command);
		} finally {
			runtime.nestedCalls.setSource(undefined);
			runtime.clear();
		}
	});

	test("a request the session only sized is named as truncated and is not copied", () => {
		const session = fakeSession(
			[
				messageEntry("e1", null, "parent", {
					complete: false,
					calls: [{ id: "parent/1", name: "bash", argumentsBytes: 9_000, status: "ok" }],
				}),
			],
			"e1",
		);
		runtime.nestedCalls.setSource(session.manager);
		try {
			const h = host();
			const view = h.resolve("codemode").renderResult!(
				codemodeResult(
					[{ id: "parent/1", name: "bash", args: '{"command":"ls', status: "ok" }],
					["parent/1"],
				),
				{ expanded: false, isPartial: false },
				theme,
				context(),
			) as ToolView;
			view.render(80);
			view.handleMouse(click(10, 1));
			const body = view.render(80).slice(2).join("\n");
			expect(body).toContain("(request not recorded: 9000 bytes)");
			expect(body).not.toContain("ls");

			view.handleMouse(click(78, 1));
			expect(h.copyToClipboard).not.toHaveBeenCalled();
			expect(view.render(80)[1]).toContain("✗");
		} finally {
			runtime.nestedCalls.setSource(undefined);
			runtime.clear();
		}
	});

	test("switching branches drops the previous branch's calls", () => {
		const session = fakeSession(
			[
				messageEntry("e1", null, "parent", {
					complete: true,
					calls: [{ id: "parent/1", name: "bash", arguments: { command: "ls" }, status: "ok" }],
				}),
				{ id: "e2", parentId: null, type: "message", message: { role: "user", content: [] } },
			],
			"e1",
		);
		runtime.nestedCalls.setSource(session.manager);
		try {
			const h = host();
			const render = () =>
				h.resolve("codemode").renderResult!(
					codemodeResult(
						[{ id: "parent/1", name: "bash", args: '{"command":"ls', status: "ok" }],
						["parent/1"],
					),
					{ expanded: false, isPartial: false },
					theme,
					context(),
				) as ToolView;

			const first = render();
			first.render(80);
			first.handleMouse(click(10, 1));
			expect(first.render(80).join("\n")).toContain("ls");

			session.switchLeaf("e2");
			const second = render();
			second.render(80);
			second.handleMouse(click(10, 1));
			const body = second.render(80).slice(2).join("\n");
			expect(body).toContain("(request not recorded; summary only)");
			expect(body).not.toContain("ls");
		} finally {
			runtime.nestedCalls.setSource(undefined);
			runtime.clear();
		}
	});

	test("live captured arguments win over the saved record", () => {
		const session = fakeSession(
			[
				messageEntry("e1", null, "parent", {
					complete: true,
					calls: [{ id: "parent/1", name: "bash", arguments: { command: "saved" }, status: "ok" }],
				}),
			],
			"e1",
		);
		runtime.nestedCalls.setSource(session.manager);
		runtime.clear();
		try {
			runtime.tracker.recordStart({
				toolCallId: "parent/1",
				toolName: "bash",
				args: { command: "live" },
				parentToolCallId: "parent",
			});
			runtime.tracker.recordResolved({ toolCallId: "parent/1", parentToolCallId: "parent" });
			const h = host();
			const view = h.resolve("codemode").renderResult!(
				codemodeResult(
					[{ id: "parent/1", name: "bash", args: '{"command":"sa', status: "ok" }],
					["parent/1"],
				),
				{ expanded: false, isPartial: false },
				theme,
				context(),
			) as ToolView;
			view.render(80);
			view.handleMouse(click(78, 1));
			expect(h.copyToClipboard).toHaveBeenLastCalledWith("live");
		} finally {
			runtime.nestedCalls.setSource(undefined);
			runtime.clear();
		}
	});
});

describe("resolution facts", () => {
	test("the host's tool_call hook persists the facts on the parent result", () => {
		const h = host();
		h.handlers.get("tool_call")?.({
			type: "tool_call",
			toolName: "read",
			toolCallId: "parent/1",
			parentToolCallId: "parent",
			input: {},
		});
		// A top-level call is not a nested one.
		h.handlers.get("tool_call")?.({
			type: "tool_call",
			toolName: "codemode",
			toolCallId: "top",
			input: {},
		});
		const saved = h.handlers.get("tool_result")?.({
			type: "tool_result",
			toolName: "codemode",
			toolCallId: "parent",
			input: {},
			content: [],
			details: { calls: [] },
			isError: false,
		});
		expect(saved).toEqual({ details: { calls: [], __piExtUiResolvedCalls: ["parent/1"] } });
		// A nested result does not own the record; the model-issued call does.
		expect(
			h.handlers.get("tool_result")?.({
				type: "tool_result",
				toolName: "read",
				toolCallId: "parent/1",
				parentToolCallId: "parent",
				input: {},
				content: [],
				details: {},
				isError: false,
			}),
		).toBeUndefined();
		expect(
			h.handlers.get("tool_result")?.({
				type: "tool_result",
				toolName: "bash",
				toolCallId: "top",
				input: {},
				content: [],
				details: {},
				isError: false,
			}),
		).toBeUndefined();
	});

	test("only proven resolutions count; unknown calls stay visible with their error", () => {
		const h = host();
		const view = h.resolve("codemode").renderResult!(
			codemodeResult(
				[
					{ id: "parent/1", name: "grep", args: '{"pattern":"x"}', status: "ok" },
					{
						id: "parent/2",
						name: "codemodE",
						args: '{"code":"x"}',
						status: "error",
						error: "Tool codemodE not found",
					},
				],
				["parent/1"],
			),
			{ expanded: false, isPartial: false },
			theme,
			context(),
		) as ToolView;
		const rows = view.render(80);
		expect(rows[0]).toContain("1 call · 1 unknown");
		// The group counts this container's proven calls, not its rows.
		expect(view.childCount).toBe(1);
		expect(rows[2]).toContain("codemodE");
		view.handleMouse(click(10, 2));
		expect(view.render(80).join("\n")).toContain("Tool codemodE not found");
	});

	test("a resolved call that failed still counts as failed", () => {
		const h = host();
		const view = h.resolve("codemode").renderResult!(
			codemodeResult(
				[{ id: "parent/1", name: "edit", args: '{"path":"a.ts"}', status: "error" }],
				["parent/1"],
			),
			{ expanded: false, isPartial: false },
			theme,
			context(),
		) as ToolView;
		expect(view.render(80)[0]).toContain("0 ok · 1 failed");
	});

	test("a legacy record without the fact reports every call as unknown", () => {
		const h = host();
		const view = h.resolve("codemode").renderResult!(
			codemodeResult([{ id: "parent/1", name: "grep", args: '{"pattern":"x"}', status: "ok" }]),
			{ expanded: false, isPartial: false },
			theme,
			context(),
		) as ToolView;
		expect(view.render(80)[0]).toContain("0 calls · 1 unknown");
		// Zero proven calls is a real answer: the container must not fall back to counting as one.
		expect(view.childCount).toBe(0);
	});
});

describe("owner board with child facts", () => {
	test("draws its children, expands a saved request, and copies it", () => {
		const command = "ls -la\necho ZZ_OWNER";
		const session = fakeSession(
			[
				messageEntry("e1", null, "cell", {
					complete: true,
					calls: [{ id: "cell/1", name: "bash", arguments: { command }, status: "ok" }],
				}),
			],
			"e1",
		);
		runtime.nestedCalls.setSource(session.manager);
		try {
			const h = host();
			const native = createToolPresentationRenderers(h.pi, "python_eval", () => ({
				summary: "1 call",
				children: [{ id: "cell/1", title: "bash", summary: "ls -la", status: "ok", durationMs: 5 }],
				childCount: 1,
			}));
			const view = h.resolve("python_eval", native).renderResult!(
				textToolResult("plain", undefined),
				{ expanded: false, isPartial: false },
				theme,
				context({ toolCallId: "cell", args: { code: "text(1)" } }),
			) as ToolView;
			const rows = view.render(80);
			expect(rows[1]).toContain("✓ bash ls -la · 5ms");

			view.handleMouse(click(10, 1));
			expect(view.render(80).join("\n")).toContain("ZZ_OWNER");
			view.handleMouse(click(78, 1));
			expect(h.copyToClipboard).toHaveBeenLastCalledWith(command);
		} finally {
			runtime.nestedCalls.setSource(undefined);
			runtime.clear();
		}
	});
});

function click(x: number, y: number, extra: { shift?: boolean; ctrl?: boolean } = {}) {
	return {
		type: "click" as const,
		button: "left" as const,
		x,
		y,
		screenX: x,
		screenY: y,
		width: 80,
		height: 20,
		shift: extra.shift === true,
		alt: false,
		ctrl: extra.ctrl === true,
	};
}
