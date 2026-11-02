import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { EvalKernelHost } from "../src/kernel/host.js";
import type { EvalRunResult, EvalRuntimeHooks } from "../src/runtime.js";

/**
 * Drives the real kernel through the host so the protocol, the drain barrier, and the
 * namespace report are exercised together rather than against a double.
 */
async function run(
	host: EvalKernelHost,
	code: string,
	options: { readonly reset?: boolean } = {},
): Promise<EvalRunResult & { readonly background: string; readonly text: string }> {
	const text: string[] = [];
	const background: string[] = [];
	const result = await host.runWithHooks(
		code,
		{
			cwd: process.cwd(),
			onText: (chunk) => text.push(chunk),
			onDisplay: (): void => undefined,
			onBackground: (chunk) => background.push(chunk),
			callTool: async (name) => {
				throw new Error(`unexpected nested call: ${name}`);
			},
		},
		undefined,
		options.reset,
	);
	return { ...result, background: background.join(""), text: text.join("") };
}

/**
 * Awaits a real event, but never hangs the suite: if the handshake never fires, the deadline turns
 * the wait into a failure naming what was expected. The passing path settles on the event itself.
 */
function withDeadline<T>(pending: Promise<T>, expectation: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		pending,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expectation}.`)), 10_000);
			timer.unref?.();
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

/**
 * Binds a unix-socket server and resolves once it is accepting connections. `connected` settles on
 * the first client, and `release` ends that client so a child blocking on it continues immediately.
 * Callers own the returned server and must close it on every path, success or failure.
 */
function listen(
	path: string,
): Promise<{ server: Server; connected: Promise<void>; release: () => void }> {
	const server = createServer();
	let peer: Socket | undefined;
	const connected = new Promise<void>((resolve) => {
		server.once("connection", (socket) => {
			peer = socket;
			resolve();
		});
	});
	return new Promise((resolve, reject) => {
		// A bind failure owns the server too: close it here, because the caller never receives it.
		server.once("error", (error) => {
			server.close();
			reject(error);
		});
		server.listen(path, () => resolve({ server, connected, release: () => peer?.destroy() }));
	});
}

describe("Eval kernel namespace reporting", () => {
	test.each([
		["await tools.apply_patch({'patch': patch})", "without await"],
		["if", "Fix and re-run the entire cell"],
	])("does not execute any part of a cell with a compile error: %s", async (invalid, guidance) => {
		const host = new EvalKernelHost(process.cwd());
		const calls: { name: string; args: unknown }[] = [];
		const hooks: EvalRuntimeHooks = {
			cwd: process.cwd(),
			onText() {},
			onDisplay() {},
			onBackground() {},
			async callTool(name, args) {
				calls.push({ name, args });
				return "applied";
			},
		};
		const setup = "patch = 'test patch'\ntools.read(path='before.txt')\n";
		try {
			await run(host, "kept = 1");
			const failed = host.runWithHooks(setup + invalid, hooks);
			await expect(failed).rejects.toThrow("SyntaxError");
			await expect(failed).rejects.toThrow("Cell did not run");
			await expect(failed).rejects.toThrow(guidance);
			expect(calls).toEqual([]);
			const unchanged = await run(host, "names()");
			expect(unchanged.value).toEqual(["kept"]);
			expect(unchanged.restarted).toBe(false);
			const retry = await host.runWithHooks(
				`${setup}result = tools.apply_patch({'patch': patch})\nresult`,
				hooks,
			);
			expect(retry.value).toBe("applied");
			expect(retry.state?.added).toEqual(["patch", "result"]);
			expect(calls).toEqual([
				{ name: "read", args: { path: "before.txt" } },
				{ name: "apply_patch", args: { patch: "test patch" } },
			]);
		} finally {
			host.dispose();
		}
	});

	test("reports names a cell added and imports it repeated", async () => {
		const host = new EvalKernelHost(process.cwd());
		try {
			const first = await run(host, "import os\nx = 1");
			expect(first.state?.names).toBe(2);
			expect([...(first.state?.added ?? [])].sort()).toEqual(["os", "x"]);
			expect(first.state?.redundant).toEqual([]);

			// The second cell proves the kernel kept the scope: the repeat is reported, not hidden.
			const second = await run(host, "import os\ny = 2");
			expect(second.state?.names).toBe(3);
			expect(second.state?.added).toEqual(["y"]);
			expect(second.state?.redundant).toEqual(["os"]);
			expect(second.restarted).toBe(false);
		} finally {
			host.dispose();
		}
	});

	test("reports the namespace on a failed cell so the model still knows what survived", async () => {
		const host = new EvalKernelHost(process.cwd());
		try {
			await run(host, "kept = 1");
			const failed = await run(host, "kept + missing_name").catch((error: Error) => error);
			expect(failed).toBeInstanceOf(Error);
			if (!(failed instanceof Error)) throw failed;
			expect(failed.message).not.toContain("child.py");
			expect(failed.message).not.toContain("_execute");
			expect(failed.message).toContain("NameError: name 'missing_name' is not defined");
			// The failure reaches the model as an error, so the report rides the next successful cell.
			const next = await run(host, "names()");
			expect(next.value).toEqual(["kept"]);
			expect(next.state?.redundant).toEqual([]);
		} finally {
			host.dispose();
		}
	});

	test("stays quiet for an explicit reset, which is a request rather than a loss", async () => {
		const host = new EvalKernelHost(process.cwd());
		try {
			await run(host, "kept = 1");
			const afterReset = await run(host, "kept = 2", { reset: true });
			expect(afterReset.restarted).toBe(false);
			expect(afterReset.state?.added).toEqual(["kept"]);
		} finally {
			host.dispose();
		}
	});

	test("reports a restart when a cell killed the kernel", async () => {
		const host = new EvalKernelHost(process.cwd());
		try {
			await run(host, "kept = 1");
			// `sys.exit` is a BaseException, so it takes the kernel process down with the cell.
			const died = await run(host, "import sys\nsys.exit(3)").catch((error: Error) => error);
			expect(died).toBeInstanceOf(Error);
			const next = await run(host, "1 + 1");
			expect(next.restarted).toBe(true);
			expect(next.state?.names).toBe(0);
		} finally {
			host.dispose();
		}
	});

	test("carries output from a detached child into the next cell instead of dropping it", async () => {
		const host = new EvalKernelHost(process.cwd());
		const directory = await mkdtemp(join(tmpdir(), "eval-orphan-"));
		// Collected as each server binds, so a listen failure mid-setup still closes the ones that
		// are already bound. The array lives outside the try so the finally can always reach it.
		const closers: (() => void)[] = [];
		try {
			// Two unix sockets replace the fixed delay, and the child is never awaited, so the cell
			// that spawned it ends while the child is still alive. The child blocks on its gate until
			// the test releases it, then writes the token to fd 1 and reports that write on the second
			// socket. Waiting for those connections is a real event, so the token is known to be on
			// fd 1 before the next cell runs and asks the drain barrier for it.
			const gatePath = join(directory, "gate.sock");
			const flushedPath = join(directory, "flushed.sock");
			const gate = await listen(gatePath);
			closers.push(() => {
				gate.release();
				gate.server.close();
			});
			const flushed = await listen(flushedPath);
			closers.push(() => {
				flushed.release();
				flushed.server.close();
			});
			// `recv` sees either the closing byte or the reset the release causes; both mean "go".
			const childCode = [
				"import socket, sys",
				"gate = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); gate.connect(sys.argv[1])",
				"try:\n gate.recv(1)\nexcept OSError:\n pass",
				"sys.stdout.write('ORPHAN' + chr(10)); sys.stdout.flush()",
				"done = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); done.connect(sys.argv[2]); done.close()",
			].join("\n");
			await run(
				host,
				[
					"import subprocess, sys",
					"child = subprocess.Popen([sys.executable, '-c', " +
						JSON.stringify(childCode) +
						", " +
						JSON.stringify(gatePath) +
						", " +
						JSON.stringify(flushedPath) +
						"])",
					"child.poll()",
				].join("\n"),
			);
			await withDeadline(gate.connected, "the detached child taking the gate");
			// Ending the gate connection releases the child; the flush it reports next proves the
			// token is on fd 1 while no cell is running to claim it.
			gate.release();
			await withDeadline(flushed.connected, "the detached child flushing its output to fd 1");
			// The next two cells are the handshake: each one drains the barrier at its own end, so the
			// token is reported either as background output (read between cells) or as the text of
			// the cell that was running when it was read. Both outcomes mean output from a process
			// that outlived its cell was kept instead of dropped.
			const next = await run(host, "1 + 1");
			const after = await run(host, "2 + 2");
			expect(next.background + next.text + after.background + after.text).toContain("ORPHAN");
			expect(next.value).toBe(2);
			expect(after.value).toBe(4);
		} finally {
			for (const close of closers) close();
			await rm(directory, { recursive: true, force: true });
			host.dispose();
		}
	});

	test("supports copy and deepcopy on tools and rejects private dunder methods", async () => {
		const host = new EvalKernelHost(process.cwd());
		try {
			const result = await run(
				host,
				[
					"import copy",
					"t1 = copy.copy(tools)",
					"t2 = copy.deepcopy(tools)",
					"fn = copy.deepcopy(tools.read)",
					"state = {'tools': tools, 'data': [1, 2]}",
					"state_copied = copy.deepcopy(state)",
					"has_dunder = hasattr(tools, '__deepcopy__')",
					"has_private = hasattr(tools, '_anything')",
					"same = (t1 is tools) and (t2 is tools) and (state_copied['tools'] is tools)",
					"same, has_dunder, has_private, state_copied['data']",
				].join("\n"),
			);
			expect(result.value).toEqual([true, true, false, [1, 2]]);
		} finally {
			host.dispose();
		}
	});
});
