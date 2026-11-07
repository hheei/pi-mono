/**
 * Side-effect-free coordination contracts for independently installed Pi extensions.
 * Concrete packages own commands, state, policy, and rendering; core only owns
 * shared registration, lifecycle, cancellation, and cross-package coordination.
 */

export type { ToolRenderers } from "@earendil-works/pi-coding-agent";
export type {
	BackgroundDelivery,
	BackgroundDeliveryChannel,
	BackgroundDeliveryRegistration,
} from "./background-delivery.js";
export { createBackgroundDelivery, getBackgroundDelivery } from "./background-delivery.js";
export type { SubcommandCompletions } from "./command-completions.js";
export { splitSubcommand, subcommandCompletions } from "./command-completions.js";
export {
	estimateEntryTokens,
	estimateTextTokens,
} from "./context-usage.js";
export type {
	OpenTuiSurfaceOptions,
	TuiSurfaceContext,
	TuiSurfaceResult,
} from "./custom-surface.js";
export { openTuiSurface, TuiSurfaceBusyError } from "./custom-surface.js";
export type { Cleanup, CleanupFailure, DisposerRegistry } from "./disposer-registry.js";
export { abortError, errorMessage, throwIfAborted } from "./errors.js";
export type {
	ExtensionPointHandle,
	ExtensionPointKey,
	OpenExtensionPointOptions,
} from "./extension-point.js";
export {
	createExtensionPointKey,
	openExtensionPoint,
	readExtensionHooks,
	registerExtensionHook,
} from "./extension-point.js";
export { getGlobalState } from "./global-state.js";
export type {
	ExtensionSettingsPaths,
	JsonSettingsValueSource,
	MergedJsonSettingsSection,
	ReadMergedJsonSettingsSectionOptions,
} from "./json-settings.js";
export {
	defaultExtensionSettingsPaths,
	readJsonSettingsRoot,
	readJsonSettingsSection,
	readMergedJsonSettingsSection,
	updateJsonSettingsRoot,
} from "./json-settings.js";
export type { ExtensionLifecycleContext, ExtensionLifecycleOptions } from "./lifecycle.js";
export { registerExtensionLifecycle } from "./lifecycle.js";
export type {
	MessageRows,
	MessageTone,
	MessageViewFactory,
	MessageViewHeader,
	MessageViewSpec,
} from "./message-view-point.js";
export { messageViewPoint, readMessageView } from "./message-view-point.js";
export type {
	CreateModelSelectionFieldOptions,
	ModelSelectionCandidate,
	ModelSelectionOption,
	ModelSelectionRegistry,
	ModelThinkingCycle,
	ModelThinkingLevel,
	ModelThinkingResolver,
} from "./model-selection.js";
export {
	authenticatedModelSelectionOptions,
	clampThinkingLevel,
	createModelSelectionField,
	modelSelectionOptions,
	thinkingGlyph,
} from "./model-selection.js";
export type { BashOutputResult } from "./output-tail.js";
export { BashOutputSink, DEFAULT_VISIBLE_TAIL_BYTES } from "./output-tail.js";
export type {
	ExtensionPageRegistration,
	ExtensionPageView,
	ExtensionPageViewContext,
	OpenExtensionPageRouterOptions,
} from "./page-router.js";
export { openExtensionPageRouter, registerExtensionPage } from "./page-router.js";
export {
	calculateScrollTop,
	LIST_HINT_ROWS,
	PANEL_ROWS,
	pad,
	STACKED_LIST_ROWS,
	WIDE_COLUMNS,
} from "./panel-layout.js";
export { panelScrollbar } from "./panel-scrollbar.js";
export { expandHome } from "./paths.js";
export type { CommandOptions, CommandResult } from "./process.js";
export { isSubagentProcess, runCommand, shellQuote } from "./process.js";
export {
	OPTIONAL_TOOLS_PREAMBLE,
	OPTIONAL_TOOLS_SECTION,
	setOptionalToolBullet,
	setPromptSection,
	setSectionBullet,
} from "./prompt-section.js";
export { isRecord } from "./record.js";
export type { RenderThrottle } from "./render-throttle.js";
export {
	createRenderThrottle,
	HOST_FRAME_INTERVAL_MS,
	STREAM_REPAINT_INTERVAL_MS,
} from "./render-throttle.js";
export type {
	ColorFn,
	ResponseStatusFeature,
	TelemetryMetrics,
	ThemeLike,
} from "./response-status.js";
export {
	createResponseStatusFeature,
	formatCompactNumber,
	formatDurationColor,
	formatRate,
	formatTelemetryStatus,
	TELEMETRY_DISMISS_DELAY_MS,
} from "./response-status.js";
export { fitRow } from "./row-fit.js";
export {
	extractShellCommands,
	isSearchOnlyCommand,
	SEARCH_BASH_TIMEOUT_SECONDS,
	SEARCH_TIMEOUT_MS,
} from "./search-command.js";
export type {
	MemoryCompactorService,
	ServiceKey,
} from "./service.js";
export {
	createServiceKey,
	getService,
	MEMORY_COMPACTOR_SERVICE_KEY,
	provideService,
} from "./service.js";
export type {
	JsonSettingsStorageOptions,
	SettingChange,
	SettingField,
	SettingGroup,
	SettingOption,
	SettingPrimitive,
	SettingsContext,
	SettingsPanel,
	SettingsProvider,
	SettingsRegistry,
	SettingsState,
	SettingsStorage,
	SettingTabCycle,
	SettingType,
	SettingValue,
} from "./settings.js";
export {
	createJsonSettingsStorage,
	getRuntimeSettingsRegistry,
	registerSettings,
} from "./settings.js";
export { defaultShellPath } from "./shell.js";
export { escapeXml } from "./text.js";
export type { SpilledOutput, ToolOutputLimits } from "./tool-output.js";
export {
	budgetMultiplier,
	CHARS_PER_TOKEN,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	DEFAULT_MAX_TOKENS,
	fitsOutputBudget,
	limitsForCalls,
	MAX_BUDGET_MULTIPLIER,
	SPILL_NOTE_PREFIX,
	truncateWithSpill,
} from "./tool-output.js";
export { capToolResult, outputPrefixFor, registerToolOutputCap } from "./tool-output-cap.js";
export type {
	BaseToolPresentation,
	DiffToolPresentation,
	TextToolPresentation,
	ToolPresentation,
	ToolPresentationChild,
	ToolPresentationContext,
	ToolPresentationProvider,
	ToolPresentationSection,
	ToolPresentationStatus,
} from "./tool-presentation.js";
export {
	createToolPresentationRenderers,
	getRegisteredToolPresentationProvider,
	getToolPresentationProvider,
} from "./tool-presentation.js";
export type { ToolRendererFactory } from "./tool-renderer-point.js";
export {
	createOptionalToolRenderers,
	getRegisteredToolRenderers,
	hasOptionalToolRenderers,
	toolRendererPoint,
} from "./tool-renderer-point.js";
export { agentResultText, formatDuration, textToolResult } from "./tool-result.js";
export type {
	WidgetHandle,
	WidgetPlacement,
	WidgetRegistration,
	WidgetSuspension,
} from "./widgets.js";
export { registerWidget, suspendWidgets } from "./widgets.js";
