import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { createDisposerRegistry, type DisposerRegistry } from "./disposer-registry.js";

/**
 * One session-scoped owner view. The signal is aborted before resource cleanup;
 * consumers must treat it as the authority for cancelling async work created from
 * this context rather than retaining the Pi context after shutdown or reload.
 */
export interface ExtensionLifecycleContext {
	readonly pi: ExtensionAPI;
	readonly extension: ExtensionContext;
	readonly signal: AbortSignal;
	readonly resources: DisposerRegistry;
}

export interface ExtensionLifecycleOptions {
	/** Stable extension package name used in validation and diagnostics. */
	readonly key: string;
	/** Creates session-owned resources. Failure triggers registered cleanup. */
	readonly start: (context: ExtensionLifecycleContext) => void | Promise<void>;
	/**
	 * Called with the reason the scope ended, before its signal aborts and its resources are
	 * disposed. A scope that keeps something alive past the end reports that here, so its disposers
	 * can hand it over instead of stopping it.
	 */
	readonly end?: (reason: SessionShutdownEvent["reason"] | undefined) => void | Promise<void>;
}

/** Registers one session-scoped lifecycle owner for an extension package. */
export function registerExtensionLifecycle(
	pi: ExtensionAPI,
	options: ExtensionLifecycleOptions,
): void {
	if (!options.key.trim()) throw new Error("Extension lifecycle key must not be empty");
	const controller = createLifecycleController(pi, options);
	pi.on("session_start", async (_event, context) => {
		await controller.start(context);
	});
	pi.on("session_shutdown", async (event) => {
		await controller.shutdown(event.reason);
	});
}

interface ActiveLifecycle {
	readonly controller: AbortController;
	readonly resources: DisposerRegistry;
}

function createLifecycleController(
	pi: ExtensionAPI,
	options: ExtensionLifecycleOptions,
): {
	start(context: ExtensionContext): Promise<void>;
	shutdown(reason: SessionShutdownEvent["reason"] | undefined): Promise<void>;
} {
	let active: ActiveLifecycle | undefined;
	let transition = Promise.resolve();

	// Pi awaits lifecycle handlers serially, so start/shutdown must share one
	// queue. This also prevents an old shutdown from closing a newly started scope.
	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = transition.then(operation);
		transition = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	const shutdownUnlocked = async (
		reason: SessionShutdownEvent["reason"] | undefined,
	): Promise<void> => {
		const current = active;
		if (current === undefined) return;
		active = undefined;
		const failures: Array<{ readonly id: string; readonly error: unknown }> = [];
		if (options.end !== undefined) {
			try {
				await options.end(reason);
			} catch (error) {
				failures.push({ id: "scope.end", error });
			}
		}
		current.controller.abort();
		failures.push(...(await current.resources.cleanup()));
		if (failures.length > 0) {
			throw new AggregateError(
				failures.map((failure) => failure.error),
				`Extension lifecycle cleanup failed: ${failures.map((failure) => failure.id).join(", ")}`,
			);
		}
	};

	return {
		start(context: ExtensionContext): Promise<void> {
			return enqueue(async () => {
				if (active !== undefined) await shutdownUnlocked(undefined);
				const controller = new AbortController();
				const resources = createDisposerRegistry();
				active = { controller, resources };
				try {
					await options.start({
						pi,
						extension: context,
						signal: controller.signal,
						resources,
					});
				} catch (error) {
					active = undefined;
					controller.abort();
					const failures = await resources.cleanup();
					if (failures.length > 0) {
						throw new AggregateError(
							[error, ...failures.map((failure) => failure.error)],
							`Extension lifecycle start failed: ${failures.map((failure) => failure.id).join(", ")}`,
							{ cause: error },
						);
					}
					throw error;
				}
			});
		},
		shutdown: (reason): Promise<void> => enqueue(() => shutdownUnlocked(reason)),
	};
}
