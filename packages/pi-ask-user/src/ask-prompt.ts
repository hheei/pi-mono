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
import { editWithExternalEditor } from "./external-editor";
import { MultiSelectList } from "./multi-select-list";
import { PromptContextPane } from "./prompt-context";
import { buildHelpText } from "./prompt-help";
import { railRow } from "./prompt-layout";
import { type AskUIResult, createFreeformResponse, createSelectionResponse } from "./response";
import type { BatchQuestion } from "./schema";
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
	private readonly contextPane: PromptContextPane;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly onDone: (result: AskUIResult | null) => void;

	private mode: AskMode = "select";
	private chrome = "";
	private freeformDraft = "";

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
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		onDone: (result: AskUIResult | null) => void,
	) {
		super();

		this.prompt = prompt;
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
			...this.helpLines(width),
		];
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

	/** Header shown above the freeform editor. */
	private editorHeader(): string {
		return this.theme.fg("accent", this.theme.bold("Custom response"));
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

	/** The hint row for the current mode. */
	private helpLines(width: number): string[] {
		return wrapTextWithAnsi(
			buildHelpText({
				theme: this.theme,
				mode: this.mode,
				allowMultiple: this.prompt.allowMultiple,
				hasOptions: this.prompt.options.length > 0,
				contextCollapsible: this.contextIsCollapsible,
				contextToggleKey: this.contextPane.toggleKey(),
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
		this.invalidate();
		this.tui.requestRender();
		return true;
	}

	handleInput(data: string): void {
		if (matchesKey(data, this.contextPane.toggleKey()) && this.toggleContext()) {
			return;
		}
		if (this.mode === "freeform") {
			if (matchesKey(data, Key.ctrl("g"))) {
				const editor = this.ensureEditor();
				void editWithExternalEditor(this.tui, editor.getText())
					.then((text) => {
						editor.setText(text);
						this.tui.requestRender();
					})
					.catch(() => {
						this.tui.requestRender();
					});
				return;
			}

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
