import { Buffer } from "node:buffer";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	type AgentToolResult,
	createWriteToolDefinition,
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	agentResultText,
	createOptionalToolRenderers,
	createToolPresentationRenderers,
	isRecord,
	type ToolPresentation,
} from "@hheei/pi-ext-core";
import * as Diff from "diff";
import { type Static, Type } from "typebox";

export const MAX_HL_CHARS = 256 * 1024;
export const MAX_RENDER_LINES = 1000;

function normalizeLineEndings(text: string): string {
	if (!text.includes("\r")) return text;
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function summarize(a: number, d: number): string {
	const parts: string[] = [];
	if (a > 0) parts.push(`+${a}`);
	if (d > 0) parts.push(`-${d}`);
	return parts.length ? parts.join(" ") : "no changes";
}

const WRITE_RENDER_DETAILS = "__piExtToolsWrite";
const WRITE_VIEW_KEY = "__piExtToolsWriteView";

function createExecutionTool<TParams extends TypeBoxSchema, TDetails, TState>(
	factory: (cwd: string) => ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	const template = factory(process.cwd());
	return {
		...template,
		async execute(toolCallId, params, signal, onUpdate, context) {
			return factory(context.cwd).execute(toolCallId, params, signal, onUpdate, context);
		},
	};
}

const WRITE_PARAMETERS = Type.Object(
	{
		path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
		content: Type.String({ description: "Content to write to the file" }),
	},
	{ additionalProperties: false },
);

type WriteDefinition = ReturnType<typeof createWriteToolDefinition>;
type WriteArgs = Static<typeof WRITE_PARAMETERS>;
type WriteState = { targetExists?: { readonly path: string; readonly exists: boolean } };

/**
 * `renderCall` reruns on every streamed argument update and `existsSync` is a
 * synchronous syscall. The answer cannot change before this write runs, so the
 * row's renderer state keeps it for the row's lifetime.
 */
function _writeTargetExists(state: WriteState, cwd: string, path: string): boolean {
	const cached = state.targetExists;
	if (cached !== undefined && cached.path === path) return cached.exists;
	const exists = existsSync(resolvePath(cwd, path));
	state.targetExists = { path, exists };
	return exists;
}

type WriteDiffLine = {
	readonly type: "add" | "del" | "ctx" | "sep";
	readonly oldNum: number | null;
	readonly newNum: number | null;
	readonly content: string;
};

type WriteView =
	| {
			readonly kind: "diff";
			readonly summary: string;
			readonly language?: string | undefined;
			readonly added?: number;
			readonly removed?: number;
			readonly chars?: number;
			readonly lines?: readonly WriteDiffLine[];
	  }
	| {
			readonly kind: "new";
			readonly lines: number;
			readonly language?: string | undefined;
			readonly content?: string;
	  }
	| {
			readonly kind: "replace";
			readonly lines: number;
			readonly language?: string | undefined;
			readonly content?: string;
	  }
	| { readonly kind: "noChange" };

function filePath(args: WriteArgs): string {
	return typeof args.path === "string" ? args.path : "";
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : join(cwd, path);
}

function readTextIfSmall(path: string): { exists: boolean; text?: string } {
	try {
		const size = statSync(path).size;
		if (size > MAX_HL_CHARS) return { exists: true };
		return { exists: true, text: readFileSync(path, "utf-8") };
	} catch {
		return { exists: false };
	}
}

function countContentLines(content: string): number {
	let len = content.length;
	while (len > 0) {
		const c = content.charCodeAt(len - 1);
		if (c === 10 || c === 13) len -= 1;
		else break;
	}
	if (len === 0) return 0;
	let count = 1;
	for (let i = 0; i < len; i++) {
		if (content.charCodeAt(i) === 10) count += 1;
	}
	return count;
}

function writeMetrics(args: WriteArgs): { bytes: number; lines: number } | undefined {
	if (typeof args.content !== "string") return undefined;
	return { bytes: Buffer.byteLength(args.content), lines: countContentLines(args.content) };
}

function withWriteDetails(
	result: AgentToolResult<unknown>,
	metrics: { bytes: number; lines: number } | undefined,
	view: WriteView | undefined,
	patch?: string,
): AgentToolResult<unknown> {
	const details = isRecord(result.details) ? result.details : {};
	return {
		...result,
		details: {
			...details,
			...(metrics === undefined ? {} : { [WRITE_RENDER_DETAILS]: metrics }),
			...(view === undefined ? {} : { [WRITE_VIEW_KEY]: view }),
			...(patch === undefined ? {} : { patch }),
		},
	};
}

function _readWriteMetrics(
	result: AgentToolResult<unknown>,
): { bytes: number; lines: number } | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const value = (details as Record<string, unknown>)[WRITE_RENDER_DETAILS];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return typeof (value as Record<string, unknown>).bytes === "number" &&
		typeof (value as Record<string, unknown>).lines === "number"
		? {
				bytes: (value as { bytes: number }).bytes,
				lines: (value as { lines: number }).lines,
			}
		: undefined;
}

function _writeView(result: AgentToolResult<unknown>): WriteView | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const value = (details as Record<string, unknown>)[WRITE_VIEW_KEY];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const kind = (value as Record<string, unknown>).kind;
	return kind === "diff" || kind === "new" || kind === "replace" || kind === "noChange"
		? (value as WriteView)
		: undefined;
}

function persistWriteDiff(oldText: string, newText: string): Extract<WriteView, { kind: "diff" }> {
	const patch = Diff.structuredPatch(
		"",
		"",
		normalizeLineEndings(oldText),
		normalizeLineEndings(newText),
		"",
		"",
		{ context: 3 },
	);
	const lines: {
		type: "add" | "del" | "ctx" | "sep";
		oldNum: number | null;
		newNum: number | null;
		content: string;
	}[] = [];
	let added = 0;
	let removed = 0;
	for (let hi = 0; hi < patch.hunks.length; hi++) {
		const h = patch.hunks[hi];
		if (!h) continue;
		if (hi > 0) {
			const prev = patch.hunks[hi - 1];
			const gap = prev ? h.oldStart - (prev.oldStart + prev.oldLines) : 0;
			lines.push({ type: "sep", oldNum: null, newNum: gap > 0 ? gap : null, content: "" });
		}
		let oL = h.oldStart;
		let nL = h.newStart;
		for (const raw of h.lines) {
			if (raw === "\\ No newline at end of file") continue;
			const ch = raw[0];
			const text = raw.slice(1);
			if (ch === "+") {
				lines.push({ type: "add", oldNum: null, newNum: nL++, content: text });
				added++;
			} else if (ch === "-") {
				lines.push({ type: "del", oldNum: oL++, newNum: null, content: text });
				removed++;
			} else {
				lines.push({ type: "ctx", oldNum: oL++, newNum: nL++, content: text });
			}
		}
	}
	return {
		kind: "diff",
		summary: summarize(added, removed),
		added,
		removed,
		chars: oldText.length + newText.length,
		lines: lines.slice(0, MAX_RENDER_LINES),
	};
}

function writePresentation(
	path: string,
	args: WriteArgs,
	baseline: { readonly exists: boolean; readonly text?: string },
): {
	readonly metrics: { bytes: number; lines: number } | undefined;
	readonly view: WriteView;
	readonly patch?: string;
} {
	const content = typeof args.content === "string" ? args.content : "";
	const old = baseline.text;
	const metrics = writeMetrics(args);
	const preview = { lines: metrics?.lines ?? 0 };
	const isDiff =
		baseline.exists &&
		old !== undefined &&
		content.length <= MAX_HL_CHARS &&
		normalizeLineEndings(old) !== normalizeLineEndings(content);
	const view: WriteView = !baseline.exists
		? { kind: "new", ...preview }
		: isDiff
			? persistWriteDiff(old, content)
			: old !== undefined && normalizeLineEndings(old) === normalizeLineEndings(content)
				? { kind: "noChange" }
				: { kind: "replace", ...preview };
	const patch = isDiff ? Diff.createPatch(path, old, content, "", "", { context: 3 }) : undefined;
	return { metrics, view, ...(patch === undefined ? {} : { patch }) };
}

export function createWritePresentation(
	args: unknown,
	result: AgentToolResult<unknown> | undefined,
	_theme: Theme,
): ToolPresentation {
	const path =
		typeof args === "object" && args !== null && "path" in args && typeof args.path === "string"
			? args.path
			: "";
	if (result === undefined) {
		return { kind: "text", summary: `write ${path}` };
	}
	const isError = result.isError === true;
	if (isError) {
		return { kind: "text", summary: `write ${path}`, output: agentResultText(result) };
	}
	const details = isRecord(result.details) ? result.details : undefined;
	const patch = typeof details?.patch === "string" ? details.patch : undefined;
	const view = _writeView(result);
	const metrics = _readWriteMetrics(result);
	if (patch !== undefined && patch.trim() !== "" && view && view.kind === "diff") {
		const additions = typeof view.added === "number" ? view.added : 0;
		const deletions = typeof view.removed === "number" ? view.removed : 0;
		const stats = { additions, deletions };
		return {
			kind: "diff",
			path,
			diff: patch,
			stats,
			summary: `${path} (+${stats.additions} -${stats.deletions})`,
			copy: { primary: patch },
		};
	}
	if (view?.kind === "new") {
		const lines = metrics?.lines ?? 0;
		const content =
			typeof args === "object" &&
			args !== null &&
			"content" in args &&
			typeof args.content === "string"
				? args.content
				: "";
		return {
			kind: "text",
			summary: `${path} (new file (${lines} lines))`,
			...(content ? { copy: { primary: content } } : {}),
		};
	}
	if (view?.kind === "noChange") {
		return {
			kind: "text",
			summary: `${path} (no changes)`,
		};
	}
	return {
		kind: "text",
		summary: path,
		output: agentResultText(result),
	};
}

type TypeBoxSchema = import("typebox").TSchema;

export function registerWriteTool(pi: ExtensionAPI): ToolDefinition {
	const baseTool = createExecutionTool(createWriteToolDefinition) as ToolDefinition<
		WriteDefinition["parameters"],
		unknown,
		WriteState
	>;
	const tool: ToolDefinition<typeof WRITE_PARAMETERS, unknown, WriteState> = {
		...baseTool,
		parameters: WRITE_PARAMETERS,
		...createOptionalToolRenderers(
			pi,
			"write",
			createToolPresentationRenderers(pi, "write", createWritePresentation),
		),
		annotations: {
			destructiveHint: true,
			idempotentHint: true,
		},
		async execute(toolCallId, params: WriteArgs, signal, onUpdate, context) {
			const path = filePath(params);
			const resolved = resolvePath(context.cwd, path);
			const baseline = path === "" ? { exists: false } : readTextIfSmall(resolved);
			const result = await baseTool.execute(toolCallId, params, signal, onUpdate, context);
			const presentation = writePresentation(path, params, baseline);
			return withWriteDetails(result, presentation.metrics, presentation.view, presentation.patch);
		},
	};
	pi.registerTool(tool as ToolDefinition);
	return tool as ToolDefinition;
}
