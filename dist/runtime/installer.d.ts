import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { RuntimeConfig } from '../shared/config.js';
import type { AntigravityExecutable } from '../shared/contracts.js';
/** Dependency injection seams for deterministic offline testing and custom environments. */
export interface AntigravityInstallerOptions {
    readonly fetch?: typeof globalThis.fetch;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
    readonly musl?: boolean;
    readonly cacheDir?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly homeDir?: string;
    readonly pathEnv?: string;
    readonly subprocess?: SubprocessRuntime;
    readonly manifestBaseUrl?: string;
    readonly maxDownloadBytes?: number;
    readonly tarExtractor?: (archivePath: string, destDir: string, signal?: AbortSignal) => Promise<void>;
}
/**
 * Resolves and optionally downloads/caches the Antigravity CLI (`agy`) runtime binary.
 */
export declare class AntigravityInstaller {
    private readonly config;
    private readonly fetchImpl;
    private readonly platform;
    private readonly arch;
    private readonly musl;
    private readonly env;
    private readonly homeDir;
    private readonly pathEnvOverride?;
    private readonly explicitCacheDir?;
    private readonly subprocess?;
    private readonly manifestBaseUrl;
    private readonly maxDownloadBytes;
    private readonly tarExtractor?;
    private readonly hasMockedExecutionWorld;
    constructor(config: RuntimeConfig, options?: AntigravityInstallerOptions);
    /** Root cache directory owning managed Antigravity binaries. */
    resolveCacheRoot(): string;
    /** Target-specific managed runtime directory holding `active.json` and `versions/`. */
    resolvePlatformCacheDir(): string;
    /**
     * Resolve the executable in strict precedence:
     * 1) `config.binaryPath` (`configured`)
     * 2) Managed cache (`cached`)
     * 3) System `PATH` (`path`)
     * 4) Managed download when `autoDownload` enabled (`downloaded`)
     */
    resolveExecutable(options?: {
        readonly signal?: AbortSignal;
        readonly allowDownload?: boolean;
    }): Promise<AntigravityExecutable>;
    private resolveConfiguredBinary;
    resolveCachedBinary(): AntigravityExecutable | null;
    private resolveSystemPathBinary;
    /**
     * Fetch the target manifest, download and verify SHA-512, extract/stage atomically, and activate.
     */
    installManaged(options?: {
        readonly signal?: AbortSignal;
        readonly onProgress?: (msg: string) => void;
    }): Promise<AntigravityExecutable>;
    private writeActivePointer;
    private downloadAndHash;
    private extractTarball;
}
/**
 * Factory helper creating an {@link AntigravityInstaller} for a {@link RuntimeConfig}.
 */
export declare function createAntigravityInstaller(config: RuntimeConfig, options?: AntigravityInstallerOptions): AntigravityInstaller;
//# sourceMappingURL=installer.d.ts.map