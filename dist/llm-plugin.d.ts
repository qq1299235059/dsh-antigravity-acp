import type { Context } from '@deepseek-ai/cordis';
import { type LlmPluginConfig } from './shared/config.js';
export declare const name = "llm-antigravity-acp";
export declare const inject: string[];
export declare const Config: import("@deepseek-ai/schemastery").default<Partial<LlmPluginConfig>, LlmPluginConfig>;
/**
 * Cordis plugin registering {@link AntigravityLlmAdapter} into `ctx.llm`.
 * Named exports only (DSH Cordis loader requirement).
 */
export declare function apply(ctx: Context, config: LlmPluginConfig): void;
export { AntigravityLlmAdapter, type AdapterLogger, type AntigravityLlmAdapterDeps, } from './llm/adapter.js';
//# sourceMappingURL=llm-plugin.d.ts.map