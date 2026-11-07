import { rmSync } from "node:fs";
import {
	type ExtensionAPI,
	type ExtensionToolContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { BashJobRegistry } from "../src/bash-jobs.js";
import { bashExecutionDirectory } from "../src/bash-ledger.js";
import * as bashSettings from "../src/bash-settings.js";
import { registerBgBashTools } from "../src/bg-bash-tools.js";
import { createBashRuntime, registerBashLifecycle } from "../src/session-state.js";
import { toolFor, toolHost } from "./fixtures/harness.js";
import { ledgerTemporaryDirectory } from "./fixtures/ledger-directory.js";

interface Lifecycle {
	readonly tools: ReturnType<typeof toolHost>["tools"];
	readonly start: () => Promise<void>;
	readonly shutdown: (reason?: "quit" | "reload" | "new" | "resume" | "fork") => Promise<void>;
	readonly fire: (type: string, event?: Record<string, unknown>) => Promise<void>;
	readonly warnings: string[];
	readonly context: ExtensionToolContext;
	readonly directory: string;
	readonly manager: SessionManager;
	readonly jobs: () => BashJobRegistry | undefined;
	readonly settings: () => bashSettings.BashSettings;
}

const open: Lifecycle[] = [];

afterEach(async () => {
	for (const current of open.splice(0)) {
		await current.shutdown();
		rmSync(current.directory, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

/** One extension session: the lifecycle handlers Pi would call, over a real settings registry. */
function lifecycle(existing?: SessionManager): Lifecycle {
	const directory = ledgerTemporaryDirectory("pi-bash-lifecycle-");
	const host = toolHost();
	const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void> | void>();
	const warnings: string[] = [];
	const manager = existing ?? SessionManager.create(process.cwd(), directory);
	const context = {
		sessionManager: manager,
		isIdle: () => true,
		ui: { notify: (message: string) => void warnings.push(message), setStatus: vi.fn() },
		cwd: process.cwd(),
	} as unknown as ExtensionToolContext;
	const pi = {
		events: {},
		registerTool: host.pi.registerTool,
		getActiveTools: host.activeTools,
		setActiveTools: host.pi.setActiveTools,
		sendMessage: () => undefined,
		appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
		on(type: string, handler: (event: unknown, context: unknown) => Promise<void> | void) {
			handlers.set(type, handler);
			return () => {
				handlers.delete(type);
			};
		},
	} as unknown as ExtensionAPI;
	const runtime = createBashRuntime();
	registerBgBashTools(pi, runtime.state);
	registerBashLifecycle(pi, runtime.slot);
	const fire = async (type: string, event: Record<string, unknown> = {}): Promise<void> => {
		await handlers.get(type)?.({ type, ...event }, context);
	};
	const current: Lifecycle = {
		tools: host.tools,
		fire,
		start: () => fire("session_start"),
		shutdown: (reason) => fire("session_shutdown", reason === undefined ? {} : { reason }),
		warnings,
		context,
		directory,
		manager,
		jobs: () => runtime.state.getBashJobs(),
		settings: () => runtime.state.getSettings(),
	};
	open.push(current);
	return current;
}

test("each session reads current Bash settings after registration", async () => {
	const read = vi.spyOn(bashSettings, "readBashSettings");
	const current = lifecycle();
	expect(read).not.toHaveBeenCalled();
	const first = { shellPath: "/bin/sh", bashOutputTailKiB: 4 };
	read.mockReturnValue(first);
	await current.start();
	expect(current.settings()).toEqual(first);
	await current.shutdown();
	const next = { shellPath: "/bin/bash", bashOutputTailKiB: 12 };
	read.mockReturnValue(next);
	await current.start();
	expect(current.settings()).toEqual(next);
	expect(read).toHaveBeenCalledTimes(2);
});

test("an extension reload carries running jobs into the next start instead of stopping them", async () => {
	const current = lifecycle();
	await current.start();
	const started = await toolFor(current.tools, "bg_bash_spawn").execute(
		"call",
		{ command: "sleep 30" },
		undefined,
		undefined,
		current.context,
	);
	expect(started).not.toMatchObject({ isError: true });
	const { id } = started.details as { id: string };
	const owned = current.jobs();

	await current.shutdown("reload");
	expect(current.jobs()).toBeUndefined();
	await current.start();

	// The same registry answers again: the child kept running, so nothing was restarted or rebuilt.
	expect(current.jobs()).toBe(owned);
	expect(current.jobs()?.get(id)).toMatchObject({ status: "running" });
	// No second instance opened the ledger, so the reload never looked like a concurrent Pi.
	expect(current.warnings).toEqual([]);

	await current.shutdown();
	expect(current.jobs()).toBeUndefined();
});

test("a session start owns one Bash registry and teardown releases it", async () => {
	const current = lifecycle();
	await current.start();
	expect(current.warnings).toEqual([]);
	const spawn = toolFor(current.tools, "bg_bash_spawn");
	const started = await spawn.execute(
		"call",
		{ command: "sleep 30" },
		undefined,
		undefined,
		current.context,
	);
	expect(started).not.toMatchObject({ isError: true });
	const { id } = started.details as { id: string };
	await current.fire("tool_result");
	// The footer follows the shared streaming repaint window, so the first change lands immediately
	// and the settled state arrives on the trailing paint rather than synchronously.
	expect(id).toMatch(/^bash-[0-9a-f]{6}$/u);
	await vi.waitFor(() =>
		expect(current.context.ui.setStatus).toHaveBeenLastCalledWith("pi-bg-bash", "bash x1"),
	);

	// Teardown stops the owned process and waits for its exit before the session is gone.
	await current.shutdown();
	expect(current.context.ui.setStatus).toHaveBeenLastCalledWith("pi-bg-bash", undefined);
	// A second shutdown and a second start stay harmless.
	await current.shutdown();
	await current.start();
});

test("a session restart restores reliable execution records and preserves their ID", async () => {
	const current = lifecycle();
	await current.start();
	const result = await toolFor(current.tools, "bg_bash_spawn").execute(
		"call",
		{ command: "printf lifecycle-output" },
		undefined,
		undefined,
		current.context,
	);
	const { id } = result.details as { id: string };
	expect(await current.jobs()?.waitFor(id)).toMatchObject({
		status: "completed",
		output: "lifecycle-output",
	});
	await current.shutdown();
	await current.start();
	expect(current.jobs()?.get(id)).toMatchObject({
		status: "completed",
		output: "lifecycle-output",
		exitCode: 0,
	});
});

test("real fork preserves history while isolating execution ownership and original-session recovery", async () => {
	const current = lifecycle();
	current.manager.appendMessage({
		role: "user",
		content: "start background build",
		timestamp: Date.now(),
	});
	await current.start();
	const result = await toolFor(current.tools, "bg_bash_spawn").execute(
		"spawn",
		{ command: "printf fork-output" },
		undefined,
		undefined,
		current.context,
	);
	const { id } = result.details as { id: string };
	expect(await current.jobs()?.waitFor(id)).toMatchObject({
		status: "completed",
		output: "fork-output",
	});
	const leaf = current.manager.appendCustomEntry("historical-bg-spawn", { id });
	const originalFile = current.manager.getSessionFile()!;
	const originalSession = current.manager.getSessionId();
	const originalDirectory = bashExecutionDirectory(current.context);
	const originalEntries = current.manager.getBranch().map((entry) => entry.id);
	await current.shutdown();
	current.manager.createBranchedSession(leaf);
	expect(current.manager.getSessionId()).not.toBe(originalSession);
	expect(current.manager.getBranch().map((entry) => entry.id)).toEqual(originalEntries);
	expect(bashExecutionDirectory(current.context)).not.toBe(originalDirectory);
	await current.start();
	expect(current.jobs()?.get(id)).toBeUndefined();
	expect(current.jobs()?.pendingDeliveries()).toEqual([]);
	for (const name of ["bg_bash_get", "bg_bash_stop"]) {
		await expect(
			toolFor(current.tools, name).execute(name, { id }, undefined, undefined, current.context),
		).rejects.toThrow("not found");
	}
	await current.shutdown();
	current.manager.setSessionFile(originalFile);
	await current.start();
	expect(current.manager.getSessionId()).toBe(originalSession);
	expect(current.jobs()?.get(id)).toMatchObject({
		status: "completed",
		output: "fork-output",
		exitCode: 0,
	});
});

test("a second mount of one session stays unavailable instead of failing the extension", async () => {
	const owner = lifecycle();
	owner.manager.appendMessage({
		role: "user",
		content: "record this session",
		timestamp: Date.now(),
	});
	await owner.start();
	const viewer = lifecycle(SessionManager.open(owner.manager.getSessionFile()!));
	await viewer.start();
	expect(viewer.jobs()).toBeUndefined();
	expect(viewer.warnings).toEqual([
		"Background Bash unavailable: another Pi instance is recording this session. Fork or start a new session to run it here.",
	]);
	const spawn = toolFor(viewer.tools, "bg_bash_spawn");
	expect(
		await spawn.execute("call", { command: "printf no" }, undefined, undefined, viewer.context),
	).toMatchObject({ isError: true });
	// The owner releases the ledger on shutdown, so the same session becomes writable again.
	await owner.shutdown();
	await viewer.start();
	expect(viewer.jobs()).toBeDefined();
});

test("teardown of an idle session registers and disposes a registry exactly once", async () => {
	const current = lifecycle();
	await current.start();
	await current.start();
	await current.shutdown();
	expect(current.warnings).toEqual([]);
});

test("a registry dispose is awaited, so shutdown never returns with a live tree", async () => {
	const jobs = new BashJobRegistry();
	const started = jobs.start({ command: "sleep 30", cwd: process.cwd(), background: true });
	expect(started.status).toBe("running");
	await jobs.dispose();
	// The process reported its exit before dispose resolved, so no record survives teardown.
	expect(jobs.get(started.id)).toBeUndefined();
	expect(jobs.pendingDeliveries()).toEqual([]);
});
