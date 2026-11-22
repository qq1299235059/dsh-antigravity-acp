import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravityAcpError, redactSensitiveText } from '../shared/errors.js';
import { resolveProfilePaths } from './profile.js';
const OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CLOUDCODE_HOSTS = [
    'https://daily-cloudcode-pa.googleapis.com',
    'https://cloudcode-pa.googleapis.com',
];
const QUOTA_SUMMARY_PATH = '/v1internal:retrieveUserQuotaSummary';
const AVAILABLE_MODELS_PATH = '/v1internal:fetchAvailableModels';
const TOKEN_REFRESH_SKEW_MS = 60_000;
const SENSITIVE_KEY_RE = /(?:access_?token|refresh_?token|client_?secret|id_?token|api_?key|authorization)/i;
function sanitizeSecrets(text, secrets) {
    let result = redactSensitiveText(text);
    for (const secret of secrets) {
        if (secret && secret.length >= 4) {
            result = result.split(secret).join('[REDACTED]');
        }
    }
    return result;
}
function sanitizeRawPayload(value, secrets, depth = 0) {
    if (depth > 6 || value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'string') {
        return sanitizeSecrets(value, secrets);
    }
    if (typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeRawPayload(item, secrets, depth + 1));
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (SENSITIVE_KEY_RE.test(k)) {
            out[k] = '[REDACTED]';
        }
        else {
            out[k] = sanitizeRawPayload(v, secrets, depth + 1);
        }
    }
    return out;
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
function readJsonRecordSync(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        const text = fs.readFileSync(filePath, 'utf8');
        if (!text.trim()) {
            return null;
        }
        const parsed = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
function unwrapCredentialRecord(root) {
    for (const key of ['token', 'creds', 'credentials', 'default']) {
        const nested = root[key];
        if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
            return nested;
        }
    }
    return root;
}
function loadOAuthCredentials(paths) {
    const candidates = [
        paths.cliTokenPath,
        paths.tokenPath,
        path.join(paths.geminiHome, 'antigravity_oauth_creds.json'),
        path.join(paths.acpDirectory, 'antigravity_oauth_creds.json'),
    ];
    let accountFallback;
    for (const accountFile of [
        path.join(paths.acpDirectory, 'google_accounts.json'),
        path.join(paths.geminiHome, 'google_accounts.json'),
    ]) {
        const accountsJson = readJsonRecordSync(accountFile);
        if (accountsJson && typeof accountsJson.active === 'string' && accountsJson.active.trim()) {
            accountFallback = accountsJson.active.trim();
            break;
        }
    }
    for (const filePath of candidates) {
        const rawRoot = readJsonRecordSync(filePath);
        if (!rawRoot) {
            continue;
        }
        const record = unwrapCredentialRecord(rawRoot);
        const accessToken = typeof record.access_token === 'string'
            ? record.access_token.trim() || undefined
            : typeof record.accessToken === 'string'
                ? record.accessToken.trim() || undefined
                : undefined;
        const refreshToken = typeof record.refresh_token === 'string'
            ? record.refresh_token.trim() || undefined
            : typeof record.refreshToken === 'string'
                ? record.refreshToken.trim() || undefined
                : undefined;
        const clientId = typeof record.client_id === 'string'
            ? record.client_id.trim() || undefined
            : typeof record.clientId === 'string'
                ? record.clientId.trim() || undefined
                : undefined;
        const clientSecret = typeof record.client_secret === 'string'
            ? record.client_secret.trim() || undefined
            : typeof record.clientSecret === 'string'
                ? record.clientSecret.trim() || undefined
                : undefined;
        const expiryMs = parseTimestampMs(record.expiry_date) ??
            parseTimestampMs(record.expires_at) ??
            parseTimestampMs(record.expiresAt);
        const explicitAccount = typeof record.email === 'string'
            ? record.email.trim() || undefined
            : typeof record.account === 'string'
                ? record.account.trim() || undefined
                : undefined;
        const account = explicitAccount ?? decodeJwtEmail(record.id_token ?? record.idToken) ?? accountFallback;
        if (accessToken || refreshToken) {
            return {
                filePath,
                rawRoot,
                accessToken,
                refreshToken,
                clientId,
                clientSecret,
                expiryMs,
                account,
            };
        }
    }
    return null;
}
function combineSignalWithTimeout(timeoutMs, externalSignal) {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
        if (externalSignal.aborted) {
            controller.abort(externalSignal.reason);
        }
        else {
            externalSignal.addEventListener('abort', onAbort, { once: true });
        }
    }
    let timer;
    if (timeoutMs > 0 && !controller.signal.aborted) {
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort(new Error(`Quota request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    }
    return {
        signal: controller.signal,
        didTimeout: () => timedOut,
        cleanup: () => {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            externalSignal?.removeEventListener('abort', onAbort);
        },
    };
}
async function refreshOAuthToken(creds, fetchImpl, nowMs, platform, signal) {
    if (!creds.refreshToken || !creds.clientId) {
        throw new AntigravityAcpError('Antigravity OAuth token is expired or missing and lacks refresh fields', 'AGY_AUTH_REQUIRED');
    }
    const secrets = [creds.accessToken, creds.refreshToken, creds.clientSecret].filter((v) => Boolean(v));
    const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
    });
    if (creds.clientSecret) {
        form.set('client_secret', creds.clientSecret);
    }
    let response;
    try {
        response = await fetchImpl(OAUTH_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: form.toString(),
            signal,
        });
    }
    catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        throw new AntigravityAcpError(`Failed to refresh OAuth token: ${sanitizeSecrets(error?.message ?? String(error), secrets)}`, 'TRANSPORT', { cause: error });
    }
    const rawText = await response.text().catch(() => '');
    let payload = null;
    try {
        const parsed = rawText ? JSON.parse(rawText) : null;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            payload = parsed;
        }
    }
    catch {
        payload = null;
    }
    if (!response.ok) {
        const errorCode = response.status === 400 || response.status === 401 ? 'AGY_AUTH_REQUIRED' : 'TRANSPORT';
        const detail = payload && typeof payload.error === 'string' ? ` (${payload.error})` : '';
        throw new AntigravityAcpError(`OAuth token refresh failed with HTTP ${response.status}${detail}`, errorCode, { status: response.status });
    }
    const newAccessToken = payload && typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
    if (!newAccessToken) {
        throw new AntigravityAcpError('OAuth token refresh response did not contain an access token', 'AGY_AUTH_REQUIRED');
    }
    secrets.push(newAccessToken);
    const expiresInSec = payload && typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : undefined;
    const newExpiryMs = expiresInSec !== undefined ? nowMs + expiresInSec * 1000 : undefined;
    // Best-effort persistence back to the token file using original casing style
    try {
        const updatedRoot = { ...creds.rawRoot };
        const usesCamel = typeof updatedRoot.accessToken === 'string' || typeof updatedRoot.refreshToken === 'string';
        if (usesCamel) {
            updatedRoot.accessToken = newAccessToken;
            if (newExpiryMs !== undefined) {
                updatedRoot.expiresAt = newExpiryMs;
            }
            if (payload && typeof payload.refresh_token === 'string' && payload.refresh_token.trim()) {
                updatedRoot.refreshToken = payload.refresh_token.trim();
            }
        }
        else {
            updatedRoot.access_token = newAccessToken;
            if (newExpiryMs !== undefined) {
                updatedRoot.expiry_date = newExpiryMs;
            }
            if (payload && typeof payload.refresh_token === 'string' && payload.refresh_token.trim()) {
                updatedRoot.refresh_token = payload.refresh_token.trim();
            }
        }
        await fs.promises.writeFile(creds.filePath, `${JSON.stringify(updatedRoot, null, 2)}\n`, { encoding: 'utf8', mode: platform === 'win32' ? undefined : 0o600 });
    }
    catch {
        // Non-fatal if token file is read-only
    }
    return { accessToken: newAccessToken, secrets };
}
function clamp01(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(1, value));
}
function parseFiniteNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim()) {
        const num = Number(value.trim());
        if (Number.isFinite(num)) {
            return num;
        }
    }
    return undefined;
}
function parseResetDurationSeconds(value) {
    const num = parseFiniteNumber(value);
    if (num !== undefined && num >= 0) {
        return Math.round(num);
    }
    if (typeof value === 'string') {
        const match = /^(\d+(?:\.\d+)?)s$/i.exec(value.trim());
        if (match) {
            return Math.max(0, Math.round(Number(match[1])));
        }
    }
    return undefined;
}
function parseQuotaWindowEntry(rawItem, fallbackId, nowMs) {
    const id = (typeof rawItem.id === 'string' && rawItem.id.trim()) ||
        (typeof rawItem.bucketId === 'string' && rawItem.bucketId.trim()) ||
        (typeof rawItem.modelId === 'string' && rawItem.modelId.trim()) ||
        (typeof rawItem.model === 'string' && rawItem.model.trim()) ||
        (typeof rawItem.family === 'string' && rawItem.family.trim()) ||
        fallbackId;
    const label = (typeof rawItem.label === 'string' && rawItem.label.trim()) ||
        (typeof rawItem.displayName === 'string' && rawItem.displayName.trim()) ||
        (typeof rawItem.name === 'string' && rawItem.name.trim()) ||
        undefined;
    const limit = parseFiniteNumber(rawItem.limit ?? rawItem.quotaLimit);
    const remaining = parseFiniteNumber(rawItem.remaining ?? rawItem.quotaRemaining);
    const unit = typeof rawItem.unit === 'string' && rawItem.unit.trim() ? rawItem.unit.trim() : undefined;
    let remainingFraction = parseFiniteNumber(rawItem.remainingFraction);
    let usedFraction = parseFiniteNumber(rawItem.usedFraction);
    if (remainingFraction === undefined) {
        const remainingPct = parseFiniteNumber(rawItem.remainingPercent ?? rawItem.remainingPercentage);
        if (remainingPct !== undefined) {
            remainingFraction = remainingPct > 1 ? remainingPct / 100 : remainingPct;
        }
    }
    if (remainingFraction === undefined && usedFraction !== undefined) {
        remainingFraction = 1 - usedFraction;
    }
    if (remainingFraction === undefined && limit !== undefined && limit > 0 && remaining !== undefined) {
        remainingFraction = remaining / limit;
    }
    if (remainingFraction !== undefined) {
        remainingFraction = clamp01(remainingFraction);
        if (usedFraction === undefined) {
            usedFraction = clamp01(1 - remainingFraction);
        }
        else {
            usedFraction = clamp01(usedFraction);
        }
    }
    else if (usedFraction !== undefined) {
        usedFraction = clamp01(usedFraction);
        remainingFraction = clamp01(1 - usedFraction);
    }
    const rawResetAt = rawItem.resetAt ?? rawItem.resetTime;
    const resetAt = typeof rawResetAt === 'string' && rawResetAt.trim() ? rawResetAt.trim() : undefined;
    let resetInSeconds = parseResetDurationSeconds(rawItem.resetInSeconds ?? rawItem.resetDuration);
    if (resetInSeconds === undefined && resetAt) {
        const resetMs = Date.parse(resetAt);
        if (Number.isFinite(resetMs)) {
            resetInSeconds = Math.max(0, Math.round((resetMs - nowMs) / 1000));
        }
    }
    return {
        id,
        ...(label ? { label } : {}),
        ...(remainingFraction !== undefined ? { remainingFraction } : {}),
        ...(usedFraction !== undefined ? { usedFraction } : {}),
        ...(resetAt ? { resetAt } : {}),
        ...(resetInSeconds !== undefined ? { resetInSeconds } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(remaining !== undefined ? { remaining } : {}),
        ...(unit ? { unit } : {}),
    };
}
function parseQuotaPayload(payload, nowDate, accountFallback, secrets) {
    const nowMs = nowDate.getTime();
    const windows = [];
    for (const arrayKey of ['buckets', 'quotaBuckets', 'quotaSummaries', 'quotas', 'windows']) {
        const list = payload[arrayKey];
        if (Array.isArray(list)) {
            list.forEach((entry, idx) => {
                if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
                    windows.push(parseQuotaWindowEntry(entry, `bucket-${idx}`, nowMs));
                }
            });
        }
    }
    if (windows.length === 0 && payload.models !== undefined) {
        if (Array.isArray(payload.models)) {
            payload.models.forEach((entry, idx) => {
                if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
                    const obj = entry;
                    const quotaInfo = typeof obj.quotaInfo === 'object' && obj.quotaInfo !== null && !Array.isArray(obj.quotaInfo)
                        ? obj.quotaInfo
                        : {};
                    const merged = { ...obj, ...quotaInfo };
                    if (merged.remainingFraction !== undefined ||
                        merged.usedFraction !== undefined ||
                        merged.remaining !== undefined ||
                        merged.resetTime !== undefined ||
                        merged.resetAt !== undefined) {
                        windows.push(parseQuotaWindowEntry(merged, `model-${idx}`, nowMs));
                    }
                }
            });
        }
        else if (typeof payload.models === 'object' && payload.models !== null) {
            for (const [modelId, rawModel] of Object.entries(payload.models)) {
                if (typeof rawModel !== 'object' || rawModel === null || Array.isArray(rawModel)) {
                    continue;
                }
                const modelObj = rawModel;
                const quotaInfo = typeof modelObj.quotaInfo === 'object' &&
                    modelObj.quotaInfo !== null &&
                    !Array.isArray(modelObj.quotaInfo)
                    ? modelObj.quotaInfo
                    : null;
                if (!quotaInfo && modelObj.remainingFraction === undefined && modelObj.usedFraction === undefined) {
                    continue;
                }
                const merged = {
                    id: modelId,
                    label: typeof modelObj.displayName === 'string' && modelObj.displayName.trim()
                        ? modelObj.displayName.trim()
                        : modelId,
                    ...(quotaInfo ?? modelObj),
                };
                windows.push(parseQuotaWindowEntry(merged, modelId, nowMs));
            }
        }
    }
    const currentTier = typeof payload.currentTier === 'object' && payload.currentTier !== null
        ? payload.currentTier
        : undefined;
    const paidTier = typeof payload.paidTier === 'object' && payload.paidTier !== null
        ? payload.paidTier
        : undefined;
    const tier = (typeof payload.tier === 'string' && payload.tier.trim()) ||
        (typeof payload.userTier === 'string' && payload.userTier.trim()) ||
        (paidTier && typeof paidTier.name === 'string' && paidTier.name.trim()) ||
        (paidTier && typeof paidTier.id === 'string' && paidTier.id.trim()) ||
        (currentTier && typeof currentTier.name === 'string' && currentTier.name.trim()) ||
        (currentTier && typeof currentTier.id === 'string' && currentTier.id.trim()) ||
        undefined;
    const account = (typeof payload.account === 'string' && payload.account.trim()) ||
        (typeof payload.email === 'string' && payload.email.trim()) ||
        accountFallback ||
        undefined;
    const exhausted = payload.exhausted === true ||
        payload.isExhausted === true ||
        windows.some((window) => (window.remainingFraction !== undefined && window.remainingFraction <= 0) ||
            (window.remaining !== undefined && window.remaining <= 0));
    return {
        capturedAt: nowDate.toISOString(),
        ...(account ? { account } : {}),
        ...(tier ? { tier } : {}),
        windows,
        exhausted,
        raw: sanitizeRawPayload(payload, secrets),
    };
}
function parseRetryAfterMs(headers) {
    const raw = headers?.get?.('retry-after');
    if (!raw) {
        return undefined;
    }
    const seconds = Number(raw.trim());
    if (Number.isFinite(seconds) && seconds > 0) {
        return Math.round(seconds * 1000);
    }
    const dateMs = Date.parse(raw.trim());
    if (Number.isFinite(dateMs)) {
        const delta = dateMs - Date.now();
        return delta > 0 ? delta : undefined;
    }
    return undefined;
}
/**
 * Probe Cloud Code Assist quota endpoints using the active profile's OAuth credentials.
 */
export async function probeAntigravityQuota(config, options = {}) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const envInput = options.env ?? process.env;
    const homeDir = options.homeDir ?? os.homedir();
    const activePlatform = options.platform ?? process.platform;
    const now = options.now ?? (() => new Date());
    const timeoutMs = options.timeoutMs ?? config.requestTimeoutMs ?? 30_000;
    if (options.signal?.aborted) {
        throw new AntigravityAcpError('Quota probe aborted', 'ABORTED', {
            cause: options.signal.reason,
        });
    }
    const paths = resolveProfilePaths(config, envInput, homeDir, activePlatform);
    const creds = loadOAuthCredentials(paths);
    if (!creds) {
        throw new AntigravityAcpError('No Antigravity OAuth credentials found for quota probe', 'AGY_AUTH_REQUIRED');
    }
    const secrets = [creds.accessToken, creds.refreshToken, creds.clientSecret].filter((v) => Boolean(v));
    const { signal, didTimeout, cleanup } = combineSignalWithTimeout(timeoutMs, options.signal);
    try {
        let accessToken = creds.accessToken;
        const nowDate = now();
        const isExpiredOrSoon = creds.expiryMs !== undefined && creds.expiryMs <= nowDate.getTime() + TOKEN_REFRESH_SKEW_MS;
        if (!accessToken || isExpiredOrSoon) {
            const refreshed = await refreshOAuthToken(creds, fetchImpl, nowDate.getTime(), activePlatform, signal);
            accessToken = refreshed.accessToken;
            secrets.push(...refreshed.secrets);
        }
        const requestBody = JSON.stringify(config.gcpProject?.trim() ? { project: config.gcpProject.trim() } : {});
        const endpoints = [QUOTA_SUMMARY_PATH, AVAILABLE_MODELS_PATH];
        let lastError = null;
        let lastEmptySnapshot = null;
        for (const endpointPath of endpoints) {
            for (const host of CLOUDCODE_HOSTS) {
                if (signal.aborted) {
                    throw new AntigravityAcpError(didTimeout() ? `Quota probe timed out after ${timeoutMs}ms` : 'Quota probe aborted', didTimeout() ? 'TIMEOUT' : 'ABORTED');
                }
                const url = `${host}${endpointPath}`;
                let res;
                try {
                    res = await fetchImpl(url, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json',
                            Accept: 'application/json',
                        },
                        body: requestBody,
                        signal,
                    });
                }
                catch (error) {
                    if (signal.aborted) {
                        throw new AntigravityAcpError(didTimeout() ? `Quota probe timed out after ${timeoutMs}ms` : 'Quota probe aborted', didTimeout() ? 'TIMEOUT' : 'ABORTED', { cause: error });
                    }
                    lastError = new AntigravityAcpError(`Quota probe network error (${host}): ${sanitizeSecrets(error?.message ?? String(error), secrets)}`, 'TRANSPORT', { cause: error });
                    continue;
                }
                const rawText = await res.text().catch(() => '');
                const safeText = sanitizeSecrets(rawText, secrets);
                let parsedBody = null;
                try {
                    const parsed = rawText ? JSON.parse(rawText) : null;
                    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                        parsedBody = parsed;
                    }
                }
                catch {
                    parsedBody = null;
                }
                if (res.status === 401) {
                    throw new AntigravityAcpError('Antigravity OAuth session expired or unauthorized', 'AGY_AUTH_REQUIRED', { status: 401 });
                }
                if (res.status === 403) {
                    if (/SUSPEND|DISABLED|TERMS_OF_SERVICE|VIOLATION/i.test(safeText)) {
                        throw new AntigravityAcpError('Antigravity account is suspended or disabled', 'AGY_ACCOUNT_SUSPENDED', { status: 403 });
                    }
                    lastError = new AntigravityAcpError(`Antigravity quota endpoint returned HTTP 403`, 'AUTH', { status: 403 });
                    continue;
                }
                if (res.status === 429) {
                    const retryAfterMs = parseRetryAfterMs(res.headers);
                    lastError = new AntigravityAcpError('Antigravity quota probe rate-limited', 'RATE_LIMIT', { status: 429, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
                    continue;
                }
                if (!res.ok) {
                    lastError = new AntigravityAcpError(`Quota endpoint ${endpointPath} failed with HTTP ${res.status}`, 'TRANSPORT', { status: res.status });
                    continue;
                }
                if (!parsedBody) {
                    lastError = new AntigravityAcpError(`Quota endpoint ${endpointPath} returned invalid JSON`, 'TRANSPORT');
                    continue;
                }
                const snapshot = parseQuotaPayload(parsedBody, now(), creds.account, secrets);
                if (snapshot.windows.length > 0 || snapshot.exhausted || endpointPath === AVAILABLE_MODELS_PATH) {
                    return snapshot;
                }
                lastEmptySnapshot = snapshot;
            }
        }
        if (lastEmptySnapshot) {
            return lastEmptySnapshot;
        }
        throw (lastError ??
            new AntigravityAcpError('Failed to query Antigravity quota endpoints', 'TRANSPORT'));
    }
    catch (error) {
        if (error instanceof AntigravityAcpError) {
            throw error;
        }
        if (didTimeout()) {
            throw new AntigravityAcpError(`Quota probe timed out after ${timeoutMs}ms`, 'TIMEOUT', {
                cause: error,
            });
        }
        if (options.signal?.aborted) {
            throw new AntigravityAcpError('Quota probe aborted', 'ABORTED', { cause: error });
        }
        throw new AntigravityAcpError(`Quota probe failed: ${sanitizeSecrets(error?.message ?? String(error), secrets)}`, 'TRANSPORT', { cause: error });
    }
    finally {
        cleanup();
    }
}
//# sourceMappingURL=quota.js.map