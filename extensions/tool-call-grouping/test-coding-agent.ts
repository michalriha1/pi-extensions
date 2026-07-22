export type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "../../../packages/coding-agent/src/core/extensions/types.ts";
export { createBashToolDefinition } from "../../../packages/coding-agent/src/core/tools/bash.ts";
export { AssistantMessageComponent } from "../../../packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
export { ToolExecutionComponent } from "../../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
export { initTheme, theme, type Theme } from "../../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
