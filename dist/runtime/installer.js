import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AntigravityAcpError, redactSensitiveText } from '../shared/errors.js';
import { expandHomePath, getEnvValue, renameWithWindowsRetry, writeFileAtomic, } from './profile.js';
import { ANTIGRAVITY_CLI_MANIFEST_BASE, MINIMUM_AGY_VERSION, antigravityCliTarget, compareSemver, parseAntigravityCliRelease, } from './release.js';
const execFileAsync = promisify(execFile);
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_WAIT_TIMEOUT_MS = 60_000;
const STRICT_BINARY_BASENAME_RE = /^(?:agy|antigravity)(?:\.(?:exe|cmd|bat))?$/i;
const SAFE_RELEASE_ID_RE = /^[A-Za-z0-9._-]+$/;
function throwIfAborted(signal, message = 'Operation aborted') {
    if (signal?.aborted) {
        throw new AntigravityAcpError(message, 'ABORTED', { cause: signal.reason });
    }
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new AntigravityAcpError('Operation aborted', 'ABORTED', { cause: signal.reason }));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new AntigravityAcpError('Operation aborted', 'ABORTED', { cause: signal?.reason }));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
function detectMuslHost(platform, isRealPlatform) {
    if (platform !== 'linux' || !isRealPlatform) {
        return false;
    }
    try {
        const report = process.report?.getReport?.();
        if (report?.header) {
            return !report.header.glibcVersionRuntime;
        }
    }
    catch {
        // Fall through to filesystem check
    }
    try {
        if (fs.existsSync('/etc/alpine-release')) {
            return true;
        }
        const libEntries = fs.existsSync('/lib') ? fs.readdirSync('/lib') : [];
        return libEntries.some((entry) => entry.startsWith('ld-musl-'));
    }
    catch {
        return false;
    }
}
function isPathLike(target) {
    return (target.includes('/') ||
        target.includes('\\') ||
        target.startsWith('.') ||
        /^[A-Za-z]:/.test(target));
}
function isExecutableFileSync(filePath, platform) {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
            return false;
        }
        if (platform === 'win32') {
            return true;
        }
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function resolveWindowsCandidates(baseName, env) {
    if (/\.(?:exe|cmd|bat|com)$/i.test(baseName)) {
        return [baseName];
    }
    const pathExtRaw = getEnvValue(env, 'PATHEXT', 'win32');
    const defaultExts = ['.EXE', '.CMD', '.BAT', '.COM'];
    const parsedExts = pathExtRaw
        ? pathExtRaw
            .split(';')
            .map((ext) => ext.trim())
            .filter((ext) => ext.startsWith('.'))
        : defaultExts;
    const preferred = ['.EXE', '.CMD', '.BAT'];
    const ordered = new Set([...preferred, ...parsedExts.map((ext) => ext.toUpperCase())]);
    return [...ordered].map((ext) => `${baseName}${ext.toLowerCase()}`);
}
function findExecutableOnPath(names, pathEnv, platform, env) {
    if (!pathEnv) {
        return null;
    }
    const delimiter = platform === 'win32' ? ';' : ':';
    const dirs = pathEnv
        .split(delimiter)
        .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean);
    for (const dir of dirs) {
        for (const rawName of names) {
            const candidates = platform === 'win32' ? resolveWindowsCandidates(rawName, env) : [rawName];
            for (const candidateName of candidates) {
                const candidatePath = path.join(dir, candidateName);
                if (isExecutableFileSync(candidatePath, platform)) {
                    return candidatePath;
                }
            }
        }
    }
    return null;
}
function resolveWithinDir(baseDir, relativePath) {
    if (!relativePath || path.isAbsolute(relativePath)) {
        return null;
    }
    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.resolve(resolvedBase, relativePath);
    const rel = path.relative(resolvedBase, resolvedTarget);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        return null;
    }
    return resolvedTarget;
}
async function removeWithRetry(targetPath) {
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            await fs.promises.rm(targetPath, { recursive: true, force: true });
            return;
        }
        catch (error) {
            const code = error.code;
            if ((code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY' || code === 'EACCES') &&
                attempt < maxAttempts - 1) {
                await sleep(50 * (attempt + 1));
                continue;
            }
            return;
        }
    }
}
async function acquireLockfile(lockPath, signal) {
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    while (true) {
        throwIfAborted(signal, 'Installation aborted while waiting for cache lock');
        try {
            const handle = await fs.promises.open(lockPath, 'wx');
            try {
                await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
            }
            finally {
                await handle.close();
            }
            return async () => {
                await removeWithRetry(lockPath);
            };
        }
        catch (error) {
            const code = error.code;
            if (code !== 'EEXIST') {
                throw error;
            }
            try {
                const stat = await fs.promises.stat(lockPath);
                if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
                    await removeWithRetry(lockPath);
                    continue;
                }
            }
            catch {
                // Lock disappeared concurrently
                continue;
            }
            if (Date.now() >= deadline) {
                throw new AntigravityAcpError('Timed out waiting for Antigravity CLI installation lock', 'AGY_INSTALL_FAILED');
            }
            await sleep(75, signal);
        }
    }
}
function safeParseJson(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function combineSignals(signal, timeoutMs) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
        if (signal.aborted) {
            controller.abort(signal.reason);
        }
        else {
            signal.addEventListener('abort', onAbort, { once: true });
        }
    }
    let timer;
    if (timeoutMs !== undefined && timeoutMs > 0 && !controller.signal.aborted) {
        timer = setTimeout(() => {
            controller.abort(new Error(`Timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    }
    return {
        signal: controller.signal,
        cleanup: () => {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            signal?.removeEventListener('abort', onAbort);
        },
    };
}
function findExtractedBinary(extractDir, expectedName) {
    const direct = path.join(extractDir, expectedName);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
        return direct;
    }
    const candidates = expectedName === 'agy.exe' ? ['agy.exe', 'antigravity.exe'] : ['antigravity', 'agy'];
    const queue = [{ dir: extractDir, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        const entries = fs.readdirSync(current.dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current.dir, entry.name);
            if (entry.isFile() && candidates.includes(entry.name)) {
                return fullPath;
            }
            if (entry.isDirectory() && current.depth < 3) {
                queue.push({ dir: fullPath, depth: current.depth + 1 });
            }
        }
    }
    return null;
}
/**
 * Resolves and optionally downloads/caches the Antigravity CLI (`agy`) runtime binary.
 */
export class AntigravityInstaller {
    config;
    fetchImpl;
    platform;
    arch;
    musl;
    env;
    homeDir;
    pathEnvOverride;
    explicitCacheDir;
    subprocess;
    manifestBaseUrl;
    maxDownloadBytes;
    tarExtractor;
    hasMockedExecutionWorld;
    constructor(config, options = {}) {
        this.config = config;
        this.fetchImpl = options.fetch ?? globalThis.fetch;
        this.platform = options.platform ?? process.platform;
        this.arch = options.arch ?? process.arch;
        this.env = options.env ?? process.env;
        this.homeDir = options.homeDir ?? os.homedir();
        this.pathEnvOverride = options.pathEnv;
        this.explicitCacheDir = options.cacheDir;
        this.subprocess = options.subprocess;
        this.manifestBaseUrl = (options.manifestBaseUrl ?? ANTIGRAVITY_CLI_MANIFEST_BASE).replace(/\/+$/, '');
        this.maxDownloadBytes = options.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
        this.tarExtractor = options.tarExtractor;
        this.hasMockedExecutionWorld =
            options.platform !== undefined ||
                options.arch !== undefined ||
                options.env !== undefined ||
                options.pathEnv !== undefined;
        this.musl =
            options.musl ?? detectMuslHost(this.platform, options.platform === undefined);
    }
    /** Root cache directory owning managed Antigravity binaries. */
    resolveCacheRoot() {
        const rawOverride = this.explicitCacheDir?.trim() || this.config.cacheDir?.trim();
        if (rawOverride) {
            return path.resolve(expandHomePath(rawOverride, this.homeDir));
        }
        if (this.platform === 'win32') {
            const localAppData = getEnvValue(this.env, 'LOCALAPPDATA', 'win32')?.trim() ||
                path.join(this.homeDir, 'AppData', 'Local');
            return path.resolve(path.join(localAppData, 'dsh-antigravity-acp'));
        }
        if (this.platform === 'darwin') {
            return path.resolve(path.join(this.homeDir, 'Library', 'Caches', 'dsh-antigravity-acp'));
        }
        const xdgCache = getEnvValue(this.env, 'XDG_CACHE_HOME', this.platform)?.trim() ||
            path.join(this.homeDir, '.cache');
        return path.resolve(path.join(xdgCache, 'dsh-antigravity-acp'));
    }
    /** Target-specific managed runtime directory holding `active.json` and `versions/`. */
    resolvePlatformCacheDir() {
        return path.join(this.resolveCacheRoot(), 'tools', 'antigravity-acp', `${this.platform}-${this.arch}`);
    }
    /**
     * Resolve the executable in strict precedence:
     * 1) `config.binaryPath` (`configured`)
     * 2) Managed cache (`cached`)
     * 3) System `PATH` (`path`)
     * 4) Managed download when `autoDownload` enabled (`downloaded`)
     */
    async resolveExecutable(options) {
        throwIfAborted(options?.signal, 'Executable resolution aborted');
        const configured = this.config.binaryPath?.trim();
        if (configured) {
            return this.resolveConfiguredBinary(configured, options?.signal);
        }
        const cached = this.resolveCachedBinary();
        if (cached) {
            return cached;
        }
        const onPath = await this.resolveSystemPathBinary(options?.signal);
        if (onPath) {
            return onPath;
        }
        if (options?.allowDownload !== false && this.config.autoDownload) {
            return this.installManaged({ signal: options?.signal });
        }
        throw new AntigravityAcpError('Antigravity CLI (agy) is not installed and autoDownload is disabled', 'AGY_NOT_INSTALLED');
    }
    async resolveConfiguredBinary(rawBinaryPath, signal) {
        const expanded = expandHomePath(rawBinaryPath, this.homeDir);
        const basename = path.basename(expanded);
        if (!STRICT_BINARY_BASENAME_RE.test(basename)) {
            throw new AntigravityAcpError(`Configured binaryPath "${basename}" must target agy or antigravity`, 'AGY_NOT_INSTALLED');
        }
        if (isPathLike(expanded)) {
            const resolved = path.resolve(expanded);
            if (!isExecutableFileSync(resolved, this.platform)) {
                throw new AntigravityAcpError(`Configured Antigravity binary was not found or is not executable: ${resolved}`, 'AGY_NOT_INSTALLED');
            }
            return {
                command: resolved,
                argsPrefix: ['acp'],
                source: 'configured',
            };
        }
        const pathValue = this.pathEnvOverride ?? getEnvValue(this.env, 'PATH', this.platform);
        const found = findExecutableOnPath([expanded], pathValue, this.platform, this.env);
        if (found) {
            return {
                command: found,
                argsPrefix: ['acp'],
                source: 'configured',
            };
        }
        if (this.subprocess && !this.hasMockedExecutionWorld) {
            try {
                const resolved = await this.subprocess.resolveExecutable(expanded, undefined, signal);
                return {
                    command: resolved,
                    argsPrefix: ['acp'],
                    source: 'configured',
                };
            }
            catch {
                // Fall through to AGY_NOT_INSTALLED
            }
        }
        throw new AntigravityAcpError(`Configured Antigravity command "${expanded}" was not found on PATH`, 'AGY_NOT_INSTALLED');
    }
    resolveCachedBinary() {
        const platformCacheDir = this.resolvePlatformCacheDir();
        const activePath = path.join(platformCacheDir, 'active.json');
        if (!fs.existsSync(activePath)) {
            return null;
        }
        let activeRaw;
        try {
            activeRaw = fs.readFileSync(activePath, 'utf8');
        }
        catch {
            return null;
        }
        const active = safeParseJson(activeRaw);
        if (!active ||
            typeof active.releaseId !== 'string' ||
            !SAFE_RELEASE_ID_RE.test(active.releaseId) ||
            active.releaseId === '.' ||
            active.releaseId === '..') {
            return null;
        }
        const expectedTarget = antigravityCliTarget(this.platform, this.arch, this.musl);
        if (active.target && expectedTarget && active.target !== expectedTarget) {
            return null;
        }
        const versionDir = path.join(platformCacheDir, 'versions', active.releaseId);
        const receiptPath = path.join(versionDir, '.install-complete.json');
        if (!fs.existsSync(receiptPath)) {
            return null;
        }
        let receiptRaw;
        try {
            receiptRaw = fs.readFileSync(receiptPath, 'utf8');
        }
        catch {
            return null;
        }
        const receipt = safeParseJson(receiptRaw);
        if (!receipt ||
            receipt.releaseId !== active.releaseId ||
            typeof receipt.version !== 'string' ||
            typeof receipt.executableRelativePath !== 'string' ||
            typeof receipt.size !== 'number' ||
            !Number.isSafeInteger(receipt.size) ||
            receipt.size <= 0) {
            return null;
        }
        if (receipt.target && expectedTarget && receipt.target !== expectedTarget) {
            return null;
        }
        try {
            if (compareSemver(receipt.version, MINIMUM_AGY_VERSION) < 0) {
                return null;
            }
        }
        catch {
            return null;
        }
        const binaryPath = resolveWithinDir(versionDir, receipt.executableRelativePath);
        if (!binaryPath || !isExecutableFileSync(binaryPath, this.platform)) {
            return null;
        }
        try {
            const stat = fs.statSync(binaryPath);
            if (stat.size !== receipt.size) {
                return null;
            }
        }
        catch {
            return null;
        }
        return {
            command: binaryPath,
            argsPrefix: ['acp'],
            source: 'cached',
            version: receipt.version,
            cacheDir: platformCacheDir,
        };
    }
    async resolveSystemPathBinary(signal) {
        const pathValue = this.pathEnvOverride ?? getEnvValue(this.env, 'PATH', this.platform);
        const found = findExecutableOnPath(['agy', 'antigravity'], pathValue, this.platform, this.env);
        if (found) {
            return {
                command: found,
                argsPrefix: ['acp'],
                source: 'path',
            };
        }
        if (this.subprocess && !this.hasMockedExecutionWorld) {
            for (const cmd of ['agy', 'antigravity']) {
                throwIfAborted(signal, 'Executable resolution aborted');
                try {
                    const resolved = await this.subprocess.resolveExecutable(cmd, undefined, signal);
                    if (isExecutableFileSync(resolved, this.platform)) {
                        return {
                            command: resolved,
                            argsPrefix: ['acp'],
                            source: 'path',
                        };
                    }
                }
                catch {
                    // Try next binary name
                }
            }
        }
        return null;
    }
    /**
     * Fetch the target manifest, download and verify SHA-512, extract/stage atomically, and activate.
     */
    async installManaged(options) {
        throwIfAborted(options?.signal, 'Antigravity CLI installation aborted');
        const target = antigravityCliTarget(this.platform, this.arch, this.musl);
        if (!target) {
            throw new AntigravityAcpError(`Unsupported platform/architecture for managed Antigravity CLI install: ${this.platform}/${this.arch}`, 'AGY_INSTALL_FAILED');
        }
        const platformCacheDir = this.resolvePlatformCacheDir();
        const versionsDir = path.join(platformCacheDir, 'versions');
        await fs.promises.mkdir(versionsDir, { recursive: true });
        const lockPath = path.join(platformCacheDir, '.install.lock');
        const releaseLock = await acquireLockfile(lockPath, options?.signal);
        const stagingDir = path.join(platformCacheDir, `.staging-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
        try {
            const manifestUrl = `${this.manifestBaseUrl}/${target}.json`;
            options?.onProgress?.(`Fetching manifest ${manifestUrl}`);
            const manifestSignal = combineSignals(options?.signal, DEFAULT_FETCH_TIMEOUT_MS);
            let manifestJson;
            try {
                const res = await this.fetchImpl(manifestUrl, {
                    method: 'GET',
                    headers: { Accept: 'application/json' },
                    signal: manifestSignal.signal,
                });
                if (!res.ok) {
                    throw new AntigravityAcpError(`Manifest fetch failed with HTTP ${res.status}`, 'AGY_INSTALL_FAILED', { status: res.status });
                }
                manifestJson = await res.json();
            }
            catch (error) {
                if (options?.signal?.aborted) {
                    throw new AntigravityAcpError('Antigravity CLI installation aborted', 'ABORTED', {
                        cause: error,
                    });
                }
                if (error instanceof AntigravityAcpError) {
                    throw error;
                }
                throw new AntigravityAcpError(`Failed to fetch Antigravity CLI manifest: ${redactSensitiveText(error?.message ?? String(error))}`, 'AGY_INSTALL_FAILED', { cause: error });
            }
            finally {
                manifestSignal.cleanup();
            }
            const asset = parseAntigravityCliRelease(manifestJson, this.platform, this.arch, this.musl);
            if (!asset) {
                throw new AntigravityAcpError(`Invalid Antigravity CLI manifest payload for target ${target}`, 'AGY_INSTALL_FAILED');
            }
            if (asset.size !== undefined && asset.size > this.maxDownloadBytes) {
                throw new AntigravityAcpError(`Antigravity CLI release exceeds maximum allowed size (${asset.size} bytes)`, 'AGY_INSTALL_FAILED');
            }
            const versionDir = path.join(versionsDir, asset.releaseId);
            const completePath = path.join(versionDir, '.install-complete.json');
            if (fs.existsSync(completePath)) {
                const existingReceipt = safeParseJson(fs.readFileSync(completePath, 'utf8'));
                if (existingReceipt &&
                    existingReceipt.releaseId === asset.releaseId &&
                    existingReceipt.sha512 === asset.sha512) {
                    const existingBinary = resolveWithinDir(versionDir, existingReceipt.executableRelativePath);
                    if (existingBinary &&
                        isExecutableFileSync(existingBinary, this.platform) &&
                        fs.statSync(existingBinary).size === existingReceipt.size) {
                        await this.writeActivePointer(platformCacheDir, asset.releaseId, asset.version, target, asset.executableName);
                        return {
                            command: existingBinary,
                            argsPrefix: ['acp'],
                            source: 'downloaded',
                            version: asset.version,
                            cacheDir: platformCacheDir,
                        };
                    }
                }
            }
            await fs.promises.mkdir(stagingDir, { recursive: true });
            const downloadFilename = asset.format === 'executable' ? asset.executableName : `archive.tar.gz`;
            const downloadPath = path.join(stagingDir, downloadFilename);
            const extractDir = path.join(stagingDir, 'extract');
            await fs.promises.mkdir(extractDir, { recursive: true });
            options?.onProgress?.(`Downloading Antigravity CLI ${asset.version}`);
            const actualSha512 = await this.downloadAndHash(asset.url, downloadPath, options?.signal, {
                version: asset.version,
                onProgress: options?.onProgress,
            });
            const actualBuf = Buffer.from(actualSha512, 'hex');
            const expectedBuf = Buffer.from(asset.sha512, 'hex');
            if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
                throw new AntigravityAcpError(`Antigravity CLI SHA-512 checksum mismatch for ${asset.releaseId}`, 'AGY_INSTALL_FAILED');
            }
            let stagedBinaryPath;
            if (asset.format === 'executable') {
                stagedBinaryPath = path.join(extractDir, asset.executableName);
                await renameWithWindowsRetry(downloadPath, stagedBinaryPath);
            }
            else {
                options?.onProgress?.(`Extracting Antigravity CLI ${asset.version}`);
                stagedBinaryPath = await this.extractTarball(downloadPath, extractDir, asset.executableName, options?.signal);
                if (this.platform !== 'win32') {
                    await fs.promises.chmod(stagedBinaryPath, 0o755);
                }
            }
            const finalBinaryInExtract = path.join(extractDir, asset.executableName);
            if (path.resolve(stagedBinaryPath) !== path.resolve(finalBinaryInExtract)) {
                await renameWithWindowsRetry(stagedBinaryPath, finalBinaryInExtract);
            }
            const binaryStat = await fs.promises.stat(finalBinaryInExtract);
            if (!binaryStat.isFile() || binaryStat.size <= 0) {
                throw new AntigravityAcpError('Installed Antigravity CLI binary is empty or invalid', 'AGY_INSTALL_FAILED');
            }
            if (fs.existsSync(versionDir)) {
                await removeWithRetry(versionDir);
            }
            await renameWithWindowsRetry(extractDir, versionDir);
            const receipt = {
                releaseId: asset.releaseId,
                version: asset.version,
                target: asset.target,
                sha512: asset.sha512,
                executableRelativePath: asset.executableName,
                size: binaryStat.size,
                completedAt: new Date().toISOString(),
            };
            await writeFileAtomic(path.join(versionDir, '.install-complete.json'), `${JSON.stringify(receipt, null, 2)}\n`, this.platform);
            await this.writeActivePointer(platformCacheDir, asset.releaseId, asset.version, asset.target, asset.executableName);
            const finalBinaryPath = path.join(versionDir, asset.executableName);
            return {
                command: finalBinaryPath,
                argsPrefix: ['acp'],
                source: 'downloaded',
                version: asset.version,
                cacheDir: platformCacheDir,
            };
        }
        catch (error) {
            if (error instanceof AntigravityAcpError) {
                throw error;
            }
            if (options?.signal?.aborted) {
                throw new AntigravityAcpError('Antigravity CLI installation aborted', 'ABORTED', {
                    cause: error,
                });
            }
            throw new AntigravityAcpError(`Antigravity CLI installation failed: ${redactSensitiveText(error?.message ?? String(error))}`, 'AGY_INSTALL_FAILED', { cause: error });
        }
        finally {
            await removeWithRetry(stagingDir);
            await releaseLock();
        }
    }
    async writeActivePointer(platformCacheDir, releaseId, version, target, executable) {
        const activePointer = {
            releaseId,
            version,
            target,
            executable,
            installedAt: new Date().toISOString(),
        };
        await writeFileAtomic(path.join(platformCacheDir, 'active.json'), `${JSON.stringify(activePointer, null, 2)}\n`, this.platform);
    }
    async downloadAndHash(url, destinationPath, signal, progress) {
        const downloadSignal = combineSignals(signal, DEFAULT_FETCH_TIMEOUT_MS);
        try {
            const response = await this.fetchImpl(url, {
                method: 'GET',
                signal: downloadSignal.signal,
            });
            if (!response.ok) {
                throw new AntigravityAcpError(`Asset download failed with HTTP ${response.status}`, 'AGY_INSTALL_FAILED', { status: response.status });
            }
            const contentLengthRaw = response.headers?.get?.('content-length');
            let expectedTotalBytes;
            if (contentLengthRaw) {
                const contentLength = Number(contentLengthRaw);
                if (Number.isFinite(contentLength) && contentLength > this.maxDownloadBytes) {
                    throw new AntigravityAcpError(`Asset content-length ${contentLength} exceeds ${this.maxDownloadBytes} byte limit`, 'AGY_INSTALL_FAILED');
                }
                if (Number.isFinite(contentLength) && contentLength > 0) {
                    expectedTotalBytes = contentLength;
                }
            }
            const hash = crypto.createHash('sha512');
            let totalBytes = 0;
            let lastProgressAt = 0;
            if (response.body && typeof response.body.getReader === 'function') {
                const reader = response.body.getReader();
                const fileHandle = await fs.promises.open(destinationPath, 'w');
                try {
                    while (true) {
                        throwIfAborted(signal, 'Antigravity CLI download aborted');
                        const { done, value } = await reader.read();
                        if (done) {
                            break;
                        }
                        if (!value || value.byteLength === 0) {
                            continue;
                        }
                        totalBytes += value.byteLength;
                        if (totalBytes > this.maxDownloadBytes) {
                            await reader.cancel('Exceeds maximum download size').catch(() => { });
                            throw new AntigravityAcpError(`Downloaded artifact exceeds maximum allowed size (${this.maxDownloadBytes} bytes)`, 'AGY_INSTALL_FAILED');
                        }
                        hash.update(value);
                        await fileHandle.write(value);
                        if (progress?.onProgress) {
                            const now = Date.now();
                            if (now - lastProgressAt >= 400) {
                                lastProgressAt = now;
                                const mbDone = (totalBytes / (1024 * 1024)).toFixed(1);
                                const label = progress.version
                                    ? `Downloading Antigravity CLI ${progress.version}`
                                    : 'Downloading Antigravity CLI';
                                if (expectedTotalBytes !== undefined) {
                                    const mbTotal = (expectedTotalBytes / (1024 * 1024)).toFixed(1);
                                    const pct = Math.min(100, Math.round((totalBytes / expectedTotalBytes) * 100));
                                    progress.onProgress(`${label} (${mbDone} / ${mbTotal} MB, ${pct}%)`);
                                }
                                else {
                                    progress.onProgress(`${label} (${mbDone} MB)`);
                                }
                            }
                        }
                    }
                }
                finally {
                    await fileHandle.close();
                    reader.releaseLock();
                }
            }
            else {
                const arrayBuf = await response.arrayBuffer();
                const buf = Buffer.from(arrayBuf);
                if (buf.byteLength > this.maxDownloadBytes) {
                    throw new AntigravityAcpError(`Downloaded artifact exceeds maximum allowed size (${this.maxDownloadBytes} bytes)`, 'AGY_INSTALL_FAILED');
                }
                hash.update(buf);
                await fs.promises.writeFile(destinationPath, buf);
            }
            return hash.digest('hex');
        }
        catch (error) {
            if (signal?.aborted) {
                throw new AntigravityAcpError('Antigravity CLI download aborted', 'ABORTED', {
                    cause: error,
                });
            }
            if (error instanceof AntigravityAcpError) {
                throw error;
            }
            throw new AntigravityAcpError(`Failed to download Antigravity CLI asset: ${redactSensitiveText(error?.message ?? String(error))}`, 'AGY_INSTALL_FAILED', { cause: error });
        }
        finally {
            downloadSignal.cleanup();
        }
    }
    async extractTarball(archivePath, extractDir, expectedName, signal) {
        if (this.tarExtractor) {
            await this.tarExtractor(archivePath, extractDir, signal);
        }
        else {
            const { stdout: listing } = await execFileAsync('tar', ['-tzf', archivePath], {
                shell: false,
                signal,
                maxBuffer: 4 * 1024 * 1024,
            });
            for (const rawEntry of listing.split(/\r?\n/)) {
                const entry = rawEntry.trim();
                if (!entry) {
                    continue;
                }
                const normalized = entry.replace(/\\/g, '/');
                if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
                    throw new AntigravityAcpError(`Unsafe path entry in Antigravity CLI archive: ${entry}`, 'AGY_INSTALL_FAILED');
                }
            }
            await execFileAsync('tar', ['-xzf', archivePath, '-C', extractDir], {
                shell: false,
                signal,
                maxBuffer: 4 * 1024 * 1024,
            });
        }
        const found = findExtractedBinary(extractDir, expectedName);
        if (!found) {
            throw new AntigravityAcpError(`Extracted archive does not contain ${expectedName}`, 'AGY_INSTALL_FAILED');
        }
        const realExtractDir = fs.realpathSync(extractDir);
        const realBinaryPath = fs.realpathSync(found);
        const rel = path.relative(realExtractDir, realBinaryPath);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new AntigravityAcpError('Extracted binary resolves outside staging directory', 'AGY_INSTALL_FAILED');
        }
        return found;
    }
}
/**
 * Factory helper creating an {@link AntigravityInstaller} for a {@link RuntimeConfig}.
 */
export function createAntigravityInstaller(config, options) {
    return new AntigravityInstaller(config, options);
}
//# sourceMappingURL=installer.js.map