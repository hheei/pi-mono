import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createRenderThrottle,
	type ExtensionLifecycleContext,
	getGlobalState,
	registerExtensionLifecycle,
} from "@hheei/pi-ext-core";
import { startBashDelivery } from "./bash-delivery.js";
import { BashJobRegistry } from "./bash-jobs.js";
import {
	BashExecutionLedger,
	BashLedgerLockedError,
	bashExecutionDirectory,
	bashSessionId,
} from "./bash-ledger.js";
import { type BashSettings, DEFAULT_BASH_SETTINGS, readBashSettings } from "./bash-settings.js";
import { createBashStatus } from "./status.js";

/**
 * Live session view consumed by the statically registered background Bash tools. Any object with
 * this shape is a valid reader: nothing about reading the session depends on who made the reader.
 */
export interface BackgroundBashRuntimeState {
	getSettings(): BashSettings;
	getBashJobs(): BashJobRegistry | undefined;
}

/** The session lifecycle's half of the slot, and the only writer to it. */
export interface BashRuntimeSlot {
	settings: BashSettings;
	jobs: BashJobRegistry | undefined;
}

/** One session's slot: the tools read `state`, the lifecycle writes `slot`. */
export interface BashRuntime {
	readonly state: BackgroundBashRuntimeState;
	readonly slot: BashRuntimeSlot;
}

export function createBashRuntime(): BashRuntime {
	const slot: BashRuntimeSlot = { settings: DEFAULT_BASH_SETTINGS, jobs: undefined };
	return {
		state: {
			getSettings: () => slot.settings,
			getBashJobs: () => slot.jobs,
		},
		slot,
	};
}

/**
 * Register the session-owned job registry, its ledger and delivery.
 *
 * The `bash` settings group belongs to the foreground extension, so this lifecycle only reads
 * that group; no second provider claims the same fields. Static tool registration stays caller-owned.
 */
export function registerBashLifecycle(pi: ExtensionAPI, slot: BashRuntimeSlot): void {
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-bg-bash",
		start: (context) => startLifecycle(pi, context, slot, readBashSettings()),
		// A reload replaces the extension, not the work: the live registry is handed to the start
		// that follows. Every other end leaves it to its disposers, which stop the process groups.
		end: (reason) => {
			if (reason === "reload" && live !== undefined) carriedBash.set(live.sessionId, live);
		},
	});
}

/** What one scope owns: the registry, its ledger and the session that claims it back. */
interface OwnedBash {
	readonly sessionId: string;
	readonly ledger: BashExecutionLedger;
	readonly jobs: BashJobRegistry;
}

/**
 * The current scope's registry. A reload evaluates this module again, so anything that has to
 * outlive the module instance lives in `carriedBash`; this pointer only bridges start to end.
 */
let live: OwnedBash | undefined;

/**
 * Registries waiting for the start that follows a reload, in process-global state because a reload
 * replaces this module. A child is a real process group whose output is still being collected, so the
 * next start claims the same registry instead of reconstructing one from the ledger.
 */
const carriedBash = getGlobalState<Map<string, OwnedBash>>("bg-bash-carried", () => new Map());

function startLifecycle(
	pi: ExtensionAPI,
	context: ExtensionLifecycleContext,
	slot: BashRuntimeSlot,
	settings: BashSettings,
): void {
	slot.settings = settings;
	const sessionId = bashSessionId(context.extension);
	const owned = carriedBash.get(sessionId) ?? openRegistry(context, sessionId, settings);
	carriedBash.delete(sessionId);
	if (owned === undefined) return;
	const { ledger, jobs } = owned;
	live = owned;
	slot.jobs = jobs;
	let stopDelivery = (): void => {};
	const status = createBashStatus(context.extension.ui, context.signal);
	// Terminal events and tool results both move the footer, and a command that exits while another
	// is still streaming used to repaint the footer per event. The footer follows the shared
	// streaming window; the first change still paints immediately and the last state is never lost.
	const repaintStatus = createRenderThrottle(() => {
		status.refresh(jobs);
	});
	const refreshStatus = (): void => repaintStatus.request();
	context.resources.add("bash-jobs", async () => {
		stopDelivery();
		repaintStatus.dispose();
		status.dispose();
		if (slot.jobs === jobs) slot.jobs = undefined;
		live = undefined;
		// A reload already handed this registry to the next start, so nothing is stopped here.
		if (carriedBash.get(sessionId) === owned) return;
		try {
			await jobs.dispose();
		} finally {
			ledger.close();
		}
	});
	const unsubscribeTerminal = jobs.onTerminal(refreshStatus);
	context.resources.add("bash-status", unsubscribeTerminal);
	context.resources.add("bash-status-tools", pi.on("tool_result", refreshStatus));
	refreshStatus();
	stopDelivery = startBashDelivery({
		pi,
		jobs,
		session: context.extension,
		signal: context.signal,
		notify: (message, level) => context.extension.ui.notify(message, level),
	});
}

/** One session's ledger and registry, or nothing when another instance is recording the session. */
function openRegistry(
	context: ExtensionLifecycleContext,
	sessionId: string,
	settings: BashSettings,
): OwnedBash | undefined {
	let ledger: BashExecutionLedger;
	try {
		ledger = new BashExecutionLedger(
			join(bashExecutionDirectory(context.extension), "bash.sqlite"),
		);
	} catch (error) {
		if (!(error instanceof BashLedgerLockedError)) throw error;
		// One session file can be mounted twice, and Background Bash is the writer: the second mount
		// stays a viewer instead of failing the extension. Its tools already report unavailability
		// when no registry exists, and a fork or a new session gets its own ledger directory.
		context.extension.ui.notify(
			"Background Bash unavailable: another Pi instance is recording this session. Fork or start a new session to run it here.",
			"info",
		);
		return undefined;
	}
	try {
		const jobs = new BashJobRegistry(settings.bashOutputTailKiB * 1024, {
			ledger,
			onError: (message) => context.extension.ui.notify(message, "warning"),
		});
		return { sessionId, ledger, jobs };
	} catch (error) {
		ledger.close();
		throw error;
	}
}
