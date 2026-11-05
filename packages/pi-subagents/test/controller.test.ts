import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { StandaloneControllerError, startStandaloneController } from "../src/controller.js";
import { holdProcessLock } from "../src/process-lock.js";
import { withoutInheritedChildIdentity } from "./helpers/bridge-env.js";

withoutInheritedChildIdentity();

test("a standalone controller keeps one parent session and refuses a second owner", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-subagents-controller-workspace-"));
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagents-controller-agent-"));
	// The extension resolves its own state from the agent dir environment, so the controller it
	// loads must see this temporary one rather than the machine's real state.
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	try {
		const first = await startStandaloneController({ workspace, agentDir }).catch(
			(error: unknown) => error,
		);
		expect(first).toBeInstanceOf(StandaloneControllerError);
		if (!(first instanceof StandaloneControllerError)) return;
		expect(first.code).toBe("model_unavailable");
		expect(first.parentSessionId).toBeTruthy();

		const locks = (await readdir(join(agentDir, "subagents", "controllers"))).filter((name) =>
			name.endsWith(".lock"),
		);
		expect(locks).toHaveLength(1);
		const held = holdProcessLock(join(agentDir, "subagents", "controllers", locks[0] ?? ""));
		const busy = await startStandaloneController({ workspace, agentDir }).catch(
			(error: unknown) => error,
		);
		held.release();
		expect(busy).toBeInstanceOf(StandaloneControllerError);
		if (!(busy instanceof StandaloneControllerError)) return;
		expect(busy.code).toBe("busy");

		const second = await startStandaloneController({ workspace, agentDir }).catch(
			(error: unknown) => error,
		);
		expect(second).toBeInstanceOf(StandaloneControllerError);
		if (!(second instanceof StandaloneControllerError)) return;
		expect(second.code).toBe("model_unavailable");
		expect(second.parentSessionId).toBe(first.parentSessionId);
	} finally {
		vi.unstubAllEnvs();
		await rm(workspace, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	}
}, 30_000);
