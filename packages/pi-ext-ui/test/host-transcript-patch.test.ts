import {
	AssistantMessageComponent,
	type ExtensionContext,
	type ExtensionUIContext,
	InteractiveMode,
	initTheme,
	type Theme,
	ToolExecutionComponent,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Spacer,
	Text,
	type TUI,
	TuiMainScreen,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { installHostToolGroups } from "../src/host-transcript-patch.js";
import { createMessageView } from "../src/message-view.js";
import { type ToolStatusKind, ToolView, type ToolViewChild } from "../src/tool-view.js";

/** The runtime's background preference, as the extension would hold it. */
let backgrounds = false;

const theme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
} as Theme;
/** A theme that keeps its tokens visible, so a test can assert semantic color, not only text. */
const tokens = {
	fg: (token: string, text: string) => `[${token}]${text}[/]`,
	bg: (token: string, text: string) => `[bg:${token}]${text}[/bg]`,
	bold: (text: string) => text,
	italic: (text: string) => text,
} as Theme;
const cleanups: (() => void)[] = [];
const seam = "getRegisteredToolDefinition";
const originalSeam = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, seam);
const noticeSeam = "showExtensionNotify";
const originalNoticeSeam = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, noticeSeam);

beforeAll(() => initTheme("dark", false));
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	expect(Object.getOwnPropertyDescriptor(InteractiveMode.prototype, seam)).toEqual(originalSeam);
	expect(Object.getOwnPropertyDescriptor(InteractiveMode.prototype, noticeSeam)).toEqual(
		originalNoticeSeam,
	);
});

function assistant(
	ids: string[],
	mixed: boolean | "text" = false,
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number },
	thinking = "reason",
): AssistantMessageComponent {
	type Message = Parameters<AssistantMessageComponent["updateContent"]>[0];
	const message: Message = {
		role: "assistant",
		content: [
			...(mixed === "text"
				? [{ type: "text" as const, text: "prose boundary" }]
				: mixed
					? [{ type: "thinking" as const, thinking }]
					: []),
			...ids.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: {} })),
		],
		api: "openai-completions",
		provider: "openai",
		model: "fixture",
		usage: {
			input: usage?.input ?? 0,
			output: usage?.output ?? 0,
			cacheRead: usage?.cacheRead ?? 0,
			cacheWrite: usage?.cacheWrite ?? 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
	return new AssistantMessageComponent(message);
}

function setup(connect = true, uiTheme: Theme = theme) {
	let expanded = false;
	let idle = true;
	const notify = vi.fn();
	const requestRender = vi.fn();
	const copyToClipboard = vi.fn(async (_text: string) => {});
	// Obtain the complete native UI facade; override only services exercised here.
	const host: object = Object.create(InteractiveMode.prototype);
	const ui: ExtensionUIContext = Reflect.apply(
		Reflect.get(host, "createExtensionUIContext"),
		host,
		[],
	);
	Object.defineProperty(ui, "theme", { value: uiTheme });
	Object.assign(ui, {
		notify,
		getToolsExpanded: () => expanded,
		setToolsExpanded: (value: boolean) => {
			expanded = value;
		},
	});
	const context = { ui, mode: "tui", isIdle: () => idle } as ExtensionContext;
	const chat = new Container();
	const definitions = new Map<string, ToolRenderers>();
	const resolve = vi.fn((name: string) => definitions.get(name));
	// Use the real host prototype; only session services are fixture-owned.
	Object.defineProperties(host, {
		chatContainer: { value: chat },
		ui: { value: { requestRender } },
		session: {
			value: {
				extensionRunner: {
					getUIContext: () => ui,
					resolveToolRenderers: resolve,
				},
			},
		},
	});
	const lookup = (name: string): unknown => Reflect.apply(Reflect.get(host, seam), host, [name]);
	const originals = {
		render: chat.render,
		handleMouse: chat.handleMouse,
		invalidate: chat.invalidate,
	};
	const patch = installHostToolGroups(
		context,
		() => backgrounds,
		() => 1,
	);
	cleanups.push(patch.dispose);
	if (connect) lookup("fixture");
	const notice = (message: string, type: "info" | "warning" | "error" = "info") =>
		Reflect.apply(Reflect.get(host, noticeSeam), host, [message, type]);
	const row = (
		id: string,
		name = "read",
		status: ToolStatusKind = "ok",
		callError = false,
		complete = true,
		children?: ToolViewChild[],
		childCount?: number,
		board?: readonly string[],
	) => {
		let callView: ToolView | undefined;
		// Real TUI prototype, with the only service used by ToolExecutionComponent replaced.
		const tui: TUI = Object.assign(Object.create(TuiMainScreen.prototype), { requestRender });
		const tool = new ToolExecutionComponent(
			name,
			id,
			{},
			{ showImages: false },
			{
				renderShell: "self",
				renderCall: (args, _theme, ctx) => {
					if (callError) throw new Error("call renderer failed");
					callView = new ToolView({
						background: () => backgrounds,
						theme,
						header: {
							title: name,
							status: ctx.argsComplete ? "running" : "streaming",
							summary: JSON.stringify(args),
						},
						outputPad: ctx.outputPad,
					});
					if (complete) callView.hide();
					return callView;
				},
				renderResult: (_result, options, _theme, ctx) => {
					callView?.hide();
					return new ToolView({
						background: () => backgrounds,
						theme,
						header: {
							title: name,
							status: ctx.isError ? "error" : options.isPartial ? "running" : status,
						},
						outputPad: ctx.outputPad,
						...(children === undefined ? {} : { children }),
						...(childCount === undefined ? {} : { childCount }),
						...(board === undefined ? {} : { collapsedRows: board }),
						sections: [{ railToken: "dim", content: `RESULT ${id}` }],
						copy: { primary: `COPY ${id}` },
						copyToClipboard,
						defaultLevel: board === undefined ? 1 : 0,
					});
				},
			},
			tui,
			process.cwd(),
		);
		if (complete) {
			tool.setArgsComplete();
			tool.markExecutionStarted();
			tool.updateResult({ content: [{ type: "text", text: `RESULT ${id}` }], isError: false });
		}
		return tool;
	};
	return {
		chat,
		patch,
		context,
		host,
		originals,
		notify,
		requestRender,
		resolve,
		lookup,
		notice,
		row,
		begin: () => patch.beginRun(),
		copyToClipboard,
		setIdle: (value: boolean) => {
			idle = value;
		},
		setExpanded: (value: boolean) => {
			expanded = value;
		},
	};
}

function click(chat: Container, y: number, width = 80, x = 0) {
	const height = chat.render(width).length;
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x,
		y,
		screenX: 0,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
	};
	return chat.handleMouse(event);
}

function show(chat: Container, width = 80): string {
	// The group background fills every row to the terminal width; trailing padding is not content.
	return chat
		.render(width)
		.map((row) => row.trimEnd())
		.join("\n");
}

function clickRow(chat: Container, needle: string) {
	const index = chat.render(80).findIndex((row) => row.includes(needle));
	if (index < 0) throw new Error(`No transcript row matching ${needle}`);
	return click(chat, index);
}

/** The category row and its item label can read alike; pick the nth match instead of the first. */
function clickRowAt(chat: Container, needle: string, occurrence: number) {
	const index = chat.render(80).flatMap((row, at) => (row.includes(needle) ? [at] : []))[
		occurrence
	];
	if (index === undefined)
		throw new Error(`No transcript row #${String(occurrence)} matching ${needle}`);
	return click(chat, index);
}

describe("tail total-height minimum", () => {
	test.each([
		false,
		true,
	])("a tail that can still grow keeps the four-row floor (grouped=%s)", (grouped) => {
		const f = setup();
		f.begin();
		const prefix = grouped ? [assistant(["a", "b"]), f.row("a"), f.row("b")] : [];
		// A live row draws the shared spinner clock, so two renders a frame apart would differ.
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		backgrounds = true;
		try {
			for (const width of [30, 120]) {
				const tool = f.row("tail", "read", "ok", false, false);
				f.chat.children = [...prefix, tool];
				const native = tool.render(width);
				expect(native.length).toBeLessThanOrEqual(4);
				const first = f.chat.render(width);
				const tail = first.slice(-4);
				expect(tail.slice(0, native.length)).toEqual(native);
				expect(tail.slice(native.length)).toEqual(
					Array.from({ length: 4 - native.length }, () => ""),
				);
				expect(f.chat.render(width)).toEqual(first);
				for (let y = first.length - (4 - native.length); y < first.length; y++) {
					expect(click(f.chat, y, width)?.handled).not.toBe(true);
				}
			}
		} finally {
			clock.mockRestore();
			backgrounds = false;
		}
	});

	test.each([false, true])("one-row tails pass through without padding (grouped=%s)", (grouped) => {
		const colored = {
			...theme,
			bg: (_token: string, text: string) => `\x1b[44m${text}\x1b[49m`,
		} as Theme;
		const f = setup(true, colored);
		f.begin();
		const prefix = grouped ? [assistant(["a", "b"]), f.row("a"), f.row("b")] : [];
		const message = new Container();
		message.addChild(new Spacer(1));
		message.addChild(createMessageView({ theme: colored, header: { kind: "notice" } }));
		const thinking = assistant([], true, undefined, "one thought");
		thinking.setHideThinkingBlock(true);
		for (const tail of [message, thinking]) {
			f.chat.children = [...prefix, tail];
			const native = tail.render(40);
			const render = vi.spyOn(tail, "render");
			const first = f.chat.render(40);
			expect(render).toHaveBeenCalledTimes(1);
			expect(first.slice(-native.length)).toEqual(native);
			expect(f.chat.render(40)).toEqual(first);
			render.mockRestore();
		}
	});

	test.each([
		false,
		true,
	])("tools exclude color padding and never retain tall frames (grouped=%s)", (grouped) => {
		const f = setup();
		f.begin();
		const prefix = grouped ? [assistant(["a", "b"]), f.row("a"), f.row("b")] : [];
		for (const background of [false, true]) {
			backgrounds = background;
			try {
				for (const count of [1, 2, 4, 1]) {
					const tool = f.row(
						"tail",
						"read",
						"ok",
						false,
						true,
						undefined,
						undefined,
						Array.from({ length: count - 1 }, (_, i) => `row ${i}`),
					);
					f.chat.children = [...prefix, assistant(["tail"]), tool];
					const native = tool.render(40);
					const first = f.chat.render(40);
					expect(first.slice(-native.length)).toEqual(native);
					expect(f.chat.render(40)).toEqual(first);
				}
			} finally {
				backgrounds = false;
			}
		}
	});

	test.each([
		false,
		true,
	])("notify replaces thinking without cross-frame feedback (grouped=%s)", (grouped) => {
		const f = setup();
		f.begin();
		f.chat.children = grouped ? [assistant(["a", "b"]), f.row("a"), f.row("b")] : [];
		f.chat.addChild(assistant([], true, undefined, "one thought"));
		expect(f.chat.render(40).at(-1)).toBe("");
		f.notice("short notice");
		const first = f.chat.render(40);
		expect(first.at(-1)).toContain("short notice");
		expect(f.chat.render(40)).toEqual(first);
	});

	test("an empty assistant placeholder leaves the preceding visible tail", () => {
		const f = setup();
		f.notice("visible");
		f.chat.addChild(assistant(["pending"]));
		expect(f.chat.render(40).map((row) => row.trimEnd())).toEqual(["", " visible"]);
	});

	test.each([30, 120])("custom notices preserve 1/2/3 content rows at width %i", (width) => {
		const f = setup();
		for (const count of [1, 2, 3, 1]) {
			const message = new Container();
			message.addChild(new Spacer(1));
			message.addChild(
				createMessageView({
					theme,
					header: { kind: "notice" },
					preview: Array.from({ length: count - 1 }, (_, i) => `内容 ${i}`),
				}),
			);
			f.chat.children = [message];
			const first = f.chat.render(width);
			const native = message.render(width);
			expect(first).toEqual(native);
			expect(f.chat.render(width)).toEqual(first);
			for (const line of first) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test.each([
		30, 120,
	])("thinking clicks and resize use actual rows, not remembered height (%i)", (width) => {
		const f = setup();
		const thinking = assistant([], true, undefined, "long reasoning ".repeat(20));
		thinking.setHideThinkingBlock(true);
		f.chat.children = [thinking];
		const folded = f.chat.render(width);
		expect(folded).toEqual(thinking.render(width));
		expect(click(f.chat, 1, width)?.handled).toBe(true);
		const expanded = f.chat.render(width);
		expect(expanded.length).toBeGreaterThan(3);
		expect(expanded).toEqual(thinking.render(width));
		expect(click(f.chat, 1, width)?.handled).toBe(true);
		expect(f.chat.render(width)).toEqual(folded);
	});

	test("streaming tool completion and background changes refresh decoration even on cached renders", () => {
		const f = setup();
		const tool = f.row("tail", "read", "ok", false, false);
		f.chat.children = [tool];
		backgrounds = true;
		try {
			const first = f.chat.render(40);
			expect(first.join("\n")).toContain(tool.render(40).join("\n"));
			tool.setArgsComplete();
			tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
			const view: unknown = Reflect.get(tool, "resultRendererComponent");
			if (!(view instanceof ToolView)) throw new Error("Expected the installed tool renderer");
			view.setFoldLevel(0);
			const completed = f.chat.render(40);
			expect(completed.join("\n")).toContain(view.render(40).join("\n"));
			expect(f.chat.render(40)).toEqual(completed);
			backgrounds = false;
			const quiet = f.chat.render(40);
			expect(quiet.length).toBeLessThan(completed.length);
			expect(quiet.join("\n")).toContain(view.render(40).join("\n"));
		} finally {
			backgrounds = false;
		}
	});

	test("multi-part thinking pads only the complete tail and an empty tail creates no rows", () => {
		const f = setup();
		f.chat.children = [assistant([])];
		expect(f.chat.render(40)).toEqual([]);
		const one = assistant([], true, undefined, "first thought");
		const two = assistant([], true, undefined, "second thought");
		f.chat.children = [one, two];
		const rows = f.chat.render(40);
		expect(rows.at(-1)).toContain("second thought");
		expect(rows.filter((row) => row.includes("first thought"))).toHaveLength(1);
		expect(rows.filter((row) => row.includes("second thought"))).toHaveLength(1);
		expect(f.chat.render(40)).toEqual(rows);
	});

	test("ending a run absorbs the tail and the surface fade keeps the row count", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		f.notice("tail notice");
		const live = f.chat.render(40);
		expect(live.at(-1)).toContain("tail notice");
		f.patch.endRun();
		now.mockReturnValue(6_000);
		const ended = f.chat.render(40);
		expect(ended.some((row) => row.includes("tail notice"))).toBe(true);
		expect(ended.length).toBeLessThanOrEqual(live.length);
		const prose = assistant([], "text");
		f.chat.addChild(prose);
		const after = f.chat.render(40);
		expect(after.at(-1)).not.toBe("");
		expect(after.slice(-prose.render(40).length)).toEqual(prose.render(40));
	});
});

describe("two centralized host seams / original transcript projection", () => {
	test("counts real adjacent tools; preserves children and original methods on disposal", () => {
		const f = setup();
		f.begin();
		const rows = [assistant(["a", "b", "c"]), f.row("a"), f.row("b"), f.row("c", "grep")];
		f.chat.children = rows;
		expect(show(f.chat)).toContain("▸ read ×2");
		expect(show(f.chat)).toContain("3 calls");
		expect(show(f.chat)).toContain("✓ grep");
		// The last unit stays outside the group, drawn by its own component at its own fold level.
		expect(show(f.chat)).toContain("RESULT c");
		expect(show(f.chat)).not.toContain("RESULT a");
		expect(f.chat.children).toBe(rows);
		f.patch.dispose();
		f.patch.dispose();
		expect(f.chat.render).toBe(f.originals.render);
		expect(f.chat.handleMouse).toBe(f.originals.handleMouse);
		expect(f.chat.invalidate).toBe(f.originals.invalidate);
		expect(show(f.chat)).toContain("RESULT a");
	});

	test.each([30, 80, 120])("adjacent native notices form a group at %i columns", (width) => {
		const f = setup();
		f.begin();
		f.notice("FIRST NOTICE");
		expect(show(f.chat, width)).not.toContain("collapse views");
		f.notice("SECOND NOTICE", "warning");
		expect(show(f.chat, width)).not.toContain("collapse views");
		f.notice("THIRD NOTICE");
		expect(show(f.chat, width)).not.toContain("collapse views");
		f.notice("FOURTH NOTICE");
		expect(show(f.chat, width)).toContain("collapse views");
		expect(show(f.chat)).toContain("0 calls");
		expect(show(f.chat, width)).not.toContain("FIRST NOTICE");
		clickRow(f.chat, "▸ notice");
		expect(show(f.chat, width)).toContain("FIRST NOTICE");
		expect(show(f.chat, width)).toContain("SECOND NOTICE");
		for (const row of f.chat.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	});

	test("two notices and one streaming tool form a group without counting an unfinished call", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a"]), f.row("a", "read", "ok", false, false)];
		expect(show(f.chat)).not.toContain("collapse views");
		f.notice("NOTICE AFTER TOOL");
		expect(show(f.chat)).not.toContain("collapse views");
		f.notice("ANOTHER NOTICE");
		expect(show(f.chat)).toContain("collapse views");
		expect(show(f.chat)).toContain("0 calls");
		// The unfinished call is listed but adds no number; the last notice is the unit outside.
		expect(show(f.chat)).toContain("▸ tools");
		clickRow(f.chat, "▸ tools");
		expect(show(f.chat)).toMatch(/[·✢✳✶✻✽] read/);
		clickRow(f.chat, "▸ notice");
		expect(show(f.chat)).toContain("NOTICE AFTER TOOL");
	});

	test("adjacent MessageViews group without tools and preserve their bodies", () => {
		const f = setup();
		for (const summary of ["first message", "second message", "third message", "fourth message"]) {
			const notice = new Container();
			notice.addChild(
				createMessageView({ theme, header: { kind: "memory", summary }, body: `${summary} body` }),
			);
			f.chat.addChild(notice);
		}
		expect(show(f.chat)).toContain("collapse views");
		clickRow(f.chat, "▸ notice");
		expect(show(f.chat)).toContain("first message");
		expect(show(f.chat)).toContain("second message");
		clickRow(f.chat, "▸ memory · first message");
		expect(show(f.chat)).toContain("first message body");
	});

	test.each([
		{ notices: 0, thinking: 0, tools: 1, grouped: false },
		{ notices: 0, thinking: 0, tools: 2, grouped: true },
		{ notices: 3, thinking: 0, tools: 0, grouped: false },
		{ notices: 4, thinking: 0, tools: 0, grouped: true },
		{ notices: 0, thinking: 3, tools: 0, grouped: false },
		// Consecutive thinking blocks are one run, so four of them weigh 0.5, not 2.
		{ notices: 0, thinking: 4, tools: 0, grouped: false },
		{ notices: 1, thinking: 0, tools: 1, grouped: false },
		{ notices: 0, thinking: 1, tools: 1, grouped: false },
		{ notices: 1, thinking: 1, tools: 1, grouped: true },
		// A notice between two thinking blocks splits the run, so each one weighs again.
		{ notices: 1, thinking: 3, tools: 0, grouped: false },
		{ notices: 3, thinking: 1, tools: 0, grouped: true },
		{ notices: 2, thinking: 2, tools: 0, grouped: true },
	])("weighted group threshold: $notices notices, $thinking thinking, $tools tools", ({
		notices,
		thinking,
		tools,
		grouped,
	}) => {
		const f = setup();
		const ids = Array.from({ length: tools }, (_, index) => `tool-${index}`);
		const children: Component[] = [];
		for (let index = 0; index < Math.max(notices, thinking); index++) {
			if (index < notices) {
				const notice = new Container();
				notice.addChild(
					createMessageView({ theme, header: { kind: "memory", summary: `n${index}` } }),
				);
				children.push(notice);
			}
			if (index < thinking) children.push(assistant([], true));
		}
		children.push(assistant(ids), ...ids.map((id) => f.row(id)));
		f.chat.children = children;
		expect(show(f.chat).includes("collapse views")).toBe(grouped);
	});

	test("empty thinking and assistant placeholders do not add group weight", () => {
		const f = setup();
		f.chat.children = [
			assistant([], true, undefined, ""),
			assistant([]),
			assistant([]),
			assistant([]),
		];
		for (let index = 0; index < 3; index++) f.notice(`notice ${index}`);
		expect(show(f.chat)).not.toContain("collapse views");
	});

	test("mouse and global expansion retain local choices and original child hit testing", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		expect(clickRow(f.chat, "collapse views")).toMatchObject({ handled: true });
		expect(show(f.chat)).toContain("RESULT a");
		f.setExpanded(true);
		expect(show(f.chat)).toContain("RESULT a");
		f.setExpanded(false);
		expect(show(f.chat)).not.toContain("RESULT a");
		// The tail keeps its own component in every mode, so its rows never blink out.
		expect(show(f.chat)).toContain("RESULT b");
		f.setExpanded(true);
		expect(show(f.chat)).toContain("RESULT b");
	});

	test("unknown nodes, including empty nodes, break groups", () => {
		const f = setup();
		f.begin();
		f.chat.children = [
			assistant(["a", "b", "c", "d"]),
			f.row("a"),
			f.row("b"),
			new Text("NOTICE", 0, 0),
			f.row("c"),
			f.row("d"),
		];
		expect(show(f.chat).match(/collapse views/g)).toHaveLength(2);
		expect(show(f.chat).match(/requests ×1/g)).toHaveLength(1);
		expect(show(f.chat)).toContain("NOTICE");
		f.chat.children.splice(3, 1, { render: () => [], invalidate() {} });
		expect(show(f.chat).match(/collapse views/g)).toHaveLength(2);
		expect(show(f.chat)).not.toContain("4 calls");
	});

	test("the tools row lists effective calls and the header toggles the raw view", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		expect(clickRow(f.chat, "▸ read")).toMatchObject({ handled: true });
		expect(show(f.chat)).toContain("▾ read ×1");
		expect(show(f.chat)).toContain("✓ read");
		expect(clickRow(f.chat, "read ×1")).toMatchObject({ handled: true });
		expect(show(f.chat)).toContain("▸ read ×1");
		expect(clickRow(f.chat, "collapse views")).toMatchObject({ handled: true });
		expect(show(f.chat)).toContain("RESULT a");
		expect(show(f.chat)).toContain("▾ collapse views");
		expect(clickRow(f.chat, "collapse views")).toMatchObject({ handled: true });
		expect(show(f.chat)).not.toContain("RESULT a");
		expect(show(f.chat)).toContain("▸ collapse views");
	});

	test("expanded member clicks use original tool geometry", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		clickRow(f.chat, "collapse views");
		const header = f.chat.render(80).findIndex((line, index) => index > 1 && line.includes("read"));
		expect(header).toBeGreaterThan(1);
		expect(click(f.chat, header, 80, 2)).toMatchObject({ handled: true });
		expect(show(f.chat)).not.toContain("RESULT a");
		expect(show(f.chat)).toContain("RESULT b");
	});

	test("expanded tools are consecutive while body blank lines remain intact", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		clickRow(f.chat, "collapse views");
		expect(show(f.chat)).toContain("RESULT a");
		expect(show(f.chat)).toContain("▾ ✓ read");
		const tool = f.chat.children[1];
		expect(tool).toBeInstanceOf(ToolExecutionComponent);
		if (!(tool instanceof ToolExecutionComponent)) throw new Error("Missing fixture tool");
		tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		const view = Reflect.get(tool, "resultRendererComponent");
		expect(view).toBeInstanceOf(ToolView);
		if (!(view instanceof ToolView)) throw new Error("Missing fixture result view");
		const render = view.render.bind(view);
		view.render = (width) => [...render(width), "", "body after blank"];
		expect(show(f.chat)).toContain("RESULT a");
		expect(show(f.chat)).toContain("\n\nbody after blank");
	});

	test("expanded copy actions keep original right-edge geometry and one outer rail", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		clickRow(f.chat, "collapse views");
		const header = f.chat.render(80).findIndex((line, index) => index > 1 && line.includes("read"));
		expect(click(f.chat, header, 80, 78)).toMatchObject({ handled: true });
		expect(f.copyToClipboard).toHaveBeenCalledWith("COPY a");
		expect(show(f.chat)).toContain("RESULT a");
		expect(show(f.chat)).not.toContain("▎ ▎");
		for (const width of [8, 24, 80]) {
			for (const line of f.chat.render(width))
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("call renderer fallback remains visible even when result presentation succeeds", () => {
		const f = setup();
		f.chat.children = [assistant(["a", "b"]), f.row("a", "read", "ok", true), f.row("b")];
		expect(show(f.chat)).not.toContain("2 calls");
		expect(show(f.chat)).toContain("RESULT a");
	});

	test("original host errors propagate through the seam", () => {
		const f = setup();
		f.resolve.mockImplementation(() => {
			throw new Error("host failure");
		});
		expect(() => f.lookup("fixture")).toThrow("host failure");
		expect(f.notify).not.toHaveBeenCalled();
	});

	test("a non-writable instance rejects grouping without partially patching it", () => {
		const f = setup();
		f.patch.dispose();
		Object.defineProperty(f.chat, "handleMouse", {
			value: f.originals.handleMouse,
			configurable: true,
			writable: false,
		});
		const patch = installHostToolGroups(
			f.context,
			() => backgrounds,
			() => 1,
		);
		cleanups.push(patch.dispose);
		f.lookup("fixture");
		expect(f.chat.render).toBe(f.originals.render);
		expect(f.chat.invalidate).toBe(f.originals.invalidate);
		expect(f.notify).toHaveBeenCalledTimes(1);
	});

	test("thinking rounds merge; prose remains a boundary", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"], true), f.row("a"), f.row("b")];
		expect(show(f.chat)).toContain("2 calls");
		expect(show(f.chat)).toContain("thinking x1 · 2 tokens");
		expect(show(f.chat)).not.toContain("reason");
		f.chat.children = [assistant(["a"]), f.row("a"), assistant(["b"], true), f.row("b")];
		expect(show(f.chat)).toContain("2 calls");
		f.chat.children.splice(2, 0, assistant([], "text"));
		expect(show(f.chat)).not.toContain("2 calls");
		expect(show(f.chat)).toContain("prose boundary");
	});

	test.each([
		"warn",
		"error",
		"none",
		"running",
	] as const)("%s presentation keeps its summary in the group", (status) => {
		const f = setup();
		f.begin();
		f.chat.children = [
			assistant(["a", "b", "c"]),
			f.row("a"),
			f.row("b", "read", status),
			f.row("c"),
		];
		expect(show(f.chat)).toContain("3 calls");
		expect(show(f.chat)).not.toContain("RESULT b");
	});

	test("partial and failed results update summaries; images and unknown renderers break groups", () => {
		const f = setup();
		f.begin();
		for (const kind of ["partial", "error", "image", "fallback"] as const) {
			const middle = f.row("b");
			if (kind === "partial")
				middle.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
			if (kind === "error")
				middle.updateResult({ content: [{ type: "text", text: "error" }], isError: true });
			if (kind === "image")
				middle.updateResult({
					content: [{ type: "image", data: "", mimeType: "image/png" }],
					isError: false,
				});
			if (kind === "fallback") Reflect.set(middle, "resultRendererComponent", new Text("native"));
			f.chat.children = [assistant(["a", "b", "c"]), f.row("a"), middle, f.row("c")];
			// A partial result is not a completed call; the failed one is, and still counts.
			if (kind === "error") expect(show(f.chat)).toContain("3 calls");
			else if (kind === "partial") expect(show(f.chat)).toContain("2 calls");
			else expect(show(f.chat)).not.toContain("×");
		}
	});

	test("groups form during streaming and keep the live tail as its own component", () => {
		const f = setup();
		f.begin();
		f.setIdle(false);
		const live = f.row("b", "read", "ok", false, false);
		f.chat.children = [assistant(["a", "b"]), f.row("a"), live];
		// Args streaming is not a call yet: only the finished sibling is counted.
		expect(show(f.chat)).toContain("1 call");
		expect(show(f.chat)).toContain("▸ read ×1");
		expect(show(f.chat)).toMatch(/[·✢✳✶✻✽] read/);
		// The group never synthesizes a tail row: the live call is the transcript's own component.
		live.updateArgs({ path: "new-path" });
		expect(show(f.chat)).toContain('{"path":"new-path"}');
		live.setArgsComplete();
		live.markExecutionStarted();
		expect(show(f.chat)).toMatch(/[·✢✳✶✻✽] read/);
		live.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
		expect(show(f.chat)).toMatch(/[·✢✳✶✻✽] read/);
		live.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		expect(show(f.chat)).toContain("✓ read");
		expect(show(f.chat)).not.toMatch(/[·✢✳✶✻✽] read/);
		clickRow(f.chat, "collapse views");
		f.chat.children.push(assistant(["c"], true), f.row("c"));
		expect(show(f.chat)).toContain("3 calls");
		expect(show(f.chat)).toContain("RESULT c");
		clickRow(f.chat, "collapse views");
		// Closing the raw view collapses the block, not the tail's own component.
		expect(show(f.chat)).not.toContain("RESULT a");
		expect(show(f.chat)).toContain("RESULT c");
		expect(show(f.chat)).toContain("3 calls");
		expect(show(f.chat)).toContain("▸ read ×2");
	});

	test("each block has its own clock across native boundaries and freezes when the loop ends", () => {
		const f = setup();
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		f.patch.beginRun();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		expect(show(f.chat)).toContain("0s");
		now.mockReturnValue(1000);
		f.chat.children.push(new Text("NOTICE", 0, 0), assistant(["c", "d"]), f.row("c"), f.row("d"));
		expect(show(f.chat)).toContain("collapse views · 0s · 2 calls");
		now.mockReturnValue(65_000);
		clickRow(f.chat, "collapse views");
		expect(show(f.chat)).toContain("collapse views · 1s · 2 calls");
		expect(show(f.chat)).toContain("collapse views · 1m 04s · 2 calls");
		f.patch.endRun();
		now.mockReturnValue(600_000);
		expect(show(f.chat)).toContain("collapse views · 1s · 2 calls");
		expect(show(f.chat)).toContain("collapse views · 1m 04s · 2 calls");
		expect(show(f.chat)).toContain("requests ×1");
		f.patch.beginRun();
		f.chat.children.push(new Text("NOTICE", 0, 0), assistant(["e", "f"]), f.row("e"), f.row("f"));
		expect(show(f.chat)).toContain("collapse views · 0s · 2 calls");
		now.mockReturnValue(605_000);
		expect(show(f.chat)).toContain("collapse views · 5s · 2 calls");
	});

	test("a block clock stays stable through run end and rebuild", () => {
		const f = setup();
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		f.patch.beginRun();
		const a = f.row("a");
		const b = f.row("b");
		const c = f.row("c");
		f.chat.children = [assistant(["a", "b", "c"]), a, b, c];
		expect(show(f.chat)).toContain("0s");
		now.mockReturnValue(65_000);
		f.patch.endRun();
		now.mockReturnValue(600_000);
		expect(show(f.chat)).toContain("1m 05s");
		// The first member leaves the block after the end; the rebuilt group keeps its clock.
		const first = Reflect.get(a, "resultRendererComponent");
		expect(first).toBeInstanceOf(ToolView);
		if (!(first instanceof ToolView)) throw new Error("Missing fixture result view");
		first.hide();
		expect(show(f.chat)).toContain("1m 05s");

		f.patch.beginRun();
		now.mockReturnValue(700_000);
		f.chat.children.push(new Text("NOTICE", 0, 0), assistant(["d", "e"]), f.row("d"), f.row("e"));
		// The next block gets its own clock and never re-times finished blocks.
		expect(show(f.chat)).toContain("0s");
		expect(show(f.chat)).toContain("1m 05s");
	});

	test("restored history keeps an unknown clock while a live block times itself", () => {
		const f = setup();
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		// Nobody painted this history before the run started, so its duration is honestly unknown.
		f.patch.beginRun();
		now.mockReturnValue(5000);
		expect(show(f.chat)).toContain("collapse views · — · 2 calls");
		f.chat.children.push(new Text("NOTICE", 0, 0), assistant(["c", "d"]), f.row("c"), f.row("d"));
		// The live block starts on first observation; restored history keeps its honest unknown duration.
		expect(show(f.chat)).toContain("collapse views · 0s · 2 calls");
		expect(show(f.chat)).toContain("collapse views · — · 2 calls");
		now.mockReturnValue(10_000);
		expect(show(f.chat)).toContain("collapse views · 5s · 2 calls");
		f.patch.endRun();
		now.mockReturnValue(9000);
		expect(show(f.chat)).toContain("collapse views · 5s · 2 calls");
		expect(show(f.chat)).toContain("collapse views · — · 2 calls");
	});

	test("a restored block that live content joins starts timing when that content appears", () => {
		const f = setup();
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		expect(show(f.chat)).toContain("collapse views · — · 2 calls");
		f.patch.beginRun();
		f.chat.children.push(assistant(["c", "d"]), f.row("c"), f.row("d"));
		expect(show(f.chat)).toContain("collapse views · 0s · 4 calls");
		now.mockReturnValue(65_000);
		f.patch.endRun();
		now.mockReturnValue(120_000);
		expect(show(f.chat)).toContain("collapse views · 1m 05s · 4 calls");
		expect(show(f.chat)).toContain("requests ×2");
	});

	test.each([
		[0, "0s"],
		[65_000, "1m 05s"],
		[3_723_000, "1h 02m 03s"],
	] as const)("elapsed %i ms reads %s through redraw and resize", (milliseconds, expected) => {
		const f = setup();
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		f.patch.beginRun();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		expect(show(f.chat)).toContain("0s");
		now.mockReturnValue(milliseconds);
		expect(show(f.chat)).toContain(`· ${expected} ·`);
		for (const width of [80, 120]) {
			expect(f.chat.render(width).join("\n")).toContain(`· ${expected} ·`);
		}
		f.chat.invalidate();
		expect(show(f.chat)).toContain(`· ${expected} ·`);
		for (const width of [30, 80, 120]) {
			for (const line of f.chat.render(width))
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("a finished block keeps its frame and its statistics footer", () => {
		const f = setup();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		const rows = show(f.chat).trim().split("\n");
		expect(rows[0]).toContain("▸ collapse views · — · 2 calls");
		expect(rows).toContain("▸ read ×1");
		// The group brackets its frame with two horizontal rails; the tail draws its own rows.
		expect(rows.filter((row) => /^─+$/.test(row))).toHaveLength(2);
		const footer = rows.indexOf("requests ×1 · ↑— · ↓—");
		expect(footer).toBeGreaterThan(0);
		// Exactly one blank row separates the block from the unit it keeps outside.
		// One colored padding row closes the background, then the single uncolored separator.
		expect(rows[footer + 1]).toBe("");
		expect(rows[footer + 2]).toBe("");
		expect(rows[footer + 3]).toContain("✓ read");
	});

	test("the footer is always statistics, and native content moves the tail into the block", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b", "grep")];
		expect(show(f.chat)).toContain("✓ grep");
		expect(show(f.chat)).toContain("requests ×1 · ↑— · ↓—");

		f.chat.children.push(new Text("prose after the block", 0, 0));
		expect(show(f.chat)).toContain("requests ×1");
		// The old tail joins the block once; the native prose is the new last unit.
		expect(show(f.chat)).toContain("grep ×1");
		expect(show(f.chat)).toContain("prose after the block");
	});

	test("a parallel completion does not reorder the tail", () => {
		const f = setup();
		f.begin();
		const stillRunning = f.row("a", "grep", "running");
		// A tool that started and has not produced its final result: the host marks it partial.
		Reflect.set(stillRunning, "isPartial", true);
		f.chat.children = [assistant(["a", "b"]), stillRunning, f.row("b", "read", "ok")];
		// The tail is the transcript's last unit, not the call that finished or started last.
		const tailRows = () => {
			const rows = show(f.chat).split("\n");
			const footer = rows.findIndex((row) => row.startsWith("requests ×"));
			return rows.slice(footer).join("\n");
		};
		expect(tailRows()).toContain("✓ read");
		expect(show(f.chat)).toContain("▸ tools");
		clickRow(f.chat, "▸ tools");
		expect(show(f.chat)).toMatch(/[·✢✳✶✻✽] grep/);
		stillRunning.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		expect(show(f.chat)).toContain("grep ×1");
		expect(tailRows()).toContain("✓ read");
	});

	test("closing the host's forced expansion returns to the collapsed aggregate", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		const header = () => show(f.chat).trim().split("\n")[0] ?? "";

		clickRow(f.chat, "collapse views");
		expect(header()).toContain("▾ collapse views");
		f.setExpanded(true);
		expect(header()).toContain("▾ collapse views");
		f.setExpanded(false);
		expect(header()).toContain("▸ collapse views");
		expect(show(f.chat)).toContain("▸ read ×1");
	});

	test("a collapsed frame is one background block with the tail outside at every width", () => {
		const f = setup(true, tokens);
		f.begin();
		const failed = f.row("b", "read");
		failed.updateResult({ content: [{ type: "text", text: "boom" }], isError: true });
		f.chat.children = [assistant(["a", "b"]), f.row("a", "grep"), failed];
		const text = show(f.chat);
		expect(text).toContain("✗ read");
		expect(text).toContain("[toolTitle]grep[/]");
		// The block's own rows carry the group background; the failed tail votes for the error token.
		expect(text).toContain("[bg:toolErrorBg]");

		// Width safety is measured on real cells, so this half uses the token-free theme.
		const plain = setup();
		plain.begin();
		const broken = plain.row("b", "read");
		broken.updateResult({ content: [{ type: "text", text: "boom" }], isError: true });
		plain.chat.children = [assistant(["a", "b"]), plain.row("a", "grep"), broken];
		for (const width of [8, 24, 80]) {
			for (const line of plain.chat.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(line).not.toMatch(/[\r\n]/);
			}
		}
	});

	test("collapsed group rails bracket categories and footer, but disappear in raw view", () => {
		const f = setup(true, tokens);
		f.begin();
		for (let index = 0; index < 4; index++) f.notice(`notice ${index}`);

		const rows = () => f.chat.render(80).map((row) => row.trimEnd());
		const frame = rows();
		const header = frame.findIndex((row) => row.includes("collapse views"));
		const rails = frame.flatMap((row, index) => (row.includes("[borderMuted]") ? [index] : []));
		const footer = frame.findIndex((row) => row.includes("requests"));
		expect(rails).toHaveLength(2);
		expect(rails[0]).toBe(header + 1);
		expect(rails[1]).toBe(footer - 1);

		// The category row sits between the top rail and the footer.
		click(f.chat, header + 2, 80);
		expect(rows().filter((row) => row.includes("[borderMuted]"))).toHaveLength(2);
		clickRow(f.chat, "collapse views");
		expect(rows().some((row) => row.includes("[borderMuted]"))).toBe(false);
	});

	test("a container counts its children but keeps one original component", () => {
		const f = setup();
		f.begin();
		const children: ToolViewChild[] = [
			{ title: "read", summary: "a.ts", status: "ok" },
			{ title: "grep", summary: "needle", status: "error" },
			{ title: "bash", summary: "ls", status: "ok" },
		];
		f.chat.children = [
			assistant(["a", "b", "c"]),
			f.row("a", "grep"),
			f.row("b", "codemode", "none", false, true, children),
			f.row("c", "read"),
		];
		// grep 1 + the container's 3 children + read 1 = 5 calls, not 1 + 1 + 1 + 1.
		expect(show(f.chat)).toContain("5 calls");
		expect(show(f.chat)).toContain("▸ grep ×2 · read ×1 · bash ×1");
		clickRow(f.chat, "▸ grep ×2");
		const rows = show(f.chat).split("\n");
		expect(rows.filter((row) => row.includes("codemode"))).toHaveLength(1);
		expect(rows).not.toContain("▸ ✓ read a.ts");
		expect(rows).not.toContain("▸ ✗ grep needle");
		expect(show(f.chat)).toContain("RESULT b");
	});

	test("a running tool keeps its row and adds no count until it completes", () => {
		const f = setup();
		f.begin();
		const running = f.row("a", "grep", "ok", false, false);
		running.setArgsComplete();
		running.markExecutionStarted();
		const later = f.row("b", "read", "ok", false, false);
		later.setArgsComplete();
		later.markExecutionStarted();
		f.chat.children = [assistant(["a", "b"]), running, later];
		const header = () => (show(f.chat).trim().split("\n")[0] ?? "").trimEnd();
		expect(header().endsWith("0 calls")).toBe(true);
		expect(show(f.chat)).toContain("▸ tools");
		clickRow(f.chat, "▸ tools");
		expect(show(f.chat)).toMatch(/[·✢✳✶✻✽] grep/);
		running.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		expect(header().endsWith("1 call")).toBe(true);
		expect(show(f.chat)).toContain("grep ×1");
	});

	test("a container enters the counts once, at its final result", () => {
		const f = setup();
		f.begin();
		const children: ToolViewChild[] = [];
		const container = f.row("a", "codemode", "none", false, false, children);
		f.chat.children = [assistant(["a", "b"]), container, f.row("b")];
		const header = () => (show(f.chat).trim().split("\n")[0] ?? "").trimEnd();
		// Args streaming: neither the parent nor a not-yet-existing child is a call.
		expect(header().endsWith("1 call")).toBe(true);
		// The last unit is outside the block, so the group lists only the unfinished container.
		expect(show(f.chat)).toContain("▸ tools");
		container.setArgsComplete();
		container.markExecutionStarted();
		container.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
		children.push({ title: "grep", summary: "one" });
		expect(header().endsWith("1 call")).toBe(true);
		children.push({ title: "edit", summary: "two" }, { title: "bash", summary: "three" });
		expect(header().endsWith("1 call")).toBe(true);
		expect(show(f.chat)).toContain("▸ tools");
		container.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		// One atomic replacement at the final result: the parent is not counted beside its children.
		expect(header()).toContain("4 calls");
		expect(show(f.chat)).toContain("▸ grep ×1 · edit ×1 · bash ×1");
		expect(show(f.chat)).toContain("✓ read");
		// Redraws and rebuilt projections reuse the same final facts; nothing is counted twice.
		f.chat.invalidate();
		expect(header()).toContain("4 calls");
		for (const width of [30, 80, 120]) f.chat.render(width);
		expect(header()).toContain("4 calls");
	});

	test.each([
		"codemode",
		"python_eval",
	] as const)("%s keeps its own level 0 board inside the category", (name) => {
		const f = setup();
		f.begin();
		const children: ToolViewChild[] = [
			{ title: "read", summary: "a.ts", status: "ok" },
			{ title: "grep", summary: "needle", status: "error" },
		];
		f.chat.children = [
			assistant(["a", "b"]),
			f.row("a", name, "none", false, true, children, undefined, [
				"▸ ✓ read a.ts",
				"▸ ✗ grep needle",
			]),
			f.row("b", "read"),
		];
		clickRow(f.chat, "▸ read ×1");
		const rows = show(f.chat).split("\n");
		expect(rows).toContain(" ▎ ▸ ✓ read a.ts");
		expect(rows).toContain(" ▎ ▸ ✗ grep needle");
		expect(rows.filter((row) => row.includes(name))).toHaveLength(1);
		const header = rows.findIndex((row) => row.includes(name));
		expect(click(f.chat, header, 80, 2)).toMatchObject({ handled: true });
		expect(show(f.chat)).toContain("RESULT a");
	});

	test("a container keeps its own copy and fold interaction inside the category", () => {
		const f = setup();
		f.begin();
		const children: ToolViewChild[] = [{ title: "read", summary: "a.ts", status: "ok" }];
		const container = f.row("a", "codemode", "none", false, true, children);
		f.chat.children = [assistant(["a", "b"]), container, f.row("b", "read")];
		clickRow(f.chat, "▸ read ×1");
		expect(show(f.chat)).toContain("RESULT a");
		const header = f.chat.render(80).findIndex((row) => row.includes("codemode"));
		expect(click(f.chat, header, 80, 78)).toMatchObject({ handled: true });
		expect(f.copyToClipboard).toHaveBeenCalledWith("COPY a");
		// A pure redraw keeps the component's own fold state; the group never resets it per frame.
		f.chat.invalidate();
		expect(show(f.chat)).toContain("RESULT a");
		container.updateResult({ content: [{ type: "text", text: "UPDATED" }], isError: false });
		expect(show(f.chat)).toContain("RESULT a");
		expect(click(f.chat, header, 80, 2)).toMatchObject({ handled: true });
		expect(show(f.chat)).not.toContain("RESULT a");
	});

	test("tools category shows each original component with one-space padding and one blank row", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b", "c"]), f.row("a"), f.row("b"), f.row("c")];
		clickRow(f.chat, "▸ read ×2");
		const rows = show(f.chat).split("\n");
		expect(rows.find((row) => row.includes("✓ read"))?.startsWith(" ▾ ✓ read")).toBe(true);
		expect(rows).toContain(" ▎ RESULT a");
		expect(rows).toContain(" ▎ RESULT b");
		const first = rows.findIndex((row) => row.includes("✓ read"));
		const second = rows.findIndex((row, index) => index > first && row.includes("✓ read"));
		expect(rows.slice(first + 1, second).filter((row) => row.trim() === "")).toEqual([""]);
		for (const width of [30, 80, 120]) {
			for (const row of f.chat.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	});

	test("failed and partial tools keep their own rows inside the category", () => {
		const f = setup();
		f.begin();
		const partial = f.row("a", "read", "ok", false, false);
		partial.setArgsComplete();
		partial.markExecutionStarted();
		partial.updateResult({ content: [{ type: "text", text: "PARTIAL" }], isError: false }, true);
		const failed = f.row("b", "read");
		failed.updateResult({ content: [{ type: "text", text: "boom" }], isError: true });
		const running = f.row("d", "read", "ok", false, false);
		running.setArgsComplete();
		running.markExecutionStarted();
		f.chat.children = [assistant(["a", "b", "c", "d"]), partial, failed, f.row("c"), running];
		// The failed and the finished calls are counted; partial and running are only listed.
		clickRow(f.chat, "▸ read ×2");
		expect(show(f.chat)).toContain("✗ read");
		expect(show(f.chat)).toMatch(/[·✢✳✶✻✽] read/);
		expect(show(f.chat)).toContain("RESULT a");
		expect(show(f.chat)).toContain("RESULT b");
		expect(show(f.chat)).toContain("RESULT c");
	});

	test("an expanded tool keeps its own row geometry inside the tools category", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		clickRow(f.chat, "▸ read ×1");
		expect(show(f.chat)).toContain("RESULT a");
		clickRow(f.chat, "RESULT a");
		expect(show(f.chat)).toContain("RESULT a");
		const header = f.chat.render(80).findIndex((row) => row.includes("✓ read"));
		expect(click(f.chat, header, 80, 2)).toMatchObject({ handled: true });
		expect(show(f.chat)).not.toContain("RESULT a");
	});

	test("one category and one item open at a time", () => {
		const f = setup();
		f.begin();
		const notice = new Container();
		notice.addChild(
			createMessageView({
				theme,
				header: { kind: "memory", summary: "page", tone: "success" },
				body: "remembered body",
			}),
		);
		const message = assistant(["a", "b"], true, undefined, "reason one reason two reason three");
		Reflect.set(message, "hideThinkingBlock", true);
		f.chat.children = [message, f.row("a"), notice, f.row("b")];
		clickRow(f.chat, "▸ thinking");
		expect(show(f.chat)).toContain("▾ thinking x1");
		// One row per item: the preview itself is the fold target, with no label row above it.
		expect(show(f.chat)).not.toContain("▎ reason one reason two reason three");
		clickRow(f.chat, "▎ reason");
		// Opening keeps the rail: the body rows line up with the preview's text column.
		expect(show(f.chat)).toContain("▎ reason one reason two reason three");
		clickRow(f.chat, "▸ read ×1");
		expect(show(f.chat)).toContain("▾ read ×1");
		expect(show(f.chat)).toContain("▸ thinking");
		expect(show(f.chat)).not.toContain("reason");
		clickRow(f.chat, "▸ notice · memory ×1");
		expect(show(f.chat)).toContain("▾ notice · memory ×1");
		clickRow(f.chat, "▸ memory · page");
		expect(show(f.chat)).toContain("remembered body");
	});

	test("thinking rows keep the rail while transparent and drop it under a background", () => {
		const f = setup(true, tokens);
		f.begin();
		const message = assistant(["a", "b"], true, undefined, "keep this reasoning");
		Reflect.set(message, "hideThinkingBlock", true);
		f.chat.children = [message, f.row("a"), f.row("b")];
		clickRow(f.chat, "thinking x1");
		clickRow(f.chat, "keep this reasoning");
		// Transparent: the preview and the opened body share one rail, so the text column never moves.
		expect(show(f.chat)).toContain("[dim]▎[/] [thinkingText]keep this reasoning[/]");
		backgrounds = true;
		try {
			const rows = show(f.chat).split("\n");
			expect(rows.some((row) => row.includes("[thinkingText]keep this reasoning"))).toBe(true);
			// A filled block is delimited by its own surface, so no row draws a rail.
			expect(rows.some((row) => row.includes("▎"))).toBe(false);
		} finally {
			backgrounds = false;
		}
	});

	test("categories render notice, then thinking, then tools", () => {
		const f = setup();
		f.begin();
		const notice = new Container();
		notice.addChild(
			createMessageView({
				theme,
				header: { kind: "memory", summary: "page", tone: "success" },
				body: "remembered body",
			}),
		);
		f.chat.children = [assistant(["a", "b"], true), f.row("a"), notice, f.row("b")];
		const rows = show(f.chat).split("\n");
		const order = ["▸ notice · memory ×1", "▸ thinking x1 · 2 tokens", "▸ read ×1"].map((row) =>
			rows.findIndex((line) => line.startsWith(row)),
		);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		for (const index of order) expect(index).toBeGreaterThanOrEqual(0);
	});

	test("hidden thinking previews real content and opens the full text", () => {
		const f = setup();
		f.begin();
		const thinking =
			"first paragraph with a very long tail beyond twenty graphemes\n\nsecond paragraph stays out of the preview";
		const message = assistant(["a", "b"], true, undefined, thinking);
		Reflect.set(message, "hideThinkingBlock", true);
		f.chat.children = [message, f.row("a"), f.row("b")];
		clickRow(f.chat, "▸ thinking");
		const preview = show(f.chat)
			.split("\n")
			.find((row) => row.includes("first paragraph"));
		expect(preview).toContain("first paragraph with…");
		expect(preview).not.toContain("second paragraph");
		expect(preview).not.toContain("tokens");
		clickRow(f.chat, "first paragraph");
		const opened = show(f.chat).split("\n");
		expect(opened).toContain("▎ first paragraph with a very long tail beyond twenty graphemes");
		expect(opened).toContain("▎ second paragraph stays out of the preview");
		clickRow(f.chat, "▎ first paragraph");
		expect(show(f.chat)).toContain("first paragraph with…");
		expect(show(f.chat)).not.toContain("second paragraph stays out");
	});

	test("two thinking items open one at a time", () => {
		const f = setup();
		f.begin();
		const first = assistant(["a"], true, undefined, "alpha reasoning about the first step");
		const second = assistant(["b"], true, undefined, "beta reasoning about the second step");
		for (const message of [first, second]) Reflect.set(message, "hideThinkingBlock", true);
		f.chat.children = [first, f.row("a"), second, f.row("b")];
		expect(show(f.chat)).toContain("▸ thinking x2 ·");
		expect(show(f.chat, 30)).toContain("thinking x2");
		clickRow(f.chat, "▸ thinking");
		expect(show(f.chat)).toContain("▾ thinking x2 ·");
		clickRow(f.chat, "alpha reasoning");
		expect(show(f.chat)).toContain("alpha reasoning about the first step");
		clickRow(f.chat, "beta reasoning");
		expect(show(f.chat)).toContain("beta reasoning about the second step");
		expect(show(f.chat)).not.toContain("alpha reasoning about the first step");
	});

	test("visible thinking prints the full text with no item arrow", () => {
		const f = setup();
		f.begin();
		f.chat.children = [
			assistant(["a", "b"], true, undefined, "para one\n\npara two"),
			f.row("a"),
			f.row("b"),
		];
		clickRow(f.chat, "▸ thinking");
		const rows = show(f.chat).split("\n");
		expect(rows).toContain("▎ para one");
		expect(rows).toContain("");
		expect(rows).toContain("▎ para two");
		// Visible thinking is already the full text, so no item row offers to fold it.
		expect(rows.some((row) => row.startsWith("▸ thinking"))).toBe(false);
		const before = show(f.chat);
		clickRowAt(f.chat, "▎ para one", 0);
		expect(show(f.chat)).toBe(before);
	});

	test("empty thinking adds no category and no clickable row", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"], true, undefined, "   "), f.row("a"), f.row("b")];
		expect(show(f.chat)).not.toContain("thinking");
	});

	test("thinking previews count graphemes, not code points", () => {
		const f = setup();
		f.begin();
		const message = assistant(["a", "b"], true, undefined, "🙂".repeat(25));
		Reflect.set(message, "hideThinkingBlock", true);
		f.chat.children = [message, f.row("a"), f.row("b")];
		clickRow(f.chat, "▸ thinking");
		const preview = show(f.chat)
			.split("\n")
			.find((row) => row.includes("🙂"));
		expect(preview?.match(/🙂/gu)).toHaveLength(20);
		expect(preview).toContain("…");
	});

	test("hidden thinking previews stay width-safe and keep the tail on demand", () => {
		const text = "一二三四五六七八九十一二三四五六七八九十多出来的内容";
		for (const width of [30, 80, 120]) {
			const f = setup();
			f.begin();
			const message = assistant(["a", "b"], true, undefined, text);
			Reflect.set(message, "hideThinkingBlock", true);
			f.chat.children = [message, f.row("a"), f.row("b")];
			clickRow(f.chat, "▸ thinking");
			const rows = f.chat.render(width);
			const preview = rows.find((row) => row.includes("一二三"));
			expect(preview).toContain("…");
			expect(preview).not.toContain("多");
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			clickRowAt(f.chat, "一二三", 0);
			expect(show(f.chat)).toContain("多出来的内容");
			for (const row of f.chat.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	});

	test("thinking preview and body use thinkingText with italic", () => {
		const italic: string[] = [];
		const spyTheme = {
			fg: (token: string, text: string) => `[${token}]${text}[/]`,
			bg: (token: string, text: string) => `[bg:${token}]${text}[/bg]`,
			bold: (text: string) => text,
			italic: (text: string) => {
				italic.push(text);
				return text;
			},
		} as Theme;
		const f = setup(true, spyTheme);
		f.begin();
		const message = assistant(["a", "b"], true, undefined, "reasoning");
		Reflect.set(message, "hideThinkingBlock", true);
		f.chat.children = [message, f.row("a"), f.row("b")];
		// The category label is readable text; the open category is the block's focus point.
		clickRow(f.chat, "[text]thinking");
		expect(show(f.chat)).toContain("[accent]thinking");
		expect(show(f.chat)).toContain("[thinkingText]");
		expect(italic.length).toBeGreaterThan(0);
		clickRowAt(f.chat, "thinking", 1);
		expect(show(f.chat)).toContain("[thinkingText]");
	});

	test("changing the thinking visibility keeps the text and switches the layout", () => {
		const f = setup();
		f.begin();
		const message = assistant(["a", "b"], true, undefined, "keep this reasoning");
		Reflect.set(message, "hideThinkingBlock", true);
		f.chat.children = [message, f.row("a"), f.row("b")];
		clickRow(f.chat, "▸ thinking");
		clickRow(f.chat, "keep this reasoning");
		expect(show(f.chat)).toContain("keep this reasoning");
		Reflect.set(message, "hideThinkingBlock", false);
		f.chat.invalidate();
		const rows = show(f.chat).split("\n");
		expect(rows).toContain("▎ keep this reasoning");
		expect(rows.some((row) => row.startsWith("▸ thinking"))).toBe(false);
	});

	test("a notice shows its preview directly and opens only a real body", () => {
		const f = setup();
		f.begin();
		const bare = new Container();
		bare.addChild(createMessageView({ theme, header: { kind: "memory", summary: "page" } }));
		const previewOnly = new Container();
		previewOnly.addChild(
			createMessageView({
				theme,
				header: { kind: "memory", summary: "two" },
				preview: "preview line",
			}),
		);
		f.chat.children = [assistant(["a", "b"]), f.row("a"), bare, previewOnly, f.row("b")];
		clickRow(f.chat, "▸ notice · memory ×2");

		const rows = show(f.chat).split("\n");
		expect(rows.find((row) => row.includes("memory · page"))).not.toContain("▸");
		expect(rows.find((row) => row.includes("memory · two"))).not.toContain("▸");
		expect(rows.filter((row) => row.includes("preview line"))).toHaveLength(1);

		const before = show(f.chat);
		clickRow(f.chat, "preview line");
		expect(show(f.chat)).toBe(before);
		clickRow(f.chat, "memory · two");
		expect(show(f.chat)).toBe(before);
	});

	test("one notice body opens at a time and closing the category forgets it", () => {
		const f = setup();
		f.begin();
		const notice = (summary: string, body: string) => {
			const container = new Container();
			container.addChild(
				createMessageView({
					theme,
					header: { kind: "memory", summary },
					preview: `${summary} preview`,
					body,
				}),
			);
			return container;
		};
		f.chat.children = [
			assistant(["a", "b"]),
			f.row("a"),
			notice("one", "body one"),
			notice("two", "body two"),
			f.row("b"),
		];
		clickRow(f.chat, "▸ notice · memory ×2");
		clickRow(f.chat, "memory · one");
		const opened = show(f.chat).split("\n");
		expect(opened.filter((row) => row.includes("memory · one"))).toHaveLength(1);
		expect(opened.filter((row) => row.includes("one preview"))).toHaveLength(1);
		expect(opened.filter((row) => row.includes("body one"))).toHaveLength(1);
		clickRow(f.chat, "memory · two");
		expect(show(f.chat)).toContain("body two");
		expect(show(f.chat)).not.toContain("body one");
		clickRow(f.chat, "▾ notice");
		clickRow(f.chat, "▸ notice");
		expect(show(f.chat)).not.toContain("body two");
	});

	test("a plain notify prints its content once, indented, with no item arrow", () => {
		const f = setup(false);
		f.begin();
		f.notice("om: observer running on 2.7K tokens chunk");
		f.chat.children.push(assistant(["a", "b"]), f.row("a"), f.row("b"));
		expect(show(f.chat)).not.toContain("om: observer");
		clickRow(f.chat, "▸ notice · info ×1");
		const rows = show(f.chat).split("\n");
		const content = rows.filter((row) => row.includes("om: observer"));
		expect(content).toHaveLength(1);
		expect(content[0]).toMatch(/^ om: observer/);
		expect(content[0]).not.toContain("▸");
		const before = show(f.chat);
		clickRow(f.chat, "om: observer");
		expect(show(f.chat)).toBe(before);
		// Outside the group the notice keeps the same single indented block.
		f.patch.dispose();
		const native = show(f.chat)
			.split("\n")
			.filter((row) => row.includes("om: observer"));
		expect(native).toHaveLength(1);
		expect(native[0]).toMatch(/^ om: observer/);
	});

	test("the group header, category labels, and rails use distinct semantic tokens", () => {
		const f = setup(false, tokens);
		f.begin();
		f.notice("hello");
		f.chat.children.push(assistant(["a", "b"]), f.row("a"), f.row("b"));
		const text = show(f.chat);
		// Labels are readable text, secondary facts stay dim, and structure is its own token.
		expect(text).toContain("[text]collapse views[/]");
		// The group is a background block bracketed by its own rails, never by tool rails.
		expect(text).toContain("[bg:toolSuccessBg]");
		expect(text).toContain("[borderMuted]");
		expect(text).toContain("[text]notice[/]");
		expect(text).toContain("[dim]info ×1[/]");
		expect(text).not.toContain("[muted]collapse views");
	});

	test("the open category is the block's focus point", () => {
		const f = setup(false, tokens);
		f.begin();
		f.notice("hello");
		f.chat.children.push(assistant(["a", "b"]), f.row("a"), f.row("b"));
		clickRow(f.chat, "[text]notice");
		const rows = show(f.chat).split("\n");
		expect(rows.some((row) => row.includes("[accent]notice[/]"))).toBe(true);
		// The arrow still states the state, so the color is never the only signal.
		expect(rows.some((row) => row.includes("[dim]▾[/] [accent]notice[/]"))).toBe(true);
	});

	test("plain notify content keeps its semantic color and prefix", () => {
		const f = setup(false, tokens);
		f.begin();
		f.notice("plain notice");
		f.notice("warn", "warning");
		f.notice("err", "error");
		f.chat.children.push(assistant(["a", "b"]), f.row("a"), f.row("b"));
		clickRow(f.chat, "[text]notice");
		const text = show(f.chat);
		expect(text.split("[text]plain notice[/]")).toHaveLength(2);
		expect(text).toContain("[warning]Warning: warn[/]");
		expect(text).toContain("[error]Error: err[/]");
		expect(text).not.toContain("▸ Warning");
	});

	test("plain notify content wraps to the available width", () => {
		const long = "observer running on 2.7K tokens chunk ".repeat(3).trim();
		for (const width of [30, 80, 120]) {
			const f = setup(false);
			f.begin();
			f.notice(long);
			f.notice("second notice\nsecond line", "warning");
			f.chat.children.push(assistant(["a", "b"]), f.row("a"), f.row("b"));
			clickRow(f.chat, "▸ notice · info ×1");
			const rows = f.chat.render(width);
			const text = rows.join("\n");
			expect(text).toContain("observer running on 2.7K");
			expect(text).toContain("second line");
			expect(text.split("Warning: second notice")).toHaveLength(2);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	});

	test("counts a container's calls from its own count, not from the children it lists", () => {
		const f = setup();
		f.begin();
		f.chat.children = [
			assistant(["a", "b"]),
			f.row("a", "read", "ok", false, true, [{ title: "read", summary: "a.txt" }], 3),
			f.row("b"),
		];
		// Two top-level tools, but the container reports three calls: 3 + 1, not 1 + 1.
		expect(show(f.chat)).toContain("4 calls");
	});

	test("a finished block reports the native request usage it owns", () => {
		const f = setup();
		f.chat.children = [
			assistant(["a", "b"], false, { input: 999, output: 100, cacheRead: 0, cacheWrite: 0 }),
			f.row("a"),
			f.row("b"),
			assistant(["c", "d"], false, { input: 1000, output: 2000, cacheRead: 9000, cacheWrite: 0 }),
			f.row("c"),
			f.row("d"),
		];
		// ↑ is the non-cached input of both requests; the 9k cached prompt is R, not ↑.
		expect(show(f.chat)).toContain("requests ×2 · ↑2.0k · ↓2.1k · R9.0k · CH90.0%");
	});

	test("cache hit keeps the last measured prompt through zeroed and missing usage", () => {
		const f = setup();
		f.chat.children = [
			assistant(["a", "b"], false, { input: 1000, output: 10, cacheRead: 9000, cacheWrite: 0 }),
			f.row("a"),
			f.row("b"),
		];
		expect(show(f.chat)).toContain("CH90.0%");
		// A streaming thinking snapshot arrives with every usage field zeroed.
		f.chat.children.push(assistant(["c", "d"], true), f.row("c"), f.row("d"));
		expect(show(f.chat)).toContain("CH90.0%");
		// A missing usage reports nothing at all and must not clear the known fact either.
		const missing = assistant(["e", "f"], true);
		Reflect.set(Reflect.get(missing, "lastMessage"), "usage", undefined);
		f.chat.children.push(missing, f.row("e"), f.row("f"));
		expect(show(f.chat)).toContain("CH90.0%");
		f.chat.children.push(
			assistant(["g", "h"], false, { input: 500, output: 0, cacheRead: 500, cacheWrite: 0 }),
			f.row("g"),
			f.row("h"),
		);
		expect(show(f.chat)).toContain("CH50.0%");
	});

	test("a block with no cache activity shows no CH, and no measurement stays unknown", () => {
		const f = setup();
		f.chat.children = [assistant(["a", "b"], true), f.row("a"), f.row("b")];
		expect(show(f.chat)).toContain("requests ×1 · ↑— · ↓—");
		f.chat.children.push(
			assistant(["c", "d"], false, { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }),
			f.row("c"),
			f.row("d"),
		);
		// Missing data is unknown; a measured prompt without cache activity shows no CH at all.
		expect(show(f.chat)).toContain("requests ×2 · ↑1.0k");
	});

	test.each([
		[999, "999"],
		[1000, "1.0k"],
		[9999, "10.0k"],
		[10_000, "10k"],
		[999_999, "1000k"],
		[1_000_000, "1.0M"],
		[9_999_999, "10.0M"],
		[10_000_000, "10M"],
	])("token counts follow the native footer at %i", (input, expected) => {
		const f = setup();
		f.chat.children = [
			assistant(["a", "b"], false, { input, output: 0, cacheRead: 0, cacheWrite: 0 }),
			f.row("a"),
			f.row("b"),
		];
		expect(show(f.chat)).toContain(`requests ×1 · ↑${expected}`);
	});

	test("global expansion shows the raw members and closing it restores the closed frame", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		clickRow(f.chat, "▸ read");
		expect(show(f.chat)).toContain("▾ read ×1");
		f.setExpanded(true);
		expect(show(f.chat)).toContain("RESULT a");
		expect(show(f.chat)).toContain("▾ collapse views");
		f.setExpanded(false);
		expect(show(f.chat)).not.toContain("RESULT a");
		expect(show(f.chat)).toContain("▸ read ×1");
	});

	test("notifications captured before the first tool keep full text and never count", () => {
		const f = setup(false);
		f.begin();
		f.notice("first notice");
		f.notice("second notice\ndetail", "warning");
		f.chat.children.push(assistant(["a", "b"]), f.row("a"), f.row("b"));
		expect(show(f.chat)).toContain("2 calls");
		expect(show(f.chat)).toContain("▸ notice · info ×1 · warning ×1");
		expect(show(f.chat)).not.toContain("first notice");
		clickRow(f.chat, "▸ notice · info ×1");
		const rows = show(f.chat).split("\n");
		expect(rows.filter((row) => row.includes("first notice"))).toHaveLength(1);
		expect(rows.find((row) => row.includes("first notice"))).toMatch(/^ first notice/);
		expect(rows.find((row) => row.includes("Warning: second notice"))).toMatch(
			/^ Warning: second notice/,
		);
		expect(rows.find((row) => row.includes("detail"))).toMatch(/^ detail/);
		expect(rows.filter((row) => row.includes("▸ Warning"))).toHaveLength(0);
		const before = show(f.chat);
		clickRow(f.chat, "first notice");
		expect(show(f.chat)).toBe(before);
		f.patch.dispose();
		f.notice("native after disposal");
		expect(show(f.chat)).toContain("native after disposal");
	});

	test("notices and tool groups survive stale extension context after session replacement or reload", () => {
		const f = setup(false);
		f.begin();
		f.notice("session notice");
		f.chat.children.push(assistant(["a", "b"]), f.row("a"), f.row("b"));
		Object.defineProperty(f.context, "ui", {
			get() {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			},
		});
		expect(() => show(f.chat)).not.toThrow();
		clickRow(f.chat, "▸ notice · info ×1");
		expect(show(f.chat)).toContain("session notice");
		expect(show(f.chat)).toContain("2 calls");
		expect(() => clickRow(f.chat, "collapse views")).not.toThrow();
		expect(show(f.chat)).toContain("read");
	});

	test("MessageView notices stay inside the activity group and raw entries break it", () => {
		const f = setup();
		f.begin();
		const report = new Container();
		Reflect.set(report, "entry", { customType: "bg-bash-info", data: { message: "tail output" } });
		report.addChild(new Spacer(1));
		report.addChild(
			createMessageView({
				theme,
				header: {
					kind: "bg-bash",
					summary: "✓ job · terminal · completed",
					tone: "success",
				},
				body: "tail output",
			}),
		);
		f.chat.children = [assistant(["a", "b"]), f.row("a"), report, f.row("b")];
		const collapsed = show(f.chat);
		expect(collapsed).toContain("2 calls");
		expect(collapsed).toContain("▸ notice · bg-bash ×1");
		expect(collapsed).not.toContain("tail output");
		clickRow(f.chat, "▸ notice · bg-bash ×1");
		expect(show(f.chat)).toContain("bg-bash · ✓ job · terminal · completed");
		clickRow(f.chat, "▸ bg-bash · ✓ job");
		expect(show(f.chat)).toContain("tail output");
		clickRow(f.chat, "collapse views");
		const expanded = show(f.chat);
		expect(expanded).toContain("2 calls");
		expect(expanded).toContain("▸ bg-bash · ✓ job · terminal · completed");
		const agents = new Container();
		agents.addChild(
			createMessageView({
				theme,
				header: { kind: "agents", summary: "✓ child scout · done", tone: "success" },
			}),
		);
		const raw = new Container();
		Reflect.set(raw, "entry", { customType: "foreign-entry" });
		raw.addChild(new Text("foreign"));
		f.chat.children = [assistant(["a", "b"]), f.row("a"), agents, f.row("b")];
		expect(show(f.chat)).toContain("2 calls");
		expect(show(f.chat)).toContain("▸ notice · agents ×1");
		clickRow(f.chat, "▸ notice · agents ×1");
		expect(show(f.chat)).toContain("agents · ✓ child scout · done");
		f.chat.children = [assistant(["a", "b"]), f.row("a"), raw, f.row("b")];
		expect(show(f.chat)).not.toContain("×");
		expect(show(f.chat)).toContain("foreign");
	});

	test("history replacement and theme invalidation use current nodes, not model projection", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		clickRow(f.chat, "collapse views");
		expect(show(f.chat)).toContain("RESULT a");
		f.chat.clear();
		f.chat.children = [assistant(["c", "d"]), f.row("c", "grep"), f.row("d", "grep")];
		f.chat.invalidate();
		expect(show(f.chat)).toContain("▸ grep ×1");
		expect(show(f.chat)).toContain("2 calls");
		expect(show(f.chat)).not.toContain("RESULT c");
	});

	test("narrow names remain width-safe and counts retain namespace identity", () => {
		const f = setup();
		f.begin();
		f.chat.children = [
			assistant(["a", "b"]),
			f.row("a", "mcp__one__工具"),
			f.row("b", "mcp__two__工具"),
		];
		for (const width of [8, 24, 80]) {
			for (const line of f.chat.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(line).not.toMatch(/[\r\n]/);
			}
		}
		expect(show(f.chat)).toContain("mcp__one__工具 ×1");
		expect(show(f.chat)).toContain("✓ mcp__two__工具");
	});

	test("two owners share one hook and dispose independently; reinstall works", () => {
		const a = setup();
		const b = setup();
		a.begin();
		b.begin();
		const wrapper = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, seam)?.value;
		a.chat.children = [assistant(["a", "b"]), a.row("a"), a.row("b")];
		b.chat.children = [assistant(["c", "d"]), b.row("c"), b.row("d")];
		expect(show(a.chat)).toContain("2 calls");
		expect(show(b.chat)).toContain("2 calls");
		a.patch.dispose();
		expect(Object.getOwnPropertyDescriptor(InteractiveMode.prototype, seam)?.value).toBe(wrapper);
		expect(show(a.chat)).not.toContain("2 calls");
		expect(show(b.chat)).toContain("2 calls");
		b.patch.dispose();
		const again = installHostToolGroups(
			a.context,
			() => backgrounds,
			() => 1,
		);
		cleanups.push(again.dispose);
		again.beginRun();
		expect(show(a.chat)).toContain("2 calls");
	});

	test("reload reattaches rebuilt history with the current module generation", async () => {
		const f = setup();
		f.patch.dispose();
		vi.resetModules();
		const { ToolView: ReloadedView } = await import("../src/tool-view.js");
		const { installHostToolGroups: reinstall } = await import("../src/host-transcript-patch.js");
		const rows = [f.row("a"), f.row("b")];
		for (const row of rows) {
			const call = new ReloadedView({ theme, header: { title: "read", status: "running" } });
			call.hide();
			Reflect.set(row, "callRendererComponent", call);
			Reflect.set(
				row,
				"resultRendererComponent",
				new ReloadedView({
					theme,
					header: { title: "read", status: "ok" },
				}),
			);
		}
		f.chat.children = [assistant(["a", "b"]), ...rows];
		const patch = reinstall(
			f.context,
			() => backgrounds,
			() => 1,
		);
		cleanups.push(patch.dispose);
		patch.beginRun();
		// No additional tool lookup: history was already rebuilt before session_start.
		expect(show(f.chat)).toContain("2 calls");
	});

	test("instance shape mismatch falls back to original transcript and reports once", () => {
		const f = setup();
		const row = f.row("a");
		Reflect.deleteProperty(row, "toolCallId");
		f.chat.children = [assistant(["a", "b"]), row, f.row("b")];
		expect(show(f.chat)).toContain("RESULT b");
		show(f.chat);
		expect(f.notify).toHaveBeenCalledTimes(1);
	});

	test("does not overwrite an intervening instance patch; old wrapper becomes pass-through", () => {
		const f = setup();
		const wrapper = f.chat.render;
		const other = (width: number) => wrapper.call(f.chat, width);
		f.chat.render = other;
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		f.patch.dispose();
		expect(f.chat.render).toBe(other);
		expect(show(f.chat)).toContain("RESULT a");
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("restart Pi"), "warning");
	});

	test("container summaries do not require rendering their bodies", () => {
		const render = vi.fn(() => ["private body"]);
		const view = new ToolView({
			theme,
			header: { title: "codemode", status: "none", summary: "2 calls" },
			collapsedRows: { render, invalidate() {} },
		});
		expect(view.summary).toBe("codemode 2 calls");
		expect(render).not.toHaveBeenCalled();
		view.hide();
		expect(view.summary).toBeUndefined();
	});

	/** A line far wider than the frame, with a marker only the last wrapped row can carry. */
	const longLine = `HEAD ${"x".repeat(80)} TAIL-MARKER`;

	test("visible thinking wraps a long line instead of cutting its tail", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"], true, undefined, longLine), f.row("a"), f.row("b")];
		const width = 20;
		const rows = () => f.chat.render(width);
		const category = rows().findIndex((row) => row.includes("thinking"));
		expect(category).toBeGreaterThan(-1);
		click(f.chat, category, width);

		const opened = rows();
		expect(opened.join("\n")).toContain("TAIL-MARKER");
		for (const row of opened) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	});

	test("hidden thinking wraps the full text after opening", () => {
		const f = setup();
		f.begin();
		const message = assistant(["a", "b"], true, undefined, longLine);
		Reflect.set(message, "hideThinkingBlock", true);
		f.chat.children = [message, f.row("a"), f.row("b")];
		const width = 20;
		const rows = () => f.chat.render(width);
		const category = rows().findIndex((row) => row.includes("thinking"));
		expect(category).toBeGreaterThan(-1);
		click(f.chat, category, width);
		expect(rows().join("\n")).not.toContain("TAIL-MARKER");
		const item = rows().findIndex((row, index) => index > category && row.includes("HEAD"));
		expect(item).toBeGreaterThan(category);
		click(f.chat, item, width);
		const opened = rows();
		expect(opened.join("\n")).toContain("TAIL-MARKER");
		for (const row of opened) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		// A wrapped body row is not a hit area; the label itself folds the item again.
		const body = rows().findIndex((row) => row.includes("TAIL-MARKER"));
		click(f.chat, body, width);
		expect(rows().join("\n")).toContain("TAIL-MARKER");
		const label = rows().findIndex((row, index) => index > category && row.includes("HEAD"));
		click(f.chat, label, width);
		expect(rows().join("\n")).not.toContain("TAIL-MARKER");
	});

	test("a thinking run is one item and keeps its paragraphs", () => {
		const f = setup();
		f.begin();
		f.chat.children = [
			assistant([], true, undefined, "first paragraph"),
			assistant(["a", "b"], true, undefined, "second paragraph"),
			f.row("a"),
			f.row("b"),
		];
		// Two consecutive thinking messages are one continuous run: one item, one weight.
		expect(show(f.chat)).toContain("▸ thinking x1 ·");
		clickRow(f.chat, "▸ thinking");
		const rows = show(f.chat).split("\n");
		expect(rows).toContain("▎ first paragraph");
		expect(rows).toContain("");
		expect(rows).toContain("▎ second paragraph");
	});

	test("a block that does not group shows no orphan footer", () => {
		const f = setup();
		f.chat.children = [
			assistant(["a"], false, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }),
			f.row("a"),
		];
		expect(show(f.chat)).not.toContain("collapse views");
		expect(show(f.chat)).not.toContain("requests");
	});

	test("the tail is the transcript's last visible unit, whatever it is", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		expect(show(f.chat)).toContain("RESULT b");
		f.notice("tail notice");
		// The notice is now the last unit: the old tail joins the block and is no longer drawn alone.
		expect(show(f.chat)).toContain("tail notice");
		expect(show(f.chat)).toContain("▸ read ×2");
		expect(show(f.chat)).not.toContain("RESULT b");
	});

	test("agent_end alone does not absorb the tail", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		expect(show(f.chat)).toContain("RESULT b");
		f.patch.endRun();
		f.chat.invalidate();
		expect(show(f.chat)).toContain("RESULT b");
		expect(show(f.chat)).toContain("▸ read ×1");
	});

	test("a category stays open across a tail migration", () => {
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		clickRow(f.chat, "▸ read");
		expect(show(f.chat)).toContain("▾ read ×1");
		// Same block, same component identity: the new unit only changes which unit stays outside.
		f.notice("later notice");
		expect(show(f.chat)).toContain("▾ read ×2");
		expect(show(f.chat)).toContain("later notice");
	});

	test("a thinking tail separates from the block with one blank row, like a tool tail", () => {
		// Pi opens a message zone with an OSC 133 row that paints no cells. Counting that row as
		// content added a second blank row after the block and made the transcript jump as soon as
		// the tail changed from a thinking run to a tool.
		const blankGap = (rows: readonly string[], needle: string): number => {
			const end = rows.findIndex((row) => row.includes(needle));
			let start = end - 1;
			while (start >= 0 && visibleWidth(rows[start] ?? "") === 0) start -= 1;
			return end - start - 1;
		};
		const f = setup(true, tokens);
		f.begin();
		f.chat.children = [assistant(["a"], true), f.row("a"), assistant([], true)];
		const thinkingRows = f.chat.render(80);
		expect(blankGap(thinkingRows, "reason")).toBe(1);
		// The zone marker itself stays: terminal integrations need the row, they just get no blank.
		expect(thinkingRows.some((row) => row.includes("\u001b]133;A"))).toBe(true);

		f.chat.children = [assistant(["a"], true), f.row("a"), f.row("b")];
		expect(blankGap(f.chat.render(80), "✓ read")).toBe(1);
	});

	test("a thinking tail answers a click on its own text", () => {
		// A separator row this unit prepends is a row of the unit, so the part offsets have to move with
		// it: otherwise the click lands past the component's last row and the tail stops opening.
		const f = setup();
		f.begin();
		f.chat.children = [assistant(["a"], true), f.row("a"), assistant([], true)];
		const collapsed = show(f.chat);
		expect(clickRow(f.chat, "reason")).toMatchObject({ handled: true });
		expect(show(f.chat)).not.toBe(collapsed);
	});

	test("eight requests add up exactly, and cache writes stay out of ↑", () => {
		const f = setup();
		const usage = (input: number, output: number, cacheWrite: number) => ({
			input,
			output,
			cacheRead: 0,
			cacheWrite,
		});
		const build = (input: number, output: number, cacheWrite: number) => [
			assistant(["a", "b"], false, usage(input, output, cacheWrite)),
			f.row("a"),
			f.row("b"),
			assistant(["c", "d"], true, usage(input, output, cacheWrite)),
			f.row("c"),
			f.row("d"),
			assistant([], true, usage(input, output, cacheWrite)),
			assistant([], true, usage(input, output, cacheWrite)),
			assistant(["e"], false, usage(input, output, cacheWrite)),
			f.row("e"),
			assistant(["f"], false, usage(input, output, cacheWrite)),
			f.row("f"),
			assistant([], true, usage(input, output, cacheWrite)),
			// The prose that ends the loop is native content, but its request is this block's too.
			assistant([], "text", usage(input, output, cacheWrite)),
		];
		f.chat.children = build(100, 10, 5000);
		// 8 requests: IN is the whole prompt, so a cache write is part of it.
		expect(show(f.chat)).toContain("requests ×8 · ↑800 · ↓80 · W40k");
		f.chat.invalidate();
		expect(show(f.chat)).toContain("requests ×8 · ↑800 · ↓80 · W40k");
		f.chat.children = build(1000, 100, 0);
		expect(show(f.chat)).toContain("requests ×8 · ↑8.0k · ↓800");
	});

	test("the group background follows the block's worst fact", () => {
		const f = setup(true, tokens);
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		expect(show(f.chat)).toContain("[bg:toolSuccessBg]");
		const running = f.row("c", "read", "ok", false, false);
		running.setArgsComplete();
		running.markExecutionStarted();
		f.chat.children = [assistant(["a", "b", "c"]), f.row("a"), f.row("b"), running];
		expect(show(f.chat)).toContain("[bg:toolPendingBg]");
		const failed = f.row("d", "read");
		failed.updateResult({ content: [{ type: "text", text: "boom" }], isError: true });
		f.chat.children = [assistant(["a", "b", "c", "d"]), f.row("a"), f.row("b"), running, failed];
		expect(show(f.chat)).toContain("[bg:toolErrorBg]");
	});

	test("the surface states the last fact and drops five seconds after the block settles", () => {
		vi.useFakeTimers();
		let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			const f = setup(true, tokens);
			f.begin();
			const failed = f.row("a", "read");
			failed.updateResult({ content: [{ type: "text", text: "boom" }], isError: true });
			f.chat.children = [assistant(["a", "b"]), failed, f.row("b")];
			// An earlier failure must not tint a block whose last fact is a success.
			expect(show(f.chat)).toContain("[bg:toolSuccessBg]");
			now = 5_001;
			vi.advanceTimersByTime(5_001);
			// The hold ends on the neutral surface, not on a hole in the block.
			expect(show(f.chat)).toContain("[bg:toolPendingBg]");
			expect(show(f.chat)).not.toContain("[bg:toolSuccessBg]");
			expect(f.requestRender).toHaveBeenCalled();
		} finally {
			clock.mockRestore();
			vi.useRealTimers();
		}
	});

	test("a live member restarts the hold instead of keeping the old surface", () => {
		vi.useFakeTimers();
		let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			const f = setup(true, tokens);
			f.begin();
			f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
			expect(show(f.chat)).toContain("[bg:toolSuccessBg]");
			now = 6_000;
			expect(show(f.chat)).toContain("[bg:toolPendingBg]");
			const running = f.row("c", "read", "ok", false, false);
			running.setArgsComplete();
			running.markExecutionStarted();
			f.chat.children = [assistant(["a", "b", "c"]), f.row("a"), f.row("b"), running];
			expect(show(f.chat)).toContain("[bg:toolPendingBg]");
		} finally {
			clock.mockRestore();
			vi.useRealTimers();
		}
	});

	test("Pi-native tool surfaces sit inside the group surface", () => {
		backgrounds = true;
		try {
			const f = setup(true, tokens);
			f.begin();
			f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
			const rows = show(f.chat).split("\n");
			// The group keeps its own panel; the tool it contains paints its own surface inside it.
			expect(rows.filter((row) => row.includes("[bg:toolSuccessBg]")).length).toBeGreaterThan(4);
		} finally {
			backgrounds = false;
		}
	});

	test("a locally expanded category keeps the group background", () => {
		const f = setup(true, tokens);
		f.begin();
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b")];
		clickRow(f.chat, "read");
		const rows = show(f.chat).split("\n");
		// Header, category, the opened tool's own rows, and the footer are one background block.
		expect(rows.filter((row) => row.includes("[bg:toolSuccessBg]")).length).toBeGreaterThan(4);
		expect(show(f.chat)).toContain("[bg:toolSuccessBg][dim]requests");
	});

	test("the expanded block is transparent and keeps block backgrounds", () => {
		const f = setup(true, tokens);
		f.begin();
		f.chat.children = [assistant(["a", "b"], true, undefined, "reason"), f.row("a"), f.row("b")];
		clickRow(f.chat, "collapse views");
		const text = show(f.chat);
		expect(text).toContain("[text]collapse views[/]");
		// The expanded group fills nothing itself, and neither tools nor thinking runs fill their rows.
		expect(text).not.toContain("[bg:");
	});

	test("an expanded notice keeps its own padded surface", () => {
		const f = setup(true, tokens);
		f.begin();
		const report = new Container();
		Reflect.set(report, "entry", { customType: "bg-bash-info", data: { message: "tail output" } });
		report.addChild(new Spacer(1));
		report.addChild(
			createMessageView({
				theme: tokens,
				header: { kind: "bg-bash", summary: "✓ job", tone: "success" },
				body: "tail output",
			}),
		);
		f.chat.children = [assistant(["a", "b"]), f.row("a"), f.row("b"), report];
		clickRow(f.chat, "collapse views");
		const rows = show(f.chat).split("\n");
		const index = rows.findIndex((row) => row.includes("✓ job"));
		expect(index).toBeGreaterThan(0);
		expect(rows[index]).toContain("[bg:customMessageBg]");
		// The block owns its padding: one filled row sits between it and whatever follows.
		expect(rows[index - 1]).toContain("[bg:customMessageBg]");
	});

	test.each([30, 80, 120])("the statistics footer stays one row at %i columns", (width) => {
		const f = setup();
		f.begin();
		f.chat.children = [
			assistant(["a", "b"], false, {
				input: 123_456,
				output: 7890,
				cacheRead: 1000,
				cacheWrite: 0,
			}),
			f.row("a"),
			f.row("b"),
		];
		const rows = f.chat.render(width);
		expect(rows.filter((row) => row.includes("requests"))).toHaveLength(1);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	});
});
