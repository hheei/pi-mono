import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ToolDefinition, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	createOptionalToolRenderers,
	createRenderThrottle,
	createToolPresentationRenderers,
	errorMessage,
	formatDuration,
	limitsForCalls,
	textToolResult,
	truncateWithSpill,
} from "@hheei/pi-ext-core";
import { Type } from "typebox";
import type { EvalNestedImage, EvalToolBridge } from "./bridge.js";
import type { EvalKernelState } from "./kernel/protocol.js";
import { evalCellState } from "./kernel/protocol.js";
import type { EvalRuntimeState } from "./lifecycle.js";
import {
	createPythonEvalPresentation,
	type EvalToolDetails,
	PYTHON_EVAL_DETAILS_FORMAT,
} from "./presentation.js";
import { CellTranscript } from "./transcript.js";

const MAX_CODE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;
/** Largest delay `setTimeout` supports, which bounds `timeout_ms` exactly like codemode's option. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const EVAL_DESCRIPTION =
	"Run trusted local Python in a persistent session kernel. Use python_eval for multi-step computation over one shared namespace: write a helper once and call it from later cells. Nested tools.name(...) calls are synchronous; do not await them. Every cell reports the names it added, so what the kernel holds stays visible across calls. This is not a sandbox. Do not write any comments in the code.";
const EVAL_CODE_DESCRIPTION =
	"Non-empty trusted source, at most 1 MiB. Do not write any comments in the code.";
const EVAL_TIMEOUT_DESCRIPTION =
	"Hard deadline for the whole cell, in milliseconds. Defaults to 180000 (180 seconds).";
export const PYTHON_EVAL_PROMPT_SNIPPET =
	"Persistent Python kernel. One cell per call; names and functions survive across cells until a cell reports the kernel restarted.";

export function pythonEvalPromptGuidelines(): string[] {
	return [
		"python_eval: use for computation, data wrangling, and inspecting values that should persist across cells.",
		"python_eval: use bash for one-shot shell, grep/find for search, and edit/write for file changes. Do not run JS/Python via bash -e/-c.",
		"python_eval: a cell that would repeat earlier work defines a function instead: `def load(path): ...` once, then `load(a)` and `load(b)` in later cells. Import, define, and load once, then keep using those names; each cell reports the names it added and any import it repeated.",
		"python_eval: re-run setup only when a cell reports the kernel restarted, or after reset: true.",
		"python_eval: use Python. Nested tools are synchronous: `result = tools.name(...)` with kwargs or a dict; do not use await. Top-level await is unsupported.",
		"python_eval: nested tools are read, grep, find, foreground bash, edit, write, and apply_patch. No python_eval, wait, or other extension tools. Nested bash rejects async.",
		"python_eval: nested tools return text strings, or structured dicts for tools declaring schemas (e.g. bash).",
		"python_eval: print/console go to the transcript. display() keeps JSON-safe values. The last expression is the result; undefined/None is omitted.",
		"python_eval: names() lists what the kernel holds. Check it before defining a name again, and call the helper you already wrote instead of pasting it.",
		"python_eval: reset: true wipes the Python kernel and scope. timeout_ms is a hard deadline for the whole cell, defaulting to 180000 (180 seconds); nested tool calls count toward it. On error, fix and re-run only the failing cell.",
		"python_eval: a compile-time SyntaxError prevents the entire cell from running, including assignments before the error. Fix and re-run the whole cell; use the reported namespace to check what survived runtime errors.",
		"python_eval: do not write any comments in the code. Write only executable code.",
	];
}

export const EVAL_PARAMETERS = Type.Object(
	{
		code: Type.String({
			minLength: 1,
			maxLength: MAX_CODE_BYTES,
			description: EVAL_CODE_DESCRIPTION,
		}),
		reset: Type.Optional(
			Type.Boolean({
				description: "Wipe the Python kernel before running.",
			}),
		),
		timeout_ms: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: MAX_TIMEOUT_MS,
				default: DEFAULT_TIMEOUT_MS,
				description: EVAL_TIMEOUT_DESCRIPTION,
			}),
		),
	},
	{ additionalProperties: false },
);

const activeRuns = new WeakSet<EvalRuntimeState>();

export function createPythonEvalTool(
	state: EvalRuntimeState,
	bridge: EvalToolBridge,
): ToolDefinition<typeof EVAL_PARAMETERS, EvalToolDetails> {
	return {
		name: "python_eval",
		label: "python_eval",
		description: EVAL_DESCRIPTION,
		promptSnippet: PYTHON_EVAL_PROMPT_SNIPPET,
		promptGuidelines: pythonEvalPromptGuidelines(),
		parameters: EVAL_PARAMETERS,
		exposure: "model-only",
		defaultActive: false,
		reachesTools: () => ["read", "bash", "edit", "write", "grep", "find", "apply_patch"],
		annotations: {
			openWorldHint: true,
		},
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, context) {
			if (params.code.trim() === "") throw new Error("Python_eval code must not be blank.");
			if (Buffer.byteLength(params.code) > MAX_CODE_BYTES)
				throw new Error("Python_eval code exceeds 1 MiB.");
			const runtime = state.getRuntime();
			if (runtime === undefined)
				throw new Error("Python_eval runtime is unavailable outside an active session.");
			if (activeRuns.has(state)) throw new Error("Python_eval is already running in this session.");
			const deadline = new EvalDeadline(params.timeout_ms ?? DEFAULT_TIMEOUT_MS);
			activeRuns.add(state);
			// The cell's transcript owns the raw output, the preview, and the line rules between them.
			// This function only submits events and reads the result.
			const transcript = new CellTranscript(() => repaint.request());
			const images: EvalNestedImage[] = [];
			const startedAt = performance.now();
			let failure: string | undefined;
			const runSignal = mergeAbortSignals(signal, deadline.signal);
			// A cell prints in small pieces, and every piece used to rebuild the whole transcript.
			// The repaint follows the shared streaming window instead; the result below stays the
			// only authority for what the finished call reports.
			const repaint = createRenderThrottle(() => {
				onUpdate?.(
					textToolResult(transcript.body(), {
						format: PYTHON_EVAL_DETAILS_FORMAT,
						rows: transcript.rows,
						calls: transcript.callsFact,
						durationMs: Math.round(performance.now() - startedAt),
					}),
				);
			});
			try {
				const run = await runtime.runWithHooks(
					params.code,
					{
						cwd: context.cwd,
						onText: (text) => {
							transcript.text(text);
						},
						onDisplay: (display) => {
							transcript.display(display);
						},
						onBackground: (text) => {
							transcript.background(text);
						},
						onDiagnostic: (text) => {
							transcript.state(text);
						},
						callTool: async (name, args) =>
							await bridge.call(name, args, context, runSignal, (trace, nestedImages) => {
								images.push(...nestedImages);
								transcript.tool(trace);
							}),
					},
					runSignal,
					params.reset === true,
				);
				if (run.restarted) transcript.state("kernel restarted — earlier names are gone");
				if (run.recovered !== undefined) transcript.state(run.recovered);
				if (run.state !== undefined) transcript.state(formatState(run.state));
				if (run.value !== undefined) transcript.result(run.value);
			} catch (error) {
				// A user cancellation reaches the model as bare text, so the elapsed time is the only
				// record of how long the cell ran. The deadline already names its own budget.
				const reason = errorMessage(error);
				const elapsed =
					runSignal?.aborted === true && deadline.signal.aborted !== true
						? formatDuration(performance.now() - startedAt)
						: undefined;
				failure = elapsed === undefined ? reason : `${reason.replace(/\.$/, "")} after ${elapsed}.`;
				// The failure is the row the user has to see, so it keeps its slot even when the detail cap
				// has already been reached.
				transcript.fail(failure);
				// A failed cell still reports what the kernel holds, so a NameError does not leave the
				// model guessing which names survived.
				const cellState = evalCellState(error);
				if (cellState !== undefined) transcript.state(formatState(cellState));
			} finally {
				activeRuns.delete(state);
				deadline.dispose();
				// The last rows usually land inside an open window, so the trailing snapshot is
				// delivered before the window closes; the result below is then the only authority for
				// the finished cell, and a repaint after it would rewrite a settled body.
				repaint.flush();
				repaint.dispose();
			}
			transcript.finish();
			const details = {
				format: PYTHON_EVAL_DETAILS_FORMAT,
				rows: transcript.rows,
				calls: transcript.callsFact,
				durationMs: Math.round(performance.now() - startedAt),
				...(failure === undefined ? {} : { error: failure }),
			};
			// The model body comes from the output ledger, not from the bounded preview: the preview
			// drops rows past its cap and cuts long lines, and a spilled file made of that would have
			// nothing left to recover. A cell that ran nested tools keeps a share per call, so a script
			// that read eight files is not cut to the width of one.
			const body = await truncateWithSpill(
				transcript.output(),
				"py",
				limitsForCalls(transcript.callsFact.total),
			);
			const result = textToolResult(body.text, details);
			return {
				...result,
				content: [...result.content, ...images],
				...(failure !== undefined ? { isError: true } : {}),
			};
		},
	};
}

/**
 * Registers python_eval with the rich presentation this package owns.
 *
 * The presentation is the single source of the cell's facts: status, summary, code input, transcript
 * sections, collapsed nested rows, and copy. A UI package consumes those facts through ext-core's
 * optional renderer point and draws the frame; without one, the native renderer shows the plain
 * transcript.
 */
export function registerPythonEvalTool(
	pi: ExtensionAPI,
	state: EvalRuntimeState,
	bridge: EvalToolBridge,
): ToolDefinition<typeof EVAL_PARAMETERS, EvalToolDetails> {
	const tool: ToolDefinition<typeof EVAL_PARAMETERS, EvalToolDetails> = {
		...createPythonEvalTool(state, bridge),
		...createPythonEvalRenderers(pi),
	};
	pi.registerTool(tool);
	return tool;
}

function createPythonEvalRenderers(pi: ExtensionAPI): ToolRenderers {
	return createOptionalToolRenderers(
		pi,
		"python_eval",
		createToolPresentationRenderers(pi, "python_eval", createPythonEvalPresentation),
	);
}

/** One line naming what the kernel holds, what the cell added, and what it imported again. */
function formatState(state: EvalKernelState): string {
	const more = (count: number, listed: number): string => (count > listed ? ", …" : "");
	const parts = [`state: ${String(state.names)} ${state.names === 1 ? "name" : "names"}`];
	if (state.addedCount > 0) {
		parts.push(`+${state.added.join(", ")}${more(state.addedCount, state.added.length)}`);
	}
	if (state.redundantCount > 0) {
		parts.push(
			`re-imported ${state.redundant.join(", ")}${more(state.redundantCount, state.redundant.length)}`,
		);
	}
	return parts.join(" · ");
}

function mergeAbortSignals(left?: AbortSignal, right?: AbortSignal): AbortSignal | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return AbortSignal.any([left, right]);
}

/**
 * A hard deadline for the whole cell, matching codemode's `timeout_ms`: it runs on the host clock and
 * keeps running while a nested tool call is in flight, so waiting on a tool cannot extend the cell.
 */
class EvalDeadline {
	readonly signal: AbortSignal;
	readonly #timer: ReturnType<typeof setTimeout>;

	constructor(ms: number) {
		const controller = new AbortController();
		this.signal = controller.signal;
		this.#timer = setTimeout(() => {
			controller.abort(new Error(`Execution timed out after ${ms} ms`));
		}, ms);
		this.#timer.unref?.();
	}

	dispose(): void {
		clearTimeout(this.#timer);
	}
}
