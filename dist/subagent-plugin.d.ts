import type { Context } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-subagent';
import '@deepseek-ai/dsh-tools';
import '@deepseek-ai/dsh-system-prompt';
import { type SubagentPluginConfig } from './shared/config.js';
export declare const name = "subagent-antigravity-acp";
export declare const inject: string[];
export declare const Config: import("@deepseek-ai/schemastery").default<Partial<SubagentPluginConfig>, SubagentPluginConfig>;
/**
 * Cordis plugin registering {@link AntigravitySubagentProvider} on `ctx.subagents`,
 * plus the model-facing `antigravity_agent` tool (`ctx.tools`), `antigravity-subagent`
 * skill (`ctx.skills`), and prompt guidance (`ctx.systemPrompt`) when those host
 * services are mounted.
 */
export declare function apply(ctx: Context, config: SubagentPluginConfig): void;
export { AntigravitySubagentProvider, resolveSubagentPermission, type SubagentProviderLogger, } from './subagent/provider.js';
export { ANTIGRAVITY_SUBAGENT_SKILL_NAME, registerAntigravitySubagentSkill, registerAntigravitySystemPrompt, renderAntigravitySkillContent, } from './subagent/skill.js';
export { createAntigravitySubagentTool, DEFAULT_ANTIGRAVITY_TOOL_NAME, type CreateAntigravitySubagentToolOptions, } from './subagent/tool.js';
export { mergeSubagentConfigWithOverrides, type AntigravitySubagentCallOverrides, } from './subagent/overrides.js';
//# sourceMappingURL=subagent-plugin.d.ts.map