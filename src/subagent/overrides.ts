import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SubagentPluginConfig, SubagentUiOverrides } from '../shared/config.js';

/** Per-invocation overrides passed from `antigravity_agent` tool arguments. */
export interface AntigravitySubagentCallOverrides {
  readonly model?: string;
  readonly thoughtLevel?: string;
}

const pendingCallOverrides = new WeakMap<
  readonly ContentBlock[],
  AntigravitySubagentCallOverrides
>();

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Attach per-call model/thinking overrides keyed on the request's `prompt` block array.
 * Safe for external `SubagentStartRequest` calls because DSH preserves `request.prompt` by reference.
 */
export function setPendingCallOverrides(
  prompt: readonly ContentBlock[],
  overrides: AntigravitySubagentCallOverrides,
): void {
  const normalized: AntigravitySubagentCallOverrides = {
    ...(normalizeOptionalString(overrides.model) !== undefined
      ? { model: normalizeOptionalString(overrides.model) }
      : {}),
    ...(normalizeOptionalString(overrides.thoughtLevel) !== undefined
      ? { thoughtLevel: normalizeOptionalString(overrides.thoughtLevel) }
      : {}),
  };
  if (normalized.model !== undefined || normalized.thoughtLevel !== undefined) {
    pendingCallOverrides.set(prompt, normalized);
  }
}

/** Read and remove any attached per-call overrides for a subagent start request. */
export function consumePendingCallOverrides(
  prompt: readonly ContentBlock[],
): AntigravitySubagentCallOverrides | undefined {
  const entry = pendingCallOverrides.get(prompt);
  if (entry !== undefined) {
    pendingCallOverrides.delete(prompt);
  }
  return entry;
}

/** Clear unconsumed per-call overrides (e.g. if activation startup throws before `provider.start`). */
export function clearPendingCallOverrides(prompt: readonly ContentBlock[]): void {
  pendingCallOverrides.delete(prompt);
}

/**
 * Merge persisted/live UI subagent overrides onto a base {@link SubagentPluginConfig}.
 */
export function mergeSubagentConfigWithOverrides(
  baseConfig: SubagentPluginConfig,
  overrides: SubagentUiOverrides = {},
): SubagentPluginConfig {
  const merged: SubagentPluginConfig = { ...baseConfig };

  if ('defaultModel' in overrides) {
    const val = normalizeOptionalString(overrides.defaultModel);
    if (val === undefined) {
      delete merged.defaultModel;
    } else {
      merged.defaultModel = val;
    }
  }

  if ('defaultThoughtLevel' in overrides) {
    const val = normalizeOptionalString(overrides.defaultThoughtLevel);
    if (val === undefined) {
      delete merged.defaultThoughtLevel;
    } else {
      merged.defaultThoughtLevel = val;
    }
  }

  if ('systemPromptAppend' in overrides) {
    const val = normalizeOptionalString(overrides.systemPromptAppend);
    if (val === undefined) {
      delete merged.systemPromptAppend;
    } else {
      merged.systemPromptAppend = val;
    }
  }

  if (overrides.permissionMode !== undefined) {
    merged.permissionMode = overrides.permissionMode;
  }

  if (overrides.permissionFallback !== undefined) {
    merged.permissionFallback = overrides.permissionFallback;
  }

  return merged;
}
