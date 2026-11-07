import { errorMessage } from "@hheei/pi-ext-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	createCmuxHostAdapter,
	createHerdrHostAdapter,
	type HostAdapter,
	type HostAttachment,
	type HostCommandResult,
	type HostCommandRunner,
	herdrTabIds,
	listRexAttachments,
	selectHostAdapter,
} from "../src/host-adapter.js";
import type { LaunchSpec } from "../src/launch-spec.js";

const spec: LaunchSpec = {
	command: "/usr/bin/node",
	argv: ["/tmp/pi cli.js", "--thinking", "high", "--session-id", "01J7-session"],
	cwd: "/tmp/work dir",
	presentation: "panel",
	stdio: "inherit",
	env: { PI_SUBAGENTS_ENDPOINT: "/tmp/socket path", PI_SUBAGENTS_AGENT: "secret'quoted" },
	config: { subagentId: "agent-7" } as LaunchSpec["config"],
};

const quotedLaunch = `'/usr/bin/node' '/tmp/pi cli.js' '--thinking' 'high' '--session-id' '01J7-session'`;

/** The pid of the shell that owns the pane under test. */
const paneShellPid = 4242;

/** The real `ps -A -o pid=,ppid=` answer for this process, its parent and that parent's parent. */
function processTree(parent = 1): string {
	return `${process.pid} ${parent}\n${parent} 1\n1 0\n`;
}

/** The real `herdr tab create` answer: the new tab plus the root pane it owns. */
const herdrTabCreated = JSON.stringify({
	id: "cli:tab:create",
	result: {
		type: "tab_created",
		root_pane: { pane_id: "wG:pD", tab_id: "wG:tH", cwd: "/tmp/work dir" },
		tab: { tab_id: "wG:tH", label: "child-a", focused: false, pane_count: 1 },
	},
});
const ownsAttachment = (): boolean => true;

/** The real `herdr tab list` / `herdr workspace list` answers, which are how focus is read. */
function herdrTabList(tabId: string, workspaceId: string, focused: boolean): string {
	return JSON.stringify({
		id: "cli:tab:list",
		result: {
			type: "tab_list",
			tabs: [{ tab_id: tabId, workspace_id: workspaceId, focused, label: "agent-7" }],
		},
	});
}

function herdrWorkspaceList(workspaceId: string, focused: boolean): string {
	return JSON.stringify({
		id: "cli:workspace:list",
		result: {
			type: "workspace_list",
			workspaces: [{ workspace_id: workspaceId, focused, active_tab_id: "wG:tH" }],
		},
	});
}

/** The real `herdr pane list` answer. */
function herdrPaneList(
	panes: ReadonlyArray<{
		readonly paneId: string;
		readonly tabId: string;
		readonly workspaceId: string;
	}>,
): string {
	return JSON.stringify({
		id: "cli:pane:list",
		result: {
			type: "pane_list",
			panes: panes.map((pane) => ({
				pane_id: pane.paneId,
				tab_id: pane.tabId,
				workspace_id: pane.workspaceId,
			})),
		},
	});
}

/**
 * The real `herdr pane process-info` answer: the pane's foreground job is `foregroundPids`, and
 * `paneShellPid` owns the terminal it runs in.
 */
function herdrPaneProcessInfo(paneId: string, foregroundPids: readonly number[]): string {
	return JSON.stringify({
		id: "cli:pane:process_info",
		result: {
			type: "pane_process_info",
			process_info: {
				pane_id: paneId,
				shell_pid: paneShellPid,
				foreground_process_group_id: foregroundPids[0] ?? paneShellPid,
				foreground_processes: foregroundPids.map((pid) => ({
					argv: ["/usr/bin/pi"],
					name: "pi",
					pid,
				})),
			},
		},
	});
}

function result(
	stdout = "",
	stderr = "",
	exitCode: number | null = 0,
	timedOut = false,
): HostCommandResult {
	return { stdout, stderr, exitCode, timedOut };
}

/** This process owns pane `wG:p2`, which lives in workspace `wG`. */
const ownedByThisProcess = [
	result(processTree()),
	result(herdrPaneList([{ paneId: "wG:p2", tabId: "wG:t2", workspaceId: "wG" }])),
	result(herdrPaneProcessInfo("wG:p2", [process.pid])),
] as const;

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

function runningProcessInfo(paneId: string): string {
	return JSON.stringify({
		id: "cli:pane:process_info",
		result: {
			process_info: {
				foreground_processes: [{ argv: ["/usr/bin/node"], name: "node", pid: 42 }],
				pane_id: paneId,
				shell_pid: 7,
			},
		},
	});
}

function idleProcessInfo(paneId: string): string {
	return JSON.stringify({
		id: "cli:pane:process_info",
		result: {
			process_info: {
				foreground_processes: [{ argv: ["/usr/bin/zsh"], name: "zsh", pid: 7 }],
				pane_id: paneId,
				shell_pid: 7,
			},
		},
	});
}

const herdrTabCreateCall = [
	"herdr",
	"tab",
	"create",
	"--cwd",
	"/tmp/work dir",
	"--label",
	"agent-7",
	"--no-focus",
	"--workspace",
	"wG",
	"--env",
	"PI_SUBAGENTS_ENDPOINT=/tmp/socket path",
	"--env",
	"PI_SUBAGENTS_AGENT=secret'quoted",
];

beforeEach(() => {
	vi.stubEnv("HERDR_ENV", "1");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

test("Herdr opens its own labeled tab and runs the LaunchSpec in its root pane", async () => {
	const { runner, calls } = runnerFor([
		...ownedByThisProcess,
		result(herdrTabCreated),
		result(),
		result(runningProcessInfo("wG:pD")),
		result(herdrTabList("wG:tH", "wG", true)),
		result(herdrWorkspaceList("wG", true)),
		result('{"result":{"type":"ok"}}'),
	]);
	const adapter = createHerdrHostAdapter({ runner, ownerId: "owner-1", ownsAttachment });
	const attachment = await adapter.open(spec);
	const observed = await attachment.observe();
	await attachment.cleanup();

	// Ownership is read from the kernel, then the tab goes into the owning pane's workspace.
	expect(calls[0]).toEqual(["ps", "-A", "-o", "pid=,ppid="]);
	expect(calls[1]).toEqual(["herdr", "pane", "list"]);
	expect(calls[2]).toEqual(["herdr", "pane", "process-info", "--pane", "wG:p2"]);
	expect(calls[3]).toEqual(herdrTabCreateCall);
	expect(calls[4]).toEqual(["herdr", "pane", "run", "wG:pD", quotedLaunch]);
	expect(calls[4]?.[4]).not.toContain("PI_SUBAGENTS_AGENT");
	expect(observed).toMatchObject({
		alive: true,
		known: true,
		focused: true,
		identity: { host: "herdr", attachmentId: "wG:tH", createdBy: "owner-1" },
	});
	expect(attachment.presence).toBe("observable");
	expect(calls[5]).toEqual(["herdr", "pane", "process-info", "--pane", "wG:pD"]);
	expect(calls[6]).toEqual(["herdr", "tab", "list"]);
	expect(calls[7]).toEqual(["herdr", "workspace", "list"]);
	expect(calls.at(-1)).toEqual(["herdr", "tab", "close", "wG:tH"]);
});

test("Herdr reports focus only when the child's tab and its workspace are both focused", async () => {
	const cases: ReadonlyArray<{
		readonly name: string;
		readonly tabs: string;
		readonly workspaces: string;
		readonly expected: boolean | undefined;
	}> = [
		{
			name: "both focused",
			tabs: herdrTabList("wG:tH", "wG", true),
			workspaces: herdrWorkspaceList("wG", true),
			expected: true,
		},
		{
			name: "the tab is not the focused one",
			tabs: herdrTabList("wG:tH", "wG", false),
			workspaces: herdrWorkspaceList("wG", true),
			expected: false,
		},
		{
			name: "the tab is focused inside a workspace nobody is looking at",
			tabs: herdrTabList("wG:tH", "wG", true),
			workspaces: herdrWorkspaceList("wG", false),
			expected: false,
		},
		{
			name: "the listing is unusable",
			tabs: "not json",
			workspaces: herdrWorkspaceList("wG", true),
			expected: undefined,
		},
		{
			name: "the tab is gone",
			tabs: herdrTabList("wG:tZ", "wG", true),
			workspaces: herdrWorkspaceList("wG", true),
			expected: undefined,
		},
		{
			// A host that stops reporting the field is unknown, not unfocused: the caller closes a
			// panel on "unfocused", so a missing answer must never be read as one.
			name: "the tab listing omits focused",
			tabs: JSON.stringify({
				result: { tabs: [{ tab_id: "wG:tH", workspace_id: "wG" }] },
			}),
			workspaces: herdrWorkspaceList("wG", true),
			expected: undefined,
		},
		{
			name: "the workspace listing omits focused",
			tabs: herdrTabList("wG:tH", "wG", true),
			workspaces: JSON.stringify({
				result: { workspaces: [{ workspace_id: "wG" }] },
			}),
			expected: undefined,
		},
	];
	for (const item of cases) {
		const { runner } = runnerFor([
			...ownedByThisProcess,
			result(herdrTabCreated),
			result(),
			result(runningProcessInfo("wG:pD")),
			result(item.tabs),
			result(item.workspaces),
		]);
		const attachment = await createHerdrHostAdapter({
			runner,
			ownerId: "owner-1",
			ownsAttachment,
		}).open(spec);
		const observed = await attachment.observe();
		expect(observed.focused, item.name).toBe(item.expected);
	}
});

test("Herdr probe is unavailable when no pane runs this process group", async () => {
	const { runner, calls } = runnerFor([
		result(processTree()),
		result(
			herdrPaneList([
				{ paneId: "wG:p2", tabId: "wG:t2", workspaceId: "wG" },
				{ paneId: "wG:p3", tabId: "wG:t3", workspaceId: "wG" },
			]),
		),
		result(herdrPaneProcessInfo("wG:p2", [11])),
		result(herdrPaneProcessInfo("wG:p3", [12])),
	]);
	const capability = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability.available).toBe(false);
	expect(capability.reason).toBe("no herdr pane runs this process");
	expect(calls.filter((call) => call[1] === "pane" && call[2] === "process-info")).toHaveLength(2);
});

test("Herdr probe accepts a pane whose foreground job is an ancestor", async () => {
	// A wrapper such as `pnpm exec` runs this process as a child, while the pane's foreground job
	// is still the Pi above it.
	const wrapperPid = 777;
	const { runner } = runnerFor([
		result(processTree(wrapperPid)),
		result(herdrPaneList([{ paneId: "wG:p2", tabId: "wG:t2", workspaceId: "wG" }])),
		result(herdrPaneProcessInfo("wG:p2", [wrapperPid])),
	]);
	const capability = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability).toEqual({
		host: "herdr",
		available: true,
		reason: "pane wG:p2 runs this process",
	});
});

test("Herdr probe ignores a pane that only runs its own shell", async () => {
	// `pi &` and anything else started from a pane leaves the shell in the foreground, so the pane
	// is not this process's pane.
	const { runner } = runnerFor([
		result(processTree(paneShellPid)),
		result(herdrPaneList([{ paneId: "wG:p2", tabId: "wG:t2", workspaceId: "wG" }])),
		result(herdrPaneProcessInfo("wG:p2", [paneShellPid])),
	]);
	const capability = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability).toEqual({
		host: "herdr",
		available: false,
		reason: "no herdr pane runs this process",
	});
});

test("Herdr probe finds the owning pane even when the inherited pane id is gone", async () => {
	// A GUI app or daemon started from a herdr pane keeps this id after the pane is closed; the
	// pane list is the fact, the environment is only a hint.
	vi.stubEnv("HERDR_PANE_ID", "wK:p8");
	const { runner, calls } = runnerFor([
		result(processTree()),
		result(herdrPaneList([{ paneId: "wG:p2", tabId: "wG:t2", workspaceId: "wG" }])),
		result(herdrPaneProcessInfo("wG:p2", [process.pid])),
	]);
	const capability = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability).toEqual({
		host: "herdr",
		available: true,
		reason: "pane wG:p2 runs this process",
	});
	expect(calls[2]).toEqual(["herdr", "pane", "process-info", "--pane", "wG:p2"]);
});

test("Herdr probe asks the inherited pane first", async () => {
	vi.stubEnv("HERDR_PANE_ID", "wG:p9");
	const { runner, calls } = runnerFor([
		result(processTree()),
		result(
			herdrPaneList([
				{ paneId: "wG:p2", tabId: "wG:t2", workspaceId: "wG" },
				{ paneId: "wG:p9", tabId: "wG:t9", workspaceId: "wG" },
			]),
		),
		result(herdrPaneProcessInfo("wG:p9", [process.pid])),
	]);
	const capability = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability.available).toBe(true);
	expect(calls.filter((call) => call[1] === "pane" && call[2] === "process-info")).toEqual([
		["herdr", "pane", "process-info", "--pane", "wG:p9"],
	]);
});

test("Herdr probe reports the host error code when the pane list is rejected", async () => {
	const { runner } = runnerFor([
		result(processTree()),
		result(
			'{"error":{"code":"server_not_running","message":"no herdr server"},"id":"cli:pane:list"}',
		),
	]);
	const capability = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability.available).toBe(false);
	expect(capability.reason).toBe("herdr pane list failed: server_not_running (no herdr server)");
});

test("Herdr probe is unavailable when this process tree cannot be read", async () => {
	const { runner, calls } = runnerFor([result("", "ps: not found", 127)]);
	const capability = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability).toEqual({
		host: "herdr",
		available: false,
		reason: "could not read this process tree",
	});
	expect(calls).toEqual([["ps", "-A", "-o", "pid=,ppid="]]);
});

test("Herdr open refuses to draw a panel when this process is not in a pane", async () => {
	const { runner, calls } = runnerFor([
		result(processTree()),
		result(herdrPaneList([{ paneId: "wG:p2", tabId: "wG:t2", workspaceId: "wG" }])),
		result(herdrPaneProcessInfo("wG:p2", [11])),
	]);
	const adapter = createHerdrHostAdapter({ runner, ownerId: "owner-1", ownsAttachment });
	await expect(adapter.open(spec)).rejects.toThrow("herdr panel: no herdr pane runs this process");
	expect(calls.some((call) => call[1] === "tab" && call[2] === "create")).toBe(false);
});

test("Herdr tab creation rejection is reported with the host error code", async () => {
	const { runner, calls } = runnerFor([
		...ownedByThisProcess,
		result(
			'{"error":{"code":"workspace_not_found","message":"workspace wG not found"},"id":"cli:tab:create"}',
		),
	]);
	const adapter = createHerdrHostAdapter({ runner, ownerId: "owner-1", ownsAttachment });
	await expect(adapter.open(spec)).rejects.toThrow(
		"herdr tab create failed: workspace_not_found (workspace wG not found)",
	);
	expect(calls.some((call) => call[1] === "pane" && call[2] === "run")).toBe(false);
});

test("Herdr tab creation failure never launches a command", async () => {
	const { runner, calls } = runnerFor([...ownedByThisProcess, result("", "tab create denied", 1)]);
	const adapter = createHerdrHostAdapter({ runner, ownerId: "owner-1", ownsAttachment });
	try {
		await adapter.open(spec);
		throw new Error("expected open to fail");
	} catch (error) {
		expect(errorMessage(error)).toContain("herdr tab create returned no tab and root pane id");
	}
	expect(calls.some((call) => call[1] === "pane" && call[2] === "run")).toBe(false);
});

test("Herdr command timeout still returns the attachment and does not close the tab", async () => {
	const { runner, calls } = runnerFor([
		...ownedByThisProcess,
		result(herdrTabCreated),
		result("", "deadline", null, true),
	]);
	const attachment = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).open(spec);
	expect(attachment.identity.attachmentId).toBe("wG:tH");
	expect(attachment.launch.timedOut).toBe(true);
	expect(calls.some((call) => call[1] === "tab" && call[2] === "close")).toBe(false);
});

test("Herdr cleanup still closes an owned tab after the child process has exited", async () => {
	const { runner, calls } = runnerFor([
		...ownedByThisProcess,
		result(herdrTabCreated),
		result(),
		result(idleProcessInfo("wG:pD")),
		result('{"result":{"type":"ok"}}'),
	]);
	const attachment = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).open(spec);
	expect((await attachment.observe()).alive).toBe(false);
	const cleanup = await attachment.cleanup();
	expect(cleanup.exitCode).toBe(0);
	expect(calls.at(-1)).toEqual(["herdr", "tab", "close", "wG:tH"]);
});

test("cmux opens a new surface without splitting the parent layout", async () => {
	const { runner, calls } = runnerFor([
		result('{"surface_id":"surface:7"}'),
		result('{"panels":["surface:7"]}'),
		result(),
	]);
	const attachment = await createCmuxHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).open(spec);
	await attachment.cleanup();
	expect(calls[0]?.[0]).toBe("cmux");
	expect(calls[0]?.slice(1, 3)).toEqual(["--json", "new-surface"]);
	expect(calls[0]?.[3]).toBe("--command");
	expect(calls[0]?.[4]).toContain("cd '/tmp/work dir'");
	expect(calls[0]?.[4]).toContain(quotedLaunch);
	expect(calls[0]?.[4]).not.toContain("--mode");
	expect(calls[0]?.join(" ")).not.toContain("new-split");
	expect(attachment.presence).toBe("unknown");
	expect(calls.at(-1)).toEqual(["cmux", "--json", "close-surface", "--surface", "surface:7"]);
});

test("cmux surface rejection is reported with the host error code", async () => {
	const { runner } = runnerFor([
		result('{"error":{"code":"no_socket","message":"cmux is not running"},"id":"cli:new-surface"}'),
	]);
	await expect(
		createCmuxHostAdapter({ runner, ownerId: "owner-1", ownsAttachment }).open(spec),
	).rejects.toThrow("cmux new-surface failed: no_socket (cmux is not running)");
});

test("cmux probe does not claim availability from a missing binary", async () => {
	const { runner } = runnerFor([result("", "command not found: cmux", 127)]);
	const capability = await createCmuxHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability).toEqual({
		host: "cmux",
		available: false,
		reason: "cmux ping failed: command not found: cmux",
	});
});

test("cmux probe requires a successful capabilities query after ping", async () => {
	const { runner } = runnerFor([result('{"pong":true}'), result("", "no socket methods", 1)]);
	const capability = await createCmuxHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability.available).toBe(false);
	expect(capability.reason).toBe("cmux capabilities failed: no socket methods");
});

function fakeAdapter(kind: "hc" | "herdr" | "cmux" | "rex", available: boolean): HostAdapter {
	return {
		kind,
		probe: async () => ({
			host: kind,
			available,
			reason: available ? "ready" : "unavailable",
		}),
		open: async () => {
			throw new Error("not used");
		},
	};
}

test("default selection falls back from Herdr to cmux and records the reason", async () => {
	const selection = await selectHostAdapter({
		adapters: {
			hc: fakeAdapter("hc", false),
			herdr: fakeAdapter("herdr", false),
			cmux: fakeAdapter("cmux", true),
			rex: fakeAdapter("rex", false),
		},
	});
	expect(selection.available).toBe(true);
	if (selection.available) {
		expect(selection.selectedHost).toBe("cmux");
		expect(selection.reason).toContain("herdr: unavailable");
	}
});

test("explicit unavailable host fails without silent fallback", async () => {
	const selection = await selectHostAdapter({
		preferredHost: "herdr",
		adapters: {
			hc: fakeAdapter("hc", false),
			herdr: fakeAdapter("herdr", false),
			cmux: fakeAdapter("cmux", true),
			rex: fakeAdapter("rex", false),
		},
	});
	expect(selection).toMatchObject({ available: false, selectedHost: null });
	expect(selection.reason).toContain("explicit host unavailable");
});

test("stale cleanup refuses to close after ownership is revoked", async () => {
	let owned = true;
	const { runner, calls } = runnerFor([...ownedByThisProcess, result(herdrTabCreated), result()]);
	const attachment = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment: () => owned,
	}).open(spec);
	owned = false;
	const cleanup = await attachment.cleanup();
	expect(cleanup.stderr).toContain("ownership was revoked");
	expect(calls.some((call) => call[1] === "tab" && call[2] === "close")).toBe(false);
});

test("a pane that no longer exists is a known dead child, not an unknown one", async () => {
	const { runner } = runnerFor([
		...ownedByThisProcess,
		result(herdrTabCreated),
		result(),
		// What herdr prints for a closed pane: an error on stderr and a non-zero exit code.
		result(
			"",
			'{"error":{"code":"pane_not_found","message":"pane not found"},"id":"cli:pane:process_info"}',
			1,
		),
		result(herdrTabList("wG:tH", "wG", true)),
		result(herdrWorkspaceList("wG", true)),
	]);
	const attachment = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).open(spec);

	// The caller drops the runtime evidence on this answer, so it must mean "the child is gone" and
	// not "the host could not say".
	await expect(attachment.observe()).resolves.toMatchObject({ alive: false, known: true });
});

test("a failed process query is unknown rather than a dead child", async () => {
	const { runner } = runnerFor([
		...ownedByThisProcess,
		result(herdrTabCreated),
		result(),
		result("", "herdr: server_not_running", 2),
		result(herdrTabList("wG:tH", "wG", true)),
		result(herdrWorkspaceList("wG", true)),
	]);
	const attachment = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).open(spec);

	await expect(attachment.observe()).resolves.toMatchObject({ alive: false, known: false });
	// A failed listing says nothing about focus either: unfocused would close the panel.
	expect((await attachment.observe()).focused).toBeUndefined();
});

test("timed-out observation does not close an owned tab", async () => {
	const { runner, calls } = runnerFor([
		...ownedByThisProcess,
		result(herdrTabCreated),
		result(),
		result("", "process-info hung", null, true),
	]);
	const attachment = await createHerdrHostAdapter({
		runner,
		ownerId: "owner-1",
		ownsAttachment,
	}).open(spec);
	const cleanup = await attachment.cleanup();
	expect(cleanup.stderr).toContain("timed out");
	expect(calls.some((call) => call[1] === "tab" && call[2] === "close")).toBe(false);
});

test("system cmux probe is a capability failure when cmux is not live", async () => {
	const capability = await createCmuxHostAdapter({
		ownerId: "owner-1",
		ownsAttachment,
	}).probe();
	expect(capability.available).toBe(false);
	expect(capability.reason.length).toBeGreaterThan(0);
});

test.skipIf(process.env.HERDR_ENV !== "1")(
	"Herdr live open launches a process from a TUI LaunchSpec in its own tab and closes only that tab",
	async () => {
		vi.unstubAllEnvs();
		const adapter = createHerdrHostAdapter({
			ownerId: "sub-07-smoke",
			ownsAttachment,
			timeoutMs: 8_000,
		});
		const capability = await adapter.probe();
		expect(capability.available).toBe(true);
		let attachment: HostAttachment | undefined;
		try {
			const launched = await adapter.open({
				...spec,
				command: "/usr/bin/sleep",
				argv: ["20"],
				cwd: "/tmp",
				env: { PI_SUBAGENTS_SMOKE: "sub-07" },
			});
			attachment = launched;
			let observed = await launched.observe();
			for (let attempt = 0; attempt < 10 && !observed.alive; attempt++) {
				observed = await launched.observe();
			}
			expect(observed.known).toBe(true);
			expect(observed.alive).toBe(true);
			expect(observed.identity.attachmentId.length).toBeGreaterThan(0);
		} finally {
			const cleanup = await attachment?.cleanup();
			expect(cleanup?.stderr ?? "").not.toContain("ownership was revoked");
		}
	},
	15_000,
);

test("herdrTabIds filters tabs by workspaceId when provided", () => {
	const tabListJson = JSON.stringify({
		result: {
			tabs: [
				{ tab_id: "tab-1", workspace_id: "ws-A" },
				{ tab_id: "tab-2", workspace_id: "ws-B" },
				{ tab_id: "tab-3", workspace_id: "ws-A" },
			],
		},
	});
	expect(herdrTabIds(tabListJson)).toEqual(new Set(["tab-1", "tab-2", "tab-3"]));
	expect(herdrTabIds(tabListJson, "ws-A")).toEqual(new Set(["tab-1", "tab-3"]));
	expect(herdrTabIds(tabListJson, "ws-B")).toEqual(new Set(["tab-2"]));
	expect(herdrTabIds(tabListJson, "ws-C")).toEqual(new Set([]));
});

test("listRexAttachments filters blocks by session when provided", async () => {
	const { runner, calls } = runnerFor([
		result(JSON.stringify({ instance_id: "inst-1", started_at: "t0" })),
		result("blk-s1-1\nblk-s1-2\n"),
	]);
	const list = await listRexAttachments(runner, 1000, {
		env: { REX_SESSION: "session-1" },
	});
	expect(list.known).toBe(true);
	if (!list.known) throw new Error("not known");
	expect(list.generation).toContain("session-1");
	expect(list.present).toEqual(new Set(["blk-s1-1", "blk-s1-2"]));
	expect(calls).toEqual([
		["rex", "api", "call", "server.status"],
		["rex", "block", "ls", "-q", "-s", "session-1"],
	]);
});
