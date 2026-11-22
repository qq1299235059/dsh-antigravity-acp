import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-subagent';
import {
  SubagentPluginConfigSchema,
  type SubagentPluginConfig,
} from './shared/config.js';
import type {} from './shared/contracts.js';
import { AntigravitySubagentProvider } from './subagent/provider.js';

export const name = 'subagent-antigravity-acp';
export const inject = ['subagents', 'antigravityRuntime'];
export const Config = SubagentPluginConfigSchema;

/**
 * Cordis plugin registering {@link AntigravitySubagentProvider} into `ctx.subagents`.
 * Named exports only (DSH Cordis loader requirement).
 */
export function apply(ctx: Context, config: SubagentPluginConfig): void {
  const provider = new AntigravitySubagentProvider(
    ctx.antigravityRuntime,
    config,
    ctx.get('attachments'),
    ctx.logger(name),
  );

  const disposeProvider = ctx.subagents.registerProvider(provider);
  ctx.effect(
    () => () => {
      disposeProvider();
    },
    `${name}.registerProvider`,
  );
}

export {
  AntigravitySubagentProvider,
  resolveSubagentPermission,
  type SubagentProviderLogger,
} from './subagent/provider.js';
