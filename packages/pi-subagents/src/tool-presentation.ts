import type { AgentToolResult, ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	agentResultText,
	createOptionalToolRenderers,
	createToolPresentationRenderers,
	isRecord,
	type ToolPresentation,
	type ToolPresentationProvider,
} from "@hheei/pi-ext-core";
import type { DashboardView, DelegationView } from "./delegation.js";

/**
 * Owned presentations for every subagent tool. Each definition ships its own native renderers, so a
 * session without pi-ext-ui still shows the tool title, full request, model-visible text and raw
 * errors; when the UI is loaded it decorates those same native renderers through ext-core's
 * optional-renderer point and reads the same ToolPresentation, so both paths share one semantic
 * source. This package never depends on pi-ext-ui.
 */

/** Native presentation renderers, then the optional UI frame over them. */
function ownedRenderers(
	pi: ExtensionAPI,
	name: string,
	present: ToolPresentationProvider,
): ToolRenderers {
	return createOptionalToolRenderers(pi, name, createToolPresentationRenderers(pi, name, present));
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = source?.[key];
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function delegationDetails(
	result: AgentToolResult<unknown> | undefined,
): DelegationView | undefined {
	const details = result?.details;
	return isRecord(details) && typeof details.id === "string"
		? (details as unknown as DelegationView)
		: undefined;
}

/** Readable delegation state; the result body is copied, never restated as state. */
function delegationLines(view: DelegationView): string[] {
	const lines = [`status: ${view.status}`, `revision: ${view.revision}`];
	if (view.sessionPath !== undefined) {
		lines.push(`sessionPath: ${view.sessionPath}`);
	}
	if (view.progress !== undefined) {
		lines.push(`runtime: ${view.progress.runtimeState}`);
		if (view.progress.activeTool !== undefined)
			lines.push(`activeTool: ${view.progress.activeTool}`);
		if (view.progress.summary !== undefined) lines.push(`summary: ${view.progress.summary}`);
	}
	lines.push(`hasOutput: ${String(view.hasOutput)}`);
	if (view.error !== undefined) lines.push(`error: ${view.error.reason}`);
	return lines;
}

function delegationRow(view: DelegationView): string {
	const parts: string[] = [view.status];
	if (view.agent !== undefined) parts.push(view.agent);
	if (view.progress !== undefined) {
		parts.push(view.progress.activeTool ?? view.progress.runtimeState);
	}
	parts.push(`rev ${view.revision}`);
	return parts.join(" · ");
}

function delegatePresentation(
	args: unknown,
	result: AgentToolResult<unknown> | undefined,
): ToolPresentation {
	const record = isRecord(args) ? args : undefined;
	const agent = stringField(record, "agent");
	const id = stringField(record, "id");
	const task = stringField(record, "task");
	const view = delegationDetails(result);
	const resultText = view?.resultText;
	const summaryParts = [view?.agent ?? agent ?? "agent"];
	if (view !== undefined) {
		summaryParts.push(view.id, `rev ${view.revision}`);
	} else if (id !== undefined) {
		summaryParts.push(id);
	}
	const output = resultText ?? (view === undefined ? undefined : delegationLines(view).join("\n"));
	return {
		summary: summaryParts.join(" · "),
		...(task === undefined ? {} : { request: task }),
		...(output === undefined ? {} : { output }),
		...(task === undefined
			? {}
			: { copy: { primary: task, full: output === undefined ? task : `${task}\n---\n${output}` } }),
	};
}

function getPresentation(
	args: unknown,
	result: AgentToolResult<unknown> | undefined,
): ToolPresentation {
	const record = isRecord(args) ? args : undefined;
	const id = stringField(record, "id") ?? "agent";
	const revision = record?.revision;
	const view = delegationDetails(result);
	const lines = view === undefined ? [] : delegationLines(view);
	const resultText = view?.resultText;
	const includeOutput = record?.includeOutput === true;
	const output =
		includeOutput && resultText !== undefined
			? `${lines.join("\n")}\n\n${resultText}`
			: lines.length === 0
				? undefined
				: lines.join("\n");
	return {
		summary: typeof revision === "number" ? `${id} · rev ${revision}` : id,
		request: includeOutput ? "with output" : "without output",
		...(output === undefined ? {} : { output }),
		...(view === undefined ? {} : { collapsedRows: [delegationRow(view)] }),
		...(resultText === undefined ? {} : { copy: { primary: resultText } }),
	};
}

function stopPresentation(
	args: unknown,
	result: AgentToolResult<unknown> | undefined,
): ToolPresentation {
	const record = isRecord(args) ? args : undefined;
	const id = stringField(record, "id") ?? "agent";
	const view = delegationDetails(result);
	const confirmation = result === undefined ? undefined : agentResultText(result);
	const output = confirmation ?? (view === undefined ? undefined : `status: ${view.status}`);
	return {
		summary: id,
		...(output === undefined ? {} : { output }),
		...(output === undefined ? {} : { copy: { primary: output } }),
	};
}

function dashboardPresentation(
	_args: unknown,
	result: AgentToolResult<unknown> | undefined,
): ToolPresentation {
	const details = result?.details;
	const view =
		isRecord(details) && Array.isArray(details.children)
			? (details as unknown as DashboardView)
			: undefined;
	if (view === undefined) return { summary: "agents" };
	const rows = view.children.map((child) => {
		const agent = child.agent === undefined ? "" : ` (${child.agent})`;
		const summary = child.summary === undefined ? "" : ` — ${child.summary}`;
		return `- ${child.id}${agent}: ${child.runtimeState} / ${child.status} · rev ${child.revision}${summary}`;
	});
	return {
		summary: `${view.total} agents · running ${view.running} · blocked ${view.blocked} · completed ${view.completed} · failed ${view.failed}`,
		...(rows.length === 0 ? {} : { output: rows.join("\n") }),
	};
}

function contactPresentation(
	args: unknown,
	result: AgentToolResult<unknown> | undefined,
): ToolPresentation {
	const record = isRecord(args) ? args : undefined;
	const reason = stringField(record, "reason") ?? "blocked";
	const message = stringField(record, "message");
	const confirmation = result === undefined ? undefined : agentResultText(result);
	const copy =
		message === undefined
			? undefined
			: {
					primary: message,
					...(confirmation === undefined ? {} : { full: `${message}\n${confirmation}` }),
				};
	return {
		summary: reason,
		...(message === undefined ? {} : { request: message }),
		...(confirmation === undefined ? {} : { output: confirmation }),
		...(copy === undefined ? {} : { copy }),
	};
}

/** One renderer set per tool, named exactly after its tool so nested calls resolve too. */
export function parentToolRenderers(pi: ExtensionAPI): {
	readonly delegate: ToolRenderers;
	readonly get: ToolRenderers;
	readonly stop: ToolRenderers;
	readonly dashboard: ToolRenderers;
} {
	return {
		delegate: ownedRenderers(pi, "agents_delegate", delegatePresentation),
		get: ownedRenderers(pi, "agents_get", getPresentation),
		stop: ownedRenderers(pi, "agents_stop", stopPresentation),
		dashboard: ownedRenderers(pi, "agents_dashboard", dashboardPresentation),
	};
}

/** The child's blocker report names the reason in the header and keeps the full message readable. */
export function contactParentRenderers(pi: ExtensionAPI): ToolRenderers {
	return ownedRenderers(pi, "contact_parent", contactPresentation);
}
