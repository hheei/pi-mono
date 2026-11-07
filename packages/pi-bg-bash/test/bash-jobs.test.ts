import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type TestContext, test } from "vitest";
import { BashJobRegistry, MAX_BASH_TERMINAL_OUTPUT, MAX_JOB_OUTPUT } from "../src/bash-jobs.js";

function registry(context: TestContext, tailBytes?: number): BashJobRegistry {
	const created = new BashJobRegistry(tailBytes);
	context.onTestFinished(() => created.dispose());
	return created;
}

const isPidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/**
 * Starts a command and resolves with the first descendant pid it prints.
 *
 * The pid arrives on the shell's own stdout, so readiness is the child event itself rather than a
 * file appearing at some later point in time.
 */
async function startWithDescendantPid(
	context: TestContext,
	command: string,
): Promise<{ jobs: BashJobRegistry; job: ReturnType<BashJobRegistry["start"]>; pid: number }> {
	const jobs = registry(context);
	let announce: (pid: number) => void = () => {};
	const pid = new Promise<number>((resolve) => {
		announce = resolve;
	});
	const job = jobs.start({
		command,
		cwd: process.cwd(),
		background: true,
		onData: (data) => {
			const match = /(\d+)/.exec(data.toString());
			if (match !== null) announce(Number(match[1]));
		},
	});
	return { jobs, job, pid: await pid };
}

test.concurrent("retains a bounded terminal result and reports completion", async (context) => {
	const jobs = registry(context);
	const started = jobs.start({ command: "yes x | head -c 1100000", cwd: process.cwd() });
	expect(() => structuredClone(started)).not.toThrow();
	expect(started.truncated).toBe(false);
	const completed = await jobs.waitFor(started.id);
	expect(completed?.status).toBe("completed");
	expect(completed?.truncated).toBe(true);
	// The live tail is bounded by the configured sink; the terminal result is bounded for delivery.
	expect(Buffer.byteLength(completed?.output ?? "")).toBeLessThanOrEqual(MAX_BASH_TERMINAL_OUTPUT);
});

test.concurrent("keeps a terminal result inside the byte bound while the log holds everything", async (context) => {
	const jobs = registry(context, 128 * 1024);
	const dir = await mkdtemp(join(tmpdir(), "pi-bash-bound-"));
	try {
		const started = jobs.start({
			command: `node -e "process.stdout.write('界😀'.repeat(30000))"`,
			cwd: process.cwd(),
			background: true,
			logPath: join(dir, "wide.log"),
		});
		const finished = await jobs.waitFor(started.id);
		expect(finished?.status).toBe("completed");
		const reported = finished?.output ?? "";
		expect(Buffer.byteLength(reported)).toBeLessThanOrEqual(MAX_BASH_TERMINAL_OUTPUT);
		// The cut lands on a whole character, so the model never sees a replacement glyph.
		expect(reported).not.toContain("\uFFFD");
		expect(finished?.truncated).toBe(true);
		expect(readFileSync(join(dir, "wide.log"), "utf8")).toBe("界😀".repeat(30_000));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test.concurrent("running output follows the configured tail bound", async (context) => {
	const jobs = registry(context, MAX_JOB_OUTPUT);
	let sawOutput: () => void = () => {};
	const firstOutput = new Promise<void>((resolve) => {
		sawOutput = resolve;
	});
	const started = jobs.start({
		command: "yes x",
		cwd: process.cwd(),
		onData: sawOutput,
	});
	await firstOutput;
	const running = jobs.get(started.id);
	expect(running?.status).toBe("running");
	expect(Buffer.byteLength(running?.output ?? "")).toBeLessThanOrEqual(MAX_JOB_OUTPUT);
	jobs.stop(started.id);
	await jobs.waitFor(started.id);
});

test.concurrent("stops an owned process group, not just the job shell", async (context) => {
	const {
		jobs,
		job,
		pid: descendant,
	} = await startWithDescendantPid(context, `sleep 30 & echo $!; wait`);
	expect(isPidAlive(descendant)).toBe(true);
	const requested = jobs.stop(job.id);
	// Cancellation is a request: the record says stopping until the process reports its exit.
	expect(requested?.status).toBe("stopping");
	const stopped = await jobs.waitFor(job.id);
	expect(stopped?.status).toBe("cancelled");
	expect(isPidAlive(descendant)).toBe(false);
});

test.concurrent("a leader that exits on TERM still gets its ignoring descendant killed", async (context) => {
	// The shell traps TERM and exits at once, so treating a leader exit as proof that the whole
	// tree is gone would leave this descendant running for its full sleep.
	const {
		jobs,
		job,
		pid: descendant,
	} = await startWithDescendantPid(
		context,
		`(trap '' TERM; sleep 30) & echo $!; trap 'exit 0' TERM; wait`,
	);
	expect(isPidAlive(descendant)).toBe(true);
	jobs.stop(job.id);
	const finished = await jobs.waitFor(job.id);
	// The leader exited by itself, so its own result is kept rather than reported as a cancel.
	expect(finished?.status).toBe("completed");
	expect(isPidAlive(descendant)).toBe(false);
});

test.concurrent("kills a TERM-ignoring descendant whose stdio no longer holds the shell open", async (context) => {
	// The descendant redirects its stdio away, so the leader closes immediately and nothing but
	// the process group can prove the tree is gone.
	const {
		jobs,
		job,
		pid: descendant,
	} = await startWithDescendantPid(
		context,
		`(trap '' TERM; sleep 30) >/dev/null 2>&1 & echo $!; trap 'exit 0' TERM; wait`,
	);
	expect(isPidAlive(descendant)).toBe(true);
	jobs.stop(job.id);
	await jobs.waitFor(job.id);
	// Completion waits for the group sweep, even though the shell itself closed at once.
	expect(isPidAlive(descendant)).toBe(false);
});

test.concurrent("a shell that cannot be spawned fails with its error and one result", async (context) => {
	const jobs = registry(context);
	const started = jobs.start({
		command: "printf never",
		shellPath: "/nonexistent/pi-ext-tools-shell",
		cwd: process.cwd(),
		background: true,
	});
	const finished = await jobs.waitFor(started.id);
	expect(finished?.status).toBe("failed");
	expect(finished?.diagnostic).toContain("ENOENT");
	expect(finished?.output).toContain("ENOENT");
	expect(jobs.pendingDeliveries()).toHaveLength(1);
	expect(jobs.pendingDeliveries()[0]?.status).toBe("failed");
});

test.concurrent("a released record already has its complete log on disk", async (context) => {
	const jobs = registry(context);
	const dir = await mkdtemp(join(tmpdir(), "pi-bash-flush-"));
	try {
		const started = jobs.start({
			command: "echo flushed",
			cwd: process.cwd(),
			background: true,
			resolveLogPath: (id) => join(dir, `${id}.log`),
		});
		// The delivery names this path, so waiting for the record must imply the file was closed.
		const finished = await jobs.waitFor(started.id);
		expect(finished?.logPath).toBe(join(dir, `${started.id}.log`));
		expect(readFileSync(finished?.logPath ?? "", "utf8")).toBe("flushed\n");
		expect(jobs.pendingDeliveries()[0]?.logPath).toBe(finished?.logPath);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test.concurrent("foreground jobs reserve no delivery and are released when they finish", async (context) => {
	const jobs = registry(context);
	const started = jobs.start({ command: "echo inline", cwd: process.cwd() });
	const finished = await jobs.waitFor(started.id);
	expect(finished?.status).toBe("completed");
	expect(jobs.pendingDeliveries()).toEqual([]);
	// The record ends with the call that reported its result inline.
	expect(jobs.get(started.id)).toBeUndefined();
});

test.concurrent("assigns ids that stay unique across a registry reload", async () => {
	const first = new BashJobRegistry();
	const second = new BashJobRegistry();
	try {
		const a = first.start({ command: "true", cwd: process.cwd() });
		const b = first.start({ command: "true", cwd: process.cwd() });
		const c = second.start({ command: "true", cwd: process.cwd() });
		// Foreground jobs end with their call, so teardown has nothing left to stop and wait for.
		await Promise.all([first.waitFor(a.id), first.waitFor(b.id), second.waitFor(c.id)]);
		expect(new Set([a.id, b.id, c.id]).size).toBe(3);
		// Every job draws its own id, in the same shape as a subagent child id, so a rebuilt
		// registry cannot reuse the log file of an earlier run in the same session directory.
		for (const id of [a.id, b.id, c.id]) expect(id).toMatch(/^bash-[0-9a-f]{6}$/u);
	} finally {
		await first.dispose();
		await second.dispose();
	}
});
