import { LlmAdapter, ReasoningEffortId, isContextWindowExceededError, isQuotaExceededError, } from '@deepseek-ai/dsh-llm';
import { antigravityAppendsSystemPrompt, antigravitySessionMeta, isMcpToolCallMeta, isSignInRequiredError, normalizeStopReasonToLlm, selectPermissionOption, } from '../acp/protocol.js';
import { PrivateMcpBridge, } from '../mcp/bridge.js';
import { computeToolCatalogSignature, sanitizeToolCatalog } from '../mcp/schema.js';
import { AntigravityAcpError, redactSensitiveText, toLlmError } from '../shared/errors.js';
import { SessionReuseTracker, buildTurnMessagesAndBlocks, computeAssistantFingerprints, computeSessionConfigHash, extractSystemPrompt, hashRequestMessage, } from './prompt.js';
const MAX_RETAINED_SESSION_BRIDGES = 16;
class AsyncChunkQueue {
    buffer = [];
    waiters = [];
    done = false;
    failure;
    push(chunk) {
        if (this.done || this.failure) {
            return;
        }
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter.resolve({ value: chunk, done: false });
            return;
        }
        this.buffer.push(chunk);
    }
    complete() {
        if (this.done || this.failure) {
            return;
        }
        this.done = true;
        while (this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            waiter.resolve({ value: undefined, done: true });
        }
    }
    fail(error) {
        if (this.done || this.failure) {
            return;
        }
        this.failure = error;
        this.buffer.length = 0;
        while (this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            waiter.reject(error);
        }
    }
    async next() {
        if (this.failure) {
            throw this.failure;
        }
        if (this.buffer.length > 0) {
            return { value: this.buffer.shift(), done: false };
        }
        if (this.done) {
            return { value: undefined, done: true };
        }
        return await new Promise((resolve, reject) => {
            this.waiters.push({ resolve, reject });
        });
    }
}
function isPlainRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isBridgedMcpPermissionRequest(req, serverName = 'dsh_tools') {
    const toolCall = req.toolCall;
    if (isMcpToolCallMeta(toolCall._meta)) {
        return true;
    }
    if (isPlainRecord(toolCall._meta)) {
        const server = toolCall._meta['mcpServer'] ??
            toolCall._meta['mcp_server'] ??
            toolCall._meta['serverName'] ??
            toolCall._meta['server_name'];
        if (server === serverName) {
            return true;
        }
    }
    if (typeof toolCall.title === 'string') {
        const title = toolCall.title.trim();
        if (title === serverName ||
            title.startsWith(`${serverName}/`) ||
            title.startsWith(`mcp__${serverName}__`)) {
            return true;
        }
    }
    if (typeof toolCall.name === 'string') {
        const name = toolCall.name.trim();
        if (name === serverName ||
            name.startsWith(`${serverName}/`) ||
            name.startsWith(`mcp__${serverName}__`)) {
            return true;
        }
    }
    return false;
}
function mapAcpUsage(usage) {
    if (!usage) {
        return undefined;
    }
    const inputTokens = Math.max(0, usage.inputTokens);
    const outputTokens = Math.max(0, usage.outputTokens);
    const mapped = {
        inputTokens,
        outputTokens,
        ...(typeof usage.totalTokens === 'number' && usage.totalTokens >= 0
            ? { totalTokens: usage.totalTokens }
            : {}),
        ...(typeof usage.cachedReadTokens === 'number' && usage.cachedReadTokens >= 0
            ? { cacheReadTokens: usage.cachedReadTokens }
            : {}),
        ...(typeof usage.cachedWriteTokens === 'number' && usage.cachedWriteTokens >= 0
            ? { cacheWriteTokens: usage.cachedWriteTokens }
            : {}),
        ...(typeof usage.thoughtTokens === 'number' && usage.thoughtTokens >= 0
            ? { reasoningTokens: usage.thoughtTokens }
            : {}),
    };
    return mapped;
}
function serializeToolResultBlocks(content, attachments) {
    const parts = [];
    for (const block of content) {
        if (block.type === 'text') {
            if (block.text.length > 0) {
                parts.push(block.text);
            }
            continue;
        }
        if (block.type === 'file') {
            let hostPath;
            try {
                hostPath = attachments?.fileHostPath(block.attachment);
            }
            catch {
                hostPath = undefined;
            }
            parts.push(hostPath
                ? `[File "${block.attachment.name}" (${block.attachment.bytes} bytes) at ${JSON.stringify(hostPath)}]`
                : `[File "${block.attachment.name}" (${block.attachment.bytes} bytes)]`);
            continue;
        }
        if (block.type === 'image') {
            parts.push(`[Image ${block.attachment.name ?? block.attachment.attachmentId} (${block.attachment.width}x${block.attachment.height})]`);
            continue;
        }
        parts.push(JSON.stringify(block));
    }
    return parts.join('\n');
}
function classifyProviderError(error) {
    if (error instanceof AntigravityAcpError) {
        return error;
    }
    if (isSignInRequiredError(error)) {
        return new AntigravityAcpError('Antigravity authentication is required; run login before making requests', 'AGY_AUTH_REQUIRED', { cause: error });
    }
    if (error instanceof Error) {
        if (error.name === 'AbortError') {
            return new AntigravityAcpError('Antigravity ACP request aborted', 'ABORTED', {
                cause: error,
            });
        }
        const msg = error.message || '';
        if (isContextWindowExceededError(msg)) {
            return new AntigravityAcpError(msg, 'CONTEXT_WINDOW_EXCEEDED', { cause: error });
        }
        if (isQuotaExceededError(msg)) {
            return new AntigravityAcpError(msg, 'QUOTA', { cause: error });
        }
    }
    return error instanceof Error ? error : new Error(String(error));
}
/**
 * DSH {@link LlmAdapter} backed by Antigravity ACP workers and a private loopback MCP tool bridge.
 */
export class AntigravityLlmAdapter extends LlmAdapter {
    runtime;
    config;
    deps;
    reuseTracker = new SessionReuseTracker();
    sessionBridges = new Map();
    activeParkedTurns = new Map();
    activeTurns = new Set();
    catalogModels = [];
    catalogAttempted = false;
    generation = 0;
    disposed = false;
    constructor(runtime, config, deps) {
        super();
        this.runtime = runtime;
        this.config = config;
        this.deps = deps;
    }
    get defaultCwd() {
        return this.deps?.cwd ?? process.cwd();
    }
    providerInfo(provider) {
        return {
            id: provider,
            name: this.config.providerName,
        };
    }
    /**
     * Refresh the cached model catalog from the Antigravity runtime.
     */
    async refreshModels(signal) {
        signal?.throwIfAborted();
        try {
            const models = await this.runtime.listModels({
                cwd: this.defaultCwd,
                refresh: true,
                signal,
            });
            this.catalogModels = models;
            this.catalogAttempted = true;
            this.generation += 1;
            return models;
        }
        catch (error) {
            if (signal?.aborted) {
                throw toLlmError(classifyProviderError(error));
            }
            this.catalogModels = [];
            this.catalogAttempted = true;
            this.generation += 1;
            const safeMessage = error instanceof Error ? redactSensitiveText(error.message) : String(error);
            this.deps?.logger?.debug?.(`antigravity model discovery unavailable: ${safeMessage}`);
            return [];
        }
    }
    async listModels(provider) {
        if (!this.catalogAttempted) {
            await this.refreshModels();
        }
        if (this.catalogModels.length === 0) {
            const override = this.config.modelOverrides['server-default'];
            return [
                {
                    provider,
                    id: 'server-default',
                    name: override?.name ?? 'Antigravity Default',
                    description: override?.description ??
                        'Sign in to Antigravity ACP to discover available models.',
                    inputModalities: override?.inputModalities
                        ? [...override.inputModalities]
                        : ['text', 'image'],
                    badge: {
                        text: 'Sign in / Connect',
                        tone: 'warning',
                    },
                },
            ];
        }
        return this.catalogModels.map((discovered) => {
            const override = this.config.modelOverrides[discovered.id];
            const description = override?.description ?? discovered.description;
            const inputModalities = override?.inputModalities
                ? [...override.inputModalities]
                : discovered.inputModalities
                    ? [...discovered.inputModalities]
                    : ['text', 'image'];
            return {
                provider,
                id: discovered.id,
                name: override?.name ?? discovered.name ?? discovered.id,
                ...(description !== undefined ? { description } : {}),
                inputModalities,
            };
        });
    }
    async resolveModel(provider, model, signal) {
        signal?.throwIfAborted();
        if (!this.catalogAttempted) {
            await this.refreshModels(signal);
        }
        const discovered = this.catalogModels.find((entry) => entry.id === model);
        const override = this.config.modelOverrides[model];
        const rawContext = override?.contextWindow ?? discovered?.contextWindow ?? this.config.contextWindow;
        const contextWindow = Number.isInteger(rawContext) && rawContext > 0 ? rawContext : this.config.contextWindow;
        const rawDefaultMaxTokens = override?.defaultMaxTokens;
        const defaultMaxTokens = rawDefaultMaxTokens !== undefined &&
            Number.isSafeInteger(rawDefaultMaxTokens) &&
            rawDefaultMaxTokens > 0
            ? rawDefaultMaxTokens
            : undefined;
        const inputModalities = override?.inputModalities
            ? [...override.inputModalities]
            : discovered?.inputModalities
                ? [...discovered.inputModalities]
                : ['text', 'image'];
        const description = override?.description ?? discovered?.description;
        const reasoning = this.buildReasoningInfo(discovered, override?.defaultThoughtLevel);
        return {
            provider,
            id: model,
            name: override?.name ?? discovered?.name ?? model,
            ...(description !== undefined ? { description } : {}),
            inputModalities,
            context: { contextWindow },
            ...(defaultMaxTokens !== undefined ? { defaultMaxTokens } : {}),
            ...(reasoning !== undefined ? { reasoning } : {}),
        };
    }
    async prepareCall(provider, model, signal) {
        const resolvedModel = await this.resolveModel(provider, model, signal);
        const capturedGeneration = this.generation;
        return {
            model: resolvedModel,
            stream: (options) => this.streamInternal(options, resolvedModel, capturedGeneration),
        };
    }
    stream(options) {
        return this.streamInternal(options, undefined, this.generation);
    }
    /**
     * Abort all parked/in-flight turns and close all retained MCP bridges.
     */
    async dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const turns = [...this.activeTurns];
        this.activeTurns.clear();
        this.activeParkedTurns.clear();
        this.reuseTracker.clear();
        for (const turn of turns) {
            await this.abortTurn(turn, new AntigravityAcpError('Antigravity LLM adapter disposed', 'ABORTED'), true);
        }
        const bridges = [...this.sessionBridges.values()];
        this.sessionBridges.clear();
        await Promise.all(bridges.map((bridge) => bridge.close()));
    }
    buildReasoningInfo(discovered, overrideDefaultEffort) {
        const rawOptions = discovered?.thinkingOptions;
        if (!rawOptions || rawOptions.length === 0) {
            return undefined;
        }
        const seen = new Set();
        const efforts = [];
        for (const option of rawOptions) {
            const id = option.id.trim();
            const name = (option.name || option.id).trim();
            if (!id || !name || seen.has(id)) {
                continue;
            }
            seen.add(id);
            efforts.push({
                id: ReasoningEffortId(id),
                name,
                ...(option.description ? { description: option.description } : {}),
            });
        }
        if (efforts.length === 0) {
            return undefined;
        }
        const candidateDefault = overrideDefaultEffort ?? discovered?.defaultThoughtLevel;
        const defaultEffort = candidateDefault && seen.has(candidateDefault)
            ? ReasoningEffortId(candidateDefault)
            : undefined;
        return {
            efforts,
            ...(defaultEffort !== undefined ? { defaultEffort } : {}),
        };
    }
    validateSamplingOptions(options, preparedModel) {
        const unsupported = [];
        if (options.temperature !== undefined) {
            unsupported.push('temperature');
        }
        if (options.maxTokens !== undefined && options.maxTokens !== preparedModel?.defaultMaxTokens) {
            unsupported.push('maxTokens');
        }
        if (options.stop !== undefined && options.stop.length > 0) {
            unsupported.push('stop');
        }
        if (unsupported.length === 0) {
            return;
        }
        if (this.config.ignoreUnsupportedOptions) {
            this.deps?.logger?.warn?.(`antigravity-acp ignoring unsupported sampling option(s): ${unsupported.join(', ')}`);
            return;
        }
        throw toLlmError(new AntigravityAcpError(`Antigravity ACP does not support sampling option(s): ${unsupported.join(', ')}`, 'UNSUPPORTED_OPTION'));
    }
    async getOrCreateSessionBridge(sessionKey, canReuseExisting) {
        if (!sessionKey || !this.config.reuseSessions) {
            const bridge = new PrivateMcpBridge({ toolTimeoutMs: this.config.toolTimeoutMs });
            await bridge.start();
            return { bridge, ownsEphemeralBridge: !sessionKey };
        }
        const existing = this.sessionBridges.get(sessionKey);
        if (canReuseExisting && existing && existing.isListening) {
            // Refresh LRU insertion order.
            this.sessionBridges.delete(sessionKey);
            this.sessionBridges.set(sessionKey, existing);
            return { bridge: existing, ownsEphemeralBridge: false };
        }
        if (existing) {
            this.sessionBridges.delete(sessionKey);
            await existing.close();
        }
        const bridge = new PrivateMcpBridge({ toolTimeoutMs: this.config.toolTimeoutMs });
        await bridge.start();
        this.sessionBridges.set(sessionKey, bridge);
        // Bound idle bridge retention when reuseSessions is active across many sessions.
        while (this.sessionBridges.size > MAX_RETAINED_SESSION_BRIDGES) {
            const oldestKey = this.sessionBridges.keys().next().value;
            if (!oldestKey || oldestKey === sessionKey) {
                break;
            }
            const inUse = this.activeParkedTurns.has(oldestKey) ||
                [...this.activeTurns].some((turn) => turn.sessionKey === oldestKey);
            if (inUse) {
                break;
            }
            const oldestBridge = this.sessionBridges.get(oldestKey);
            this.sessionBridges.delete(oldestKey);
            this.reuseTracker.delete(oldestKey);
            if (oldestBridge) {
                await oldestBridge.close();
            }
        }
        return { bridge, ownsEphemeralBridge: false };
    }
    async *streamInternal(options, preparedModel, _capturedGeneration) {
        if (this.disposed) {
            throw toLlmError(new AntigravityAcpError('Antigravity LLM adapter is disposed', 'ABORTED'));
        }
        if (options.signal?.aborted) {
            throw toLlmError(new AntigravityAcpError('Request aborted before start', 'ABORTED', {
                cause: options.signal.reason,
            }));
        }
        this.validateSamplingOptions(options, preparedModel);
        const sessionKey = options.sessionId !== undefined ? `${options.provider}:${String(options.sessionId)}` : undefined;
        let sanitizedTools;
        let toolsSignature;
        let systemPrompt;
        let configHash;
        try {
            sanitizedTools = sanitizeToolCatalog(options.tools);
            toolsSignature = computeToolCatalogSignature(sanitizedTools);
            systemPrompt = extractSystemPrompt(options);
            configHash = computeSessionConfigHash({
                systemPrompt,
                model: options.model,
                reasoningEffort: options.reasoningEffort ? String(options.reasoningEffort) : undefined,
                toolsSignature,
            });
        }
        catch (error) {
            throw toLlmError(classifyProviderError(error));
        }
        // Check mid-prompt continuation for a currently parked ACP turn.
        const parkedTurn = sessionKey ? this.activeParkedTurns.get(sessionKey) : undefined;
        if (parkedTurn) {
            if (parkedTurn.fatalError) {
                const fatal = parkedTurn.fatalError;
                this.activeParkedTurns.delete(sessionKey);
                await this.abortTurn(parkedTurn, fatal, true);
                throw toLlmError(classifyProviderError(fatal));
            }
            if (parkedTurn.configHash !== configHash) {
                this.activeParkedTurns.delete(sessionKey);
                await this.abortTurn(parkedTurn, new AntigravityAcpError('Session configuration changed while tool calls were parked', 'ABORTED'), true);
            }
            else {
                const continuation = this.validateAndExtractContinuationResults(parkedTurn, options);
                if (!continuation.ok) {
                    this.activeParkedTurns.delete(sessionKey);
                    await this.abortTurn(parkedTurn, continuation.error, true);
                    throw toLlmError(continuation.error);
                }
                // Resume the SAME in-flight ACP session/prompt with tool results delivered to PrivateMcpBridge.
                yield* this.resumeParkedTurn(parkedTurn, options, continuation.results);
                return;
            }
        }
        // Standard new or reused ACP turn.
        let lease;
        let bridge;
        let ownsEphemeralBridge = false;
        let turnController;
        try {
            const plan = this.reuseTracker.plan({
                sessionKey,
                provider: options.provider,
                reuseEnabled: this.config.reuseSessions,
                configHash,
                messages: options.messages,
            });
            const bridgeSetup = await this.getOrCreateSessionBridge(sessionKey, plan.canReuse);
            bridge = bridgeSetup.bridge;
            ownsEphemeralBridge = bridgeSetup.ownsEphemeralBridge;
            bridge.setSanitizedTools(sanitizedTools);
            const resolvedModelInfo = preparedModel ?? (await this.resolveModel(options.provider, options.model, options.signal));
            lease = await this.runtime.acquireWorker({
                cwd: this.defaultCwd,
                sessionKey,
                reuseSession: plan.canReuse,
                signal: options.signal,
            });
            const actuallyReused = plan.canReuse &&
                lease.client.id === plan.tracked.workerId &&
                (!lease.sessionId || lease.sessionId === plan.tracked.acpSessionId);
            const capabilities = lease.client.initialized.capabilities;
            const modelAllowsImages = !resolvedModelInfo.inputModalities ||
                resolvedModelInfo.inputModalities.includes('image');
            const acpSupportsImages = lease.client.initialized.supportsImages;
            let acpSessionId;
            let supportsImages;
            let appendsSystemPrompt;
            let messagesToSerialize;
            let includeSystemPromptInTurn;
            if (actuallyReused) {
                acpSessionId = plan.tracked.acpSessionId;
                supportsImages = plan.tracked.supportsImages;
                appendsSystemPrompt = plan.tracked.appendsSystemPrompt;
                messagesToSerialize = plan.deltaMessages;
                includeSystemPromptInTurn = false;
            }
            else {
                appendsSystemPrompt = antigravityAppendsSystemPrompt(capabilities);
                supportsImages = acpSupportsImages && modelAllowsImages;
                const effectiveModel = options.model === 'server-default'
                    ? this.config.defaultModel && this.config.defaultModel !== 'server-default'
                        ? this.config.defaultModel
                        : undefined
                    : options.model;
                const thoughtLevel = options.reasoningEffort
                    ? String(options.reasoningEffort)
                    : undefined;
                const meta = antigravitySessionMeta(capabilities, systemPrompt);
                const sessionResp = await lease.client.newSession({
                    cwd: this.defaultCwd,
                    mcpServers: [bridge.getMcpServerConfig()],
                    ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
                    ...(thoughtLevel !== undefined ? { thoughtLevel } : {}),
                    ...(meta !== undefined ? { meta } : {}),
                    ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
                }, options.signal);
                acpSessionId = sessionResp.sessionId;
                messagesToSerialize = options.messages;
                includeSystemPromptInTurn = !appendsSystemPrompt && systemPrompt.trim().length > 0;
            }
            const promptBlocks = await buildTurnMessagesAndBlocks({
                messages: messagesToSerialize,
                systemPrompt,
                includeSystemPromptInTurn,
                supportsImages,
                attachments: this.deps?.attachments,
                maxPromptBytes: this.config.maxPromptBytes,
                signal: options.signal,
            });
            if (promptBlocks.length === 0) {
                promptBlocks.push({ type: 'text', text: '' });
            }
            turnController = this.createTurnController({
                sessionKey,
                provider: options.provider,
                lease,
                acpSessionId,
                bridge,
                ownsEphemeralBridge,
                configHash,
                supportsImages,
                appendsSystemPrompt,
                requestMessages: options.messages,
            });
            this.activeTurns.add(turnController);
            this.launchAcpPrompt(turnController, promptBlocks, options.signal);
            yield* this.consumeSegment(turnController, options.signal);
        }
        catch (error) {
            if (turnController) {
                await this.abortTurn(turnController, error instanceof Error ? error : new Error(String(error)), true);
            }
            else {
                if (lease) {
                    await lease
                        .release({
                        recycle: true,
                        reason: error instanceof Error ? redactSensitiveText(error.message) : 'setup_failed',
                    })
                        .catch(() => { });
                }
                if (bridge && ownsEphemeralBridge) {
                    await bridge.close().catch(() => { });
                }
                if (sessionKey && !this.activeParkedTurns.has(sessionKey)) {
                    this.reuseTracker.delete(sessionKey);
                }
            }
            throw toLlmError(classifyProviderError(error));
        }
    }
    validateAndExtractContinuationResults(parkedTurn, options) {
        const prefixLen = parkedTurn.requestMessageHashes.length;
        if (options.messages.length <= prefixLen) {
            return {
                ok: false,
                error: new AntigravityAcpError('Continuation request is missing trailing tool result messages for parked calls', 'AGY_TOOL_RESULTS_MISSING'),
            };
        }
        for (let i = 0; i < prefixLen; i += 1) {
            if (hashRequestMessage(options.messages[i]) !== parkedTurn.requestMessageHashes[i]) {
                return {
                    ok: false,
                    error: new AntigravityAcpError('Request history diverged before parked tool results were delivered', 'AGY_TOOL_RESULTS_MISSING'),
                };
            }
        }
        const tail = options.messages.slice(prefixLen);
        let idx = 0;
        if (tail[idx]?.role === 'assistant') {
            idx += 1;
        }
        const results = new Map();
        for (; idx < tail.length; idx += 1) {
            const msg = tail[idx];
            if (msg.role !== 'tool') {
                return {
                    ok: false,
                    error: new AntigravityAcpError(`Expected trailing tool result messages, found role "${msg.role}"`, 'AGY_TOOL_RESULTS_MISSING'),
                };
            }
            const content = serializeToolResultBlocks(msg.content, this.deps?.attachments);
            results.set(msg.toolCallId, {
                content,
                isError: Boolean(msg.isError),
            });
        }
        if (results.size === 0) {
            return {
                ok: false,
                error: new AntigravityAcpError('No trailing tool result messages were supplied for parked tool calls', 'AGY_TOOL_RESULTS_MISSING'),
            };
        }
        const expectedIds = new Set([
            ...parkedTurn.expectedToolCallIds,
            ...parkedTurn.bridge.getPendingCalls().map((call) => call.id),
        ]);
        const missingIds = [];
        for (const expectedId of expectedIds) {
            if (!results.has(expectedId)) {
                missingIds.push(String(expectedId));
            }
        }
        if (missingIds.length > 0) {
            return {
                ok: false,
                error: new AntigravityAcpError(`Missing tool result(s) for parked call id(s): ${missingIds.join(', ')}`, 'AGY_TOOL_RESULTS_MISSING'),
            };
        }
        const unexpectedIds = [];
        for (const suppliedId of results.keys()) {
            if (!expectedIds.has(suppliedId)) {
                unexpectedIds.push(String(suppliedId));
            }
        }
        if (unexpectedIds.length > 0) {
            return {
                ok: false,
                error: new AntigravityAcpError(`Mismatched tool result id(s) not matching parked calls: ${unexpectedIds.join(', ')}`, 'AGY_TOOL_RESULTS_MISSING'),
            };
        }
        return { ok: true, results };
    }
    async *resumeParkedTurn(turn, options, results) {
        if (turn.sessionKey) {
            this.activeParkedTurns.delete(turn.sessionKey);
        }
        turn.requestMessages = options.messages;
        turn.requestMessageHashes = options.messages.map(hashRequestMessage);
        // Reset segment state so continuation chunks start cleanly at index 0.
        turn.segmentQueue = new AsyncChunkQueue();
        turn.nextBlockIndex = 0;
        turn.openBlock = null;
        turn.emittedBlocksInSegment = [];
        turn.segmentFinished = false;
        turn.parkedForContinuation = false;
        turn.expectedToolCallIds.clear();
        turn.latestUsage = undefined;
        this.attachSegmentAbortListener(turn, options.signal);
        // Re-attach bridge listener in case any state needs fresh reference.
        turn.bridge.setTurnListener({
            onToolCallParked: (call) => this.handleBridgeToolCallParked(turn, call),
            onToolCallError: (err) => this.handleBridgeToolCallError(turn, err),
        });
        turn.bridge.deliverToolResults(results);
        yield* this.consumeSegment(turn, options.signal);
    }
    createTurnController(input) {
        return {
            sessionKey: input.sessionKey,
            provider: input.provider,
            lease: input.lease,
            acpSessionId: input.acpSessionId,
            bridge: input.bridge,
            ownsEphemeralBridge: input.ownsEphemeralBridge,
            configHash: input.configHash,
            supportsImages: input.supportsImages,
            appendsSystemPrompt: input.appendsSystemPrompt,
            requestMessages: input.requestMessages,
            requestMessageHashes: input.requestMessages.map(hashRequestMessage),
            segmentQueue: new AsyncChunkQueue(),
            nextBlockIndex: 0,
            openBlock: null,
            emittedBlocksInSegment: [],
            segmentFinished: false,
            parkedForContinuation: false,
            promptSettled: false,
            fatalError: undefined,
            nativeToolError: undefined,
            parkSettleTimer: undefined,
            expectedToolCallIds: new Set(),
            latestUsage: undefined,
            detachAbortSignal: undefined,
            released: false,
            recycleOnRelease: false,
            releaseReason: undefined,
        };
    }
    attachSegmentAbortListener(turn, signal) {
        turn.detachAbortSignal?.();
        turn.detachAbortSignal = undefined;
        if (!signal) {
            return;
        }
        const onAbort = () => {
            const abortErr = new AntigravityAcpError('Request aborted by caller signal', 'ABORTED', {
                cause: signal.reason,
            });
            void this.abortTurn(turn, abortErr, true);
        };
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        turn.detachAbortSignal = () => {
            signal.removeEventListener('abort', onAbort);
        };
    }
    launchAcpPrompt(turn, promptBlocks, signal) {
        this.attachSegmentAbortListener(turn, signal);
        turn.bridge.setTurnListener({
            onToolCallParked: (call) => this.handleBridgeToolCallParked(turn, call),
            onToolCallError: (err) => this.handleBridgeToolCallError(turn, err),
        });
        const callbacks = {
            onThoughtDelta: (text) => this.handleThoughtDelta(turn, text),
            onTextDelta: (text) => this.handleTextDelta(turn, text),
            onRequestPermission: (req) => this.handlePermissionRequest(turn, req),
        };
        void turn.lease.client
            .prompt({
            sessionId: turn.acpSessionId,
            prompt: promptBlocks,
        }, callbacks)
            .then((result) => this.handlePromptCompleted(turn, result), (error) => this.handlePromptFailed(turn, error));
    }
    closeOpenTextOrReasoningBlock(turn) {
        const open = turn.openBlock;
        if (!open) {
            return;
        }
        turn.openBlock = null;
        const block = open.type === 'reasoning'
            ? { type: 'reasoning', text: open.text }
            : { type: 'text', text: open.text };
        turn.emittedBlocksInSegment.push(block);
        turn.segmentQueue.push({
            type: 'block-end',
            index: open.index,
            block,
        });
    }
    handleThoughtDelta(turn, text) {
        if (turn.segmentFinished || turn.promptSettled || turn.fatalError || text.length === 0) {
            return;
        }
        if (turn.openBlock && turn.openBlock.type !== 'reasoning') {
            this.closeOpenTextOrReasoningBlock(turn);
        }
        if (!turn.openBlock) {
            const index = turn.nextBlockIndex;
            turn.nextBlockIndex += 1;
            turn.openBlock = { index, type: 'reasoning', text: '' };
            turn.segmentQueue.push({
                type: 'block-start',
                index,
                blockType: 'reasoning',
            });
        }
        turn.openBlock.text += text;
        turn.segmentQueue.push({
            type: 'reasoning-delta',
            index: turn.openBlock.index,
            text,
        });
    }
    handleTextDelta(turn, text) {
        if (turn.segmentFinished || turn.promptSettled || turn.fatalError || text.length === 0) {
            return;
        }
        if (turn.openBlock && turn.openBlock.type !== 'text') {
            this.closeOpenTextOrReasoningBlock(turn);
        }
        if (!turn.openBlock) {
            const index = turn.nextBlockIndex;
            turn.nextBlockIndex += 1;
            turn.openBlock = { index, type: 'text', text: '' };
            turn.segmentQueue.push({
                type: 'block-start',
                index,
                blockType: 'text',
            });
        }
        turn.openBlock.text += text;
        turn.segmentQueue.push({
            type: 'text-delta',
            index: turn.openBlock.index,
            text,
        });
    }
    handleBridgeToolCallParked(turn, call) {
        if (turn.segmentFinished || turn.promptSettled || turn.fatalError) {
            return;
        }
        this.closeOpenTextOrReasoningBlock(turn);
        const index = turn.nextBlockIndex;
        turn.nextBlockIndex += 1;
        turn.segmentQueue.push({
            type: 'block-start',
            index,
            blockType: 'tool-call',
        });
        turn.segmentQueue.push({
            type: 'tool-call-delta',
            index,
            id: call.id,
            name: call.name,
            argumentsDelta: call.argumentsJson,
        });
        const block = {
            type: 'tool-call',
            id: call.id,
            name: call.name,
            arguments: call.argumentsJson,
        };
        turn.emittedBlocksInSegment.push(block);
        turn.segmentQueue.push({
            type: 'block-end',
            index,
            block,
        });
        turn.expectedToolCallIds.add(call.id);
        if (turn.parkSettleTimer) {
            clearTimeout(turn.parkSettleTimer);
        }
        turn.parkSettleTimer = setTimeout(() => {
            turn.parkSettleTimer = undefined;
            this.finalizeToolCallsSegment(turn);
        }, this.config.bridgeParkSettleMs);
    }
    handleBridgeToolCallError(turn, error) {
        if (turn.fatalError || turn.promptSettled) {
            return;
        }
        void this.abortTurn(turn, error, true);
    }
    finalizeToolCallsSegment(turn) {
        if (turn.segmentFinished || turn.promptSettled || turn.fatalError) {
            return;
        }
        if (turn.expectedToolCallIds.size === 0) {
            return;
        }
        this.closeOpenTextOrReasoningBlock(turn);
        turn.segmentFinished = true;
        turn.parkedForContinuation = true;
        turn.detachAbortSignal?.();
        turn.detachAbortSignal = undefined;
        if (turn.sessionKey) {
            this.activeParkedTurns.set(turn.sessionKey, turn);
        }
        if (turn.latestUsage) {
            turn.segmentQueue.push({ type: 'usage', usage: turn.latestUsage });
        }
        turn.segmentQueue.push({
            type: 'finish',
            reason: { kind: 'tool-calls' },
        });
        turn.segmentQueue.complete();
    }
    handlePermissionRequest(turn, req) {
        if (isBridgedMcpPermissionRequest(req)) {
            const allow = selectPermissionOption(req.options, 'allow_once');
            if (allow) {
                return {
                    outcome: {
                        outcome: 'selected',
                        optionId: allow.optionId,
                    },
                };
            }
            return { outcome: { outcome: 'cancelled' } };
        }
        const toolLabel = req.toolCall.title || req.toolCall.name || req.toolCall.toolCallId;
        const blockedErr = new AntigravityAcpError(`Native Antigravity tool "${toolLabel}" is blocked; DSH tools must run via private MCP bridge`, 'AGY_NATIVE_TOOLS_BLOCKED');
        turn.nativeToolError = blockedErr;
        turn.recycleOnRelease = true;
        turn.releaseReason = 'AGY_NATIVE_TOOLS_BLOCKED';
        queueMicrotask(() => {
            void this.abortTurn(turn, blockedErr, true);
        });
        const reject = selectPermissionOption(req.options, 'reject_once');
        if (reject) {
            return {
                outcome: {
                    outcome: 'selected',
                    optionId: reject.optionId,
                },
            };
        }
        return { outcome: { outcome: 'cancelled' } };
    }
    async handlePromptCompleted(turn, result) {
        if (turn.promptSettled) {
            return;
        }
        turn.promptSettled = true;
        if (turn.parkSettleTimer) {
            clearTimeout(turn.parkSettleTimer);
            turn.parkSettleTimer = undefined;
        }
        if (turn.nativeToolError || turn.fatalError) {
            const err = turn.nativeToolError ?? turn.fatalError;
            await this.finalizeTurnWithFailure(turn, err, true);
            return;
        }
        // If any bridge calls remained parked when the prompt unexpectedly ended, abort them cleanly.
        if (turn.bridge.pendingCount > 0) {
            turn.bridge.abortAll(new AntigravityAcpError('ACP prompt ended while tool calls were pending', 'TRANSPORT'));
        }
        if (turn.segmentFinished) {
            return;
        }
        const stopKind = normalizeStopReasonToLlm(result.stopReason);
        if (stopKind === 'error') {
            const code = result.stopReason === 'cancelled' ? 'ABORTED' : 'TRANSPORT';
            const err = new AntigravityAcpError(`Antigravity ACP prompt terminated with stopReason "${result.stopReason}"`, code);
            await this.finalizeTurnWithFailure(turn, err, code === 'ABORTED');
            return;
        }
        this.closeOpenTextOrReasoningBlock(turn);
        // Fallback if ACP server returned full text/reasoning in PromptResponse without streaming deltas.
        if (turn.emittedBlocksInSegment.length === 0) {
            if (result.reasoning && result.reasoning.trim().length > 0) {
                const index = turn.nextBlockIndex;
                turn.nextBlockIndex += 1;
                turn.segmentQueue.push({ type: 'block-start', index, blockType: 'reasoning' });
                turn.segmentQueue.push({ type: 'reasoning-delta', index, text: result.reasoning });
                const block = { type: 'reasoning', text: result.reasoning };
                turn.emittedBlocksInSegment.push(block);
                turn.segmentQueue.push({ type: 'block-end', index, block });
            }
            if (result.text && result.text.trim().length > 0) {
                const index = turn.nextBlockIndex;
                turn.nextBlockIndex += 1;
                turn.segmentQueue.push({ type: 'block-start', index, blockType: 'text' });
                turn.segmentQueue.push({ type: 'text-delta', index, text: result.text });
                const block = { type: 'text', text: result.text };
                turn.emittedBlocksInSegment.push(block);
                turn.segmentQueue.push({ type: 'block-end', index, block });
            }
        }
        if (turn.emittedBlocksInSegment.length === 0 && result.stopReason === 'end_turn') {
            await this.finalizeTurnWithFailure(turn, new AntigravityAcpError('Antigravity ACP returned an empty response', 'EMPTY_RESPONSE'), false);
            return;
        }
        turn.segmentFinished = true;
        turn.parkedForContinuation = false;
        turn.detachAbortSignal?.();
        turn.detachAbortSignal = undefined;
        if (turn.sessionKey) {
            this.activeParkedTurns.delete(turn.sessionKey);
        }
        const usage = mapAcpUsage(result.usage) ?? turn.latestUsage;
        if (usage) {
            turn.segmentQueue.push({ type: 'usage', usage });
        }
        turn.segmentQueue.push({
            type: 'finish',
            reason: { kind: stopKind },
        });
        if (turn.sessionKey && this.config.reuseSessions && stopKind === 'stop') {
            this.reuseTracker.record({
                sessionKey: turn.sessionKey,
                provider: turn.provider,
                acpSessionId: turn.acpSessionId,
                workerId: turn.lease.client.id,
                configHash: turn.configHash,
                sentMessageHashes: turn.requestMessageHashes,
                assistantFingerprints: computeAssistantFingerprints(turn.emittedBlocksInSegment),
                supportsImages: turn.supportsImages,
                appendsSystemPrompt: turn.appendsSystemPrompt,
            });
        }
        else if (turn.sessionKey) {
            this.reuseTracker.delete(turn.sessionKey);
        }
        await this.cleanupTurnResources(turn, false);
        turn.segmentQueue.complete();
    }
    async handlePromptFailed(turn, error) {
        if (turn.promptSettled) {
            return;
        }
        turn.promptSettled = true;
        const effectiveError = turn.nativeToolError ?? turn.fatalError ?? classifyProviderError(error);
        await this.finalizeTurnWithFailure(turn, effectiveError, true);
    }
    async finalizeTurnWithFailure(turn, error, recycleWorker) {
        if (turn.parkSettleTimer) {
            clearTimeout(turn.parkSettleTimer);
            turn.parkSettleTimer = undefined;
        }
        turn.detachAbortSignal?.();
        turn.detachAbortSignal = undefined;
        if (!turn.fatalError) {
            turn.fatalError = error;
        }
        if (turn.sessionKey) {
            if (!turn.parkedForContinuation) {
                this.activeParkedTurns.delete(turn.sessionKey);
            }
            this.reuseTracker.delete(turn.sessionKey);
        }
        turn.bridge.setTurnListener(undefined);
        turn.bridge.abortAll(error);
        await this.cleanupTurnResources(turn, recycleWorker, redactSensitiveText(error.message));
        if (!turn.segmentFinished) {
            turn.segmentFinished = true;
            turn.segmentQueue.fail(toLlmError(classifyProviderError(error)));
        }
    }
    async abortTurn(turn, error, recycleWorker) {
        if (turn.parkSettleTimer) {
            clearTimeout(turn.parkSettleTimer);
            turn.parkSettleTimer = undefined;
        }
        turn.detachAbortSignal?.();
        turn.detachAbortSignal = undefined;
        if (!turn.fatalError) {
            turn.fatalError = error;
        }
        if (turn.sessionKey) {
            if (!turn.parkedForContinuation) {
                this.activeParkedTurns.delete(turn.sessionKey);
            }
            this.reuseTracker.delete(turn.sessionKey);
        }
        turn.bridge.setTurnListener(undefined);
        turn.bridge.abortAll(error);
        if (!turn.promptSettled) {
            turn.promptSettled = true;
            void turn.lease.client.cancel(turn.acpSessionId).catch(() => { });
        }
        await this.cleanupTurnResources(turn, recycleWorker, redactSensitiveText(error.message));
        if (!turn.segmentFinished) {
            turn.segmentFinished = true;
            turn.segmentQueue.fail(toLlmError(classifyProviderError(error)));
        }
    }
    async cleanupTurnResources(turn, recycleWorker, reason) {
        this.activeTurns.delete(turn);
        turn.bridge.setTurnListener(undefined);
        const shouldRecycle = recycleWorker || turn.recycleOnRelease;
        if (shouldRecycle && turn.sessionKey && !turn.ownsEphemeralBridge) {
            const retained = this.sessionBridges.get(turn.sessionKey);
            if (retained === turn.bridge) {
                this.sessionBridges.delete(turn.sessionKey);
            }
            await turn.bridge.close().catch(() => { });
        }
        else if (turn.ownsEphemeralBridge) {
            await turn.bridge.close().catch(() => { });
        }
        if (!turn.released) {
            turn.released = true;
            await turn.lease
                .release({
                recycle: shouldRecycle,
                ...(reason ?? turn.releaseReason ? { reason: reason ?? turn.releaseReason } : {}),
            })
                .catch(() => { });
        }
    }
    async *consumeSegment(turn, signal) {
        let completedCleanly = false;
        try {
            while (true) {
                const next = await turn.segmentQueue.next();
                if (next.done) {
                    completedCleanly = true;
                    return;
                }
                yield next.value;
            }
        }
        finally {
            if (!completedCleanly && !turn.segmentFinished) {
                const abortReason = signal?.aborted
                    ? new AntigravityAcpError('Request aborted by caller', 'ABORTED', {
                        cause: signal.reason,
                    })
                    : new AntigravityAcpError('Stream consumer closed before turn completed', 'ABORTED');
                await this.abortTurn(turn, abortReason, true);
            }
            else if (turn.parkedForContinuation) {
                // Wait for continuation call; keep lease & bridge parked, only remove signal listener.
                turn.detachAbortSignal?.();
                turn.detachAbortSignal = undefined;
            }
        }
    }
}
//# sourceMappingURL=adapter.js.map