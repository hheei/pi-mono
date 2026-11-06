import { expect, test, vi } from "vitest";
import {
	createHcHostAdapter,
	type HostCommandResult,
	type HostCommandRunner,
	hcRunArgs,
	hcTerminalAlive,
	listHcAttachments,
	rebindHcTerminal,
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

const parentTerminal = "t10";
const childTerminal = "t15";

const ownsAttachment = (): boolean => true;
const hcEnv = { HC_TERMINAL_ID: parentTerminal };

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
 * The real `hc get` answer. `foreground` is what the terminal runs right now; a terminal sitting at
 * its shell reports the shell, which is not this process.
 */
function hcTerminal(options: {
	readonly address?: string;
	readonly state?: "live" | "finished";
	readonly foregroundPid?: number;
}): string {
	const address = options.address ?? parentTerminal;
	return JSON.stringify({
		address,
		argv: ["/usr/bin/zsh"],
		cols: 191,
		cwd: "/tmp/work dir",
		exit_code: options.state === "finished" ? 0 : null,
		foreground:
			options.foregroundPid === undefined
				? null
				: { argv: ["pi"], cwd: "/tmp/work dir", name: "pi", pid: options.foregroundPid },
		labels: {},
		name: null,
		pid: 4242,
		reason: options.state === "finished" ? "exited" : null,
		state: options.state ?? "live",
		status: { app: "pi", msg: "", state: "working" },
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

test("hc claims the terminal whose foreground process is this process", async () => {
	const { runner, calls } = runnerFor([
		result(processTree()),
		result(hcTerminal({ foregroundPid: process.pid })),
	]);
	const capability = await createHcHostAdapter({
		runner,
		ownerId: "owner",
		ownsAttachment,
		env: hcEnv,
	}).probe();
	expect(capability).toEqual({
		host: "hc",
		available: true,
		reason: `terminal ${parentTerminal} runs this process`,
	});
	expect(calls[1]).toEqual(["hc", "get", parentTerminal, "--json"]);
});

test("hc does not claim a terminal from an inherited environment", async () => {
	const { runner, calls } = runnerFor([]);
	const capability = await createHcHostAdapter({
		runner,
		ownerId: "owner",
		ownsAttachment,
		env: {},
	}).probe();
	expect(capability).toEqual({
		host: "hc",
		available: false,
		reason: "HC_TERMINAL_ID is not set: this process does not run in an hc terminal",
	});
	expect(calls).toEqual([]);
});

test("hc does not claim a terminal that runs something else", async () => {
	const { runner } = runnerFor([
		result(processTree()),
		result(hcTerminal({ foregroundPid: 4242 })),
	]);
	const capability = await createHcHostAdapter({
		runner,
		ownerId: "owner",
		ownsAttachment,
		env: hcEnv,
	}).probe();
	expect(capability.available).toBe(false);
	expect(capability.reason).toBe(`terminal ${parentTerminal} does not run this process`);
});

test("hc opens a child terminal that carries the bridge environment", async () => {
	const { runner, calls } = runnerFor([
		result(processTree()),
		result(hcTerminal({ foregroundPid: process.pid })),
		result(JSON.stringify({ address: childTerminal, state: "live" })),
		result(hcTerminal({ address: childTerminal, foregroundPid: 7 })),
		result(hcTerminal({ address: childTerminal, foregroundPid: 7 })),
		result(hcTerminal({ address: childTerminal, foregroundPid: 7 })),
		result(JSON.stringify({ address: childTerminal })),
		result(JSON.stringify({ removed: childTerminal })),
	]);
	const attachment = await createHcHostAdapter({
		runner,
		ownerId: "owner",
		ownsAttachment,
		env: hcEnv,
	}).open(spec);
	expect(attachment.identity).toEqual({
		host: "hc",
		attachmentId: childTerminal,
		createdBy: "owner",
	});
	expect(attachment.reportsFocus).toBe(false);
	expect(calls[2]).toEqual([
		"hc",
		"run",
		"--bg",
		"--json",
		"--no-notify",
		"--cwd",
		"/tmp/work dir",
		"--label",
		"pi-subagents=agent-7",
		"env",
		"PI_SUBAGENTS_ENDPOINT=/tmp/socket path",
		"PI_SUBAGENTS_AGENT=secret'quoted",
		"/usr/bin/node",
		"/tmp/pi cli.js",
		"--thinking",
		"high",
	]);
	expect(await attachment.observe()).toMatchObject({ alive: true, known: true });
	expect((await attachment.cleanup()).exitCode).toBe(0);
	expect(calls.at(-2)).toEqual(["hc", "kill", childTerminal, "--json"]);
	expect(calls.at(-1)).toEqual(["hc", "rm", childTerminal, "--json"]);
});

test("hc run args keep the environment out of the shell", () => {
	expect(hcRunArgs({ ...spec, env: {} })).toEqual([
		"run",
		"--bg",
		"--json",
		"--no-notify",
		"--cwd",
		"/tmp/work dir",
		"--label",
		"pi-subagents=agent-7",
		"/usr/bin/node",
		"/tmp/pi cli.js",
		"--thinking",
		"high",
	]);
});

test("hc reports a removed terminal as gone, a finished one as dead, and a failed query as unknown", async () => {
	const removed = rebindHcTerminal({
		runner: runnerFor([
			result(
				JSON.stringify({ error: { kind: "not_found", message: `no terminal "${childTerminal}"` } }),
				"",
				3,
			),
		]).runner,
		address: childTerminal,
		ownerId: "owner",
		ownsAttachment,
	});
	expect(await removed.observe()).toMatchObject({ alive: false, known: true, containerGone: true });

	const finished = rebindHcTerminal({
		runner: runnerFor([result(hcTerminal({ address: childTerminal, state: "finished" }))]).runner,
		address: childTerminal,
		ownerId: "owner",
		ownsAttachment,
	});
	expect(await finished.observe()).toMatchObject({ alive: false, known: true });

	const failed = rebindHcTerminal({
		runner: runnerFor([result("", "hc: core is not running", 1)]).runner,
		address: childTerminal,
		ownerId: "owner",
		ownsAttachment,
	});
	expect(await failed.observe()).toMatchObject({ alive: false, known: false });
});

test("hc reads aliveness only from a terminal state it understands", () => {
	expect(hcTerminalAlive(result(hcTerminal({ state: "live" })))).toBe(true);
	expect(hcTerminalAlive(result(hcTerminal({ state: "finished" })))).toBe(false);
	expect(hcTerminalAlive(result("not json"))).toBeUndefined();
	expect(
		hcTerminalAlive(result(JSON.stringify({ address: "t15", state: "spawning" }))),
	).toBeUndefined();
});

test("hc lists the terminals of the core that answered, and its instance as the generation", async () => {
	const { runner, calls } = runnerFor([
		result(JSON.stringify({ core: { id: "core-1", name: "judy" }, live: 2 })),
		result(
			JSON.stringify({
				terminals: [{ address: parentTerminal }, { address: childTerminal, state: "finished" }],
			}),
		),
	]);
	expect(await listHcAttachments(runner, 1_000)).toEqual({
		known: true,
		generation: "hc:core-1",
		present: new Set([parentTerminal, childTerminal]),
	});
	expect(calls).toEqual([
		["hc", "server", "status", "--json"],
		["hc", "ls", "--all", "--json"],
	]);
});

test("hc reports an unreadable listing as unknown instead of an empty one", async () => {
	const unreadable = runnerFor([result("", "hc: core is not running", 1)]).runner;
	expect(await listHcAttachments(unreadable, 1_000)).toEqual({ known: false });

	const garbled = runnerFor([
		result(JSON.stringify({ core: { id: "core-1" } })),
		result("not json"),
	]).runner;
	expect(await listHcAttachments(garbled, 1_000)).toEqual({ known: false });
});

test("default selection reaches hc before the other hosts", async () => {
	const selection = await selectHostAdapter({
		adapters: {
			hc: {
				kind: "hc",
				probe: async () => ({ host: "hc", available: true, reason: "terminal runs this process" }),
				open: async () => {
					throw new Error("not used");
				},
			},
			herdr: {
				kind: "herdr",
				probe: async () => ({ host: "herdr", available: true, reason: "pane runs this process" }),
				open: async () => {
					throw new Error("not used");
				},
			},
			cmux: {
				kind: "cmux",
				probe: async () => ({ host: "cmux", available: true, reason: "cmux answers" }),
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
	expect(selection.selectedHost).toBe("hc");
});
