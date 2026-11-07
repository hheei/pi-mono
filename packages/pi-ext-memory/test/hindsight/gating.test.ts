import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => mock.agentDir,
}));

import {
	HINDSIGHT_MCP_SERVER_NAME,
	HINDSIGHT_MCP_TIMEOUT_SECONDS,
	HINDSIGHT_MCP_TOOL_EXPOSURES,
} from "../../src/hindsight/mcp.js";
import observationalMemory from "../../src/index.js";

interface Hooks {
	readonly names: string[];
	readonly registered: string[];
	readonly mcpServers: Map<string, unknown>;
	readonly toolRenderers: unknown[];
	readonly handlers: Map<string, (event: unknown, context: unknown) => unknown>;
	readonly uiNotifications: Array<{ message: string; type: string }>;
}

function installExtension(): Hooks {
	const names: string[] = [];
	const registered: string[] = [];
	const mcpServers = new Map<string, unknown>();
	const toolRenderers: unknown[] = [];
	const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
	const uiNotifications: Array<{ message: string; type: string }> = [];

	const pi = {
		on: (eventName: string, handler: (event: unknown, context: unknown) => unknown) => {
			names.push(eventName);
			handlers.set(eventName, handler);
			return () => {};
		},
		registerCommand: () => {},
		registerTool: (tool: { name: string }) => {
			registered.push(tool.name);
		},
		getActiveTools: () => [...registered],
		setActiveTools: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
		registerToolRenderer: (resolver: unknown) => {
			toolRenderers.push(resolver);
		},
		registerMcpServer: (name: string, config: unknown) => {
			mcpServers.set(name, config);
		},
		unregisterMcpServer: (name: string) => {
			mcpServers.delete(name);
		},
		getMcpServers: () =>
			[...mcpServers.entries()].map(([name, config]) => ({
				name,
				config,
				extensionPath: "fake",
			})),
	} as unknown as ExtensionAPI;
	observationalMemory(pi);
	return { names, registered, mcpServers, toolRenderers, handlers, uiNotifications };
}

async function startSession(hooks: Hooks, cwd: string): Promise<() => Promise<void>> {
	const sessionContext = {
		cwd,
		ui: {
			notify: (message: string, type: string) => {
				hooks.uiNotifications.push({ message, type });
			},
		},
		sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
	};
	await hooks.handlers.get("session_start")?.(undefined, sessionContext);
	return async () => {
		await hooks.handlers.get("session_shutdown")?.(
			{ type: "session_shutdown", reason: "quit" },
			sessionContext,
		);
	};
}

describe("hindsight opt-in gating", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	let origChildId: string | undefined;
	let origHindsightDisable: string | undefined;

	beforeEach(() => {
		origChildId = process.env.PI_SUBAGENTS_CHILD_ID;
		origHindsightDisable = process.env.PI_HINDSIGHT_DISABLE;
		delete process.env.PI_SUBAGENTS_CHILD_ID;
		delete process.env.PI_HINDSIGHT_DISABLE;

		root = `${tmpdir()}/hindsight-gating-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mock.agentDir = agentDir;
	});

	afterEach(() => {
		if (origChildId !== undefined) process.env.PI_SUBAGENTS_CHILD_ID = origChildId;
		else delete process.env.PI_SUBAGENTS_CHILD_ID;
		if (origHindsightDisable !== undefined) process.env.PI_HINDSIGHT_DISABLE = origHindsightDisable;
		else delete process.env.PI_HINDSIGHT_DISABLE;

		rmSync(root, { recursive: true, force: true });
	});

	it("registers no Hindsight MCP server or legacy tools without an explicit opt-in", async () => {
		const absent = installExtension();
		await startSession(absent, cwd);
		expect(absent.mcpServers.has(HINDSIGHT_MCP_SERVER_NAME)).toBe(false);
		expect(absent.registered.filter((n) => n.startsWith("hindsight_"))).toEqual([]);
		// The session-scoped memory tool is still registered: gating applies only to Hindsight.
		expect(absent.registered).toContain("om_recall_evidence");

		writeFileSync(
			join(agentDir, "ext_settings.json"),
			JSON.stringify({
				"pi-ext-memory": { hindsight: { enabled: false, apiUrl: "http://unused" } },
			}),
			"utf-8",
		);
		const disabled = installExtension();
		await startSession(disabled, cwd);
		expect(disabled.mcpServers.has(HINDSIGHT_MCP_SERVER_NAME)).toBe(false);
		expect(disabled.registered.filter((n) => n.startsWith("hindsight_"))).toEqual([]);
	});

	it("registers the hindsight MCP server once enabled and unregisters it on shutdown", async () => {
		writeFileSync(
			join(agentDir, "ext_settings.json"),
			JSON.stringify({
				"pi-ext-memory": {
					hindsight: {
						enabled: true,
						apiUrl: "http://hindsight.test:38888",
						bankId: "coding-agent::project",
					},
				},
			}),
			"utf-8",
		);
		const hooks = installExtension();
		const shutdown = await startSession(hooks, cwd);

		expect(hooks.mcpServers.has(HINDSIGHT_MCP_SERVER_NAME)).toBe(true);
		const config = hooks.mcpServers.get(HINDSIGHT_MCP_SERVER_NAME) as Record<string, unknown>;
		expect(config.type).toBe("http");
		expect(config.url).toBe("http://hindsight.test:38888/mcp/coding-agent%3A%3Aproject/");
		expect(config.exposure).toBe("deferred");
		expect(config.toolExposure).toEqual(HINDSIGHT_MCP_TOOL_EXPOSURES);
		expect(config.timeout).toBe(HINDSIGHT_MCP_TIMEOUT_SECONDS);

		// On session shutdown, the MCP server is unregistered cleanly
		await shutdown();
		expect(hooks.mcpServers.has(HINDSIGHT_MCP_SERVER_NAME)).toBe(false);
	});

	it("registers an explicitly shared bank without a startup warning", async () => {
		writeFileSync(
			join(agentDir, "ext_settings.json"),
			JSON.stringify({
				"pi-ext-memory": {
					hindsight: { enabled: true, apiUrl: "http://hindsight.test:38888", bankId: "hheei" },
				},
			}),
			"utf-8",
		);
		const hooks = installExtension();
		await startSession(hooks, cwd);
		expect(hooks.mcpServers.has(HINDSIGHT_MCP_SERVER_NAME)).toBe(true);
		expect(hooks.uiNotifications.some((n) => n.message.includes("using shared bank"))).toBe(false);
	});

	it("notifies warning when an external mcp.json overrides hindsight", async () => {
		writeFileSync(
			join(agentDir, "ext_settings.json"),
			JSON.stringify({
				"pi-ext-memory": { hindsight: { enabled: true, apiUrl: "http://hindsight.test:38888" } },
			}),
			"utf-8",
		);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { [HINDSIGHT_MCP_SERVER_NAME]: { url: "http://other" } } }),
			"utf-8",
		);

		const hooks = installExtension();
		await startSession(hooks, cwd);
		expect(
			hooks.uiNotifications.some(
				(n) => n.type === "warning" && n.message.includes("overridden by .pi/mcp.json"),
			),
		).toBe(true);
	});
});
