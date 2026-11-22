import z from '@deepseek-ai/schemastery';
/** Supported authentication strategies for the Antigravity ACP agent. */
export type AntigravityAuthMethod = 'oauth-personal' | 'oauth-business' | 'gemini-api-key' | 'agent-platform';
/** Permission handling modes for ACP tool-permission requests in subagents. */
export type AntigravityPermissionMode = 'default' | 'auto_edit' | 'auto' | 'yolo';
/** Fallback decision when `permissionMode` is `'default'` and interactive approval is unavailable. */
export type AntigravityPermissionFallback = 'reject' | 'cancel';
/** Per-model metadata override configured for the LLM plugin. */
export interface ModelOverrideConfig {
    name?: string;
    description?: string;
    contextWindow?: number;
    defaultMaxTokens?: number;
    inputModalities?: readonly ('text' | 'image')[];
    defaultThoughtLevel?: string;
}
/** Configuration for the shared `antigravityRuntime` Cordis service. */
export interface RuntimeConfig {
    authMethod: AntigravityAuthMethod;
    apiKey?: string;
    apiKeyEnv?: string;
    gcpProject?: string;
    gcpLocation?: string;
    binaryPath?: string;
    autoDownload: boolean;
    cacheDir?: string;
    profileDir?: string;
    proxyUrl?: string;
    proxyBypass?: string;
    extraArgs: string[];
    maxConcurrentSessions: number;
    queueTimeoutMs: number;
    handshakeTimeoutMs: number;
    requestTimeoutMs: number;
    authTimeoutMs: number;
    promptTimeoutMs: number;
    idleRecycleMs: number;
    autoWarmup: boolean;
}
/** Input type accepted by {@link RuntimeConfigSchema}. */
export type RuntimeConfigInput = Partial<RuntimeConfig>;
/** Configuration for the `dsh-antigravity-acp/llm` adapter plugin. */
export interface LlmPluginConfig {
    providerId: string;
    providerName: string;
    defaultModel?: string;
    contextWindow: number;
    reuseSessions: boolean;
    ignoreUnsupportedOptions: boolean;
    toolTimeoutMs: number;
    bridgeParkSettleMs: number;
    maxPromptBytes: number;
    modelOverrides: Record<string, ModelOverrideConfig>;
}
/** Input type accepted by {@link LlmPluginConfigSchema}. */
export type LlmPluginConfigInput = Partial<LlmPluginConfig>;
/** Configuration for the `dsh-antigravity-acp/subagent` provider plugin. */
export interface SubagentPluginConfig {
    providerName: string;
    permissionMode: AntigravityPermissionMode;
    permissionFallback: AntigravityPermissionFallback;
    defaultModel?: string;
    defaultThoughtLevel?: string;
    systemPromptAppend?: string;
    disposeEofGraceMs: number;
    disposeGraceMs: number;
}
/** Input type accepted by {@link SubagentPluginConfigSchema}. */
export type SubagentPluginConfigInput = Partial<SubagentPluginConfig>;
export declare const AuthMethodSchema: z<AntigravityAuthMethod>;
export declare const PermissionModeSchema: z<AntigravityPermissionMode>;
export declare const PermissionFallbackSchema: z<AntigravityPermissionFallback>;
export declare const RuntimeConfigSchema: z<RuntimeConfigInput, RuntimeConfig>;
export declare const LlmPluginConfigSchema: z<LlmPluginConfigInput, LlmPluginConfig>;
export declare const SubagentPluginConfigSchema: z<SubagentPluginConfigInput, SubagentPluginConfig>;
//# sourceMappingURL=config.d.ts.map