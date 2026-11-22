import type { AntigravityPluginUpdateReason } from '../shared/contracts.js';
export declare const DEFAULT_PLUGIN_PACKAGE_NAME = "dsh-antigravity-acp";
export declare const DEFAULT_PLUGIN_REPO_OWNER = "qq1299235059";
export declare const DEFAULT_PLUGIN_REPO_NAME = "dsh-antigravity-acp";
export declare const DEFAULT_PLUGIN_BRANCH = "main";
export declare const DEFAULT_PLUGIN_GITHUB_API_BASE = "https://api.github.com";
export declare const DEFAULT_PLUGIN_RAW_BASE = "https://raw.githubusercontent.com";
/** Structural subset of `@deepseek-ai/dsh-plugin-manager`'s `ChangeResult`. */
export interface PluginManagerChangeResultLike {
    readonly changed?: boolean;
    readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled';
    readonly restartReason?: string;
    readonly stage?: string;
    readonly target?: string;
    readonly version?: string;
    readonly bundle?: string;
    readonly warnings?: readonly string[];
    readonly error?: {
        readonly code?: string;
        readonly diagnostic?: string;
    };
    readonly packageResult?: {
        readonly exitCode?: number;
        readonly output?: string;
    };
}
/** Structural subset of DSH's `ctx.get('pluginManager')` service used for self-updates. */
export interface PluginManagerLike {
    listBundles?(): Promise<readonly {
        readonly name: string;
        readonly version?: string;
        readonly source?: string;
        readonly installed?: boolean;
        readonly enabled?: boolean;
    }[]>;
    installBundle?(spec: string, options?: {
        readonly enabled?: boolean;
        readonly saveExact?: boolean;
        readonly requestId?: string;
        readonly approvedBuilds?: readonly string[];
        readonly registry?: string | null;
    }): Promise<PluginManagerChangeResultLike>;
    cancelInstall?(requestId: string): Promise<{
        readonly status: 'cancelled' | 'too-late' | 'not-running';
    }>;
}
/** Metadata about the locally installed plugin bundle. */
export interface InstalledPluginInfo {
    readonly packageName: string;
    readonly currentVersion: string;
    readonly currentCommit?: string;
    readonly installedSpec?: string;
    readonly owner: string;
    readonly repo: string;
    readonly repoUrl: string;
    readonly branch: string;
    readonly dshProfileDir?: string;
    readonly canAutoUpdate: boolean;
}
/** Options accepted by {@link checkPluginUpdate}. */
export interface CheckPluginUpdateOptions {
    readonly packageRootDir?: string;
    readonly dshProfileDir?: string;
    readonly pluginManager?: PluginManagerLike;
    readonly fetch?: typeof globalThis.fetch;
    readonly signal?: AbortSignal;
    readonly githubApiBase?: string;
    readonly rawGithubBase?: string;
    readonly branch?: string;
    readonly timeoutMs?: number;
    readonly cliInstalledVersion?: string;
    readonly cliManifestBaseUrl?: string;
    readonly checkCliManifest?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
    readonly musl?: boolean;
}
/** Structured outcome from checking GitHub (and optionally Antigravity CLI manifest) for updates. */
export interface PluginUpdateCheckResult {
    readonly packageName: string;
    readonly currentVersion: string;
    readonly currentCommit?: string;
    readonly installedSpec?: string;
    readonly owner: string;
    readonly repo: string;
    readonly repoUrl: string;
    readonly branch: string;
    readonly latestVersion?: string;
    readonly latestCommit?: string;
    readonly latestMessage?: string;
    readonly latestDate?: string;
    readonly commitUrl?: string;
    readonly installSpec: string;
    readonly updateAvailable: boolean;
    readonly reason: AntigravityPluginUpdateReason;
    readonly canAutoUpdate: boolean;
    readonly cliLatestVersion?: string;
    readonly cliUpdateAvailable?: boolean;
    readonly checkedAt: string;
}
/** Options accepted by {@link applyPluginUpdate}. */
export interface ApplyPluginUpdateOptions {
    readonly installSpec: string;
    readonly requestId?: string;
    readonly owner?: string;
    readonly repo?: string;
    readonly pluginManager?: PluginManagerLike;
}
/** Structured outcome from applying a plugin update via DSH's plugin manager. */
export interface PluginUpdateApplyResult {
    readonly status: 'succeeded' | 'failed' | 'cancelled';
    readonly installSpec: string;
    readonly installedVersion?: string;
    readonly restartRequired: boolean;
    readonly restartReason?: string;
    readonly warnings?: readonly string[];
    readonly message: string;
    readonly error?: string;
}
/**
 * Parse a `package.json` repository URL into GitHub `{ owner, repo, repoUrl }`,
 * falling back cleanly to the canonical `qq1299235059/dsh-antigravity-acp` repo.
 */
export declare function parseGitHubRepoUrl(url?: string): {
    readonly owner: string;
    readonly repo: string;
    readonly repoUrl: string;
};
/**
 * Extract the resolved 40-character git commit SHA for `packageName` from a pnpm v9 lockfile.
 */
export declare function extractInstalledCommitFromLockfile(lockfileText: string, packageName: string): string | undefined;
/**
 * Infer the enclosing DSH profile directory when this plugin is installed inside `<profile>/node_modules/<pkg>`.
 */
export declare function inferDshProfileDir(packageRootDir: string, packageName?: string): string | undefined;
interface ParsedPackageManifest {
    readonly packageName: string;
    readonly currentVersion: string;
    readonly owner: string;
    readonly repo: string;
    readonly repoUrl: string;
}
/**
 * Synchronously read the installed plugin package manifest without touching network or profile lockfiles.
 */
export declare function readInstalledPluginManifestSync(packageRootDir?: string): ParsedPackageManifest;
/**
 * Inspect local `package.json`, enclosing DSH profile manifest/`pnpm-lock.yaml`, and optional `pluginManager`
 * to resolve installed plugin version, commit SHA, install spec, and auto-update availability.
 */
export declare function readInstalledPluginInfo(options?: {
    readonly packageRootDir?: string;
    readonly dshProfileDir?: string;
    readonly pluginManager?: PluginManagerLike;
    readonly branch?: string;
}): Promise<InstalledPluginInfo>;
/**
 * Validate that an installation spec strictly points to this plugin's GitHub repository
 * with an optional clean commit SHA, branch `main`, or SemVer tag ref.
 */
export declare function validatePluginUpdateSpec(spec: string, owner?: string, repo?: string): string;
/**
 * Query GitHub (`commits/<branch>` and `package.json`) and optionally the Antigravity CLI manifest
 * to determine whether a newer plugin version or commit is available.
 */
export declare function checkPluginUpdate(options?: CheckPluginUpdateOptions): Promise<PluginUpdateCheckResult>;
/**
 * Apply a plugin update through DSH's `pluginManager.installBundle(...)` when available,
 * returning a structured status and restart recommendation without throwing host internals.
 */
export declare function applyPluginUpdate(options: ApplyPluginUpdateOptions): Promise<PluginUpdateApplyResult>;
export {};
//# sourceMappingURL=updater.d.ts.map