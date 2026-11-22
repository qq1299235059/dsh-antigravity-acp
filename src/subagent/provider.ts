import { randomUUID } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import {
  fileHandleText,
  textOnlyImageText,
  type ContentBlock,
} from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import {
  AssistantOutputFold,
  NO_START_CAPABILITIES,
  SubagentError,
  assertPositiveFinite,
  assertUsableCwd,
  settleRunResult,
  subprocessRunHandle,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent';
import type {
  AntigravityPermissionFallback,
  AntigravityPermissionMode,
  SubagentPluginConfig,
} from '../shared/config.js';
import type {
  AcpClientHandle,
  AcpPromptResult,
  AntigravityRuntimeService,
} from '../shared/contracts.js';
import { AntigravityAcpError, redactSensitiveText } from '../shared/errors.js';
import {
  antigravitySessionMeta,
  antigravitySessionMode,
  isSignInRequiredError,
  selectPermissionOption,
} from '../acp/protocol.js';
import { consumePendingCallOverrides } from './overrides.js';

/** Minimal logger surface accepted by {@link AntigravitySubagentProvider}. */
export interface SubagentProviderLogger {
  debug?(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

const DIAGNOSTIC_PREFIX = 'subagent-antigravity';
const LOCAL_CANCEL_GRACE_MS = 150;

function waitForDelayOrSettle(promise: Promise<unknown>, ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    void promise.then(finish, finish);
  });
}

function formatSafeDiagnostic(error: unknown): string {
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

function mapStopReason(reason: acp.StopReason): SubagentStopReason {
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

function selectAllowedOption(
  options: readonly acp.PermissionOption[],
): acp.RequestPermissionResponse {
  const chosen =
    selectPermissionOption(options, 'allow_once') ??
    selectPermissionOption(options, 'allow_always');
  if (chosen !== undefined) {
    return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

function applyPermissionFallback(
  options: readonly acp.PermissionOption[],
  fallback: AntigravityPermissionFallback,
): acp.RequestPermissionResponse {
  if (fallback === 'cancel') {
    return { outcome: { outcome: 'cancelled' } };
  }
  const rejected =
    selectPermissionOption(options, 'reject_once') ??
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
export function resolveSubagentPermission(
  request: acp.RequestPermissionRequest,
  permissionMode: AntigravityPermissionMode,
  permissionFallback: AntigravityPermissionFallback,
): acp.RequestPermissionResponse {
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

async function convertSubagentPromptBlocks(
  blocks: readonly ContentBlock[],
  supportsImages: boolean,
  attachments: AttachmentStore | undefined,
  systemFallbackText: string | undefined,
  signal: AbortSignal,
): Promise<acp.ContentBlock[]> {
  const acpBlocks: acp.ContentBlock[] = [];

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
        } else {
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
export class AntigravitySubagentProvider implements SubagentProvider {
  readonly name: string;
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES;
  readonly inheritsParentContext = false;
  private readonly resolveConfig: () => SubagentPluginConfig;

  constructor(
    private readonly runtime: AntigravityRuntimeService,
    configOrResolver: SubagentPluginConfig | (() => SubagentPluginConfig),
    private readonly attachments?: AttachmentStore,
    private readonly logger?: SubagentProviderLogger,
  ) {
    this.resolveConfig =
      typeof configOrResolver === 'function' ? configOrResolver : () => configOrResolver;
    const initial = this.resolveConfig();
    this.name = initial.providerName?.trim() || 'antigravity';
    assertPositiveFinite(DIAGNOSTIC_PREFIX, 'disposeEofGraceMs', initial.disposeEofGraceMs);
    assertPositiveFinite(DIAGNOSTIC_PREFIX, 'disposeGraceMs', initial.disposeGraceMs);
  }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    request.signal.throwIfAborted();
    assertUsableCwd(DIAGNOSTIC_PREFIX, 'child cwd', request.cwd);
    const activeConfig = this.resolveConfig();
    const callOverrides = consumePendingCallOverrides(request.prompt);
    const targetModel = callOverrides?.model ?? activeConfig.defaultModel;
    const targetThoughtLevel = callOverrides?.thoughtLevel ?? activeConfig.defaultThoughtLevel;

    if (request.agentOptions !== undefined) {
      throw new SubagentError(
        `subagent provider "${this.name}" does not support "agentOptions"`,
        'UNSUPPORTED_CAPABILITY',
      );
    }
    if (request.agentPreset !== undefined) {
      throw new SubagentError(
        `subagent provider "${this.name}" does not support "agentPreset"`,
        'UNSUPPORTED_CAPABILITY',
      );
    }
    if (request.outputSchema !== undefined) {
      throw new SubagentError(
        `subagent provider "${this.name}" does not support "outputSchema"`,
        'UNSUPPORTED_CAPABILITY',
      );
    }
    if (request.maxDepth !== undefined) {
      throw new SubagentError(
        `subagent provider "${this.name}" does not support "depthLimit"`,
        'UNSUPPORTED_CAPABILITY',
      );
    }

    const runId = randomUUID() as SessionId;
    let client: AcpClientHandle | undefined;
    let session: acp.NewSessionResponse;
    let promptBlocks: acp.ContentBlock[];

    try {
      client = await this.runtime.spawnClient({
        cwd: request.cwd,
        signal: request.signal,
        suppressBrowser: true,
      });

      const meta = antigravitySessionMeta(
        client.initialized.capabilities,
        activeConfig.systemPromptAppend,
      );
      const systemFallback =
        meta === undefined && activeConfig.systemPromptAppend?.trim()
          ? activeConfig.systemPromptAppend.trim()
          : undefined;

      promptBlocks = await convertSubagentPromptBlocks(
        request.prompt,
        client.initialized.supportsImages,
        this.attachments,
        systemFallback,
        request.signal,
      );

      session = await client.newSession(
        {
          cwd: request.cwd,
          mcpServers: [],
          ...(meta !== undefined ? { meta } : {}),
        },
        request.signal,
      );

      if (targetModel !== undefined && client.setSessionModel) {
        await client.setSessionModel(session.sessionId, targetModel, request.signal);
      }

      if (targetThoughtLevel !== undefined && client.setSessionThoughtLevel) {
        await client.setSessionThoughtLevel(
          session.sessionId,
          targetThoughtLevel,
          request.signal,
        );
      }

      const targetMode = antigravitySessionMode(
        activeConfig.permissionMode,
        session.modes?.availableModes,
      );
      if (targetMode && session.modes?.currentModeId !== targetMode) {
        const modeAvailable =
          !session.modes?.availableModes ||
          session.modes.availableModes.some((mode) => mode.id === targetMode);
        if (modeAvailable) {
          await client.setSessionMode(session.sessionId, targetMode, request.signal);
        }
      }

      request.signal.throwIfAborted();
    } catch (error: unknown) {
      if (client !== undefined) {
        await client.close(activeConfig.disposeGraceMs).catch(() => {});
      }
      throw error;
    }

    const activeClient = client;
    const acpSessionId = session.sessionId;
    const fold = new AssistantOutputFold();
    let localCancelled = false;
    let promptDone = false;
    let lastDiagnostic: string | undefined;
    const turnAbortController = new AbortController();
    let resolveLocalCancel: (() => void) | undefined;
    const localCancelTriggered = new Promise<void>((resolve) => {
      resolveLocalCancel = resolve;
    });

    const requestCancel = (): void => {
      if (localCancelled) return;
      localCancelled = true;
      turnAbortController.abort();
      resolveLocalCancel?.();
      if (!promptDone && !activeClient.isClosed) {
        void activeClient.cancel(acpSessionId).catch(() => {});
      }
    };

    const onAbort = (): void => {
      requestCancel();
    };
    request.signal.addEventListener('abort', onAbort, { once: true });

    const promptPromise = activeClient.prompt(
      {
        sessionId: acpSessionId,
        prompt: promptBlocks,
      },
      {
        onTextDelta: (text) => {
          fold.pushText(text);
        },
        onRequestPermission: (permReq) =>
          resolveSubagentPermission(
            permReq,
            activeConfig.permissionMode,
            activeConfig.permissionFallback,
          ),
      },
      turnAbortController.signal,
    );

    const promptSettled = promptPromise.then(
      () => {
        promptDone = true;
      },
      () => {
        promptDone = true;
      },
    );

    let teardownPromise: Promise<void> | undefined;
    const teardown = (): Promise<void> => {
      if (teardownPromise !== undefined) return teardownPromise;
      teardownPromise = (async () => {
        if (!promptDone) {
          requestCancel();
          await waitForDelayOrSettle(
            Promise.race([promptSettled, activeClient.closed.catch(() => {})]),
            activeConfig.disposeEofGraceMs,
          );
        }
        await activeClient.close(activeConfig.disposeGraceMs).catch(() => {});
      })();
      return teardownPromise;
    };

    if (request.signal.aborted) {
      requestCancel();
    }

    const result = settleRunResult({
      attempt: async (): Promise<SubagentResult> => {
        const cancelRace = localCancelTriggered.then(
          async (): Promise<AcpPromptResult | 'local-cancelled'> => {
            await waitForDelayOrSettle(
              promptSettled,
              Math.min(LOCAL_CANCEL_GRACE_MS, activeConfig.disposeEofGraceMs),
            );
            return 'local-cancelled';
          },
        );
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
            diagnostic: redactSensitiveText(
              `ACP subagent turn stopped with reason: ${outcome.stopReason}`,
            ),
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
      void teardown().catch(() => {});
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
