import { isRecord } from "@hheei/pi-ext-core";

export const PROTOCOL_VERSION = 1 as const;

export type SubagentState = "running" | "done" | "blocked" | "error";

export function normalizeSubagentState(value: unknown): SubagentState | undefined {
	if (typeof value !== "string") return undefined;
	switch (value) {
		case "running":
		case "starting":
		case "idle":
			return "running";
		case "done":
		case "stopped":
			return "done";
		case "blocked":
			return "blocked";
		case "error":
		case "failed":
			return "error";
		default:
			return undefined;
	}
}

/**
 * Where a child is presented: `panel` is the native Pi TUI in a host panel (herdr tab / cmux
 * surface), `background` is a headless Pi the parent owns over stdio. It is frozen when the child
 * is created, because it decides who holds the process for the rest of the child's life.
 */
export type Presentation = "panel" | "background";
export type VisualSubagentState = SubagentState;

export function toVisualSubagentState(
	state: SubagentState,
	interrupted?: string,
): VisualSubagentState {
	if (state === "error") return "error";
	if (state === "blocked") return "blocked";
	if (interrupted !== undefined && state !== "done") return "blocked";
	return state;
}

export const VISUAL_SUBAGENT_GLYPH: Record<VisualSubagentState, string> = {
	running: "✢",
	done: "✓",
	blocked: "!",
	error: "✗",
};

export const VISUAL_SUBAGENT_TONE: Record<
	VisualSubagentState,
	"accent" | "success" | "warning" | "error"
> = {
	running: "accent",
	done: "success",
	blocked: "warning",
	error: "error",
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type LaunchValueSource = "agent" | "parent";
export type SubagentIntent = "active" | "stopped";
export type PersistenceState = "never_flushed" | "flushed";

export interface ChildIdentity {
	readonly parentSessionId: string;
	readonly subagentId: string;
	readonly runtimeIdentity: string;
	readonly endpoint: string;
}

/**
 * What a launch spec may contain and what may be persisted: the child's identity minus nothing,
 * because the mailbox is authenticated by the process lock its writer holds, not by a token.
 */
export interface ChildBridgeEnvironment {
	readonly parentSessionId: string;
	readonly subagentId: string;
	readonly runtimeIdentity: string;
	readonly endpoint: string;
}

export interface PiInvocation {
	/** Executable or runtime binary, never resolved through a shell. */
	readonly command: string;
	/** Host-resolved leading argv (for example an absolute `cli.js`). Feature flags are appended by the launch builder. */
	readonly args: readonly string[];
}

export interface ResolvedAgentIdentity {
	readonly name: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly hidden: boolean;
	readonly sourcePath: string;
	readonly instructions: string;
}

export interface ResolvedModel {
	readonly provider: string;
	readonly id: string;
	readonly source: LaunchValueSource;
}

export interface ResolvedThinking {
	readonly level: ThinkingLevel;
	readonly source: LaunchValueSource;
}

export interface Selection {
	readonly discovery: boolean;
	readonly paths: readonly string[];
}

/** Extensions and skills are selected the same way; the aliases keep the two roles named. */
export type ExtensionSelection = Selection;
export type SkillSelection = Selection;

export interface McpSelection {
	readonly enabled: boolean;
	readonly servers?: readonly string[];
	readonly excluded?: readonly string[];
}

export interface EffectiveLaunchConfig {
	/** Logical child id; the same value the child bridge reports back. */
	readonly subagentId: string;
	readonly invocation: PiInvocation;
	readonly cwd: string;
	readonly sessionId: string;
	/** Directory Pi uses for this child's session file; always passed explicitly so recovery can find the file. */
	readonly sessionDir: string;
	/** Known only once the session has been flushed to disk. */
	readonly sessionPath?: string;
	readonly agent: ResolvedAgentIdentity;
	readonly model: ResolvedModel;
	readonly thinking: ResolvedThinking;
	readonly tools: readonly string[];
	readonly excludeTools: readonly string[];
	readonly extensions: ExtensionSelection;
	readonly skills: SkillSelection;
	readonly mcp: McpSelection;
	readonly prompt: string;
	readonly bridgeExtensionPath: string;
	/** Whether the subagent operates in codemode-only mode. */
	readonly codemodeOnly?: boolean;
	/**
	 * Session title asked for at spawn, frozen so a relaunched child re-applies the same name.
	 * Presentation only: it never changes the child's identity or its host attachment label.
	 */
	readonly title?: string;
}

export interface ResolvedAgentPolicy {
	readonly agent: ResolvedAgentIdentity;
	readonly model: ResolvedModel;
	readonly thinking: ResolvedThinking;
	readonly tools: readonly string[];
	readonly excludeTools: readonly string[];
	readonly extensions: ExtensionSelection;
	readonly skills: SkillSelection;
	readonly mcp: McpSelection;
	readonly codemodeOnly?: boolean;
	readonly enabled?: boolean;
}

/**
 * The runtime attachment a child was last launched with. It is evidence, never a liveness proof:
 * whether that process is still serving this child is answered by the bridge connection.
 */
export type PanelHost = "hc" | "herdr" | "cmux" | "rex";

/**
 * The surface that owns a child runtime. A panel id is a host tab or surface. A process id is a
 * background child. Neither one is liveness by itself: the host list or a pid check says whether
 * it is still there.
 */
export type RuntimeAttachment =
	| { readonly kind: "panel"; readonly host: PanelHost; readonly id: string }
	| { readonly kind: "process"; readonly pid: number };

export interface RuntimeMetadata {
	readonly runtimeIdentity: string;
	readonly endpoint: string;
	readonly attachment?: RuntimeAttachment;
}

export interface UsageSummary {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly costUsd: number | null;
	readonly turns: number;
}

export interface SubagentRecord {
	readonly subagentId: string;
	readonly parentSessionId: string;
	readonly revision: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly sessionId: string;
	readonly sessionPath?: string;
	readonly cwd: string;
	readonly initialTask: string;
	readonly intent: SubagentIntent;
	readonly state: SubagentState;
	readonly presentation: Presentation;
	readonly persistence: PersistenceState;
	readonly launchConfig: EffectiveLaunchConfig;
	readonly runtime?: RuntimeMetadata;
	readonly latestSummary?: string;
	readonly activeTool?: string;
	readonly usage?: UsageSummary;
	readonly interrupted?: string;
	readonly unacknowledgedInput?: string;
}

export interface PublicSubagent {
	readonly id: string;
	/** Pi-assigned session file path; the first write may still be pending. */
	readonly path?: string;
	readonly agent: string;
	readonly displayName?: string;
	readonly state: SubagentState;
	readonly presentation: Presentation;
	readonly cwd: string;
	readonly sessionId: string;
	readonly task?: string;
	readonly summary?: string;
	readonly activeTool?: string;
	readonly usage?: UsageSummary;
	readonly interrupted?: string;
	readonly freshness: "live" | "last_known";
	readonly model: ResolvedModel;
	readonly thinking: ResolvedThinking;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface OperationError {
	readonly operation: string;
	readonly childId?: string;
	readonly reason: string;
	readonly sideEffects: readonly string[];
	readonly state?: SubagentState;
	readonly safeToRetry: boolean;
}

export interface SpawnSubagentInput {
	readonly task: string;
	readonly agent: string;
	readonly cwd?: string;
	/**
	 * Where to run this child. `auto` (the default) means a panel whenever this parent has a
	 * presentation host, and the background otherwise; the Task tool pins `background` because a
	 * Task is settled by its parent and never handed to a human. This is not a model-facing
	 * parameter: `agents_delegate` always spawns with `auto`.
	 */
	readonly presentation?: Presentation | "auto";
}

/**
 * Input for a single delegated turn. An existing child ID always takes precedence over the agent
 * definition: the child already owns its launch configuration, model, and session history.
 */
export interface DelegateSubagentInput {
	readonly task: string;
	readonly id?: string;
	readonly agent?: string;
	/** Only used when creating a child; ignored when id is supplied. */
	readonly cwd?: string;
	/**
	 * Opaque owned-scope token. Only a consumer that ends the child itself sets it, and an owned
	 * delegation always creates a new child; ordinary callers omit it, which is what makes an owned
	 * child unavailable to them.
	 */
	readonly owner?: string;
}

/** True when a manager call returned a structured failure instead of a value. */
export function isOperationError(value: unknown): value is OperationError {
	return (
		isRecord(value) &&
		typeof value.operation === "string" &&
		typeof value.reason === "string" &&
		Array.isArray(value.sideEffects)
	);
}

/** Child bridge tool name; agent tool policy must never remove it. */
export const CONTACT_PARENT_TOOL_NAME = "contact_parent" as const;
export const DEFAULT_PI_TOOLS = ["read", "bash", "edit", "write"] as const;

/** Environment contract between a parent launch and the child branch of this extension. */
export const BRIDGE_ENVIRONMENT_KEYS = {
	parentSessionId: "PI_SUBAGENTS_PARENT_SESSION_ID",
	childId: "PI_SUBAGENTS_CHILD_ID",
	runtimeId: "PI_SUBAGENTS_RUNTIME_ID",
	endpoint: "PI_SUBAGENTS_ENDPOINT",
} as const;

/** Non-secret agent label for the child TUI identity line. Not part of handshake. */
export const CHILD_AGENT_ENV_KEY = "PI_SUBAGENTS_AGENT" as const;

/** Session title requested at spawn; empty means the child derives one. Not part of handshake. */
export const CHILD_TITLE_ENV_KEY = "PI_SUBAGENTS_TITLE" as const;

/** Bound Pi session id for the child branch. Not part of the runner handshake. */
export const CHILD_SESSION_ENV_KEY = "PI_SUBAGENTS_SESSION_ID" as const;

/**
 * Set on the standalone controller process. Its children must not discover Pi settings extensions:
 * another installed copy of this package registers the same bridge tool as the explicit -e entry,
 * and Pi aborts the child before it connects.
 */
export const STANDALONE_CONTROLLER_ENV_KEY = "PI_SUBAGENTS_STANDALONE_CONTROLLER" as const;

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Pi session ids reach argv and file names, so they must stay in Pi's accepted alphabet. */
export function isSessionId(value: unknown): value is string {
	return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

const THINKING_LEVELS: Record<string, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS[value] === true;
}

const SUBAGENT_STATES: Record<string, true> = {
	running: true,
	done: true,
	blocked: true,
	error: true,
};

export function isSubagentState(value: unknown): value is SubagentState {
	return (
		typeof value === "string" &&
		(SUBAGENT_STATES[value] === true || normalizeSubagentState(value) !== undefined)
	);
}

const PRESENTATIONS: Record<string, true> = { panel: true, background: true };

export function isPresentation(value: unknown): value is Presentation {
	return typeof value === "string" && PRESENTATIONS[value] === true;
}

const SUBAGENT_INTENTS: Record<string, true> = { active: true, stopped: true };

export function isSubagentIntent(value: unknown): value is SubagentIntent {
	return typeof value === "string" && SUBAGENT_INTENTS[value] === true;
}

const PERSISTENCE_STATES: Record<string, true> = { never_flushed: true, flushed: true };

export function isPersistenceState(value: unknown): value is PersistenceState {
	return typeof value === "string" && PERSISTENCE_STATES[value] === true;
}

const LAUNCH_VALUE_SOURCES: Record<string, true> = { agent: true, parent: true };

export function isLaunchValueSource(value: unknown): value is LaunchValueSource {
	return typeof value === "string" && LAUNCH_VALUE_SOURCES[value] === true;
}
