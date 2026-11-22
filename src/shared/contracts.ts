import type * as acp from '@agentclientprotocol/sdk';
import type { ModelModality } from '@deepseek-ai/dsh-llm';
import type { AntigravityAuthMethod, RuntimeConfig } from './config.js';

/** Resolved Antigravity CLI/ACP executable details. */
export interface AntigravityExecutable {
  /** Executable command or absolute path in the subprocess execution world. */
  readonly command: string;
  /** Leading arguments required before ACP flags (e.g. `['acp']` or `[]`). */
  readonly argsPrefix: readonly string[];
  /** How the executable was resolved. */
  readonly source: 'configured' | 'path' | 'cached' | 'downloaded';
  /** Reported CLI/runtime version when known. */
  readonly version?: string;
  /** Cache directory owning a cached or downloaded runtime. */
  readonly cacheDir?: string;
}

/** Isolated Antigravity runtime profile and authentication state. */
export interface AntigravityProfile {
  /** Absolute path to the isolated profile directory. */
  readonly profileDir: string;
  /** Active authentication method configured for this profile. */
  readonly authMethod: AntigravityAuthMethod;
  /** Whether usable credentials or an authenticated session are available. */
  readonly authenticated: boolean;
  /** Authenticated account identifier (email or label) when known. */
  readonly account?: string;
  /** Google Cloud project id when configured. */
  readonly gcpProject?: string;
  /** Google Cloud location when configured. */
  readonly gcpLocation?: string;
  /** Whether an API key was resolved from config or environment. */
  readonly hasApiKey: boolean;
}

/** One selectable thinking/reasoning option advertised by an Antigravity model. */
export interface ThinkingOption {
  /** Stable identifier passed as `reasoningEffort` / `thought_level`. */
  readonly id: string;
  /** Human-readable display label. */
  readonly name: string;
  /** Optional description for UI selectors. */
  readonly description?: string;
  /** Backing ACP `SessionConfigOption` id when derived from session config options. */
  readonly configId?: string;
}

/** Model advertised by the Antigravity ACP backend or static/cached fallback catalog. */
export interface DiscoveredModel {
  /** Exact model identifier accepted by the ACP agent. */
  readonly id: string;
  /** Human-readable model name. */
  readonly name: string;
  /** Optional model summary or capability notes. */
  readonly description?: string;
  /** Maximum context window in tokens when known. */
  readonly contextWindow?: number;
  /** Maximum output tokens when known. */
  readonly maxTokens?: number;
  /** Input modalities accepted by this model. */
  readonly inputModalities?: readonly ModelModality[];
  /** Supported thinking/reasoning levels for this model. */
  readonly thinkingOptions?: readonly ThinkingOption[];
  /** Default thinking/reasoning level id when advertised. */
  readonly defaultThoughtLevel?: string;
  /** Whether this model is advertised as the session default. */
  readonly isDefault?: boolean;
}

/** Single quota window entry (e.g. per model family or bucket). */
export interface QuotaWindow {
  /** Stable bucket/window identifier. */
  readonly id: string;
  /** Human-readable label for display. */
  readonly label?: string;
  /** Fraction of quota remaining (`0..1`) when reported. */
  readonly remainingFraction?: number;
  /** Fraction of quota consumed (`0..1`) when reported. */
  readonly usedFraction?: number;
  /** ISO-8601 reset timestamp when reported. */
  readonly resetAt?: string;
  /** Seconds until quota reset when reported. */
  readonly resetInSeconds?: number;
  /** Raw numeric limit when reported. */
  readonly limit?: number;
  /** Raw numeric remaining units when reported. */
  readonly remaining?: number;
  /** Unit name for numeric limit/remaining fields. */
  readonly unit?: string;
}

/** Aggregated quota snapshot observed for the active profile/account. */
export interface QuotaSnapshot {
  /** ISO-8601 timestamp when this snapshot was captured. */
  readonly capturedAt: string;
  /** Account identifier associated with this snapshot when known. */
  readonly account?: string;
  /** Plan or subscription tier when known. */
  readonly tier?: string;
  /** Individual quota windows reported by the agent. */
  readonly windows: readonly QuotaWindow[];
  /** Whether any active quota window is currently exhausted. */
  readonly exhausted: boolean;
  /** Optional raw metadata payload preserved for diagnostics. */
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** Normalized summary of the ACP `initialize` handshake response. */
export interface AcpInitializeSummary {
  readonly protocolVersion: acp.ProtocolVersion;
  readonly agentName?: string;
  readonly agentVersion?: string;
  readonly agentTitle?: string;
  readonly authMethods: readonly acp.AuthMethod[];
  readonly capabilities?: acp.AgentCapabilities;
  readonly supportsImages: boolean;
  readonly supportsAudio: boolean;
  readonly supportsEmbeddedContext: boolean;
  readonly supportsLoadSession: boolean;
  readonly supportsMcpHttp: boolean;
  readonly supportsMcpSse: boolean;
}

/** Streaming and client-request callbacks bound to an active ACP prompt turn. */
export interface AcpTurnCallbacks {
  readonly onAuthUrl?: (url: string) => void;
  readonly onSessionUpdate?: (notification: acp.SessionNotification) => void | Promise<void>;
  readonly onTextDelta?: (text: string, messageId?: string | null) => void;
  readonly onThoughtDelta?: (text: string, messageId?: string | null) => void;
  readonly onToolCall?: (update: acp.ToolCall & { sessionUpdate: 'tool_call' }) => void;
  readonly onToolCallUpdate?: (
    update: acp.ToolCallUpdate & { sessionUpdate: 'tool_call_update' },
  ) => void;
  readonly onUsageUpdate?: (usage: acp.UsageUpdate) => void;
  readonly onPlan?: (plan: acp.Plan) => void;
  readonly onConfigOptionsUpdate?: (options: readonly acp.SessionConfigOption[]) => void;
  readonly onModeUpdate?: (modeId: string) => void;
  readonly onRequestPermission?: (
    request: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse> | acp.RequestPermissionResponse;
  readonly onReadTextFile?: (
    request: acp.ReadTextFileRequest,
  ) => Promise<acp.ReadTextFileResponse> | acp.ReadTextFileResponse;
  readonly onWriteTextFile?: (
    request: acp.WriteTextFileRequest,
  ) => Promise<acp.WriteTextFileResponse | void> | acp.WriteTextFileResponse | void;
}

/** Parameters used to establish or configure an ACP session before prompting. */
export interface AcpSessionSetup {
  /** Absolute working directory for the ACP session. */
  readonly cwd: string;
  /** Additional absolute workspace directories. */
  readonly additionalDirectories?: readonly string[];
  /** MCP servers exposed to this session (e.g. the DSH tool bridge). */
  readonly mcpServers?: readonly acp.McpServer[];
  /** Requested model id. */
  readonly model?: string;
  /** Requested thinking/reasoning level id. */
  readonly thoughtLevel?: string;
  /** Requested session mode id. */
  readonly mode?: string;
  /** Optional system prompt text forwarded via setup metadata or preamble. */
  readonly systemPrompt?: string;
  /** Existing ACP session id to load/resume/reuse when available. */
  readonly sessionId?: string;
  /** Whether an existing matching session may be reused. */
  readonly reuseSession?: boolean;
  /** Optional ACP `_meta` entries for `session/new`. */
  readonly meta?: Record<string, unknown>;
}

/** Final outcome of one ACP `session/prompt` turn. */
export interface AcpPromptResult {
  readonly sessionId: acp.SessionId;
  readonly stopReason: acp.StopReason;
  readonly text: string;
  readonly reasoning: string;
  readonly usage?: acp.Usage | null;
  readonly configOptions?: readonly acp.SessionConfigOption[];
  readonly modes?: acp.SessionModeState | null;
  readonly quota?: QuotaSnapshot;
  readonly meta?: Record<string, unknown> | null;
}

/** Live ACP client connection backed by a managed Antigravity subprocess. */
export interface AcpClientHandle {
  readonly id: string;
  readonly initialized: AcpInitializeSummary;
  readonly executable: AntigravityExecutable;
  readonly profile: AntigravityProfile;
  readonly closed: Promise<void>;
  readonly isClosed: boolean;
  authenticate(methodId?: string, signal?: AbortSignal): Promise<void>;
  logout?(signal?: AbortSignal): Promise<void>;
  setCallbacks?(callbacks?: AcpTurnCallbacks): void;
  newSession(setup: AcpSessionSetup, signal?: AbortSignal): Promise<acp.NewSessionResponse>;
  loadSession?(
    params: acp.LoadSessionRequest,
    signal?: AbortSignal,
  ): Promise<acp.LoadSessionResponse>;
  setSessionModel?(
    sessionId: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<readonly acp.SessionConfigOption[] | undefined>;
  setSessionThoughtLevel?(
    sessionId: string,
    level: string,
    signal?: AbortSignal,
  ): Promise<readonly acp.SessionConfigOption[] | undefined>;
  setSessionMode(sessionId: string, modeId: string, signal?: AbortSignal): Promise<void>;
  setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
    signal?: AbortSignal,
  ): Promise<acp.SetSessionConfigOptionResponse>;
  prompt(
    params: acp.PromptRequest,
    callbacks?: AcpTurnCallbacks,
    signal?: AbortSignal,
  ): Promise<AcpPromptResult>;
  cancel(sessionId: string): Promise<void>;
  discoverModels(cwd: string, signal?: AbortSignal): Promise<readonly DiscoveredModel[]>;
  close(graceMs?: number): Promise<void>;
}

/** Exclusive worker lease obtained from the runtime concurrency pool. */
export interface AcpWorkerLease {
  readonly id: string;
  readonly client: AcpClientHandle;
  readonly sessionId?: string;
  readonly createdAt: number;
  release(options?: { recycle?: boolean; reason?: string }): Promise<void>;
  [Symbol.asyncDispose]?(): Promise<void>;
}

/** Options for acquiring an exclusive ACP worker lease. */
export interface AcquireWorkerOptions {
  readonly cwd: string;
  readonly sessionKey?: string;
  readonly setup?: AcpSessionSetup;
  readonly reuseSession?: boolean;
  readonly signal?: AbortSignal;
  readonly callbacks?: AcpTurnCallbacks;
  readonly onAuthUrl?: (url: string) => void;
  readonly suppressBrowser?: boolean;
}

/** Diagnostic status snapshot exposed by {@link AntigravityRuntimeService.getStatus}. */
export interface AntigravityStatusSnapshot {
  readonly installed: boolean;
  readonly executable?: AntigravityExecutable;
  readonly profile: AntigravityProfile;
  readonly activeLeases: number;
  readonly idleWorkers: number;
  readonly maxConcurrentSessions: number;
  readonly lastQuota?: QuotaSnapshot;
}

/** Core Cordis service managing the Antigravity ACP binary, profiles, auth, and worker pool. */
export interface AntigravityRuntimeService {
  readonly config: RuntimeConfig;
  resolveExecutable(signal?: AbortSignal): Promise<AntigravityExecutable>;
  ensureInstalled(signal?: AbortSignal): Promise<AntigravityExecutable>;
  resolveProfile(): AntigravityProfile;
  checkAuth(signal?: AbortSignal): Promise<AntigravityProfile>;
  login(options?: {
    readonly authMethod?: AntigravityAuthMethod;
    readonly apiKey?: string;
    readonly mode?: 'auto' | 'code' | 'loopback';
    readonly onAuthUrl?: (url: string, kind: 'loopback' | 'code') => void;
    readonly readCode?: () => Promise<string>;
    readonly signal?: AbortSignal;
  }): Promise<AntigravityProfile>;
  logout(signal?: AbortSignal): Promise<void>;
  listModels(options?: {
    cwd?: string;
    refresh?: boolean;
    signal?: AbortSignal;
  }): Promise<readonly DiscoveredModel[]>;
  getQuota(signal?: AbortSignal): Promise<QuotaSnapshot>;
  getStatus(signal?: AbortSignal): Promise<AntigravityStatusSnapshot>;
  acquireWorker(options: AcquireWorkerOptions): Promise<AcpWorkerLease>;
  spawnClient(options?: {
    readonly cwd?: string;
    readonly signal?: AbortSignal;
    readonly callbacks?: AcpTurnCallbacks;
    readonly onAuthUrl?: (url: string) => void;
    readonly suppressBrowser?: boolean;
  }): Promise<AcpClientHandle>;
  warmup(signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    antigravityRuntime: AntigravityRuntimeService;
  }
}
