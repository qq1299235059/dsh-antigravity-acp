import crypto from 'node:crypto';
import { RemoteError, TypertRemoteService, } from '@deepseek-ai/dsh-typert-protocol';
import { validateAuthConfig, validateProxyUrl } from '../runtime/profile.js';
import { compareSemver, tryParseSemver } from '../runtime/release.js';
import { applyPluginUpdate, checkPluginUpdate, readInstalledPluginInfo, readInstalledPluginManifestSync, validatePluginUpdateSpec, } from '../runtime/updater.js';
import { AntigravityAcpError, redactSensitiveText } from '../shared/errors.js';
import { loadSubagentUiOverrides, saveSubagentUiOverrides, saveUiOverrides, } from './ui-store.js';
export const ANTIGRAVITY_CONTROL_PACKAGE = 'dsh-antigravity-acp';
export const ANTIGRAVITY_CONTROL_SERVICE_KEY = 'antigravityControl';
export const ANTIGRAVITY_CONTROL_NAMESPACE = 'antigravityControl';
const ACCOUNTS_GOOGLE_URL_GLOBAL_RE = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/gi;
const VALID_AUTH_METHODS = new Set([
    'oauth-personal',
    'oauth-business',
    'gemini-api-key',
    'agent-platform',
]);
const VALID_PERMISSION_MODES = new Set([
    'default',
    'auto_edit',
    'auto',
    'yolo',
]);
const VALID_PERMISSION_FALLBACKS = new Set([
    'reject',
    'cancel',
]);
const VALID_AUTH_MODES = new Set(['code', 'loopback']);
function isPlainRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
function badRequest(message) {
    return new RemoteError('gateway/bad-request', message, {});
}
/**
 * Recursively omit `undefined` properties and non-finite numbers so returned payloads satisfy
 * `dsh-api-gateway`'s strict `assertJsonValue` wire invariant.
 */
export function stripUndefinedJson(value) {
    const visit = (current) => {
        if (current === undefined) {
            return undefined;
        }
        if (current === null || typeof current === 'string' || typeof current === 'boolean') {
            return current;
        }
        if (typeof current === 'number') {
            if (!Number.isFinite(current)) {
                return undefined;
            }
            return Object.is(current, -0) ? 0 : current;
        }
        if (typeof current !== 'object') {
            return undefined;
        }
        if (Array.isArray(current)) {
            const items = [];
            for (const entry of current) {
                const cleaned = visit(entry);
                if (cleaned !== undefined) {
                    items.push(cleaned);
                }
            }
            return items;
        }
        const out = {};
        for (const [key, entry] of Object.entries(current)) {
            const cleaned = visit(entry);
            if (cleaned !== undefined) {
                out[key] = cleaned;
            }
        }
        return out;
    };
    return visit(value);
}
/**
 * Sanitize diagnostic text before surfacing it over RPC by scrubbing credentials,
 * proxy userinfo, Google OAuth URLs, and any known active secret literals.
 */
export function sanitizeControlError(error, extraSecrets = []) {
    let raw = error instanceof Error
        ? error.message || error.name || 'Unknown error'
        : typeof error === 'string'
            ? error
            : String(error ?? 'Unknown error');
    for (const secret of extraSecrets) {
        if (secret && secret.length >= 4) {
            raw = raw.split(secret).join('[REDACTED]');
        }
    }
    const redacted = redactSensitiveText(raw)
        .replace(ACCOUNTS_GOOGLE_URL_GLOBAL_RE, '[REDACTED_AUTH_URL]')
        .trim();
    return redacted || 'Unknown error';
}
function assertOptionalString(record, field) {
    if (!Object.hasOwn(record, field) || record[field] === undefined) {
        return undefined;
    }
    const value = record[field];
    if (typeof value !== 'string') {
        throw badRequest(`Field "${field}" must be a string`);
    }
    return value;
}
function assertOptionalBoolean(record, field) {
    if (!Object.hasOwn(record, field) || record[field] === undefined) {
        return undefined;
    }
    const value = record[field];
    if (typeof value !== 'boolean') {
        throw badRequest(`Field "${field}" must be a boolean`);
    }
    return value;
}
function parseInstallInput(value) {
    if (value === undefined) {
        return undefined;
    }
    if (!isPlainRecord(value)) {
        throw badRequest('installCli input must be a plain object');
    }
    const clearBinaryPath = assertOptionalBoolean(value, 'clearBinaryPath');
    return clearBinaryPath !== undefined ? { clearBinaryPath } : {};
}
function parseSaveConfigInput(value) {
    if (!isPlainRecord(value)) {
        throw badRequest('saveConfig input must be a plain object');
    }
    const binaryPath = assertOptionalString(value, 'binaryPath');
    const autoDownload = assertOptionalBoolean(value, 'autoDownload');
    const gcpProject = assertOptionalString(value, 'gcpProject');
    const gcpLocation = assertOptionalString(value, 'gcpLocation');
    const proxyUrl = assertOptionalString(value, 'proxyUrl');
    const proxyBypass = assertOptionalString(value, 'proxyBypass');
    const apiKey = assertOptionalString(value, 'apiKey');
    const clearApiKey = assertOptionalBoolean(value, 'clearApiKey');
    let authMethod;
    if (Object.hasOwn(value, 'authMethod') && value['authMethod'] !== undefined) {
        const rawMethod = value['authMethod'];
        if (typeof rawMethod !== 'string' ||
            !VALID_AUTH_METHODS.has(rawMethod)) {
            throw badRequest('authMethod must be one of oauth-personal, oauth-business, gemini-api-key, agent-platform');
        }
        authMethod = rawMethod;
    }
    if (proxyUrl !== undefined && proxyUrl.trim() !== '') {
        try {
            validateProxyUrl(proxyUrl.trim());
        }
        catch (error) {
            throw badRequest(sanitizeControlError(error));
        }
    }
    return stripUndefinedJson({
        ...(binaryPath !== undefined ? { binaryPath } : {}),
        ...(autoDownload !== undefined ? { autoDownload } : {}),
        ...(authMethod !== undefined ? { authMethod } : {}),
        ...(gcpProject !== undefined ? { gcpProject } : {}),
        ...(gcpLocation !== undefined ? { gcpLocation } : {}),
        ...(proxyUrl !== undefined ? { proxyUrl } : {}),
        ...(proxyBypass !== undefined ? { proxyBypass } : {}),
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(clearApiKey !== undefined ? { clearApiKey } : {}),
    });
}
function parseSaveSubagentConfigInput(value) {
    if (!isPlainRecord(value)) {
        throw badRequest('saveSubagentConfig input must be a plain object');
    }
    const defaultModel = assertOptionalString(value, 'defaultModel');
    const defaultThoughtLevel = assertOptionalString(value, 'defaultThoughtLevel');
    const systemPromptAppend = assertOptionalString(value, 'systemPromptAppend');
    let permissionMode;
    if (Object.hasOwn(value, 'permissionMode') && value['permissionMode'] !== undefined) {
        const rawMode = value['permissionMode'];
        if (typeof rawMode !== 'string' ||
            !VALID_PERMISSION_MODES.has(rawMode)) {
            throw badRequest('permissionMode must be one of default, auto_edit, auto, yolo');
        }
        permissionMode = rawMode;
    }
    let permissionFallback;
    if (Object.hasOwn(value, 'permissionFallback') && value['permissionFallback'] !== undefined) {
        const rawFallback = value['permissionFallback'];
        if (typeof rawFallback !== 'string' ||
            !VALID_PERMISSION_FALLBACKS.has(rawFallback)) {
            throw badRequest('permissionFallback must be one of reject, cancel');
        }
        permissionFallback = rawFallback;
    }
    return stripUndefinedJson({
        ...(defaultModel !== undefined ? { defaultModel } : {}),
        ...(defaultThoughtLevel !== undefined ? { defaultThoughtLevel } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
        ...(permissionFallback !== undefined ? { permissionFallback } : {}),
        ...(systemPromptAppend !== undefined ? { systemPromptAppend } : {}),
    });
}
function parseAuthStartInput(value) {
    if (value === undefined) {
        return undefined;
    }
    if (!isPlainRecord(value)) {
        throw badRequest('authStart input must be a plain object');
    }
    let mode;
    if (Object.hasOwn(value, 'mode') && value['mode'] !== undefined) {
        const rawMode = value['mode'];
        if (typeof rawMode !== 'string' || !VALID_AUTH_MODES.has(rawMode)) {
            throw badRequest('mode must be "code" or "loopback"');
        }
        mode = rawMode;
    }
    let authMethod;
    if (Object.hasOwn(value, 'authMethod') && value['authMethod'] !== undefined) {
        const rawMethod = value['authMethod'];
        if (typeof rawMethod !== 'string' ||
            !VALID_AUTH_METHODS.has(rawMethod)) {
            throw badRequest('authMethod must be one of oauth-personal, oauth-business, gemini-api-key, agent-platform');
        }
        authMethod = rawMethod;
    }
    const apiKey = assertOptionalString(value, 'apiKey');
    const gcpProject = assertOptionalString(value, 'gcpProject');
    const gcpLocation = assertOptionalString(value, 'gcpLocation');
    return stripUndefinedJson({
        ...(mode !== undefined ? { mode } : {}),
        ...(authMethod !== undefined ? { authMethod } : {}),
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(gcpProject !== undefined ? { gcpProject } : {}),
        ...(gcpLocation !== undefined ? { gcpLocation } : {}),
    });
}
function parseAuthSubmitCodeInput(value) {
    if (!isPlainRecord(value)) {
        throw badRequest('authSubmitCode input must be a plain object');
    }
    const code = assertOptionalString(value, 'code');
    if (!code || code.trim().length === 0) {
        throw badRequest('Authorization code must be a non-empty string');
    }
    return { code: code.trim() };
}
function parseUpdatePluginInput(value) {
    if (value === undefined) {
        return undefined;
    }
    if (!isPlainRecord(value)) {
        throw badRequest('updatePlugin input must be a plain object');
    }
    const targetSpec = assertOptionalString(value, 'targetSpec');
    const force = assertOptionalBoolean(value, 'force');
    if (targetSpec !== undefined && targetSpec.trim() === '') {
        throw badRequest('Field "targetSpec" must not be empty');
    }
    return stripUndefinedJson({
        ...(targetSpec !== undefined ? { targetSpec: targetSpec.trim() } : {}),
        ...(force !== undefined ? { force } : {}),
    });
}
function parseStatusResult(value) {
    if (!isPlainRecord(value)) {
        throw badRequest('Control status snapshot must be a plain object');
    }
    return value;
}
const CONTROL_STATUS_RESULT_CODEC = {
    mode: 'strict',
    typeSymbol: 'dsh-antigravity-acp#ControlStatus',
    create: () => ({
        parse: parseStatusResult,
    }),
};
function makeInputCodec(typeSymbol, parser) {
    return {
        mode: 'strict',
        typeSymbol,
        create: () => ({
            parse: parser,
        }),
    };
}
function makeDirectDescriptor(method, inputCodec) {
    return {
        id: `${ANTIGRAVITY_CONTROL_PACKAGE}#${ANTIGRAVITY_CONTROL_NAMESPACE}/${method}`,
        service: ANTIGRAVITY_CONTROL_SERVICE_KEY,
        namespace: ANTIGRAVITY_CONTROL_NAMESPACE,
        method,
        invocation: { kind: 'direct' },
        parameters: inputCodec
            ? [
                {
                    name: 'input',
                    wire: 'input',
                    source: 'json',
                    acceptsUndefined: true,
                    codec: inputCodec,
                },
            ]
            : [],
        result: CONTROL_STATUS_RESULT_CODEC,
    };
}
/** Strict Typert invocation descriptors matching the browser UI client verbatim. */
export const ANTIGRAVITY_CONTROL_INVOCATIONS = [
    makeDirectDescriptor('status'),
    makeDirectDescriptor('installCli', makeInputCodec('dsh-antigravity-acp#ControlInstallInput', parseInstallInput)),
    makeDirectDescriptor('installCancel'),
    makeDirectDescriptor('saveConfig', makeInputCodec('dsh-antigravity-acp#ControlSaveConfigInput', parseSaveConfigInput)),
    makeDirectDescriptor('saveSubagentConfig', makeInputCodec('dsh-antigravity-acp#ControlSaveSubagentConfigInput', parseSaveSubagentConfigInput)),
    makeDirectDescriptor('authStart', makeInputCodec('dsh-antigravity-acp#ControlAuthStartInput', parseAuthStartInput)),
    makeDirectDescriptor('authSubmitCode', makeInputCodec('dsh-antigravity-acp#ControlAuthSubmitCodeInput', parseAuthSubmitCodeInput)),
    makeDirectDescriptor('authCancel'),
    makeDirectDescriptor('logout'),
    makeDirectDescriptor('refreshModels'),
    makeDirectDescriptor('refreshQuota'),
    makeDirectDescriptor('checkUpdate'),
    makeDirectDescriptor('updatePlugin', makeInputCodec('dsh-antigravity-acp#ControlUpdatePluginInput', parseUpdatePluginInput)),
    makeDirectDescriptor('cancelPluginUpdate'),
];
function mapDiscoveredModels(models) {
    return models.map((model) => ({
        id: model.id,
        name: model.name,
        ...(model.description !== undefined ? { description: model.description } : {}),
        ...(model.isDefault !== undefined ? { isDefault: model.isDefault } : {}),
        ...(model.defaultThoughtLevel !== undefined
            ? { defaultThoughtLevel: model.defaultThoughtLevel }
            : {}),
        ...(model.thinkingOptions !== undefined
            ? {
                thinkingOptions: model.thinkingOptions.map((opt) => ({
                    id: opt.id,
                    name: opt.name,
                })),
            }
            : {}),
    }));
}
function mapQuotaWindow(window) {
    return {
        id: window.id,
        ...(window.label !== undefined ? { label: window.label } : {}),
        ...(window.remainingFraction !== undefined
            ? { remainingFraction: window.remainingFraction }
            : {}),
        ...(window.usedFraction !== undefined ? { usedFraction: window.usedFraction } : {}),
        ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
        ...(window.resetInSeconds !== undefined ? { resetInSeconds: window.resetInSeconds } : {}),
        ...(window.limit !== undefined ? { limit: window.limit } : {}),
        ...(window.remaining !== undefined ? { remaining: window.remaining } : {}),
        ...(window.unit !== undefined ? { unit: window.unit } : {}),
    };
}
function mapQuotaForControl(quota) {
    return {
        capturedAt: quota.capturedAt,
        ...(quota.account !== undefined ? { account: quota.account } : {}),
        ...(quota.tier !== undefined ? { tier: quota.tier } : {}),
        exhausted: quota.exhausted,
        windows: quota.windows.map(mapQuotaWindow),
    };
}
function buildRuntimeConfigPatchFromSaveInput(input) {
    const patch = {};
    if (input.binaryPath !== undefined) {
        patch.binaryPath = input.binaryPath.trim() || undefined;
    }
    if (input.autoDownload !== undefined) {
        patch.autoDownload = input.autoDownload;
    }
    if (input.authMethod !== undefined) {
        patch.authMethod = input.authMethod;
    }
    if (input.gcpProject !== undefined) {
        patch.gcpProject = input.gcpProject.trim() || undefined;
    }
    if (input.gcpLocation !== undefined) {
        patch.gcpLocation = input.gcpLocation.trim() || undefined;
    }
    if (input.proxyUrl !== undefined) {
        patch.proxyUrl = input.proxyUrl.trim() || undefined;
    }
    if (input.proxyBypass !== undefined) {
        patch.proxyBypass = input.proxyBypass.trim() || undefined;
    }
    if (input.clearApiKey === true) {
        patch.apiKey = undefined;
    }
    else if (input.apiKey !== undefined && input.apiKey.trim() !== '') {
        patch.apiKey = input.apiKey.trim();
    }
    return patch;
}
function toggleGithubSpecFormat(spec, owner, repo) {
    const fragmentMatch = /(#.+)$/.exec(spec);
    const fragment = fragmentMatch ? fragmentMatch[1] : '';
    if (/^github:/i.test(spec)) {
        return `https://github.com/${owner}/${repo}.git${fragment}`;
    }
    return `github:${owner}/${repo}${fragment}`;
}
function buildUpdateCheckMessage(result) {
    const shortCommit = result.latestCommit ? ` (${result.latestCommit.slice(0, 7)})` : '';
    if (result.reason === 'newer-version') {
        return `New version available: v${result.latestVersion ?? 'unknown'}${shortCommit}`;
    }
    if (result.reason === 'newer-commit') {
        return `New commit available on ${result.branch}${shortCommit}`;
    }
    if (result.reason === 'ahead') {
        return `Local v${result.currentVersion} is ahead of ${result.branch}${result.latestVersion ? ` (v${result.latestVersion})` : ''}`;
    }
    return `Plugin v${result.currentVersion} is up to date${shortCommit}`;
}
/**
 * Cordis Typert Remote service exposing Antigravity runtime control, installation,
 * OAuth/API-key authentication, model discovery, quota probing, and plugin self-updates to the DSH UI.
 *
 * NOTE: Uses TypeScript `private` fields only (never ES `#private`), because Cordis
 * wraps service instances in `Proxy` objects when resolving `ctx.get('antigravityControl')`.
 */
export class AntigravityControlService extends TypertRemoteService {
    runtime;
    logger;
    env;
    platform;
    arch;
    musl;
    profileDirOverride;
    dshProfileDirOverride;
    packageRootDir;
    pluginManagerOverride;
    fetchImpl;
    githubApiBase;
    rawGithubBase;
    cliManifestBaseUrl;
    installState = {
        phase: 'idle',
        message: '',
    };
    installAbort = null;
    authState = {
        phase: 'idle',
        message: '',
    };
    authAbort = null;
    pendingCodeDeferred = null;
    pluginUpdateState;
    lastCheckResult = null;
    updateCheckAbort = null;
    updateCheckTask = null;
    activeUpdateRequestId = null;
    activeUpdateTask = null;
    models = [];
    modelsError = undefined;
    lastQuota = undefined;
    quotaError = undefined;
    disposed = false;
    constructor(ctx, runtime, options = {}) {
        super(ctx, ANTIGRAVITY_CONTROL_SERVICE_KEY);
        this.runtime = runtime;
        this.logger = options.logger;
        this.env = options.env ?? process.env;
        this.platform = options.platform ?? process.platform;
        this.arch = options.arch ?? process.arch;
        this.musl = options.musl;
        this.profileDirOverride = options.profileDir;
        this.dshProfileDirOverride = options.dshProfileDir;
        this.packageRootDir = options.packageRootDir;
        this.pluginManagerOverride = options.pluginManager;
        this.fetchImpl = options.fetch;
        this.githubApiBase = options.githubApiBase;
        this.rawGithubBase = options.rawGithubBase;
        this.cliManifestBaseUrl = options.cliManifestBaseUrl;
        const initialManifest = readInstalledPluginManifestSync(this.packageRootDir);
        this.pluginUpdateState = {
            packageName: initialManifest.packageName,
            currentVersion: initialManifest.currentVersion,
            repoUrl: initialManifest.repoUrl,
            updateAvailable: false,
            reason: 'unchecked',
            canAutoUpdate: typeof this.resolvePluginManager()?.installBundle === 'function',
            phase: 'idle',
            restartRequired: false,
            message: '',
        };
    }
    resolveProfileDir() {
        return this.profileDirOverride ?? this.runtime.resolveProfile().profileDir;
    }
    resolvePluginManager() {
        if (this.pluginManagerOverride) {
            return this.pluginManagerOverride;
        }
        try {
            const pm = this.ctx?.get?.('pluginManager');
            if (pm && typeof pm === 'object') {
                return pm;
            }
        }
        catch {
            // pluginManager unavailable in headless or minimal Cordis context
        }
        return undefined;
    }
    resolveDshProfileDir() {
        if (this.dshProfileDirOverride) {
            return this.dshProfileDirOverride;
        }
        try {
            const profileCtx = this.ctx?.get?.('profileContext');
            if (profileCtx && typeof profileCtx.dir === 'string' && profileCtx.dir.trim()) {
                return profileCtx.dir.trim();
            }
        }
        catch {
            // profileContext unavailable in headless or minimal Cordis context
        }
        return undefined;
    }
    activeSecrets(extra) {
        const secrets = [];
        if (this.runtime.config.apiKey) {
            secrets.push(this.runtime.config.apiKey);
        }
        if (extra && extra.trim()) {
            secrets.push(extra.trim());
        }
        return secrets;
    }
    buildAuthSnapshot() {
        const includeAuthUrl = this.authState.phase === 'awaiting_code' || this.authState.phase === 'awaiting_browser';
        return {
            phase: this.authState.phase,
            ...(this.authState.mode !== undefined ? { mode: this.authState.mode } : {}),
            ...(includeAuthUrl && this.authState.authUrl !== undefined
                ? { authUrl: this.authState.authUrl }
                : {}),
            message: this.authState.message,
            ...(this.authState.startedAt !== undefined ? { startedAt: this.authState.startedAt } : {}),
            ...(this.authState.finishedAt !== undefined
                ? { finishedAt: this.authState.finishedAt }
                : {}),
            ...(this.authState.error !== undefined ? { error: this.authState.error } : {}),
        };
    }
    async readLocalPluginInfoSafe() {
        try {
            return await readInstalledPluginInfo({
                packageRootDir: this.packageRootDir,
                dshProfileDir: this.resolveDshProfileDir(),
                pluginManager: this.resolvePluginManager(),
            });
        }
        catch {
            return undefined;
        }
    }
    formatPluginUpdateSnapshot(localInfo, cliInstalledVersion) {
        const pluginManager = this.resolvePluginManager();
        const base = this.pluginUpdateState;
        const canAutoUpdate = localInfo?.canAutoUpdate ?? typeof pluginManager?.installBundle === 'function';
        let cliUpdateAvailable = base.cliUpdateAvailable;
        if (base.cliLatestVersion !== undefined &&
            cliInstalledVersion !== undefined &&
            tryParseSemver(cliInstalledVersion) !== null) {
            cliUpdateAvailable = compareSemver(base.cliLatestVersion, cliInstalledVersion) > 0;
        }
        return {
            packageName: localInfo?.packageName ?? base.packageName,
            currentVersion: localInfo?.currentVersion ?? base.currentVersion,
            ...((localInfo?.currentCommit ?? base.currentCommit) !== undefined
                ? { currentCommit: localInfo?.currentCommit ?? base.currentCommit }
                : {}),
            ...((localInfo?.installedSpec ?? base.installedSpec) !== undefined
                ? { installedSpec: localInfo?.installedSpec ?? base.installedSpec }
                : {}),
            repoUrl: localInfo?.repoUrl ?? base.repoUrl,
            ...(base.latestVersion !== undefined ? { latestVersion: base.latestVersion } : {}),
            ...(base.latestCommit !== undefined ? { latestCommit: base.latestCommit } : {}),
            ...(base.latestMessage !== undefined ? { latestMessage: base.latestMessage } : {}),
            ...(base.latestDate !== undefined ? { latestDate: base.latestDate } : {}),
            ...(base.commitUrl !== undefined ? { commitUrl: base.commitUrl } : {}),
            ...(base.installSpec !== undefined ? { installSpec: base.installSpec } : {}),
            updateAvailable: base.updateAvailable,
            reason: base.reason,
            canAutoUpdate,
            ...(base.cliLatestVersion !== undefined ? { cliLatestVersion: base.cliLatestVersion } : {}),
            ...(cliUpdateAvailable !== undefined ? { cliUpdateAvailable } : {}),
            phase: base.phase,
            restartRequired: base.restartRequired,
            ...(base.restartReason !== undefined ? { restartReason: base.restartReason } : {}),
            message: base.message,
            ...(base.checkedAt !== undefined ? { checkedAt: base.checkedAt } : {}),
            ...(base.startedAt !== undefined ? { startedAt: base.startedAt } : {}),
            ...(base.finishedAt !== undefined ? { finishedAt: base.finishedAt } : {}),
            ...(base.error !== undefined ? { error: base.error } : {}),
        };
    }
    cancelActiveAuthInternal(reasonMessage, nextPhase) {
        const abort = this.authAbort;
        const deferred = this.pendingCodeDeferred;
        const previousMode = this.authState.mode;
        const previousStartedAt = this.authState.startedAt;
        this.authAbort = null;
        this.pendingCodeDeferred = null;
        if (nextPhase === 'idle') {
            this.authState = {
                phase: 'idle',
                message: '',
            };
        }
        else {
            this.authState = {
                phase: 'cancelled',
                ...(previousMode !== undefined ? { mode: previousMode } : {}),
                message: reasonMessage,
                ...(previousStartedAt !== undefined ? { startedAt: previousStartedAt } : {}),
                finishedAt: new Date().toISOString(),
            };
        }
        deferred?.reject(new AntigravityAcpError(reasonMessage, 'ABORTED'));
        abort?.abort(new AntigravityAcpError(reasonMessage, 'ABORTED'));
    }
    buildSubagentSnapshot() {
        const base = this.runtime.getSubagentDefaults?.() ?? {
            providerName: 'antigravity',
            toolName: 'antigravity_agent',
            permissionMode: 'default',
            permissionFallback: 'reject',
        };
        const overrides = this.runtime.getSubagentConfig?.() ??
            loadSubagentUiOverrides(this.resolveProfileDir(), this.platform);
        return {
            providerName: base.providerName || 'antigravity',
            toolName: base.toolName || 'antigravity_agent',
            defaultModel: overrides.defaultModel ?? base.defaultModel ?? '',
            defaultThoughtLevel: overrides.defaultThoughtLevel ?? base.defaultThoughtLevel ?? '',
            permissionMode: overrides.permissionMode ?? base.permissionMode,
            permissionFallback: overrides.permissionFallback ?? base.permissionFallback,
            systemPromptAppend: overrides.systemPromptAppend ?? base.systemPromptAppend ?? '',
        };
    }
    async status() {
        const localInfo = await this.readLocalPluginInfoSafe();
        const snap = await this.runtime.getStatus();
        const cfg = this.runtime.config;
        const effectiveQuota = snap.lastQuota ?? this.lastQuota;
        const pluginUpdate = this.formatPluginUpdateSnapshot(localInfo, snap.executable?.version);
        const snapshot = {
            installed: snap.installed,
            ...(snap.executable
                ? {
                    executable: {
                        command: snap.executable.command,
                        source: snap.executable.source,
                        ...(snap.executable.version !== undefined
                            ? { version: snap.executable.version }
                            : {}),
                        ...(snap.executable.cacheDir !== undefined
                            ? { cacheDir: snap.executable.cacheDir }
                            : {}),
                    },
                }
                : {}),
            profile: {
                profileDir: snap.profile.profileDir,
                authMethod: snap.profile.authMethod,
                authenticated: snap.profile.authenticated,
                ...(snap.profile.account !== undefined ? { account: snap.profile.account } : {}),
                ...(snap.profile.gcpProject !== undefined
                    ? { gcpProject: snap.profile.gcpProject }
                    : {}),
                ...(snap.profile.gcpLocation !== undefined
                    ? { gcpLocation: snap.profile.gcpLocation }
                    : {}),
                hasApiKey: snap.profile.hasApiKey,
            },
            config: {
                binaryPath: cfg.binaryPath ?? '',
                autoDownload: cfg.autoDownload,
                authMethod: cfg.authMethod,
                gcpProject: cfg.gcpProject ?? '',
                gcpLocation: cfg.gcpLocation ?? '',
                proxyUrl: cfg.proxyUrl ?? '',
                proxyBypass: cfg.proxyBypass ?? '',
                hasApiKey: snap.profile.hasApiKey,
            },
            subagent: this.buildSubagentSnapshot(),
            pool: {
                activeLeases: snap.activeLeases,
                idleWorkers: snap.idleWorkers,
                maxConcurrentSessions: snap.maxConcurrentSessions,
            },
            install: {
                phase: this.installState.phase,
                message: this.installState.message,
                ...(this.installState.startedAt !== undefined
                    ? { startedAt: this.installState.startedAt }
                    : {}),
                ...(this.installState.finishedAt !== undefined
                    ? { finishedAt: this.installState.finishedAt }
                    : {}),
                ...(this.installState.error !== undefined ? { error: this.installState.error } : {}),
            },
            auth: this.buildAuthSnapshot(),
            pluginUpdate,
            models: this.models.map((m) => ({
                id: m.id,
                name: m.name,
                ...(m.description !== undefined ? { description: m.description } : {}),
                ...(m.isDefault !== undefined ? { isDefault: m.isDefault } : {}),
                ...(m.defaultThoughtLevel !== undefined
                    ? { defaultThoughtLevel: m.defaultThoughtLevel }
                    : {}),
                ...(m.thinkingOptions !== undefined
                    ? {
                        thinkingOptions: m.thinkingOptions.map((opt) => ({
                            id: opt.id,
                            name: opt.name,
                        })),
                    }
                    : {}),
            })),
            ...(this.modelsError !== undefined ? { modelsError: this.modelsError } : {}),
            ...(effectiveQuota !== undefined ? { quota: mapQuotaForControl(effectiveQuota) } : {}),
            ...(this.quotaError !== undefined ? { quotaError: this.quotaError } : {}),
            updatedAt: new Date().toISOString(),
        };
        return stripUndefinedJson(snapshot);
    }
    async installCli(input) {
        const parsed = parseInstallInput(input);
        if (this.disposed) {
            throw badRequest('Antigravity control service has been disposed');
        }
        if (this.installAbort !== null) {
            return await this.status();
        }
        if (parsed?.clearBinaryPath === true && this.runtime.config.binaryPath) {
            await saveUiOverrides(this.resolveProfileDir(), { binaryPath: '' }, this.platform);
            await this.runtime.updateConfig?.({ binaryPath: undefined });
        }
        const abort = new AbortController();
        this.installAbort = abort;
        const startedAt = new Date().toISOString();
        this.installState = {
            phase: 'running',
            message: 'Starting Antigravity CLI installation...',
            startedAt,
        };
        const runInstall = async () => {
            try {
                const onProgress = (message) => {
                    if (this.installAbort !== abort || abort.signal.aborted || this.disposed) {
                        return;
                    }
                    this.installState = {
                        phase: 'running',
                        message: sanitizeControlError(message, this.activeSecrets()),
                        startedAt,
                    };
                };
                const exe = this.runtime.installManaged
                    ? await this.runtime.installManaged({ signal: abort.signal, onProgress })
                    : await this.runtime.ensureInstalled(abort.signal);
                if (this.installAbort !== abort || this.disposed) {
                    return;
                }
                this.installState = {
                    phase: 'succeeded',
                    message: exe.version
                        ? `Antigravity CLI ${exe.version} installed (${exe.command})`
                        : `Antigravity CLI installed (${exe.command})`,
                    startedAt,
                    finishedAt: new Date().toISOString(),
                };
            }
            catch (error) {
                if (this.installAbort !== abort || this.disposed) {
                    return;
                }
                const isAborted = abort.signal.aborted ||
                    (error instanceof AntigravityAcpError && error.code === 'ABORTED');
                const safeErr = sanitizeControlError(error, this.activeSecrets());
                this.installState = {
                    phase: isAborted ? 'cancelled' : 'failed',
                    message: isAborted ? 'Installation cancelled' : safeErr,
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    ...(!isAborted ? { error: safeErr } : {}),
                };
            }
            finally {
                if (this.installAbort === abort) {
                    this.installAbort = null;
                }
            }
        };
        const task = runInstall();
        // Allow fast synchronous/in-memory installs to report initial progress or finish cleanly without blocking slow downloads.
        await Promise.race([
            task,
            new Promise((resolve) => {
                const timer = setTimeout(resolve, 20);
                timer.unref?.();
            }),
        ]);
        return await this.status();
    }
    async installCancel() {
        if (this.installAbort !== null) {
            const abort = this.installAbort;
            const startedAt = this.installState.startedAt;
            this.installAbort = null;
            this.installState = {
                phase: 'cancelled',
                message: 'Installation cancelled',
                ...(startedAt !== undefined ? { startedAt } : {}),
                finishedAt: new Date().toISOString(),
            };
            abort.abort(new AntigravityAcpError('Installation cancelled', 'ABORTED'));
        }
        return await this.status();
    }
    async saveConfig(input) {
        const parsed = parseSaveConfigInput(input);
        const previousMethod = this.runtime.config.authMethod;
        await saveUiOverrides(this.resolveProfileDir(), parsed, this.platform);
        const runtimePatch = buildRuntimeConfigPatchFromSaveInput(parsed);
        await this.runtime.updateConfig?.(runtimePatch);
        if (parsed.clearApiKey === true ||
            parsed.apiKey !== undefined ||
            (parsed.authMethod !== undefined && parsed.authMethod !== previousMethod)) {
            this.modelsError = undefined;
            this.quotaError = undefined;
            if (parsed.authMethod !== undefined && parsed.authMethod !== previousMethod) {
                this.models = [];
                this.lastQuota = undefined;
            }
        }
        else {
            this.quotaError = undefined;
        }
        await this.runtime.checkAuth().catch((error) => {
            this.logger?.debug?.(`checkAuth after saveConfig failed: ${sanitizeControlError(error, this.activeSecrets())}`);
        });
        return await this.status();
    }
    async saveSubagentConfig(input) {
        const parsed = parseSaveSubagentConfigInput(input);
        const savedOverrides = await saveSubagentUiOverrides(this.resolveProfileDir(), parsed, this.platform);
        this.runtime.updateSubagentConfig?.(savedOverrides);
        return await this.status();
    }
    async authStart(input) {
        const parsed = parseAuthStartInput(input);
        if (this.disposed) {
            throw badRequest('Antigravity control service has been disposed');
        }
        if (this.authAbort !== null) {
            return await this.status();
        }
        const configSavePatch = {
            ...(parsed?.authMethod !== undefined ? { authMethod: parsed.authMethod } : {}),
            ...(parsed?.gcpProject !== undefined ? { gcpProject: parsed.gcpProject } : {}),
            ...(parsed?.gcpLocation !== undefined ? { gcpLocation: parsed.gcpLocation } : {}),
            ...(parsed?.apiKey !== undefined && parsed.apiKey.trim() !== ''
                ? { apiKey: parsed.apiKey.trim() }
                : {}),
        };
        const prospectiveConfig = { ...this.runtime.config };
        if (configSavePatch.authMethod !== undefined) {
            prospectiveConfig.authMethod = configSavePatch.authMethod;
        }
        if (configSavePatch.gcpProject !== undefined) {
            const trimmed = configSavePatch.gcpProject.trim();
            if (trimmed) {
                prospectiveConfig.gcpProject = trimmed;
            }
            else {
                delete prospectiveConfig.gcpProject;
            }
        }
        if (configSavePatch.gcpLocation !== undefined) {
            const trimmed = configSavePatch.gcpLocation.trim();
            if (trimmed) {
                prospectiveConfig.gcpLocation = trimmed;
            }
            else {
                delete prospectiveConfig.gcpLocation;
            }
        }
        if (configSavePatch.apiKey !== undefined) {
            prospectiveConfig.apiKey = configSavePatch.apiKey;
        }
        const effectiveMethod = prospectiveConfig.authMethod;
        if (effectiveMethod === 'oauth-business' && !prospectiveConfig.gcpProject?.trim()) {
            throw badRequest('oauth-business authentication requires gcpProject');
        }
        try {
            validateAuthConfig(prospectiveConfig, this.env, this.platform);
        }
        catch (error) {
            throw badRequest(sanitizeControlError(error, this.activeSecrets(parsed?.apiKey)));
        }
        if (Object.keys(configSavePatch).length > 0) {
            await saveUiOverrides(this.resolveProfileDir(), configSavePatch, this.platform);
            const runtimePatch = buildRuntimeConfigPatchFromSaveInput(configSavePatch);
            await this.runtime.updateConfig?.(runtimePatch);
        }
        const startedAt = new Date().toISOString();
        if (effectiveMethod === 'gemini-api-key' || effectiveMethod === 'agent-platform') {
            this.authState = {
                phase: 'starting',
                message: 'Validating API key authentication...',
                startedAt,
            };
            try {
                await this.runtime.login({
                    authMethod: effectiveMethod,
                    ...(configSavePatch.apiKey !== undefined ? { apiKey: configSavePatch.apiKey } : {}),
                });
                this.authState = {
                    phase: 'succeeded',
                    message: `Authenticated with ${effectiveMethod}`,
                    startedAt,
                    finishedAt: new Date().toISOString(),
                };
                this.modelsError = undefined;
                this.quotaError = undefined;
                if (!this.disposed) {
                    void this.refreshModels().catch(() => { });
                }
            }
            catch (error) {
                const safeErr = sanitizeControlError(error, this.activeSecrets(parsed?.apiKey));
                this.authState = {
                    phase: 'failed',
                    message: safeErr,
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    error: safeErr,
                };
            }
            return await this.status();
        }
        const requestedMode = parsed?.mode ?? 'code';
        const abort = new AbortController();
        this.authAbort = abort;
        let deferred = null;
        let codePromise;
        if (requestedMode === 'code') {
            let resolveCode;
            let rejectCode;
            codePromise = new Promise((resolve, reject) => {
                resolveCode = resolve;
                rejectCode = reject;
            });
            codePromise.catch(() => { });
            deferred = {
                settled: false,
                resolve: (code) => {
                    if (deferred && !deferred.settled) {
                        deferred.settled = true;
                        resolveCode(code);
                    }
                },
                reject: (error) => {
                    if (deferred && !deferred.settled) {
                        deferred.settled = true;
                        rejectCode(error);
                    }
                },
            };
            this.pendingCodeDeferred = deferred;
        }
        this.authState = {
            phase: 'starting',
            mode: requestedMode,
            message: requestedMode === 'code'
                ? 'Starting OAuth authorization code flow...'
                : 'Starting local loopback OAuth login...',
            startedAt,
        };
        let notifyFirstProgress;
        const firstProgressPromise = new Promise((resolve) => {
            notifyFirstProgress = resolve;
        });
        const runOAuth = async () => {
            try {
                await this.runtime.login({
                    authMethod: effectiveMethod,
                    mode: requestedMode,
                    onAuthUrl: (url, kind) => {
                        if (this.authAbort !== abort || abort.signal.aborted || this.disposed) {
                            return;
                        }
                        this.authState = {
                            phase: kind === 'code' ? 'awaiting_code' : 'awaiting_browser',
                            mode: kind,
                            authUrl: url,
                            message: kind === 'code'
                                ? 'Open the authorization link, complete sign-in, and submit the authorization code.'
                                : 'Complete sign-in in the browser window (or open the authorization link below).',
                            startedAt,
                        };
                        notifyFirstProgress();
                    },
                    ...(requestedMode === 'code' && codePromise ? { readCode: () => codePromise } : {}),
                    signal: abort.signal,
                });
                if (this.pendingCodeDeferred === deferred) {
                    this.pendingCodeDeferred = null;
                }
                if (this.authAbort !== abort || this.disposed) {
                    return;
                }
                this.authAbort = null;
                this.authState = {
                    phase: 'succeeded',
                    mode: requestedMode,
                    message: 'Authentication succeeded',
                    startedAt,
                    finishedAt: new Date().toISOString(),
                };
                this.modelsError = undefined;
                this.quotaError = undefined;
                if (!this.disposed) {
                    void this.refreshModels().catch(() => { });
                }
            }
            catch (error) {
                if (this.pendingCodeDeferred === deferred) {
                    this.pendingCodeDeferred = null;
                }
                if (this.authAbort !== abort || this.disposed) {
                    return;
                }
                this.authAbort = null;
                const isAborted = abort.signal.aborted ||
                    (error instanceof AntigravityAcpError && error.code === 'ABORTED');
                const safeErr = sanitizeControlError(error, this.activeSecrets(parsed?.apiKey));
                this.authState = {
                    phase: isAborted ? 'cancelled' : 'failed',
                    mode: requestedMode,
                    message: isAborted ? 'Authentication cancelled' : safeErr,
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    ...(!isAborted ? { error: safeErr } : {}),
                };
            }
            finally {
                notifyFirstProgress();
            }
        };
        const loginTask = runOAuth();
        let timer;
        await Promise.race([
            firstProgressPromise,
            loginTask,
            new Promise((resolve) => {
                timer = setTimeout(resolve, 30);
                timer.unref?.();
            }),
        ]);
        if (timer !== undefined) {
            clearTimeout(timer);
        }
        return await this.status();
    }
    async authSubmitCode(input) {
        const parsed = parseAuthSubmitCodeInput(input);
        const deferred = this.pendingCodeDeferred;
        if (!deferred || deferred.settled) {
            throw badRequest('No pending authorization code login is waiting for a code');
        }
        const startedAt = this.authState.startedAt;
        this.authState = {
            phase: 'exchanging',
            mode: 'code',
            message: 'Exchanging authorization code...',
            ...(startedAt !== undefined ? { startedAt } : {}),
        };
        this.pendingCodeDeferred = null;
        deferred.resolve(parsed.code);
        return await this.status();
    }
    async authCancel() {
        if (this.authAbort !== null || this.pendingCodeDeferred !== null) {
            this.cancelActiveAuthInternal('Authentication cancelled', 'cancelled');
        }
        return await this.status();
    }
    async logout() {
        if (this.authAbort !== null || this.pendingCodeDeferred !== null) {
            this.cancelActiveAuthInternal('Logged out', 'idle');
        }
        else {
            this.authState = {
                phase: 'idle',
                message: '',
            };
        }
        await this.runtime.logout();
        await saveUiOverrides(this.resolveProfileDir(), { clearApiKey: true }, this.platform);
        await this.runtime.updateConfig?.({ apiKey: undefined });
        this.models = [];
        this.modelsError = undefined;
        this.lastQuota = undefined;
        this.quotaError = undefined;
        return await this.status();
    }
    async refreshModels() {
        try {
            const discovered = await this.runtime.listModels({ refresh: true });
            this.models = mapDiscoveredModels(discovered);
            this.modelsError = undefined;
        }
        catch (error) {
            this.modelsError = sanitizeControlError(error, this.activeSecrets());
        }
        return await this.status();
    }
    async refreshQuota() {
        try {
            const quota = await this.runtime.getQuota();
            this.lastQuota = quota;
            this.quotaError = undefined;
        }
        catch (error) {
            this.quotaError = sanitizeControlError(error, this.activeSecrets());
        }
        return await this.status();
    }
    async checkUpdate() {
        if (this.disposed) {
            throw badRequest('Antigravity control service has been disposed');
        }
        if (this.activeUpdateTask !== null) {
            return await this.status();
        }
        if (this.updateCheckTask !== null) {
            await this.updateCheckTask.catch(() => { });
            return await this.status();
        }
        const abort = new AbortController();
        this.updateCheckAbort = abort;
        const startedAt = new Date().toISOString();
        this.pluginUpdateState = {
            ...this.pluginUpdateState,
            phase: 'checking',
            startedAt,
            finishedAt: undefined,
            error: undefined,
            message: 'Checking GitHub for plugin updates...',
        };
        const runCheck = async () => {
            try {
                const runtimeSnap = await this.runtime.getStatus().catch(() => undefined);
                const result = await checkPluginUpdate({
                    packageRootDir: this.packageRootDir,
                    dshProfileDir: this.resolveDshProfileDir(),
                    pluginManager: this.resolvePluginManager(),
                    fetch: this.fetchImpl,
                    signal: abort.signal,
                    githubApiBase: this.githubApiBase,
                    rawGithubBase: this.rawGithubBase,
                    cliInstalledVersion: runtimeSnap?.executable?.version,
                    cliManifestBaseUrl: this.cliManifestBaseUrl,
                    platform: this.platform,
                    arch: this.arch,
                    musl: this.musl,
                });
                if (this.updateCheckAbort !== abort || this.disposed) {
                    return;
                }
                this.lastCheckResult = result;
                this.pluginUpdateState = {
                    packageName: result.packageName,
                    currentVersion: result.currentVersion,
                    ...(result.currentCommit !== undefined ? { currentCommit: result.currentCommit } : {}),
                    ...(result.installedSpec !== undefined ? { installedSpec: result.installedSpec } : {}),
                    repoUrl: result.repoUrl,
                    ...(result.latestVersion !== undefined ? { latestVersion: result.latestVersion } : {}),
                    ...(result.latestCommit !== undefined ? { latestCommit: result.latestCommit } : {}),
                    ...(result.latestMessage !== undefined ? { latestMessage: result.latestMessage } : {}),
                    ...(result.latestDate !== undefined ? { latestDate: result.latestDate } : {}),
                    ...(result.commitUrl !== undefined ? { commitUrl: result.commitUrl } : {}),
                    installSpec: result.installSpec,
                    updateAvailable: result.updateAvailable,
                    reason: result.reason,
                    canAutoUpdate: result.canAutoUpdate,
                    ...(result.cliLatestVersion !== undefined
                        ? { cliLatestVersion: result.cliLatestVersion }
                        : {}),
                    ...(result.cliUpdateAvailable !== undefined
                        ? { cliUpdateAvailable: result.cliUpdateAvailable }
                        : {}),
                    phase: 'idle',
                    restartRequired: this.pluginUpdateState.restartRequired,
                    ...(this.pluginUpdateState.restartReason !== undefined
                        ? { restartReason: this.pluginUpdateState.restartReason }
                        : {}),
                    message: buildUpdateCheckMessage(result),
                    checkedAt: result.checkedAt,
                    startedAt,
                    finishedAt: new Date().toISOString(),
                };
            }
            catch (error) {
                if (this.updateCheckAbort !== abort || this.disposed) {
                    return;
                }
                const isAborted = abort.signal.aborted ||
                    (error instanceof AntigravityAcpError && error.code === 'ABORTED');
                const safeErr = sanitizeControlError(error, this.activeSecrets());
                this.pluginUpdateState = {
                    ...this.pluginUpdateState,
                    phase: isAborted ? 'cancelled' : 'failed',
                    message: isAborted ? 'Update check cancelled' : safeErr,
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    ...(!isAborted ? { error: safeErr } : {}),
                };
            }
            finally {
                if (this.updateCheckAbort === abort) {
                    this.updateCheckAbort = null;
                }
            }
        };
        const task = runCheck().finally(() => {
            if (this.updateCheckTask === task) {
                this.updateCheckTask = null;
            }
        });
        this.updateCheckTask = task;
        await task;
        return await this.status();
    }
    async updatePlugin(input) {
        const parsed = parseUpdatePluginInput(input);
        if (this.disposed) {
            throw badRequest('Antigravity control service has been disposed');
        }
        if (this.activeUpdateTask !== null) {
            return await this.status();
        }
        if (this.updateCheckAbort !== null) {
            const checkAbort = this.updateCheckAbort;
            this.updateCheckAbort = null;
            checkAbort.abort(new AntigravityAcpError('Superseded by plugin update', 'ABORTED'));
        }
        const pluginManager = this.resolvePluginManager();
        const dshProfileDir = this.resolveDshProfileDir();
        const info = await readInstalledPluginInfo({
            packageRootDir: this.packageRootDir,
            dshProfileDir,
            pluginManager,
        });
        let validatedTargetSpec;
        if (parsed?.targetSpec !== undefined) {
            try {
                validatedTargetSpec = validatePluginUpdateSpec(parsed.targetSpec, info.owner, info.repo);
            }
            catch (error) {
                throw badRequest(sanitizeControlError(error, this.activeSecrets()));
            }
        }
        const startedAt = new Date().toISOString();
        const requestId = `agp-update-${crypto.randomUUID()}`;
        this.activeUpdateRequestId = requestId;
        this.pluginUpdateState = {
            ...this.pluginUpdateState,
            packageName: info.packageName,
            currentVersion: info.currentVersion,
            ...(info.currentCommit !== undefined ? { currentCommit: info.currentCommit } : {}),
            ...(info.installedSpec !== undefined ? { installedSpec: info.installedSpec } : {}),
            repoUrl: info.repoUrl,
            canAutoUpdate: info.canAutoUpdate,
            phase: 'updating',
            restartRequired: false,
            restartReason: undefined,
            error: undefined,
            startedAt,
            finishedAt: undefined,
            message: 'Preparing plugin update...',
        };
        const runUpdate = async () => {
            let unsubscribeProgress;
            try {
                let targetSpec = validatedTargetSpec;
                if (!targetSpec) {
                    this.pluginUpdateState = {
                        ...this.pluginUpdateState,
                        phase: 'updating',
                        message: 'Checking latest release on GitHub before updating...',
                    };
                    const runtimeSnap = await this.runtime.getStatus().catch(() => undefined);
                    const checked = await checkPluginUpdate({
                        packageRootDir: this.packageRootDir,
                        dshProfileDir: this.resolveDshProfileDir(),
                        pluginManager: this.resolvePluginManager(),
                        fetch: this.fetchImpl,
                        githubApiBase: this.githubApiBase,
                        rawGithubBase: this.rawGithubBase,
                        cliInstalledVersion: runtimeSnap?.executable?.version,
                        cliManifestBaseUrl: this.cliManifestBaseUrl,
                        platform: this.platform,
                        arch: this.arch,
                        musl: this.musl,
                    });
                    if (this.disposed) {
                        return;
                    }
                    this.lastCheckResult = checked;
                    this.pluginUpdateState = {
                        ...this.pluginUpdateState,
                        packageName: checked.packageName,
                        currentVersion: checked.currentVersion,
                        ...(checked.currentCommit !== undefined
                            ? { currentCommit: checked.currentCommit }
                            : {}),
                        ...(checked.installedSpec !== undefined
                            ? { installedSpec: checked.installedSpec }
                            : {}),
                        repoUrl: checked.repoUrl,
                        ...(checked.latestVersion !== undefined
                            ? { latestVersion: checked.latestVersion }
                            : {}),
                        ...(checked.latestCommit !== undefined ? { latestCommit: checked.latestCommit } : {}),
                        ...(checked.latestMessage !== undefined
                            ? { latestMessage: checked.latestMessage }
                            : {}),
                        ...(checked.latestDate !== undefined ? { latestDate: checked.latestDate } : {}),
                        ...(checked.commitUrl !== undefined ? { commitUrl: checked.commitUrl } : {}),
                        installSpec: checked.installSpec,
                        updateAvailable: checked.updateAvailable,
                        reason: checked.reason,
                        canAutoUpdate: checked.canAutoUpdate,
                        ...(checked.cliLatestVersion !== undefined
                            ? { cliLatestVersion: checked.cliLatestVersion }
                            : {}),
                        ...(checked.cliUpdateAvailable !== undefined
                            ? { cliUpdateAvailable: checked.cliUpdateAvailable }
                            : {}),
                        checkedAt: checked.checkedAt,
                    };
                    if (!checked.updateAvailable && parsed?.force !== true) {
                        this.pluginUpdateState = {
                            ...this.pluginUpdateState,
                            phase: 'succeeded',
                            restartRequired: false,
                            finishedAt: new Date().toISOString(),
                            error: undefined,
                            message: buildUpdateCheckMessage(checked),
                        };
                        return;
                    }
                    targetSpec = checked.installSpec;
                }
                const currentInfo = await readInstalledPluginInfo({
                    packageRootDir: this.packageRootDir,
                    dshProfileDir: this.resolveDshProfileDir(),
                    pluginManager: this.resolvePluginManager(),
                });
                if (parsed?.force === true &&
                    currentInfo.installedSpec !== undefined &&
                    currentInfo.installedSpec === targetSpec) {
                    targetSpec = toggleGithubSpecFormat(targetSpec, currentInfo.owner, currentInfo.repo);
                }
                const ctxLike = this.ctx;
                unsubscribeProgress = ctxLike.on?.('plugin-manager/install-state', (payload) => {
                    if (this.disposed ||
                        this.activeUpdateRequestId !== requestId ||
                        typeof payload !== 'object' ||
                        payload === null) {
                        return;
                    }
                    const ev = payload;
                    if (ev.requestId !== requestId) {
                        return;
                    }
                    if (ev.phase === 'installing') {
                        this.pluginUpdateState = {
                            ...this.pluginUpdateState,
                            phase: 'updating',
                            message: 'Installing updated plugin bundle via DSH package manager...',
                        };
                    }
                    else if (ev.phase === 'applying') {
                        this.pluginUpdateState = {
                            ...this.pluginUpdateState,
                            phase: 'updating',
                            message: 'Applying updated plugin bundle...',
                        };
                    }
                    else if (ev.phase === 'cancelling') {
                        this.pluginUpdateState = {
                            ...this.pluginUpdateState,
                            message: 'Cancelling plugin update...',
                        };
                    }
                });
                this.pluginUpdateState = {
                    ...this.pluginUpdateState,
                    phase: 'updating',
                    installSpec: targetSpec,
                    message: `Updating plugin from ${targetSpec}...`,
                };
                const applyResult = await applyPluginUpdate({
                    installSpec: targetSpec,
                    requestId,
                    owner: currentInfo.owner,
                    repo: currentInfo.repo,
                    pluginManager: this.resolvePluginManager(),
                });
                if (this.disposed) {
                    return;
                }
                if (applyResult.status === 'cancelled') {
                    this.pluginUpdateState = {
                        ...this.pluginUpdateState,
                        phase: 'cancelled',
                        restartRequired: false,
                        finishedAt: new Date().toISOString(),
                        error: undefined,
                        message: applyResult.message,
                    };
                    return;
                }
                if (applyResult.status === 'failed') {
                    const safeErr = sanitizeControlError(applyResult.error ?? applyResult.message, this.activeSecrets());
                    this.pluginUpdateState = {
                        ...this.pluginUpdateState,
                        phase: 'failed',
                        restartRequired: false,
                        finishedAt: new Date().toISOString(),
                        error: safeErr,
                        message: safeErr,
                    };
                    return;
                }
                const refreshedInfo = await readInstalledPluginInfo({
                    packageRootDir: this.packageRootDir,
                    dshProfileDir: this.resolveDshProfileDir(),
                    pluginManager: this.resolvePluginManager(),
                }).catch(() => undefined);
                const nextCommit = refreshedInfo?.currentCommit ??
                    this.pluginUpdateState.latestCommit ??
                    this.pluginUpdateState.currentCommit;
                const nextVersion = applyResult.installedVersion ??
                    refreshedInfo?.currentVersion ??
                    this.pluginUpdateState.currentVersion;
                this.pluginUpdateState = {
                    ...this.pluginUpdateState,
                    currentVersion: nextVersion,
                    ...(nextCommit !== undefined ? { currentCommit: nextCommit } : {}),
                    installedSpec: refreshedInfo?.installedSpec ?? applyResult.installSpec,
                    updateAvailable: false,
                    reason: 'up-to-date',
                    phase: 'succeeded',
                    restartRequired: applyResult.restartRequired,
                    ...(applyResult.restartReason !== undefined
                        ? { restartReason: applyResult.restartReason }
                        : {}),
                    finishedAt: new Date().toISOString(),
                    error: undefined,
                    message: applyResult.message,
                };
            }
            catch (error) {
                if (this.disposed) {
                    return;
                }
                const safeErr = sanitizeControlError(error, this.activeSecrets());
                this.pluginUpdateState = {
                    ...this.pluginUpdateState,
                    phase: 'failed',
                    restartRequired: false,
                    finishedAt: new Date().toISOString(),
                    error: safeErr,
                    message: safeErr,
                };
            }
            finally {
                try {
                    unsubscribeProgress?.();
                }
                catch {
                    // Ignore unsubscribe failure
                }
                if (this.activeUpdateRequestId === requestId) {
                    this.activeUpdateRequestId = null;
                }
            }
        };
        const task = runUpdate().finally(() => {
            if (this.activeUpdateTask === task) {
                this.activeUpdateTask = null;
            }
        });
        this.activeUpdateTask = task;
        await Promise.race([
            task,
            new Promise((resolve) => {
                const timer = setTimeout(resolve, 20);
                timer.unref?.();
            }),
        ]);
        return await this.status();
    }
    async cancelPluginUpdate() {
        if (this.disposed) {
            throw badRequest('Antigravity control service has been disposed');
        }
        if (this.updateCheckAbort !== null) {
            const checkAbort = this.updateCheckAbort;
            const startedAt = this.pluginUpdateState.startedAt;
            this.updateCheckAbort = null;
            this.pluginUpdateState = {
                ...this.pluginUpdateState,
                phase: 'cancelled',
                message: 'Update check cancelled',
                ...(startedAt !== undefined ? { startedAt } : {}),
                finishedAt: new Date().toISOString(),
                error: undefined,
            };
            checkAbort.abort(new AntigravityAcpError('Update check cancelled', 'ABORTED'));
        }
        const requestId = this.activeUpdateRequestId;
        if (requestId !== null) {
            const pm = this.resolvePluginManager();
            const cancelRes = await pm?.cancelInstall?.(requestId).catch(() => undefined);
            if (cancelRes?.status === 'too-late') {
                if (this.pluginUpdateState.phase === 'updating') {
                    this.pluginUpdateState = {
                        ...this.pluginUpdateState,
                        message: 'Update is already being applied and cannot be cancelled now.',
                    };
                }
            }
            else {
                if (this.activeUpdateTask !== null) {
                    await this.activeUpdateTask.catch(() => { });
                }
                if (this.pluginUpdateState.phase === 'updating') {
                    this.pluginUpdateState = {
                        ...this.pluginUpdateState,
                        phase: 'cancelled',
                        restartRequired: false,
                        finishedAt: new Date().toISOString(),
                        error: undefined,
                        message: 'Plugin update cancelled',
                    };
                }
            }
        }
        return await this.status();
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        // Abort in-flight GitHub HTTP checks only; never call pluginManager.cancelInstall
        // here because HMR disposes this old service while applying the updated bundle.
        if (this.updateCheckAbort !== null) {
            const checkAbort = this.updateCheckAbort;
            this.updateCheckAbort = null;
            checkAbort.abort(new AntigravityAcpError('Control service disposed', 'ABORTED'));
        }
        if (this.installAbort !== null) {
            const installAbort = this.installAbort;
            this.installAbort = null;
            installAbort.abort(new AntigravityAcpError('Control service disposed', 'ABORTED'));
        }
        if (this.authAbort !== null || this.pendingCodeDeferred !== null) {
            this.cancelActiveAuthInternal('Control service disposed', 'cancelled');
        }
    }
}
/**
 * Instantiate {@link AntigravityControlService} and register strict Typert invocation descriptors
 * on `ctx.typert`, withdrawing both cleanly when the Cordis scope disposes.
 */
export function registerAntigravityControlRemote(ctx, runtime, options = {}) {
    const service = new AntigravityControlService(ctx, runtime, options);
    const typert = ctx.get('typert');
    const disposeTypert = typert?.register?.({
        package: ANTIGRAVITY_CONTROL_PACKAGE,
        face: 'host',
        schemas: [],
        model: {
            services: [],
            events: [],
            objects: [],
        },
        invocations: [...ANTIGRAVITY_CONTROL_INVOCATIONS],
    });
    ctx.effect(() => async () => {
        service.dispose();
        await disposeTypert?.();
    }, 'antigravityControl.lifecycle');
    return service;
}
//# sourceMappingURL=control-remote.js.map