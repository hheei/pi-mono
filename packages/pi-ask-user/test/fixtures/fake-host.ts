/**
 * Stand-in host modules for the ask_user tests.
 *
 * `vi.mock` factories are hoisted above the test file's own declarations, so the
 * fakes live here instead of inside the spec. The editor's draft text is shared
 * through `editorState`, which is the only mutable state the tests poke at.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const editorState: { inputs: string[]; text: string } = { inputs: [], text: "" };

export function wrapPlainText(text: string, width = 80): string[] {
	const lines: string[] = [];
	for (const rawLine of text.split("\n")) {
		if (rawLine.length <= width) {
			lines.push(rawLine);
			continue;
		}
		for (let i = 0; i < rawLine.length; i += width) {
			lines.push(rawLine.slice(i, i + width));
		}
	}
	return lines.length > 0 ? lines : [""];
}

export class MockText {
	constructor(private text: string) {}
	render(width = 80) {
		return wrapPlainText(this.text, width);
	}
	setText(text: string) {
		this.text = text;
	}
}

export class MockContainer {
	private children: unknown[] = [];
	addChild(child?: unknown) {
		if (child) this.children.push(child);
	}
	clear() {
		this.children = [];
	}
	invalidate() {}
	render(width = 80) {
		return this.children.flatMap((child) => {
			const render = (child as { render?: (width: number) => string[] } | null)?.render;
			return typeof render === "function"
				? (child as { render: (width: number) => string[] }).render(width)
				: [];
		});
	}
}

export class MockEditor {
	disableSubmit = false;
	onSubmit?: (text: string) => void;

	constructor(_tui: unknown, theme: { borderColor?: unknown }) {
		if (!theme?.borderColor) {
			throw new TypeError("Cannot read properties of undefined (reading 'borderColor')");
		}
	}

	handleInput(data?: string) {
		if (typeof data === "string") {
			editorState.inputs.push(data);
		}
		if (data === "enter") {
			this.onSubmit?.(editorState.text);
		}
	}
	getText() {
		return editorState.text;
	}
	setText(text = "") {
		editorState.text = text;
	}
	render(width = 80) {
		return [
			"─".repeat(width),
			...wrapPlainText(editorState.text, Math.max(1, width - 1)),
			"─".repeat(width),
		];
	}
}

/** Plain markdown theme: identity styling, enough for pi-tui's Markdown component. */
function fakeMarkdownTheme() {
	return {
		bold: (text: string) => text,
		italic: (text: string) => text,
		heading: (text: string) => text,
	};
}

export function piCodingAgentModule() {
	return {
		CONFIG_DIR_NAME: ".pi",
		DynamicBorder: class {},
		getAgentDir: () => {
			const override = process.env.PI_CODING_AGENT_DIR?.trim();
			return override ? override : join(homedir(), ".pi", "agent");
		},
		getMarkdownTheme: () => fakeMarkdownTheme(),
		rawKeyHint: (key: string, description: string) => `${key} ${description}`,
	};
}

export function piTuiModule() {
	return {
		Container: MockContainer,
		CURSOR_MARKER: "\x1b_pi:c\x07",
		Editor: MockEditor,
		Key: {
			escape: "escape",
			enter: "enter",
			up: "up",
			down: "down",
			pageUp: "pageUp",
			pageDown: "pageDown",
			home: "home",
			end: "end",
			space: "space",
			backspace: "backspace",
			ctrl: (key: string) => `ctrl+${key}`,
			alt: (key: string) => `alt+${key}`,
			shift: (key: string) => `shift+${key}`,
			tab: "tab",
		},
		Markdown: class extends MockText {
			private mdTheme: { bold(line: string): string };
			constructor(text: string, _a: number, _b: number, theme: { bold(line: string): string }) {
				super(text);
				this.mdTheme = theme;
			}
			override render(width?: number) {
				return super.render(width).map((line) => this.mdTheme.bold(line));
			}
		},
		matchesKey: (data: string, key: string) =>
			data === key || (key === "alt+o" && /^\x1b\[111;3:[123]u$/.test(data)),
		isKeyRepeat: (data: string) => data.includes(":2u"),
		isKeyRelease: (data: string) => data.includes(":3u"),
		Spacer: class {
			render() {
				return [""];
			}
		},
		Text: MockText,
		truncateToWidth: (text: string) => text,
		visibleWidth: (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").length,
		wrapTextWithAnsi: (text: string, width = 80) => wrapPlainText(text, width),
		decodeKittyPrintable: (data: string) => (data.length === 1 ? data : undefined),
		fuzzyFilter: <T>(items: T[], query: string, getText: (item: T) => string) => {
			const normalized = query.trim().toLowerCase();
			if (!normalized) return items;
			return items.filter((item) => getText(item).toLowerCase().includes(normalized));
		},
	};
}

export function typeboxModule() {
	const passthrough = (value?: unknown) => value;
	return {
		Type: {
			Object: passthrough,
			String: passthrough,
			Optional: passthrough,
			Array: passthrough,
			Union: passthrough,
			Literal: passthrough,
			Boolean: passthrough,
			Number: passthrough,
			Integer: passthrough,
			Unsafe: passthrough,
		},
	};
}
