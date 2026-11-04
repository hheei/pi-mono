import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ThemeLike } from "@hheei/pi-ext-core";
import { type PublicSubagent, toVisualSubagentState } from "./domain.js";

export const SUBAGENT_STATUS_KEY = "pi-subagents";

/** Display shorthand only; commands and tools still use the full child id. */
export function formatSubagentId(id: string): string {
	return `#${id.replace(/^agent-/u, "")}`;
}

export function formatSubagentStatus(
	children: readonly PublicSubagent[],
	theme?: ThemeLike,
): string | undefined {
	const running = children.filter(
		(child) => toVisualSubagentState(child.state, child.interrupted) === "running",
	);
	if (running.length === 0) return undefined;
	const count = `x${running.length}`;
	if (!theme) return `agents ${count}`;
	return `${theme.fg("dim", "agents")} ${theme.fg("accent", count)}`;
}

/** Native status transport; no widget, timers or dependency on pi-status. */
export function createSubagentStatus(
	ui: Pick<ExtensionUIContext, "setStatus"> & { readonly theme: ThemeLike },
	signal: AbortSignal,
): { refresh(children: readonly PublicSubagent[]): void; dispose(): void } {
	let disposed = false;
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		signal.removeEventListener("abort", dispose);
		ui.setStatus(SUBAGENT_STATUS_KEY, undefined);
	};
	if (signal.aborted) dispose();
	else signal.addEventListener("abort", dispose, { once: true });
	return {
		refresh(children): void {
			if (!disposed) ui.setStatus(SUBAGENT_STATUS_KEY, formatSubagentStatus(children, ui.theme));
		},
		dispose,
	};
}
