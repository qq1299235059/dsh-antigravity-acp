import z from '@deepseek-ai/schemastery';
export const AuthMethodSchema = z
    .union([
    z.const('oauth-personal'),
    z.const('oauth-business'),
    z.const('gemini-api-key'),
    z.const('agent-platform'),
])
    .default('oauth-personal')
    .description('Authentication method for the Antigravity ACP agent.');
export const PermissionModeSchema = z
    .union([
    z.const('default'),
    z.const('auto_edit'),
    z.const('auto'),
    z.const('yolo'),
])
    .default('default')
    .description('Permission handling policy for ACP subagent tool requests.');
export const PermissionFallbackSchema = z
    .union([z.const('reject'), z.const('cancel')])
    .default('reject')
    .description('Fallback decision when permissionMode is default.');
const ModelOverrideConfigSchema = z.object({
    name: z.string().min(1),
    description: z.string(),
    contextWindow: z.natural().min(1),
    defaultMaxTokens: z.natural().min(1),
    inputModalities: z.array(z.union([z.const('text'), z.const('image')])),
    defaultThoughtLevel: z.string().min(1),
});
export const RuntimeConfigSchema = z.object({
    authMethod: AuthMethodSchema,
    apiKey: z.string().role('secret').description('Explicit API key for gemini-api-key or agent-platform auth.'),
    apiKeyEnv: z.string().min(1).description('Environment variable name holding the API key.'),
    gcpProject: z.string().min(1).description('Google Cloud project id for enterprise/business auth.'),
    gcpLocation: z.string().min(1).description('Google Cloud location/region for enterprise/business auth.'),
    binaryPath: z.string().min(1).description('Explicit path to the Antigravity CLI/ACP executable.'),
    autoDownload: z.boolean().default(true).description('Automatically install or cache the Antigravity runtime if absent.'),
    cacheDir: z.string().min(1).description('Cache directory for downloaded runtime artifacts.'),
    profileDir: z.string().min(1).description('Isolated Antigravity profile directory for auth and state.'),
    proxyUrl: z.string().min(1).description('Outbound HTTP/HTTPS/SOCKS proxy URL.'),
    proxyBypass: z.string().description('Comma-separated NO_PROXY host list.'),
    extraArgs: z.array(z.string()).default([]).description('Additional CLI arguments appended to the ACP launch command.'),
    maxConcurrentSessions: z
        .natural()
        .min(1)
        .max(4)
        .default(2)
        .description('Maximum concurrent leased ACP worker sessions (1-4).'),
    queueTimeoutMs: z.natural().min(1).default(120_000).description('Maximum time to wait for a worker lease in milliseconds.'),
    handshakeTimeoutMs: z.natural().min(1).default(120_000).description('ACP spawn and initialize handshake timeout in milliseconds.'),
    requestTimeoutMs: z.natural().min(1).default(30_000).description('Timeout for short ACP control requests in milliseconds.'),
    authTimeoutMs: z.natural().min(1).default(300_000).description('Interactive authentication flow timeout in milliseconds.'),
    promptTimeoutMs: z.natural().min(1).default(1_800_000).description('Maximum duration for a single ACP prompt turn in milliseconds.'),
    idleRecycleMs: z.natural().min(0).default(300_000).description('Idle worker recycle delay in milliseconds.'),
    autoWarmup: z.boolean().default(false).description('Warm up runtime binary and model catalog on service startup.'),
});
export const LlmPluginConfigSchema = z.object({
    providerId: z.string().min(1).default('antigravity-acp').description('Registered DSH LLM provider route id.'),
    providerName: z.string().min(1).default('Antigravity ACP').description('Display name for the registered LLM provider.'),
    defaultModel: z.string().min(1).description('Fallback model id when callers select an unspecified model.'),
    contextWindow: z.natural().min(1).default(128_000).description('Default context window reported for discovered models.'),
    reuseSessions: z.boolean().default(true).description('Reuse ACP sessions when request history strictly appends to the prior turn.'),
    ignoreUnsupportedOptions: z.boolean().default(true).description('Ignore unsupported sampling options like temperature/stop instead of throwing.'),
    toolTimeoutMs: z.natural().min(1).default(300_000).description('Timeout waiting for DSH tool execution roundtrip in milliseconds.'),
    bridgeParkSettleMs: z.natural().min(0).default(50).description('Grace settle window for parking MCP bridge tool calls in milliseconds.'),
    maxPromptBytes: z.natural().min(1).default(1_000_000).description('Maximum serialized prompt payload size in bytes.'),
    modelOverrides: z
        .dict(ModelOverrideConfigSchema)
        .default({})
        .description('Per-model metadata overrides keyed by model id.'),
});
export const SubagentPluginConfigSchema = z.object({
    providerName: z.string().min(1).default('antigravity').description('Registered DSH subagent provider name.'),
    permissionMode: PermissionModeSchema,
    permissionFallback: PermissionFallbackSchema,
    defaultModel: z.string().min(1).description('Default model id for spawned subagent sessions.'),
    defaultThoughtLevel: z.string().min(1).description('Default thinking/reasoning level for spawned subagent sessions.'),
    systemPromptAppend: z.string().description('Additional instructions appended to subagent prompts.'),
    disposeEofGraceMs: z.natural().min(1).default(6_000).description('Grace wait for ACP process EOF during subagent disposal in milliseconds.'),
    disposeGraceMs: z.natural().min(1).default(3_000).description('Subprocess termination escalation grace period in milliseconds.'),
});
//# sourceMappingURL=config.js.map