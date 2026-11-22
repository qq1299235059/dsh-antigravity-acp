/** Base URL for Antigravity CLI release manifests. */
export declare const ANTIGRAVITY_CLI_MANIFEST_BASE = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
/** Minimum supported Antigravity CLI version for ACP integration. */
export declare const MINIMUM_AGY_VERSION = "1.5.0";
/** Parsed semantic version components following SemVer 2.0.0. */
export interface ParsedSemver {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    readonly prerelease: readonly string[];
}
/** Validated Antigravity CLI release manifest asset for a single target. */
export interface AntigravityCliReleaseAsset {
    readonly version: string;
    readonly releaseId: string;
    readonly target: string;
    readonly url: string;
    readonly sha512: string;
    readonly executableName: 'agy.exe' | 'antigravity';
    readonly format: 'executable' | 'tar.gz';
    readonly size?: number;
}
/**
 * Parse a semantic version string (allowing optional leading `v` and build metadata).
 */
export declare function tryParseSemver(version: string): ParsedSemver | null;
/**
 * Compare two SemVer 2.0.0 strings. Returns `-1`, `0`, or `1`.
 */
export declare function compareSemver(left: string, right: string): number;
/**
 * Map Node platform/arch/musl metadata to the Antigravity CLI release target string.
 */
export declare function antigravityCliTarget(platform: NodeJS.Platform, arch: string, musl?: boolean): string | null;
/**
 * Validate and normalize an Antigravity CLI auto-updater manifest payload for the requested target.
 */
export declare function parseAntigravityCliRelease(value: unknown, platform: NodeJS.Platform, arch: string, musl?: boolean): AntigravityCliReleaseAsset | null;
//# sourceMappingURL=release.d.ts.map