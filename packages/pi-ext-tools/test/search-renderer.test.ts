import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { GrepDisplayLine, GrepSubmatch, GrepToolDetails } from "../src/grep.js";
import { renderFindResult, renderGrepResult } from "../src/search-renderer.js";
import { plainTheme } from "./fixtures/theme.js";

/** The details these tests need; `GrepToolDetails` also carries a budget report nobody here reads. */
type FixtureDetails = Pick<
	GrepToolDetails,
	"format" | "engine" | "events" | "display" | "totalMatched" | "totalFiles" | "totalLines"
>;

/** One match row; the fields this renderer ignores keep their defaults. */
function matchLine(args: {
	readonly source: string;
	readonly lineNumber?: number;
	readonly submatches?: readonly GrepSubmatch[];
}): GrepDisplayLine {
	return {
		type: "match",
		lineNumber: args.lineNumber ?? 1,
		text: args.source,
		source: args.source,
		visibleStart: 0,
		visibleEnd: args.source.length,
		truncatedLeft: false,
		truncatedRight: false,
		submatches: args.submatches ?? [],
	};
}

function grepResult(
	display: readonly GrepDisplayLine[],
	overrides: Partial<FixtureDetails> = {},
): AgentToolResult<unknown> {
	const details = {
		format: "canonical-grep",
		engine: "rg",
		events: [],
		totalMatched: 1,
		totalFiles: 1,
		totalLines: 1,
		display,
	} satisfies FixtureDetails;
	return {
		content: [{ type: "text", text: "1 match in 1 file" }],
		details: { ...details, ...overrides },
	};
}

function rendered(result: AgentToolResult<unknown>, expanded = false): string {
	const component = renderGrepResult(result, { expanded, isPartial: false }, plainTheme, {
		isError: false,
		lastComponent: undefined,
		keyText: () => "ctrl+o",
	});
	return stripTerminalSequences(component.render(80).join("\n"));
}

describe("search-renderer", () => {
	it("renders a match line far wider than the terminal", () => {
		const source = `const payload = "${"x".repeat(25_000)}";`;
		const result = grepResult([
			matchLine({ source, submatches: [{ start: 6, end: 13, text: "payload" }] }),
		]);

		const output = rendered(result);

		// How long this takes is measured by a benchmark, not here: a wall-clock floor in a test only
		// reports how busy the machine was. What this input pins is that the widest line the grep tool
		// can hand over is still rendered width-safe and keeps its match.
		expect(output).toContain("payload");
		for (const line of output.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	it("maps a match's byte offsets onto characters in multibyte text", () => {
		const source = "const msg = '你好 🌍 世界 🚀';";
		const result = grepResult([
			matchLine({ source, lineNumber: 42, submatches: [{ start: 0, end: 5, text: "const" }] }),
		]);

		expect(rendered(result, true)).toContain(source);
	});

	it("groups find candidates by directory and summarizes them", () => {
		const candidates = [
			{ path: "src/tools/find.ts", matchType: "exact" },
			{ path: "src/tools/grep.ts", matchType: "exact" },
			{ path: "src/root.ts", matchType: "exact" },
		];
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "3 files found" }],
			details: {
				format: "canonical-find",
				candidates,
				totalMatched: 3,
				totalFiles: 3,
			},
		};

		const output = stripTerminalSequences(
			renderFindResult(result, { expanded: true, isPartial: false }, plainTheme, {
				isError: false,
				lastComponent: undefined,
				keyText: () => "ctrl+o",
			})
				.render(80)
				.join("\n"),
		);

		expect(output).toContain("src/tools/");
	});

	it("prints the host's configured expand key in the find omission hint", () => {
		const candidates = Array.from({ length: 30 }, (_, index) => ({
			path: `src/dir-${index}/file.ts`,
			matchType: "exact",
		}));
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: `${candidates.length} files found` }],
			details: {
				format: "canonical-find",
				candidates,
				totalMatched: candidates.length,
				totalFiles: candidates.length,
			},
		};

		const output = stripTerminalSequences(
			renderFindResult(result, { expanded: false, isPartial: false }, plainTheme, {
				isError: false,
				lastComponent: undefined,
				keyText: () => "ctrl+x",
			})
				.render(80)
				.join("\n"),
		);

		expect(output).toContain("ctrl+x to expand");
	});
});
