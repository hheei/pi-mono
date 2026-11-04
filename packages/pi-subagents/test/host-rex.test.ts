import { expect, test, vi } from "vitest";
import {
	createRexHostAdapter,
	type HostCommandResult,
	type HostCommandRunner,
	listRexAttachments,
	rebindRexBlock,
	rexBlockFocused,
	rexLaunchArgv,
	rexWindowCreateArgs,
	selectHostAdapter,
} from "../src/host-adapter.js";
import type { LaunchSpec } from "../src/launch-spec.js";

const spec: LaunchSpec = {
	command: "/usr/bin/node",
	argv: ["/tmp/pi cli.js", "--thinking", "high"],
	cwd: "/tmp/work dir",
	presentation: "panel",
	stdio: "inherit",
	env: { PI_SUBAGENTS_ENDPOINT: "/tmp/socket path", PI_SUBAGENTS_AGENT: "secret'quoted" },
	config: { subagentId: "agent-7" } as LaunchSpec["config"],
};

const parentBlock = "block:01a1a507-6776-7047-88ec-c5b11a1051d2";
const parentSession = "session:01a1a507-6775-7ee8-bb3d-b82591baacf5";
const childBlock = "block:01a1a507-6b6e-7d29-9edf-855c207c3175";

const ownsAttachment = (): boolean => true;
const rexEnv = { REX_BLOCK: parentBlock, REX_SESSION: parentSession };

function result(
	stdout = "",
	stderr = "",
	exitCode: number | null = 0,
	timedOut = false,
): HostCommandResult {
	return { stdout, stderr, exitCode, timedOut };
}

/** The real `ps -A -o pid=,ppid=` answer for this process and its parent. */
function processTree(): string {
	return `${process.pid} 1\n1 0\n`;
}

/**
 * The real `rex block call process` answer. `child` is the terminal's own program, `foreground` is
 * what is running in it right now; an idle block reports the same process for both.
 */
function rexProcess(options: {
	readonly childPid: number;
	readonly foregroundPid?: number;
	readonly lastExit?: unknown;
}): string {
	const program = (pid: number, name: string) => ({
		pid,
		user_id: 1000,
		user: "user",
		name,
		path: `/usr/bin/${name}`,
		invoked_path: `/usr/bin/${name}`,
		argv0: name,
		cwd: "/tmp/work dir",
	});
	return JSON.stringify({
		last_exit: options.lastExit ?? null,
		child: program(options.childPid, "zsh"),
		...(options.foregroundPid === undefined
			? {}
			: { foreground: program(options.foregroundPid, "pi") }),
		home: "/home/user",
	});
}

function rexView(options: {
	readonly activeWindow: string;
	readonly focusedBlock: string;
	readonly blocks: readonly { readonly window: string; readonly block: string }[];
}): string {
	const windows = [...new Set(options.blocks.map((entry) => entry.window))];
	return JSON.stringify({
		revision: 3,
		session_id: parentSession,
		active_window_id: options.activeWindow,
		windows: windows.map((window) => ({
			window_id: window,
			label: `Window ${window.slice(-4)}`,
			focused_block_id: options.focusedBlock,
			layers: [
				{
					layer_id: "layer:1",
					kind: "tiled",
					bounds: [0, 0, 1, 1],
					blocks: options.blocks
						.filter((entry) => entry.window === window)
						.map((entry) => ({
							block_id: entry.block,
							label: "agent-7",
							creator_name: "com.superlogical.terminal",
							flavor: "com.superlogical.terminal.shell",
						})),
				},
			],
		})),
	});
}

function runnerFor(responses: readonly HostCommandResult[]): {
	runner: HostCommandRunner;
	calls: string[][];
} {
	const calls: string[][] = [];
	let index = 0;
	return {
		calls,
		runner: {
			run: vi.fn(async (command, args) => {
				calls.push([command, ...args]);
				return responses[index++] ?? result();
			}),
		},
	};
}

test("Rex claims the block whose foreground process is this process", async () => {
	const { runner, calls } = runnerFor([
		result(processTree()),
		result(rexProcess({ childPid: 7, foregroundPid: process.pid })),
	]);
	const capability = await createRexHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
		env: rexEnv,
	}).probe();
	expect(capability).toEqual({
		host: "rex",
		available: true,
		reason: `block ${parentBlock} runs this process`,
	});
	expect(calls[1]).toEqual(["rex", "block", "call", "-b", parentBlock, "process"]);
});

test("Rex does not claim a block from an inherited environment", async () => {
	const { runner } = runnerFor([result("", "REX_BLOCK is not set", 0)]);
	const capability = await createRexHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
		env: {},
	}).probe();
	expect(capability).toEqual({
		host: "rex",
		available: false,
		reason: "REX_BLOCK is not set: this process does not run in a Rex block",
	});
});

test("Rex does not claim an idle block, so a backgrounded process cannot take its parent's block", async () => {
	// An idle block reports its shell as both the terminal program and the foreground: the shell is
	// this process's ancestor, so counting it would let `pi &` claim the block it was started from.
	const { runner } = runnerFor([
		result(processTree()),
		result(rexProcess({ childPid: process.pid, foregroundPid: process.pid })),
	]);
	const capability = await createRexHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
		env: rexEnv,
	}).probe();
	expect(capability.available).toBe(false);
	expect(capability.reason).toBe(`block ${parentBlock} does not run this process`);
});

test("Rex opens a dedicated window whose block carries the bridge environment", async () => {
	const { runner, calls } = runnerFor([
		result(processTree()),
		result(rexProcess({ childPid: 7, foregroundPid: process.pid })),
		result(JSON.stringify({ window_id: "window:9", block_ids: [childBlock], revision: 2 })),
		result(rexProcess({ childPid: 4242, foregroundPid: 4242 })),
		result(
			rexView({
				activeWindow: "window:9",
				focusedBlock: childBlock,
				blocks: [{ window: "window:9", block: childBlock }],
			}),
		),
		result(JSON.stringify({ block_ids: [childBlock] })),
	]);
	const attachment = await createRexHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
		env: rexEnv,
	}).open(spec);
	expect(attachment.identity).toEqual({
		host: "rex",
		attachmentId: childBlock,
		createdBy: "owner-1",
	});
	expect(attachment.reportsFocus).toBe(true);
	expect(calls[2]).toEqual([
		"rex",
		"api",
		"call",
		"-s",
		parentSession,
		"session.new_window",
		JSON.stringify({
			focus: false,
			window_label: "subagent agent-7",
			layout: {
				block: {
					flavor: "com.superlogical.terminal.shell",
					label: "agent-7",
					options: {
						cwd: "/tmp/work dir",
						command: [
							"env",
							"PI_SUBAGENTS_ENDPOINT=/tmp/socket path",
							"PI_SUBAGENTS_AGENT=secret'quoted",
							"/usr/bin/node",
							"/tmp/pi cli.js",
							"--thinking",
							"high",
						],
					},
				},
			},
		}),
	]);
	await attachment.cleanup();
	expect(calls.at(-1)).toEqual(["rex", "block", "close", childBlock]);
});

test("Rex reports a window it no longer has as gone, and a failed query as unknown", async () => {
	const gone = runnerFor([
		result("", 'Error: block target "block:1" not found', 3),
		result("", 'Error: session target "session:1" not found', 3),
	]);
	const goneAttachment = rebindRexBlock({
		runner: gone.runner,
		blockId: childBlock,
		ownerId: "owner-1",
		ownsAttachment,
	});
	expect(await goneAttachment.observe()).toMatchObject({
		alive: false,
		known: true,
		containerGone: true,
	});

	const failed = runnerFor([
		result("", "rex: server is not running", 1),
		result("", "rex: server is not running", 1),
	]);
	const failedAttachment = rebindRexBlock({
		runner: failed.runner,
		blockId: childBlock,
		ownerId: "owner-1",
		ownsAttachment,
	});
	expect(await failedAttachment.observe()).toMatchObject({ alive: false, known: false });
});

test("Rex answers focus from the session view, and nothing when the block is not in it", () => {
	const focused = rexView({
		activeWindow: "window:9",
		focusedBlock: childBlock,
		blocks: [{ window: "window:9", block: childBlock }],
	});
	expect(rexBlockFocused(focused, childBlock)).toBe(true);
	const otherWindow = rexView({
		activeWindow: "window:1",
		focusedBlock: childBlock,
		blocks: [
			{ window: "window:1", block: "block:1" },
			{ window: "window:9", block: childBlock },
		],
	});
	expect(rexBlockFocused(otherWindow, childBlock)).toBe(false);
	expect(rexBlockFocused(otherWindow, "block:404")).toBeUndefined();
	expect(rexBlockFocused("not json", childBlock)).toBeUndefined();
});

test("Rex lists the blocks of every session and the generation of the running server", async () => {
	const { runner, calls } = runnerFor([
		result(JSON.stringify({ instance_id: "server-1", started_at: "2026-11-04T04:22:14Z" })),
		result(JSON.stringify({ sessions: [{ session_id: "session:1", label: "work" }] })),
		result(`${childBlock}\nblock:2\n`),
	]);
	const listed = await listRexAttachments(runner, 1_000);
	expect(listed).toEqual({
		known: true,
		generation: "server-1@2026-11-04T04:22:14Z",
		present: new Set([childBlock, "block:2"]),
	});
	expect(calls.at(-1)).toEqual(["rex", "block", "ls", "-q", "-s", "session:1"]);
});

test("Rex reports an unreadable listing as unknown instead of an empty one", async () => {
	const { runner } = runnerFor([
		result(JSON.stringify({ instance_id: "server-1" })),
		result("", "rex: server is not running", 1),
	]);
	expect(await listRexAttachments(runner, 1_000)).toEqual({ known: false });
});

test("Rex launch argv adds the environment only when there is one", () => {
	expect(rexLaunchArgv({ ...spec, env: {} })).toEqual([
		"/usr/bin/node",
		"/tmp/pi cli.js",
		"--thinking",
		"high",
	]);
	expect(rexLaunchArgv(spec)).toEqual([
		"env",
		"PI_SUBAGENTS_ENDPOINT=/tmp/socket path",
		"PI_SUBAGENTS_AGENT=secret'quoted",
		"/usr/bin/node",
		"/tmp/pi cli.js",
		"--thinking",
		"high",
	]);
});

test("Rex window creation never focuses the parent's window", () => {
	const args = rexWindowCreateArgs(spec, parentSession);
	const request = JSON.parse(args.at(-1) ?? "{}") as { focus?: boolean };
	expect(args.slice(0, 5)).toEqual(["api", "call", "-s", parentSession, "session.new_window"]);
	expect(request.focus).toBe(false);
});

test("default selection reaches Rex after Herdr and cmux decline", async () => {
	const selection = await selectHostAdapter({
		adapters: {
			herdr: {
				kind: "herdr",
				probe: async () => ({ host: "herdr", available: false, reason: "no herdr pane" }),
				open: async () => {
					throw new Error("not used");
				},
			},
			cmux: {
				kind: "cmux",
				probe: async () => ({ host: "cmux", available: false, reason: "cmux is not running" }),
				open: async () => {
					throw new Error("not used");
				},
			},
			rex: {
				kind: "rex",
				probe: async () => ({ host: "rex", available: true, reason: "block runs this process" }),
				open: async () => {
					throw new Error("not used");
				},
			},
		},
	});
	expect(selection.available).toBe(true);
	if (selection.available) {
		expect(selection.selectedHost).toBe("rex");
		expect(selection.reason).toContain("herdr: no herdr pane");
	}
});
