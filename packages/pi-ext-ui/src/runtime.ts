import { NestedCallArgsIndex, ToolExecutionTracker } from "./tracker.js";

/** Bounded like the capture table: only rows the session can still repaint are worth keeping. */
const MAX_LIVE_ROWS = 200;

/**
 * The mutable state one extension runtime owns: nested-call captures, the session-branch argument
 * index, and the tool background preference. Two Pi runtimes in one process never share it, so a
 * restart, cleanup or settings change in one cannot reach the other.
 */
export class ToolUiRuntime {
	readonly tracker = new ToolExecutionTracker();
	readonly nestedCalls = new NestedCallArgsIndex();
	/** A container row's own invalidator, so a live nested call can repaint the row that made it. */
	readonly #invalidators = new Map<string, () => void>();
	/** Pi-native per-tool backgrounds are opt-in; the default is the quiet transparent row. */
	backgrounds = false;

	rememberRow(toolCallId: string, invalidate: () => void): void {
		if (!this.#invalidators.has(toolCallId) && this.#invalidators.size >= MAX_LIVE_ROWS) {
			const oldest = this.#invalidators.keys().next().value;
			if (oldest !== undefined) this.#invalidators.delete(oldest);
		}
		this.#invalidators.set(toolCallId, invalidate);
	}

	/** The host rebuilds the row from fresh facts, so its child board shows the call that started. */
	repaintParent(parentToolCallId: string | undefined): void {
		if (parentToolCallId === undefined) return;
		this.#invalidators.get(parentToolCallId)?.();
	}

	forgetRow(toolCallId: string): void {
		this.#invalidators.delete(toolCallId);
	}

	clear(): void {
		this.tracker.clear();
		this.nestedCalls.setSource(undefined);
		this.#invalidators.clear();
	}
}
