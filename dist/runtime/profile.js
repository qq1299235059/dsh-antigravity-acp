import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravityAcpError } from '../shared/errors.js';
/** Stdout prefix emitted by `agy acp` when requesting interactive browser authentication. */
export const ANTIGRAVITY_AUTH_STDOUT_PREFIX = 'Open the following link to authenticate the ACP server: ';
/** Stderr marker emitted by our `BROWSER` interceptor script with a JSON-encoded auth URL. */
export const ANTIGRAVITY_AUTH_BROWSER_MARKER = '__DSH_ANTIGRAVITY_AUTH_URL__';
/** Token filename written by Antigravity CLI (`agy` 1.5.x) under `<profileDir>/.gemini/antigravity-acp/`. */
export const ANTIGRAVITY_OAUTH_TOKEN_FILENAME = 'antigravity-oauth-token';
/** Ambient environment variables scrubbed before spawning Antigravity ACP processes. */
export const removedEnvironmentKeys = [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_CLOUD_QUOTA_PROJECT',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GCLOUD_PROJECT',
    'CLOUDSDK_CORE_PROJECT',
    'AGY_ACP_CCPA_PROJECT',
    'AGY_ACP_ENABLE_OAUTH',
    'GEMINI_HOME',
    'AGY_ACP_FORCE_FILE_STORAGE',
    'AGY_CLI_DISABLE_AUTO_UPDATE',
    'BROWSER',
    'PYTHONUNBUFFERED',
    'ELECTRON_RUN_AS_NODE',
    'CHROME_CRASHPAD_PIPE_NAME',
];
const REMOVED_KEYS_EXACT = new Set(removedEnvironmentKeys);
const REMOVED_KEYS_UPPER = new Set(removedEnvironmentKeys.map((k) => k.toUpperCase()));
const SUPPORTED_PROXY_PROTOCOLS = new Set([
    'http:',
    'https:',
    'socks5:',
    'socks5h:',
    'socks4:',
    'socks4a:',
]);
const LINUX_CA_BUNDLE_CANDIDATES = [
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/pki/tls/certs/ca-bundle.crt',
    '/etc/ssl/ca-bundle.pem',
    '/etc/ssl/cert.pem',
];
const VALID_AUTH_METHODS = new Set([
    'oauth-personal',
    'oauth-business',
    'gemini-api-key',
    'agent-platform',
]);
/**
 * Expand a leading `~` segment relative to `homeDir`.
 */
export function expandHomePath(targetPath, homeDir = os.homedir()) {
    const trimmed = targetPath.trim();
    if (trimmed === '~') {
        return homeDir;
    }
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
        return path.join(homeDir, trimmed.slice(2));
    }
    return trimmed;
}
/**
 * Read an environment variable, matching case-insensitively on Windows.
 */
export function getEnvValue(env, name, platform = process.platform) {
    if (!env) {
        return undefined;
    }
    if (platform !== 'win32') {
        return env[name];
    }
    if (env[name] !== undefined) {
        return env[name];
    }
    const targetUpper = name.toUpperCase();
    for (const [key, value] of Object.entries(env)) {
        if (key.toUpperCase() === targetUpper && value !== undefined) {
            return value;
        }
    }
    return undefined;
}
function setEnvCaseAware(target, name, value, platform) {
    if (platform === 'win32') {
        const targetUpper = name.toUpperCase();
        for (const existingKey of Object.keys(target)) {
            if (existingKey.toUpperCase() === targetUpper) {
                delete target[existingKey];
            }
        }
    }
    target[name] = value;
}
function resolvePlatform(platform, env) {
    if (platform) {
        return platform;
    }
    if (env && getEnvValue(env, 'OS', 'win32') === 'Windows_NT' && process.platform === 'win32') {
        return 'win32';
    }
    return process.platform;
}
/**
 * Resolve the default isolated profile directory for Antigravity ACP state.
 */
export function resolveDefaultProfileDir(config, env = process.env, homeDir = os.homedir(), platform) {
    const activePlatform = resolvePlatform(platform, env);
    const configured = config.profileDir?.trim();
    if (configured) {
        return path.resolve(expandHomePath(configured, homeDir));
    }
    if (activePlatform === 'win32') {
        const localAppData = getEnvValue(env, 'LOCALAPPDATA', 'win32')?.trim() || path.join(homeDir, 'AppData', 'Local');
        return path.resolve(path.join(localAppData, 'dsh-antigravity-acp', 'profile'));
    }
    if (activePlatform === 'darwin') {
        return path.resolve(path.join(homeDir, 'Library', 'Application Support', 'dsh-antigravity-acp', 'profile'));
    }
    const xdgState = getEnvValue(env, 'XDG_STATE_HOME', activePlatform)?.trim() ||
        path.join(homeDir, '.local', 'state');
    return path.resolve(path.join(xdgState, 'dsh-antigravity-acp', 'profile'));
}
function resolveShortTempDirectory(profileDir, platform, env) {
    const profileTmp = path.join(profileDir, 'tmp');
    const hash8 = crypto.createHash('sha256').update(profileDir).digest('hex').slice(0, 8);
    if (platform === 'win32') {
        if (profileTmp.length <= 90) {
            return profileTmp;
        }
        const baseTmp = getEnvValue(env, 'TEMP', 'win32')?.trim() ||
            getEnvValue(env, 'TMP', 'win32')?.trim() ||
            os.tmpdir();
        const shortTmp = path.join(baseTmp, `agy-${hash8}`);
        return shortTmp.length < profileTmp.length ? shortTmp : profileTmp;
    }
    if (profileTmp.length <= 120) {
        return profileTmp;
    }
    const baseTmp = getEnvValue(env, 'TMPDIR', platform)?.trim() || '/tmp';
    const shortTmp = path.join(baseTmp, `agy-${hash8}`);
    return shortTmp.length < profileTmp.length ? shortTmp : profileTmp;
}
/**
 * Compute all filesystem paths belonging to a profile without mutating disk.
 */
export function resolveProfilePaths(config, env = process.env, homeDir = os.homedir(), platform) {
    const activePlatform = resolvePlatform(platform, env);
    const profileDir = resolveDefaultProfileDir(config, env, homeDir, activePlatform);
    const geminiHome = path.join(profileDir, '.gemini');
    const acpDirectory = path.join(geminiHome, 'antigravity-acp');
    return {
        platform: activePlatform,
        profileDir,
        geminiHome,
        acpDirectory,
        settingsPath: path.join(acpDirectory, 'settings.json'),
        tokenPath: path.join(acpDirectory, 'oauth_creds.json'),
        cliTokenPath: path.join(geminiHome, 'oauth_creds.json'),
        tempDirectory: resolveShortTempDirectory(profileDir, activePlatform, env),
    };
}
function resolveConfiguredApiKey(config, env, platform) {
    const direct = config.apiKey?.trim();
    if (direct) {
        return direct;
    }
    const envName = config.apiKeyEnv?.trim();
    if (envName) {
        const fromEnv = getEnvValue(env, envName, platform)?.trim();
        if (fromEnv) {
            return fromEnv;
        }
    }
    return undefined;
}
function safeReadJsonFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw.trim()) {
            return null;
        }
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
function decodeJwtEmail(idToken) {
    if (typeof idToken !== 'string') {
        return undefined;
    }
    const parts = idToken.split('.');
    if (parts.length !== 3 || !parts[1]) {
        return undefined;
    }
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (typeof payload.email === 'string' && payload.email.trim()) {
            return payload.email.trim();
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
function parseTimestampMs(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        return raw < 1e12 ? raw * 1000 : raw;
    }
    if (typeof raw === 'string' && raw.trim()) {
        const asNumber = Number(raw.trim());
        if (Number.isFinite(asNumber) && asNumber > 0) {
            return asNumber < 1e12 ? asNumber * 1000 : asNumber;
        }
        const parsedDate = Date.parse(raw.trim());
        if (Number.isFinite(parsedDate)) {
            return parsedDate;
        }
    }
    return undefined;
}
function unwrapCredentialRecord(record) {
    for (const key of ['token', 'creds', 'credentials', 'default']) {
        const nested = record[key];
        if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
            return nested;
        }
    }
    return record;
}
function inspectOAuthTokenFiles(paths) {
    const tokenCandidates = [
        path.join(paths.acpDirectory, ANTIGRAVITY_OAUTH_TOKEN_FILENAME),
        path.join(paths.geminiHome, ANTIGRAVITY_OAUTH_TOKEN_FILENAME),
        paths.tokenPath,
        paths.cliTokenPath,
        path.join(paths.acpDirectory, 'antigravity_oauth_creds.json'),
        path.join(paths.geminiHome, 'antigravity_oauth_creds.json'),
    ];
    let hasUsableToken = false;
    let account;
    for (const candidate of tokenCandidates) {
        const rawJson = safeReadJsonFile(candidate);
        if (!rawJson) {
            continue;
        }
        const record = unwrapCredentialRecord(rawJson);
        const refreshToken = typeof record.refresh_token === 'string'
            ? record.refresh_token.trim()
            : typeof record.refreshToken === 'string'
                ? record.refreshToken.trim()
                : '';
        const accessToken = typeof record.access_token === 'string'
            ? record.access_token.trim()
            : typeof record.accessToken === 'string'
                ? record.accessToken.trim()
                : '';
        const expiryMs = parseTimestampMs(record.expiry_date) ??
            parseTimestampMs(record.expiry) ??
            parseTimestampMs(record.expires_at) ??
            parseTimestampMs(record.expiresAt);
        if (refreshToken.length > 0) {
            hasUsableToken = true;
        }
        else if (accessToken.length > 0 && (expiryMs === undefined || expiryMs > Date.now())) {
            hasUsableToken = true;
        }
        if (!account) {
            const explicitCandidates = [
                rawJson.id_token_email,
                record.id_token_email,
                record.email,
                rawJson.email,
                record.account,
                rawJson.account,
            ];
            const explicitAccount = explicitCandidates.find((v) => typeof v === 'string' && v.trim().length > 0);
            if (explicitAccount) {
                account = explicitAccount.trim();
            }
            else {
                account = decodeJwtEmail(record.id_token ?? record.idToken ?? rawJson.id_token ?? rawJson.idToken);
            }
        }
    }
    if (!account) {
        for (const accountsFile of [
            path.join(paths.acpDirectory, 'google_accounts.json'),
            path.join(paths.geminiHome, 'google_accounts.json'),
        ]) {
            const accountsJson = safeReadJsonFile(accountsFile);
            if (accountsJson && typeof accountsJson.active === 'string' && accountsJson.active.trim()) {
                account = accountsJson.active.trim();
                break;
            }
        }
    }
    return { hasUsableToken, ...(account ? { account } : {}) };
}
/**
 * Synchronously inspect profile state without modifying files on disk.
 */
export function resolveProfileSnapshot(config, env = process.env, homeDir = os.homedir(), platform) {
    const paths = resolveProfilePaths(config, env, homeDir, platform);
    const apiKey = resolveConfiguredApiKey(config, env, paths.platform);
    const hasApiKey = Boolean(apiKey);
    const gcpProject = config.gcpProject?.trim() || undefined;
    const gcpLocation = config.gcpLocation?.trim() || undefined;
    const tokenInfo = inspectOAuthTokenFiles(paths);
    let authenticated = false;
    switch (config.authMethod) {
        case 'gemini-api-key':
            authenticated = hasApiKey;
            break;
        case 'agent-platform':
            authenticated = hasApiKey || tokenInfo.hasUsableToken;
            break;
        case 'oauth-personal':
        case 'oauth-business':
            authenticated = tokenInfo.hasUsableToken;
            break;
    }
    return {
        profileDir: paths.profileDir,
        authMethod: config.authMethod,
        authenticated,
        ...(tokenInfo.account ? { account: tokenInfo.account } : {}),
        ...(gcpProject ? { gcpProject } : {}),
        ...(gcpLocation ? { gcpLocation } : {}),
        hasApiKey,
    };
}
function detectLinuxCaBundlePath(platform, options) {
    if (platform !== 'linux') {
        return undefined;
    }
    if (options?.caBundlePath !== undefined) {
        return options.caBundlePath || undefined;
    }
    const exists = options?.existsSync ?? (platform === process.platform ? fs.existsSync : undefined);
    if (!exists) {
        return undefined;
    }
    for (const candidate of LINUX_CA_BUNDLE_CANDIDATES) {
        try {
            if (exists(candidate)) {
                return candidate;
            }
        }
        catch {
            // Ignore probe errors on restricted paths
        }
    }
    return undefined;
}
function shellSingleQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
const profilePrepareQueue = new Map();
async function withProfilePrepareLock(key, task) {
    const previous = profilePrepareQueue.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const chained = previous.catch(() => { }).then(() => gate);
    profilePrepareQueue.set(key, chained);
    await previous.catch(() => { });
    try {
        return await task();
    }
    finally {
        release();
        if (profilePrepareQueue.get(key) === chained) {
            profilePrepareQueue.delete(key);
        }
    }
}
/**
 * Rename a file or directory with Windows EPERM/EBUSY/EACCES retry backoff.
 */
export async function renameWithWindowsRetry(sourcePath, targetPath) {
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            await fs.promises.rename(sourcePath, targetPath);
            return;
        }
        catch (error) {
            const code = error.code;
            if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') &&
                attempt < maxAttempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
                continue;
            }
            throw error;
        }
    }
}
/**
 * Atomically write a UTF-8 file using a unique temp file and Windows-safe rename.
 */
export async function writeFileAtomic(targetPath, content, platform, mode = 0o644) {
    const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    try {
        await fs.promises.writeFile(tempPath, content, {
            encoding: 'utf8',
            mode: platform === 'win32' ? undefined : mode,
        });
        await renameWithWindowsRetry(tempPath, targetPath);
    }
    catch (error) {
        await fs.promises.rm(tempPath, { force: true }).catch(() => { });
        throw error;
    }
}
async function writeBrowserInterceptor(tempDirectory, platform) {
    const scriptPath = path.join(tempDirectory, 'browser-intercept.mjs');
    const scriptBody = [
        '#!/usr/bin/env node',
        'const url = process.argv[2] ?? "";',
        'if (url) {',
        `  process.stderr.write(${JSON.stringify(ANTIGRAVITY_AUTH_BROWSER_MARKER)} + JSON.stringify(url) + "\\n");`,
        '}',
        '',
    ].join('\n');
    await writeFileAtomic(scriptPath, scriptBody, platform, 0o755);
    const isElectronHost = Boolean(process.versions.electron);
    if (platform === 'win32') {
        const cmdPath = path.join(tempDirectory, 'browser-intercept.cmd');
        const lines = ['@echo off'];
        if (isElectronHost) {
            lines.push('set "ELECTRON_RUN_AS_NODE=1"');
        }
        lines.push(`"${process.execPath}" "${scriptPath}" %*`);
        await writeFileAtomic(cmdPath, `${lines.join('\r\n')}\r\n`, platform);
        return cmdPath;
    }
    const shPath = path.join(tempDirectory, 'browser-intercept.sh');
    const prefix = isElectronHost ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
    const shBody = `#!/bin/sh\nexec ${prefix}${shellSingleQuote(process.execPath)} ${shellSingleQuote(scriptPath)} "$@"\n`;
    await writeFileAtomic(shPath, shBody, platform, 0o755);
    await fs.promises.chmod(shPath, 0o755);
    return shPath;
}
/**
 * Prepare isolated profile directories, ACP settings, temp dir, CA detection, and browser interceptor.
 */
export async function prepareAntigravityProfile(config, options) {
    const env = options?.env ?? process.env;
    const homeDir = options?.homeDir ?? os.homedir();
    const paths = resolveProfilePaths(config, env, homeDir, options?.platform);
    const lockKey = paths.platform === 'win32' ? paths.profileDir.toLowerCase() : paths.profileDir;
    return withProfilePrepareLock(lockKey, async () => {
        const dirMode = paths.platform === 'win32' ? undefined : 0o700;
        await fs.promises.mkdir(paths.profileDir, { recursive: true, mode: dirMode });
        await fs.promises.mkdir(paths.geminiHome, { recursive: true, mode: dirMode });
        await fs.promises.mkdir(paths.acpDirectory, { recursive: true, mode: dirMode });
        await fs.promises.mkdir(paths.tempDirectory, { recursive: true, mode: dirMode });
        const gcpProject = config.gcpProject?.trim() || undefined;
        const gcpLocation = config.gcpLocation?.trim() || undefined;
        const settingsPayload = {
            auth: { type: config.authMethod },
        };
        if (gcpProject || gcpLocation) {
            settingsPayload.gcp = {
                ...(gcpProject ? { project: gcpProject } : {}),
                ...(gcpLocation ? { location: gcpLocation } : {}),
            };
        }
        await writeFileAtomic(paths.settingsPath, `${JSON.stringify(settingsPayload, null, 2)}\n`, paths.platform, 0o600);
        const browserCommand = options?.suppressBrowser !== false
            ? await writeBrowserInterceptor(paths.tempDirectory, paths.platform)
            : undefined;
        const caBundlePath = detectLinuxCaBundlePath(paths.platform, options);
        const snapshot = resolveProfileSnapshot(config, env, homeDir, paths.platform);
        return {
            ...snapshot,
            platform: paths.platform,
            geminiHome: paths.geminiHome,
            acpDirectory: paths.acpDirectory,
            tokenPath: paths.tokenPath,
            cliTokenPath: paths.cliTokenPath,
            tempDirectory: paths.tempDirectory,
            ...(browserCommand ? { browserCommand } : {}),
            ...(caBundlePath ? { caBundlePath } : {}),
        };
    });
}
/**
 * Validate outbound HTTP/HTTPS/SOCKS proxy URL syntax and protocol.
 */
export function validateProxyUrl(proxyUrl) {
    const trimmed = proxyUrl.trim();
    if (!trimmed || /[\s\r\n\0]/.test(trimmed)) {
        throw new AntigravityAcpError('Proxy URL must be a non-empty URL without whitespace', 'AGY_PROXY_INVALID');
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        throw new AntigravityAcpError(`Invalid proxy URL: ${trimmed}`, 'AGY_PROXY_INVALID');
    }
    if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
        throw new AntigravityAcpError(`Unsupported proxy protocol "${parsed.protocol}" (expected http, https, socks4, socks4a, socks5, or socks5h)`, 'AGY_PROXY_INVALID');
    }
    if (!parsed.hostname) {
        throw new AntigravityAcpError('Proxy URL is missing a hostname', 'AGY_PROXY_INVALID');
    }
    if (parsed.port) {
        const portNum = Number(parsed.port);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65_535) {
            throw new AntigravityAcpError(`Proxy URL has an invalid port: ${parsed.port}`, 'AGY_PROXY_INVALID');
        }
    }
}
/**
 * Build the scrubbed, isolated child environment for spawning `agy acp`.
 */
export function buildAntigravityEnvironment(profile, config, baseEnv = process.env, runtimeTempDir) {
    const platform = profile.platform;
    const envOut = {};
    for (const [key, value] of Object.entries(baseEnv)) {
        if (value === undefined) {
            continue;
        }
        const isRemoved = platform === 'win32'
            ? REMOVED_KEYS_UPPER.has(key.toUpperCase())
            : REMOVED_KEYS_EXACT.has(key);
        if (!isRemoved) {
            envOut[key] = value;
        }
    }
    const configuredApiKey = resolveConfiguredApiKey(config, baseEnv, platform);
    if (configuredApiKey) {
        if (config.authMethod === 'gemini-api-key') {
            setEnvCaseAware(envOut, 'GEMINI_API_KEY', configuredApiKey, platform);
        }
        else if (config.authMethod === 'agent-platform') {
            setEnvCaseAware(envOut, 'GOOGLE_API_KEY', configuredApiKey, platform);
        }
    }
    if (config.authMethod === 'oauth-business' || config.authMethod === 'agent-platform') {
        const project = config.gcpProject?.trim();
        const location = config.gcpLocation?.trim();
        if (project) {
            setEnvCaseAware(envOut, 'GOOGLE_CLOUD_PROJECT', project, platform);
        }
        if (location) {
            setEnvCaseAware(envOut, 'GOOGLE_CLOUD_LOCATION', location, platform);
        }
    }
    if (config.authMethod === 'oauth-personal') {
        setEnvCaseAware(envOut, 'SSH_CONNECTION', '127.0.0.1 0 127.0.0.1 0', platform);
    }
    setEnvCaseAware(envOut, 'GEMINI_HOME', profile.geminiHome, platform);
    setEnvCaseAware(envOut, 'AGY_ACP_FORCE_FILE_STORAGE', '1', platform);
    setEnvCaseAware(envOut, 'AGY_CLI_DISABLE_AUTO_UPDATE', '1', platform);
    setEnvCaseAware(envOut, 'PYTHONUNBUFFERED', '1', platform);
    if (profile.browserCommand) {
        setEnvCaseAware(envOut, 'BROWSER', profile.browserCommand, platform);
    }
    if (profile.caBundlePath && !getEnvValue(envOut, 'SSL_CERT_FILE', platform)) {
        setEnvCaseAware(envOut, 'SSL_CERT_FILE', profile.caBundlePath, platform);
    }
    const effectiveTempDir = runtimeTempDir?.trim() || profile.tempDirectory;
    if (platform === 'win32') {
        setEnvCaseAware(envOut, 'TEMP', effectiveTempDir, platform);
        setEnvCaseAware(envOut, 'TMP', effectiveTempDir, platform);
    }
    else {
        setEnvCaseAware(envOut, 'TMPDIR', effectiveTempDir, platform);
    }
    const proxyUrl = config.proxyUrl?.trim();
    if (proxyUrl) {
        validateProxyUrl(proxyUrl);
        setEnvCaseAware(envOut, 'HTTP_PROXY', proxyUrl, platform);
        setEnvCaseAware(envOut, 'HTTPS_PROXY', proxyUrl, platform);
        setEnvCaseAware(envOut, 'ALL_PROXY', proxyUrl, platform);
        if (platform !== 'win32') {
            envOut.http_proxy = proxyUrl;
            envOut.https_proxy = proxyUrl;
            envOut.all_proxy = proxyUrl;
        }
    }
    if (config.proxyBypass !== undefined) {
        const bypass = config.proxyBypass.trim();
        if (bypass || proxyUrl) {
            setEnvCaseAware(envOut, 'NO_PROXY', bypass, platform);
            if (platform !== 'win32') {
                envOut.no_proxy = bypass;
            }
        }
    }
    return envOut;
}
/**
 * Build CLI arguments for spawning `agy acp` against an isolated profile.
 * Never passes an absolute path for `--app-data-dir`.
 */
export function buildAcpSpawnArgs(executable, profile, extraArgs) {
    return [
        ...executable.argsPrefix,
        '--gemini-dir',
        profile.geminiHome,
        '--app-data-dir',
        'antigravity-acp',
        ...(extraArgs ?? []),
    ];
}
function isLoopbackRedirectUrl(redirectUri) {
    try {
        const parsed = new URL(redirectUri);
        if (parsed.protocol !== 'http:') {
            return false;
        }
        return (parsed.hostname === 'localhost' ||
            parsed.hostname === '127.0.0.1' ||
            parsed.hostname === '[::1]' ||
            parsed.hostname === '::1');
    }
    catch {
        return false;
    }
}
/**
 * Parse and validate an Antigravity Google OAuth authorization URL.
 */
export function parseAntigravityAuthorizationUrl(rawUrl, expectedKind) {
    if (typeof rawUrl !== 'string') {
        return null;
    }
    const trimmed = rawUrl.trim();
    if (!trimmed || /[\s\r\n\0]/.test(trimmed)) {
        return null;
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        return null;
    }
    if (parsed.protocol !== 'https:' ||
        parsed.hostname !== 'accounts.google.com' ||
        parsed.username !== '' ||
        parsed.password !== '') {
        return null;
    }
    if (!parsed.pathname.startsWith('/o/oauth2/') &&
        !parsed.pathname.startsWith('/signin/oauth')) {
        return null;
    }
    const responseType = parsed.searchParams.get('response_type');
    if (responseType !== null && responseType !== 'code') {
        return null;
    }
    const redirectUriRaw = parsed.searchParams.get('redirect_uri');
    let redirectUri;
    let inferredKind = expectedKind ?? 'code';
    if (redirectUriRaw !== null) {
        const trimmedRedirect = redirectUriRaw.trim();
        if (!trimmedRedirect) {
            return null;
        }
        try {
            new URL(trimmedRedirect);
        }
        catch {
            return null;
        }
        redirectUri = trimmedRedirect;
        inferredKind = isLoopbackRedirectUrl(trimmedRedirect) ? 'loopback' : 'code';
    }
    if (expectedKind && inferredKind !== expectedKind) {
        return null;
    }
    const state = parsed.searchParams.get('state')?.trim() || undefined;
    return {
        url: parsed.toString(),
        kind: inferredKind,
        ...(redirectUri ? { redirectUri } : {}),
        ...(state ? { state } : {}),
    };
}
/**
 * Validate a pasted OAuth authorization code or redirected callback URL against a pending login.
 */
export function validateLoginResponse(pending, response) {
    if (typeof response !== 'string') {
        throw new AntigravityAcpError('Authorization response must be a string', 'AUTH');
    }
    const trimmed = response.trim();
    if (!trimmed || /[\r\n\0]/.test(trimmed)) {
        throw new AntigravityAcpError('Authorization code or callback URL must not be empty', 'AUTH');
    }
    if (/^https?:\/\//i.test(trimmed)) {
        let callbackUrl;
        try {
            callbackUrl = new URL(trimmed);
        }
        catch {
            throw new AntigravityAcpError('Malformed OAuth callback URL', 'AUTH');
        }
        const oauthError = callbackUrl.searchParams.get('error');
        if (oauthError) {
            throw new AntigravityAcpError(`Authorization failed: ${oauthError}`, 'AUTH');
        }
        if (pending.redirectUri && /^https?:\/\//i.test(pending.redirectUri)) {
            const expectedRedirect = new URL(pending.redirectUri);
            if (callbackUrl.origin !== expectedRedirect.origin ||
                callbackUrl.pathname !== expectedRedirect.pathname) {
                throw new AntigravityAcpError('Callback URL does not match pending OAuth redirect URI', 'AUTH');
            }
        }
        const code = callbackUrl.searchParams.get('code')?.trim();
        if (!code) {
            throw new AntigravityAcpError('Callback URL is missing authorization code', 'AUTH');
        }
        const state = callbackUrl.searchParams.get('state')?.trim() || undefined;
        if (pending.state && state !== pending.state) {
            throw new AntigravityAcpError('OAuth state parameter mismatch', 'AUTH');
        }
        return { code, ...(state ? { state } : {}) };
    }
    if (/(?:^|&)code=/.test(trimmed)) {
        const params = new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed);
        const oauthError = params.get('error');
        if (oauthError) {
            throw new AntigravityAcpError(`Authorization failed: ${oauthError}`, 'AUTH');
        }
        const code = params.get('code')?.trim();
        if (!code) {
            throw new AntigravityAcpError('Authorization response is missing code parameter', 'AUTH');
        }
        const state = params.get('state')?.trim() || undefined;
        if (pending.state && state && state !== pending.state) {
            throw new AntigravityAcpError('OAuth state parameter mismatch', 'AUTH');
        }
        return { code, ...(state ? { state } : {}) };
    }
    if (/\s/.test(trimmed) || trimmed.includes('://') || trimmed.length < 8 || trimmed.length > 4096) {
        throw new AntigravityAcpError('Invalid OAuth authorization code format', 'AUTH');
    }
    return { code: trimmed };
}
/**
 * Validate authentication and proxy settings before spawning or authenticating an ACP client.
 */
export function validateAuthConfig(config, env = process.env, platform = process.platform) {
    if (!VALID_AUTH_METHODS.has(config.authMethod)) {
        throw new AntigravityAcpError(`Unsupported authMethod: ${String(config.authMethod)}`, 'INVALID_REQUEST');
    }
    if (config.proxyUrl?.trim()) {
        validateProxyUrl(config.proxyUrl);
    }
    if (config.gcpProject !== undefined && !config.gcpProject.trim()) {
        throw new AntigravityAcpError('gcpProject must not be blank when specified', 'INVALID_REQUEST');
    }
    if (config.gcpLocation !== undefined && !config.gcpLocation.trim()) {
        throw new AntigravityAcpError('gcpLocation must not be blank when specified', 'INVALID_REQUEST');
    }
    const resolvedApiKey = resolveConfiguredApiKey(config, env, platform);
    if (config.authMethod === 'gemini-api-key' && !resolvedApiKey) {
        throw new AntigravityAcpError('gemini-api-key authentication requires apiKey or a populated apiKeyEnv variable', 'AGY_AUTH_REQUIRED');
    }
    if (config.authMethod === 'agent-platform' && !resolvedApiKey && !config.gcpProject?.trim()) {
        throw new AntigravityAcpError('agent-platform authentication requires gcpProject or an API key', 'AGY_AUTH_REQUIRED');
    }
}
//# sourceMappingURL=profile.js.map