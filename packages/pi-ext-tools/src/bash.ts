import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
	type AgentToolResult,
	createBashToolDefinition,
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ToolDefinition,
	type ToolLoadout,
	type ToolLoadoutChanges,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Keybinding,
	stripTerminalSequences,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	agentResultText,
	BashOutputSink,
	createOptionalToolRenderers,
	createRenderThrottle,
	formatDuration,
	isRecord,
	isSearchOnlyCommand,
	SEARCH_BASH_TIMEOUT_SECONDS,
	textToolResult,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type BashSettings, DEFAULT_BASH_SETTINGS } from "./bash-settings.js";

/** Unexpanded output rows. Matches the request cap so a command and its output weigh the same. */
const BASH_MAX_BODY_LINES = 10;

const BASH_DESCRIPTION = "Run one shell command or short pipeline in the foreground.";
const BASH_TIMEOUT_DESCRIPTION =
	"Timeout in seconds (optional, default 180s, or 25s for pure search commands like rg/fd/grep/find)";
const Timeout = Type.Optional(Type.Number({ description: BASH_TIMEOUT_DESCRIPTION }));
const BashInput = Type.Object(
	{
		command: Type.String({ minLength: 1 }),
		timeout: Timeout,
	},
	{ additionalProperties: false },
);
type Input = Static<typeof BashInput>;

/** A `null` timeout means the same as an absent one. Nothing else is repaired here. */
function normalizeBashInput(value: unknown): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
	const input = { ...(value as Record<string, unknown>) };
	if (input.timeout === null) delete input.timeout;
	return input;
}

/**
 * A NUL byte cannot survive argv, and rewriting it to `\0` guesses at shell syntax the target program
 * may not share: `printf "%s" a<NUL>b` prints `a0b` after that rewrite, and a command that writes files
 * would silently act on different arguments. Refusing it keeps the caller's own escape intact.
 */
function rejectNulByte(command: string): void {
	if (!command.includes("\0")) return;
	throw new Error(
		"The command contains a NUL byte (U+0000), which cannot be passed to a shell. Write the escape " +
			"your target program expects (for example \\0 for printf or tr) instead.",
	);
}

/** Every bash result carries the model-visible text plus tool-owned details. */
type BashToolResult = AgentToolResult<Record<string, unknown>>;

function detailsRecord(value: unknown): Readonly<Record<string, unknown>> {
	return isRecord(value) ? value : {};
}

function logicalOutputLines(output: string): string[] {
	if (output === "") return [];
	return output
		.replace(/\r?\n$/, "")
		.split("\n")
		.map((line) => line.replace(/\r/g, ""));
}

function outputTotalLines(result: AgentToolResult<unknown>, output: string): number {
	const total = detailsRecord(result.details).totalLines;
	if (typeof total === "number" && Number.isFinite(total)) return total;
	return output === "" ? 0 : output.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

/** Matches upstream bashOutputSchema in @earendil-works/pi-coding-agent */
export interface BashToolOutput {
	output: string;
	truncated: boolean;
	exit_code: number;
	wall_time_seconds: number;
}

function withBashStructuredContent(
	result: AgentToolResult<unknown>,
	options: {
		output: string;
		truncated: boolean;
		exitCode: number;
		startedAt: number;
	},
): AgentToolResult<unknown> {
	const wallTimeSeconds = Math.round((performance.now() - options.startedAt) / 100) / 10;
	const structuredContent: BashToolOutput = {
		output: options.output,
		truncated: options.truncated,
		exit_code: options.exitCode,
		wall_time_seconds: wallTimeSeconds,
	};
	return {
		...result,
		structuredContent: structuredContent as never,
		...(options.exitCode !== 0 ? { isError: true } : {}),
	};
}

/**
 * The text a failed call shows the model. Providers send only a tool result's text parts, so the
 * reason has to live here rather than in details, with whatever partial output the command produced
 * above it, the way upstream bash reports a failure.
 */
function bashFailureText(reason: string, output: string): string {
	const body = output.trimEnd();
	return body === "" ? reason : `${body}\n\n${reason}`;
}

/**
 * One cancelled call: partial output, the reason, and how long the command ran. `startedAt` is
 * omitted when the signal was already aborted before the command started, because "aborted after
 * 0ms" describes nothing the model can use.
 */
function bashAbortedResult(options: {
	output: string;
	startedAt?: number;
	truncated?: boolean;
}): BashToolResult {
	const elapsed =
		options.startedAt === undefined
			? undefined
			: formatDuration(performance.now() - options.startedAt);
	const text = bashFailureText(
		elapsed === undefined ? "Bash aborted" : `Bash aborted after ${elapsed}`,
		options.output,
	);
	return withBashStructuredContent(
		textToolResult(text, {
			output: options.output,
			truncated: options.truncated ?? false,
			error: "aborted",
		}),
		{
			output: options.output,
			truncated: options.truncated ?? false,
			exitCode: 130,
			startedAt: options.startedAt ?? performance.now(),
		},
	) as BashToolResult;
}

/**
 * A command killed by its own timeout. The line names the budget that expired, which is what the
 * model needs to choose a longer one or a narrower command, so the elapsed time would only repeat
 * the same number back.
 */
function bashTimedOutResult(options: {
	output: string;
	startedAt: number;
	timeoutSeconds: number;
	truncated: boolean;
}): BashToolResult {
	const text = bashFailureText(
		`Command timed out after ${options.timeoutSeconds}s`,
		options.output,
	);
	return withBashStructuredContent(
		textToolResult(text, {
			output: options.output,
			truncated: options.truncated,
			timedOut: true,
			exitCode: 124,
			outcome: "timeout",
		}),
		{
			output: options.output,
			truncated: options.truncated,
			exitCode: 124,
			startedAt: options.startedAt,
		},
	) as BashToolResult;
}

function outputStreamer(
	sink: BashOutputSink,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): { readonly push: (data: Buffer) => void; readonly finish: () => void } {
	// Every chunk used to rebuild the whole tail snapshot and hand it to the host. Streaming
	// output arrives far faster than anyone can read it, so the snapshot is rebuilt on the
	// shared streaming window instead; the first chunk still paints immediately.
	const repaint = createRenderThrottle(() => {
		const output = sink.snapshot();
		onUpdate?.(textToolResult(output.output, output));
	});
	return {
		push: (data: Buffer): void => {
			sink.push(data);
			repaint.request();
		},
		// The last chunk usually lands inside an open window, so the trailing snapshot is delivered
		// before the window closes. Disposal alone would drop it: the result that follows is the only
		// authority for the finished call, but the model still has to see the output it reports.
		finish: (): void => {
			repaint.flush();
			repaint.dispose();
		},
	};
}

/**
 * Bash's own result body. The result text is already exactly what the model sees, so the body
 * renders it directly and caps it to the shared collapsed height instead of delegating to a second
 * upstream presentation of the same text.
 */
class BashOutputBody implements Component {
	private cached: { readonly width: number; readonly rows: string[] } | undefined;

	constructor(
		private readonly output: string,
		private readonly theme: Theme,
		private readonly expanded: boolean,
		private readonly totalLines: number,
		private readonly isError: boolean,
		private readonly durationMs: number | undefined,
		/** The host's configured expand key plus our label, so a remap stays accurate. */
		private readonly expandHint: string,
	) {}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.rows;
		const lines = logicalOutputLines(this.output);
		const available = Math.max(1, width);
		const truncation = this.theme.fg("dim", "…");
		const style = this.isError ? "error" : "toolOutput";
		const budget = this.expanded ? lines.length : BASH_MAX_BODY_LINES;
		const hiddenTotal = Math.max(this.totalLines, lines.length);
		const needsHint = !this.expanded && hiddenTotal > budget;
		const take = needsHint ? Math.min(lines.length, budget - 1) : Math.min(lines.length, budget);
		const visible = lines.slice(-take);
		const hidden = hiddenTotal - visible.length;
		const body = visible.map((line) =>
			this.theme.fg(style, truncateToWidth(stripTerminalSequences(line), available, truncation)),
		);
		// Pi measures the duration of a finished call; live progress has none yet.
		const elapsed = formatDuration(this.durationMs);
		const footer = elapsed === undefined ? undefined : this.theme.fg("dim", `Took ${elapsed}`);
		const hint =
			needsHint && body.length > 0
				? [
						truncateToWidth(
							this.theme.fg("dim", `… (${hidden} earlier lines, ${this.expandHint})`),
							available,
							truncation,
						),
					]
				: [];
		const rows = [...hint, ...body, ...(footer === undefined ? [] : [footer])];
		this.cached = { width, rows };
		return rows;
	}

	invalidate(): void {
		this.cached = undefined;
	}
}

const DEFAULT_BASH_TIMEOUT_SECONDS = 180;

export function resolveDefaultBashTimeout(command: string): number {
	return isSearchOnlyCommand(command) ? SEARCH_BASH_TIMEOUT_SECONDS : DEFAULT_BASH_TIMEOUT_SECONDS;
}

async function runForeground(
	command: string,
	context: ExtensionContext,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
	settings: BashSettings,
	timeoutSeconds: number | undefined,
): Promise<BashToolResult> {
	const startedAt = performance.now();
	const effectiveTimeout = timeoutSeconds ?? resolveDefaultBashTimeout(command);
	if (signal?.aborted) return Promise.resolve(bashAbortedResult({ output: "" }));
	const sink = new BashOutputSink(settings.bashOutputTailKiB * 1024);
	const update = outputStreamer(sink, onUpdate);

	let exitCode: number | null;
	let timedOut = false;
	try {
		// Pi's local backend owns the process, its cancellation and its timeout teardown, so the
		// foreground path keeps no job registry and no record to release.
		exitCode = (
			await createLocalBashOperations({ shellPath: settings.shellPath }).exec(
				command,
				context.cwd,
				{
					onData: update.push,
					...(signal === undefined ? {} : { signal }),
					timeout: effectiveTimeout,
				},
			)
		).exitCode;
	} catch (error) {
		if (signal?.aborted) {
			const aborted = sink.finish();
			update.finish();
			return bashAbortedResult({
				output: aborted.output,
				startedAt,
				truncated: aborted.truncated,
			});
		}
		if (!(error instanceof Error) || !error.message.startsWith("timeout:")) throw error;
		timedOut = true;
		exitCode = null;
	}
	// The result is the only authority for the finished call, so the streaming window is closed
	// before it is built: a late repaint would rewrite the settled body.
	update.finish();
	const output = sink.finish();
	if (timedOut)
		return bashTimedOutResult({
			output: output.output,
			truncated: output.truncated,
			startedAt,
			timeoutSeconds: effectiveTimeout,
		});
	// A null exit means the shell died without reporting one. That is not success: the outcome
	// stays unconfirmed, and the call reports failure so the model inspects the side effects.
	if (exitCode === null) {
		const reason = "Command terminated without an exit code";
		const result = textToolResult(bashFailureText(reason, output.output), {
			...output,
			exitCode: null,
			error: "unconfirmed",
			isError: true,
		});
		return withBashStructuredContent(result, {
			output: output.output,
			truncated: output.truncated,
			exitCode: 1,
			startedAt,
		}) as BashToolResult;
	}
	const result = textToolResult(output.output, {
		...output,
		exitCode,
		...(exitCode === 0 ? {} : { isError: true }),
	});
	return withBashStructuredContent(result, {
		output: output.output,
		truncated: output.truncated,
		exitCode,
		startedAt,
	}) as BashToolResult;
}

export interface BashToolOptions {
	/** Live settings read per call, so a settings change applies to the next command. */
	readonly getSettings?: () => BashSettings;
}

export function registerBashTool(pi: ExtensionAPI, options?: BashToolOptions): ToolDefinition {
	const template = createBashToolDefinition(process.cwd());
	const tool = {
		...template,
		description: BASH_DESCRIPTION,
		promptSnippet: BASH_DESCRIPTION,
		parameters: BashInput,
		annotations: {
			openWorldHint: true,
			destructiveHint: true,
		},
		prepareLoadout(loadout: ToolLoadout): ToolLoadoutChanges {
			const declared = new Set(loadout.declared.map((t) => t.name));
			const hasEval = declared.has("python_eval");
			const hasCodemode = declared.has("codemode");
			if (hasEval && hasCodemode) {
				return {
					descriptions: {
						bash: `${BASH_DESCRIPTION} Prefer python_eval for persistent Python computation, and codemode for tool orchestration or filtering.`,
					},
				};
			}
			if (hasEval) {
				return {
					descriptions: {
						bash: `${BASH_DESCRIPTION} Prefer python_eval over python -c for multi-step computation.`,
					},
				};
			}
			if (hasCodemode) {
				return {
					descriptions: {
						bash: `${BASH_DESCRIPTION} Prefer codemode over complex shell loops or pipeline filtering.`,
					},
				};
			}
			return {};
		},
		...createOptionalToolRenderers(pi, "bash", {
			renderCall: template.renderCall as NonNullable<ToolDefinition["renderCall"]>,
			renderResult(
				result: AgentToolResult<unknown>,
				renderOptions: { readonly expanded: boolean; readonly isPartial: boolean },
				theme: Theme,
				context: {
					readonly durationMs?: number | undefined;
					readonly keyText: (keybinding: Keybinding) => string;
				},
			) {
				const output = agentResultText(result);
				return new BashOutputBody(
					output,
					theme,
					renderOptions.expanded,
					outputTotalLines(result, output),
					result.isError === true,
					context.durationMs,
					`${context.keyText("app.tools.expand")} to expand`,
				);
			},
		}),
		async execute(
			_id: string,
			params: Input,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			context: ExtensionContext,
		) {
			const validatedParams = normalizeBashInput(params);
			if (!Value.Check(BashInput, validatedParams)) throw new Error("Invalid bash parameters");
			rejectNulByte(validatedParams.command);
			return runForeground(
				validatedParams.command,
				context,
				signal,
				onUpdate,
				options?.getSettings?.() ?? DEFAULT_BASH_SETTINGS,
				validatedParams.timeout,
			);
		},
	} as unknown as ToolDefinition<typeof BashInput, unknown, unknown>;
	pi.registerTool(tool);

	return tool;
}

export { BashInput, isSearchOnlyCommand, SEARCH_BASH_TIMEOUT_SECONDS, Timeout };
