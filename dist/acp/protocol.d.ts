import type * as acp from '@agentclientprotocol/sdk';
import type { DiscoveredModel } from '../shared/contracts.js';
/** Legacy ACP model entry shape returned by agents predating `configOptions`. */
export interface AcpModelInfo {
    readonly modelId: string;
    readonly name: string;
    readonly description?: string | null;
    readonly _meta?: Record<string, unknown> | null;
}
/** Legacy ACP session model state shape returned alongside or instead of `configOptions`. */
export interface AcpSessionModelState {
    readonly currentModelId?: string | null;
    readonly availableModels: readonly AcpModelInfo[];
}
/** Permission decision kinds supported by {@link selectPermissionOption}. */
export type PermissionDecisionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
/**
 * Select the ACP `clientInfo` payload appropriate for the target Antigravity CLI version.
 *
 * Antigravity CLI `< 1.5.1` expects the legacy `'zed'` client identity, while `>= 1.5.1`
 * (and unknown versions where `>= 1.5.0` is assumed) identifies as `dsh-antigravity-acp`.
 */
export declare function antigravityClientInfo(version?: string | null): acp.Implementation;
/**
 * Check whether an agent advertises Antigravity's `_meta.antigravity.systemPrompt.append` capability.
 */
export declare function antigravityAppendsSystemPrompt(capabilities?: acp.AgentCapabilities | null): boolean;
/**
 * Build ACP `session/new` `_meta` carrying `antigravity.systemPrompt.append` when supported.
 */
export declare function antigravitySessionMeta(capabilities?: acp.AgentCapabilities | null, systemPromptAppend?: string | null): Record<string, unknown> | undefined;
/**
 * Normalize a configured permission/session mode to one accepted by Antigravity ACP.
 *
 * Antigravity CLI rejects `'yolo'` and `'auto_edit'` in `session/set_mode`, so both map to
 * `'default'`. `'auto'` is preserved only when advertised in `availableModes`.
 */
export declare function antigravitySessionMode(modeId: string, availableModes?: readonly {
    readonly id: string;
}[] | null): string;
/**
 * Pick the best matching {@link acp.PermissionOption} for a target decision kind.
 *
 * Never crosses the allow/reject boundary when falling back between `once` and `always`.
 */
export declare function selectPermissionOption(options: readonly acp.PermissionOption[], decision: PermissionDecisionKind): acp.PermissionOption | undefined;
/**
 * Parse ACP `configOptions` (and legacy `models` fallback) into normalized {@link DiscoveredModel}s.
 */
export declare function parseModelsAndThinking(setup: {
    readonly configOptions?: readonly acp.SessionConfigOption[] | null;
    readonly models?: AcpSessionModelState | null;
}): DiscoveredModel[];
/**
 * Determine whether an ACP or runtime error indicates interactive sign-in is required.
 */
export declare function isSignInRequiredError(error: unknown, depth?: number): boolean;
/**
 * Check whether tool-call `_meta` marks an MCP-bridged tool invocation rather than a native CLI tool.
 */
export declare function isMcpToolCallMeta(meta: unknown): boolean;
/**
 * Determine whether an Antigravity tool call spawns background work that can outlive the prompt turn.
 */
export declare function antigravityToolOutlivesPrompt(toolCall: {
    readonly kind?: string | null;
    readonly title?: string | null;
    readonly name?: string | null;
    readonly rawInput?: unknown;
}): boolean;
/**
 * Map an ACP {@link acp.StopReason} to DSH's coarse LLM stop-reason category.
 */
export declare function normalizeStopReasonToLlm(reason: acp.StopReason | string): 'stop' | 'max-tokens' | 'error';
//# sourceMappingURL=protocol.d.ts.map