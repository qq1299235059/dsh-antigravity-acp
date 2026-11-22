import type { Context } from '@deepseek-ai/cordis';
import { type SubagentPluginConfig } from './shared/config.js';
export declare const name = "subagent-antigravity-acp";
export declare const inject: string[];
export declare const Config: import("@deepseek-ai/schemastery").default<Partial<SubagentPluginConfig>, SubagentPluginConfig>;
/**
 * Cordis plugin registering {@link AntigravitySubagentProvider} into `ctx.subagents`.
 * Named exports only (DSH Cordis loader requirement).
 */
export declare function apply(ctx: Context, config: SubagentPluginConfig): void;
export { AntigravitySubagentProvider, resolveSubagentPermission, type SubagentProviderLogger, } from './subagent/provider.js';
//# sourceMappingURL=subagent-plugin.d.ts.map