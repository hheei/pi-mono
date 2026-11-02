import { Key } from "@earendil-works/pi-tui";

export const BATCH_MIN_QUESTIONS = 2;

export const BATCH_MAX_QUESTIONS = 4;

export type AskMode = "select" | "freeform";

export const ASK_OVERLAY_MAX_HEIGHT_RATIO = 0.85;

export const ASK_OVERLAY_MIN_RENDER_LINES = 8;

export const ASK_OVERLAY_WIDTH = "92%";

export const ASK_OVERLAY_MIN_WIDTH = 40;

export const FREEFORM_SENTINEL = "\u270f\ufe0f Type custom response...";

export const FREEFORM_LABEL = "Type something.";

export const FREEFORM_HINT = "Enter a custom response";

export const CONTEXT_TOGGLE_KEYS = [Key.ctrl("e"), Key.ctrl("x"), Key.ctrl("y")] as const;

export const INLINE_CONTEXT_MAX_ROWS = 3;

// Rows Pi's fullscreen layout keeps outside the input dock: the transcript's
// minimum row, the working status, and up to three footer rows.
export const INLINE_DOCK_RESERVED_ROWS = 5;

/** Section of `<agent-dir>/ext_settings.json` (and its project override) holding these preferences. */
export const SETTINGS_SECTION = "askUser";
