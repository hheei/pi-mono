import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, onTestFinished } from "vitest";

/** Events the extension emitted through `pi.events`, reset by every `setupTool` call. */
export let emittedEvents: Array<{ name: string; payload: any }> = [];

export type RegisteredTool = {
	/** Set by the extension so the host runs the prompt before other tools in the turn. */
	executionMode?: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
		ctx: Record<string, unknown>,
	) => Promise<{
		content: Array<{ type: string; text?: string }>;
		details: any;
		isError?: boolean;
	}>;
	renderResult: (result: any, options: any, theme: Theme, context?: any) => any;
};

/** The mounted prompt component: keys in, rendered rows out. */
export interface PromptComponent {
	handleInput(data: string): void;
	render(width: number): string[];
}

export type AskComponentFactory = (
	tui: unknown,
	theme: unknown,
	keybindings: unknown,
	done: (value: unknown) => void,
) => PromptComponent;

/**
 * Isolates preference resolution from the developer's real agent directory, even
 * when PI_CODING_AGENT_DIR points at a configured one: a local ext_settings.json
 * must not leak into overlay/layout defaults. Tests that exercise the settings
 * file point this at their own temp directory via stubEnv, which restores this
 * baseline afterwards.
 */
export function isolateAgentDir(): void {
	let isolatedAgentDir: string;
	let originalAgentDir: string | undefined;
	beforeAll(() => {
		isolatedAgentDir = mkdtempSync(join(tmpdir(), "ask-user-test-agent-dir-"));
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
	});
	afterAll(() => {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		rmSync(isolatedAgentDir, { recursive: true, force: true });
	});
}

export function stubEnv(key: string, value: string): void {
	const original = process.env[key];
	process.env[key] = value;
	onTestFinished(() => {
		if (original === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = original;
		}
	});
}

/**
 * Stand-in for `ctx.ui.custom`. The component's completion wins; when the
 * callback finishes without completing the prompt, its return value is the
 * answer (`null`/`undefined` = aborted).
 */
export function customUI(
	run: (factory: AskComponentFactory, options: any) => unknown,
): (factory: AskComponentFactory, options: any) => Promise<unknown> {
	return (factory, options) =>
		new Promise((resolve, reject) => {
			let settled = false;
			const settle = (result: unknown): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			void Promise.resolve()
				.then(() =>
					run(
						(tui, theme, keybindings) =>
							factory(tui, theme, keybindings, (result: unknown) => settle(result)),
						options,
					),
				)
				.then((value) => {
					if (settled) return;
					settle(
						value === null || value === undefined
							? { status: "aborted" }
							: { status: "closed", value },
					);
				}, reject);
		});
}

export async function setupTool(): Promise<RegisteredTool> {
	const { default: askUserExtension } = await import("../../src/index");
	let registeredTool: RegisteredTool | undefined;
	emittedEvents = [];
	const pi = {
		registerTool(tool: RegisteredTool) {
			registeredTool = tool;
		},
		on() {},
		events: {
			emit(name: string, payload: any) {
				emittedEvents.push({ name, payload });
			},
		},
	};

	askUserExtension(pi as unknown as ExtensionAPI);

	if (!registeredTool) {
		throw new Error("Tool was not registered");
	}

	return registeredTool;
}

export async function rejectedError(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`Expected an Error rejection, received ${String(error)}`);
	}
	throw new Error("Expected promise to reject");
}

/** Identity theme; the harness only exercises layout, so every style is a no-op. */
export function createTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}

export function createKeybindings(overrides: Partial<Record<string, string[]>> = {}) {
	const bindings: Record<string, string[]> = {
		"tui.input.submit": ["enter"],
		"tui.input.newLine": ["shift+enter"],
		"tui.select.confirm": ["enter"],
		"tui.select.cancel": ["escape", "ctrl+c"],
		"tui.select.up": ["up"],
		"tui.select.down": ["down"],
		"tui.editor.deleteCharBackward": ["backspace"],
		...overrides,
	};

	return {
		matches(data: string, keybinding: string) {
			return (bindings[keybinding] ?? []).includes(data);
		},
		getKeys(keybinding: string) {
			return bindings[keybinding] ?? [];
		},
	};
}

/** Mounts the batch prompt once the tool has read its settings; keys go to `state.component`. */
export function mountBatchPrompt(rows = 24) {
	const state: { component: PromptComponent; settled: boolean } = {
		component: { handleInput() {}, render: () => [] },
		settled: false,
	};
	let mounted: () => void = () => {};
	const componentReady = new Promise<void>((resolve) => {
		mounted = resolve;
	});
	const custom = async (factory: AskComponentFactory) =>
		await new Promise((resolve) => {
			state.component = factory(
				{ requestRender() {}, terminal: { rows } },
				createTheme(),
				createKeybindings(),
				(value: unknown) => {
					state.settled = true;
					resolve(value);
				},
			);
			mounted();
		});
	return { state, custom, componentReady };
}

export function press(component: PromptComponent, ...keys: string[]): void {
	keys.forEach((key) => {
		component.handleInput(key);
	});
}
export interface PromptRun {
	/** Rendered rows for a recorded label; empty when it was never recorded. */
	rowsOf: (label: string) => string[];
	/** The same rows joined into one string, for `toContain` assertions. */
	frameOf: (label: string) => string;
	result: Awaited<ReturnType<RegisteredTool["execute"]>>;
}

/**
 * Mounts the prompt the tool opens and lets `drive` press keys and snapshot
 * frames, so a test reads as "press these keys, expect these rows".
 */
export async function runPrompt(
	params: Record<string, unknown>,
	drive: (component: PromptComponent, record: (label: string, width?: number) => void) => void,
	options: {
		rows?: number;
		width?: number;
		keybindings?: Partial<Record<string, string[]>>;
	} = {},
): Promise<PromptRun> {
	const tool = await setupTool();
	const captured: Record<string, string[]> = {};
	const width = options.width ?? 50;
	const rows = options.rows ?? 24;
	const result = await tool.execute("tool-call-id", params, undefined, undefined, {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: customUI(async (factory) => {
				let resolved: unknown;
				const component = factory(
					{ requestRender() {}, terminal: { rows } },
					createTheme(),
					createKeybindings(options.keybindings),
					(value: unknown) => {
						resolved = value;
					},
				);
				drive(component, (label, recordWidth) => {
					captured[label] = component.render(recordWidth ?? width);
				});
				return resolved ?? null;
			}),
		},
	});
	return {
		rowsOf: (label) => captured[label] ?? [],
		frameOf: (label) => (captured[label] ?? []).join("\n"),
		result,
	};
}
