import { randomUUID } from 'node:crypto';
import { fileHandleText, textOnlyImageText, } from '@deepseek-ai/dsh-llm';
import { AssistantOutputFold, NO_START_CAPABILITIES, SubagentError, assertPositiveFinite, assertUsableCwd, settleRunResult, subprocessRunHandle, } from '@deepseek-ai/dsh-subagent';
import { AntigravityAcpError, redactSensitiveText } from '../shared/errors.js';
import { antigravitySessionMeta, antigravitySessionMode, isSignInRequiredError, selectPermissionOption, } from '../acp/protocol.js';
const DIAGNOSTIC_PREFIX = 'subagent-antigravity';
const LOCAL_CANCEL_GRACE_MS = 150;
function waitForDelayOrSettle(promise, ms) {
    if (ms <= 0) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        timer.unref?.();
        void promise.then(finish, finish);
    });
}
function formatSafeDiagnostic(error) {
    if (isSignInRequiredError(error)) {
        return 'Antigravity ACP authentication required; run "dsh-antigravity-acp login" to authenticate.';
    }
    if (error instanceof AntigravityAcpError) {
        return redactSensitiveText(`[${error.code}] ${error.message}`);
    }
    if (error instanceof Error) {
        const detail = redactSensitiveText(error.message).trim();
        return detail || error.name || 'Antigravity ACP subagent execution failed';
    }
    return redactSensitiveText(String(error ?? 'Antigravity ACP subagent execution failed'));
}
function mapStopReason(reason) {
    switch (reason) {
        case 'end_turn':
            return 'completed';
        case 'max_tokens':
            return 'max-tokens';
        case 'refusal':
            return 'refusal';
        case 'cancelled':
            return 'aborted';
        default:
            return 'error';
    }
}
function selectAllowedOption(options) {
    const chosen = selectPermissionOption(options, 'allow_once') ??
        selectPermissionOption(options, 'allow_always');
    if (chosen !== undefined) {
        return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
}
function applyPermissionFallback(options, fallback) {
    if (fallback === 'cancel') {
        return { outcome: { outcome: 'cancelled' } };
    }
    const rejected = selectPermissionOption(options, 'reject_once') ??
        selectPermissionOption(options, 'reject_always');
    if (rejected !== undefined) {
        return { outcome: { outcome: 'selected', optionId: rejected.optionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
}
/**
 * Evaluate an ACP `session/request_permission` prompt according to the configured
 * {@link AntigravityPermissionMode} and {@link AntigravityPermissionFallback}.
 */
export function resolveSubagentPermission(request, permissionMode, permissionFallback) {
    const options = request.options ?? [];
    switch (permissionMode) {
        case 'yolo':
            return selectAllowedOption(options);
        case 'auto_edit': {
            const kind = request.toolCall?.kind;
            if (kind === 'read' || kind === 'search' || kind === 'edit') {
                return selectAllowedOption(options);
            }
            return applyPermissionFallback(options, permissionFallback);
        }
        case 'auto':
        case 'default':
        default:
            return applyPermissionFallback(options, permissionFallback);
    }
}
async function convertSubagentPromptBlocks(blocks, supportsImages, attachments, systemFallbackText, signal) {
    const acpBlocks = [];
    if (systemFallbackText !== undefined && systemFallbackText.length > 0) {
        acpBlocks.push({
            type: 'text',
            text: `[System Instructions]\n${systemFallbackText}`,
        });
    }
    for (const block of blocks) {
        signal.throwIfAborted();
        switch (block.type) {
            case 'text':
                acpBlocks.push({ type: 'text', text: block.text });
                break;
            case 'image':
                if (supportsImages && attachments !== undefined && block.offloaded !== true) {
                    const stored = await attachments.readImage(block.attachment, signal);
                    acpBlocks.push({
                        type: 'image',
                        data: Buffer.from(stored.data).toString('base64'),
                        mimeType: stored.ref.mediaType,
                    });
                }
                else {
                    acpBlocks.push({
                        type: 'text',
                        text: textOnlyImageText(block.attachment),
                    });
                }
                break;
            case 'file':
                acpBlocks.push({
                    type: 'text',
                    text: fileHandleText(block.attachment, undefined),
                });
                break;
            default:
                break;
        }
    }
    if (acpBlocks.length === 0) {
        acpBlocks.push({ type: 'text', text: '' });
    }
    return acpBlocks;
}
/**
 * Out-of-process DSH {@link SubagentProvider} backed by isolated `agy acp` workers.
 *
 * Each run spawns an independent ACP subprocess with no DSH tool bridge (`mcpServers: []`),
 * allowing Antigravity's native agent loop to execute autonomously within `request.cwd`
 * under the configured permission policy.
 */
export class AntigravitySubagentProvider {
    runtime;
    config;
    attachments;
    logger;
    name;
    capabilities = NO_START_CAPABILITIES;
    inheritsParentContext = false;
    constructor(runtime, config, attachments, logger) {
        this.runtime = runtime;
        this.config = config;
        this.attachments = attachments;
        this.logger = logger;
        this.name = config.providerName?.trim() || 'antigravity';
        assertPositiveFinite(DIAGNOSTIC_PREFIX, 'disposeEofGraceMs', config.disposeEofGraceMs);
        assertPositiveFinite(DIAGNOSTIC_PREFIX, 'disposeGraceMs', config.disposeGraceMs);
    }
    async start(request) {
        request.signal.throwIfAborted();
        assertUsableCwd(DIAGNOSTIC_PREFIX, 'child cwd', request.cwd);
        if (request.agentOptions !== undefined) {
            throw new SubagentError(`subagent provider "${this.name}" does not support "agentOptions"`, 'UNSUPPORTED_CAPABILITY');
        }
        if (request.agentPreset !== undefined) {
            throw new SubagentError(`subagent provider "${this.name}" does not support "agentPreset"`, 'UNSUPPORTED_CAPABILITY');
        }
        if (request.outputSchema !== undefined) {
            throw new SubagentError(`subagent provider "${this.name}" does not support "outputSchema"`, 'UNSUPPORTED_CAPABILITY');
        }
        if (request.maxDepth !== undefined) {
            throw new SubagentError(`subagent provider "${this.name}" does not support "depthLimit"`, 'UNSUPPORTED_CAPABILITY');
        }
        const runId = randomUUID();
        let client;
        let session;
        let promptBlocks;
        try {
            client = await this.runtime.spawnClient({
                cwd: request.cwd,
                signal: request.signal,
                suppressBrowser: true,
            });
            const meta = antigravitySessionMeta(client.initialized.capabilities, this.config.systemPromptAppend);
            const systemFallback = meta === undefined && this.config.systemPromptAppend?.trim()
                ? this.config.systemPromptAppend.trim()
                : undefined;
            promptBlocks = await convertSubagentPromptBlocks(request.prompt, client.initialized.supportsImages, this.attachments, systemFallback, request.signal);
            session = await client.newSession({
                cwd: request.cwd,
                mcpServers: [],
                ...(meta !== undefined ? { meta } : {}),
            }, request.signal);
            if (this.config.defaultModel !== undefined && client.setSessionModel) {
                await client.setSessionModel(session.sessionId, this.config.defaultModel, request.signal);
            }
            if (this.config.defaultThoughtLevel !== undefined && client.setSessionThoughtLevel) {
                await client.setSessionThoughtLevel(session.sessionId, this.config.defaultThoughtLevel, request.signal);
            }
            const targetMode = antigravitySessionMode(this.config.permissionMode, session.modes?.availableModes);
            if (targetMode && session.modes?.currentModeId !== targetMode) {
                const modeAvailable = !session.modes?.availableModes ||
                    session.modes.availableModes.some((mode) => mode.id === targetMode);
                if (modeAvailable) {
                    await client.setSessionMode(session.sessionId, targetMode, request.signal);
                }
            }
            request.signal.throwIfAborted();
        }
        catch (error) {
            if (client !== undefined) {
                await client.close(this.config.disposeGraceMs).catch(() => { });
            }
            throw error;
        }
        const activeClient = client;
        const acpSessionId = session.sessionId;
        const fold = new AssistantOutputFold();
        let localCancelled = false;
        let promptDone = false;
        let lastDiagnostic;
        const turnAbortController = new AbortController();
        let resolveLocalCancel;
        const localCancelTriggered = new Promise((resolve) => {
            resolveLocalCancel = resolve;
        });
        const requestCancel = () => {
            if (localCancelled)
                return;
            localCancelled = true;
            turnAbortController.abort();
            resolveLocalCancel?.();
            if (!promptDone && !activeClient.isClosed) {
                void activeClient.cancel(acpSessionId).catch(() => { });
            }
        };
        const onAbort = () => {
            requestCancel();
        };
        request.signal.addEventListener('abort', onAbort, { once: true });
        const promptPromise = activeClient.prompt({
            sessionId: acpSessionId,
            prompt: promptBlocks,
        }, {
            onTextDelta: (text) => {
                fold.pushText(text);
            },
            onRequestPermission: (permReq) => resolveSubagentPermission(permReq, this.config.permissionMode, this.config.permissionFallback),
        }, turnAbortController.signal);
        const promptSettled = promptPromise.then(() => {
            promptDone = true;
        }, () => {
            promptDone = true;
        });
        let teardownPromise;
        const teardown = () => {
            if (teardownPromise !== undefined)
                return teardownPromise;
            teardownPromise = (async () => {
                if (!promptDone) {
                    requestCancel();
                    await waitForDelayOrSettle(Promise.race([promptSettled, activeClient.closed.catch(() => { })]), this.config.disposeEofGraceMs);
                }
                await activeClient.close(this.config.disposeGraceMs).catch(() => { });
            })();
            return teardownPromise;
        };
        if (request.signal.aborted) {
            requestCancel();
        }
        const result = settleRunResult({
            attempt: async () => {
                const cancelRace = localCancelTriggered.then(async () => {
                    await waitForDelayOrSettle(promptSettled, Math.min(LOCAL_CANCEL_GRACE_MS, this.config.disposeEofGraceMs));
                    return 'local-cancelled';
                });
                const outcome = await Promise.race([promptPromise, cancelRace]);
                if (outcome === 'local-cancelled' || localCancelled) {
                    return {
                        output: fold.collect() ?? [],
                        stopReason: 'aborted',
                    };
                }
                if (outcome.text.length > 0 && (fold.collect()?.length ?? 0) === 0) {
                    fold.pushText(outcome.text);
                }
                const stopReason = mapStopReason(outcome.stopReason);
                const output = fold.collect() ?? [];
                if (stopReason === 'error') {
                    return {
                        output,
                        stopReason,
                        diagnostic: redactSensitiveText(`ACP subagent turn stopped with reason: ${outcome.stopReason}`),
                    };
                }
                return { output, stopReason };
            },
            collectOutput: () => fold.collect() ?? [],
            collectDiagnostic: () => lastDiagnostic,
            cancelled: () => localCancelled,
            onError: (error, stopReason) => {
                const safe = formatSafeDiagnostic(error);
                lastDiagnostic = safe;
                this.logger?.warn(`${DIAGNOSTIC_PREFIX} run "${runId}" failed (${stopReason}): ${safe}`);
            },
            signal: request.signal,
            onAbort,
        }).finally(() => {
            void teardown().catch(() => { });
        });
        return subprocessRunHandle({
            id: runId,
            result,
            signal: request.signal,
            onAbort,
            requestCancel,
            teardown,
        });
    }
}
//# sourceMappingURL=provider.js.map