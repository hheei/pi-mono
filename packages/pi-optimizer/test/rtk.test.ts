import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
	ExecResult,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { OptimizerInfo } from "../src/info.js";
import { createRtkRuntime, type RtkRuntimeOptions, splitRtkChain } from "../src/rtk.js";
import { rtkRewriteCachePath } from "../src/rtk-cache.js";

type TestBashEvent = ToolCallEvent & { readonly input: Record<string, unknown> };
const enabled = { enabled: true, path: "" } as const;
const result = (code: number, stdout = "", stderr = "", killed = false): ExecResult => ({
	code,
	stdout,
	stderr,
	killed,
	truncated: false,
});
const VERSION_OUTPUT = result(0, "rtk 0.45.0\n");

let cacheRoot = "";

beforeAll(async () => {
	cacheRoot = await mkdtemp(join(tmpdir(), "pi-optimizer-rtk-"));
});

afterAll(async () => {
	await rm(cacheRoot, { recursive: true, force: true });
});

let cacheCounter = 0;

/** Every runtime gets its own cache file so tests never share decisions or touch the agent directory. */
function harness(exec: ExtensionAPI["exec"], options: RtkRuntimeOptions = {}) {
	const info = vi.fn<OptimizerInfo>();
	cacheCounter += 1;
	const cachePath = options.cachePath ?? join(cacheRoot, `cache-${cacheCounter}.json`);
	return {
		runtime: createRtkRuntime({ exec } as Pick<ExtensionAPI, "exec">, info, { cachePath }),
		info,
		cachePath,
	};
}

/** Counts only the rewrite spawns: the once-per-session version probe is a separate concern. */
const rewriteCalls = (exec: ExtensionAPI["exec"]): number =>
	vi.mocked(exec).mock.calls.filter(([, args]) => args[0] === "rewrite").length;

/** Answers the version probe and serves one rewrite response, so both paths stay explicit. */
function versionedExec(rewrite: ExecResult | (() => Promise<ExecResult>)) {
	return vi.fn(async (_command: string, args: string[]): Promise<ExecResult> => {
		if (args[0] === "--version") return VERSION_OUTPUT;
		return typeof rewrite === "function" ? await rewrite() : rewrite;
	});
}

type StoredCache = { version: string; rewrites: Record<string, string | null> };

/**
 * Waits for the background save to reach a cache the caller accepts. Saving runs in the background
 * and rewrites the file atomically, so this watches the directory for the rename instead of polling,
 * and only re-reads when the file actually changed. The deadline is a failure guard, not a wait.
 */
async function waitForCache(
	path: string,
	isReady: (stored: StoredCache) => boolean = () => true,
): Promise<StoredCache> {
	const read = async (): Promise<StoredCache | undefined> => {
		try {
			const parsed = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
			if (typeof parsed.version !== "string") return undefined;
			const stored = parsed as StoredCache;
			return isReady(stored) ? stored : undefined;
		} catch {
			return undefined;
		}
	};
	const immediate = await read();
	if (immediate !== undefined) return immediate;
	const name = basename(path);
	return await new Promise<StoredCache>((resolve, reject) => {
		const watcher = watch(dirname(path));
		const deadline = setTimeout(() => {
			watcher.close();
			reject(new Error(`Cache was never written to ${path}`));
		}, 5_000);
		deadline.unref?.();
		const settle = (stored: StoredCache | undefined): void => {
			if (stored === undefined) return;
			clearTimeout(deadline);
			watcher.close();
			resolve(stored);
		};
		watcher.on("change", (_event, changed) => {
			if (changed !== null && String(changed) !== name) return;
			void read().then(settle);
		});
		watcher.on("error", (error) => {
			clearTimeout(deadline);
			watcher.close();
			reject(error);
		});
		// The save may land between the first read and the watch, so close that window once.
		void read().then(settle);
	});
}

/**
 * Reports each rewrite query as it reaches `exec`, so a test can act on the in-flight query instead
 * of waiting a guessed number of event-loop turns. Register with `next()` before starting the
 * rewrite, and `signal()` from the fake exec when the query actually begins.
 */
function queryGate(): { next: () => Promise<void>; signal: () => void } {
	const waiters: (() => void)[] = [];
	return {
		next: () =>
			new Promise<void>((resolve) => {
				waiters.push(resolve);
			}),
		signal: () => waiters.shift()?.(),
	};
}

function context(signal?: AbortSignal): ExtensionContext {
	return { ...(signal === undefined ? {} : { signal }) } as ExtensionContext;
}

function bash(command: string, input: Record<string, unknown> = {}): TestBashEvent {
	return {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "call-7",
		input: { command, ...input },
	};
}

test("RTK rewrites eligible foreground Bash with the configured executable without extra info", async () => {
	const exec = vi.fn(async () => result(3, "rtk git status"));
	const { runtime, info } = harness(exec);
	const event = bash("git status");
	await runtime.rewrite(event, context(), { enabled: true, path: "/tools/my rtk" });

	expect(event.input.command).toBe("'/tools/my rtk' git status");
	expect(exec).toHaveBeenCalledWith(
		"/tools/my rtk",
		["rewrite", "git status"],
		expect.objectContaining({ timeout: 1_000, signal: expect.any(AbortSignal) }),
	);
	expect(info).not.toHaveBeenCalled();
});

test("RTK overlays use the configured executable for inferred and explicit calls", async () => {
	const exec = vi.fn(async () => result(1));
	const { runtime, info } = harness(exec);
	const inferred = bash("bun test");
	const explicit = bash("FOO=bar rtk git status && BAR=x rtk git diff");
	const settings = { enabled: true, path: "/tools/my rtk" };
	await runtime.rewrite(inferred, context(), settings);
	await runtime.rewrite(explicit, context(), settings);
	await runtime.rewrite(bash("'/tools/my rtk' test bun test"), context(), settings);
	expect(inferred.input.command).toBe("'/tools/my rtk' test bun test");
	expect(explicit.input.command).toBe(
		"FOO=bar '/tools/my rtk' git status && BAR=x '/tools/my rtk' git diff",
	);
	expect(rewriteCalls(exec)).toBe(1);
	expect(info).not.toHaveBeenCalled();
});

test("RTK leaves ineligible calls and unchanged rewrites unrecorded", async () => {
	const exec = vi.fn(async () => result(0, "git status"));
	const { runtime, info } = harness(exec);
	for (const event of [
		bash("git status"),
		bash("git status", { target: "local" }),
		{ ...bash("git status"), toolName: "read" },
		bash(" "),
		bash("rtk git status"),
		bash("git status", { target: "remote" }),
		bash("git status", { pty: true }),
		bash("git status", { async: true }),
		bash("FOO=bar rtk git status"),
	])
		await runtime.rewrite(event, context(), enabled);
	await runtime.rewrite(bash("git status"), context(), { enabled: false, path: "" });
	await runtime.rewrite(bash("git status"), context(AbortSignal.abort()), enabled);
	// Only the first eligible command reaches rtk: the second repeats it and is answered from cache.
	expect(rewriteCalls(exec)).toBe(1);
	expect(info).not.toHaveBeenCalled();
});

test("a repeated command reuses the cached rewrite without extra info", async () => {
	const exec = vi.fn(async () => result(3, "rtk git status"));
	const { runtime, info } = harness(exec);
	const first = bash("git status");
	const second = { ...bash("git status"), toolCallId: "call-8" };
	await runtime.rewrite(first, context(), enabled);
	await runtime.rewrite(second, context(), enabled);

	expect(rewriteCalls(exec)).toBe(1);
	expect(second.input.command).toBe("rtk git status");
	expect(info).not.toHaveBeenCalled();
});

test("a cached no-match stays unrecorded and reset re-derives it", async () => {
	const exec = vi.fn(async () => result(1));
	const { runtime, info } = harness(exec);
	await runtime.rewrite(bash("git status"), context(), enabled);
	await runtime.rewrite(bash("git status"), context(), enabled);
	expect(rewriteCalls(exec)).toBe(1);

	runtime.reset();
	await runtime.rewrite(bash("git status"), context(), enabled);
	expect(rewriteCalls(exec)).toBe(2);
	expect(info).not.toHaveBeenCalled();
});

test("failed queries and a changed executable are never reused", async () => {
	const failing = vi.fn(async () => result(4, "", "boom"));
	const { runtime } = harness(failing);
	await runtime.rewrite(bash("git status"), context(), enabled);
	await runtime.rewrite(bash("git status"), context(), enabled);
	expect(rewriteCalls(failing)).toBe(2);

	const exec = vi.fn(async () => result(3, "git status"));
	const other = harness(exec);
	await other.runtime.rewrite(bash("git status"), context(), enabled);
	await other.runtime.rewrite(bash("git status"), context(), { enabled: true, path: "/opt/rtk" });
	expect(rewriteCalls(exec)).toBe(2);
});

test("no-match stays quiet; rejected, missing, timed-out, and empty queries retain the original with info", async () => {
	for (const [response, warning] of [
		[result(0), true],
		[result(3), true],
		[result(1), false],
		[result(2, "", "denied"), true],
		[result(9, "", "failed"), true],
		[result(0, "rtk git status", "", true), true],
		[new Error("missing rtk"), true],
	] as const) {
		const { runtime, info } = harness(async () => {
			if (response instanceof Error) throw response;
			return response;
		});
		const event = bash("git status");
		await runtime.rewrite(event, context(), enabled);
		expect(event.input.command).toBe("git status");
		if (warning)
			expect(info).toHaveBeenCalledWith(
				expect.stringContaining("RTK query failed"),
				expect.objectContaining({ originalCommand: "git status", executionCommand: "git status" }),
				true,
			);
		else expect(info).not.toHaveBeenCalled();
	}
});

test("uses safe overlays after no-match but never overlays complex shell syntax", async () => {
	for (const [original, code, output, expected] of [
		["bun test", 1, "", "rtk test bun test"],
		["bun test", 0, "bun test", "rtk test bun test"],
		[
			"bun test && git status",
			3,
			"bun test && rtk git status",
			"rtk test bun test && rtk git status",
		],
		["find . -not -name tmp", 3, "rtk find . -not -name tmp", "find . -not -name tmp"],
		["bun --cwd test run", 0, "bun --cwd test run", "bun --cwd test run"],
		["$(echo unsafe) bun test", 0, "bun test", "bun test"],
	] as const) {
		const { runtime } = harness(async () => result(code, output));
		const event = bash(original);
		await runtime.rewrite(event, context(), enabled);
		expect(event.input.command).toBe(expected);
	}
	for (const command of [
		"echo 'unterminated",
		"echo $(unsafe)",
		'echo "unsafe \\" && bun test"',
		'echo "unsafe $value"',
		'echo "unsafe `value`"',
	])
		expect(splitRtkChain(command)).toBeNull();
});

test("reset aborts queries while reset and caller cancellation discard late results", async () => {
	let resolve: ((value: ExecResult) => void) | undefined;
	const signals: AbortSignal[] = [];
	const queries = queryGate();
	const exec: ExtensionAPI["exec"] = async (_command, args, options) => {
		if (options?.signal) signals.push(options.signal);
		if (args[0] === "--version") return VERSION_OUTPUT;
		queries.signal();
		return new Promise<ExecResult>((done) => {
			resolve = done;
		});
	};
	const { runtime, info } = harness(exec);
	const resetEvent = bash("git status");
	const resetQuery = queries.next();
	const pending = runtime.rewrite(resetEvent, context(), enabled);
	await resetQuery;
	runtime.reset();
	expect(signals.at(-1)?.aborted).toBe(true);
	resolve?.(result(0, "rtk git status"));
	await pending;
	const cancelledQuery = queries.next();
	const controller = new AbortController();
	const cancelled = runtime.rewrite(bash("git diff"), context(controller.signal), enabled);
	await cancelledQuery;
	controller.abort();
	expect(signals.at(-1)?.aborted).toBe(true);
	resolve?.(result(0, "rtk git diff"));
	await cancelled;
	expect(resetEvent.input.command).toBe("git status");
	expect(info).not.toHaveBeenCalled();
});

test("the cache lives beside the other extension state", () => {
	expect(rtkRewriteCachePath("/agent")).toBe(join("/agent", "pi-optimizer", "rtk-rewrites.json"));
});

test("a later session reuses the persisted rewrite instead of spawning rtk", async () => {
	const firstExec = versionedExec(result(3, "rtk git status"));
	const first = harness(firstExec);
	await first.runtime.rewrite(bash("git status"), context(), enabled);
	expect(rewriteCalls(firstExec)).toBe(1);
	// Saving never waits for session teardown, because closing the terminal skips teardown entirely.
	const stored = await waitForCache(first.cachePath);
	expect(stored.version).toBe("rtk 0.45.0");
	expect(Object.values(stored.rewrites)).toEqual(["rtk git status"]);
	first.runtime.reset();

	const secondExec = versionedExec(result(3, "rtk git status"));
	const second = harness(secondExec, { cachePath: first.cachePath });
	const event = bash("git status");
	await second.runtime.rewrite(event, context(), enabled);
	expect(rewriteCalls(secondExec)).toBe(0);
	expect(event.input.command).toBe("rtk git status");
	expect(second.info).not.toHaveBeenCalled();
});

test("a different reported rtk version discards the stored decisions", async () => {
	const firstExec = versionedExec(result(3, "rtk git status"));
	const first = harness(firstExec);
	await first.runtime.rewrite(bash("git status"), context(), enabled);
	// Wait for the persisted decisions, so the second session really reads a stored version.
	await waitForCache(first.cachePath);
	first.runtime.reset();

	const secondExec = vi.fn(
		async (_command: string, args: string[]): Promise<ExecResult> =>
			args[0] === "--version" ? result(0, "rtk 0.46.0") : result(3, "rtk git status"),
	);
	const second = harness(secondExec, { cachePath: first.cachePath });
	const event = bash("git status");
	await second.runtime.rewrite(event, context(), enabled);
	expect(rewriteCalls(secondExec)).toBe(1);
	expect(event.input.command).toBe("rtk git status");
});

test("an unknown rtk version keeps rewrites in memory and writes nothing", async () => {
	const exec = vi.fn(
		async (_command: string, args: string[]): Promise<ExecResult> =>
			args[0] === "--version" ? result(127, "", "rtk: not found") : result(3, "rtk git status"),
	);
	const { runtime, cachePath } = harness(exec);
	const first = bash("git status");
	const second = bash("git status");
	await runtime.rewrite(first, context(), enabled);
	await runtime.rewrite(second, context(), enabled);
	expect(rewriteCalls(exec)).toBe(1);
	expect(second.input.command).toBe("rtk git status");
	runtime.reset();
	// An unknown version queues no save at all, so the cache file must never appear.
	await expect(readFile(cachePath, "utf8")).rejects.toThrow();
});

test("a corrupt cache file is treated as cold and replaced on save", async () => {
	const firstExec = versionedExec(result(3, "rtk git status"));
	const first = harness(firstExec);
	await writeFile(first.cachePath, "{ this is not json", "utf8");

	const event = bash("git status");
	await first.runtime.rewrite(event, context(), enabled);
	expect(event.input.command).toBe("rtk git status");
	expect(rewriteCalls(firstExec)).toBe(1);
	first.runtime.reset();
	expect(await waitForCache(first.cachePath)).toMatchObject({ version: "rtk 0.45.0" });
});

test("the store keeps the newest decisions and drops the oldest", async () => {
	const exec = versionedExec(result(3, "rtk git status"));
	const { runtime, cachePath } = harness(exec);
	for (let index = 0; index < 257; index += 1)
		await runtime.rewrite(bash(`git status --${index}`), context(), enabled);
	expect(rewriteCalls(exec)).toBe(257);
	runtime.reset();
	const stored = await waitForCache(
		cachePath,
		(value) => Object.keys(value.rewrites).length === 256,
	);
	const keys = Object.keys(stored.rewrites);
	expect(keys).toHaveLength(256);
	expect(keys.some((key) => key.endsWith("git status --0"))).toBe(false);
	expect(keys.some((key) => key.endsWith("git status --256"))).toBe(true);
});

test("skips rewrite query and leaves command raw when command contains null bytes", async () => {
	const exec = vi.fn();
	const { runtime, info } = harness(exec);
	const event = bash("git status --foo\0bar");
	await runtime.rewrite(event, context(), enabled);
	expect(exec).not.toHaveBeenCalled();
	expect(event.input.command).toBe("git status --foo\0bar");
	expect(info).not.toHaveBeenCalled();
});
