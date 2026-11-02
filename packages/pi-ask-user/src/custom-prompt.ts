import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { openTuiSurface } from "@hheei/pi-ext-core";
import { ASK_OVERLAY_MIN_WIDTH, ASK_OVERLAY_WIDTH } from "./constants";
import type { AskDisplayMode } from "./schema";

/** Report the session as blocked on the user (`herdr:blocked`) for the duration of `run`. */
export async function whileBlocked<T>(pi: ExtensionAPI, run: () => Promise<T>): Promise<T> {
	pi.events.emit("herdr:blocked", { active: true, label: "Waiting for user response" });
	try {
		return await run();
	} finally {
		pi.events.emit("herdr:blocked", { active: false });
	}
}

function overlayOptions(displayMode: AskDisplayMode): OverlayOptions | undefined {
	if (displayMode !== "overlay") return undefined;
	return {
		anchor: "center",
		width: ASK_OVERLAY_WIDTH,
		minWidth: ASK_OVERLAY_MIN_WIDTH,
		maxHeight: "85%",
		margin: 1,
	};
}

export interface CustomPromptRequest<T> {
	signal?: AbortSignal | undefined;
	timeout?: number | undefined;
	displayMode: AskDisplayMode;
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
	const { signal, timeout, displayMode, createComponent } = request;
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
		const options = overlayOptions(displayMode);
		const result = await openTuiSurface<T | null>(pi, ctx, {
			hostId: "ask-user",
			signal: local.signal,
			...(options === undefined ? {} : { overlay: true, overlayOptions: options }),
			create: ({ tui, theme, keybindings, close }) =>
				createComponent(tui, theme, keybindings, close),
		});
		return result.status === "closed" ? result.value : null;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		signal?.removeEventListener("abort", abortLocally);
	}
}
