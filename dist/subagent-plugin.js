import { SubagentPluginConfigSchema, } from './shared/config.js';
import { AntigravitySubagentProvider } from './subagent/provider.js';
export const name = 'subagent-antigravity-acp';
export const inject = ['subagents', 'antigravityRuntime'];
export const Config = SubagentPluginConfigSchema;
/**
 * Cordis plugin registering {@link AntigravitySubagentProvider} into `ctx.subagents`.
 * Named exports only (DSH Cordis loader requirement).
 */
export function apply(ctx, config) {
    const provider = new AntigravitySubagentProvider(ctx.antigravityRuntime, config, ctx.get('attachments'), ctx.logger(name));
    const disposeProvider = ctx.subagents.registerProvider(provider);
    ctx.effect(() => () => {
        disposeProvider();
    }, `${name}.registerProvider`);
}
export { AntigravitySubagentProvider, resolveSubagentPermission, } from './subagent/provider.js';
//# sourceMappingURL=subagent-plugin.js.map