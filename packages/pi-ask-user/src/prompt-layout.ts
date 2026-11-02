import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	ASK_OVERLAY_MAX_HEIGHT_RATIO,
	ASK_OVERLAY_MIN_RENDER_LINES,
	type AskMode,
} from "./constants";
import type { AskDisplayMode } from "./schema";

/** Rows each mode needs to stay usable, and the size it grows to when there is room. */
const MODE_ROWS: Record<AskMode, { min: number; preferred: number }> = {
	select: { min: 3, preferred: 8 },
	freeform: { min: 5, preferred: 10 },
};

/** A surface is bracketed by two `──` rails, the way `pi-ext-ui` groups are. */
export const RAIL_ROWS = 2;

/** The native separator row: one full-width `─` rule in `borderMuted`. */
export function railRow(theme: Theme, width: number): string {
	return theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
}

/** Rows an overlay may draw for the terminal height: a ratio cap with a usable floor. */
export function getOverlayMaxRenderLinesForRows(rows: number): number {
	const normalizedRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
	const availableRows = Math.max(1, normalizedRows - 2);
	const ratioRows = Math.max(1, Math.floor(normalizedRows * ASK_OVERLAY_MAX_HEIGHT_RATIO));
	const minimumRows = Math.min(ASK_OVERLAY_MIN_RENDER_LINES, availableRows);
	return Math.min(availableRows, Math.max(minimumRows, ratioRows));
}

export function modeMinRows(mode: AskMode): number {
	return MODE_ROWS[mode].min;
}

export function modePreferredRows(mode: AskMode): number {
	return MODE_ROWS[mode].preferred;
}

export function overlayHelpBudget(bodyCapacity: number, renderedHelpRows: number): number {
	if (renderedHelpRows <= 0 || bodyCapacity <= 0) return 0;
	if (bodyCapacity >= 12) return Math.min(2, renderedHelpRows);
	return 1;
}

export interface ContextCollapseInput {
	displayMode: AskDisplayMode;
	mode: AskMode;
	contextCollapsible: boolean;
	questionRows: number;
	contextRows: number;
	bodyCapacity: number;
	helpRows: number;
}

/**
 * Inline mode always follows the row budget; the overlay keeps context open
 * when the prompt still fits next to the minimum mode rows.
 */
export function contextShouldCollapse(input: ContextCollapseInput): boolean {
	if (input.displayMode === "inline") return input.contextCollapsible;
	if (input.mode !== "select") return input.contextCollapsible;
	if (input.contextRows === 0) return false;

	const helpBudget = overlayHelpBudget(input.bodyCapacity, input.helpRows);
	const contentRows = Math.max(0, input.bodyCapacity - helpBudget);
	const separatorRows = contentRows >= 4 ? 1 : 0;
	const promptCapacity = Math.max(0, contentRows - separatorRows - modeMinRows(input.mode));
	return input.questionRows + 1 + input.contextRows > promptCapacity;
}

export interface BodyPlanInput {
	maxRenderLines: number;
	mode: AskMode;
	contextCollapsible: boolean;
	promptRows: number;
	helpRows: number;
}

export interface BodyPlan {
	bodyCapacity: number;
	helpBudget: number;
	contentRows: number;
	promptBudget: number;
	modeBudget: number;
	separatorRows: number;
}

/** Split the overlay rows between prompt, mode body and help. */
export function planOverlayBody(input: BodyPlanInput): BodyPlan {
	const bodyCapacity = Math.max(0, input.maxRenderLines);
	const helpBudget = overlayHelpBudget(bodyCapacity, input.helpRows);
	const contentRows = Math.max(0, bodyCapacity - helpBudget);

	let promptBudget = 0;
	let modeBudget = 0;
	let separatorRows = 0;

	if (input.mode === "select") {
		separatorRows = contentRows >= 4 ? 1 : 0;
		const promptAndModeRows = Math.max(0, contentRows - separatorRows);
		promptBudget = promptAndModeRows;

		if (promptAndModeRows > 0) {
			const promptMinRows = input.promptRows > 0 ? 1 : 0;
			const maximumModeRows = Math.max(0, promptAndModeRows - promptMinRows);
			const modeMin = Math.min(modeMinRows(input.mode), maximumModeRows);
			modeBudget = Math.min(modePreferredRows(input.mode), maximumModeRows);
			modeBudget = Math.max(modeMin, modeBudget);
			promptBudget = promptAndModeRows - modeBudget;

			const usefulPromptTarget = input.contextCollapsible ? 3 : 2;
			const usefulPromptRows = Math.min(
				input.promptRows,
				promptAndModeRows >= modeMin + usefulPromptTarget ? usefulPromptTarget : promptMinRows,
			);
			if (promptBudget < usefulPromptRows && modeBudget > modeMin) {
				const shiftedRows = Math.min(usefulPromptRows - promptBudget, modeBudget - modeMin);
				modeBudget -= shiftedRows;
				promptBudget += shiftedRows;
			}
		}
	} else {
		modeBudget = Math.min(modePreferredRows(input.mode), contentRows);
		modeBudget = Math.max(Math.min(modeMinRows(input.mode), contentRows), modeBudget);
		promptBudget = Math.max(0, contentRows - modeBudget);
		if (promptBudget > 0 && modeBudget > 0) {
			separatorRows = 1;
			promptBudget = Math.max(0, promptBudget - separatorRows);
		}
	}

	return { bodyCapacity, helpBudget, contentRows, promptBudget, modeBudget, separatorRows };
}
