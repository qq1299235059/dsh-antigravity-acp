import { LlmError } from '@deepseek-ai/dsh-llm';
/** Built-in DSH LLM failure codes surfaced directly by the Antigravity ACP plugin. */
export type AntigravityBuiltinErrorCode = 'AUTH' | 'RATE_LIMIT' | 'QUOTA' | 'TIMEOUT' | 'TRANSPORT' | 'ABORTED' | 'CONTEXT_WINDOW_EXCEEDED' | 'EMPTY_RESPONSE' | 'UNSUPPORTED_OPTION' | 'UNSUPPORTED_CONTENT' | 'UNKNOWN_MODEL' | 'INVALID_REQUEST';
/** Antigravity-specific extension failure codes outside {@link LLM_FAILURE_CODES}. */
export type AntigravityCustomErrorCode = 'AGY_NOT_INSTALLED' | 'AGY_INSTALL_FAILED' | 'AGY_VERSION_UNSUPPORTED' | 'AGY_AUTH_REQUIRED' | 'AGY_NATIVE_TOOLS_BLOCKED' | 'AGY_TOOL_TIMEOUT' | 'AGY_TOOL_RESULTS_MISSING' | 'AGY_TOOL_CATALOG_INVALID' | 'AGY_SESSION_LIMIT' | 'AGY_PROXY_INVALID' | 'AGY_ACCOUNT_SUSPENDED';
/** Complete machine-routable error code taxonomy for the Antigravity ACP plugin. */
export type AntigravityErrorCode = AntigravityBuiltinErrorCode | AntigravityCustomErrorCode;
/** Options accepted by {@link AntigravityAcpError}. */
export interface AntigravityAcpErrorOptions extends ErrorOptions {
    /** Valid HTTP status observed at the provider or transport boundary. */
    status?: number;
    /** Provider-requested retry delay in milliseconds. */
    retryAfterMs?: number;
}
/**
 * Strip credentials, OAuth tokens/codes, API keys, and proxy userinfo from diagnostic text.
 */
export declare function redactSensitiveText(text: string): string;
/**
 * Typed error raised by the Antigravity ACP runtime, bridge, and plugins.
 */
export declare class AntigravityAcpError extends Error {
    readonly code: AntigravityErrorCode;
    readonly status?: number;
    readonly retryAfterMs?: number;
    constructor(message: string, code: AntigravityErrorCode, options?: AntigravityAcpErrorOptions);
}
/**
 * Convert an arbitrary failure into a {@link LlmError}.
 *
 * Built-in failure codes construct {@link LlmError} directly; custom `AGY_*` codes use
 * {@link LlmError.fromFailure} when available (`dsh-llm >= 0.2.2-rc.3`) and fall back
 * to `new LlmError(...)` on older `0.2.2-rc.1`/`0.2.2-rc.2` releases.
 */
export declare function toLlmError(error: unknown): LlmError;
//# sourceMappingURL=errors.d.ts.map