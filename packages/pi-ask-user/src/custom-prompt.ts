import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { openTuiSurface } from "@hheei/pi-ext-core";

export interface CustomPromptRequest<T> {
	signal?: AbortSignal | undefined;
	timeout?: number | undefined;
	/** Absent when the host's own dialog answers the prompt, e.g. a question without options. */
	createComponent?: (
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		complete: (value: T | null) => void,
	) => Component;
	/** Non-TUI hosts (RPC, print) answer through dialogs instead of a custom surface. */
	fallback: (signal: AbortSignal, deadline: number | undefined) => Promise<T | null>;
}

/**
 * Runs one prompt and owns everything around it: the surface slot, the abort
 * forwarding, and the timeout. `null` means the user cancelled, the deadline
 * passed, or the host has no custom UI.
 */
export async function runCustomPrompt<T>(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: CustomPromptRequest<T>,
): Promise<T | null> {
	const { signal, timeout, createComponent } = request;
	const deadline = timeout && timeout > 0 ? Date.now() + timeout : undefined;
	const local = new AbortController();
	const abortLocally = () => local.abort(signal?.reason);
	if (signal?.aborted) return null;
	signal?.addEventListener("abort", abortLocally, { once: true });
	const timer = deadline === undefined ? undefined : setTimeout(abortLocally, timeout);
	try {
		if (ctx.mode !== "tui" || createComponent === undefined) {
			return await request.fallback(local.signal, deadline);
		}
		const result = await openTuiSurface<T | null>(pi, ctx, {
			hostId: "ask-user",
			signal: local.signal,
			blocked: { kind: "question", message: "Waiting for user response" },
			create: ({ tui, theme, keybindings, close }) =>
				createComponent(tui, theme, keybindings, close),
		});
		return result.status === "closed" ? result.value : null;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		signal?.removeEventListener("abort", abortLocally);
	}
}
