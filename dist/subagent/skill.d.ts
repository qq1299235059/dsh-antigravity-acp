import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import type { ToolDefinition, ToolsService } from '@deepseek-ai/dsh-tools';
import type { SubagentPluginConfig } from '../shared/config.js';
export declare const ANTIGRAVITY_SUBAGENT_SKILL_NAME = "antigravity-subagent";
export declare const ANTIGRAVITY_SKILL_PROVIDER_NAME = "dsh-antigravity-acp";
/** Minimal structural view of `@deepseek-ai/dsh-skill` `SkillRegistry`. */
export interface SkillRegistryLike {
    registerProvider?(create: (control: {
        signal: AbortSignal;
        invalidate(): void;
    }) => {
        readonly name: string;
        list(): Promise<readonly Record<string, unknown>[]>;
        get(candidate: unknown): Promise<Record<string, unknown> | undefined>;
    }): () => void;
    register?(skill: {
        readonly name: string;
        readonly description: string;
        readonly whenToUse?: string;
        readonly invocation?: {
            readonly modelInvocable: boolean;
            readonly userInvocable: boolean;
        };
        readonly source: string;
        readonly content: string;
        readonly provider?: string;
    }): () => void;
}
export interface RegisterAntigravitySkillOptions {
    readonly skills: SkillRegistryLike;
    readonly getConfig: () => SubagentPluginConfig;
    readonly subscribeConfigChange?: (listener: () => void) => () => void;
}
export interface RegisterAntigravitySystemPromptOptions {
    readonly systemPrompt: SystemPrompt;
    readonly tools: ToolsService;
    readonly toolDefinition: ToolDefinition;
    readonly getConfig: () => SubagentPluginConfig;
}
export declare function renderAntigravitySkillContent(config: SubagentPluginConfig): string;
/**
 * Register the `antigravity-subagent` skill on DSH's `ctx.skills` registry.
 * Uses `registerProvider` when supported so the loaded skill body always reflects
 * live model settings from Settings -> Antigravity ACP without churning the skill catalog summary.
 */
export declare function registerAntigravitySubagentSkill(options: RegisterAntigravitySkillOptions): () => void;
/**
 * Register a lightweight prompt section in `ctx.systemPrompt` (at `TOOL_SUBAGENT` order)
 * whenever the `antigravity_agent` tool is visible in the active agent scope.
 */
export declare function registerAntigravitySystemPrompt(options: RegisterAntigravitySystemPromptOptions): () => void;
//# sourceMappingURL=skill.d.ts.map