import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import type { SubagentPluginConfig } from '../shared/config.js';
export declare const DEFAULT_ANTIGRAVITY_TOOL_NAME = "antigravity_agent";
/** Options for creating the model-facing Antigravity subagent delegation tool. */
export interface CreateAntigravitySubagentToolOptions {
    readonly subagents: SubagentRuntime;
    readonly getConfig: () => SubagentPluginConfig;
    readonly toolName?: string;
}
/**
 * Create the model-facing `antigravity_agent` DSH tool that executes tasks through
 * `ctx.subagents.startActivation({ delivery: 'caller' })` backed by {@link AntigravitySubagentProvider}.
 */
export declare function createAntigravitySubagentTool(options: CreateAntigravitySubagentToolOptions): ToolDefinition;
//# sourceMappingURL=tool.d.ts.map