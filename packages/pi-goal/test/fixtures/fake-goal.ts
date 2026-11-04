import type {
	AgentBeforeSettleEvent,
	BeforeAgentStartEvent,
	ExtensionToolContext,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import type {
	OwnedChildHandle,
	OwnedChildSettlement,
	OwnedChildStatus,
	OwnedScope,
	OwnedScopeClose,
	SubagentOwnershipService,
} from "@hheei/pi-subagents/ownership";
import type { GoalDelivery, GoalHost } from "../../src/controller.js";
import { GOAL_ENTRY_TYPE, type GoalDocument } from "../../src/document.js";
import { DEFAULT_GOAL_SETTINGS, type GoalSettings } from "../../src/settings.js";

function asBranch(goals: readonly GoalDocument[]): readonly unknown[] {
	return goals.map((data) => ({ type: "custom", customType: GOAL_ENTRY_TYPE, data }));
}

export interface RecordedNotice {
	readonly message: string;
	readonly level: "info" | "warning" | "error";
}

export interface RecordedGoalHost {
	readonly host: GoalHost;
	/** The goal entries the host appended; the fake branch is exactly this list. */
	readonly appended: GoalDocument[];
	readonly notices: RecordedNotice[];
	readonly delivered: GoalDelivery[];
	/** Extra branch entries a test appends directly, e.g. a committed boundary message. */
	readonly extraEntries: unknown[];
	readonly state: { toolActive: boolean; aborts: number; durable: boolean };
	setSettings(settings: GoalSettings): void;
}

export function createGoalHost(
	options: {
		readonly settings?: Partial<GoalSettings>;
		readonly ownership?: SubagentOwnershipService;
		readonly failAppend?: (goal: GoalDocument) => boolean;
		readonly durable?: boolean;
		readonly branchEntries?: () => readonly unknown[];
	} = {},
): RecordedGoalHost {
	const appended: GoalDocument[] = [];
	const notices: RecordedNotice[] = [];
	const delivered: GoalDelivery[] = [];
	const extraEntries: unknown[] = [];
	const state = { toolActive: false, aborts: 0, durable: options.durable ?? true };
	let settings: GoalSettings = { ...DEFAULT_GOAL_SETTINGS, ...options.settings };
	const host: GoalHost = {
		sessionId: "session-1",
		settings: () => settings,
		append(goal) {
			if (options.failAppend?.(goal) === true) throw new Error("disk full");
			appended.push(goal);
		},
		branch: () => options.branchEntries?.() ?? [...asBranch(appended), ...extraEntries],
		durable: () => state.durable,
		notify(message, level) {
			notices.push({ message, level });
		},
		deliver(delivery) {
			delivered.push(delivery);
		},
		setGoalToolActive(active) {
			state.toolActive = active;
		},
		ownership: () => options.ownership,
		abort() {
			state.aborts += 1;
		},
		now: () => new Date("2026-01-01T00:00:00.000Z"),
	};
	return {
		host,
		appended,
		notices,
		delivered,
		extraEntries,
		state,
		setSettings(next) {
			settings = next;
		},
	};
}

interface FakeChild {
	readonly settlement: Promise<OwnedChildSettlement>;
	resolve(settlement: OwnedChildSettlement): void;
}

export interface RecordedDelegation {
	readonly agent: string;
	readonly task: string;
	readonly ctx: ExtensionToolContext;
	readonly signal: AbortSignal | undefined;
}

/**
 * A scope double that mirrors the provider's real invariants: one open scope per owner id, a
 * captured native context and signal for each dispatch, and a close that can stay unconfirmed.
 */
export class FakeOwnedScope implements OwnedScope {
	readonly ownerId: string;
	readonly children = new Map<string, FakeChild>();
	readonly requests: RecordedDelegation[] = [];
	public closed = false;
	public closes = 0;
	public failures: string[] = [];
	public stopChildren = true;
	/** When set, a dispatch stays in flight until the test releases it. */
	public delegateGate: Promise<void> | undefined;
	/** When set, close stays in flight until the test releases it. */
	public closeGate: Promise<void> | undefined;
	/** Resolves as soon as close has been entered, before its result is known. */
	public closeEntered: (() => void) | undefined;
	#sequence = 0;

	public constructor(ownerId: string) {
		this.ownerId = ownerId;
	}

	public async delegate(
		request: { readonly agent: string; readonly task: string },
		ctx: ExtensionToolContext,
		signal?: AbortSignal,
	): Promise<OwnedChildHandle> {
		if (this.closed) throw new Error("scope closed");
		if (this.delegateGate !== undefined) await this.delegateGate;
		this.#sequence += 1;
		const childId = `${this.ownerId}-child-${this.#sequence}`;
		let resolve: (settlement: OwnedChildSettlement) => void = () => {};
		const settlement = new Promise<OwnedChildSettlement>((done) => {
			resolve = done;
		});
		this.children.set(childId, { settlement, resolve });
		this.requests.push({ agent: request.agent, task: request.task, ctx, signal });
		return { childId, revision: 1, settlement };
	}

	public settle(childId: string, status: OwnedChildStatus, message: string): void {
		const child = this.children.get(childId);
		if (child === undefined) throw new Error(`unknown fake child ${childId}`);
		child.resolve({ childId, agent: "reviewer", status, message });
	}

	public async close(_reason: string): Promise<OwnedScopeClose> {
		this.closes += 1;
		this.closeEntered?.();
		if (this.closeGate !== undefined) await this.closeGate;
		if (this.stopChildren) {
			this.closed = true;
			for (const [childId, child] of this.children) {
				child.resolve({ childId, agent: "reviewer", status: "stopped", message: "scope closed" });
			}
		}
		return { closed: this.stopChildren, failures: [...this.failures] };
	}
}

export class FakeOwnership implements SubagentOwnershipService {
	readonly scopes: FakeOwnedScope[] = [];
	readonly scopeIds: string[] = [];
	/** Applied to every scope opened afterwards, so a dispatch can be held mid-flight. */
	public nextGate: Promise<void> | undefined;

	/** Mirrors the provider: the same owner id cannot be opened twice. */
	public openScope(ownerId: string): OwnedScope {
		if (this.scopeIds.includes(ownerId)) throw new Error(`scope ${ownerId} is already open`);
		this.scopeIds.push(ownerId);
		const scope = new FakeOwnedScope(ownerId);
		scope.delegateGate = this.nextGate;
		this.scopes.push(scope);
		return scope;
	}

	public get last(): FakeOwnedScope {
		const scope = this.scopes[this.scopes.length - 1];
		if (scope === undefined) throw new Error("no owned scope was opened");
		return scope;
	}
}

/** A native `before_agent_start` event for a custom message that starts a run. */
export function customStartEvent(
	options: { readonly details?: unknown; readonly customType?: string } = {},
): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		messageType: "custom",
		message: {
			role: "custom",
			customType: options.customType ?? "pi-goal-kickoff",
			content: [],
			display: true,
			...(options.details === undefined ? {} : { details: options.details }),
			timestamp: 0,
		},
		systemPrompt: "",
		systemPromptOptions: { sections: {} },
	} as unknown as BeforeAgentStartEvent;
}

export function fakeToolContext(): ExtensionToolContext {
	return {} as unknown as ExtensionToolContext;
}

export function boundaryEvent(
	options: {
		readonly entries?: SessionBoundaryDraft[];
		readonly continue?: boolean;
		readonly pendingMessage?: boolean;
		readonly canContinue?: boolean;
		readonly outcome?: "completed" | "aborted" | "error";
	} = {},
): AgentBeforeSettleEvent {
	return {
		type: "agent_before_settle",
		entries: options.entries ?? [],
		continue: options.continue ?? false,
		outcome: options.outcome ?? "completed",
		context: {
			contextEntries: [],
			contextMessages: [],
			llmMessages: [],
			pendingMessages:
				options.pendingMessage === true ? [{ role: "user", content: "queued", timestamp: 0 }] : [],
			canContinue: options.canContinue ?? false,
		},
	};
}
