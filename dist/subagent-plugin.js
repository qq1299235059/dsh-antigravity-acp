import '@deepseek-ai/dsh-subagent';
import '@deepseek-ai/dsh-tools';
import '@deepseek-ai/dsh-system-prompt';
import { SubagentPluginConfigSchema, } from './shared/config.js';
import { mergeSubagentConfigWithOverrides } from './subagent/overrides.js';
import { AntigravitySubagentProvider } from './subagent/provider.js';
import { registerAntigravitySubagentSkill, registerAntigravitySystemPrompt, } from './subagent/skill.js';
import { createAntigravitySubagentTool, } from './subagent/tool.js';
export const name = 'subagent-antigravity-acp';
export const inject = ['subagents', 'antigravityRuntime'];
export const Config = SubagentPluginConfigSchema;
/**
 * Cordis plugin registering {@link AntigravitySubagentProvider} on `ctx.subagents`,
 * plus the model-facing `antigravity_agent` tool (`ctx.tools`), `antigravity-subagent`
 * skill (`ctx.skills`), and prompt guidance (`ctx.systemPrompt`) when those host
 * services are mounted.
 */
export function apply(ctx, config) {
    ctx.antigravityRuntime.setSubagentDefaults?.({
        providerName: config.providerName,
        toolName: config.toolName,
        permissionMode: config.permissionMode,
        permissionFallback: config.permissionFallback,
        ...(config.defaultModel !== undefined ? { defaultModel: config.defaultModel } : {}),
        ...(config.defaultThoughtLevel !== undefined
            ? { defaultThoughtLevel: config.defaultThoughtLevel }
            : {}),
        ...(config.systemPromptAppend !== undefined
            ? { systemPromptAppend: config.systemPromptAppend }
            : {}),
    });
    const resolveEffectiveConfig = () => {
        const overrides = ctx.antigravityRuntime.getSubagentConfig?.() ?? {};
        return mergeSubagentConfigWithOverrides(config, overrides);
    };
    const provider = new AntigravitySubagentProvider(ctx.antigravityRuntime, resolveEffectiveConfig, ctx.get('attachments'), ctx.logger(name));
    const disposeProvider = ctx.subagents.registerProvider(provider);
    ctx.effect(() => () => {
        disposeProvider();
    }, `${name}.registerProvider`);
    ctx.inject(['tools'], (toolCtx) => {
        const toolDef = createAntigravitySubagentTool({
            subagents: ctx.subagents,
            getConfig: resolveEffectiveConfig,
            toolName: config.toolName,
        });
        toolCtx.effect(() => toolCtx.tools.register(toolDef), `${name}.registerTool`);
        toolCtx.inject(['systemPrompt'], (promptCtx) => {
            promptCtx.effect(() => registerAntigravitySystemPrompt({
                systemPrompt: promptCtx.systemPrompt,
                tools: toolCtx.tools,
                toolDefinition: toolDef,
                getConfig: resolveEffectiveConfig,
            }), `${name}.registerSystemPrompt`);
        });
    });
    ctx.inject(['skills'], (skillCtx) => {
        skillCtx.effect(() => registerAntigravitySubagentSkill({
            skills: skillCtx.skills,
            getConfig: resolveEffectiveConfig,
            subscribeConfigChange: (listener) => ctx.antigravityRuntime.onSubagentChanged?.(listener) ?? (() => { }),
        }), `${name}.registerSkill`);
    });
}
export { AntigravitySubagentProvider, resolveSubagentPermission, } from './subagent/provider.js';
export { ANTIGRAVITY_SUBAGENT_SKILL_NAME, registerAntigravitySubagentSkill, registerAntigravitySystemPrompt, renderAntigravitySkillContent, } from './subagent/skill.js';
export { createAntigravitySubagentTool, DEFAULT_ANTIGRAVITY_TOOL_NAME, } from './subagent/tool.js';
export { mergeSubagentConfigWithOverrides, } from './subagent/overrides.js';
//# sourceMappingURL=subagent-plugin.js.map