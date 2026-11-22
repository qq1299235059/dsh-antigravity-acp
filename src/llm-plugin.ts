import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-llm';
import { AntigravityLlmAdapter } from './llm/adapter.js';
import {
  LlmPluginConfigSchema,
  type LlmPluginConfig,
} from './shared/config.js';
import type {} from './shared/contracts.js';
import { redactSensitiveText } from './shared/errors.js';

export const name = 'llm-antigravity-acp';
export const inject = ['llm', 'antigravityRuntime'];
export const Config = LlmPluginConfigSchema;

/**
 * Cordis plugin registering {@link AntigravityLlmAdapter} into `ctx.llm`.
 * Named exports only (DSH Cordis loader requirement).
 */
export function apply(ctx: Context, config: LlmPluginConfig): void {
  const logger = ctx.logger(name);
  const adapter = new AntigravityLlmAdapter(ctx.antigravityRuntime, config, {
    attachments: ctx.get('attachments'),
    logger,
  });

  const disposeRegistration = ctx.llm.registerAdapter([config.providerId], adapter);
  const warmupAbort = new AbortController();
  let disposed = false;

  const triggerModelRefresh = (reason: string): void => {
    if (disposed || warmupAbort.signal.aborted || ctx.fiber.uid === null) {
      return;
    }
    void adapter.refreshModels(warmupAbort.signal).then(
      () => {
        if (!disposed && !warmupAbort.signal.aborted && ctx.fiber.uid !== null) {
          ctx.emit('llm/models-updated', config.providerId);
        }
      },
      (error: unknown) => {
        if (disposed || warmupAbort.signal.aborted) {
          return;
        }
        const message =
          error instanceof Error ? redactSensitiveText(error.message) : String(error);
        logger.debug(`${reason} skipped: ${message}`);
      },
    );
  };

  triggerModelRefresh('initial model discovery');

  const unsubscribeRuntimeChanged = ctx.antigravityRuntime.onRuntimeChanged?.(() => {
    triggerModelRefresh('runtime-change model discovery');
  });

  ctx.effect(
    () => async () => {
      disposed = true;
      unsubscribeRuntimeChanged?.();
      warmupAbort.abort();
      disposeRegistration();
      await adapter.dispose();
    },
    `${name}.lifecycle`,
  );
}

export {
  AntigravityLlmAdapter,
  type AdapterLogger,
  type AntigravityLlmAdapterDeps,
} from './llm/adapter.js';
