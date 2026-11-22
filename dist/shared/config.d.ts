import z from '@deepseek-ai/schemastery';
/** Supported authentication strategies for the Antigravity ACP agent. */
export type AntigravityAuthMethod = 'oauth-personal' | 'oauth-business' | 'gemini-api-key' | 'agent-platform';
/** Permission handling modes for ACP tool-permission requests in subagents. */
export type AntigravityPermissionMode = 'default' | 'auto_edit' | 'auto' | 'yolo';
/** Fallback decision when `permissionMode` is `'default'` and interactive approval is unavailable. */
export type AntigravityPermissionFallback = 'reject' | 'cancel';
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
/** Configuration for the `dsh-antigravity-acp/subagent` provider & tool plugin. */
export interface SubagentPluginConfig {
    providerName: string;
    toolName: string;
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
/** UI-persisted overrides for Antigravity subagent defaults. */
export interface SubagentUiOverrides {
    readonly defaultModel?: string;
    readonly defaultThoughtLevel?: string;
    readonly permissionMode?: AntigravityPermissionMode;
    readonly permissionFallback?: AntigravityPermissionFallback;
    readonly systemPromptAppend?: string;
}
export declare const AuthMethodSchema: z<AntigravityAuthMethod>;
export declare const PermissionModeSchema: z<AntigravityPermissionMode>;
export declare const PermissionFallbackSchema: z<AntigravityPermissionFallback>;
export declare const RuntimeConfigSchema: z<RuntimeConfigInput, RuntimeConfig>;
export declare const SubagentPluginConfigSchema: z<SubagentPluginConfigInput, SubagentPluginConfig>;
//# sourceMappingURL=config.d.ts.map