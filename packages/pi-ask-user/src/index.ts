import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reconcileAskUserTool } from "./reconcile";
import { registerAskUserTool } from "./tool";

export default function askUser(pi: ExtensionAPI): void {
	registerAskUserTool(pi);
	pi.on("before_agent_start", (_event, ctx) => {
		reconcileAskUserTool(pi, ctx);
	});
}

export { reconcileAskUserTool };
