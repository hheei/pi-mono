import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type KeyId, Markdown } from "@earendil-works/pi-tui";
import { fitRow } from "@hheei/pi-ext-core";
import { CONTEXT_TOGGLE_KEYS } from "./constants";

/**
 * Owns the question's context block: the component that renders it, whether it is
 * long enough to collapse, and the expand/collapse state the user toggles with the
 * context shortcut. The prompt only asks for display lines; the pane never decides
 * layout, scrolling, or which mode is active.
 */
export class PromptContextPane {
	readonly component: Markdown | undefined;
	private readonly text: string | undefined;
	private readonly theme: Theme;
	private readonly onChange: () => void;
	private collapsibleState = false;
	private expandedState = false;

	constructor(text: string | undefined, theme: Theme, onChange: () => void) {
		this.text = text;
		this.theme = theme;
		this.onChange = onChange;
		if (!text) {
			this.component = undefined;
			return;
		}
		this.component = new Markdown("", 1, 0, getMarkdownTheme());
	}

	get collapsible(): boolean {
		return this.collapsibleState;
	}

	get expanded(): boolean {
		return this.expandedState;
	}

	fullLines(width: number): string[] {
		return this.component ? this.component.render(width) : [];
	}

	displayLines(fullContextLines: string[], width: number): string[] {
		if (fullContextLines.length === 0) return [];
		if (!this.collapsibleState || this.expandedState) return fullContextLines;
		const label = `Context (${fullContextLines.length} lines) — ${this.toggleKey()} expand`;
		return [fitRow(this.theme.fg("dim", label), width, "")];
	}

	toggleKey(): KeyId {
		return CONTEXT_TOGGLE_KEYS[0];
	}

	/** Marks the block as long enough to collapse; a new state starts collapsed. */
	setCollapsible(value: boolean): void {
		if (this.collapsibleState === value) return;
		this.collapsibleState = value;
		this.expandedState = false;
		this.onChange();
	}

	toggle(): boolean {
		if (!this.collapsibleState) return false;
		this.expandedState = !this.expandedState;
		this.onChange();
		return true;
	}

	updateText(): void {
		if (!this.component || !this.text) return;
		this.component.setText(`**Context:**\n${this.text}`);
	}
}
