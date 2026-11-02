import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type {
	Component,
	OverlayHandle,
	OverlayOptions,
	ProgramStatus,
	TUI,
} from "@earendil-works/pi-tui";
import { getGlobalState } from "./global-state.js";
import { runtimeIdentity } from "./runtime-identity.js";

type SurfaceComponent = Component & { dispose?(): void };

/** Result resolved by the surface owner when its component closes or is aborted. */
export type TuiSurfaceResult<T> =
	| { readonly status: "closed"; readonly value: T }
	| { readonly status: "aborted" };

/** Context given to a surface only after it owns Pi's custom-UI slot. */
export interface TuiSurfaceContext<T> {
	readonly tui: TUI;
	readonly theme: Theme;
	readonly keybindings: KeybindingsManager;
	readonly signal: AbortSignal;
	requestRender(): void;
	/** Temporarily yields an overlay's focus slot while a Pi-owned UI operation runs. */
	withHiddenOverlay<R>(operation: () => Promise<R>): Promise<R>;
	/** Resolves the caller's promise as `closed`; the host then disposes the component. */
	close(value: T): void;
}

/**
 * Opens one extension-owned custom surface through the runtime-wide arbiter.
 *
 * The caller owns visible content, result handling, and non-TUI fallback.
 * Only one surface may be active at a time; concurrent requests reject with
 * `TuiSurfaceBusyError`.
 */
export interface OpenTuiSurfaceOptions<T> {
	readonly hostId: string;
	readonly signal: AbortSignal;
	readonly overlay?: boolean;
	readonly overlayOptions?: OverlayOptions | (() => OverlayOptions);
	readonly onHandle?: (handle: OverlayHandle) => void;
	/** What the user is expected to provide. The host reports it for inline surfaces only. */
	readonly blocked?: {
		readonly kind: NonNullable<ProgramStatus["kind"]>;
		readonly message: string;
	};
	/**
	 * Runs once after host settlement and hidden operations finish, before the
	 * arbiter releases this surface slot. A failure rejects the returned Promise.
	 */
	readonly beforeRelease?: () => void | Promise<void>;
	create(context: TuiSurfaceContext<T>): SurfaceComponent | Promise<SurfaceComponent>;
}

/** Thrown when attempting to open a surface while another surface is currently active. */
export class TuiSurfaceBusyError extends Error {
	constructor() {
		super("A TUI surface is already active");
		this.name = "TuiSurfaceBusyError";
	}
}

function abortError(reason: unknown): Error {
	if (reason instanceof Error && reason.name === "AbortError") return reason;
	const error = new Error(reason instanceof Error ? reason.message : "TUI surface request aborted");
	error.name = "AbortError";
	return error;
}

interface SurfaceRequest {
	readonly hostId: string;
	abort(reason: unknown): void;
}

interface SurfaceState {
	active?: SurfaceRequest;
}

function surfaceState(pi: ExtensionAPI): SurfaceState {
	const states = getGlobalState(
		"tui-surface-states",
		(): WeakMap<object, SurfaceState> => new WeakMap(),
	);
	const identity = runtimeIdentity(pi);
	const existing = states.get(identity);
	if (existing !== undefined) return existing;
	const created: SurfaceState = {};
	states.set(identity, created);
	return created;
}

/**
 * Serializes `ctx.ui.custom()` calls for one Pi runtime. Core owns only the
 * focus slot and cleanup: content, policy, and result interpretation remain
 * with the invoking extension. A caller must not retain its component after
 * this Promise settles because Pi disposes custom components when they close.
 */
export function openTuiSurface<T>(
	pi: ExtensionAPI,
	command: ExtensionContext,
	options: OpenTuiSurfaceOptions<T>,
): Promise<TuiSurfaceResult<T>> {
	if (!options.hostId.trim()) throw new Error("TUI surface hostId must not be empty");
	if (command.mode !== "tui") throw new Error("TUI surface requires TUI mode");
	if (options.signal.aborted) return Promise.reject(abortError(options.signal.reason));

	const state = surfaceState(pi);
	if (state.active !== undefined) {
		return Promise.reject(new TuiSurfaceBusyError());
	}

	return new Promise<TuiSurfaceResult<T>>((resolve, reject) => {
		let settled = false;
		let live = false;
		let hostSettled = false;
		let overlayHandle: OverlayHandle | undefined;
		let hiddenOperationCompletion: Promise<void> | undefined;
		let deferredCompletion: (() => void) | undefined;
		let complete: ((result: TuiSurfaceResult<T>) => void) | undefined;

		const request: SurfaceRequest = {
			hostId: options.hostId,
			abort: (_reason) => {
				if (settled) return;
				complete?.({ status: "aborted" });
			},
		};

		state.active = request;

		const onAbort = (): void => request.abort(options.signal.reason);
		options.signal.addEventListener("abort", onAbort, { once: true });

		void command.ui
			.custom<TuiSurfaceResult<T>>(
				(tui, theme, keybindings, done) => {
					live = true;
					const close = (result: TuiSurfaceResult<T>): void => {
						if (settled) return;
						settled = true;
						live = false;
						const finish = (): void => {
							if (!hostSettled) done(result);
						};
						if (hiddenOperationCompletion === undefined) finish();
						else deferredCompletion = finish;
					};
					complete = close;
					if (options.signal.aborted) {
						close({ status: "aborted" });
						return { render: () => [], invalidate: () => undefined };
					}
					return options.create({
						tui,
						theme,
						keybindings,
						signal: options.signal,
						requestRender: () => tui.requestRender(),
						withHiddenOverlay: async <R>(operation: () => Promise<R>): Promise<R> => {
							if (options.overlay !== true)
								throw new Error("Hidden overlay operations require an overlay surface");
							if (!live || options.signal.aborted) throw abortError(options.signal.reason);
							const handle = overlayHandle;
							if (handle === undefined) throw new Error("Overlay handle is not mounted");
							if (hiddenOperationCompletion !== undefined)
								throw new Error("Hidden overlay operation is already in progress");
							let finishHiddenOperation: (() => void) | undefined;
							hiddenOperationCompletion = new Promise<void>((resolve) => {
								finishHiddenOperation = resolve;
							});
							let hidden = false;
							try {
								handle.setHidden(true);
								hidden = true;
								const value = await operation();
								if (!live || options.signal.aborted || overlayHandle !== handle)
									throw abortError(options.signal.reason);
								return value;
							} catch (error: unknown) {
								if (!live || options.signal.aborted || overlayHandle !== handle)
									throw abortError(options.signal.reason);
								throw error;
							} finally {
								try {
									if (hidden && live && !options.signal.aborted && overlayHandle === handle)
										handle.setHidden(false);
								} finally {
									hiddenOperationCompletion = undefined;
									finishHiddenOperation?.();
									const finish = deferredCompletion;
									deferredCompletion = undefined;
									finish?.();
								}
							}
						},
						close: (value) => close({ status: "closed", value }),
					});
				},
				{
					...(options.overlay === true ? { overlay: true } : {}),
					...(options.overlayOptions === undefined
						? {}
						: { overlayOptions: options.overlayOptions }),
					...(options.blocked === undefined ? {} : { blocked: options.blocked }),
					...(options.overlay === true || options.onHandle !== undefined
						? {
								onHandle: (handle: OverlayHandle): void => {
									overlayHandle = handle;
									options.onHandle?.(handle);
								},
							}
						: {}),
				},
			)
			.then(
				(result) => ({ status: "fulfilled" as const, result }),
				(error: unknown) => ({ status: "rejected" as const, error }),
			)
			.then(async (outcome) => {
				hostSettled = true;
				settled = true;
				live = false;
				deferredCompletion = undefined;
				const completion = hiddenOperationCompletion;
				if (completion !== undefined) await completion;

				let releaseFailure: { readonly error: unknown } | undefined;
				try {
					await options.beforeRelease?.();
				} catch (error: unknown) {
					releaseFailure = { error };
				}
				if (outcome.status === "rejected" && releaseFailure !== undefined)
					throw new AggregateError(
						[outcome.error, releaseFailure.error],
						"TUI surface host and before-release hook both failed",
					);
				if (outcome.status === "rejected") throw outcome.error;
				if (releaseFailure !== undefined) throw releaseFailure.error;
				return outcome.result;
			})
			.then(resolve, reject)
			.finally(() => {
				live = false;
				overlayHandle = undefined;
				options.signal.removeEventListener("abort", onAbort);
				if (state.active === request) delete state.active;
			});
	});
}
