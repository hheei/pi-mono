import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Editor,
	type EditorTheme,
	Key,
	type KeybindingsManager,
	matchesKey,
	Spacer,
	Text,
	type TUI,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type AskMode, INLINE_CONTEXT_MAX_ROWS } from "./constants";
import { MultiSelectList } from "./multi-select-list";
import type { PromptSettings } from "./preferences";
import { PromptContextPane } from "./prompt-context";
import { buildHelpText } from "./prompt-help";
import {
	contextShouldCollapse,
	getOverlayMaxRenderLinesForRows,
	planOverlayBody,
	RAIL_ROWS,
	railRow,
} from "./prompt-layout";
import { applyOverflowMarkers, limitEditorLines, limitLines } from "./prompt-overflow";
import { type AskUIResult, createFreeformResponse, createSelectionResponse } from "./response";
import type { BatchQuestion } from "./schema";
import { pageDelta } from "./shortcuts";
import { WrappedSingleSelectList } from "./single-select-list";

function editorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		},
	};
}

/**
 * Interactive ask UI. Uses a root Container for layout and swaps the center
 * component between the option list and an Editor (freeform mode).
 */
export class AskComponent extends Container {
	private readonly prompt: BatchQuestion;
	private readonly settings: PromptSettings;
	private readonly contextPane: PromptContextPane;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly onDone: (result: AskUIResult | null) => void;

	private mode: AskMode = "select";
	private chrome = "";
	private freeformDraft = "";
	private promptScrollOffset = 0;
	private promptMaxScrollOffset = 0;
	private promptViewportRows = 0;

	private get contextIsCollapsible(): boolean {
		return this.contextPane.collapsible;
	}

	private get contextExpanded(): boolean {
		return this.contextPane.expanded;
	}

	// Static layout components
	private questionText: Text;
	private modeContainer: Container;

	// Mode components
	private optionListValue?: WrappedSingleSelectList | MultiSelectList;
	private editor?: Editor;

	// Focusable - propagate to Editor for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.editor && this.mode === "freeform") {
			this.editor.focused = value;
		}
	}

	constructor(
		prompt: BatchQuestion,
		settings: PromptSettings,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		onDone: (result: AskUIResult | null) => void,
	) {
		super();

		this.prompt = prompt;
		this.settings = settings;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.onDone = onDone;

		this.questionText = new Text("", 1, 0);
		this.addChild(this.questionText);

		this.contextPane = new PromptContextPane(prompt.context, theme, () => this.invalidate());
		if (this.contextPane.component) {
			this.addChild(new Spacer(1));
			this.addChild(this.contextPane.component);
		}

		this.addChild(new Spacer(1));

		this.modeContainer = new Container();
		this.addChild(this.modeContainer);

		this.updateStaticText();
		// A question without options opens straight in the editor, like the
		// input dialog a single question without options uses.
		if (this.prompt.options.length === 0) {
			this.showEditorMode();
		} else {
			this.showSelectMode();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.updateStaticText();
	}

	override render(width: number): string[] {
		if (this.settings.displayMode === "overlay") return this.renderOverlayLayout(width);

		if (this.mode === "select") this.optionList.setMaxVisibleRows(12);

		return this.renderInlineLayout(width);
	}

	private renderInlineLayout(width: number): string[] {
		const fullContextLines = this.contextPane.fullLines(width);
		this.contextPane.setCollapsible(fullContextLines.length > INLINE_CONTEXT_MAX_ROWS);
		return [
			railRow(this.theme, width),
			...this.buildPromptLines(width, fullContextLines),
			"",
			...this.modeContainer.render(width),
			railRow(this.theme, width),
			...this.helpLines(width, false),
		];
	}

	private renderOverlayLayout(width: number): string[] {
		const maxLines = getOverlayMaxRenderLinesForRows(this.tui.terminal.rows);
		if (maxLines <= 0) return [];
		const bodyCapacity = Math.max(0, maxLines - RAIL_ROWS);

		let helpLines = this.helpLines(width, false);
		const questionLines = this.questionText.render(width);
		const fullContextLines = this.contextPane.fullLines(width);
		this.contextPane.setCollapsible(
			contextShouldCollapse({
				displayMode: this.settings.displayMode,
				mode: this.mode,
				contextCollapsible: this.contextIsCollapsible,
				questionRows: questionLines.length,
				contextRows: fullContextLines.length,
				bodyCapacity,
				helpRows: helpLines.length,
			}),
		);
		const promptLines = this.buildPromptLines(width, fullContextLines);
		const plan = planOverlayBody({
			maxRenderLines: bodyCapacity,
			mode: this.mode,
			contextCollapsible: this.contextIsCollapsible,
			promptRows: promptLines.length,
			helpRows: helpLines.length,
		});

		const modeLines = this.renderModeLines(width, plan.modeBudget);
		const promptBudget = plan.promptBudget + Math.max(0, plan.modeBudget - modeLines.length);
		const promptPaneLines = this.renderPromptPane(promptLines, promptBudget, width);
		helpLines = this.helpLines(width, promptLines.length > promptBudget);
		const visibleHelpLines = limitLines(this.theme, helpLines, plan.helpBudget, width, false);
		const contentLines = [
			...promptPaneLines,
			...(plan.separatorRows > 0 && promptPaneLines.length > 0 && modeLines.length > 0 ? [""] : []),
			...modeLines,
		];

		return [
			railRow(this.theme, width),
			...contentLines.slice(0, plan.bodyCapacity),
			railRow(this.theme, width),
			...visibleHelpLines,
		].slice(0, maxLines);
	}

	private buildPromptLines(width: number, fullContextLines: string[]): string[] {
		const questionLines = this.questionText.render(width);
		const contextLines = this.contextPane.displayLines(fullContextLines, width);
		const contextSeparator = this.contextIsCollapsible && !this.contextExpanded ? [] : [""];
		return [
			...questionLines,
			...(contextLines.length > 0 ? [...contextSeparator, ...contextLines] : []),
		];
	}

	private renderModeLines(width: number, budget: number): string[] {
		const safeBudget = Math.max(0, Math.floor(budget));
		if (safeBudget <= 0) return [];

		if (this.mode === "select") {
			this.optionList.setMaxVisibleRows(Math.max(1, safeBudget));
			return limitLines(this.theme, this.modeContainer.render(width), safeBudget, width, true);
		}

		return this.renderEditorModeLines(width, safeBudget);
	}

	private renderEditorModeLines(width: number, budget: number): string[] {
		const headerLines = [...new Text(this.editorHeader(), 1, 0).render(width), ""];
		const minimumEditorRows = Math.min(3, budget);
		const headerBudget = Math.max(0, budget - minimumEditorRows);
		const visibleHeaderLines = limitLines(this.theme, headerLines, headerBudget, width, true);
		const editorBudget = Math.max(0, budget - visibleHeaderLines.length);

		return [
			...visibleHeaderLines,
			...limitEditorLines(this.theme, this.ensureEditor().render(width), editorBudget, width),
		];
	}

	/** Header shared by the container children (inline) and the overlay budget path. */
	private editorHeader(): string {
		return this.theme.fg("accent", this.theme.bold("Custom response"));
	}

	private renderPromptPane(promptLines: string[], budget: number, width: number): string[] {
		const viewportRows = Math.max(0, Math.floor(budget));
		this.promptViewportRows = viewportRows;

		if (viewportRows <= 0 || promptLines.length === 0) {
			this.promptMaxScrollOffset = 0;
			this.promptScrollOffset = 0;
			return [];
		}

		this.promptMaxScrollOffset = Math.max(0, promptLines.length - viewportRows);
		this.promptScrollOffset = Math.max(
			0,
			Math.min(this.promptScrollOffset, this.promptMaxScrollOffset),
		);

		const visibleLines = promptLines.slice(
			this.promptScrollOffset,
			this.promptScrollOffset + viewportRows,
		);
		const hasHiddenAbove = this.promptScrollOffset > 0;
		const hasHiddenBelow = this.promptScrollOffset + viewportRows < promptLines.length;
		return applyOverflowMarkers(this.theme, visibleLines, width, hasHiddenAbove, hasHiddenBelow);
	}

	private updateStaticText(): void {
		const theme = this.theme;
		const question = theme.fg("text", theme.bold(this.prompt.question));
		this.questionText.setText(this.chrome ? `${this.chrome}\n${question}` : question);
		this.contextPane.updateText();
	}

	/** Batch pages: show the question strip and the page-navigation hint above the question. */
	setBatchChrome(frameTitle: string, navigationHint: string): void {
		const theme = this.theme;
		this.chrome = `${theme.fg("dim", frameTitle)}  ${theme.fg("dim", navigationHint)}`;
		this.updateStaticText();
	}

	/** The hint row for the current mode; `promptScrollable` only applies where the pane can clip. */
	private helpLines(width: number, promptScrollable: boolean): string[] {
		return wrapTextWithAnsi(
			buildHelpText({
				theme: this.theme,
				mode: this.mode,
				displayMode: this.settings.displayMode,
				allowMultiple: this.prompt.allowMultiple,
				hasOptions: this.prompt.options.length > 0,
				contextCollapsible: this.contextIsCollapsible,
				contextToggleKey: this.contextPane.toggleKey(),
				promptScrollable,
				keybindings: this.keybindings,
			}),
			width,
		);
	}

	/** The select-mode body; both lists share the wiring and differ in the selection shape. */
	private get optionList(): WrappedSingleSelectList | MultiSelectList {
		if (this.optionListValue) return this.optionListValue;

		if (this.prompt.allowMultiple) {
			const list = new MultiSelectList(
				this.prompt.options,
				this.prompt.allowFreeform,
				this.theme,
				this.keybindings,
			);
			list.onSubmit = (result) => this.onDone(createSelectionResponse(result));
			this.optionListValue = list;
		} else {
			const list = new WrappedSingleSelectList(
				this.prompt.options,
				this.prompt.allowFreeform,
				this.theme,
				this.keybindings,
			);
			list.onSubmit = (result) => this.onDone(createSelectionResponse([result]));
			this.optionListValue = list;
		}

		this.optionListValue.onCancel = () => this.onDone(null);
		this.optionListValue.onEnterFreeform = () => this.showEditorMode();
		return this.optionListValue;
	}

	private ensureEditor(): Editor {
		if (this.editor) return this.editor;
		const editor = new Editor(this.tui, editorTheme(this.theme));
		editor.disableSubmit = false;
		editor.onSubmit = (text: string) => {
			this.onDone(createFreeformResponse(text));
		};
		this.editor = editor;
		return editor;
	}

	private saveEditorDraft(): void {
		if (!this.editor) return;
		this.freeformDraft = this.editor.getText();
	}

	private showSelectMode(): void {
		if (this.mode === "freeform") this.saveEditorDraft();

		this.mode = "select";
		this.modeContainer.clear();
		this.modeContainer.addChild(this.optionList);

		this.invalidate();
		this.tui.requestRender();
	}

	private showEditorMode(): void {
		if (this.mode === "freeform") this.saveEditorDraft();

		this.mode = "freeform";
		this.modeContainer.clear();

		const editor = this.ensureEditor();
		editor.setText(this.freeformDraft);
		editor.focused = this._focused;

		this.modeContainer.addChild(new Text(this.editorHeader(), 1, 0));
		this.modeContainer.addChild(new Spacer(1));
		this.modeContainer.addChild(editor);

		this.invalidate();
		this.tui.requestRender();
	}

	private toggleContext(): boolean {
		if (this.mode !== "select") return false;
		if (!this.contextPane.toggle()) return false;
		this.promptScrollOffset = 0;
		this.invalidate();
		this.tui.requestRender();
		return true;
	}

	private setPromptScrollOffset(nextOffset: number): void {
		this.promptScrollOffset = Math.max(
			0,
			Math.min(Math.floor(nextOffset), this.promptMaxScrollOffset),
		);
	}

	private handlePromptScrollInput(data: string): boolean {
		if (this.settings.displayMode !== "overlay") return false;
		if (this.promptMaxScrollOffset <= 0) return false;
		// Prompt scrolling is select-mode only: in freeform mode the editor owns
		// PageUp/PageDown (tui.editor.pageUp/pageDown) for paging through long
		// input, so intercepting them here would steal editor keys.
		if (this.mode !== "select") return false;

		const pageRows = Math.max(1, this.promptViewportRows - 1);
		const halfPageRows = Math.max(1, Math.floor(this.promptViewportRows / 2));
		const delta = pageDelta(data, pageRows);
		if (delta !== 0) return this.scrollPromptBy(delta);
		if (matchesKey(data, Key.home)) return this.scrollPromptBy(-this.promptScrollOffset);
		if (matchesKey(data, Key.end)) return this.scrollPromptBy(this.promptMaxScrollOffset);
		if (matchesKey(data, Key.ctrl("u"))) return this.scrollPromptBy(-halfPageRows);
		if (matchesKey(data, Key.ctrl("d"))) return this.scrollPromptBy(halfPageRows);
		return false;
	}

	private scrollPromptBy(delta: number): true {
		this.setPromptScrollOffset(this.promptScrollOffset + delta);
		return true;
	}

	handleInput(data: string): void {
		if (matchesKey(data, this.contextPane.toggleKey()) && this.toggleContext()) {
			return;
		}
		if (this.handlePromptScrollInput(data)) {
			this.tui.requestRender();
			return;
		}
		if (this.mode === "freeform") {
			if (matchesKey(data, Key.escape)) {
				// Without options there is no list to go back to, so esc cancels.
				if (this.prompt.options.length === 0) {
					this.onDone(null);
					return;
				}
				this.showSelectMode();
				return;
			}

			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.onDone(null);
				return;
			}

			this.ensureEditor().handleInput(data);
			this.tui.requestRender();
			return;
		}

		this.optionList.handleInput(data);
		this.tui.requestRender();
	}
}
