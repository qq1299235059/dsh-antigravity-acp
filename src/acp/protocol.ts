import type * as acp from '@agentclientprotocol/sdk';
import type { ModelModality } from '@deepseek-ai/dsh-llm';
import { compareSemver } from '../runtime/release.js';
import type { DiscoveredModel, ThinkingOption } from '../shared/contracts.js';
import { AntigravityAcpError } from '../shared/errors.js';

const CLIENT_INFO_MODERN: acp.Implementation = {
  name: 'dsh-antigravity-acp',
  title: 'DSH Antigravity ACP',
  version: '0.1.0',
};

const CLIENT_INFO_LEGACY: acp.Implementation = {
  name: 'zed',
  version: '0.0.0',
};

const SEMVER_PREFIX_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?$/;
const NO_BROWSER_ERROR_FRAGMENT = 'no browser is available here';
const BACKGROUND_TITLE_PATTERN =
  /\b(?:background|bg_process|start_background|detached|daemon|run_in_background)\b|in background/i;

/** Legacy ACP model entry shape returned by agents predating `configOptions`. */
export interface AcpModelInfo {
  readonly modelId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly _meta?: Record<string, unknown> | null;
}

/** Legacy ACP session model state shape returned alongside or instead of `configOptions`. */
export interface AcpSessionModelState {
  readonly currentModelId?: string | null;
  readonly availableModels: readonly AcpModelInfo[];
}

/** Permission decision kinds supported by {@link selectPermissionOption}. */
export type PermissionDecisionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Select the ACP `clientInfo` payload appropriate for the target Antigravity CLI version.
 *
 * Antigravity CLI `< 1.5.1` expects the legacy `'zed'` client identity, while `>= 1.5.1`
 * (and unknown versions where `>= 1.5.0` is assumed) identifies as `dsh-antigravity-acp`.
 */
export function antigravityClientInfo(version?: string | null): acp.Implementation {
  const trimmed = version?.trim();
  if (!trimmed) {
    return CLIENT_INFO_MODERN;
  }

  const match = SEMVER_PREFIX_PATTERN.exec(trimmed);
  if (!match?.[1]) {
    return CLIENT_INFO_MODERN;
  }

  try {
    return compareSemver(match[1], '1.5.1') < 0 ? CLIENT_INFO_LEGACY : CLIENT_INFO_MODERN;
  } catch {
    return CLIENT_INFO_MODERN;
  }
}

/**
 * Check whether an agent advertises Antigravity's `_meta.antigravity.systemPrompt.append` capability.
 */
export function antigravityAppendsSystemPrompt(
  capabilities?: acp.AgentCapabilities | null,
): boolean {
  const meta = capabilities?._meta;
  if (!isPlainRecord(meta)) {
    return false;
  }
  const antigravity = meta['antigravity'];
  if (!isPlainRecord(antigravity)) {
    return false;
  }
  const systemPrompt = antigravity['systemPrompt'];
  if (!isPlainRecord(systemPrompt)) {
    return false;
  }
  return systemPrompt['append'] === true;
}

/**
 * Build ACP `session/new` `_meta` carrying `antigravity.systemPrompt.append` when supported.
 */
export function antigravitySessionMeta(
  capabilities?: acp.AgentCapabilities | null,
  systemPromptAppend?: string | null,
): Record<string, unknown> | undefined {
  if (!antigravityAppendsSystemPrompt(capabilities)) {
    return undefined;
  }
  if (typeof systemPromptAppend !== 'string' || systemPromptAppend.trim().length === 0) {
    return undefined;
  }
  return {
    antigravity: {
      systemPrompt: {
        append: systemPromptAppend,
      },
    },
  };
}

/**
 * Normalize a configured permission/session mode to one accepted by Antigravity ACP.
 *
 * Antigravity CLI rejects `'yolo'` and `'auto_edit'` in `session/set_mode`, so both map to
 * `'default'`. `'auto'` is preserved only when advertised in `availableModes`.
 */
export function antigravitySessionMode(
  modeId: string,
  availableModes?: readonly { readonly id: string }[] | null,
): string {
  const normalized = modeId.trim();
  if (!normalized || normalized === 'yolo' || normalized === 'auto_edit') {
    return 'default';
  }
  if (normalized === 'auto') {
    return availableModes?.some((mode) => mode.id === 'auto') ? 'auto' : 'default';
  }
  if (availableModes && availableModes.length > 0) {
    return availableModes.some((mode) => mode.id === normalized) ? normalized : 'default';
  }
  return normalized;
}

const PERMISSION_FALLBACK_ORDER: Record<PermissionDecisionKind, readonly acp.PermissionOptionKind[]> =
  {
    allow_once: ['allow_once', 'allow_always'],
    allow_always: ['allow_always', 'allow_once'],
    reject_once: ['reject_once', 'reject_always'],
    reject_always: ['reject_always', 'reject_once'],
  };

/**
 * Pick the best matching {@link acp.PermissionOption} for a target decision kind.
 *
 * Never crosses the allow/reject boundary when falling back between `once` and `always`.
 */
export function selectPermissionOption(
  options: readonly acp.PermissionOption[],
  decision: PermissionDecisionKind,
): acp.PermissionOption | undefined {
  const preference = PERMISSION_FALLBACK_ORDER[decision];
  for (const kind of preference) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function flattenSelectOptions(
  options: acp.SessionConfigSelectOptions,
): readonly acp.SessionConfigSelectOption[] {
  const flattened: acp.SessionConfigSelectOption[] = [];
  for (const entry of options) {
    if ('options' in entry && Array.isArray(entry.options)) {
      flattened.push(...entry.options);
    } else if ('value' in entry) {
      flattened.push(entry);
    }
  }
  return flattened;
}

function parseMetaPositiveInt(meta: Record<string, unknown> | null | undefined, keys: readonly string[]): number | undefined {
  if (!meta) {
    return undefined;
  }
  for (const key of keys) {
    const val = meta[key];
    if (typeof val === 'number' && Number.isInteger(val) && val > 0) {
      return val;
    }
  }
  return undefined;
}

function parseMetaModalities(meta: Record<string, unknown> | null | undefined): readonly ModelModality[] | undefined {
  if (!meta) {
    return undefined;
  }
  const raw = meta['inputModalities'] ?? meta['input_modalities'];
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const valid = raw.filter(
    (entry): entry is ModelModality => entry === 'text' || entry === 'image',
  );
  return valid.length > 0 ? valid : undefined;
}

/**
 * Parse ACP `configOptions` (and legacy `models` fallback) into normalized {@link DiscoveredModel}s.
 */
export function parseModelsAndThinking(setup: {
  readonly configOptions?: readonly acp.SessionConfigOption[] | null;
  readonly models?: AcpSessionModelState | null;
}): DiscoveredModel[] {
  const configOptions = setup.configOptions ?? [];

  const thoughtOption =
    configOptions.find(
      (opt): opt is acp.SessionConfigSelect & acp.SessionConfigOption =>
        opt.type === 'select' && opt.category === 'thought_level',
    ) ??
    configOptions.find(
      (opt): opt is acp.SessionConfigSelect & acp.SessionConfigOption =>
        opt.type === 'select' && (opt.id === 'thought_level' || opt.id === 'reasoning_effort'),
    );

  const thinkingOptions: ThinkingOption[] = thoughtOption
    ? flattenSelectOptions(thoughtOption.options)
        .filter((item) => item.value.trim().length > 0)
        .map((item) => ({
          id: item.value,
          name: item.name || item.value,
          ...(item.description ? { description: item.description } : {}),
          configId: thoughtOption.id,
        }))
    : [];

  const defaultThoughtLevel =
    thoughtOption && thoughtOption.currentValue.trim().length > 0
      ? thoughtOption.currentValue
      : undefined;

  const modelOption =
    configOptions.find(
      (opt): opt is acp.SessionConfigSelect & acp.SessionConfigOption =>
        opt.type === 'select' && opt.category === 'model',
    ) ??
    configOptions.find(
      (opt): opt is acp.SessionConfigSelect & acp.SessionConfigOption =>
        opt.type === 'select' && opt.id === 'model',
    );

  const legacyById = new Map<string, AcpModelInfo>();
  for (const legacy of setup.models?.availableModels ?? []) {
    if (legacy.modelId.trim().length > 0) {
      legacyById.set(legacy.modelId, legacy);
    }
  }

  const models: DiscoveredModel[] = [];
  const seenIds = new Set<string>();

  if (modelOption) {
    for (const item of flattenSelectOptions(modelOption.options)) {
      const id = item.value.trim();
      if (!id || seenIds.has(id)) {
        continue;
      }
      seenIds.add(id);

      const legacy = legacyById.get(id);
      const description = item.description ?? legacy?.description ?? undefined;
      const meta = isPlainRecord(item._meta)
        ? item._meta
        : isPlainRecord(legacy?._meta)
          ? legacy._meta
          : undefined;
      const contextWindow = parseMetaPositiveInt(meta, ['contextWindow', 'context_window']);
      const maxTokens = parseMetaPositiveInt(meta, ['maxTokens', 'max_tokens']);
      const inputModalities = parseMetaModalities(meta);

      models.push({
        id,
        name: item.name?.trim() || legacy?.name?.trim() || id,
        ...(description ? { description } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(inputModalities !== undefined ? { inputModalities } : {}),
        ...(thinkingOptions.length > 0 ? { thinkingOptions } : {}),
        ...(defaultThoughtLevel !== undefined ? { defaultThoughtLevel } : {}),
        isDefault: modelOption.currentValue === id,
      });
    }
  }

  if (models.length === 0 && setup.models?.availableModels) {
    const currentId = setup.models.currentModelId ?? undefined;
    for (const item of setup.models.availableModels) {
      const id = item.modelId.trim();
      if (!id || seenIds.has(id)) {
        continue;
      }
      seenIds.add(id);

      const meta = isPlainRecord(item._meta) ? item._meta : undefined;
      const contextWindow = parseMetaPositiveInt(meta, ['contextWindow', 'context_window']);
      const maxTokens = parseMetaPositiveInt(meta, ['maxTokens', 'max_tokens']);
      const inputModalities = parseMetaModalities(meta);

      models.push({
        id,
        name: item.name?.trim() || id,
        ...(item.description ? { description: item.description } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(inputModalities !== undefined ? { inputModalities } : {}),
        ...(thinkingOptions.length > 0 ? { thinkingOptions } : {}),
        ...(defaultThoughtLevel !== undefined ? { defaultThoughtLevel } : {}),
        isDefault: currentId === id,
      });
    }
  }

  return models;
}

function collectErrorText(value: unknown, depth = 0): string {
  if (depth > 3 || value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value !== 'object') {
    return '';
  }
  const parts: string[] = [];
  const record = value as Record<string, unknown>;
  if (typeof record['message'] === 'string') {
    parts.push(record['message']);
  }
  if (typeof record['details'] === 'string') {
    parts.push(record['details']);
  }
  if ('data' in record && record['data'] !== undefined) {
    parts.push(collectErrorText(record['data'], depth + 1));
  }
  return parts.join(' ');
}

/**
 * Determine whether an ACP or runtime error indicates interactive sign-in is required.
 */
export function isSignInRequiredError(error: unknown, depth = 0): boolean {
  if (depth > 5 || error == null) {
    return false;
  }

  if (error instanceof AntigravityAcpError && error.code === 'AGY_AUTH_REQUIRED') {
    return true;
  }

  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const code = record['code'];
    if (code === 'AGY_AUTH_REQUIRED' || code === -32000) {
      return true;
    }
    if (code === -32603) {
      const text = collectErrorText(record).toLowerCase();
      if (text.includes(NO_BROWSER_ERROR_FRAGMENT)) {
        return true;
      }
    }
    if ('cause' in record && record['cause'] !== undefined) {
      return isSignInRequiredError(record['cause'], depth + 1);
    }
  }

  return false;
}

/**
 * Check whether tool-call `_meta` marks an MCP-bridged tool invocation rather than a native CLI tool.
 */
export function isMcpToolCallMeta(meta: unknown): boolean {
  return Boolean(isPlainRecord(meta) && meta['is_mcp_tool_call'] === true);
}

function parseRawInputRecord(rawInput: unknown): Record<string, unknown> | undefined {
  if (isPlainRecord(rawInput)) {
    return rawInput;
  }
  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        return isPlainRecord(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Determine whether an Antigravity tool call spawns background work that can outlive the prompt turn.
 */
export function antigravityToolOutlivesPrompt(toolCall: {
  readonly kind?: string | null;
  readonly title?: string | null;
  readonly name?: string | null;
  readonly rawInput?: unknown;
}): boolean {
  const input = parseRawInputRecord(toolCall.rawInput);
  if (input) {
    const backgroundFlags = [
      input['background'],
      input['is_background'],
      input['isBackground'],
      input['run_in_background'],
      input['runInBackground'],
      input['detached'],
      input['isDaemon'],
      input['daemon'],
      input['keepAlive'],
      input['keep_alive'],
    ];
    if (backgroundFlags.some((flag) => flag === true)) {
      return true;
    }
  }

  const label = [toolCall.name, toolCall.title]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
  if (label && BACKGROUND_TITLE_PATTERN.test(label)) {
    return true;
  }

  return false;
}

/**
 * Map an ACP {@link acp.StopReason} to DSH's coarse LLM stop-reason category.
 */
export function normalizeStopReasonToLlm(
  reason: acp.StopReason | string,
): 'stop' | 'max-tokens' | 'error' {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'max-tokens';
    default:
      return 'error';
  }
}
