import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getRuntimeSettingsRegistry,
	type MessageViewSpec,
	messageViewPoint,
	registerExtensionHook,
	registerExtensionLifecycle,
	registerSettings,
	toolRendererPoint,
} from "@hheei/pi-ext-core";
import { linkPaths, resolveLocalLinks } from "./file-links.js";
import { installHostToolGroups } from "./host-transcript-patch.js";
import { createMessageView } from "./message-view.js";
import { createOptionalToolRendererFactory, registerCollapsibleToolRenderer } from "./renderer.js";
import { ToolUiRuntime } from "./runtime.js";
import {
	activityGroupsEnabled,
	createToolGroupSettings,
	toolBackgroundsEnabled,
	toolCopyControlEnabled,
} from "./settings.js";

export default function (pi: ExtensionAPI): void {
	// One runtime per extension instance: two Pi runtimes in one process never share these facts.
	const runtime = new ToolUiRuntime();
	let redrawGroups: (() => void) | undefined;
	pi.on("agent_settled", () => redrawGroups?.());
	registerCollapsibleToolRenderer(pi, runtime);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-ui",
		async start(context) {
			let patch:
				| { dispose(): void; requestRender(): void; beginRun(): void; endRun(): void }
				| undefined;
			// The host owns this setting; a message view that draws its own shell applies the same
			// value the host applies to its own rows, including the default when it is unset.
			const outputPad = (): number => (context.pi.getSettings().outputPad === 0 ? 0 : 1);
			const apply = (enabled: boolean): void => {
				if (context.extension.mode !== "tui") return;
				if (!enabled) {
					redrawGroups = undefined;
					patch?.dispose();
					patch = undefined;
					return;
				}
				if (patch !== undefined) return;
				try {
					patch = installHostToolGroups(context.extension, () => runtime.backgrounds, outputPad);
					redrawGroups = patch.requestRender;
				} catch (error) {
					context.extension.ui.notify(
						error instanceof Error ? error.message : String(error),
						"warning",
					);
				}
			};
			const applyBackgrounds = (enabled: boolean): void => {
				runtime.backgrounds = enabled;
				redrawGroups?.();
			};
			const applyCopyControl = (enabled: boolean): void => {
				runtime.copyControl = enabled;
				redrawGroups?.();
			};
			const provider = createToolGroupSettings({
				onEnabled: apply,
				onBackgrounds: applyBackgrounds,
				onCopyControl: applyCopyControl,
			});
			const onAgentStart = pi.on("agent_start", () => {
				patch?.beginRun();
				redrawGroups?.();
			});
			const onAgentEnd = pi.on("agent_end", () => {
				patch?.endRun();
				redrawGroups?.();
			});
			// The live glyph clock lives with the rows that draw it, so nothing here ticks.
			context.resources.add("run-clock", () => {
				onAgentStart();
				onAgentEnd();
			});
			context.resources.add(
				"tool-group-settings",
				registerSettings(provider, getRuntimeSettingsRegistry(pi)),
			);
			// A host that resolves paths itself, or a reader on another machine, keeps them as text.
			if (await resolveLocalLinks(pi, process.env)) {
				pi.registerMarkdownTransformer((markdown) => linkPaths(markdown));
			}
			context.resources.add("tool-groups", () => {
				redrawGroups = undefined;
				patch?.dispose();
				patch = undefined;
			});
			context.resources.add("tracker-cleanup", () => {
				runtime.tracker.clear();
			});
			// Resume reads the host's own nested-call record for the current branch, never another one.
			runtime.nestedCalls.setSource(context.extension.sessionManager);
			context.resources.add("nested-call-source", () => {
				runtime.nestedCalls.setSource(undefined);
			});
			const toolRenderers = registerExtensionHook(
				pi,
				toolRendererPoint,
				createOptionalToolRendererFactory(pi, runtime),
			);
			context.resources.add("tool-renderer", () => toolRenderers.dispose());
			const handle = registerExtensionHook(context.pi, messageViewPoint, (spec: MessageViewSpec) =>
				createMessageView({ ...spec, outputPad: spec.outputPad ?? outputPad() }),
			);
			context.resources.add("message-view", () => handle.dispose());
			try {
				const state = await provider.storage.load({
					sessionId: context.extension.sessionManager.getSessionId(),
					signal: context.signal,
				});
				if (!context.signal.aborted) {
					apply(activityGroupsEnabled(state));
					applyBackgrounds(toolBackgroundsEnabled(state));
					applyCopyControl(toolCopyControlEnabled(state));
				}
			} catch (error) {
				if (!context.signal.aborted) {
					const detail = error instanceof Error ? error.message : String(error);
					context.extension.ui.notify(
						`Tool activity groups settings unreadable: ${detail}`,
						"warning",
					);
					apply(true);
					applyBackgrounds(false);
					applyCopyControl(true);
				}
			}
		},
	});
}
