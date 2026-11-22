import type { RuntimeConfig, SubagentUiOverrides } from '../shared/config.js';
import type { AntigravitySaveConfigInput, AntigravitySaveSubagentConfigInput } from '../shared/contracts.js';
import { mergeSubagentConfigWithOverrides } from '../subagent/overrides.js';
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
/**
 * Load persisted UI subagent overrides from `<profileDir>/ui-config.json`.
 * Wait-free and resilient to missing or corrupt files; omits unset keys.
 */
export declare function loadSubagentUiOverrides(profileDir: string, _platform?: NodeJS.Platform): SubagentUiOverrides;
/**
 * Persist UI subagent overrides into `<profileDir>/ui-config.json` without clobbering runtime settings.
 * Empty strings clear optional text overrides (`defaultModel`, `defaultThoughtLevel`, `systemPromptAppend`).
 */
export declare function saveSubagentUiOverrides(profileDir: string, patch: AntigravitySaveSubagentConfigInput, platform?: NodeJS.Platform): Promise<SubagentUiOverrides>;
export { mergeSubagentConfigWithOverrides };
//# sourceMappingURL=ui-store.d.ts.map