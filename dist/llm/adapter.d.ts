import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type PreparedAdapterCall, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { LlmPluginConfig } from '../shared/config.js';
import type { AntigravityRuntimeService, DiscoveredModel } from '../shared/contracts.js';
/** Optional logger contract compatible with Cordis logger and test spies. */
export interface AdapterLogger {
    debug?(message: string, ...args: unknown[]): void;
    info?(message: string, ...args: unknown[]): void;
    warn?(message: string, ...args: unknown[]): void;
    error?(message: string, ...args: unknown[]): void;
}
/** Injectable dependencies for {@link AntigravityLlmAdapter}. */
export interface AntigravityLlmAdapterDeps {
    readonly attachments?: AttachmentStore;
    readonly logger?: AdapterLogger;
    readonly cwd?: string;
}
/**
 * DSH {@link LlmAdapter} backed by Antigravity ACP workers and a private loopback MCP tool bridge.
 */
export declare class AntigravityLlmAdapter extends LlmAdapter {
    private readonly runtime;
    private readonly config;
    private readonly deps?;
    private readonly reuseTracker;
    private readonly sessionBridges;
    private readonly activeParkedTurns;
    private readonly activeTurns;
    private catalogModels;
    private catalogAttempted;
    private generation;
    private disposed;
    constructor(runtime: AntigravityRuntimeService, config: LlmPluginConfig, deps?: AntigravityLlmAdapterDeps | undefined);
    private get defaultCwd();
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * Refresh the cached model catalog from the Antigravity runtime.
     */
    refreshModels(signal?: AbortSignal): Promise<readonly DiscoveredModel[]>;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * Abort all parked/in-flight turns and close all retained MCP bridges.
     */
    dispose(): Promise<void>;
    private buildReasoningInfo;
    private validateSamplingOptions;
    private getOrCreateSessionBridge;
    private streamInternal;
    private validateAndExtractContinuationResults;
    private resumeParkedTurn;
    private createTurnController;
    private attachSegmentAbortListener;
    private launchAcpPrompt;
    private closeOpenTextOrReasoningBlock;
    private handleThoughtDelta;
    private handleTextDelta;
    private handleBridgeToolCallParked;
    private handleBridgeToolCallError;
    private finalizeToolCallsSegment;
    private handlePermissionRequest;
    private handlePromptCompleted;
    private handlePromptFailed;
    private finalizeTurnWithFailure;
    private abortTurn;
    private cleanupTurnResources;
    private consumeSegment;
}
//# sourceMappingURL=adapter.d.ts.map