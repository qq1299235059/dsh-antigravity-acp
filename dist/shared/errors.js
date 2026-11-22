import { HarnessError, LlmError, } from '@deepseek-ai/dsh-llm';
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const PROXY_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+(?::[^/\s@]*)?)@/gi;
const QUOTED_SECRET_KV_PATTERN = /((["'])(?:access_token|refresh_token|client_secret|api_?key|GEMINI_API_KEY|GOOGLE_API_KEY)\2\s*[:=]\s*)(["'])(?:\\.|(?!\3)[^\\])*\3/gi;
const UNQUOTED_SECRET_KV_PATTERN = /(\b(?:access_token|refresh_token|client_secret|api_?key|GEMINI_API_KEY|GOOGLE_API_KEY)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&;,)"'}\]]+)/gi;
const OAUTH_QUERY_PARAM_PATTERN = /([?&#](?:code|state)=)([^&#\s"']+)/gi;
const OAUTH_LEADING_PARAM_PATTERN = /^((?:code|state)=)([^&#\s"']+)/gim;
const GOOGLE_API_KEY_PATTERN = /\bAIza[0-9A-Za-z\-_]{20,}/g;
const GOOGLE_OAUTH_ACCESS_PATTERN = /\bya29\.[0-9A-Za-z\-_]+/g;
/**
 * Strip credentials, OAuth tokens/codes, API keys, and proxy userinfo from diagnostic text.
 */
export function redactSensitiveText(text) {
    if (!text) {
        return text;
    }
    return text
        .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
        .replace(PROXY_USERINFO_PATTERN, '$1[REDACTED]@')
        .replace(QUOTED_SECRET_KV_PATTERN, '$1$3[REDACTED]$3')
        .replace(UNQUOTED_SECRET_KV_PATTERN, '$1[REDACTED]')
        .replace(OAUTH_QUERY_PARAM_PATTERN, '$1[REDACTED]')
        .replace(OAUTH_LEADING_PARAM_PATTERN, '$1[REDACTED]')
        .replace(GOOGLE_API_KEY_PATTERN, '[REDACTED]')
        .replace(GOOGLE_OAUTH_ACCESS_PATTERN, '[REDACTED]');
}
/**
 * Typed error raised by the Antigravity ACP runtime, bridge, and plugins.
 */
export class AntigravityAcpError extends Error {
    code;
    status;
    retryAfterMs;
    constructor(message, code, options) {
        const safeMessage = redactSensitiveText(message).trim() || code;
        super(safeMessage, options);
        this.name = 'AntigravityAcpError';
        this.code = code;
        this.status = options?.status;
        this.retryAfterMs = options?.retryAfterMs;
    }
}
function sanitizeHttpStatus(status) {
    if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
        return status;
    }
    return undefined;
}
function sanitizeRetryAfterMs(retryAfterMs) {
    if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return retryAfterMs;
    }
    return undefined;
}
const BUILTIN_LLM_FAILURE_CODES = new Set([
    'ABORTED',
    'ACCOUNT_QUOTA',
    'ACCOUNT_SIGN_IN_REQUIRED',
    'ACCOUNT_TOKEN_INVALID',
    'AUTH',
    'CLIENT_UPGRADE_REQUIRED',
    'CONTEXT_WINDOW_EXCEEDED',
    'DISCOVERY_FAILED',
    'DISCOVERY_UNSUPPORTED',
    'DUPLICATE_ADAPTER',
    'DUPLICATE_DIRECTORY',
    'DUPLICATE_DISCOVERY',
    'EMPTY_RESPONSE',
    'FILES_API',
    'IMAGE_OFFLOAD_REQUIRED',
    'INVALID_ADAPTER',
    'INVALID_CATALOG',
    'INVALID_CONFIG',
    'INVALID_CREDENTIAL',
    'INVALID_DIRECTORY',
    'INVALID_DISCOVERY',
    'INVALID_MODEL_CONTEXT',
    'INVALID_MODEL_INFO',
    'INVALID_MODEL_MAX_TOKENS',
    'INVALID_MODEL_REASONING',
    'INVALID_PREPARED_CALL',
    'INVALID_REPLAY_STATE',
    'INVALID_REQUEST',
    'INVALID_RESPONSE',
    'MALFORMED_RESPONSE',
    'MISSING_CREDENTIAL',
    'MODEL_SWITCH_COMPACTION_FAILED',
    'MODEL_UNSUPPORTED',
    'NO_ADAPTER',
    'NO_CREDENTIAL_STORE',
    'NO_DISCOVERY',
    'PI_AI_ERROR',
    'QUOTA',
    'RATE_LIMIT',
    'REGISTRATION_DISPOSED',
    'REQUEST_EXTENSION',
    'REQUEST_HEADERS',
    'SERVER',
    'STREAM_CLOSED',
    'TIMEOUT',
    'TRANSPORT',
    'UNKNOWN',
    'UNKNOWN_MODEL',
    'UNSTORABLE_PROVIDER_ID',
    'UNSUPPORTED_CONTENT',
    'UNSUPPORTED_OPTION',
    'UNSUPPORTED_REASONING_EFFORT',
]);
function isBuiltinLlmFailureCode(code) {
    return BUILTIN_LLM_FAILURE_CODES.has(code);
}
function buildCustomLlmError(failure, cause) {
    if (typeof LlmError.fromFailure === 'function') {
        return LlmError.fromFailure(failure, { cause });
    }
    const opts = {
        cause,
        ...(failure.status !== undefined ? { status: failure.status } : {}),
        ...(failure.providerRetryAfterMs !== undefined
            ? { providerRetryAfterMs: failure.providerRetryAfterMs }
            : {}),
    };
    return new LlmError(failure.message, failure.code, opts);
}
/**
 * Convert an arbitrary failure into a {@link LlmError}.
 *
 * Built-in failure codes construct {@link LlmError} directly; custom `AGY_*` codes use
 * {@link LlmError.fromFailure} when available (`dsh-llm >= 0.2.2-rc.3`) and fall back
 * to `new LlmError(...)` on older `0.2.2-rc.1`/`0.2.2-rc.2` releases.
 */
export function toLlmError(error) {
    if (error instanceof LlmError) {
        return error;
    }
    if (error instanceof AntigravityAcpError) {
        const message = redactSensitiveText(error.message).trim() || error.code;
        const status = sanitizeHttpStatus(error.status);
        const providerRetryAfterMs = sanitizeRetryAfterMs(error.retryAfterMs);
        if (isBuiltinLlmFailureCode(error.code)) {
            const opts = {
                cause: error,
                ...(status !== undefined ? { status } : {}),
                ...(providerRetryAfterMs !== undefined ? { providerRetryAfterMs } : {}),
            };
            return new LlmError(message, error.code, opts);
        }
        const failure = {
            code: error.code,
            message,
            ...(status !== undefined ? { status } : {}),
            ...(providerRetryAfterMs !== undefined ? { providerRetryAfterMs } : {}),
        };
        return buildCustomLlmError(failure, error);
    }
    if (error instanceof HarnessError) {
        const message = redactSensitiveText(error.message).trim() || error.code || 'Harness error';
        if (isBuiltinLlmFailureCode(error.code)) {
            return new LlmError(message, error.code, { cause: error });
        }
        return buildCustomLlmError({ code: error.code || 'TRANSPORT', message }, error);
    }
    if (error instanceof Error) {
        const code = error.name === 'AbortError' ? 'ABORTED' : 'TRANSPORT';
        const message = redactSensitiveText(error.message).trim() || error.name || 'Antigravity transport error';
        return new LlmError(message, code, { cause: error });
    }
    const rawText = typeof error === 'string' ? error : String(error ?? 'Unknown Antigravity error');
    const message = redactSensitiveText(rawText).trim() || 'Unknown Antigravity error';
    return new LlmError(message, 'TRANSPORT', { cause: error });
}
//# sourceMappingURL=errors.js.map