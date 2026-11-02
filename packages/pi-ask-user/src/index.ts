import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserSettings } from "./settings-provider";
import { registerAskUserTool } from "./tool";

export default function askUser(pi: ExtensionAPI): void {
	registerAskUserTool(pi);
	registerAskUserSettings(pi);
}
