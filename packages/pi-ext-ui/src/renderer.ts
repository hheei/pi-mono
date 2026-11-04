import {
	type AgentToolResult,
	type ExtensionAPI,
	highlightCode,
	type Theme,
	type ToolRendererResolver,
	type ToolRenderers,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	agentResultText,
	getRegisteredToolPresentationProvider,
	getRegisteredToolRenderers,
	getToolPresentationProvider,
	hasOptionalToolRenderers,
	isRecord,
	type ToolPresentation,
	type ToolPresentationChild,
	type ToolPresentationProvider,
} from "@hheei/pi-ext-core";
import { DiffView } from "./diff-view.js";
import { NestedCallsView } from "./nested-calls-view.js";
import type { ToolUiRuntime } from "./runtime.js";
import {
	type FoldLevel,
	formatToolHeaderText,
	type RailColorToken,
	type RailSection,
	type ToolStatusKind,
	ToolView,
	type ToolViewChild,
	type ToolViewCopySpec,
} from "./tool-view.js";
import type { CapturedToolCall } from "./tracker.js";

/** Everything the host hands a tool renderer for one call. */
export type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

/**
 * Upstream tools whose call and result views pi-ext-ui still frames itself. Concrete tool packages
 * own their own presentation through ext-core's optional renderer point, so their names never
 * appear here.
 */
export const SPECIALIZED_TOOL_RENDERERS = ["codemode"] as const;

export type SpecializedToolRendererName = (typeof SPECIALIZED_TOOL_RENDERERS)[number];

import {
	inlinePresentation,
	nativeHeaderSummary,
	nativeHeavyRequest,
	nativeOutputLanguage,
	nativeRequestBlock,
	nativeResultText,
	nativeTimeoutFact,
} from "./native-tools.js";
import {
	callStatsParts,
	estimateStreamingTokens,
	extractNestedCalls,
	formatCostUsd,
	formatDurationMs,
	type NestedCallRecord,
	RESOLVED_CALLS_KEY,
	resolveContainerStatus,
} from "./payload-parser.js";

export { extractChildToolCopyText, inlinePresentation } from "./native-tools.js";
export {
	estimateStreamingTokens,
	type NestedCallRecord,
} from "./payload-parser.js";

const SPECIALIZED_TOOL_SET: ReadonlySet<string> = new Set(SPECIALIZED_TOOL_RENDERERS);
const CALL_VIEW_STATE_KEY = "__piExtUiCallView";

export interface CollapsibleToolRendererOptions {
	readonly tools?: readonly string[] | undefined;
	readonly match?: ((toolName: string) => boolean) | undefined;
	readonly catchAll?: boolean | undefined;
	readonly defaultCollapsed?: boolean | undefined;
	readonly copyToClipboard?: ((text: string) => Promise<void>) | undefined;
}

function createInputCodeSection(
	toolName: string,
	args: unknown,
	theme: Theme,
	railToken: RailColorToken = "muted",
): RailSection | undefined {
	const block = nativeRequestBlock(toolName, args);
	if (block === undefined) return undefined;
	// Display only: the request is model-controlled input, while its copy stays byte-exact.
	const clean = stripTerminalSequences(block.text.trim()).replace(/\r/g, "").replace(/\t/g, "  ");

	let lines: string[];
	if (block.shell) {
		lines = clean.split("\n").map((line, i) => (i === 0 ? `$ ${line}` : `  ${line}`));
	} else {
		try {
			lines = highlightCode(clean, block.language);
		} catch {
			lines = clean.split("\n").map((line) => theme.fg("mdCode", line));
		}
	}

	return { railToken, content: lines };
}

/** One row's header facts: what the tool states about its own call, plus what the frame dims. */
interface ToolHeaderFacts {
	readonly summary: string;
	readonly summaryStyled?: true;
	readonly meta?: string;
}

/**
 * The one-row argument line a native generic tool row shows. It states the arguments as given, so a
 * tool with no vocabulary of its own keeps the information its native row carried without this
 * frame rendering and parsing that row.
 */
function genericArgsLine(args: unknown): string {
	if (typeof args === "string") return stripTerminalSequences(args.trim());
	if (!isRecord(args)) return "";
	const pairs = Object.entries(args)
		.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`)
		.join(" ");
	return pairs.length > 100 ? `${pairs.slice(0, 97)}...` : pairs;
}

/**
 * The header facts of one tool row. The tool's own layer states its summary and whether it absorbs the
 * secondary facts; a tool with no vocabulary of its own states its arguments as given.
 */
function toolHeaderFacts(params: {
	readonly toolName: string;
	readonly args: unknown;
	readonly theme: Theme;
	readonly cwd: string;
	readonly facts: readonly string[];
	/** Whether the tool has a native call row, whose arguments this frame still has to state. */
	readonly nativeArgsLine?: boolean;
}): ToolHeaderFacts {
	const { toolName, args, theme, cwd, facts, nativeArgsLine } = params;
	const secondary = facts.filter(Boolean);
	const meta = secondary.join(" · ");
	const withMeta = (summary: string, styled: boolean): ToolHeaderFacts => ({
		summary,
		...(styled ? { summaryStyled: true as const } : {}),
		...(meta === "" ? {} : { meta }),
	});
	const native = nativeHeaderSummary(toolName, args, theme, cwd);
	if (native !== undefined) {
		return native.factsInSummary
			? { summary: [native.summary, ...secondary].filter(Boolean).join(" · ") }
			: withMeta(native.summary, native.styled);
	}
	const summary = nativeArgsLine === true ? genericArgsLine(args) : "";
	return { summary: [summary, ...secondary].filter(Boolean).join(" · ") };
}

function isCapturedCall(call: CapturedToolCall | NestedCallRecord): call is CapturedToolCall {
	return "args" in call || "result" in call;
}

/**
 * The request a persisted child row can still show. A live capture already carries it; otherwise the
 * host's saved nested-call record for the same id does, as long as it kept the arguments at all.
 */
function withSessionArgs(
	calls: readonly (CapturedToolCall | NestedCallRecord)[],
	runtime: ToolUiRuntime,
): readonly (CapturedToolCall | NestedCallRecord)[] {
	return calls.map((call) => {
		if (isCapturedCall(call)) return call;
		if (call.args !== undefined || call.argsTruncated === true) return call;
		const fact = runtime.nestedCalls.args(call.id);
		if (fact === undefined) return call;
		return {
			...call,
			...(fact.args === undefined ? {} : { args: fact.args }),
			...(fact.truncated
				? {
						argsTruncated: true,
						...(fact.bytes === undefined ? {} : { argsBytes: fact.bytes }),
					}
				: {}),
		};
	});
}

/** A call counts only when the host proved it resolved; an absent fact is not a negative one. */
function callResolved(
	call: CapturedToolCall | NestedCallRecord,
	live: ReadonlySet<string> | undefined,
): boolean {
	if (call.resolved === true) return true;
	return call.id !== undefined && live?.has(call.id) === true;
}

/** The container's own child facts, in the shape the nested board draws and copies. */
function presentationChildCalls(children: readonly ToolPresentationChild[]): NestedCallRecord[] {
	return children.map((child) => {
		const status: NestedCallRecord["status"] =
			child.status === "running" || child.status === "streaming"
				? "running"
				: child.status === "warn"
					? "cancelled"
					: child.status === "error"
						? "error"
						: "ok";
		return {
			toolName: child.title,
			...(child.id === undefined ? {} : { id: child.id }),
			...(child.summary === undefined ? {} : { summary: child.summary }),
			status,
			...(child.durationMs === undefined ? {} : { durationMs: child.durationMs }),
		};
	});
}

/** Nested call facts for a consumer that counts or aggregates them outside the container's body. */
function nestedChildren(calls: readonly (CapturedToolCall | NestedCallRecord)[]): ToolViewChild[] {
	return calls.map((call) => {
		if (isCapturedCall(call)) {
			const isError = call.isError === true;
			const inline = inlinePresentation(call.toolName, call.args, call.result?.details, isError);
			return {
				title: call.toolName,
				...(inline === undefined ? {} : { summary: inline.summary }),
				// The tracker records a call when it starts, so a missing result means it is still
				// running, not that it succeeded.
				status: isError
					? ("error" as const)
					: call.result === undefined
						? ("running" as const)
						: ("ok" as const),
				...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
				...(call.resolved === true ? { resolved: true } : {}),
			};
		}
		return {
			title: call.toolName,
			...(call.summary === undefined ? {} : { summary: call.summary }),
			// Same precedence as formatNestedCallRow: a cancelled call is a warning, not a success.
			status:
				call.status === "running"
					? ("running" as const)
					: call.isWarning === true
						? ("warn" as const)
						: call.isError === true || call.status === "error"
							? ("error" as const)
							: ("ok" as const),
			...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
			...(call.resolved === true ? { resolved: true } : {}),
		};
	});
}

function formatArgsPreview(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return stripTerminalSequences(args);
	try {
		return JSON.stringify(args, null, 2);
	} catch {
		return "";
	}
}

/**
 * The host stacks a tool execution's call and result views. Following the
 * official edit renderer, the call view is stored in the shared renderer
 * state so the result renderer can hide it in place within the same
 * updateDisplay pass — no draw-time flags needed.
 *
 * The call row is left visible until a result view exists: hiding it here would
 * blank the whole execution for as long as the tool produces no result yet.
 */
function rememberCallView(context: ToolRenderContext, view: ToolView): void {
	if (isRecord(context.state)) {
		context.state[CALL_VIEW_STATE_KEY] = view;
	}
}

/**
 * A result view takes over from the call view. A container tool yields on any result, because its
 * own row would duplicate the nested rows and output it now carries. A mounted result view takes
 * over from its call view, including during partial updates. A provider states container semantics.
 */
function hideCallView(context: ToolRenderContext): void {
	const view = isRecord(context.state) ? context.state[CALL_VIEW_STATE_KEY] : undefined;
	if (view instanceof ToolView) view.hide();
}

function formatNestedCallRow(call: NestedCallRecord, theme: Theme, cwd: string): string {
	const inline = inlinePresentation(call.toolName, call.summary, undefined, call.isError === true);
	const status: ToolStatusKind =
		call.status === "running"
			? "running"
			: call.isWarning === true
				? "warn"
				: (inline?.status ?? (call.isError === true ? "error" : "ok"));
	const cleanArgs =
		inline !== undefined || call.summary === undefined
			? ""
			: stripTerminalSequences(call.summary.trim());
	const truncatedArgs = cleanArgs.length > 72 ? `${cleanArgs.slice(0, 69)}…` : cleanArgs;
	const header = toolHeaderFacts({
		toolName: call.toolName,
		args: call.summary,
		theme,
		cwd,
		facts: [formatDurationMs(call.durationMs), formatCostUsd(call.cost)],
	});
	// A record's arguments may be a summary the container already flattened; fall back to it rather
	// than drop the only text the row has.
	return formatToolHeaderText(
		{
			status,
			title: call.toolName,
			...header,
			summary: header.summary || (inline?.summary ?? truncatedArgs),
		},
		theme,
	);
}

export function isMcpTool(toolName: string): boolean {
	return (
		toolName.startsWith("mcp__") ||
		toolName === "read_mcp_resource" ||
		toolName === "list_mcp_resources" ||
		toolName === "list_mcp_resource_templates"
	);
}

function shouldInterceptTool(
	toolName: string,
	options: CollapsibleToolRendererOptions | undefined,
): boolean {
	if (options?.match?.(toolName)) {
		return true;
	}
	const toolList = options?.tools;
	if (toolList !== undefined) {
		return toolList.includes(toolName);
	}
	if (options?.catchAll === false) {
		return SPECIALIZED_TOOL_SET.has(toolName) || isMcpTool(toolName);
	}
	return true;
}

function renderGenericResult(params: {
	readonly runtime: ToolUiRuntime;
	readonly toolName: string;
	readonly theme: Theme;
	readonly context: ToolRenderContext;
	readonly result: AgentToolResult<unknown>;
	readonly renderOptions: ToolRenderResultOptions;
	readonly defaultLevel: FoldLevel;
	/** The tool has a native call row, so its arguments still need a one-row statement here. */
	readonly nativeArgsLine: boolean;
	readonly originalRenderResult?:
		| ((
				result: AgentToolResult<unknown>,
				options: ToolRenderResultOptions,
				theme: Theme,
				context: ToolRenderContext,
		  ) => Component)
		| undefined;
	readonly options: CollapsibleToolRendererOptions | undefined;
	readonly resolvePresentation?:
		| ((toolName: string) => ToolPresentationProvider | undefined)
		| undefined;
	readonly resolveNativeRenderer?: ((toolName: string) => ToolRenderers | undefined) | undefined;
}): ToolView {
	const {
		runtime,
		toolName,
		theme,
		context,
		result,
		renderOptions,
		defaultLevel,
		nativeArgsLine,
		originalRenderResult,
		resolvePresentation,
		resolveNativeRenderer,
		options,
	} = params;

	const heavyCmd = nativeHeavyRequest(toolName, context.args);
	const nestedCalls = extractNestedCalls(result);
	const captured =
		toolName === "codemode"
			? (runtime.tracker.getCaptured(context.toolCallId) ??
				(isRecord(result.details) &&
				Array.isArray((result.details as Record<string, unknown>).__piExtUiCapturedCalls)
					? ((result.details as Record<string, unknown>)
							.__piExtUiCapturedCalls as CapturedToolCall[])
					: undefined))
			: undefined;
	const childCalls = withSessionArgs(captured ?? nestedCalls, runtime);
	const liveResolved = runtime.tracker.getResolved(context.toolCallId);
	const resolvedCalls = childCalls.filter((call) => callResolved(call, liveResolved));
	const unknownCallCount = childCalls.length - resolvedCalls.length;
	const isMetaTool = toolName === "codemode" || toolName === "subagent" || childCalls.length > 0;
	const { outputText: rawOutput, wallTimeSeconds } = nativeResultText(toolName, result);
	const isError = (context.isError ?? false) || (result.isError ?? false);

	const status: ToolStatusKind =
		toolName === "codemode"
			? childCalls.length > 0
				? "none"
				: isError
					? "error"
					: renderOptions.isPartial === true
						? context.argsComplete
							? "running"
							: "streaming"
						: "none"
			: isMetaTool
				? resolveContainerStatus({
						isError,
						isPartial: renderOptions.isPartial === true,
						hasChildren: childCalls.length > 0,
						selfFailed: childCalls.length === 0 && isError,
					})
				: isError
					? "error"
					: renderOptions.isPartial
						? "running"
						: "ok";

	const facts: string[] = [];
	if (isMetaTool && childCalls.length > 0) {
		// Only a proven resolution is a call; the rest stay visible as unknown instead of counting.
		const failCount = resolvedCalls.filter((c) =>
			Boolean(c.isError || ("status" in c && c.status === "error")),
		).length;
		facts.push(...callStatsParts(resolvedCalls.length, failCount));
		if (unknownCallCount > 0) facts.push(`${String(unknownCallCount)} unknown`);
	}
	if (context.durationMs !== undefined) {
		facts.push(formatDurationMs(context.durationMs));
	} else if (wallTimeSeconds !== undefined && Number.isFinite(wallTimeSeconds)) {
		facts.push(formatDurationMs(wallTimeSeconds * 1000));
	}
	const totalCost = childCalls.reduce((sum, c) => sum + (c.cost ?? 0), 0);
	if (totalCost > 0) facts.push(formatCostUsd(totalCost));
	const timeout = nativeTimeoutFact(toolName, context.args);
	if (timeout !== undefined) facts.unshift(timeout);
	const header = toolHeaderFacts({
		toolName,
		args: context.args,
		theme,
		cwd: context.cwd,
		facts,
		nativeArgsLine,
	});

	const codemodeNestedView =
		toolName === "codemode" && childCalls.length > 0
			? new NestedCallsView({
					calls: childCalls,
					theme,
					context,
					headerSummary: (childName, childArgs, childTheme) =>
						nativeHeaderSummary(childName, childArgs, childTheme, context.cwd)?.summary,
					resolveChildRenderer: (childName: string) => {
						return {
							renderResult: (childResult, childOptions, childTheme, childCtx) => {
								const provider = resolvePresentation?.(childName);
								if (provider !== undefined) {
									return renderOwnedPresentation({
										runtime,
										toolName: childName,
										presentation: provider(childCtx.args, childResult, childTheme, childCtx),
										result: childResult,
										theme: childTheme,
										context: childCtx,
										defaultLevel: childOptions.expanded ? 2 : 1,
										resolvePresentation,
										resolveNativeRenderer,
										options,
									});
								}

								const registered = resolveNativeRenderer?.(childName);

								return renderGenericResult({
									runtime,
									toolName: childName,
									theme: childTheme,
									context: childCtx,
									result: childResult,
									renderOptions: childOptions,
									defaultLevel: childOptions.expanded ? 2 : 1,
									nativeArgsLine: registered?.renderCall !== undefined,
									originalRenderResult: registered?.renderResult,
									resolvePresentation,
									resolveNativeRenderer,
									options,
								});
							},
						};
					},
					copyToClipboard: options?.copyToClipboard,
					stateHolder: context.state,
					resolvePresentation,
					invalidate: () => context.invalidate(),
				})
			: undefined;

	const children: ToolViewChild[] = nestedChildren(resolvedCalls);

	const collapsedRows =
		codemodeNestedView !== undefined
			? codemodeNestedView
			: isMetaTool && nestedCalls.length > 0
				? nestedCalls.map((call) => formatNestedCallRow(call, theme, context.cwd))
				: undefined;

	const toolRailToken: RailColorToken = isError
		? "error"
		: renderOptions.isPartial
			? "accent"
			: "success";

	// Upper room (input code) uses neutral/muted rail; lower room (output) uses toolRailToken (success/error)
	const inputSection = createInputCodeSection(toolName, context.args, theme, "muted");
	const sections: RailSection[] = [];
	if (inputSection !== undefined) {
		sections.push(inputSection);
	} else {
		const preview = formatArgsPreview(context.args);
		if (preview !== "" && preview !== "{}") {
			sections.push({ railToken: "muted", content: preview });
		}
	}

	if (toolName === "codemode") {
		// Nested tool calls belong only to collapsedRows (Level 0), hidden when expanded
		if (rawOutput !== "") {
			const rawLines = rawOutput.replace(/\r/g, "").replace(/\t/g, "  ").split("\n");
			const outputLines = isError
				? rawLines.map((line) => theme.fg("error", line))
				: rawLines.map((line) => theme.fg("dim", line));
			sections.push({
				railToken: toolRailToken,
				content: outputLines,
			});
		}
	} else if (originalRenderResult !== undefined) {
		const viewProbe = new ToolView({
			background: () => runtime.backgrounds,
			theme,
			header: { title: toolName },
			stateHolder: context.state,
			defaultLevel,
			globalExpanded: renderOptions.expanded,
		});
		const effectiveExpanded = viewProbe.effectiveLevel === 2;
		const effectiveOptions: ToolRenderResultOptions = {
			...renderOptions,
			expanded: effectiveExpanded,
		};
		let lastUpstreamComponent: Component | undefined;
		const lazyUpstreamComponent: Component = {
			render(w: number): string[] {
				const upstreamContext: ToolRenderContext = {
					...context,
					lastComponent: lastUpstreamComponent,
					// This frame indents the rows it embeds, so the renderer it wraps must not indent
					// them again: the pad is applied once, by the outermost shell.
					outputPad: 0,
				};
				const comp = originalRenderResult(result, effectiveOptions, theme, upstreamContext);
				lastUpstreamComponent = comp;
				return comp.render(w);
			},
			invalidate(): void {},
		};
		sections.push({
			railToken: toolRailToken,
			content: lazyUpstreamComponent,
			maxLines: effectiveExpanded ? Number.POSITIVE_INFINITY : undefined,
		});
	} else if (rawOutput !== "") {
		const rawLines = rawOutput.split("\n");
		const outputLines = isError
			? rawLines.map((line) => theme.fg("error", line))
			: rawLines.map((line) => theme.fg("dim", line));
		sections.push({
			railToken: toolRailToken,
			content: outputLines,
		});
	}
	let copy: ToolViewCopySpec | undefined;
	if (toolName === "codemode") {
		copy = undefined;
	} else if (heavyCmd !== undefined) {
		const cleanOutput = stripTerminalSequences(rawOutput);
		copy = {
			primary: heavyCmd,
			full: rawOutput !== "" ? `${heavyCmd}\n---\n${cleanOutput}` : heavyCmd,
		};
	} else if (rawOutput !== "") {
		const cleanOutput = stripTerminalSequences(rawOutput);
		const argsFormatted = formatArgsPreview(context.args);
		copy = {
			primary: cleanOutput,
			full: argsFormatted !== "" ? `${argsFormatted}\n\n${cleanOutput}` : cleanOutput,
		};
	}

	return new ToolView({
		background: () => runtime.backgrounds,
		theme,
		header: { title: toolName, status, ...header },
		railToken: toolRailToken,
		collapsedRows,
		...(children.length === 0 ? {} : { children }),
		// A container with child facts states its effective count, including zero: a container whose
		// children all failed to resolve is not one call.
		...(childCalls.length === 0 ? {} : { childCount: resolvedCalls.length }),
		sections,
		copy: () => (runtime.copyControl ? copy : undefined),
		outputPad: context.outputPad,
		stateHolder: context.state,
		defaultLevel,
		globalExpanded: renderOptions.expanded,
		invalidate: () => context.invalidate(),
		copyToClipboard: options?.copyToClipboard,
	});
}

/**
 * The generic frame around one owner's presentation. The caller already resolved it, so a frame
 * pass never asks the tool to rebuild its rows.
 */
function renderOwnedPresentation(params: {
	readonly runtime: ToolUiRuntime;
	readonly toolName: string;
	readonly presentation: ToolPresentation;
	readonly result?: AgentToolResult<unknown>;
	readonly theme: Theme;
	readonly context: ToolRenderContext;
	readonly defaultLevel: FoldLevel;
	readonly resolvePresentation?:
		| ((toolName: string) => ToolPresentationProvider | undefined)
		| undefined;
	readonly resolveNativeRenderer?: ((toolName: string) => ToolRenderers | undefined) | undefined;
	readonly options: CollapsibleToolRendererOptions | undefined;
}): ToolView {
	const {
		runtime,
		toolName,
		presentation,
		result,
		theme,
		context,
		defaultLevel,
		resolvePresentation,
		resolveNativeRenderer,
		options,
	} = params;
	const isError = context.isError || result?.isError === true;
	const pending = result === undefined || context.isPartial;
	const isDiff = !isError && !pending && presentation.kind === "diff";
	// A container's children are facts: the provider states the ones it finished, and the tracker
	// already holds the one still running, so the row can show work the tool has not reported yet.
	const captured =
		runtime.tracker.getCaptured(context.toolCallId) ??
		(result !== undefined &&
		isRecord(result.details) &&
		Array.isArray(result.details.__piExtUiCapturedCalls)
			? (result.details.__piExtUiCapturedCalls as CapturedToolCall[])
			: undefined);
	const ownCalls =
		presentation.children === undefined
			? extractNestedCalls(result)
			: presentationChildCalls(presentation.children);
	const childCalls = withSessionArgs(captured ?? ownCalls, runtime);
	// The tool owns its status: a container says "none" for a child's failure and a partial patch
	// says "warn" even though the host marks the result failed. Only a provider without an opinion
	// falls back to the frame's own reading of the execution.
	const status: ToolStatusKind =
		presentation.status ??
		(isError
			? "error"
			: // Child rows carry the work, so the container's own glyph is the fold pin only.
				childCalls.length > 0
				? "none"
				: pending
					? context.argsComplete
						? "running"
						: "streaming"
					: isDiff
						? "none"
						: "ok");
	const railToken: RailColorToken = isError ? "error" : pending ? "accent" : "success";
	const output =
		isError && result !== undefined
			? agentResultText(result)
			: (presentation.output ?? (result === undefined ? "" : agentResultText(result)));
	const sections: RailSection[] = [...(presentation.sections ?? [])];
	if (presentation.sections === undefined && presentation.request) {
		sections.push({ railToken: "muted", content: stripTerminalSequences(presentation.request) });
	}
	if (presentation.sections !== undefined) {
		// Tool owns domain rows; this factory owns the frame and interaction only.
	} else if (isDiff) {
		if (presentation.diff.trim() !== "") {
			sections.push({
				railToken: "dim",
				content: new DiffView({
					theme,
					source: { kind: "unifiedPatch", text: presentation.diff },
				}),
			});
		}
	} else if (output !== "") {
		const rawLines = stripTerminalSequences(output).split("\n");
		const lang = nativeOutputLanguage(toolName, context.args);
		let styledLines: string[];
		if (isError) {
			styledLines = rawLines.map((line) => theme.fg("error", line));
		} else if (lang !== undefined) {
			try {
				styledLines = highlightCode(output.replace(/\t/g, "  "), lang);
			} catch {
				styledLines = rawLines.map((line) => theme.fg("toolOutput", line));
			}
		} else {
			styledLines = rawLines.map((line) => theme.fg("toolOutput", line));
		}
		sections.push({
			railToken,
			content: styledLines,
		});
	}
	const duration = result === undefined ? "" : formatDurationMs(context.durationMs);
	// The provider owns the request/output boundary; cleaning its payload here corrupts raw input.
	const copy =
		presentation.copy ??
		(isDiff && presentation.diff.trim() !== "" ? { primary: presentation.diff } : undefined);
	return new ToolView({
		background: () => runtime.backgrounds,
		theme,
		header: {
			title: toolName,
			status,
			summary: stripTerminalSequences(presentation.summary),
			...(duration === "" ? {} : { meta: duration }),
		},
		railToken,
		copy: () => (runtime.copyControl ? copy : undefined),
		// The tool owns the folded rows and their tones; the frame only sanitizes them for the host.
		collapsedRows: (() => {
			if (presentation.collapsedRows !== undefined) {
				return presentation.collapsedRows;
			}
			if (childCalls.length > 0) {
				return new NestedCallsView({
					calls: childCalls,
					theme,
					context,
					headerSummary: (childName, childArgs, childTheme) =>
						nativeHeaderSummary(childName, childArgs, childTheme, context.cwd)?.summary,
					resolveChildRenderer: (childName: string) => ({
						renderResult: (childResult, childOptions, childTheme, childCtx) => {
							const childProvider = resolvePresentation?.(childName);
							if (childProvider !== undefined) {
								return renderOwnedPresentation({
									runtime,
									toolName: childName,
									presentation: childProvider(childCtx.args, childResult, childTheme, childCtx),
									result: childResult,
									theme: childTheme,
									context: childCtx,
									defaultLevel: childOptions.expanded ? 2 : 1,
									resolvePresentation,
									resolveNativeRenderer,
									options,
								});
							}
							const registered = resolveNativeRenderer?.(childName);
							return renderGenericResult({
								runtime,
								toolName: childName,
								theme: childTheme,
								context: childCtx,
								result: childResult,
								renderOptions: childOptions,
								defaultLevel: childOptions.expanded ? 2 : 1,
								nativeArgsLine: registered?.renderCall !== undefined,
								originalRenderResult: registered?.renderResult,
								resolvePresentation,
								resolveNativeRenderer,
								options,
							});
						},
					}),
					copyToClipboard: options?.copyToClipboard,
					stateHolder: context.state,
					resolvePresentation,
					invalidate: () => context.invalidate(),
				});
			}
			return isError && output !== ""
				? output
						.split("\n")
						.slice(0, 1)
						.map((line) => theme.fg("error", stripTerminalSequences(line)))
				: undefined;
		})(),
		...(presentation.children === undefined
			? {}
			: {
					children: presentation.children
						.filter((child) => (child as { resolved?: boolean }).resolved !== false)
						.map((child) => ({
							...child,
							...(child.status === "warn"
								? { status: "warn" as const }
								: child.status === "error"
									? { status: "error" as const }
									: child.status === "running"
										? { status: "running" as const }
										: { status: "ok" as const }),
						})),
				}),
		...(presentation.childCount === undefined ? {} : { childCount: presentation.childCount }),
		sections,
		outputPad: context.outputPad,
		stateHolder: context.state,
		defaultLevel,
		globalExpanded: context.expanded,
		invalidate: () => context.invalidate(),
		copyToClipboard: options?.copyToClipboard,
	});
}

export function createCollapsibleToolRendererResolver(
	runtime: ToolUiRuntime,
	options?: CollapsibleToolRendererOptions,
): ToolRendererResolver {
	return createRendererResolver(runtime, options);
}

function createRendererResolver(
	runtime: ToolUiRuntime,
	options?: CollapsibleToolRendererOptions,
	resolvePresentation?: (toolName: string) => ToolPresentationProvider | undefined,
	resolveNativeRenderer?: (toolName: string) => ToolRenderers | undefined,
): ToolRendererResolver {
	const defaultLevel: FoldLevel = options?.defaultCollapsed === false ? 1 : 0;

	return (toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined => {
		const upstream = next();
		if (hasOptionalToolRenderers(upstream)) return upstream;
		const provider = getToolPresentationProvider(upstream) ?? resolvePresentation?.(toolName);
		if (provider === undefined && !shouldInterceptTool(toolName, options)) {
			return upstream;
		}

		const registeredNative = resolveNativeRenderer?.(toolName);
		const nativeArgsLine =
			upstream?.renderCall !== undefined || registeredNative?.renderCall !== undefined;
		const originalRenderResult = upstream?.renderResult ?? registeredNative?.renderResult;

		return {
			renderShell: "self",
			renderCall(args, theme, context: ToolRenderContext) {
				runtime.rememberRow(context.toolCallId, context.invalidate);
				if (provider !== undefined) {
					const callContext = { ...context, args };
					const view = renderOwnedPresentation({
						runtime,
						toolName,
						presentation: provider(args, undefined, theme, callContext),
						theme,
						context: callContext,
						defaultLevel,
						resolvePresentation,
						resolveNativeRenderer,
						options,
					});
					rememberCallView(context, view);
					return view;
				}
				const isStreamingArgs = context.isPartial && !context.argsComplete;
				const status: ToolStatusKind = context.isError
					? "error"
					: isStreamingArgs
						? "streaming"
						: "running";

				const streamedTokens = isStreamingArgs ? estimateStreamingTokens(args) : 0;
				const header = isStreamingArgs
					? { summary: streamedTokens > 0 ? `· ${String(streamedTokens)} tokens` : "" }
					: toolHeaderFacts({ toolName, args, theme, cwd: context.cwd, facts: [], nativeArgsLine });

				const heavyCmd = nativeHeavyRequest(toolName, args);
				const sections: RailSection[] = [];
				const inputSection = createInputCodeSection(toolName, args, theme);
				if (inputSection !== undefined) {
					sections.push(inputSection);
				} else {
					const preview = formatArgsPreview(args);
					if (preview !== "" && preview !== "{}") {
						sections.push({
							railToken: "muted",
							content: preview,
						});
					}
				}

				const copy: ToolViewCopySpec | undefined =
					heavyCmd !== undefined
						? { primary: heavyCmd }
						: formatArgsPreview(args) !== ""
							? { primary: formatArgsPreview(args) }
							: undefined;

				const view = new ToolView({
					background: () => runtime.backgrounds,
					theme,
					header: { title: toolName, status, ...header },
					sections,
					copy: () => (runtime.copyControl ? copy : undefined),
					outputPad: context.outputPad,
					stateHolder: context.state,
					defaultLevel,
					globalExpanded: context.expanded,
					invalidate: () => context.invalidate(),
					copyToClipboard: options?.copyToClipboard,
				});
				rememberCallView(context, view);
				return view;
			},
			renderResult(result, renderOptions, theme, context) {
				runtime.rememberRow(context.toolCallId, context.invalidate);
				const resultContext = {
					...context,
					expanded: renderOptions.expanded,
					isPartial: renderOptions.isPartial,
				};
				const presentation =
					provider === undefined
						? undefined
						: provider(resultContext.args, result, theme, resultContext);
				// Without an owner, a container frame is the only name-based decision left, and it
				// belongs to upstream codemode.
				hideCallView(context);
				if (presentation !== undefined) {
					return renderOwnedPresentation({
						runtime,
						toolName,
						presentation,
						result,
						theme,
						context: resultContext,
						defaultLevel,
						resolvePresentation,
						options,
					});
				}

				return renderGenericResult({
					runtime,
					toolName,
					theme,
					context,
					result,
					renderOptions,
					defaultLevel,
					nativeArgsLine,
					originalRenderResult,
					resolvePresentation,
					resolveNativeRenderer,
					options,
				});
			},
		};
	};
}

/** UI factory consumed by package-owned direct renderers, independently of host resolver precedence. */
export function createOptionalToolRendererFactory(
	pi: ExtensionAPI,
	runtime: ToolUiRuntime,
	options?: CollapsibleToolRendererOptions,
): import("@hheei/pi-ext-core").ToolRendererFactory {
	return (name, native) =>
		createRendererResolver(
			runtime,
			{ ...options, tools: [name] },
			(toolName) => getRegisteredToolPresentationProvider(pi, toolName),
			(toolName) => getRegisteredToolRenderers(pi, toolName),
		)(name, () => native) ?? native;
}

/**
 * Save the resolution facts of one model-issued call on its own tool result. The host emits
 * `tool_call` only after the tool resolved and its arguments validated, so these ids are proof;
 * writing them into the details keeps the fact with the call through resume, fork and reload.
 */
function withResolvedCallFacts(
	event: {
		toolCallId: string;
		parentToolCallId?: string | undefined;
		details?: unknown;
	},
	runtime: ToolUiRuntime,
): unknown {
	if (event.parentToolCallId !== undefined) return undefined;
	const ids = runtime.tracker.getResolved(event.toolCallId);
	if (ids === undefined || ids.size === 0) return undefined;
	if (!isRecord(event.details)) return undefined;
	return { ...event.details, [RESOLVED_CALLS_KEY]: [...ids] };
}

export function registerCollapsibleToolRenderer(
	pi: ExtensionAPI,
	runtime: ToolUiRuntime,
	options?: CollapsibleToolRendererOptions,
): () => void {
	const disposers: (() => void)[] = [
		pi.on("tool_execution_start", (event) => {
			runtime.tracker.recordStart(event);
			// A nested call has no row of its own until the container redraws, so the container is
			// rebuilt the moment the call starts rather than when its result arrives.
			runtime.repaintParent(event.parentToolCallId);
		}),
		pi.on("tool_execution_end", (event) => {
			runtime.tracker.recordEnd(event);
			if (event.parentToolCallId === undefined) runtime.forgetRow(event.toolCallId);
			else runtime.repaintParent(event.parentToolCallId);
		}),
		pi.on("tool_call", (event) => {
			runtime.tracker.recordResolved(event);
		}),
		pi.on("tool_result", (event) => {
			const details = withResolvedCallFacts(event, runtime);
			if (details === undefined) return undefined;
			// The hook replaces the whole result, so the fields it does not own pass through.
			return {
				details,
				...(event.structuredContent === undefined
					? {}
					: { structuredContent: event.structuredContent }),
				...(event.usage === undefined ? {} : { usage: event.usage }),
			};
		}),
	];
	pi.registerToolRenderer(
		createRendererResolver(
			runtime,
			options,
			(name) => getRegisteredToolPresentationProvider(pi, name),
			(name) => getRegisteredToolRenderers(pi, name),
		),
	);
	return () => {
		for (const dispose of disposers) dispose();
	};
}
