import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { EffectiveLaunchConfig, SubagentRecord } from "../src/domain.js";
import { BRIDGE_ENVIRONMENT_KEYS } from "../src/domain.js";
import type { HostAdapter, HostAttachment } from "../src/host-adapter.js";
import type { LaunchSpec } from "../src/launch-spec.js";
import { assembleChildPrompt } from "../src/launch-spec.js";
import { createSubagentRegistry } from "../src/registry.js";
import {
	launchChild,
	openChildPanel,
	parentBridgeEndpoint,
	prepareRuntimeDirectory,
} from "../src/runtime.js";
import { withTempDir } from "./helpers/tmp-dir.js";

const PARENT_SESSION_ID = "01J7-parent";

function launchConfig(subagentId: string, cwd: string): EffectiveLaunchConfig {
	return {
		subagentId,
		// A stand-in child: it holds stdin open exactly like a headless Pi and exits with the pipe.
		invocation: { command: process.execPath, args: ["-e", "process.stdin.resume()"] },
		cwd,
		sessionId: `${subagentId}-session`,
		sessionDir: join(cwd, "sessions"),
		agent: {
			name: "worker",
			hidden: false,
			sourcePath: join(cwd, "worker.md"),
			instructions: "Do the work.",
		},
		model: { provider: "anthropic", id: "claude-sonnet-4", source: "parent" },
		thinking: { level: "medium", source: "parent" },
		tools: ["contact_parent"],
		excludeTools: [],
		extensions: { discovery: false, paths: ["/pkg/dist/extension.js"] },
		skills: { discovery: true, paths: [] },
		mcp: { enabled: true },
		prompt: assembleChildPrompt("Do the work."),
		bridgeExtensionPath: "/pkg/dist/extension.js",
	};
}

function record(id: string, cwd: string): SubagentRecord {
	const config = launchConfig(id, cwd);
	return {
		subagentId: id,
		parentSessionId: PARENT_SESSION_ID,
		revision: 1,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		sessionId: config.sessionId,
		cwd,
		initialTask: "Do the work.",
		intent: "active",
		state: "running",
		presentation: "background",
		persistence: "never_flushed",
		launchConfig: config,
	};
}

describe("parent bridge endpoint", () => {
	test("is a stable path per parent session in a private runtime directory", () => {
		const endpoint = parentBridgeEndpoint(PARENT_SESSION_ID);
		expect(endpoint.endsWith("state.sqlite")).toBe(true);
		expect(parentBridgeEndpoint("another")).toBe(endpoint);
	});

	test("creates the runtime directory", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			await expect(prepareRuntimeDirectory()).resolves.toContain("pi-subagents-");
			void directory;
		});
	});
});

describe("launching a child runtime", () => {
	test("spawns a headless child, records its runtime and waits for the bridge", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const registry = createSubagentRegistry({
				parentSessionId: PARENT_SESSION_ID,
				filePath: join(directory, "registry.json"),
			});
			await mkdir(join(directory, "work"), { recursive: true });
			const stored = await registry.create(record("sa_launch", join(directory, "work")));
			const waitForBridge = vi.fn(async () => true);

			const launched = await launchChild({
				registry,
				record: stored,
				waitForBridge,
			});
			const runtime = launched.handle;
			if (runtime === undefined) throw new Error(launched.failure);
			expect(runtime.pid).toBeGreaterThan(0);
			expect(runtime.alive).toBe(true);
			expect(waitForBridge).toHaveBeenCalledWith("sa_launch", undefined);

			const current = await registry.get("sa_launch");
			expect(current?.runtime?.endpoint).toBe(parentBridgeEndpoint(PARENT_SESSION_ID));
			expect(current?.runtime?.runtimeIdentity).toBeTruthy();

			await runtime.terminate();
			await expect(runtime.exited).resolves.toBeDefined();
			expect(runtime.alive).toBe(false);
		});
	});

	test("ends a child that never connects instead of leaving it unreachable", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const registry = createSubagentRegistry({
				parentSessionId: PARENT_SESSION_ID,
				filePath: join(directory, "registry.json"),
			});
			await mkdir(join(directory, "work"), { recursive: true });
			const stored = await registry.create(record("sa_silent", join(directory, "work")));

			const launched = await launchChild({
				registry,
				record: stored,
				waitForBridge: async () => false,
			});
			expect(launched.failure).toMatch(/never connected to the parent bridge/);
			// The process did stop, so nothing is handed back for the caller to keep.
			expect(launched.handle).toBeUndefined();

			const current = await registry.get("sa_silent");
			// Confirmed cleanup leaves no runtime evidence that could block a safe retry.
			expect(current?.runtime).toBeUndefined();
		});
	});
});

describe("opening a child in a host panel", () => {
	/** A host that records what it was asked to open and counts the panels it was asked to close. */
	function fakeHost(
		behavior: {
			readonly failOpen?: string;
			readonly refuseClose?: boolean;
			readonly earlyExit?: string;
			readonly containerGone?: string;
			readonly initialPending?: boolean;
		} = {},
	): {
		readonly host: HostAdapter;
		readonly specs: LaunchSpec[];
		readonly cleanups: () => number;
	} {
		const specs: LaunchSpec[] = [];
		let cleanups = 0;
		const identity = {
			host: "herdr",
			attachmentId: "wG:tH",
			createdBy: PARENT_SESSION_ID,
		} as const;
		return {
			specs,
			cleanups: () => cleanups,
			host: {
				kind: "herdr",
				async probe() {
					return { host: "herdr", available: true, reason: "test host" };
				},
				async open(spec): Promise<HostAttachment> {
					specs.push(spec);
					if (behavior.failOpen !== undefined) throw new Error(behavior.failOpen);
					let alive = true;
					let observeCall = 0;
					return {
						identity,
						launch: { stdout: "", stderr: "", exitCode: 0, timedOut: false },
						presence: "observable",
						async observe() {
							observeCall += 1;
							if (behavior.containerGone !== undefined) {
								return {
									identity,
									alive: false,
									known: true,
									containerGone: true,
									focused: false,
									detail: behavior.containerGone,
								};
							}
							if (behavior.earlyExit !== undefined) {
								if (observeCall === 1) {
									return { identity, alive: true, known: true, focused: false, detail: "" };
								}
								return {
									identity,
									alive: false,
									known: true,
									focused: false,
									detail: behavior.earlyExit,
								};
							}
							if (behavior.initialPending && observeCall === 1) {
								return { identity, alive: false, known: true, focused: false, detail: "" };
							}
							return { identity, alive, known: true, focused: false, detail: "" };
						},
						async cleanup() {
							cleanups += 1;
							if (behavior.refuseClose === true) {
								return { stdout: "", stderr: "close denied", exitCode: 1, timedOut: false };
							}
							alive = false;
							return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
						},
					};
				},
			},
		};
	}

	async function panelSetup(directory: string): Promise<{
		readonly registry: ReturnType<typeof createSubagentRegistry>;
		readonly stored: SubagentRecord;
	}> {
		const registry = createSubagentRegistry({
			parentSessionId: PARENT_SESSION_ID,
			filePath: join(directory, "registry.json"),
		});
		await mkdir(join(directory, "work"), { recursive: true });
		const stored = await registry.create(record("sa_panel", join(directory, "work")));
		return { registry, stored };
	}

	test("runs the same Pi argv as a background child, minus --mode", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const { registry, stored } = await panelSetup(directory);
			const { host, specs } = fakeHost();
			const waitForBridge = vi.fn(async () => true);

			const opened = await openChildPanel({
				registry,
				record: stored,
				host,
				waitForBridge,
			});
			expect(opened.failure).toBeUndefined();
			const attachment = opened.handle;
			if (attachment === undefined) throw new Error("no panel was opened");
			expect(attachment.identity.attachmentId).toBe("wG:tH");
			expect(waitForBridge).toHaveBeenCalledWith("sa_panel", expect.any(AbortSignal));

			const spec = specs[0];
			expect(spec?.presentation).toBe("panel");
			expect(spec?.stdio).toBe("inherit");
			expect(spec?.argv).not.toContain("--mode");
			expect(spec?.env[BRIDGE_ENVIRONMENT_KEYS.endpoint]).toBe(
				parentBridgeEndpoint(PARENT_SESSION_ID),
			);
			const current = await registry.get("sa_panel");
			expect(current?.runtime?.runtimeIdentity).toBeTruthy();
		});
	});

	test("closes the panel when the child never connects", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const { registry, stored } = await panelSetup(directory);
			const { host, cleanups } = fakeHost();

			const opened = await openChildPanel({
				registry,
				record: stored,
				host,
				waitForBridge: async () => false,
			});
			expect(opened.failure).toMatch(/never connected to the parent bridge/);
			// The panel is closed and confirmed gone, so the caller holds nothing.
			expect(opened.handle).toBeUndefined();

			expect(cleanups()).toBe(1);
			const current = await registry.get("sa_panel");
			expect(current?.runtime).toBeUndefined();
		});
	});

	test("hands back a panel it could not close so nothing starts a second runtime", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const { registry, stored } = await panelSetup(directory);
			const { host, cleanups } = fakeHost({ refuseClose: true });

			const opened = await openChildPanel({
				registry,
				record: stored,
				host,
				waitForBridge: async () => false,
			});
			expect(opened.failure).toMatch(/could not be closed/);
			expect(opened.handle?.identity.attachmentId).toBe("wG:tH");
			expect(cleanups()).toBe(1);
			// The runtime evidence stays too: a child that does come up is adopted instead of becoming a
			// process nobody owns. The handle lets stop close the tab; it does not block a later send.
			const current = await registry.get("sa_panel");
			expect(current?.runtime?.runtimeIdentity).toBeTruthy();
		});
	});

	test("keeps the runtime evidence and reports an unconfirmed panel when the host cannot open one", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const { registry, stored } = await panelSetup(directory);
			const { host } = fakeHost({ failOpen: "herdr tab create failed" });

			// Opening is not atomic: the host can create the panel and then fail to report it, so the
			// runtime evidence is kept — a child that does come up is adopted instead of becoming a
			// process nobody can reach. The failure does not freeze later sends.
			const opened = await openChildPanel({
				registry,
				record: stored,
				host,
				waitForBridge: async () => true,
			});

			expect(opened.failure).toMatch(/could not be opened in a herdr panel/);
			expect(opened.failure).toMatch(/close it if it is still there/);
			const current = await registry.get("sa_panel");
			expect(current?.runtime?.runtimeIdentity).toBeTruthy();
		});
	});

	test("does not abort when panel initially reports alive: false while shell is starting", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const { registry, stored } = await panelSetup(directory);
			const { host } = fakeHost({ initialPending: true });

			const opened = await openChildPanel({
				registry,
				record: stored,
				host,
				waitForBridge: async (_id, signal) => {
					// Wait past one probe tick to ensure probe saw alive: false without aborting
					await new Promise((resolve) => setTimeout(resolve, 350));
					return !signal?.aborted;
				},
			});
			expect(opened.failure).toBeUndefined();
			expect(opened.handle).toBeDefined();
		});
	});

	test("aborts early when child process is observed running and then exits before bridge connects", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const { registry, stored } = await panelSetup(directory);
			const { host, cleanups } = fakeHost({ earlyExit: "crash on startup" });

			const opened = await openChildPanel({
				registry,
				record: stored,
				host,
				waitForBridge: async (_id, signal) => {
					return new Promise((resolve) => {
						signal?.addEventListener("abort", () => resolve(false), { once: true });
					});
				},
			});
			expect(opened.failure).toContain("never connected to the parent bridge (crash on startup)");
			expect(cleanups()).toBe(1);
		});
	});

	test("aborts early when host container is gone before bridge connects", async () => {
		await withTempDir("pi-subagents-runtime-", async (directory) => {
			const { registry, stored } = await panelSetup(directory);
			const { host, cleanups } = fakeHost({ containerGone: "pane_not_found" });

			const opened = await openChildPanel({
				registry,
				record: stored,
				host,
				waitForBridge: async (_id, signal) => {
					return new Promise((resolve) => {
						signal?.addEventListener("abort", () => resolve(false), { once: true });
					});
				},
			});
			expect(opened.failure).toContain("never connected to the parent bridge (pane_not_found)");
			expect(cleanups()).toBe(1);
		});
	});
});
