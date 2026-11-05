import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { textToolResult } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { DiscoveredAgent } from "./agent-resolver.js";
import type { DashboardView, DelegationView } from "./delegation.js";
import { type ChildIdentity, isOperationError, type OperationError } from "./domain.js";
import type { SubagentManager } from "./manager.js";
import { contactParentRenderers, parentToolRenderers } from "./tool-presentation.js";

/**
 * A failed operation still tells the caller what it may have already done: the identity it was
 * about, whether retrying is safe, and which side effects to check.
 */
function operationErrorText(error: OperationError): string {
	const details = [
		...(error.childId === undefined ? [] : [`id ${error.childId}`]),
		`safeToRetry ${error.safeToRetry}`,
		...(error.sideEffects.length === 0 ? [] : [`sideEffects ${error.sideEffects.join(", ")}`]),
	];
	return `${error.reason} (${details.join("; ")})`;
}

const delegateSchema = Type.Object(
	{
		task: Type.String({
			minLength: 1,
			description: "Work to perform in the selected agent session.",
		}),
		wait: Type.Optional(
			Type.Boolean({
				description:
					"Wait for the final result (default true). False returns the accepted delegation immediately, and its result is delivered automatically when it finishes.",
			}),
		),
		id: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"Existing agent id, e.g. agent-3f9a1c. Takes precedence over agent and reuses its session.",
			}),
		),
		agent: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Agent name from <available_agents> for a new agent. Ignored with id.",
			}),
		),
		cwd: Type.Optional(
			Type.String({ description: "Working directory for a new agent; ignored with id." }),
		),
		owner: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"Internal: owned scope token for a programmatic consumer. Ordinary delegation omits it, and an owned delegation always creates a new agent.",
			}),
		),
	},
	{ additionalProperties: false },
);
const getSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, description: "Agent id, e.g. agent-3f9a1c" }),
		revision: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "Delegation revision of this agent. Defaults to the newest one.",
			}),
		),
		includeOutput: Type.Optional(
			Type.Boolean({
				description:
					"Return the delegation's result body, bounded by the shared output budget. Defaults to false.",
			}),
		),
	},
	{ additionalProperties: false },
);
const idSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Agent id, e.g. agent-3f9a1c" }),
});
const dashboardSchema = Type.Object({}, { additionalProperties: false });
const contactSchema = Type.Object({
	message: Type.String({
		minLength: 1,
		description: "Explanation of what is blocking progress or the error encountered.",
	}),
	reason: Type.Optional(
		Type.Union([Type.Literal("blocked"), Type.Literal("error")], {
			description:
				"Reason: 'blocked' if waiting for input/guidance (can be resumed via agents_delegate with this id), or 'error' if the turn failed (you may retry or create a new agent). Defaults to 'blocked'.",
		}),
	),
});

const SUBAGENTS_NAMESPACE = {
	name: "agents",
	aliases: ["agent", "agents", "subagent", "subagents"],
	description: "Agent orchestration and delegation tools",
} as const;

export function formatAvailableAgents(agents: readonly DiscoveredAgent[]): string {
	const available = agents
		.filter((agent) => agent.enabled !== false && agent.frontmatter.hidden !== true)
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((agent) => {
			const description = agent.frontmatter.description;
			return `- ${agent.name}: ${typeof description === "string" && description.trim() !== "" ? description.trim() : "No description provided."}`;
		});
	return [
		"<available_agents>",
		...(available.length > 0 ? available : ["None."]),
		"</available_agents>",
	].join("\n");
}

function getDelegateDescription(agents: readonly DiscoveredAgent[]): string {
	return [
		"Delegate work to an agent. New: omit id and supply agent. Continue: use an existing id; agent/cwd are ignored. Unknown or blank ids fail.",
		'Create: agents_delegate({ agent: "worker", task: "..." }). Continue: agents_delegate({ id: "agent-3f9a1c", task: "..." }).',
		"Returns { id, revision, status, hasOutput }: revision identifies this delegation of that agent, and a finished delegation carries its result when wait is true. Results are delivered automatically when the task finishes, so do independent work or end your turn instead of polling agents_get.",
		"Related agent tools: agents_get, agents_stop, agents_dashboard.",
		formatAvailableAgents(agents),
	].join("\n");
}
const GET_DESCRIPTION =
	"Read one agent delegation: the newest by default, or one revision, with its result body when includeOutput is true. Use it for inspection, not completion polling. Related agent tools: agents_delegate, agents_stop, agents_dashboard.";
const STOP_DESCRIPTION =
	"Stop an agent runtime by id (e.g. 'agent-3f9a1c'). Open delegations end as failed; finished results and the session are kept, so a later agents_delegate with this id resumes it. Related agent tools: agents_delegate, agents_get, agents_dashboard.";
const DASHBOARD_DESCRIPTION =
	"List this session's agents with their runtime state and latest delegation. Related agent tools: agents_delegate, agents_get, agents_stop.";
const CONTACT_DESCRIPTION =
	"Notify the parent session when you are BLOCKED and cannot continue without parent decision or intervention. Do NOT call this on success or task completion: simply output your final answer directly as normal text in your response, and the harness will automatically capture and report your result to the parent.";
const CONTACT_SNIPPET =
	"Report a blocker to the parent. Do NOT call on success: write normal text to finish.";
const CONTACT_GUIDELINES = [
	"Use contact_parent ONLY if you are blocked or urgently require a parent decision midway.",
	"Do NOT use contact_parent to deliver final findings or report success: output normal text instead.",
	"After reporting a blocker, wait for a parent agents_delegate instruction.",
] as const;

export function registerParentTools(
	pi: ExtensionAPI,
	manager: SubagentManager,
	agents: readonly DiscoveredAgent[],
): void {
	const renderers = parentToolRenderers(pi);
	const inspected = new Set<string>();
	/** The same inspection twice in a row is polling, and polling never gets the answer faster. */
	function inspectionResult(
		id: string,
		text: string,
		details: DelegationView,
	): AgentToolResult<DelegationView> {
		const repeated = inspected.has(id);
		inspected.add(id);
		return textToolResult(
			repeated ? `${text}\nResults are delivered automatically; do not poll agents_get.` : text,
			details,
		);
	}
	const delegate: ToolDefinition<typeof delegateSchema> = {
		name: "agents_delegate",
		namespace: SUBAGENTS_NAMESPACE,
		label: "Delegate to agent",
		description: getDelegateDescription(agents),
		parameters: delegateSchema,
		exposure: "deferred",
		defaultActive: false,
		annotations: {
			openWorldHint: true,
		},
		async execute(_id, params, signal, onUpdate) {
			if (!Value.Check(delegateSchema, params))
				throw new Error("Invalid agents_delegate parameters");
			const view = await manager.delegate(params, signal, (accepted) => {
				onUpdate?.(textToolResult(JSON.stringify(accepted), accepted));
			});
			if (isOperationError(view)) throw new Error(operationErrorText(view));
			return textToolResult(JSON.stringify(view), view);
		},
		...renderers.delegate,
	};
	const get: ToolDefinition<typeof getSchema> = {
		name: "agents_get",
		namespace: SUBAGENTS_NAMESPACE,
		label: "Get agent",
		description: GET_DESCRIPTION,
		parameters: getSchema,
		exposure: "deferred",
		defaultActive: false,
		annotations: {
			readOnlyHint: true,
			idempotentHint: true,
		},
		async execute(_id, params) {
			if (!Value.Check(getSchema, params)) throw new Error("Invalid agents_get parameters");
			const view = await manager.inspect({
				id: params.id,
				...(params.revision === undefined ? {} : { revision: params.revision }),
				includeOutput: params.includeOutput === true,
			});
			if (isOperationError(view)) throw new Error(operationErrorText(view));
			return inspectionResult(params.id, JSON.stringify(view), view);
		},
		...renderers.get,
	};
	const stop: ToolDefinition<typeof idSchema> = {
		name: "agents_stop",
		namespace: SUBAGENTS_NAMESPACE,
		label: "Stop agent",
		description: STOP_DESCRIPTION,
		parameters: idSchema,
		exposure: "deferred",
		defaultActive: false,
		annotations: {
			destructiveHint: true,
		},
		async execute(_id, params) {
			const view = await manager.stopAgent(params.id);
			if (isOperationError(view)) throw new Error(operationErrorText(view));
			return textToolResult(
				`Agent ${view.id} stopped; revision ${view.revision} is ${view.status}.`,
				view,
			);
		},
		...renderers.stop,
	};
	const dashboard: ToolDefinition<typeof dashboardSchema> = {
		name: "agents_dashboard",
		namespace: SUBAGENTS_NAMESPACE,
		label: "Agent dashboard",
		description: DASHBOARD_DESCRIPTION,
		parameters: dashboardSchema,
		exposure: "deferred",
		defaultActive: false,
		annotations: {
			readOnlyHint: true,
			idempotentHint: true,
		},
		async execute() {
			const view: DashboardView = await manager.dashboard();
			return textToolResult(
				`${view.total} agents · running ${view.running} · blocked ${view.blocked} · completed ${view.completed} · failed ${view.failed}`,
				view,
			);
		},
		...renderers.dashboard,
	};
	pi.registerTool(delegate);
	pi.registerTool(get);
	pi.registerTool(stop);
	pi.registerTool(dashboard);
}

/** Sends a child-initiated request over the bridge and resolves with the parent's answer. */
export type ChildReport = (
	operation: string,
	payload: unknown,
	signal?: AbortSignal,
) => Promise<unknown>;

export interface RegisterChildToolsOptions {
	/** The bridge connection to the parent; a child without one cannot report anything. */
	readonly report: ChildReport;
	readonly isBound?: (sessionId: string) => boolean;
}

export function registerChildTools(
	pi: ExtensionAPI,
	identity: ChildIdentity,
	options: RegisterChildToolsOptions,
): void {
	const tool: ToolDefinition<typeof contactSchema> = {
		name: "contact_parent",
		label: "Contact parent",
		description: CONTACT_DESCRIPTION,
		promptSnippet: CONTACT_SNIPPET,
		promptGuidelines: [...CONTACT_GUIDELINES],
		parameters: contactSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (options.isBound !== undefined && !options.isBound(sessionId)) {
				throw new Error(
					"This Pi session is not the bound subagent session; contact_parent is disabled.",
				);
			}
			const reason = params.reason ?? "blocked";
			const details = {
				type: "pi_subagent_report" as const,
				parentSessionId: identity.parentSessionId,
				childId: identity.subagentId,
				runtimeIdentity: identity.runtimeIdentity,
				reason,
				message: params.message,
				sessionId,
			};
			await options.report("contact_parent", details, signal);
			return textToolResult(
				reason === "error"
					? "Error report delivered to the parent."
					: "Blocker report queued for the parent.",
				undefined,
			);
		},
		...contactParentRenderers(pi),
	};
	pi.registerTool(tool);
}
