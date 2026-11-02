import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setOptionalToolBullet } from "@hheei/pi-ext-core";
import type { SubagentManager } from "./manager.js";

/** Interactive agent tools managed by dynamic activation. */
export const INTERACTIVE_TOOL_NAMES = [
	"agents_delegate",
	"agents_get",
	"agents_stop",
	"agents_dashboard",
] as const;

export const SUBAGENT_OPTIONAL_TOOL_KEY = "subagents";
export const SUBAGENT_OPTIONAL_TOOL_BULLET =
	'subagents (query: "agent"): Agent orchestration and delegation (agents_delegate, agents_get, agents_stop, agents_dashboard).';

export interface RegisterInteractiveToolActivationOptions {
	readonly pi: ExtensionAPI;
	readonly manager: SubagentManager;
	readonly context: ExtensionContext;
}

export interface InteractiveToolActivationHandle {
	dispose(): void;
	selectFromSession(ctx: ExtensionContext): Promise<void>;
}

export function registerInteractiveToolActivation(
	options: RegisterInteractiveToolActivationOptions,
): InteractiveToolActivationHandle {
	const { pi } = options;

	const unbindBeforeAgent = pi.on(
		"before_agent_start",
		(event: { systemPromptOptions?: { sections: Record<string, string> } }) => {
			const sections = event.systemPromptOptions?.sections;
			if (sections !== undefined) {
				setOptionalToolBullet(sections, SUBAGENT_OPTIONAL_TOOL_KEY, SUBAGENT_OPTIONAL_TOOL_BULLET);
			}
		},
	);

	return {
		dispose() {
			unbindBeforeAgent();
		},
		selectFromSession: async () => {},
	};
}
