import type { RuntimeConfig } from '../shared/config.js';
import type { AntigravitySaveConfigInput } from '../shared/contracts.js';
export declare const UI_CONFIG_FILENAME = "ui-config.json";
export declare const UI_SECRETS_FILENAME = "ui-secrets.json";
/**
 * Load persisted UI overrides (`ui-config.json` and `ui-secrets.json`) from `<profileDir>`.
 * Resilient to missing or corrupt files; normalizes empty strings to `undefined`.
 */
export declare function loadUiOverrides(profileDir: string, _platform?: NodeJS.Platform): Partial<RuntimeConfig>;
/**
 * Persist UI config & secret overrides into `<profileDir>` atomically with restricted permissions.
 * Empty strings for optional string fields clear those overrides; `clearApiKey: true` clears `apiKey`.
 */
export declare function saveUiOverrides(profileDir: string, patch: AntigravitySaveConfigInput, platform?: NodeJS.Platform): Promise<Partial<RuntimeConfig>>;
/**
 * Merge persisted UI overrides onto a base {@link RuntimeConfig}.
 */
export declare function mergeRuntimeConfigWithOverrides(baseConfig: RuntimeConfig, overrides: Partial<RuntimeConfig>): RuntimeConfig;
//# sourceMappingURL=ui-store.d.ts.map