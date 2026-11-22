import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService, type InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';
import { type PluginManagerLike } from '../runtime/updater.js';
import type { AntigravityAuthStartInput, AntigravityAuthSubmitCodeInput, AntigravityControlStatusSnapshot, AntigravityInstallInput, AntigravityPluginUpdateInput, AntigravityRuntimeService, AntigravitySaveConfigInput, AntigravitySaveSubagentConfigInput } from '../shared/contracts.js';
export declare const ANTIGRAVITY_CONTROL_PACKAGE = "dsh-antigravity-acp";
export declare const ANTIGRAVITY_CONTROL_SERVICE_KEY = "antigravityControl";
export declare const ANTIGRAVITY_CONTROL_NAMESPACE = "antigravityControl";
/** Optional logger interface accepted by {@link AntigravityControlService}. */
export interface AntigravityControlLogger {
    debug?(message: string, ...args: unknown[]): void;
    info?(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error?(message: string, ...args: unknown[]): void;
}
/** Injectable options for {@link AntigravityControlService} and {@link registerAntigravityControlRemote}. */
export interface AntigravityControlOptions {
    readonly logger?: AntigravityControlLogger;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly homeDir?: string;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
    readonly musl?: boolean;
    readonly profileDir?: string;
    readonly dshProfileDir?: string;
    readonly packageRootDir?: string;
    readonly pluginManager?: PluginManagerLike;
    readonly fetch?: typeof globalThis.fetch;
    readonly githubApiBase?: string;
    readonly rawGithubBase?: string;
    readonly cliManifestBaseUrl?: string;
}
/**
 * Recursively omit `undefined` properties and non-finite numbers so returned payloads satisfy
 * `dsh-api-gateway`'s strict `assertJsonValue` wire invariant.
 */
export declare function stripUndefinedJson<T>(value: T): T;
/**
 * Sanitize diagnostic text before surfacing it over RPC by scrubbing credentials,
 * proxy userinfo, Google OAuth URLs, and any known active secret literals.
 */
export declare function sanitizeControlError(error: unknown, extraSecrets?: readonly (string | undefined)[]): string;
/** Strict Typert invocation descriptors matching the browser UI client verbatim. */
export declare const ANTIGRAVITY_CONTROL_INVOCATIONS: readonly InvocationDescriptor[];
/**
 * Cordis Typert Remote service exposing Antigravity runtime control, installation,
 * OAuth/API-key authentication, model discovery, quota probing, and plugin self-updates to the DSH UI.
 *
 * NOTE: Uses TypeScript `private` fields only (never ES `#private`), because Cordis
 * wraps service instances in `Proxy` objects when resolving `ctx.get('antigravityControl')`.
 */
export declare class AntigravityControlService extends TypertRemoteService {
    private readonly runtime;
    private readonly logger?;
    private readonly env;
    private readonly platform;
    private readonly arch;
    private readonly musl?;
    private readonly profileDirOverride?;
    private readonly dshProfileDirOverride?;
    private readonly packageRootDir?;
    private readonly pluginManagerOverride?;
    private readonly fetchImpl?;
    private readonly githubApiBase?;
    private readonly rawGithubBase?;
    private readonly cliManifestBaseUrl?;
    private installState;
    private installAbort;
    private authState;
    private authAbort;
    private pendingCodeDeferred;
    private pluginUpdateState;
    private lastCheckResult;
    private updateCheckAbort;
    private updateCheckTask;
    private activeUpdateRequestId;
    private activeUpdateTask;
    private models;
    private modelsError;
    private lastQuota;
    private quotaError;
    private disposed;
    constructor(ctx: Context, runtime: AntigravityRuntimeService, options?: AntigravityControlOptions);
    private resolveProfileDir;
    private resolvePluginManager;
    private resolveDshProfileDir;
    private activeSecrets;
    private buildAuthSnapshot;
    private readLocalPluginInfoSafe;
    private formatPluginUpdateSnapshot;
    private cancelActiveAuthInternal;
    private buildSubagentSnapshot;
    status(): Promise<AntigravityControlStatusSnapshot>;
    installCli(input?: AntigravityInstallInput): Promise<AntigravityControlStatusSnapshot>;
    installCancel(): Promise<AntigravityControlStatusSnapshot>;
    saveConfig(input: AntigravitySaveConfigInput): Promise<AntigravityControlStatusSnapshot>;
    saveSubagentConfig(input: AntigravitySaveSubagentConfigInput): Promise<AntigravityControlStatusSnapshot>;
    authStart(input?: AntigravityAuthStartInput): Promise<AntigravityControlStatusSnapshot>;
    authSubmitCode(input: AntigravityAuthSubmitCodeInput): Promise<AntigravityControlStatusSnapshot>;
    authCancel(): Promise<AntigravityControlStatusSnapshot>;
    logout(): Promise<AntigravityControlStatusSnapshot>;
    refreshModels(): Promise<AntigravityControlStatusSnapshot>;
    refreshQuota(): Promise<AntigravityControlStatusSnapshot>;
    checkUpdate(): Promise<AntigravityControlStatusSnapshot>;
    updatePlugin(input?: AntigravityPluginUpdateInput): Promise<AntigravityControlStatusSnapshot>;
    cancelPluginUpdate(): Promise<AntigravityControlStatusSnapshot>;
    dispose(): void;
}
/** Structural contribution accepted by DSH `TypertRegistry.register(...)`. */
export interface TypertHostContribution {
    readonly package: string;
    readonly face: 'host' | 'client';
    readonly schemas: readonly [];
    readonly model: {
        readonly services: readonly [];
        readonly events: readonly [];
        readonly objects: readonly [];
    };
    readonly invocations: readonly InvocationDescriptor[];
}
/**
 * Instantiate {@link AntigravityControlService} and register strict Typert invocation descriptors
 * on `ctx.typert`, withdrawing both cleanly when the Cordis scope disposes.
 */
export declare function registerAntigravityControlRemote(ctx: Context, runtime: AntigravityRuntimeService, options?: AntigravityControlOptions): AntigravityControlService;
declare module '@deepseek-ai/cordis' {
    interface Context {
        antigravityControl: AntigravityControlService;
    }
}
//# sourceMappingURL=control-remote.d.ts.map