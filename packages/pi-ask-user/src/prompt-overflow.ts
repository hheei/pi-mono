import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, truncateToWidth } from "@earendil-works/pi-tui";

export function applyOverflowMarkers(
	theme: Theme,
	lines: string[],
	width: number,
	hasHiddenAbove: boolean,
	hasHiddenBelow: boolean,
): string[] {
	if (lines.length === 0) return lines;

	const marker = (line: string, glyph: string) =>
		truncateToWidth(`${theme.fg("dim", glyph)} ${line}`, width, "", true);

	const marked = [...lines];
	if (hasHiddenAbove && hasHiddenBelow && marked.length === 1) {
		marked[0] = marker(marked[0] ?? "", "↕");
		return marked;
	}

	if (hasHiddenAbove) {
		marked[0] = marker(marked[0] ?? "", "↑");
	}
	if (hasHiddenBelow) {
		const lastIndex = marked.length - 1;
		marked[lastIndex] = marker(marked[lastIndex] ?? "", "↓");
	}
	return marked;
}

const truncateLines = (lines: string[], width: number): string[] =>
	lines.map((line) => truncateToWidth(line, width, "", true));

export function limitLines(
	theme: Theme,
	lines: string[],
	budget: number,
	width: number,
	showOverflowMarker: boolean,
): string[] {
	const safeBudget = Math.max(0, Math.floor(budget));
	if (safeBudget <= 0) return [];
	if (lines.length <= safeBudget) return truncateLines(lines, width);
	if (!showOverflowMarker) return truncateLines(lines.slice(0, safeBudget), width);
	if (safeBudget === 1) return [theme.fg("dim", "…")];
	return [...truncateLines(lines.slice(0, safeBudget - 1), width), theme.fg("dim", "…")];
}

/** Editor rows keep their top/bottom borders and follow the cursor when clipped. */
export function limitEditorLines(
	theme: Theme,
	lines: string[],
	budget: number,
	width: number,
): string[] {
	const safeBudget = Math.max(0, Math.floor(budget));
	if (safeBudget <= 0) return [];
	if (lines.length <= safeBudget) return truncateLines(lines, width);
	if (safeBudget === 1) return [theme.fg("dim", "…")];

	const topBorder = truncateToWidth(lines[0] ?? "", width, "", true);
	const bottomBorder = truncateToWidth(lines[lines.length - 1] ?? "", width, "", true);
	if (safeBudget === 2) return [topBorder, bottomBorder];

	const contentLines = lines.slice(1, -1);
	const contentBudget = safeBudget - 2;
	// Locate the cursor row: prefer the zero-width CURSOR_MARKER the editor
	// emits while focused (the same mechanism pi-tui core uses for hardware
	// cursor placement), falling back to the inverse-video fake cursor.
	const cursorLineIndex = contentLines.findIndex(
		(line) => line.includes(CURSOR_MARKER) || line.includes("\x1b[7m"),
	);
	const maxStart = Math.max(0, contentLines.length - contentBudget);
	const start =
		cursorLineIndex >= 0
			? Math.max(0, Math.min(cursorLineIndex - contentBudget + 1, maxStart))
			: maxStart;
	const visibleContentLines = contentLines.slice(start, start + contentBudget);
	const markedContentLines = applyOverflowMarkers(
		theme,
		visibleContentLines,
		width,
		start > 0,
		start + contentBudget < contentLines.length,
	);

	return [topBorder, ...markedContentLines, bottomBorder];
}
