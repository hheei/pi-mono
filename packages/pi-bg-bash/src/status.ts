import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ThemeLike } from "@hheei/pi-ext-core";
import type { BashJobRegistry } from "./bash-jobs.js";

export const BASH_STATUS_KEY = "pi-bg-bash";

/** Display shorthand only; commands and tools still use the full job id. */
export function formatBashId(id: string): string {
	return `#${id.replace(/^bash-/u, "")}`;
}

export function formatBashStatus(jobs: BashJobRegistry, theme?: ThemeLike): string | undefined {
	const running = jobs
		.list()
		.filter((job) => job.status === "running" || job.status === "stopping");
	if (running.length === 0) return undefined;
	const count = `x${running.length}`;
	if (!theme) return `bash ${count}`;
	return `${theme.fg("muted", "bash")} ${theme.fg("accent", count)}`;
}

export function createBashStatus(
	ui: Pick<ExtensionUIContext, "setStatus"> & { readonly theme?: ThemeLike },
	signal: AbortSignal,
): { refresh(jobs: BashJobRegistry): void; dispose(): void } {
	let disposed = false;
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		signal.removeEventListener("abort", dispose);
		ui.setStatus?.(BASH_STATUS_KEY, undefined);
	};
	if (signal.aborted) dispose();
	else signal.addEventListener("abort", dispose, { once: true });
	return {
		refresh(jobs): void {
			if (!disposed && typeof ui.setStatus === "function")
				ui.setStatus(BASH_STATUS_KEY, formatBashStatus(jobs, ui.theme));
		},
		dispose,
	};
}
