import type { PanelHost, SubagentRecord } from "./domain.js";
import { type SubagentRegistry, SubagentRegistryError } from "./registry.js";
import { openStateDb, readMeta, writeMeta } from "./state-db.js";

/**
 * Durable ownership of one parent session's children. Callers learn three operations. The parent
 * and child lifecycle matrices stay behind them.
 *
 * `commit` is the only write: intent, a runtime, or its removal. `roster` is this session's ledger.
 * `ready` is the barrier before a model turn: it rebinds surfaces that are still there and
 * reopens only the panels a new host generation took down. Cancel is not an operation.
 */
export const RUNTIME_ENDED_RESUME =
	"The child runtime ended while a turn was in flight; the session is unchanged and a send resumes it";

export const PARENT_EXIT_NOTE =
	"The child runtime ended with the parent process; a later send starts it again from the same session";

/** How a removed runtime is recorded. `clear` only drops it. `drop` is a gone writer. */
export type RuntimeGoneOutcome = "clear" | "drop" | "parent-exit" | "finished";

export const LEASE_EDGES = [
	"spawn-intent",
	"runtime-bound",
	"attachment-bound",
	"stop-intent",
	"runtime-gone",
	"left-session",
] as const;

export type LeaseEdge =
	| { readonly type: "spawn-intent" }
	| { readonly type: "runtime-bound"; readonly runtimeIdentity: string; readonly endpoint: string }
	| {
			readonly type: "attachment-bound";
			readonly attachment: NonNullable<NonNullable<SubagentRecord["runtime"]>["attachment"]>;
	  }
	| { readonly type: "stop-intent" }
	| { readonly type: "runtime-gone"; readonly outcome?: RuntimeGoneOutcome }
	| { readonly type: "left-session" };

export type HostList =
	| { readonly known: false }
	| { readonly known: true; readonly generation: string; readonly present: ReadonlySet<string> };

export interface HostDirectory {
	readonly host: PanelHost;
	list(): Promise<HostList>;
	/** Opens the same child session in a new panel. Does not write the lease. */
	open(record: SubagentRecord): Promise<{ readonly id: string } | { readonly failure: string }>;
	/** True when a human Pi already has this child session open. Those children are not rehydrated. */
	occupied?(record: SubagentRecord): boolean;
}

export interface ProcessDirectory {
	alive(pid: number): boolean;
}

export type LeaseReady =
	| {
			readonly ok: true;
			readonly rebound: readonly string[];
			readonly rehydrated: readonly string[];
			readonly stopped: readonly string[];
			/** Owned children this provider could not confirm stopped; their claim is kept. */
			readonly ownedFailures?: readonly string[];
	  }
	| { readonly ok: false; readonly reason: "unknown" };

export interface ConversationLease {
	commit(id: string, edge: LeaseEdge): Promise<SubagentRecord>;
	roster(): Promise<readonly SubagentRecord[]>;
	/** `skip` names children a provider incarnation must not reopen or adopt as ordinary ones. */
	ready(skip?: ReadonlySet<string>): Promise<LeaseReady>;
}

type RegistryStore = Pick<SubagentRegistry, "get" | "list" | "update" | "path">;

export function createConversationLease(options: {
	readonly registry: RegistryStore;
	readonly hosts: HostDirectory;
	readonly processes: ProcessDirectory;
}): ConversationLease {
	const { registry, hosts, processes } = options;
	return {
		commit(id, edge) {
			return commitLease(registry, id, edge);
		},
		roster() {
			return registry.list();
		},
		ready(skip) {
			return reconcile(registry, hosts, processes, skip);
		},
	};
}

export async function commitLease(
	registry: Pick<SubagentRegistry, "get" | "update">,
	id: string,
	edge: LeaseEdge,
	expectedRuntimeIdentity?: string,
): Promise<SubagentRecord> {
	const current = await registry.get(id);
	if (current === undefined) {
		throw new SubagentRegistryError("unknown_child", `Unknown child ${id}`);
	}
	const next = applyLeaseEdge(current, edge);
	if (next === undefined) return current;
	return registry.update(id, () => next, expectedRuntimeIdentity);
}

/** `undefined` means the edge changes nothing, so the caller must not write. */
export function applyLeaseEdge(
	record: SubagentRecord,
	edge: LeaseEdge,
): SubagentRecord | undefined {
	switch (edge.type) {
		case "spawn-intent":
			return record.intent === "active" ? undefined : { ...record, intent: "active" };
		case "attachment-bound": {
			if (record.runtime?.attachment !== undefined) return undefined;
			if (record.runtime === undefined) {
				throw new Error(`Child ${record.subagentId} has no runtime to attach`);
			}
			return {
				...record,
				runtime: { ...record.runtime, attachment: edge.attachment },
			};
		}
		case "runtime-bound": {
			if (
				record.runtime?.runtimeIdentity === edge.runtimeIdentity &&
				record.runtime.endpoint === edge.endpoint &&
				record.runtime.attachment === undefined
			) {
				return undefined;
			}
			return {
				...record,
				runtime: { runtimeIdentity: edge.runtimeIdentity, endpoint: edge.endpoint },
			};
		}
		case "stop-intent":
			return record.intent === "stopped" ? undefined : { ...record, intent: "stopped" };
		case "runtime-gone":
			return applyRuntimeGone(record, edge.outcome ?? "clear");
		case "left-session":
			if (record.runtime === undefined && record.state === "done") return undefined;
			return {
				...omitRuntime(record),
				state: "done",
				interrupted:
					"The child left its session; the surface is no longer controlled by the parent",
			};
		default: {
			const unreachable: never = edge;
			return unreachable;
		}
	}
}

function applyRuntimeGone(
	record: SubagentRecord,
	outcome: RuntimeGoneOutcome,
): SubagentRecord | undefined {
	if (outcome === "clear") {
		if (record.runtime === undefined) return undefined;
		return omitRuntime(record);
	}
	if (outcome === "drop") {
		if (record.intent === "stopped") {
			if (record.runtime === undefined) return undefined;
			return omitRuntime(record);
		}
		if (record.runtime === undefined && record.state !== "running") return undefined;
		const rest = omitRuntime(record);
		if (record.state !== "running") return rest;
		return { ...rest, state: "blocked", interrupted: RUNTIME_ENDED_RESUME };
	}
	if (outcome === "parent-exit") {
		if (record.runtime === undefined) {
			if (record.intent === "stopped" || record.state !== "running") return undefined;
			return { ...record, state: "done", interrupted: PARENT_EXIT_NOTE };
		}
		const rest = omitRuntime(record);
		return {
			...rest,
			...(record.state === "running" ? { state: "done" as const } : {}),
			interrupted: PARENT_EXIT_NOTE,
		};
	}
	if (record.runtime === undefined && record.state === "done") return undefined;
	const rest = record.runtime === undefined ? record : omitRuntime(record);
	return { ...rest, state: "done" };
}

async function reconcile(
	registry: RegistryStore,
	hosts: HostDirectory,
	processes: ProcessDirectory,
	skip?: ReadonlySet<string>,
): Promise<LeaseReady> {
	const list = await hosts.list();
	if (!list.known) return { ok: false, reason: "unknown" };
	const all = await registry.list();
	const records = skip === undefined ? all : all.filter((record) => !skip.has(record.subagentId));
	const parentSessionId = all[0]?.parentSessionId;
	const stored =
		parentSessionId === undefined
			? undefined
			: await readHostGeneration(registry.path, parentSessionId);
	const rebound: string[] = [];
	const rehydrated: string[] = [];
	const stopped: string[] = [];
	let held = false;
	const panels = records.flatMap((record) => {
		const id = panelId(record);
		return id === undefined ? [] : [{ record, id }];
	});
	const present = panels.filter((item) => list.present.has(item.id));
	const missing = panels.filter((item) => !list.present.has(item.id));
	for (const item of present) rebound.push(item.record.subagentId);
	const generationChanged = stored !== undefined && stored !== list.generation;
	const reopen =
		generationChanged || (stored === undefined && present.length === 0 && missing.length > 0);
	if (reopen) {
		for (const item of missing) {
			if (item.record.intent !== "active") continue;
			if (hosts.occupied?.(item.record) === true) {
				held = true;
				continue;
			}
			const opened = await hosts.open(item.record);
			if ("failure" in opened) continue;
			await commitLease(registry, item.record.subagentId, {
				type: "attachment-bound",
				attachment: { kind: "panel", host: hosts.host, id: opened.id },
			});
			rehydrated.push(item.record.subagentId);
		}
	} else {
		for (const item of missing) {
			if (item.record.intent === "active") {
				await commitLease(registry, item.record.subagentId, { type: "stop-intent" });
				stopped.push(item.record.subagentId);
			}
			await releaseRuntime(registry, item.record, { type: "runtime-gone" });
		}
	}
	for (const record of records) {
		const attachment = record.runtime?.attachment;
		if (attachment?.kind !== "process") continue;
		// A dead pid is a liveness answer, and liveness is read from the lock, never written back.
		// An alive one still has to be re-watched after a reload.
		if (processes.alive(attachment.pid)) rebound.push(record.subagentId);
	}
	if (!held && parentSessionId !== undefined && stored !== list.generation)
		await writeHostGeneration(registry.path, parentSessionId, list.generation);
	return { ok: true, rebound, rehydrated, stopped };
}

function panelId(record: SubagentRecord): string | undefined {
	const attachment = record.runtime?.attachment;
	return attachment?.kind === "panel" ? attachment.id : undefined;
}

async function releaseRuntime(
	registry: RegistryStore,
	record: SubagentRecord,
	edge: LeaseEdge,
): Promise<void> {
	await commitLease(registry, record.subagentId, edge);
}

function omitRuntime(record: SubagentRecord): SubagentRecord {
	const { runtime: _runtime, ...rest } = record;
	return rest;
}

export function readHostGeneration(
	filePath: string,
	parentSessionId: string,
): Promise<string | undefined> {
	const value = readMeta(openStateDb(filePath), parentSessionId, "hostGeneration");
	return Promise.resolve(value === "" ? undefined : value);
}

export function writeHostGeneration(
	filePath: string,
	parentSessionId: string,
	generation: string,
): Promise<void> {
	const db = openStateDb(filePath);
	const current = readMeta(db, parentSessionId, "hostGeneration");
	if (current === generation) return Promise.resolve();
	writeMeta(db, parentSessionId, "hostGeneration", generation);
	return Promise.resolve();
}
