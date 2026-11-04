import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

/**
 * A real Pi host, its real tool pipeline, and the real child process it launches. The probe
 * extension drives the ownership scope from `session_start` through a tool context the host itself
 * created, so validation, `tool_call` hooks and the nested-call seam are the ones a model gets.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(packageRoot, "..", "..");
const cli = join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

/** The bridge identity of the test runner must not leak into the host it starts. */
const CHILD_ENVIRONMENT = [
	"PI_SUBAGENTS_PARENT_SESSION_ID",
	"PI_SUBAGENTS_CHILD_ID",
	"PI_SUBAGENTS_RUNTIME_ID",
	"PI_SUBAGENTS_ENDPOINT",
	"PI_SUBAGENTS_AGENT",
	"PI_SUBAGENTS_SESSION_ID",
	"PI_SUBAGENTS_TITLE",
];

const PROBE = `
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { getService } from "@hheei/pi-ext-core";
import { SUBAGENT_OWNERSHIP_SERVICE } from "@hheei/pi-subagents/ownership";

let runner;
const createContext = ExtensionRunner.prototype.createContext;
ExtensionRunner.prototype.createContext = function () {
  runner = this;
  return createContext.call(this);
};

function claims(directory) {
  const db = new DatabaseSync(directory + "/pi-subagents/state.sqlite");
  try {
    return db
      .prepare("select child_id, owner_id, incarnation from owned_children")
      .all()
      .map((row) => ({ childId: row.child_id, ownerId: row.owner_id, incarnation: row.incarnation }));
  } finally {
    db.close();
  }
}

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    const crash = process.env.PROBE_CRASH === "1";
    const out = { crash, claimsAtStart: claims(process.env.PI_CODING_AGENT_DIR) };
    try {
      const service = getService(pi, SUBAGENT_OWNERSHIP_SERVICE);
      out.service = Boolean(service);
      if (!service) throw new Error("the ownership service was not registered");
      if (process.env.PROBE_MODE === "dispatch") {
        const toolCtx = runner.createToolContext("call/0", new AbortController().signal);
        const scope = service.openScope("run_probe");
        const handle = await scope.delegate({ agent: "reviewer", task: "review the change" }, toolCtx);
        out.childId = handle.childId;
        out.claimsAfterDispatch = claims(process.env.PI_CODING_AGENT_DIR);
        if (!crash) {
          out.close = await scope.close("probe done");
          out.claimsAfterClose = claims(process.env.PI_CODING_AGENT_DIR);
        }
      }
    } catch (error) {
      out.error = String((error && error.stack) || error);
    }
    writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 2));
    if (crash) {
      // A provider that dies without cleanup leaves its claim and its child behind.
      process.kill(process.pid, "SIGKILL");
      return;
    }
    ctx.shutdown();
  });
}
`;

/** A `tool_call` hook that rewrites the arguments of every delegation it sees. */
const HOOK = `
import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "agents_delegate") return;
    appendFileSync(process.env.PROBE_HOOK_LOG, JSON.stringify({
      hadOwner: event.input !== null && typeof event.input === "object" && "owner" in event.input,
      parent: event.parentToolCallId,
    }) + String.fromCharCode(10));
    delete event.input.owner;
  });
}
`;

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * The assistant message that issued `call/0`. The host runs a nested call from a tool context, and
 * the nested runner reads the message that issued the parent call out of the session.
 */
function writeSession(directory: string): string {
	const timestamp = new Date(0).toISOString();
	const entries = [
		{
			type: "session",
			version: 3,
			id: "11111111-1111-4111-8111-111111111111",
			cwd: directory,
			timestamp,
		},
		{
			type: "message",
			id: "assistant-1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call/0", name: "owned_probe", arguments: {} }],
				api: "anthropic",
				provider: "anthropic",
				model: "claude-sonnet-4",
				stopReason: "toolUse",
				timestamp: 0,
				usage: USAGE,
			},
		},
	];
	const path = join(directory, "session.jsonl");
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

function fixture() {
	if (!existsSync(cli)) throw new Error(`the bundled Pi CLI is not installed at ${cli}`);
	const directory = mkdtempSync(join(tmpdir(), "pi-subagents-host-"));
	// Published files are staged without host devDependencies, exactly as an install would.
	for (const name of ["pi-ext-core", "pi-subagents"]) {
		const source = join(repoRoot, "packages", name);
		const target = join(directory, "node_modules/@hheei", name);
		mkdirSync(target, { recursive: true });
		cpSync(join(source, "dist"), join(target, "dist"), { recursive: true });
		cpSync(join(source, "package.json"), join(target, "package.json"));
	}
	writeFileSync(join(directory, "probe.mjs"), PROBE);
	writeFileSync(join(directory, "hook.mjs"), HOOK);
	const session = writeSession(directory);
	const evidence = join(directory, "evidence.json");
	const hookLog = join(directory, "hook.log");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_CODING_AGENT_DIR: join(directory, "agent"),
		PI_CODING_AGENT_SESSION_DIR: join(directory, "sessions"),
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		PROBE_OUT: evidence,
		PROBE_HOOK_LOG: hookLog,
	};
	for (const key of CHILD_ENVIRONMENT) delete env[key];
	return {
		directory,
		claims() {
			const db = new DatabaseSync(join(directory, "agent/pi-subagents/state.sqlite"));
			try {
				const rows = db
					.prepare("select child_id, owner_id, incarnation from owned_children")
					.all() as Array<{ child_id: string; owner_id: string; incarnation: string }>;
				return rows.map((row) => ({
					childId: row.child_id,
					ownerId: row.owner_id,
					incarnation: row.incarnation,
				}));
			} finally {
				db.close();
			}
		},
		/** The child record this host wrote, read from its own ledger. */
		child(childId: string): { intent?: string; state?: string; presentation?: string } {
			const db = new DatabaseSync(join(directory, "agent/pi-subagents/state.sqlite"));
			try {
				const row = db.prepare("select record from children where subagent_id = ?").get(childId) as
					| { record: string }
					| undefined;
				return row === undefined ? {} : JSON.parse(row.record);
			} finally {
				db.close();
			}
		},
		hooked(): Array<{ hadOwner: boolean; parent?: string }> {
			if (!existsSync(hookLog)) return [];
			return readFileSync(hookLog, "utf8")
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => JSON.parse(line) as { hadOwner: boolean; parent?: string });
		},
		read(): {
			service?: boolean;
			childId?: string;
			error?: string;
			close?: { closed: boolean; failures: string[] };
			claimsAtStart?: unknown[];
			claimsAfterDispatch?: unknown[];
			claimsAfterClose?: unknown[];
		} {
			if (!existsSync(evidence)) {
				throw new Error("the host wrote no evidence");
			}
			return JSON.parse(readFileSync(evidence, "utf8"));
		},
		run(env2: { readonly mode: string; readonly crash?: boolean }) {
			return spawnSync(
				process.execPath,
				[
					cli,
					"--offline",
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--no-context-files",
					"--no-approve",
					"--mode",
					"rpc",
					"-e",
					join(directory, "node_modules/@hheei/pi-subagents/dist/extension.js"),
					"-e",
					join(directory, "hook.mjs"),
					"-e",
					join(directory, "probe.mjs"),
					"--session",
					session,
					"--session-dir",
					join(directory, "sessions"),
					"--provider",
					"anthropic",
					"--model",
					"claude-sonnet-4",
				],
				{
					cwd: directory,
					encoding: "utf8",
					input: "",
					timeout: 120_000,
					env: {
						...env,
						PROBE_MODE: env2.mode,
						...(env2.crash === true ? { PROBE_CRASH: "1" } : {}),
					},
				},
			);
		},
		cleanup(): void {
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

test.skipIf(process.platform === "win32")(
	"the host launches an owned child through a tool_call hook that strips its arguments",
	() => {
		const current = fixture();
		try {
			const result = current.run({ mode: "dispatch" });
			const observed = current.read();
			expect(observed.error, JSON.stringify(observed)).toBeUndefined();
			expect(result.error, result.stderr).toBeUndefined();
			if (observed.error !== undefined) return;
			expect(observed.service).toBe(true);
			// The native hook ran on the nested call and removed the owner argument.
			expect(current.hooked()).toEqual([{ hadOwner: true, parent: "call/0" }]);
			// The child is still owned: the claim was written by the call, not by its arguments.
			expect(observed.claimsAfterDispatch).toHaveLength(1);
			expect(observed.claimsAfterDispatch?.[0]).toMatchObject({ ownerId: "run_probe" });
			const childId = observed.childId ?? "";
			expect(childId).not.toBe("");
			// Owned work is headless and the confirmed close ends it.
			expect(current.child(childId)).toMatchObject({
				presentation: "background",
				intent: "stopped",
			});
			expect(observed.close).toEqual({ closed: true, failures: [] });
			expect(current.claims()).toEqual([]);
		} finally {
			current.cleanup();
		}
	},
	150_000,
);

test.skipIf(process.platform === "win32")(
	"a restarted host stops the owned child a crashed host left behind",
	() => {
		const current = fixture();
		try {
			const crashed = current.run({ mode: "dispatch", crash: true });
			expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
			const left = current.read();
			if (left.error !== undefined) throw new Error(left.error);
			// Nothing cleaned up: the claim and its child survive the provider that wrote them.
			expect(current.claims()).toHaveLength(1);
			expect(left.claimsAfterClose).toBeUndefined();

			const restarted = current.run({ mode: "boot" });
			expect(restarted.error, restarted.stderr).toBeUndefined();
			const after = current.read();
			// Recovery ran during attach, before the probe's session started.
			expect(after.claimsAtStart).toEqual([]);
			// It stops the orphan instead of adopting it, and drops the claim the dead owner left.
			expect(current.claims()).toEqual([]);
			expect(current.child(left.childId ?? "")).toMatchObject({ intent: "stopped" });
		} finally {
			current.cleanup();
		}
	},
	150_000,
);
