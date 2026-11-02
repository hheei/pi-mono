import {
	type ExtensionAPI,
	initTheme,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

/** The render context Pi hands a tool renderer, with every field it passes. */
export interface RenderContextInput {
	readonly args: unknown;
	readonly toolCallId: string;
	readonly cwd: string;
	readonly state?: unknown;
	readonly executionStarted?: boolean;
	readonly argsComplete?: boolean;
	readonly expanded?: boolean;
	readonly isPartial?: boolean;
	readonly isError?: boolean;
}

/**
 * Builds one. Renderers read a few fields each, so tests spread these defaults
 * and override only what the renderer under test looks at.
 */
export function renderContextFor(
	options: RenderContextInput,
): Parameters<NonNullable<ToolDefinition["renderCall"]>>[2] {
	return {
		args: options.args,
		toolCallId: options.toolCallId,
		invalidate: (): void => undefined,
		state: options.state ?? {},
		cwd: options.cwd,
		executionStarted: options.executionStarted ?? true,
		argsComplete: options.argsComplete ?? true,
		showImages: false,
		expanded: options.expanded ?? false,
		isPartial: options.isPartial ?? false,
		isError: options.isError ?? false,
		lastComponent: undefined,
		durationMs: undefined,
		outputPad: 0,
		keyText: () => "",
		keyHint: (_keybinding, description) => description,
	};
}

/** A pi double that captures the tools an extension registers. */
export function toolHost(activeTools: readonly string[] = ["read", "bash", "edit", "write"]): {
	readonly pi: ExtensionAPI;
	readonly tools: ToolDefinition[];
	readonly activeTools: () => readonly string[];
	readonly emit: (event: string, ...args: unknown[]) => void;
} {
	const tools: ToolDefinition[] = [];
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	let active = [...activeTools];
	return {
		pi: {
			events: {},
			on: (event: string, handler: (...args: unknown[]) => void): (() => void) => {
				const group = listeners.get(event) ?? new Set();
				group.add(handler);
				listeners.set(event, group);
				return (): void => {
					group.delete(handler);
				};
			},
			registerTool: (tool: ToolDefinition): void => {
				tools.push(tool);
			},
			registerCommand: (): void => undefined,
			getActiveTools: (): readonly string[] => active,
			setActiveTools: (names: string[]): void => {
				active = names;
			},
		} as unknown as ExtensionAPI,
		tools,
		activeTools: () => active,
		emit: (event: string, ...args: unknown[]): void => {
			for (const handler of listeners.get(event) ?? []) handler(...args);
		},
	};
}

/** The tool registered under this name; a missing tool fails the test instead of the assertion. */
export function toolFor(tools: readonly ToolDefinition[], name: string): ToolDefinition {
	const tool = tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`${name} was not registered`);
	return tool;
}

/** The same host double. */
export function framedHost(activeTools?: readonly string[]): ReturnType<typeof toolHost> {
	return toolHost(activeTools);
}

/** Pi's repaint handle: a mounted tool only needs to be able to ask for a frame. */
const silentUi = { requestRender: (): void => undefined } as unknown as TUI;

/** A tool definition in the shape Pi accepts when mounting a call. */
type MountedTool = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;

/** Mounts a registered tool the way Pi does: one component per call, at a given cwd. */
export function mountTool(
	name: string,
	toolCallId: string,
	tool: MountedTool,
	args: unknown = {},
	cwd: string = process.cwd(),
	ui: TUI = silentUi,
): ToolExecutionComponent {
	initTheme("dark");
	return new ToolExecutionComponent(name, toolCallId, args, undefined, tool, ui, cwd);
}
