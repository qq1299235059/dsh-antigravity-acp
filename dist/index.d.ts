import type { Context } from '@deepseek-ai/cordis';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { type AntigravityInstallerOptions } from './runtime/installer.js';
import { type RuntimeConfig, type SubagentUiOverrides } from './shared/config.js';
import type { AntigravityRuntimeService } from './shared/contracts.js';
export declare const name = "antigravity-runtime";
export declare const inject: string[];
export declare const Config: import("@deepseek-ai/schemastery").default<Partial<RuntimeConfig>, RuntimeConfig>;
/** Optional logger interface accepted by {@link createAntigravityRuntimeService}. */
export interface RuntimeServiceLogger {
    debug?(message: string, ...args: unknown[]): void;
    info?(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error?(message: string, ...args: unknown[]): void;
}
/** Injectable options for {@link createAntigravityRuntimeService}. */
export interface RuntimeServiceOptions {
    readonly logger?: RuntimeServiceLogger;
    readonly installerOptions?: AntigravityInstallerOptions;
    readonly skipVersionCheck?: boolean;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly homeDir?: string;
    readonly platform?: NodeJS.Platform;
    readonly fetch?: typeof globalThis.fetch;
    readonly initialSubagentOverrides?: SubagentUiOverrides;
}
/**
 * Create a standalone {@link AntigravityRuntimeService} backed by the given {@link SubprocessRuntime}.
 */
export declare function createAntigravityRuntimeService(subprocess: SubprocessRuntime, config: RuntimeConfig, options?: RuntimeServiceOptions): AntigravityRuntimeService;
/**
 * Cordis plugin providing the shared `ctx.antigravityRuntime` service.
 * Named exports only (DSH Cordis loader requirement).
 */
export declare function apply(ctx: Context, config: RuntimeConfig): void;
export { AntigravityAcpError, redactSensitiveText, toLlmError, type AntigravityAcpErrorOptions, type AntigravityBuiltinErrorCode, type AntigravityCustomErrorCode, type AntigravityErrorCode, } from './shared/errors.js';
export { AuthMethodSchema, PermissionFallbackSchema, PermissionModeSchema, RuntimeConfigSchema, SubagentPluginConfigSchema, type AntigravityAuthMethod, type AntigravityPermissionFallback, type AntigravityPermissionMode, type RuntimeConfig, type RuntimeConfigInput, type SubagentPluginConfig, type SubagentPluginConfigInput, type SubagentUiOverrides, } from './shared/config.js';
export type { AcpClientHandle, AcpInitializeSummary, AcpPromptResult, AcpSessionSetup, AcpTurnCallbacks, AcpWorkerLease, AcquireWorkerOptions, AntigravityAuthStartInput, AntigravityAuthSubmitCodeInput, AntigravityAuthTaskPhase, AntigravityAuthTaskState, AntigravityControlModelSummary, AntigravityControlStatusSnapshot, AntigravityExecutable, AntigravityInstallInput, AntigravityInstallTaskPhase, AntigravityInstallTaskState, AntigravityPluginUpdateInput, AntigravityPluginUpdatePhase, AntigravityPluginUpdateReason, AntigravityPluginUpdateState, AntigravityProfile, AntigravityRuntimeService, AntigravitySaveConfigInput, AntigravitySaveSubagentConfigInput, AntigravityStatusSnapshot, AntigravitySubagentDefaults, AntigravitySubagentSettingsSnapshot, DiscoveredModel, QuotaSnapshot, QuotaWindow, ThinkingOption, } from './shared/contracts.js';
export { DEFAULT_PLUGIN_BRANCH, DEFAULT_PLUGIN_GITHUB_API_BASE, DEFAULT_PLUGIN_PACKAGE_NAME, DEFAULT_PLUGIN_RAW_BASE, DEFAULT_PLUGIN_REPO_NAME, DEFAULT_PLUGIN_REPO_OWNER, applyPluginUpdate, checkPluginUpdate, extractInstalledCommitFromLockfile, inferDshProfileDir, parseGitHubRepoUrl, readInstalledPluginInfo, readInstalledPluginManifestSync, validatePluginUpdateSpec, type ApplyPluginUpdateOptions, type CheckPluginUpdateOptions, type InstalledPluginInfo, type PluginManagerChangeResultLike, type PluginManagerLike, type PluginUpdateApplyResult, type PluginUpdateCheckResult, } from './runtime/updater.js';
export { ANTIGRAVITY_CONTROL_INVOCATIONS, ANTIGRAVITY_CONTROL_NAMESPACE, ANTIGRAVITY_CONTROL_PACKAGE, ANTIGRAVITY_CONTROL_SERVICE_KEY, AntigravityControlService, registerAntigravityControlRemote, sanitizeControlError, stripUndefinedJson, type AntigravityControlLogger, type AntigravityControlOptions, } from './remote/control-remote.js';
export { UI_CONFIG_FILENAME, UI_SECRETS_FILENAME, loadSubagentUiOverrides, loadUiOverrides, mergeRuntimeConfigWithOverrides, mergeSubagentConfigWithOverrides, saveSubagentUiOverrides, saveUiOverrides, } from './remote/ui-store.js';
export { ANTIGRAVITY_CLI_MANIFEST_BASE, MINIMUM_AGY_VERSION, antigravityCliTarget, compareSemver, parseAntigravityCliRelease, tryParseSemver, type AntigravityCliReleaseAsset, type ParsedSemver, } from './runtime/release.js';
export { AntigravityInstaller, createAntigravityInstaller, type AntigravityInstallerOptions, } from './runtime/installer.js';
export { ANTIGRAVITY_AUTH_BROWSER_MARKER, ANTIGRAVITY_AUTH_STDOUT_PREFIX, buildAcpSpawnArgs, buildAntigravityEnvironment, prepareAntigravityProfile, removedEnvironmentKeys, resolveDefaultProfileDir, resolveProfilePaths, resolveProfileSnapshot, validateAuthConfig, validateLoginResponse, validateProxyUrl, parseAntigravityAuthorizationUrl, type InternalAntigravityProfile, type ParsedAntigravityAuthorizationUrl, type PrepareAntigravityProfileOptions, type ResolvedProfilePaths, } from './runtime/profile.js';
export { checkProfileAuth, clearProfileAuth, runCodeLogin, runLoopbackLogin, type RunCodeLoginOptions, type RunLoopbackLoginOptions, } from './runtime/auth.js';
export { probeAntigravityQuota, type ProbeAntigravityQuotaOptions } from './runtime/quota.js';
export { spawnAcpClient, type SpawnAcpClientOptions } from './acp/client.js';
export { AcpWorkerPool, type AcpPoolStats, type AcpWorkerPoolOptions, type SpawnIsolatedClientOptions, } from './acp/pool.js';
export { antigravityAppendsSystemPrompt, antigravityClientInfo, antigravitySessionMeta, antigravitySessionMode, antigravityToolOutlivesPrompt, isMcpToolCallMeta, isSignInRequiredError, normalizeStopReasonToLlm, parseModelsAndThinking, selectPermissionOption, } from './acp/protocol.js';
//# sourceMappingURL=index.d.ts.map