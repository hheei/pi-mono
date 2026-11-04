/**
 * Runtime plumbing for a child Pi process that this parent owns.
 *
 * There is no supervisor: a background child is a child process of this Pi, and a child that runs in
 * a host panel is owned by that host. Either way the parent's bridge socket is what the child dials,
 * so "is this child alive?" is answered by a bridge connection, and the runtime metadata in the
 * registry only records which runtime and endpoint a child was last launched with.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { errorMessage } from "@hheei/pi-ext-core";
import { type ChildRuntime, spawnChildRuntime } from "./child-process.js";
import type { PanelHost, Presentation, SubagentRecord } from "./domain.js";
import type { HostAdapter, HostAttachment, HostObservation } from "./host-adapter.js";
import { buildLaunchSpec, type LaunchSpec } from "./launch-spec.js";
import { commitLease } from "./lease.js";
import type { SubagentRegistry } from "./registry.js";
import { defaultStatePath } from "./state-db.js";

function runtimeDirectory(): string {
	const user = typeof process.getuid === "function" ? process.getuid() : "user";
	return join(tmpdir(), `pi-subagents-${user}`);
}

/**
 * The one mailbox a parent session reads. A child polls this path, so a parent that restarts reads
 * the same file and a surviving child reconnects instead of being rebuilt.
 */
export function parentBridgeEndpoint(_parentSessionId: string): string {
	return defaultStatePath();
}

export interface LaunchChildOptions {
	readonly registry: Pick<SubagentRegistry, "get" | "update">;
	readonly record: SubagentRecord;
	/** Waits for this child's bridge connection; false when it did not connect in time. */
	readonly waitForBridge: (childId: string, signal?: AbortSignal) => Promise<boolean>;
	readonly closeOldAttachment?: (() => Promise<void>) | undefined;
	readonly signal?: AbortSignal;
	readonly diagnose?: (message: string) => void;
}

interface ChildRuntimePlan {
	readonly runtimeIdentity: string;
	readonly endpoint: string;
	readonly spec: LaunchSpec;
}

/**
 * Mints the runtime identity and builds the one LaunchSpec for this presentation. Who starts the
 * child differs (this parent for a background child, the host for a panel one), but the spec does
 * not.
 */
function planChildRuntime(record: SubagentRecord, presentation: Presentation): ChildRuntimePlan {
	const runtimeIdentity = randomUUID();
	const endpoint = parentBridgeEndpoint(record.parentSessionId);
	const spec = buildLaunchSpec({
		config: record.launchConfig,
		invocation: record.launchConfig.invocation,
		presentation,
		persistence: record.persistence,
		bridge: {
			parentSessionId: record.parentSessionId,
			subagentId: record.subagentId,
			runtimeIdentity,
			endpoint,
		},
	});
	return { runtimeIdentity, endpoint, spec };
}

/** Evidence first: the record names the runtime that was asked for even if starting it fails. */
async function recordRuntimeEvidence(
	registry: Pick<SubagentRegistry, "get" | "update">,
	record: SubagentRecord,
	plan: ChildRuntimePlan,
): Promise<void> {
	await commitLease(registry, record.subagentId, {
		type: "runtime-bound",
		runtimeIdentity: plan.runtimeIdentity,
		endpoint: plan.endpoint,
	});
}

/**
 * Starts one headless child Pi and waits for it to connect. Nothing is driven over its stdio: the
 * process gets the parent's mailbox path in its environment, and the bridge is the only control
 * channel. A child that never connects is terminated here rather than left running with no way to
 * reach it.
 */
export async function launchChild(
	options: LaunchChildOptions,
): Promise<LaunchOutcome<ChildRuntime>> {
	const record = options.record;
	const plan = planChildRuntime(record, "background");
	await recordRuntimeEvidence(options.registry, record, plan);
	const runtime = spawnChildRuntime({
		command: plan.spec.command,
		args: plan.spec.argv,
		cwd: plan.spec.cwd,
		env: { ...process.env, ...plan.spec.env },
		...(options.diagnose === undefined ? {} : { diagnose: options.diagnose }),
	});
	let connected: boolean;
	try {
		connected = await options.waitForBridge(record.subagentId, options.signal);
	} catch (error) {
		options.diagnose?.(`bridge wait failed: ${errorMessage(error)}`);
		connected = false;
	}
	if (connected) {
		await bindProcess(options.registry, record.subagentId, runtime.pid);
		return { handle: runtime };
	}
	await runtime.terminate();
	if (runtime.alive) {
		await bindProcess(options.registry, record.subagentId, runtime.pid);
		return {
			handle: runtime,
			failure: `Child ${record.subagentId} never connected to the parent bridge and did not stop (it may still be running)`,
		};
	}
	await commitLease(
		options.registry,
		record.subagentId,
		{ type: "runtime-gone", outcome: "clear" },
		plan.runtimeIdentity,
	);
	return { failure: `Child ${record.subagentId} never connected to the parent bridge` };
}

export interface OpenChildPanelOptions extends LaunchChildOptions {
	readonly host: HostAdapter;
}

export interface LaunchOutcome<T> {
	readonly handle?: T;
	readonly failure?: string;
}

export async function openChildPanel(
	options: OpenChildPanelOptions,
): Promise<LaunchOutcome<HostAttachment>> {
	if (options.closeOldAttachment !== undefined) {
		try {
			await options.closeOldAttachment();
			await delay(100);
		} catch (error) {
			options.diagnose?.(`could not close old attachment: ${errorMessage(error)}`);
		}
	}
	const record = options.record;
	const plan = planChildRuntime(record, "panel");
	await recordRuntimeEvidence(options.registry, record, plan);
	let attachment: HostAttachment;
	try {
		attachment = await options.host.open(plan.spec);
	} catch (error) {
		return {
			failure: `Child ${record.subagentId} could not be opened in a ${options.host.kind} panel (${errorMessage(error)}); a panel may have been created, so close it if it is still there`,
		};
	}
	const earlyExitAbort = new AbortController();
	const combinedSignal = options.signal
		? AbortSignal.any([options.signal, earlyExitAbort.signal])
		: earlyExitAbort.signal;

	let childAppeared = false;
	let earlyExitObserved: HostObservation | undefined;
	const probeInterval = setInterval(async () => {
		try {
			const obs = await attachment.observe();
			if (!obs.known) return;
			if (obs.containerGone) {
				earlyExitObserved = obs;
				earlyExitAbort.abort();
				return;
			}
			if (obs.alive) {
				childAppeared = true;
			} else if (childAppeared) {
				earlyExitObserved = obs;
				earlyExitAbort.abort();
			}
		} catch {}
	}, 200);

	let connected: boolean;
	try {
		connected = await options.waitForBridge(record.subagentId, combinedSignal);
	} catch (error) {
		options.diagnose?.(`bridge wait failed: ${errorMessage(error)}`);
		connected = false;
	} finally {
		clearInterval(probeInterval);
	}
	if (connected) {
		await bindPanel(
			options.registry,
			record.subagentId,
			options.host.kind,
			attachment.identity.attachmentId,
		);
		return { handle: attachment };
	}
	const cleanup = await attachment.cleanup();
	const observed = await attachment.observe();
	if (!(observed.known && !observed.alive)) {
		await bindPanel(
			options.registry,
			record.subagentId,
			options.host.kind,
			attachment.identity.attachmentId,
		);
		return {
			handle: attachment,
			failure: `Child ${record.subagentId} never connected to the parent bridge and its panel could not be closed (${
				cleanup.stderr || "its state could not be observed"
			}); close it manually`,
		};
	}
	await commitLease(
		options.registry,
		record.subagentId,
		{ type: "runtime-gone", outcome: "clear" },
		plan.runtimeIdentity,
	);
	const detail = earlyExitObserved?.detail ? ` (${earlyExitObserved.detail.trim()})` : "";
	return { failure: `Child ${record.subagentId} never connected to the parent bridge${detail}` };
}

export async function prepareRuntimeDirectory(
	diagnose?: (message: string) => void,
): Promise<string> {
	const directory = runtimeDirectory();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700).catch((error: unknown) => {
		diagnose?.(`could not restrict the runtime directory: ${errorMessage(error)}`);
	});
	return directory;
}

async function bindProcess(
	registry: Pick<SubagentRegistry, "get" | "update">,
	id: string,
	pid: number | undefined,
): Promise<void> {
	if (pid === undefined) return;
	await commitLease(registry, id, {
		type: "attachment-bound",
		attachment: { kind: "process", pid },
	});
}

async function bindPanel(
	registry: Pick<SubagentRegistry, "get" | "update">,
	id: string,
	host: PanelHost,
	attachmentId: string,
): Promise<void> {
	await commitLease(registry, id, {
		type: "attachment-bound",
		attachment: { kind: "panel", host, id: attachmentId },
	});
}
