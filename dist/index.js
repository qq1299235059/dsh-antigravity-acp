import { spawnAcpClient } from './acp/client.js';
import { AcpWorkerPool } from './acp/pool.js';
import { checkProfileAuth, clearProfileAuth, runCodeLogin, runLoopbackLogin, } from './runtime/auth.js';
import { createAntigravityInstaller, } from './runtime/installer.js';
import { prepareAntigravityProfile, resolveProfilePaths, resolveProfileSnapshot, validateAuthConfig, validateProxyUrl, } from './runtime/profile.js';
import { probeAntigravityQuota } from './runtime/quota.js';
import { registerAntigravityControlRemote, } from './remote/control-remote.js';
import { loadUiOverrides, mergeRuntimeConfigWithOverrides, } from './remote/ui-store.js';
import { RuntimeConfigSchema } from './shared/config.js';
import { AntigravityAcpError, redactSensitiveText } from './shared/errors.js';
export const name = 'antigravity-runtime';
export const inject = ['subprocess'];
export const Config = RuntimeConfigSchema;
function isHeadlessEnvironment(env, platform) {
    if (env['SSH_CONNECTION'] || env['SSH_TTY']) {
        return true;
    }
    if (platform === 'linux' && !env['DISPLAY'] && !env['WAYLAND_DISPLAY']) {
        return true;
    }
    return false;
}
function shouldFallbackToCodeLogin(error) {
    if (error instanceof AntigravityAcpError) {
        const lower = error.message.toLowerCase();
        return (error.code === 'AGY_AUTH_REQUIRED' ||
            lower.includes('no browser') ||
            lower.includes('browser'));
    }
    if (error instanceof Error) {
        return error.message.toLowerCase().includes('no browser');
    }
    return false;
}
function raceWithAbortSignal(promise, signal) {
    if (!signal) {
        return promise;
    }
    if (signal.aborted) {
        return Promise.reject(new AntigravityAcpError('Operation aborted', 'ABORTED', { cause: signal.reason }));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            reject(new AntigravityAcpError('Operation aborted', 'ABORTED', { cause: signal.reason }));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then((value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
}
const VALID_AUTH_METHODS = new Set([
    'oauth-personal',
    'oauth-business',
    'gemini-api-key',
    'agent-platform',
]);
const OPTIONAL_RUNTIME_STRING_KEYS = [
    'apiKey',
    'apiKeyEnv',
    'gcpProject',
    'gcpLocation',
    'binaryPath',
    'cacheDir',
    'profileDir',
    'proxyUrl',
    'proxyBypass',
];
/**
 * Create a standalone {@link AntigravityRuntimeService} backed by the given {@link SubprocessRuntime}.
 */
export function createAntigravityRuntimeService(subprocess, config, options = {}) {
    const envInput = options.env ?? process.env;
    const homeDir = options.homeDir;
    const activePlatform = options.platform ?? process.platform;
    let currentConfig = { ...config };
    const buildInstaller = (cfg) => createAntigravityInstaller(cfg, {
        ...options.installerOptions,
        subprocess,
        env: options.installerOptions?.env ?? envInput,
        homeDir: options.installerOptions?.homeDir ?? homeDir,
        platform: options.installerOptions?.platform ?? activePlatform,
        fetch: options.installerOptions?.fetch ?? options.fetch,
    });
    let installer = buildInstaller(currentConfig);
    const disposeController = new AbortController();
    let disposed = false;
    let configEpoch = 0;
    let cachedModels;
    let lastQuota;
    let inflightDiscovery;
    const changeListeners = new Set();
    const notifyChanged = () => {
        for (const listener of [...changeListeners]) {
            try {
                listener();
            }
            catch (error) {
                const msg = error instanceof Error ? redactSensitiveText(error.message) : String(error);
                options.logger?.warn(`antigravity runtime change listener failed: ${msg}`);
            }
        }
    };
    const resolveExecutable = (signal) => installer.resolveExecutable({
        signal,
        allowDownload: currentConfig.autoDownload,
    });
    const ensureInstalled = async (signal) => {
        try {
            return await installer.resolveExecutable({
                signal,
                allowDownload: false,
            });
        }
        catch (error) {
            if (error instanceof AntigravityAcpError &&
                error.code === 'AGY_NOT_INSTALLED' &&
                !currentConfig.binaryPath?.trim()) {
                return installer.installManaged({ signal });
            }
            throw error;
        }
    };
    let prepareQueue = Promise.resolve();
    const prepareProfile = (opts) => {
        if (opts?.signal?.aborted) {
            return Promise.reject(new AntigravityAcpError('Profile preparation aborted', 'ABORTED', {
                cause: opts.signal.reason,
            }));
        }
        const snapshotConfig = currentConfig;
        const run = prepareQueue.then(() => prepareAntigravityProfile(snapshotConfig, {
            env: envInput,
            homeDir,
            platform: activePlatform,
            suppressBrowser: opts?.suppressBrowser,
        }));
        prepareQueue = run.then(() => undefined, () => undefined);
        return raceWithAbortSignal(run, opts?.signal);
    };
    const createPool = () => new AcpWorkerPool({
        subprocess,
        config: currentConfig,
        resolveExecutable,
        prepareProfile,
        skipVersionCheck: options.skipVersionCheck,
    });
    let pool = createPool();
    const service = {
        get config() {
            return currentConfig;
        },
        resolveExecutable,
        ensureInstalled,
        resolveProfile() {
            return resolveProfileSnapshot(currentConfig, envInput, homeDir, activePlatform);
        },
        async checkAuth(signal) {
            if (signal?.aborted) {
                throw new AntigravityAcpError('Auth check aborted', 'ABORTED', { cause: signal.reason });
            }
            return checkProfileAuth(currentConfig, envInput, homeDir, activePlatform);
        },
        async login(loginOpts) {
            if (disposed) {
                throw new AntigravityAcpError('Antigravity runtime has been disposed', 'ABORTED');
            }
            if (loginOpts?.signal?.aborted) {
                throw new AntigravityAcpError('Login aborted', 'ABORTED', {
                    cause: loginOpts.signal.reason,
                });
            }
            const effectiveConfig = {
                ...currentConfig,
                ...(loginOpts?.authMethod !== undefined ? { authMethod: loginOpts.authMethod } : {}),
                ...(loginOpts?.apiKey !== undefined ? { apiKey: loginOpts.apiKey } : {}),
            };
            validateAuthConfig(effectiveConfig, envInput, activePlatform);
            if (effectiveConfig.authMethod === 'gemini-api-key' ||
                effectiveConfig.authMethod === 'agent-platform') {
                const prepared = await prepareAntigravityProfile(effectiveConfig, {
                    env: envInput,
                    homeDir,
                    platform: activePlatform,
                    suppressBrowser: true,
                });
                if (!prepared.hasApiKey) {
                    throw new AntigravityAcpError(`Missing API key for auth method "${effectiveConfig.authMethod}"`, 'AGY_AUTH_REQUIRED');
                }
                cachedModels = undefined;
                notifyChanged();
                return resolveProfileSnapshot(effectiveConfig, envInput, homeDir, activePlatform);
            }
            const executable = await ensureInstalled(loginOpts?.signal);
            const requestedMode = loginOpts?.mode ?? 'auto';
            const invokeCodeLogin = async () => {
                if (!loginOpts?.readCode) {
                    throw new AntigravityAcpError('Code login requires a readCode callback to accept the authorization code', 'INVALID_REQUEST');
                }
                return runCodeLogin({
                    config: effectiveConfig,
                    executable,
                    subprocess,
                    onAuthUrl: (url) => loginOpts.onAuthUrl?.(url, 'code'),
                    readCode: loginOpts.readCode,
                    signal: loginOpts.signal,
                    env: envInput,
                    homeDir,
                    platform: activePlatform,
                });
            };
            const invokeLoopbackLogin = async () => runLoopbackLogin({
                config: effectiveConfig,
                connectClient: ({ profile, onAuthUrl, signal }) => spawnAcpClient({
                    subprocess,
                    executable,
                    profile,
                    config: effectiveConfig,
                    cwd: profile.profileDir,
                    onAuthUrl,
                    suppressBrowser: Boolean(loginOpts?.onAuthUrl),
                    skipVersionCheck: options.skipVersionCheck,
                    signal,
                }),
                onAuthUrl: loginOpts?.onAuthUrl
                    ? (url) => loginOpts.onAuthUrl(url, 'loopback')
                    : undefined,
                suppressBrowser: Boolean(loginOpts?.onAuthUrl),
                signal: loginOpts?.signal,
                env: envInput,
                homeDir,
                platform: activePlatform,
            });
            let resultProfile;
            if (requestedMode === 'code') {
                resultProfile = await invokeCodeLogin();
            }
            else if (requestedMode === 'loopback') {
                resultProfile = await invokeLoopbackLogin();
            }
            else if (isHeadlessEnvironment(envInput, activePlatform) && loginOpts?.readCode) {
                resultProfile = await invokeCodeLogin();
            }
            else {
                try {
                    resultProfile = await invokeLoopbackLogin();
                }
                catch (error) {
                    if (loginOpts?.readCode &&
                        !loginOpts.signal?.aborted &&
                        shouldFallbackToCodeLogin(error)) {
                        resultProfile = await invokeCodeLogin();
                    }
                    else {
                        throw error;
                    }
                }
            }
            cachedModels = undefined;
            notifyChanged();
            return resultProfile;
        },
        async logout(signal) {
            if (signal?.aborted) {
                throw new AntigravityAcpError('Logout aborted', 'ABORTED', { cause: signal.reason });
            }
            configEpoch += 1;
            cachedModels = undefined;
            lastQuota = undefined;
            inflightDiscovery = undefined;
            const oldPool = pool;
            if (!disposed) {
                pool = createPool();
            }
            await oldPool.dispose();
            const snapshot = resolveProfileSnapshot(currentConfig, envInput, homeDir, activePlatform);
            await clearProfileAuth(snapshot);
            notifyChanged();
        },
        async listModels(listOpts) {
            if (listOpts?.signal?.aborted) {
                throw new AntigravityAcpError('Model discovery aborted', 'ABORTED', {
                    cause: listOpts.signal.reason,
                });
            }
            if (!listOpts?.refresh && cachedModels !== undefined && cachedModels.length > 0) {
                return cachedModels;
            }
            if (inflightDiscovery === undefined) {
                const cwd = listOpts?.cwd ?? process.cwd();
                const taskEpoch = configEpoch;
                const task = (async () => {
                    const lease = await pool.acquireWorker({
                        cwd,
                        reuseSession: false,
                        signal: disposeController.signal,
                    });
                    try {
                        const models = await lease.client.discoverModels(cwd, disposeController.signal);
                        if (taskEpoch === configEpoch) {
                            cachedModels = models;
                        }
                        return models;
                    }
                    finally {
                        await lease.release().catch(() => { });
                    }
                })();
                inflightDiscovery = task.finally(() => {
                    if (inflightDiscovery === task) {
                        inflightDiscovery = undefined;
                    }
                });
            }
            return raceWithAbortSignal(inflightDiscovery, listOpts?.signal);
        },
        async getQuota(signal) {
            const snapshot = await probeAntigravityQuota(currentConfig, {
                signal,
                env: envInput,
                homeDir,
                platform: activePlatform,
                fetch: options.fetch,
            });
            lastQuota = snapshot;
            return snapshot;
        },
        async getStatus(signal) {
            let executable;
            try {
                executable = await installer.resolveExecutable({
                    signal,
                    allowDownload: false,
                });
            }
            catch (error) {
                if (error instanceof AntigravityAcpError && error.code === 'ABORTED') {
                    throw error;
                }
                executable = undefined;
            }
            const profile = resolveProfileSnapshot(currentConfig, envInput, homeDir, activePlatform);
            const stats = pool.getStats();
            return {
                installed: executable !== undefined,
                ...(executable !== undefined ? { executable } : {}),
                profile,
                activeLeases: stats.activeLeases,
                idleWorkers: stats.idleWorkers,
                maxConcurrentSessions: stats.maxConcurrentSessions,
                ...(lastQuota !== undefined ? { lastQuota } : {}),
            };
        },
        acquireWorker(acquireOpts) {
            return pool.acquireWorker(acquireOpts);
        },
        spawnClient(spawnOpts) {
            return pool.spawnClient(spawnOpts);
        },
        async warmup(signal) {
            if (currentConfig.proxyUrl?.trim()) {
                validateProxyUrl(currentConfig.proxyUrl);
            }
            await resolveExecutable(signal);
            await prepareProfile({ suppressBrowser: true, signal });
            const profile = resolveProfileSnapshot(currentConfig, envInput, homeDir, activePlatform);
            if (profile.authenticated) {
                await service.listModels({ refresh: true, signal });
            }
        },
        async installManaged(installOpts) {
            if (disposed) {
                throw new AntigravityAcpError('Antigravity runtime has been disposed', 'ABORTED');
            }
            const executable = await installer.installManaged(installOpts);
            cachedModels = undefined;
            notifyChanged();
            return executable;
        },
        async updateConfig(patch) {
            const nextConfig = { ...currentConfig };
            for (const key of OPTIONAL_RUNTIME_STRING_KEYS) {
                if (!(key in patch)) {
                    continue;
                }
                const raw = patch[key];
                if (raw === undefined || raw.trim() === '') {
                    delete nextConfig[key];
                }
                else {
                    nextConfig[key] = raw.trim();
                }
            }
            if ('authMethod' in patch && patch.authMethod !== undefined) {
                if (!VALID_AUTH_METHODS.has(patch.authMethod)) {
                    throw new AntigravityAcpError(`Unsupported authMethod: ${String(patch.authMethod)}`, 'INVALID_REQUEST');
                }
                nextConfig.authMethod = patch.authMethod;
            }
            if (patch.autoDownload !== undefined)
                nextConfig.autoDownload = patch.autoDownload;
            if (patch.extraArgs !== undefined)
                nextConfig.extraArgs = [...patch.extraArgs];
            if (patch.maxConcurrentSessions !== undefined) {
                nextConfig.maxConcurrentSessions = patch.maxConcurrentSessions;
            }
            if (patch.queueTimeoutMs !== undefined)
                nextConfig.queueTimeoutMs = patch.queueTimeoutMs;
            if (patch.handshakeTimeoutMs !== undefined) {
                nextConfig.handshakeTimeoutMs = patch.handshakeTimeoutMs;
            }
            if (patch.requestTimeoutMs !== undefined)
                nextConfig.requestTimeoutMs = patch.requestTimeoutMs;
            if (patch.authTimeoutMs !== undefined)
                nextConfig.authTimeoutMs = patch.authTimeoutMs;
            if (patch.promptTimeoutMs !== undefined)
                nextConfig.promptTimeoutMs = patch.promptTimeoutMs;
            if (patch.idleRecycleMs !== undefined)
                nextConfig.idleRecycleMs = patch.idleRecycleMs;
            if (patch.autoWarmup !== undefined)
                nextConfig.autoWarmup = patch.autoWarmup;
            if (nextConfig.proxyUrl?.trim()) {
                validateProxyUrl(nextConfig.proxyUrl);
            }
            currentConfig = nextConfig;
            configEpoch += 1;
            installer = buildInstaller(currentConfig);
            cachedModels = undefined;
            lastQuota = undefined;
            inflightDiscovery = undefined;
            const oldPool = pool;
            if (!disposed) {
                pool = createPool();
            }
            await oldPool.dispose();
            notifyChanged();
            return currentConfig;
        },
        onRuntimeChanged(listener) {
            changeListeners.add(listener);
            return () => {
                changeListeners.delete(listener);
            };
        },
        async dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            disposeController.abort();
            cachedModels = undefined;
            changeListeners.clear();
            await pool.dispose();
        },
    };
    return service;
}
/**
 * Cordis plugin providing the shared `ctx.antigravityRuntime` service.
 * Named exports only (DSH Cordis loader requirement).
 */
export function apply(ctx, config) {
    const logger = ctx.logger(name);
    const profileDir = resolveProfilePaths(config).profileDir;
    const uiOverrides = loadUiOverrides(profileDir);
    const effectiveConfig = mergeRuntimeConfigWithOverrides(config, uiOverrides);
    const service = createAntigravityRuntimeService(ctx.subprocess, effectiveConfig, { logger });
    ctx.provide('antigravityRuntime', service);
    ctx.inject(['typert'], (typertCtx) => {
        registerAntigravityControlRemote(typertCtx, service, { logger });
    });
    const warmupController = new AbortController();
    if (effectiveConfig.autoWarmup) {
        void service.warmup(warmupController.signal).catch((error) => {
            if (warmupController.signal.aborted) {
                return;
            }
            const message = error instanceof Error ? redactSensitiveText(error.message) : String(error);
            logger.warn(`antigravity autoWarmup failed: ${message}`);
        });
    }
    ctx.effect(() => async () => {
        warmupController.abort();
        await service.dispose();
    }, `${name}.lifecycle`);
}
// Re-export shared taxonomy, config schemas, contracts, and core helpers via named exports.
export { AntigravityAcpError, redactSensitiveText, toLlmError, } from './shared/errors.js';
export { AuthMethodSchema, LlmPluginConfigSchema, PermissionFallbackSchema, PermissionModeSchema, RuntimeConfigSchema, SubagentPluginConfigSchema, } from './shared/config.js';
export { DEFAULT_PLUGIN_BRANCH, DEFAULT_PLUGIN_GITHUB_API_BASE, DEFAULT_PLUGIN_PACKAGE_NAME, DEFAULT_PLUGIN_RAW_BASE, DEFAULT_PLUGIN_REPO_NAME, DEFAULT_PLUGIN_REPO_OWNER, applyPluginUpdate, checkPluginUpdate, extractInstalledCommitFromLockfile, inferDshProfileDir, parseGitHubRepoUrl, readInstalledPluginInfo, readInstalledPluginManifestSync, validatePluginUpdateSpec, } from './runtime/updater.js';
export { ANTIGRAVITY_CONTROL_INVOCATIONS, ANTIGRAVITY_CONTROL_NAMESPACE, ANTIGRAVITY_CONTROL_PACKAGE, ANTIGRAVITY_CONTROL_SERVICE_KEY, AntigravityControlService, registerAntigravityControlRemote, sanitizeControlError, stripUndefinedJson, } from './remote/control-remote.js';
export { UI_CONFIG_FILENAME, UI_SECRETS_FILENAME, loadUiOverrides, mergeRuntimeConfigWithOverrides, saveUiOverrides, } from './remote/ui-store.js';
export { ANTIGRAVITY_CLI_MANIFEST_BASE, MINIMUM_AGY_VERSION, antigravityCliTarget, compareSemver, parseAntigravityCliRelease, tryParseSemver, } from './runtime/release.js';
export { AntigravityInstaller, createAntigravityInstaller, } from './runtime/installer.js';
export { ANTIGRAVITY_AUTH_BROWSER_MARKER, ANTIGRAVITY_AUTH_STDOUT_PREFIX, buildAcpSpawnArgs, buildAntigravityEnvironment, prepareAntigravityProfile, removedEnvironmentKeys, resolveDefaultProfileDir, resolveProfilePaths, resolveProfileSnapshot, validateAuthConfig, validateLoginResponse, validateProxyUrl, parseAntigravityAuthorizationUrl, } from './runtime/profile.js';
export { checkProfileAuth, clearProfileAuth, runCodeLogin, runLoopbackLogin, } from './runtime/auth.js';
export { probeAntigravityQuota } from './runtime/quota.js';
export { spawnAcpClient } from './acp/client.js';
export { AcpWorkerPool, } from './acp/pool.js';
export { antigravityAppendsSystemPrompt, antigravityClientInfo, antigravitySessionMeta, antigravitySessionMode, antigravityToolOutlivesPrompt, isMcpToolCallMeta, isSignInRequiredError, normalizeStopReasonToLlm, parseModelsAndThinking, selectPermissionOption, } from './acp/protocol.js';
//# sourceMappingURL=index.js.map