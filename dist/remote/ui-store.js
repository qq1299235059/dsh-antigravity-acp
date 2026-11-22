import fs from 'node:fs';
import path from 'node:path';
import { validateProxyUrl, writeFileAtomic } from '../runtime/profile.js';
import { AntigravityAcpError } from '../shared/errors.js';
export const UI_CONFIG_FILENAME = 'ui-config.json';
export const UI_SECRETS_FILENAME = 'ui-secrets.json';
const VALID_AUTH_METHODS = new Set([
    'oauth-personal',
    'oauth-business',
    'gemini-api-key',
    'agent-platform',
]);
const OPTIONAL_STRING_FIELDS = [
    'binaryPath',
    'gcpProject',
    'gcpLocation',
    'proxyUrl',
    'proxyBypass',
];
const uiStoreSaveQueue = new Map();
async function withUiStoreLock(profileDir, platform, task) {
    const resolved = path.resolve(profileDir);
    const lockKey = platform === 'win32' ? resolved.toLowerCase() : resolved;
    const previous = uiStoreSaveQueue.get(lockKey) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const chained = previous.catch(() => { }).then(() => gate);
    uiStoreSaveQueue.set(lockKey, chained);
    await previous.catch(() => { });
    try {
        return await task();
    }
    finally {
        release();
        if (uiStoreSaveQueue.get(lockKey) === chained) {
            uiStoreSaveQueue.delete(lockKey);
        }
    }
}
function safeReadPlainJsonObject(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw.trim()) {
            return null;
        }
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
function normalizeNonEmptyString(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function parsePersistedUiConfig(raw) {
    const parsed = {};
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
                }
                catch {
                    // Ignore corrupt/invalid persisted proxyUrl on load
                }
            }
            else {
                parsed[field] = normalized;
            }
        }
    }
    if (typeof raw['autoDownload'] === 'boolean') {
        parsed.autoDownload = raw['autoDownload'];
    }
    if (typeof raw['authMethod'] === 'string' &&
        VALID_AUTH_METHODS.has(raw['authMethod'])) {
        parsed.authMethod = raw['authMethod'];
    }
    return parsed;
}
function parsePersistedUiSecrets(raw) {
    const parsed = {};
    if (!raw) {
        return parsed;
    }
    const apiKey = normalizeNonEmptyString(raw['apiKey']);
    if (apiKey !== undefined) {
        parsed.apiKey = apiKey;
    }
    return parsed;
}
function buildOverridesFromStore(configPart, secretsPart) {
    const overrides = {};
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
export function loadUiOverrides(profileDir, _platform = process.platform) {
    const configPath = path.join(profileDir, UI_CONFIG_FILENAME);
    const secretsPath = path.join(profileDir, UI_SECRETS_FILENAME);
    const configPart = parsePersistedUiConfig(safeReadPlainJsonObject(configPath));
    const secretsPart = parsePersistedUiSecrets(safeReadPlainJsonObject(secretsPath));
    return buildOverridesFromStore(configPart, secretsPart);
}
function applyOptionalStringPatch(target, field, value) {
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
export async function saveUiOverrides(profileDir, patch, platform = process.platform) {
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
                throw new AntigravityAcpError(`Unsupported authMethod: ${String(patch.authMethod)}`, 'INVALID_REQUEST');
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
        }
        else if (patch.apiKey !== undefined) {
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
            await writeFileAtomic(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, platform, 0o600);
        }
        if (secretsDirty) {
            await writeFileAtomic(secretsPath, `${JSON.stringify(nextSecrets, null, 2)}\n`, platform, 0o600);
        }
        return buildOverridesFromStore(nextConfig, nextSecrets);
    });
}
/**
 * Merge persisted UI overrides onto a base {@link RuntimeConfig}.
 */
export function mergeRuntimeConfigWithOverrides(baseConfig, overrides) {
    const merged = { ...baseConfig };
    for (const field of [...OPTIONAL_STRING_FIELDS, 'apiKey']) {
        if (!(field in overrides)) {
            continue;
        }
        const val = overrides[field];
        if (val === undefined || (typeof val === 'string' && val.trim() === '')) {
            delete merged[field];
        }
        else {
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
//# sourceMappingURL=ui-store.js.map