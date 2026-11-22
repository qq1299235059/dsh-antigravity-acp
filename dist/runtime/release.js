/** Base URL for Antigravity CLI release manifests. */
export const ANTIGRAVITY_CLI_MANIFEST_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests';
/** Minimum supported Antigravity CLI version for ACP integration. */
export const MINIMUM_AGY_VERSION = '1.5.0';
const GCS_RELEASE_ORIGIN = 'https://storage.googleapis.com';
const GCS_RELEASE_BUCKET = 'antigravity-public';
const GCS_RELEASE_PREFIX = 'antigravity-cli';
const STRICT_MANIFEST_SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;
const FLEX_SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA512_HEX_RE = /^[0-9a-fA-F]{128}$/;
function resolveTargetDescriptor(platform, arch, musl = false) {
    let osName;
    switch (platform) {
        case 'darwin':
            osName = 'darwin';
            break;
        case 'linux':
            osName = 'linux';
            break;
        case 'win32':
            osName = 'windows';
            break;
        default:
            return null;
    }
    let cpu;
    switch (arch) {
        case 'x64':
            cpu = 'amd64';
            break;
        case 'arm64':
            cpu = 'arm64';
            break;
        default:
            return null;
    }
    const isMusl = platform === 'linux' && Boolean(musl);
    const suffix = isMusl ? '_musl' : '';
    const dashSuffix = isMusl ? '-musl' : '';
    const target = `${osName}_${cpu}${suffix}`;
    const isWindows = platform === 'win32';
    const ext = isWindows ? 'exe' : 'tar.gz';
    const executableName = isWindows ? 'agy.exe' : 'antigravity';
    const format = isWindows ? 'executable' : 'tar.gz';
    const folders = new Set([
        `${osName}-${cpu}${dashSuffix}`,
        `${osName}_${cpu}${suffix}`,
        `cli_${osName}_${cpu}${suffix}`,
        `${platform}-${arch}${dashSuffix}`,
        `${osName}-${arch}${dashSuffix}`,
    ]);
    if (arch === 'arm64') {
        folders.add(`${osName}-arm${dashSuffix}`);
    }
    const fileOs = osName === 'darwin' ? 'mac' : osName;
    const filenames = new Set([
        `cli_${fileOs}_${arch}${suffix}.${ext}`,
        `cli_${osName}_${cpu}${suffix}.${ext}`,
        `cli_${osName}_${arch}${suffix}.${ext}`,
        `cli_${fileOs}_${cpu}${suffix}.${ext}`,
    ]);
    return {
        os: osName,
        cpu,
        suffix,
        dashSuffix,
        target,
        ext,
        executableName,
        format,
        allowedFolders: folders,
        allowedFilenames: filenames,
    };
}
/**
 * Parse a semantic version string (allowing optional leading `v` and build metadata).
 */
export function tryParseSemver(version) {
    if (typeof version !== 'string') {
        return null;
    }
    const trimmed = version.trim();
    const match = FLEX_SEMVER_RE.exec(trimmed);
    if (!match) {
        return null;
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
        return null;
    }
    const prereleaseRaw = match[4];
    const prerelease = prereleaseRaw ? prereleaseRaw.split('.') : [];
    if (prerelease.some((part) => part.length === 0)) {
        return null;
    }
    return { major, minor, patch, prerelease };
}
function comparePrereleaseIdentifier(left, right) {
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
        const a = Number(left);
        const b = Number(right);
        return a < b ? -1 : a > b ? 1 : 0;
    }
    if (leftNumeric !== rightNumeric) {
        return leftNumeric ? -1 : 1;
    }
    return left < right ? -1 : left > right ? 1 : 0;
}
/**
 * Compare two SemVer 2.0.0 strings. Returns `-1`, `0`, or `1`.
 */
export function compareSemver(left, right) {
    const parsedLeft = tryParseSemver(left);
    if (!parsedLeft) {
        throw new Error(`Invalid semantic version: ${left}`);
    }
    const parsedRight = tryParseSemver(right);
    if (!parsedRight) {
        throw new Error(`Invalid semantic version: ${right}`);
    }
    if (parsedLeft.major !== parsedRight.major) {
        return parsedLeft.major < parsedRight.major ? -1 : 1;
    }
    if (parsedLeft.minor !== parsedRight.minor) {
        return parsedLeft.minor < parsedRight.minor ? -1 : 1;
    }
    if (parsedLeft.patch !== parsedRight.patch) {
        return parsedLeft.patch < parsedRight.patch ? -1 : 1;
    }
    const leftPre = parsedLeft.prerelease;
    const rightPre = parsedRight.prerelease;
    if (leftPre.length === 0 && rightPre.length === 0) {
        return 0;
    }
    if (leftPre.length === 0) {
        return 1;
    }
    if (rightPre.length === 0) {
        return -1;
    }
    const len = Math.min(leftPre.length, rightPre.length);
    for (let i = 0; i < len; i += 1) {
        const cmp = comparePrereleaseIdentifier(leftPre[i], rightPre[i]);
        if (cmp !== 0) {
            return cmp;
        }
    }
    return leftPre.length < rightPre.length ? -1 : leftPre.length > rightPre.length ? 1 : 0;
}
/**
 * Map Node platform/arch/musl metadata to the Antigravity CLI release target string.
 */
export function antigravityCliTarget(platform, arch, musl) {
    const descriptor = resolveTargetDescriptor(platform, arch, musl);
    return descriptor?.target ?? null;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Validate and normalize an Antigravity CLI auto-updater manifest payload for the requested target.
 */
export function parseAntigravityCliRelease(value, platform, arch, musl) {
    const descriptor = resolveTargetDescriptor(platform, arch, musl);
    if (!descriptor) {
        return null;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const record = value;
    if (typeof record.version !== 'string' || typeof record.url !== 'string' || typeof record.sha512 !== 'string') {
        return null;
    }
    const version = record.version.trim();
    if (!STRICT_MANIFEST_SEMVER_RE.test(version)) {
        return null;
    }
    if (compareSemver(version, MINIMUM_AGY_VERSION) < 0) {
        return null;
    }
    const sha512Raw = record.sha512.trim();
    if (!SHA512_HEX_RE.test(sha512Raw)) {
        return null;
    }
    const sha512 = sha512Raw.toLowerCase();
    let parsedUrl;
    try {
        parsedUrl = new URL(record.url.trim());
    }
    catch {
        return null;
    }
    if (parsedUrl.origin !== GCS_RELEASE_ORIGIN ||
        parsedUrl.port !== '' ||
        parsedUrl.username !== '' ||
        parsedUrl.password !== '' ||
        parsedUrl.search !== '' ||
        parsedUrl.hash !== '') {
        return null;
    }
    // Strictly expect /antigravity-public/antigravity-cli/<version>-<digits>/<folder>/cli_<os>_<cpu><suffix>.<ext>
    const segments = parsedUrl.pathname.split('/');
    if (segments.length !== 6 || segments[0] !== '') {
        return null;
    }
    const [, bucket, prefix, releaseId, folder, filename] = segments;
    if (bucket !== GCS_RELEASE_BUCKET || prefix !== GCS_RELEASE_PREFIX) {
        return null;
    }
    if (!releaseId || !folder || !filename) {
        return null;
    }
    const releaseIdPattern = new RegExp(`^${escapeRegExp(version)}-\\d+$`);
    if (!releaseIdPattern.test(releaseId)) {
        return null;
    }
    if (!descriptor.allowedFolders.has(folder)) {
        return null;
    }
    if (!descriptor.allowedFilenames.has(filename)) {
        return null;
    }
    let size;
    if (record.size !== undefined) {
        if (typeof record.size !== 'number' || !Number.isSafeInteger(record.size) || record.size <= 0) {
            return null;
        }
        size = record.size;
    }
    return {
        version,
        releaseId,
        target: descriptor.target,
        url: parsedUrl.toString(),
        sha512,
        executableName: descriptor.executableName,
        format: descriptor.format,
        ...(size !== undefined ? { size } : {}),
    };
}
//# sourceMappingURL=release.js.map