import { truncateWithSpill } from "@hheei/pi-ext-core";
import type { PublicSubagent, SubagentState } from "./domain.js";
import { type Receipt, type ReceiptStatus, receiptCarriesOutput } from "./receipts.js";

/** What the agent's runtime is doing now, kept apart from the selected delegation's status. */
export interface DelegationProgress {
	readonly runtimeState: SubagentState;
	readonly summary?: string;
	readonly activeTool?: string;
	readonly path?: string;
}

/** Why a delegation did not produce a result, with what it may already have done. */
export interface DelegationError {
	readonly reason: string;
	readonly safeToRetry: boolean;
	readonly sideEffects: readonly string[];
}

/**
 * Public identity of one delegation: the agent session id plus its monotonic revision. Internal
 * database keys never appear here, so both consumers speak the same vocabulary.
 */
export interface DelegationView {
	readonly id: string;
	readonly revision: number;
	readonly status: ReceiptStatus;
	readonly task: string;
	readonly hasOutput: boolean;
	readonly agent?: string;
	readonly cwd?: string;
	readonly sessionPath?: string;
	readonly path?: string;
	readonly resultText?: string;
	readonly progress?: DelegationProgress;
	readonly error?: DelegationError;
}

/**
 * Projects one stored delegation. A result only exists for a completed or blocked delegation: the
 * text of a failed or uncertain one is the reason it failed, not child output.
 */
export function delegationView(
	receipt: Receipt,
	child?: PublicSubagent,
	options?: { readonly includeOutput?: boolean },
): DelegationView {
	if (receipt.childId === undefined || receipt.revision === undefined) {
		throw new Error("Delegation has no public identity");
	}
	const text = receipt.resultText;
	const hasOutput = receiptCarriesOutput(receipt.status, text);
	const failed = text !== undefined && !hasOutput;
	return {
		id: receipt.childId,
		revision: receipt.revision,
		status: receipt.status,
		task: receipt.task,
		hasOutput,
		...(options?.includeOutput === true && text !== undefined && hasOutput
			? { resultText: text }
			: {}),
		...(failed && text !== undefined
			? {
					error: {
						reason: text,
						safeToRetry: receipt.safeToRetry ?? false,
						sideEffects: receipt.sideEffects ?? [],
					},
				}
			: {}),
		...(child === undefined
			? {}
			: {
					agent: child.agent,
					cwd: child.cwd,
					...(child.path === undefined ? {} : { sessionPath: child.path, path: child.path }),
					progress: {
						runtimeState: child.state,
						...(child.path === undefined ? {} : { path: child.path }),
						...(child.summary === undefined ? {} : { summary: child.summary }),
						...(child.activeTool === undefined ? {} : { activeTool: child.activeTool }),
					},
				}),
	};
}

/**
 * The same projection with the result body when the caller asks for it. An explicit read still
 * obeys the shared output budget: the model gets the head, the tail, and the path to everything it
 * did not see, never an unbounded body.
 */
export async function agentView(
	receipt: Receipt,
	child?: PublicSubagent,
	options?: { readonly includeOutput?: boolean },
): Promise<DelegationView> {
	const view = delegationView(receipt, child);
	const text = receipt.resultText;
	if (options?.includeOutput !== true || !view.hasOutput || text === undefined) return view;
	const bounded = await truncateWithSpill(text, "subagent-output");
	return { ...view, resultText: bounded.text };
}

/** One agent's row in a dashboard: its runtime now, and the status of its latest delegation. */
export interface AgentSummary {
	readonly id: string;
	readonly agent?: string;
	readonly runtimeState: SubagentState;
	readonly revision: number;
	readonly status: ReceiptStatus;
	readonly hasOutput: boolean;
	readonly summary?: string;
}

export interface DashboardView {
	readonly total: number;
	readonly running: number;
	readonly blocked: number;
	readonly completed: number;
	readonly failed: number;
	readonly children: readonly AgentSummary[];
}

/** One stored delegation as history shows it: identity, status and task, never the body. */
export interface DelegationHistoryEntry {
	readonly id: string;
	readonly revision: number;
	readonly status: ReceiptStatus;
	readonly task: string;
	readonly hasOutput: boolean;
	readonly createdAt: number;
}

export function historyEntry(receipt: Receipt): DelegationHistoryEntry | undefined {
	const id = receipt.childId;
	const revision = receipt.revision;
	if (id === undefined || revision === undefined) return undefined;
	return {
		id,
		revision,
		status: receipt.status,
		task: receipt.task,
		hasOutput: receiptCarriesOutput(receipt.status, receipt.resultText),
		createdAt: receipt.createdAt,
	};
}
