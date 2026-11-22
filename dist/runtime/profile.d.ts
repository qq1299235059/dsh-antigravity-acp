import type { RuntimeConfig } from '../shared/config.js';
import type { AntigravityExecutable, AntigravityProfile } from '../shared/contracts.js';
/** Stdout prefix emitted by `agy acp` when requesting interactive browser authentication. */
export declare const ANTIGRAVITY_AUTH_STDOUT_PREFIX = "Open the following link to authenticate the ACP server: ";
/** Stderr marker emitted by our `BROWSER` interceptor script with a JSON-encoded auth URL. */
export declare const ANTIGRAVITY_AUTH_BROWSER_MARKER = "__DSH_ANTIGRAVITY_AUTH_URL__";
/** Ambient environment variables scrubbed before spawning Antigravity ACP processes. */
export declare const removedEnvironmentKeys: readonly ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_QUOTA_PROJECT", "GOOGLE_GENAI_USE_VERTEXAI", "GCLOUD_PROJECT", "CLOUDSDK_CORE_PROJECT", "AGY_ACP_CCPA_PROJECT", "AGY_ACP_ENABLE_OAUTH", "GEMINI_HOME", "AGY_ACP_FORCE_FILE_STORAGE", "AGY_CLI_DISABLE_AUTO_UPDATE", "BROWSER", "PYTHONUNBUFFERED", "ELECTRON_RUN_AS_NODE", "CHROME_CRASHPAD_PIPE_NAME"];
/** Internal profile descriptor including filesystem and spawn metadata. */
export interface InternalAntigravityProfile extends AntigravityProfile {
    readonly platform: NodeJS.Platform;
    readonly geminiHome: string;
    readonly acpDirectory: string;
    readonly tokenPath: string;
    readonly cliTokenPath: string;
    readonly tempDirectory: string;
    readonly browserCommand?: string;
    readonly caBundlePath?: string;
}
/** Parsed and validated Antigravity OAuth authorization URL. */
export interface ParsedAntigravityAuthorizationUrl {
    readonly url: string;
    readonly kind: 'loopback' | 'code';
    readonly redirectUri?: string;
    readonly state?: string;
}
/** Options for {@link prepareAntigravityProfile}. */
export interface PrepareAntigravityProfileOptions {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly homeDir?: string;
    readonly platform?: NodeJS.Platform;
    readonly suppressBrowser?: boolean;
    readonly caBundlePath?: string;
    readonly existsSync?: (targetPath: string) => boolean;
}
/** Resolved filesystem paths for an Antigravity profile without creating directories. */
export interface ResolvedProfilePaths {
    readonly platform: NodeJS.Platform;
    readonly profileDir: string;
    readonly geminiHome: string;
    readonly acpDirectory: string;
    readonly settingsPath: string;
    readonly tokenPath: string;
    readonly cliTokenPath: string;
    readonly tempDirectory: string;
}
/**
 * Expand a leading `~` segment relative to `homeDir`.
 */
export declare function expandHomePath(targetPath: string, homeDir?: string): string;
/**
 * Read an environment variable, matching case-insensitively on Windows.
 */
export declare function getEnvValue(env: Readonly<Record<string, string | undefined>> | undefined, name: string, platform?: NodeJS.Platform): string | undefined;
/**
 * Resolve the default isolated profile directory for Antigravity ACP state.
 */
export declare function resolveDefaultProfileDir(config: Pick<RuntimeConfig, 'profileDir'>, env?: Readonly<Record<string, string | undefined>>, homeDir?: string, platform?: NodeJS.Platform): string;
/**
 * Compute all filesystem paths belonging to a profile without mutating disk.
 */
export declare function resolveProfilePaths(config: Pick<RuntimeConfig, 'profileDir'>, env?: Readonly<Record<string, string | undefined>>, homeDir?: string, platform?: NodeJS.Platform): ResolvedProfilePaths;
/**
 * Synchronously inspect profile state without modifying files on disk.
 */
export declare function resolveProfileSnapshot(config: RuntimeConfig, env?: Readonly<Record<string, string | undefined>>, homeDir?: string, platform?: NodeJS.Platform): AntigravityProfile;
/**
 * Rename a file or directory with Windows EPERM/EBUSY/EACCES retry backoff.
 */
export declare function renameWithWindowsRetry(sourcePath: string, targetPath: string): Promise<void>;
/**
 * Atomically write a UTF-8 file using a unique temp file and Windows-safe rename.
 */
export declare function writeFileAtomic(targetPath: string, content: string, platform: NodeJS.Platform, mode?: number): Promise<void>;
/**
 * Prepare isolated profile directories, ACP settings, temp dir, CA detection, and browser interceptor.
 */
export declare function prepareAntigravityProfile(config: RuntimeConfig, options?: PrepareAntigravityProfileOptions): Promise<InternalAntigravityProfile>;
/**
 * Validate outbound HTTP/HTTPS/SOCKS proxy URL syntax and protocol.
 */
export declare function validateProxyUrl(proxyUrl: string): void;
/**
 * Build the scrubbed, isolated child environment for spawning `agy acp`.
 */
export declare function buildAntigravityEnvironment(profile: InternalAntigravityProfile, config: RuntimeConfig, baseEnv?: Readonly<Record<string, string | undefined>>, runtimeTempDir?: string): Record<string, string>;
/**
 * Build CLI arguments for spawning `agy acp` against an isolated profile.
 * Never passes an absolute path for `--app-data-dir`.
 */
export declare function buildAcpSpawnArgs(executable: Pick<AntigravityExecutable, 'argsPrefix'>, profile: Pick<InternalAntigravityProfile, 'geminiHome'>, extraArgs?: readonly string[]): string[];
/**
 * Parse and validate an Antigravity Google OAuth authorization URL.
 */
export declare function parseAntigravityAuthorizationUrl(rawUrl: string, expectedKind?: 'loopback' | 'code'): ParsedAntigravityAuthorizationUrl | null;
/**
 * Validate a pasted OAuth authorization code or redirected callback URL against a pending login.
 */
export declare function validateLoginResponse(pending: ParsedAntigravityAuthorizationUrl, response: string): {
    readonly code: string;
    readonly state?: string;
};
/**
 * Validate authentication and proxy settings before spawning or authenticating an ACP client.
 */
export declare function validateAuthConfig(config: RuntimeConfig, env?: Readonly<Record<string, string | undefined>>, platform?: NodeJS.Platform): void;
//# sourceMappingURL=profile.d.ts.map