import fs from 'node:fs';
import path from 'node:path';
import { validateProxyUrl, writeFileAtomic } from '../runtime/profile.js';
import type {
  AntigravityAuthMethod,
  AntigravityPermissionFallback,
  AntigravityPermissionMode,
  RuntimeConfig,
  SubagentUiOverrides,
} from '../shared/config.js';
import type {
  AntigravitySaveConfigInput,
  AntigravitySaveSubagentConfigInput,
} from '../shared/contracts.js';
import { AntigravityAcpError } from '../shared/errors.js';
import { mergeSubagentConfigWithOverrides } from '../subagent/overrides.js';

export const UI_CONFIG_FILENAME = 'ui-config.json';
export const UI_SECRETS_FILENAME = 'ui-secrets.json';

const VALID_AUTH_METHODS = new Set<AntigravityAuthMethod>([
  'oauth-personal',
  'oauth-business',
  'gemini-api-key',
  'agent-platform',
]);

const VALID_PERMISSION_MODES = new Set<AntigravityPermissionMode>([
  'default',
  'auto_edit',
  'auto',
  'yolo',
]);

const VALID_PERMISSION_FALLBACKS = new Set<AntigravityPermissionFallback>([
  'reject',
  'cancel',
]);

const SUBAGENT_STRING_FIELDS = [
  'defaultModel',
  'defaultThoughtLevel',
  'systemPromptAppend',
] as const;

type OptionalSubagentStringField = (typeof SUBAGENT_STRING_FIELDS)[number];

interface PersistedSubagentUiConfig {
  defaultModel?: string;
  defaultThoughtLevel?: string;
  permissionMode?: AntigravityPermissionMode;
  permissionFallback?: AntigravityPermissionFallback;
  systemPromptAppend?: string;
}

const OPTIONAL_STRING_FIELDS = [
  'binaryPath',
  'gcpProject',
  'gcpLocation',
  'proxyUrl',
  'proxyBypass',
] as const;

type OptionalUiStringField = (typeof OPTIONAL_STRING_FIELDS)[number];

interface PersistedUiConfig {
  binaryPath?: string;
  autoDownload?: boolean;
  authMethod?: AntigravityAuthMethod;
  gcpProject?: string;
  gcpLocation?: string;
  proxyUrl?: string;
  proxyBypass?: string;
  subagent?: PersistedSubagentUiConfig;
}

interface PersistedUiSecrets {
  apiKey?: string;
}

const uiStoreSaveQueue = new Map<string, Promise<unknown>>();

async function withUiStoreLock<T>(
  profileDir: string,
  platform: NodeJS.Platform,
  task: () => Promise<T>,
): Promise<T> {
  const resolved = path.resolve(profileDir);
  const lockKey = platform === 'win32' ? resolved.toLowerCase() : resolved;
  const previous = uiStoreSaveQueue.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => {}).then(() => gate);
  uiStoreSaveQueue.set(lockKey, chained);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (uiStoreSaveQueue.get(lockKey) === chained) {
      uiStoreSaveQueue.delete(lockKey);
    }
  }
}

function safeReadPlainJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePersistedSubagentUiConfig(raw: unknown): PersistedSubagentUiConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const parsed: PersistedSubagentUiConfig = {};

  for (const field of SUBAGENT_STRING_FIELDS) {
    const normalized = normalizeNonEmptyString(record[field]);
    if (normalized !== undefined) {
      parsed[field] = normalized;
    }
  }

  if (
    typeof record['permissionMode'] === 'string' &&
    VALID_PERMISSION_MODES.has(record['permissionMode'] as AntigravityPermissionMode)
  ) {
    parsed.permissionMode = record['permissionMode'] as AntigravityPermissionMode;
  }

  if (
    typeof record['permissionFallback'] === 'string' &&
    VALID_PERMISSION_FALLBACKS.has(record['permissionFallback'] as AntigravityPermissionFallback)
  ) {
    parsed.permissionFallback = record['permissionFallback'] as AntigravityPermissionFallback;
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parsePersistedUiConfig(raw: Record<string, unknown> | null): PersistedUiConfig {
  const parsed: PersistedUiConfig = {};
  if (!raw) {
    return parsed;
  }

  for (const field of OPTIONAL_STRING_FIELDS) {
    const normalized = normalizeNonEmptyString(raw[field]);
    if (normalized !== undefined) {
      if (field === 'proxyUrl') {
        try {
          validateProxyUrl(normalized);
          parsed.proxyUrl = normalized;
        } catch {
          // Ignore corrupt/invalid persisted proxyUrl on load
        }
      } else {
        parsed[field] = normalized;
      }
    }
  }

  if (typeof raw['autoDownload'] === 'boolean') {
    parsed.autoDownload = raw['autoDownload'];
  }

  if (
    typeof raw['authMethod'] === 'string' &&
    VALID_AUTH_METHODS.has(raw['authMethod'] as AntigravityAuthMethod)
  ) {
    parsed.authMethod = raw['authMethod'] as AntigravityAuthMethod;
  }

  const subagent = parsePersistedSubagentUiConfig(raw['subagent']);
  if (subagent !== undefined) {
    parsed.subagent = subagent;
  }

  return parsed;
}

function parsePersistedUiSecrets(raw: Record<string, unknown> | null): PersistedUiSecrets {
  const parsed: PersistedUiSecrets = {};
  if (!raw) {
    return parsed;
  }

  const apiKey = normalizeNonEmptyString(raw['apiKey']);
  if (apiKey !== undefined) {
    parsed.apiKey = apiKey;
  }

  return parsed;
}

function buildOverridesFromStore(
  configPart: PersistedUiConfig,
  secretsPart: PersistedUiSecrets,
): Partial<RuntimeConfig> {
  const overrides: Partial<RuntimeConfig> = {};

  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = configPart[field];
    if (value !== undefined) {
      overrides[field] = value;
    }
  }
  if (configPart.autoDownload !== undefined) {
    overrides.autoDownload = configPart.autoDownload;
  }
  if (configPart.authMethod !== undefined) {
    overrides.authMethod = configPart.authMethod;
  }
  if (secretsPart.apiKey !== undefined) {
    overrides.apiKey = secretsPart.apiKey;
  }

  return overrides;
}

/**
 * Load persisted UI overrides (`ui-config.json` and `ui-secrets.json`) from `<profileDir>`.
 * Resilient to missing or corrupt files; normalizes empty strings to `undefined`.
 */
export function loadUiOverrides(
  profileDir: string,
  _platform: NodeJS.Platform = process.platform,
): Partial<RuntimeConfig> {
  const configPath = path.join(profileDir, UI_CONFIG_FILENAME);
  const secretsPath = path.join(profileDir, UI_SECRETS_FILENAME);
  const configPart = parsePersistedUiConfig(safeReadPlainJsonObject(configPath));
  const secretsPart = parsePersistedUiSecrets(safeReadPlainJsonObject(secretsPath));
  return buildOverridesFromStore(configPart, secretsPart);
}

function applyOptionalStringPatch(
  target: PersistedUiConfig,
  field: OptionalUiStringField,
  value: string | undefined,
): void {
  if (value === undefined) {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    delete target[field];
    return;
  }
  if (field === 'proxyUrl') {
    validateProxyUrl(trimmed);
  }
  target[field] = trimmed;
}

/**
 * Persist UI config & secret overrides into `<profileDir>` atomically with restricted permissions.
 * Empty strings for optional string fields clear those overrides; `clearApiKey: true` clears `apiKey`.
 */
export async function saveUiOverrides(
  profileDir: string,
  patch: AntigravitySaveConfigInput,
  platform: NodeJS.Platform = process.platform,
): Promise<Partial<RuntimeConfig>> {
  return withUiStoreLock(profileDir, platform, async () => {
    const configPath = path.join(profileDir, UI_CONFIG_FILENAME);
    const secretsPath = path.join(profileDir, UI_SECRETS_FILENAME);

    const nextConfig = parsePersistedUiConfig(safeReadPlainJsonObject(configPath));
    const nextSecrets = parsePersistedUiSecrets(safeReadPlainJsonObject(secretsPath));

    let configDirty = false;
    for (const field of OPTIONAL_STRING_FIELDS) {
      if (patch[field] !== undefined) {
        applyOptionalStringPatch(nextConfig, field, patch[field]);
        configDirty = true;
      }
    }

    if (patch.autoDownload !== undefined) {
      if (typeof patch.autoDownload !== 'boolean') {
        throw new AntigravityAcpError('autoDownload must be a boolean', 'INVALID_REQUEST');
      }
      nextConfig.autoDownload = patch.autoDownload;
      configDirty = true;
    }

    if (patch.authMethod !== undefined) {
      if (!VALID_AUTH_METHODS.has(patch.authMethod)) {
        throw new AntigravityAcpError(
          `Unsupported authMethod: ${String(patch.authMethod)}`,
          'INVALID_REQUEST',
        );
      }
      nextConfig.authMethod = patch.authMethod;
      configDirty = true;
    }

    let secretsDirty = false;
    if (patch.clearApiKey === true) {
      if ('apiKey' in nextSecrets || fs.existsSync(secretsPath)) {
        delete nextSecrets.apiKey;
        secretsDirty = true;
      }
    } else if (patch.apiKey !== undefined) {
      const trimmedKey = patch.apiKey.trim();
      if (trimmedKey.length > 0) {
        nextSecrets.apiKey = trimmedKey;
        secretsDirty = true;
      }
    }

    if (configDirty || secretsDirty) {
      const dirMode = platform === 'win32' ? undefined : 0o700;
      await fs.promises.mkdir(profileDir, { recursive: true, mode: dirMode });
    }

    if (configDirty) {
      await writeFileAtomic(
        configPath,
        `${JSON.stringify(nextConfig, null, 2)}\n`,
        platform,
        0o600,
      );
    }

    if (secretsDirty) {
      await writeFileAtomic(
        secretsPath,
        `${JSON.stringify(nextSecrets, null, 2)}\n`,
        platform,
        0o600,
      );
    }

    return buildOverridesFromStore(nextConfig, nextSecrets);
  });
}

/**
 * Merge persisted UI overrides onto a base {@link RuntimeConfig}.
 */
export function mergeRuntimeConfigWithOverrides(
  baseConfig: RuntimeConfig,
  overrides: Partial<RuntimeConfig>,
): RuntimeConfig {
  const merged: RuntimeConfig = { ...baseConfig };

  for (const field of [...OPTIONAL_STRING_FIELDS, 'apiKey'] as const) {
    if (!(field in overrides)) {
      continue;
    }
    const val = overrides[field];
    if (val === undefined || (typeof val === 'string' && val.trim() === '')) {
      delete merged[field];
    } else {
      merged[field] = val.trim();
    }
  }

  if (overrides.autoDownload !== undefined) {
    merged.autoDownload = overrides.autoDownload;
  }
  if (overrides.authMethod !== undefined) {
    merged.authMethod = overrides.authMethod;
  }

  return merged;
}

function buildSubagentOverridesFromConfig(configPart: PersistedUiConfig): SubagentUiOverrides {
  const src = configPart.subagent;
  if (!src) {
    return {};
  }
  return {
    ...(src.defaultModel !== undefined ? { defaultModel: src.defaultModel } : {}),
    ...(src.defaultThoughtLevel !== undefined
      ? { defaultThoughtLevel: src.defaultThoughtLevel }
      : {}),
    ...(src.permissionMode !== undefined ? { permissionMode: src.permissionMode } : {}),
    ...(src.permissionFallback !== undefined
      ? { permissionFallback: src.permissionFallback }
      : {}),
    ...(src.systemPromptAppend !== undefined
      ? { systemPromptAppend: src.systemPromptAppend }
      : {}),
  };
}

/**
 * Load persisted UI subagent overrides from `<profileDir>/ui-config.json`.
 * Wait-free and resilient to missing or corrupt files; omits unset keys.
 */
export function loadSubagentUiOverrides(
  profileDir: string,
  _platform: NodeJS.Platform = process.platform,
): SubagentUiOverrides {
  const configPath = path.join(profileDir, UI_CONFIG_FILENAME);
  const configPart = parsePersistedUiConfig(safeReadPlainJsonObject(configPath));
  return buildSubagentOverridesFromConfig(configPart);
}

function applyOptionalSubagentStringPatch(
  target: PersistedSubagentUiConfig,
  field: OptionalSubagentStringField,
  value: string | undefined,
): boolean {
  if (value === undefined) {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (field in target) {
      delete target[field];
      return true;
    }
    return false;
  }
  if (target[field] === trimmed) {
    return false;
  }
  target[field] = trimmed;
  return true;
}

/**
 * Persist UI subagent overrides into `<profileDir>/ui-config.json` without clobbering runtime settings.
 * Empty strings clear optional text overrides (`defaultModel`, `defaultThoughtLevel`, `systemPromptAppend`).
 */
export async function saveSubagentUiOverrides(
  profileDir: string,
  patch: AntigravitySaveSubagentConfigInput,
  platform: NodeJS.Platform = process.platform,
): Promise<SubagentUiOverrides> {
  return withUiStoreLock(profileDir, platform, async () => {
    const configPath = path.join(profileDir, UI_CONFIG_FILENAME);
    const nextConfig = parsePersistedUiConfig(safeReadPlainJsonObject(configPath));
    const nextSubagent: PersistedSubagentUiConfig = { ...(nextConfig.subagent ?? {}) };

    let dirty = false;
    for (const field of SUBAGENT_STRING_FIELDS) {
      if (patch[field] !== undefined) {
        if (applyOptionalSubagentStringPatch(nextSubagent, field, patch[field])) {
          dirty = true;
        }
      }
    }

    if (patch.permissionMode !== undefined) {
      if (!VALID_PERMISSION_MODES.has(patch.permissionMode)) {
        throw new AntigravityAcpError(
          `Unsupported permissionMode: ${String(patch.permissionMode)}`,
          'INVALID_REQUEST',
        );
      }
      if (nextSubagent.permissionMode !== patch.permissionMode) {
        nextSubagent.permissionMode = patch.permissionMode;
        dirty = true;
      }
    }

    if (patch.permissionFallback !== undefined) {
      if (!VALID_PERMISSION_FALLBACKS.has(patch.permissionFallback)) {
        throw new AntigravityAcpError(
          `Unsupported permissionFallback: ${String(patch.permissionFallback)}`,
          'INVALID_REQUEST',
        );
      }
      if (nextSubagent.permissionFallback !== patch.permissionFallback) {
        nextSubagent.permissionFallback = patch.permissionFallback;
        dirty = true;
      }
    }

    if (Object.keys(nextSubagent).length > 0) {
      nextConfig.subagent = nextSubagent;
    } else if ('subagent' in nextConfig) {
      delete nextConfig.subagent;
    }

    if (dirty) {
      const dirMode = platform === 'win32' ? undefined : 0o700;
      await fs.promises.mkdir(profileDir, { recursive: true, mode: dirMode });
      await writeFileAtomic(
        configPath,
        `${JSON.stringify(nextConfig, null, 2)}\n`,
        platform,
        0o600,
      );
    }

    return buildSubagentOverridesFromConfig(nextConfig);
  });
}

export { mergeSubagentConfigWithOverrides };
