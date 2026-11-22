import z from '@deepseek-ai/schemastery';

/** Supported authentication strategies for the Antigravity ACP agent. */
export type AntigravityAuthMethod =
  | 'oauth-personal'
  | 'oauth-business'
  | 'gemini-api-key'
  | 'agent-platform';

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

export const AuthMethodSchema: z<AntigravityAuthMethod> = z
  .union([
    z.const('oauth-personal'),
    z.const('oauth-business'),
    z.const('gemini-api-key'),
    z.const('agent-platform'),
  ])
  .default('oauth-personal')
  .description('Authentication method for the Antigravity ACP agent.');

export const PermissionModeSchema: z<AntigravityPermissionMode> = z
  .union([
    z.const('default'),
    z.const('auto_edit'),
    z.const('auto'),
    z.const('yolo'),
  ])
  .default('default')
  .description('Permission handling policy for ACP subagent tool requests.');

export const PermissionFallbackSchema: z<AntigravityPermissionFallback> = z
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

export const RuntimeConfigSchema: z<RuntimeConfigInput, RuntimeConfig> = z.object({
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
}) as unknown as z<RuntimeConfigInput, RuntimeConfig>;

export const LlmPluginConfigSchema: z<LlmPluginConfigInput, LlmPluginConfig> = z.object({
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
}) as unknown as z<LlmPluginConfigInput, LlmPluginConfig>;

export const SubagentPluginConfigSchema: z<SubagentPluginConfigInput, SubagentPluginConfig> = z.object({
  providerName: z.string().min(1).default('antigravity').description('Registered DSH subagent provider name.'),
  permissionMode: PermissionModeSchema,
  permissionFallback: PermissionFallbackSchema,
  defaultModel: z.string().min(1).description('Default model id for spawned subagent sessions.'),
  defaultThoughtLevel: z.string().min(1).description('Default thinking/reasoning level for spawned subagent sessions.'),
  systemPromptAppend: z.string().description('Additional instructions appended to subagent prompts.'),
  disposeEofGraceMs: z.natural().min(1).default(6_000).description('Grace wait for ACP process EOF during subagent disposal in milliseconds.'),
  disposeGraceMs: z.natural().min(1).default(3_000).description('Subprocess termination escalation grace period in milliseconds.'),
}) as unknown as z<SubagentPluginConfigInput, SubagentPluginConfig>;
