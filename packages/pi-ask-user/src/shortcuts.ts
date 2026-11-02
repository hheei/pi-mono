import {
	decodeKittyPrintable,
	Key,
	type KeybindingsManager,
	matchesKey,
} from "@earendil-works/pi-tui";

// tab/shift+tab mirror the host's select lists; a batch prompt takes tab for paging first.
export function matchesSelectUp(data: string, keybindings: KeybindingsManager): boolean {
	return keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.shift("tab"));
}

export function matchesSelectDown(data: string, keybindings: KeybindingsManager): boolean {
	return keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.tab);
}

/** A 1-9 digit key, including the CSI-u form the kitty keyboard protocol sends. */
export function digitKey(data: string): number | null {
	const key = decodeKittyPrintable(data) ?? data;
	return key.length === 1 && key >= "1" && key <= "9" ? Number(key) : null;
}
