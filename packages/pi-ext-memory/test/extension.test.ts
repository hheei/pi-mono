import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRuntimeSettingsRegistry } from "@hheei/pi-ext-core";
import { describe, expect, it, vi } from "vitest";
import observationalMemory from "../src/index.js";

vi.mock("../src/hindsight/session.js", () => ({
	startHindsightSession: vi.fn(async () => ({ status: "disabled" })),
}));

describe("observationalMemory extension entry", () => {
	it("registers triggers, hooks, commands, tools, and ext-core lifecycle", async () => {
		const registeredEvents: string[] = [];
		const handlers: Record<string, ((event: unknown, ctx: unknown) => void) | undefined> = {};
		const commands: Record<string, unknown> = {};
		const tools: Record<string, unknown> = {};

		const pi = {
			on: vi.fn((eventName: string, handler: (event: unknown, ctx: unknown) => void) => {
				registeredEvents.push(eventName);
				handlers[eventName] = handler;
			}),
			registerCommand: vi.fn((name: string, command: unknown) => {
				commands[name] = command;
			}),
			registerTool: vi.fn((tool: { name: string }) => {
				tools[tool.name] = tool;
			}),
			registerEntryRenderer: vi.fn(),
			registerToolRenderer: vi.fn(),
			appendEntry: vi.fn(),
		};

		observationalMemory(pi as unknown as ExtensionAPI);

		// Core lifecycle events registered by registerExtensionLifecycle
		expect(registeredEvents).toContain("session_start");
		expect(registeredEvents).toContain("session_shutdown");

		// Trigger hooks
		expect(registeredEvents).toContain("agent_start");
		expect(registeredEvents).toContain("turn_end");
		expect(registeredEvents).toContain("agent_settled");
		expect(registeredEvents).toContain("session_before_compact");

		// Commands: one command surface, with actions as subcommands
		expect(Object.keys(commands)).toEqual(["om"]);

		// Tool
		expect(tools).toHaveProperty("om_recall_evidence");

		// Lifecycle session start & shutdown
		const sessionContext = {
			cwd: "/tmp/test-project",
			sessionManager: {
				getSessionId: () => "test-session-id",
			},
		};
		await handlers.session_start?.(undefined, sessionContext);

		const registry = getRuntimeSettingsRegistry(pi as unknown as ExtensionAPI);
		expect(registry.get("pi-ext-memory")).toBeDefined();
		expect(registry.get("pi-ext-memory")?.id).toBe("pi-ext-memory");

		await handlers.session_shutdown?.({ type: "session_shutdown", reason: "quit" }, sessionContext);
		expect(registry.get("pi-ext-memory")).toBeUndefined();
	});
});
