import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getRuntimeSettingsRegistry,
	type MessageViewSpec,
	messageViewPoint,
	registerExtensionHook,
} from "@hheei/pi-ext-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import piOptimizerExtension from "../src/extension.js";
import { createOptimizerInfo } from "../src/info.js";
import {
	createOptimizerSettingsProvider,
	DEFAULT_OPTIMIZER_SETTINGS,
	parseOptimizerSettings,
} from "../src/settings.js";

type Handler = (event: never, context: never) => unknown | Promise<unknown>;
type Command = { readonly handler: (args: string, context: ExtensionContext) => Promise<void> };
type Entry = { readonly type: string; readonly data: unknown };
type Renderer = Parameters<ExtensionAPI["registerEntryRenderer"]>[1];

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function temporarySettings(root?: unknown): Promise<{ cwd: string; path: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-optimizer-"));
	directories.push(cwd);
	const path = join(cwd, "ext_settings.json");
	if (root !== undefined) await writeFile(path, JSON.stringify(root));
	return { cwd, path };
}

function fakePi(): {
	readonly pi: ExtensionAPI;
	readonly handlers: Map<string, Handler[]>;
	readonly commands: Map<string, Command>;
	readonly entries: Entry[];
	readonly renderers: Map<string, Renderer>;
} {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	const entries: Entry[] = [];
	const renderers = new Map<string, Renderer>();
	const pi = {
		on(channel: string, handler: Handler): void {
			handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
		},
		registerCommand(name: string, command: Command): void {
			commands.set(name, command);
		},
		registerEntryRenderer(type: string, renderer: Renderer): void {
			renderers.set(type, renderer);
		},
		appendEntry(type: string, data: unknown): void {
			entries.push({ type, data });
		},
		exec: async (): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> => ({
			code: 3,
			stdout: "rtk git status",
			stderr: "",
			killed: false,
		}),
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands, entries, renderers };
}

/** The host always supplies mutable prompt sections alongside the rendered prompt. */
function beforeStart(systemPrompt = "base"): {
	systemPrompt: string;
	systemPromptOptions: { sections: Record<string, string> };
} {
	return { systemPrompt, systemPromptOptions: { sections: {} } };
}

async function emit(
	handlers: Map<string, Handler[]>,
	channel: string,
	event: unknown,
	ctx: ExtensionContext,
): Promise<readonly unknown[]> {
	return Promise.all(
		(handlers.get(channel) ?? []).map((handler) => handler(event as never, ctx as never)),
	);
}

function context(
	cwd: string,
	sessionId = "session",
	mode: "tui" | "json" | "rpc" = "tui",
): ExtensionContext {
	return {
		cwd,
		mode,
		hasUI: mode !== "json",
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify: () => undefined },
	} as unknown as ExtensionContext;
}

function command(host: ReturnType<typeof fakePi>): Command {
	const registered = host.commands.get("optimizer");
	if (registered === undefined) throw new Error("optimizer command missing");
	return registered;
}

describe("optimizer info entries", () => {
	test("append immediately, never enter the model, and render summaries or expanded details", () => {
		const host = fakePi();
		const info = createOptimizerInfo(host.pi);
		info("RTK rewrote Bash", { originalCommand: "git status", executionCommand: "rtk git status" });
		info("Settings failed", { reason: "disk unavailable" }, true);

		expect(host.entries).toEqual([
			{
				type: "optimizer-info",
				data: {
					summary: "RTK rewrote Bash",
					details: { originalCommand: "git status", executionCommand: "rtk git status" },
					warning: undefined,
				},
			},
			{
				type: "optimizer-info",
				data: {
					summary: "Settings failed",
					details: { reason: "disk unavailable" },
					warning: true,
				},
			},
		]);
		const renderer = host.renderers.get("optimizer-info");
		if (renderer === undefined) throw new Error("optimizer entry renderer missing");
		const entry = { data: host.entries[0]?.data } as Parameters<Renderer>[0];
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		} as never;
		const collapsed = renderer(
			entry,
			{ expanded: false, keyText: () => "", keyHint: (_keybinding, description) => description },
			theme,
		)
			?.render(48)
			.join("\n");
		const expanded = renderer(
			entry,
			{ expanded: true, keyText: () => "", keyHint: (_keybinding, description) => description },
			theme,
		)
			?.render(120)
			.join("\n");
		const warning = renderer(
			{ data: host.entries[1]?.data } as Parameters<Renderer>[0],
			{ expanded: false, keyText: () => "", keyHint: (_keybinding, description) => description },
			theme,
		)
			?.render(48)
			.join("\n");
		expect(collapsed).toContain("RTK rewrote Bash");
		expect(collapsed).not.toContain("originalCommand");
		expect(expanded).toContain("originalCommand");
		expect(warning).toContain("warning");
	});

	test("uses the optional message view for details and warnings", async () => {
		const host = fakePi();
		createOptimizerInfo(host.pi);
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		} as never;
		let spec: MessageViewSpec | undefined;
		const hook = registerExtensionHook(host.pi, messageViewPoint, (value) => {
			spec = value;
			return { render: () => ["view"], invalidate() {} };
		});
		const renderer = host.renderers.get("optimizer-info");
		if (renderer === undefined) throw new Error("optimizer entry renderer missing");
		const entry = {
			data: {
				summary: "RTK query failed",
				details: { reason: "timeout" },
				warning: true,
			},
		} as Parameters<Renderer>[0];
		expect(
			renderer(
				entry,
				{ expanded: true, keyText: () => "", keyHint: (_keybinding, description) => description },
				theme,
			)
				?.render(40)
				.join("\n"),
		).toBe("view");
		expect(spec?.header).toEqual({
			kind: "optimizer",
			summary: "RTK query failed",
			tone: "warning",
		});
		expect(spec?.body).toContain("timeout");
		expect(spec?.preview).toBeUndefined();
		expect(spec?.stateHolder).toBe(entry);
		await hook.dispose();
	});
});

describe("settings persistence", () => {
	test("defaults absent settings and fails closed for malformed state", async () => {
		expect(parseOptimizerSettings(undefined)).toEqual(DEFAULT_OPTIMIZER_SETTINGS);
		const { path } = await temporarySettings({
			t2s: false,
			rootSibling: { kept: true },
		});
		const provider = createOptimizerSettingsProvider({ path });
		await expect(provider.storage.load({ sessionId: "s" })).rejects.toThrow(
			"Invalid pi-optimizer settings",
		);
		await provider.storage.save(DEFAULT_OPTIMIZER_SETTINGS, { sessionId: "s" });
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			...DEFAULT_OPTIMIZER_SETTINGS,
			rootSibling: { kept: true },
		});
	});
});

describe("extension session integration", () => {
	test("keeps T2S and prompts session-local, records only changes, and ignores stale provider reloads", async () => {
		const { cwd, path } = await temporarySettings();
		const host = fakePi();
		piOptimizerExtension(host.pi, { settingsPath: path });
		const first = context(cwd, "same-id");
		await emit(host.handlers, "session_start", {}, first);
		expect(
			await emit(host.handlers, "input", { text: "設定", source: "interactive" }, first),
		).toEqual([{ action: "transform", text: "设定" }]);
		// Subsequent interactive T2S conversion in the same session is transformed without repeating info entry
		expect(
			await emit(host.handlers, "input", { text: "再次設定", source: "interactive" }, first),
		).toEqual([{ action: "transform", text: "再次设定" }]);
		expect(await emit(host.handlers, "input", { text: "設定", source: "rpc" }, first)).toEqual([
			undefined,
		]);
		expect(
			host.entries.filter(
				(entry) =>
					typeof entry.data === "object" &&
					entry.data !== null &&
					"summary" in entry.data &&
					typeof entry.data.summary === "string" &&
					entry.data.summary.includes("T2S"),
			),
		).toHaveLength(1);
		const beforeInactivePrompt = host.entries.length;
		expect(await emit(host.handlers, "before_agent_start", beforeStart(), first)).toEqual([
			undefined,
		]);
		expect(host.entries).toHaveLength(beforeInactivePrompt);
		await command(host).handler("caveman full", first);
		const firstEvent = beforeStart();
		await emit(host.handlers, "before_agent_start", firstEvent, first);
		const secondEvent = beforeStart();
		await emit(host.handlers, "before_agent_start", secondEvent, first);
		expect(firstEvent.systemPromptOptions.sections["pi-optimizer"]).toMatch(/CAVEMAN MODE/su);
		expect(secondEvent.systemPromptOptions.sections).toEqual(
			firstEvent.systemPromptOptions.sections,
		);
		// The rendered prompt is host-owned; the handler only adds its own section.
		expect(firstEvent.systemPrompt).toBe("base");
		// Info is emitted once on mode activation; subsequent turns with same mode do not repeat info
		expect(
			host.entries.filter(
				(entry) =>
					typeof entry.data === "object" &&
					entry.data !== null &&
					"summary" in entry.data &&
					entry.data.summary === "Prompt · Caveman full",
			),
		).toHaveLength(1);
		const oldProvider = getRuntimeSettingsRegistry(host.pi).get("pi-optimizer");
		await writeFile(path, "{}");
		await emit(host.handlers, "session_shutdown", {}, first);
		await emit(host.handlers, "session_start", {}, first);
		await oldProvider?.onChange?.(
			{
				groupId: "caveman",
				fieldId: "level",
				value: "full",
				state: { ...DEFAULT_OPTIMIZER_SETTINGS, t2s: { mode: "off" }, caveman: { level: "full" } },
			},
			{ sessionId: "same-id", cwd, signal: new AbortController().signal },
		);
		expect(await emit(host.handlers, "before_agent_start", beforeStart(), first)).toEqual([
			undefined,
		]);
		expect(host.entries.filter((entry) => entry.type === "optimizer-info")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					data: expect.objectContaining({
						summary: expect.stringContaining("T2S"),
						details: { original: "設定", transformed: "设定" },
					}),
				}),
				expect.objectContaining({
					data: expect.objectContaining({
						summary: "Prompt · Caveman full",
						details: expect.objectContaining({ prompt: expect.stringContaining("CAVEMAN MODE") }),
					}),
				}),
			]),
		);
	});

	test("serializes overlapping command updates without losing fields", async () => {
		const { cwd, path } = await temporarySettings();
		const host = fakePi();
		piOptimizerExtension(host.pi, { settingsPath: path });
		const rpc = context(cwd, "session", "rpc");
		await emit(host.handlers, "session_start", {}, rpc);
		await Promise.all([
			command(host).handler("caveman full", rpc),
			command(host).handler("rtk on", rpc),
		]);
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			caveman: { level: "full" },
			rtk: { enabled: true, path: "" },
		});
	});

	test("command exposes JSON status, and menus save, cancel, or report errors through info", async () => {
		const { cwd, path } = await temporarySettings();
		const host = fakePi();
		piOptimizerExtension(host.pi, { settingsPath: path });
		const rpc = context(cwd, "session", "rpc");
		await emit(host.handlers, "session_start", {}, rpc);
		await command(host).handler("", rpc);
		expect(host.entries.at(-1)).toEqual(
			expect.objectContaining({
				data: expect.objectContaining({ summary: expect.stringContaining("T2S") }),
			}),
		);

		const tui = context(cwd, "session");
		const select = vi
			.fn()
			.mockResolvedValueOnce("Caveman: off")
			.mockResolvedValueOnce("full")
			.mockResolvedValueOnce("Close");
		await command(host).handler("", { ...tui, ui: { ...tui.ui, select } });
		expect(select.mock.calls[2]?.[1]).toContain("Caveman: full");
		const saveCount = host.entries.length;
		await command(host).handler("", {
			...tui,
			ui: { ...tui.ui, select: vi.fn().mockResolvedValue(undefined) },
		});
		expect(host.entries).toHaveLength(saveCount);
		await writeFile(path, "invalid JSON");
		const failingMenu = vi
			.fn()
			.mockResolvedValueOnce("RTK: off")
			.mockResolvedValueOnce("on")
			.mockResolvedValueOnce("Close");
		await command(host).handler("", { ...tui, ui: { ...tui.ui, select: failingMenu } });
		expect(host.entries.at(-1)).toEqual(
			expect.objectContaining({ data: expect.objectContaining({ warning: true }) }),
		);
		const bash = {
			type: "tool_call",
			toolName: "bash",
			toolCallId: "after-failed-save",
			input: { command: "git status" },
		};
		await emit(host.handlers, "tool_call", bash, tui);
		expect(bash.input.command).toBe("git status");
	});
});
