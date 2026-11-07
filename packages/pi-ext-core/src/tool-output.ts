import { randomBytes } from "node:crypto";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./record.js";

/** Pi's own line bound, re-exported so every package in the workspace names one number. */
export { DEFAULT_MAX_LINES };

/** Model cost is estimated at four characters per token, the ratio Pi's codemode already uses. */
export const CHARS_PER_TOKEN = 4;

/**
 * What one tool result may cost the model before the rest moves to a file. Every tool shares this
 * number: a result is a result, and the model should not need a different mental budget per tool.
 */
export const DEFAULT_MAX_TOKENS = 5_000;

/** The byte budget that token bound implies. Tool output is ASCII-heavy, so bytes track tokens. */
export const DEFAULT_MAX_BYTES = DEFAULT_MAX_TOKENS * CHARS_PER_TOKEN;

/** Ceiling for the call-count multiplier: no single result may grow past this. */
export const MAX_BUDGET_MULTIPLIER = 3;

/** Every spilled output lands in this one directory so a session never scatters temp files. */
const OUTPUT_DIR = join(tmpdir(), "pi-output");

/** Output can carry private data, so only the user may read the files. */
const OUTPUT_FILE_MODE = 0o600;

/** How many ids one spill may try before another process's file wins. */
const SPILL_ATTEMPTS = 5;

export interface ToolOutputLimits {
	readonly maxBytes: number;
	readonly maxLines: number;
}

/**
 * More tool calls behind one result means each of them may keep more: a cell that ran eight nested
 * tools has eight things the model asked to see, while a single call is one. The multiplier is
 * capped so a long script cannot grow a result without bound.
 */
export function budgetMultiplier(calls: number): number {
	if (!Number.isFinite(calls) || calls <= 1) return 1;
	if (calls <= 3) return 1.5;
	if (calls <= 7) return 2;
	return MAX_BUDGET_MULTIPLIER;
}

/** The limits a result gets when it stands for `calls` tool calls. */
export function limitsForCalls(
	calls: number,
	baseBytes: number = DEFAULT_MAX_BYTES,
): ToolOutputLimits {
	const multiplier = budgetMultiplier(calls);
	return { maxBytes: Math.round(baseBytes * multiplier), maxLines: DEFAULT_MAX_LINES };
}

export interface SpilledOutput {
	/** The text to show the model; unchanged when it fit. */
	readonly text: string;
	readonly truncated: boolean;
	/** Set only when the full text was written, so a caller never advertises a missing file. */
	readonly fullOutputPath?: string;
}

/**
 * True when `text` already fits, so a caller can keep the common path synchronous instead of
 * awaiting a spill that will not happen.
 */
export function fitsOutputBudget(
	text: string,
	limits: ToolOutputLimits = limitsForCalls(1),
): boolean {
	if (Buffer.byteLength(text, "utf8") > limits.maxBytes) return false;
	if (limits.maxLines === Number.POSITIVE_INFINITY) return true;
	return countLines(text) <= limits.maxLines;
}

/**
 * Start of the note every truncated result carries. The workspace-wide cap reads it to leave a
 * result alone that its owner already cut to a budget it could justify: a cell that ran eight
 * nested tools earned a wider one, and cutting it again at the single-call width would throw that
 * away.
 */
export const SPILL_NOTE_PREFIX = "[Full output:";

async function spill(text: string, prefix: string): Promise<string | undefined> {
	try {
		await mkdir(OUTPUT_DIR, { recursive: true, mode: 0o700 });
		// Another Pi process spills into the same directory, so an id it took first is retried instead
		// of losing this text: `wx` never follows a link someone else placed at the path, and it also
		// refuses to replace a file a concurrent writer just took.
		for (let attempt = 0; attempt < SPILL_ATTEMPTS; attempt += 1) {
			const path = join(OUTPUT_DIR, `${prefix}-${randomBytes(3).toString("hex")}.txt`);
			let handle: FileHandle;
			try {
				handle = await open(path, "wx", OUTPUT_FILE_MODE);
			} catch (error) {
				if (!isRecord(error) || error.code !== "EEXIST") throw error;
				continue;
			}
			try {
				await handle.writeFile(text, "utf8");
			} finally {
				await handle.close();
			}
			return path;
		}
		return undefined;
	} catch {
		// A missing file must not cost the model the text it can still read.
		return undefined;
	}
}

function countLines(text: string): number {
	let count = 1;
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) === 10) count += 1;
	}
	return count;
}

/** The nearest character start at or before `index`, so a UTF-8 sequence is never split. */
function boundaryAtOrBefore(bytes: Buffer, index: number): number {
	let at = Math.min(Math.max(index, 0), bytes.length);
	while (at > 0 && at < bytes.length && ((bytes[at] ?? 0) & 0xc0) === 0x80) at -= 1;
	return at;
}

/** The nearest character start at or after `index`, so a UTF-8 sequence is never split. */
function boundaryAtOrAfter(bytes: Buffer, index: number): number {
	let at = Math.min(Math.max(index, 0), bytes.length);
	while (at < bytes.length && ((bytes[at] ?? 0) & 0xc0) === 0x80) at += 1;
	return at;
}

interface HeadTailCut {
	readonly head: string;
	readonly tail: string;
	readonly omittedBytes: number;
	readonly omittedLines: number;
	readonly totalBytes: number;
	readonly totalLines: number;
}

/**
 * Keeps the beginning and the end of `text` and drops the middle, because both ends carry meaning
 * the model acts on: a head names what the output is, a tail carries the error or the final state.
 * Whole lines are preferred, but a single line past the budget is cut at a character boundary
 * rather than dropped.
 */
function cutHeadTail(text: string, limits: ToolOutputLimits): HeadTailCut | undefined {
	const bytes = Buffer.from(text, "utf8");
	const totalLines = countLines(text);
	if (bytes.length <= limits.maxBytes && totalLines <= limits.maxLines) return undefined;
	const headBudget = Math.floor(limits.maxBytes / 2);
	const tailBudget = limits.maxBytes - headBudget;
	const headEnd = boundaryAtOrBefore(bytes, headBudget);
	const tailStart = Math.max(headEnd, boundaryAtOrAfter(bytes, bytes.length - tailBudget));
	let head = bytes.subarray(0, headEnd).toString("utf8");
	let tail = bytes.subarray(tailStart).toString("utf8");
	// Drop the partial line each cut landed inside, unless that would throw away a one-line output.
	const headBreak = head.lastIndexOf("\n");
	if (headBreak >= 0 && tailStart > headEnd) head = head.slice(0, headBreak + 1);
	const tailBreak = tail.indexOf("\n");
	if (tailBreak >= 0 && tailStart > headEnd) tail = tail.slice(tailBreak + 1);
	// A result made of many tiny lines is bounded by lines too, so neither side may grow unchecked.
	const lineCap = Math.max(1, Math.floor(limits.maxLines / 2));
	head = head.split("\n").slice(0, lineCap).join("\n");
	const tailLines = tail.split("\n");
	tail = tailLines.slice(Math.max(0, tailLines.length - lineCap)).join("\n");
	return {
		head,
		tail,
		omittedBytes: bytes.length - Buffer.byteLength(head) - Buffer.byteLength(tail),
		omittedLines: Math.max(0, totalLines - countLines(head) - countLines(tail)),
		totalBytes: bytes.length,
		totalLines,
	};
}

function omissionNote(cut: HeadTailCut, path: string | undefined): string {
	const size =
		cut.omittedBytes >= 1024
			? `${String(Math.round(cut.omittedBytes / 1024))}KB`
			: `${String(cut.omittedBytes)} bytes`;
	const omitted = `… ${String(cut.omittedLines)} lines / ${size} omitted …`;
	return path === undefined
		? `${omitted}\n[Full output could not be saved.]`
		: `${omitted}\n${SPILL_NOTE_PREFIX} ${path}]`;
}

/**
 * Cuts `text` to the limits and keeps the rest on disk. A result is never refused for being large:
 * the model always gets the head, the tail, and the path to everything it did not see, which is
 * what makes an oversized output recoverable instead of a failed call.
 */
export async function truncateWithSpill(
	text: string,
	prefix: string,
	limits: ToolOutputLimits = limitsForCalls(1),
): Promise<SpilledOutput> {
	const cut = cutHeadTail(text, limits);
	if (cut === undefined) return { text, truncated: false };
	const path = await spill(text, prefix);
	return {
		text: `${cut.head}\n${omissionNote(cut, path)}\n${cut.tail}`,
		truncated: true,
		...(path === undefined ? {} : { fullOutputPath: path }),
	};
}
