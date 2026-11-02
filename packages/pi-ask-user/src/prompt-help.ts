import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Keybinding, KeybindingsManager } from "@earendil-works/pi-tui";
import type { AskMode } from "./constants";
import type { AskDisplayMode } from "./schema";

/** Keys that render as one glyph so the whole hint row still fits a terminal row. */
const KEY_GLYPH: Record<string, string> = {
	up: "↑",
	down: "↓",
	enter: "↵",
	escape: "⎋",
	space: "␣",
	tab: "⇥",
};

export function formatKeyList(keys: readonly string[]): string {
	return keys.map((key) => KEY_GLYPH[key] ?? key).join("/");
}

export interface HelpHintInput {
	theme: Theme;
	mode: AskMode;
	displayMode: AskDisplayMode;
	allowMultiple: boolean;
	hasOptions: boolean;
	contextCollapsible: boolean;
	contextToggleKey: string;
	/** True when the prompt pane clipped, so the scroll keys are worth showing. */
	promptScrollable: boolean;
	keybindings: KeybindingsManager;
}

type Hint = readonly [keys: string, label: string];

/**
 * One dim hint row: the keys the current mode accepts, in the order they matter.
 * Every hint that does not apply drops out, so the row never wraps on an 80-column
 * terminal unless a remapped key makes it long.
 */
export function buildHelpText(input: HelpHintInput): string {
	const { theme, keybindings } = input;
	const binding = (id: Keybinding): string => formatKeyList(keybindings.getKeys(id));

	const alternateCancelKeys = keybindings
		.getKeys("tui.select.cancel")
		.filter((key) => key !== "escape");
	const alternateCancel: Hint | null =
		alternateCancelKeys.length > 0 ? [formatKeyList(alternateCancelKeys), "cancel"] : null;

	const hints: Array<Hint | null> =
		input.mode === "select"
			? [
					["↕", "navigate"],
					input.allowMultiple
						? [binding("tui.select.confirm"), "submit"]
						: [binding("tui.select.confirm"), "select"],
					input.allowMultiple ? ["␣", "toggle"] : null,
					input.contextCollapsible ? [input.contextToggleKey, "context"] : null,
					input.promptScrollable ? ["PgUp/PgDn", "prompt"] : null,
					[binding("tui.select.cancel"), "cancel"],
				]
			: [
					[binding("tui.input.submit"), "submit"],
					[binding("tui.input.newLine"), "newline"],
					[
						input.hasOptions ? "⎋" : binding("tui.select.cancel"),
						input.hasOptions ? "back" : "cancel",
					],
					// esc only steps back to the list, so the cancel key still needs a hint.
					alternateCancel,
				];

	return theme.fg(
		"dim",
		hints
			.filter((hint): hint is Hint => hint !== null)
			.map(([keys, label]) => `${keys} ${label}`)
			.join(" · "),
	);
}
