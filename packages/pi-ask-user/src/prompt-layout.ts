import { ASK_MAX_RENDER_LINES_RATIO, ASK_MIN_RENDER_LINES } from "./constants";

/** Rows a prompt may draw for the terminal height: a ratio cap with a usable floor. */
export function getMaxRenderLinesForRows(rows: number): number {
	const normalizedRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
	const availableRows = Math.max(1, normalizedRows - 2);
	const ratioRows = Math.max(1, Math.floor(normalizedRows * ASK_MAX_RENDER_LINES_RATIO));
	const minimumRows = Math.min(ASK_MIN_RENDER_LINES, availableRows);
	return Math.min(availableRows, Math.max(minimumRows, ratioRows));
}
