import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  buildAcpSpawnArgs,
  buildAntigravityEnvironment,
  removedEnvironmentKeys,
  type InternalAntigravityProfile,
} from '../runtime/profile.js';
import { compareSemver, MINIMUM_AGY_VERSION } from '../runtime/release.js';
import type { RuntimeConfig } from '../shared/config.js';
import type {
  AcpClientHandle,
  AcpInitializeSummary,
  AcpPromptResult,
  AcpSessionSetup,
  AcpTurnCallbacks,
  AntigravityExecutable,
  DiscoveredModel,
} from '../shared/contracts.js';
import { AntigravityAcpError, redactSensitiveText, type AntigravityErrorCode } from '../shared/errors.js';
import {
  antigravityClientInfo,
  antigravitySessionMeta,
  antigravitySessionMode,
  isSignInRequiredError,
  parseModelsAndThinking,
  selectPermissionOption,
  type AcpSessionModelState,
} from './protocol.js';
import { createStderrAuthScanner, createStdoutAuthFilter } from './stdout-filter.js';

const SEMVER_EXTRACT_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;
const GOOGLE_OAUTH_URL_PATTERN = /https:\/\/accounts\.google\.com\/(?:o\/oauth2|signin\/oauth)[^\s"'<>]*/gi;
const MAX_STDERR_TAIL_BYTES = 16 * 1024;
const MAX_STDERR_LINE_BUFFER_CHARS = 64 * 1024;
const CANCEL_FLUSH_GRACE_MS = 50;
const SPAWN_GRACE_MS = 3000;

/** Options for {@link spawnAcpClient}. */
export interface SpawnAcpClientOptions {
  readonly subprocess: SubprocessRuntime;
  readonly executable: AntigravityExecutable;
  readonly profile: InternalAntigravityProfile;
  readonly config: RuntimeConfig;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly callbacks?: AcpTurnCallbacks;
  readonly onAuthUrl?: (url: string) => void;
  readonly suppressBrowser?: boolean;
  readonly skipVersionCheck?: boolean;
  readonly signal?: AbortSignal;
}

interface CachedSessionState {
  configOptions?: readonly acp.SessionConfigOption[];
  modes?: acp.SessionModeState | null;
  legacyModels?: AcpSessionModelState | null;
}

interface NewSessionResponseLike extends acp.NewSessionResponse {
  models?: AcpSessionModelState | null;
}

interface LoadSessionResponseLike extends acp.LoadSessionResponse {
  models?: AcpSessionModelState | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeSessionMeta(
  baseMeta: Record<string, unknown> | undefined,
  systemPromptMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!baseMeta && !systemPromptMeta) {
    return undefined;
  }
  if (!baseMeta) {
    return systemPromptMeta;
  }
  if (!systemPromptMeta) {
    return baseMeta;
  }

  const baseAgy = isPlainRecord(baseMeta['antigravity']) ? baseMeta['antigravity'] : undefined;
  const sysAgy = isPlainRecord(systemPromptMeta['antigravity'])
    ? systemPromptMeta['antigravity']
    : undefined;
  const baseSysPrompt = baseAgy && isPlainRecord(baseAgy['systemPrompt'])
    ? baseAgy['systemPrompt']
    : undefined;
  const sysSysPrompt = sysAgy && isPlainRecord(sysAgy['systemPrompt'])
    ? sysAgy['systemPrompt']
    : undefined;

  return {
    ...baseMeta,
    ...systemPromptMeta,
    antigravity: {
      ...baseAgy,
      ...sysAgy,
      ...(baseSysPrompt || sysSysPrompt
        ? {
            systemPrompt: {
              ...baseSysPrompt,
              ...sysSysPrompt,
            },
          }
        : {}),
    },
  };
}

function buildSpawnEnv(options: SpawnAcpClientOptions): NodeJS.ProcessEnv {
  const envProfile: InternalAntigravityProfile =
    options.suppressBrowser === false
      ? { ...options.profile, browserCommand: undefined }
      : options.profile;

  const combinedBaseEnv: Record<string, string | undefined> = options.env
    ? { ...process.env, ...options.env }
    : process.env;

  const builtEnv = buildAntigravityEnvironment(envProfile, options.config, combinedBaseEnv);
  const spawnEnv: NodeJS.ProcessEnv = { ...builtEnv };

  const removedKeySet = new Set(
    removedEnvironmentKeys.map((key) => (process.platform === 'win32' ? key.toUpperCase() : key)),
  );

  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      const normalized = process.platform === 'win32' ? key.toUpperCase() : key;
      if (!removedKeySet.has(normalized)) {
        spawnEnv[key] = value;
      }
    }
  }

  for (const key of removedEnvironmentKeys) {
    const hasExplicit =
      process.platform === 'win32'
        ? Object.keys(spawnEnv).some((existing) => existing.toUpperCase() === key.toUpperCase())
        : Object.hasOwn(spawnEnv, key);
    if (!hasExplicit) {
      spawnEnv[key] = undefined;
    }
  }

  if (options.suppressBrowser === false) {
    spawnEnv['BROWSER'] = undefined;
  }

  return spawnEnv;
}

function sanitizeDiagnosticLine(line: string): string | null {
  if (
    line.includes(ANTIGRAVITY_AUTH_STDOUT_PREFIX) ||
    line.includes(ANTIGRAVITY_AUTH_BROWSER_MARKER)
  ) {
    return null;
  }
  return redactSensitiveText(line.replace(GOOGLE_OAUTH_URL_PATTERN, '[REDACTED_AUTH_URL]'));
}

function sanitizeDiagnosticText(text: string): string {
  const safeLines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cleaned = sanitizeDiagnosticLine(line);
    if (cleaned !== null && cleaned.trim().length > 0) {
      safeLines.push(cleaned);
    }
  }
  return safeLines.join('\n').trim();
}

function appendTail(current: string, chunk: string): string {
  const combined = current ? `${current}\n${chunk}` : chunk;
  if (Buffer.byteLength(combined, 'utf8') <= MAX_STDERR_TAIL_BYTES) {
    return combined;
  }
  const buf = Buffer.from(combined, 'utf8');
  return buf.subarray(buf.byteLength - MAX_STDERR_TAIL_BYTES).toString('utf8');
}

function extractSemver(version: string | undefined): string | undefined {
  if (!version) {
    return undefined;
  }
  const match = SEMVER_EXTRACT_PATTERN.exec(version.trim());
  return match?.[1];
}

function classifyRpcErrorCode(error: unknown, fallback: AntigravityErrorCode = 'TRANSPORT'): AntigravityErrorCode {
  if (isSignInRequiredError(error)) {
    return 'AGY_AUTH_REQUIRED';
  }
  if (error instanceof AntigravityAcpError) {
    return error.code;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'ABORTED';
  }

  const record = isPlainRecord(error) ? error : undefined;
  const rawCode = record?.['code'];
  const rawMessage =
    (error instanceof Error ? error.message : undefined) ??
    (typeof record?.['message'] === 'string' ? record['message'] : '');
  const lowerMsg = rawMessage.toLowerCase();

  if (rawCode === -32800) {
    return 'ABORTED';
  }
  if (rawCode === -32602) {
    return 'INVALID_REQUEST';
  }
  if (lowerMsg.includes('rate limit') || lowerMsg.includes('429') || lowerMsg.includes('resource_exhausted')) {
    return 'RATE_LIMIT';
  }
  if (lowerMsg.includes('quota')) {
    return 'QUOTA';
  }
  if (lowerMsg.includes('suspended') || lowerMsg.includes('account disabled')) {
    return 'AGY_ACCOUNT_SUSPENDED';
  }
  if (lowerMsg.includes('context window') || lowerMsg.includes('context length') || lowerMsg.includes('token limit')) {
    return 'CONTEXT_WINDOW_EXCEEDED';
  }
  if (lowerMsg.includes('unauthorized') || lowerMsg.includes('unauthenticated') || lowerMsg.includes('invalid api key')) {
    return 'AUTH';
  }
  if (lowerMsg.includes('timed out') || lowerMsg.includes('timeout')) {
    return 'TIMEOUT';
  }
  return fallback;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const record = error as unknown as Record<string, unknown>;
    const data = record['data'];
    if (isPlainRecord(data) && typeof data['details'] === 'string' && data['details'].trim()) {
      return `${error.message}: ${data['details']}`;
    }
    return error.message || error.name;
  }
  if (isPlainRecord(error) && typeof error['message'] === 'string') {
    return error['message'];
  }
  return typeof error === 'string' ? error : String(error ?? 'Antigravity ACP error');
}

function formatOutcomeDetail(outcome: SubprocessOutcome): string {
  if (outcome.signal) {
    return `Antigravity ACP process exited due to signal ${outcome.signal}`;
  }
  return `Antigravity ACP process exited with code ${outcome.exitCode ?? 'unknown'}`;
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeSignals(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new AntigravityAcpError(`ACP operation timed out after ${timeoutMs}ms`, 'TIMEOUT'));
  }, timeoutMs);

  const onCallerAbort = (): void => {
    controller.abort(
      callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new AntigravityAcpError('ACP operation aborted', 'ABORTED'),
    );
  };

  if (callerSignal) {
    if (callerSignal.aborted) {
      onCallerAbort();
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

function summarizeInitialize(
  resp: acp.InitializeResponse,
  executable: AntigravityExecutable,
): AcpInitializeSummary {
  const caps = resp.agentCapabilities;
  return {
    protocolVersion: resp.protocolVersion,
    agentName: resp.agentInfo?.name ?? undefined,
    agentVersion: resp.agentInfo?.version ?? executable.version ?? undefined,
    agentTitle: resp.agentInfo?.title ?? undefined,
    authMethods: resp.authMethods ?? [],
    capabilities: caps,
    supportsImages: Boolean(caps?.promptCapabilities?.image),
    supportsAudio: Boolean(caps?.promptCapabilities?.audio),
    supportsEmbeddedContext: Boolean(caps?.promptCapabilities?.embeddedContext),
    supportsLoadSession: Boolean(caps?.loadSession),
    supportsMcpHttp: Boolean(caps?.mcpCapabilities?.http),
    supportsMcpSse: Boolean(caps?.mcpCapabilities?.sse),
  };
}

/**
 * Spawn an Antigravity CLI ACP subprocess, negotiate `initialize`, and return a managed {@link AcpClientHandle}.
 */
export async function spawnAcpClient(options: SpawnAcpClientOptions): Promise<AcpClientHandle> {
  if (options.signal?.aborted) {
    throw new AntigravityAcpError('Aborted before spawning Antigravity ACP client', 'ABORTED');
  }

  const clientId = randomUUID();
  const spawnAbort = new AbortController();
  const spawnArgs = buildAcpSpawnArgs(options.executable, options.profile, options.config.extraArgs);
  const spawnEnv = buildSpawnEnv(options);

  let child: SubprocessHandle;
  try {
    child = options.subprocess.spawn({
      argv: [options.executable.command, ...spawnArgs],
      cwd: options.cwd,
      env: spawnEnv,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: SPAWN_GRACE_MS,
      signal: spawnAbort.signal,
    });
  } catch (err) {
    throw new AntigravityAcpError(
      `Failed to spawn Antigravity ACP subprocess: ${redactSensitiveText(formatErrorMessage(err))}`,
      err instanceof Error && err.name === 'AbortError' ? 'ABORTED' : 'TRANSPORT',
      { cause: err },
    );
  }

  const childStdin = child.stdin;
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (!childStdin || !childStdout || !childStderr) {
    child.terminate();
    await child.waitForExit(AbortSignal.timeout(SPAWN_GRACE_MS)).catch(() => false);
    throw new AntigravityAcpError('ACP subprocess did not expose piped stdio streams', 'TRANSPORT');
  }

  let persistentCallbacks: AcpTurnCallbacks | undefined = options.callbacks;
  let turnCallbacks: AcpTurnCallbacks | undefined;
  let stderrTail = '';
  let stderrPendingLine = '';
  let fatalError: AntigravityAcpError | undefined;
  let closedFlag = false;
  let closingDeliberately = false;
  let closePromise: Promise<void> | undefined;
  let activePromptSessionId: string | undefined;
  let activePromptPromise: Promise<unknown> | undefined;
  let promptAccumulator: {
    sessionId: string;
    text: string;
    reasoning: string;
    configOptions?: readonly acp.SessionConfigOption[];
  } | undefined;
  let pendingUpdateChain: Promise<void> = Promise.resolve();
  const sessionStates = new Map<string, CachedSessionState>();

  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const getActiveCallbacks = (): AcpTurnCallbacks | undefined => {
    if (turnCallbacks && persistentCallbacks) {
      return { ...persistentCallbacks, ...turnCallbacks };
    }
    return turnCallbacks ?? persistentCallbacks;
  };

  const getAuthUrlHandler = (): ((url: string) => void) | undefined => {
    return turnCallbacks?.onAuthUrl ?? persistentCallbacks?.onAuthUrl ?? options.onAuthUrl;
  };

  const getSafeStderrTail = (): string => {
    const combined = stderrPendingLine
      ? stderrTail
        ? `${stderrTail}\n${stderrPendingLine}`
        : stderrPendingLine
      : stderrTail;
    return sanitizeDiagnosticText(combined);
  };

  const wrapError = (error: unknown, fallbackCode: AntigravityErrorCode = 'TRANSPORT'): AntigravityAcpError => {
    if (error instanceof AntigravityAcpError) {
      return error;
    }
    const rawMsg = formatErrorMessage(error).replace(GOOGLE_OAUTH_URL_PATTERN, '[REDACTED_AUTH_URL]');
    if (fatalError && (rawMsg === 'ACP connection closed' || rawMsg.includes('connection closed'))) {
      return fatalError;
    }
    const code = classifyRpcErrorCode(error, fallbackCode);
    const tail = getSafeStderrTail();
    const msg =
      rawMsg === 'ACP connection closed' && tail
        ? `ACP connection closed (${tail.split(/\r?\n/).slice(-3).join(' | ')})`
        : rawMsg;
    return new AntigravityAcpError(msg, code, { cause: error });
  };

  let connection!: acp.ClientConnection;

  const failTransport = (err: AntigravityAcpError): void => {
    fatalError ??= err;
    if (connection && !connection.signal.aborted) {
      connection.close(err);
    }
    child.terminate();
  };

  const stderrScanner = createStderrAuthScanner({
    onAuthUrl: (url) => {
      getAuthUrlHandler()?.(url);
    },
  });

  const onStdinError = (): void => {
    // Ignore EPIPE when subprocess exits mid-write; connection/done handles failure.
  };
  childStdin.on('error', onStdinError);

  const onStderrData = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    stderrScanner(text);

    stderrPendingLine += text;
    let start = 0;
    while (true) {
      const nl = stderrPendingLine.indexOf('\n', start);
      if (nl === -1) {
        break;
      }
      const rawLine = stderrPendingLine.slice(start, nl).replace(/\r$/, '');
      start = nl + 1;
      const sanitized = sanitizeDiagnosticLine(rawLine);
      if (sanitized !== null && sanitized.trim().length > 0) {
        stderrTail = appendTail(stderrTail, sanitized);
      }
    }
    stderrPendingLine = start > 0 ? stderrPendingLine.slice(start) : stderrPendingLine;
    if (stderrPendingLine.length > MAX_STDERR_LINE_BUFFER_CHARS) {
      const sanitizedTail = sanitizeDiagnosticLine(stderrPendingLine);
      if (sanitizedTail !== null && sanitizedTail.trim().length > 0) {
        stderrTail = appendTail(stderrTail, sanitizedTail);
      }
      stderrPendingLine = '';
    }
  };
  childStderr.on('data', onStderrData);

  const stdoutFilter = createStdoutAuthFilter({
    onAuthUrl: (url) => {
      const handler = getAuthUrlHandler();
      if (handler) {
        handler(url);
        return;
      }
      failTransport(
        new AntigravityAcpError(
          'Antigravity ACP requires interactive sign-in (run `login` first)',
          'AGY_AUTH_REQUIRED',
        ),
      );
    },
    onProtocolError: (err) => {
      failTransport(wrapError(err));
    },
  });

  const onStdoutError = (err: Error): void => {
    if (!closingDeliberately) {
      failTransport(wrapError(err));
    }
  };
  const onFilterError = (err: Error): void => {
    if (!closingDeliberately) {
      failTransport(wrapError(err));
    }
  };
  childStdout.on('error', onStdoutError);
  stdoutFilter.on('error', onFilterError);
  childStdout.pipe(stdoutFilter);

  const acpStream = acp.ndJsonStream(
    Writable.toWeb(childStdin) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(stdoutFilter) as unknown as ReadableStream<Uint8Array>,
  );

  const clientCapabilities: acp.ClientCapabilities = {
    fs: {
      readTextFile: Boolean(options.callbacks?.onReadTextFile),
      writeTextFile: Boolean(options.callbacks?.onWriteTextFile),
    },
    terminal: false,
  };

  const app = acp
    .client({ name: 'dsh-antigravity-acp' })
    .onRequest(acp.CLIENT_METHODS.session_request_permission, async (ctx) => {
      const handler = getActiveCallbacks()?.onRequestPermission;
      if (handler) {
        return await handler(ctx.params);
      }
      const rejectOpt = selectPermissionOption(ctx.params.options, 'reject_once');
      return rejectOpt
        ? { outcome: { outcome: 'selected', optionId: rejectOpt.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    })
    .onNotification(acp.CLIENT_METHODS.session_update, (ctx) => {
      const notification = ctx.params;
      const run = pendingUpdateChain.then(async () => {
        const cbs = getActiveCallbacks();
        await cbs?.onSessionUpdate?.(notification);

        const update = notification.update;
        const isCurrentPromptSession =
          promptAccumulator !== undefined && notification.sessionId === promptAccumulator.sessionId;
        const cached = sessionStates.get(notification.sessionId) ?? {};

        switch (update.sessionUpdate) {
          case 'agent_message_chunk': {
            if (update.content.type === 'text') {
              if (isCurrentPromptSession && promptAccumulator) {
                promptAccumulator.text += update.content.text;
              }
              cbs?.onTextDelta?.(update.content.text, update.messageId);
            }
            break;
          }
          case 'agent_thought_chunk': {
            if (update.content.type === 'text') {
              if (isCurrentPromptSession && promptAccumulator) {
                promptAccumulator.reasoning += update.content.text;
              }
              cbs?.onThoughtDelta?.(update.content.text, update.messageId);
            }
            break;
          }
          case 'tool_call': {
            cbs?.onToolCall?.(update);
            break;
          }
          case 'tool_call_update': {
            cbs?.onToolCallUpdate?.(update);
            break;
          }
          case 'usage_update': {
            cbs?.onUsageUpdate?.(update);
            break;
          }
          case 'plan': {
            cbs?.onPlan?.(update);
            break;
          }
          case 'config_option_update': {
            cached.configOptions = update.configOptions;
            sessionStates.set(notification.sessionId, cached);
            if (isCurrentPromptSession && promptAccumulator) {
              promptAccumulator.configOptions = update.configOptions;
            }
            cbs?.onConfigOptionsUpdate?.(update.configOptions);
            break;
          }
          case 'current_mode_update': {
            if (cached.modes) {
              cached.modes = { ...cached.modes, currentModeId: update.currentModeId };
              sessionStates.set(notification.sessionId, cached);
            }
            cbs?.onModeUpdate?.(update.currentModeId);
            break;
          }
          default:
            break;
        }
      });
      pendingUpdateChain = run.catch(() => {});
      return run;
    });

  if (options.callbacks?.onReadTextFile) {
    app.onRequest(acp.CLIENT_METHODS.fs_read_text_file, async (ctx) => {
      const handler = getActiveCallbacks()?.onReadTextFile;
      if (!handler) {
        throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.fs_read_text_file);
      }
      return await handler(ctx.params);
    });
  }

  if (options.callbacks?.onWriteTextFile) {
    app.onRequest(acp.CLIENT_METHODS.fs_write_text_file, async (ctx) => {
      const handler = getActiveCallbacks()?.onWriteTextFile;
      if (!handler) {
        throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.fs_write_text_file);
      }
      return (await handler(ctx.params)) ?? {};
    });
  }

  connection = app.connect(acpStream);

  const markClosed = (): void => {
    if (closedFlag) {
      return;
    }
    closedFlag = true;
    childStdin.off('error', onStdinError);
    childStderr.off('data', onStderrData);
    childStdout.off('error', onStdoutError);
    stdoutFilter.off('error', onFilterError);
    resolveClosed();
  };

  void child.done.then(
    (outcome) => {
      if (!closingDeliberately && !fatalError) {
        const detail = formatOutcomeDetail(outcome);
        const tail = getSafeStderrTail();
        fatalError = new AntigravityAcpError(
          tail ? `${detail}: ${tail.split(/\r?\n/).slice(-3).join(' | ')}` : detail,
          'TRANSPORT',
        );
        if (!connection.signal.aborted) {
          connection.close(fatalError);
        }
      }
      markClosed();
    },
    (err) => {
      if (!closingDeliberately && !fatalError) {
        fatalError = wrapError(err);
        if (!connection.signal.aborted) {
          connection.close(fatalError);
        }
      }
      markClosed();
    },
  );

  async function closeClient(graceMs = SPAWN_GRACE_MS): Promise<void> {
    if (closePromise) {
      return closePromise;
    }
    closePromise = (async () => {
      closingDeliberately = true;
      closedFlag = true;
      try {
        if (!connection.signal.aborted) {
          connection.close(new AntigravityAcpError('ACP client closed', 'ABORTED'));
        }
      } catch {
        // Best-effort close.
      }
      try {
        if (childStdin && !childStdin.destroyed && !childStdin.writableEnded) {
          childStdin.end();
        }
      } catch {
        // Best-effort stdin EOF.
      }
      try {
        childStdout?.unpipe(stdoutFilter);
        stdoutFilter.destroy();
      } catch {
        // Best-effort filter teardown.
      }

      const effectiveGrace = Math.max(100, graceMs);
      const exitedCleanly = await Promise.race([
        child.done.then(() => true, () => true),
        delayMs(Math.min(250, effectiveGrace)).then(() => false),
      ]);

      if (!exitedCleanly) {
        child.terminate();
      }
      await Promise.allSettled([
        child.waitForExit(AbortSignal.timeout(effectiveGrace)).catch(() => false),
        child.done.catch(() => undefined),
      ]);
      markClosed();
    })();
    return closePromise;
  }

  async function runRequest<T>(
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
    exec: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (closedFlag) {
      throw fatalError ?? new AntigravityAcpError('ACP client is closed', 'TRANSPORT');
    }

    const merged = mergeSignals(timeoutMs, callerSignal);
    try {
      const rpcPromise = exec(merged.signal);
      rpcPromise.catch(() => {});

      const abortPromise = new Promise<never>((_, reject) => {
        const onAbort = (): void => {
          reject(
            merged.didTimeout()
              ? new AntigravityAcpError(`ACP request timed out after ${timeoutMs}ms`, 'TIMEOUT')
              : new AntigravityAcpError('ACP request aborted', 'ABORTED'),
          );
        };
        if (merged.signal.aborted) {
          onAbort();
        } else {
          merged.signal.addEventListener('abort', onAbort, { once: true });
        }
      });

      return await Promise.race([rpcPromise, abortPromise]);
    } catch (err) {
      throw wrapError(err);
    } finally {
      merged.cleanup();
    }
  }

  let initialized: AcpInitializeSummary;
  try {
    const initResp = await runRequest(
      options.config.handshakeTimeoutMs,
      options.signal,
      (signal) =>
        connection.agent.request(
          acp.AGENT_METHODS.initialize,
          {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities,
            clientInfo: antigravityClientInfo(options.executable.version),
          },
          { cancellationSignal: signal },
        ),
    );

    const reportedVersion = initResp.agentInfo?.version ?? options.executable.version;
    const cleanVersion = extractSemver(reportedVersion);
    if (!options.skipVersionCheck && cleanVersion) {
      if (compareSemver(cleanVersion, MINIMUM_AGY_VERSION) < 0) {
        throw new AntigravityAcpError(
          `Antigravity CLI version ${reportedVersion} is below minimum supported ${MINIMUM_AGY_VERSION}`,
          'AGY_VERSION_UNSUPPORTED',
        );
      }
    }

    initialized = summarizeInitialize(initResp, options.executable);
  } catch (err) {
    await closeClient(500);
    throw wrapError(err);
  }

  const updateCachedConfig = (
    sessionId: string,
    configOptions: readonly acp.SessionConfigOption[] | null | undefined,
  ): void => {
    if (!configOptions) {
      return;
    }
    const entry = sessionStates.get(sessionId) ?? {};
    entry.configOptions = configOptions;
    sessionStates.set(sessionId, entry);
  };

  const setSessionConfigOption = async (
    sessionId: string,
    configId: string,
    value: string | boolean,
    signal?: AbortSignal,
  ): Promise<acp.SetSessionConfigOptionResponse> => {
    const resp = await runRequest(options.config.requestTimeoutMs, signal, (reqSignal) =>
      connection.agent.request(
        acp.AGENT_METHODS.session_set_config_option,
        {
          sessionId,
          configId,
          value,
        } as acp.SetSessionConfigOptionRequest,
        { cancellationSignal: reqSignal },
      ),
    );
    updateCachedConfig(sessionId, resp.configOptions);
    return resp;
  };

  const setSessionModel = async (
    sessionId: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<readonly acp.SessionConfigOption[] | undefined> => {
    const cached = sessionStates.get(sessionId);
    const modelOpt =
      cached?.configOptions?.find((opt) => opt.category === 'model') ??
      cached?.configOptions?.find((opt) => opt.id === 'model');

    if (modelOpt || !cached?.legacyModels) {
      try {
        const resp = await setSessionConfigOption(
          sessionId,
          modelOpt?.id ?? 'model',
          model,
          signal,
        );
        return resp.configOptions;
      } catch (err) {
        const record = isPlainRecord(err) ? err : isPlainRecord((err as Error)?.cause) ? ((err as Error).cause as Record<string, unknown>) : undefined;
        if (record?.['code'] !== -32601) {
          throw err;
        }
      }
    }

    await runRequest(options.config.requestTimeoutMs, signal, (reqSignal) =>
      connection.agent.request<unknown, { sessionId: string; modelId: string }>(
        'session/set_model',
        { sessionId, modelId: model },
        { cancellationSignal: reqSignal },
      ),
    );
    return sessionStates.get(sessionId)?.configOptions;
  };

  const setSessionThoughtLevel = async (
    sessionId: string,
    level: string,
    signal?: AbortSignal,
  ): Promise<readonly acp.SessionConfigOption[] | undefined> => {
    const cached = sessionStates.get(sessionId);
    const thoughtOpt =
      cached?.configOptions?.find((opt) => opt.category === 'thought_level') ??
      cached?.configOptions?.find(
        (opt) => opt.id === 'thought_level' || opt.id === 'reasoning_effort',
      );
    const resp = await setSessionConfigOption(
      sessionId,
      thoughtOpt?.id ?? 'thought_level',
      level,
      signal,
    );
    return resp.configOptions;
  };

  const setSessionMode = async (
    sessionId: string,
    modeId: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const cached = sessionStates.get(sessionId);
    const normalizedMode = antigravitySessionMode(modeId, cached?.modes?.availableModes);
    await runRequest(options.config.requestTimeoutMs, signal, (reqSignal) =>
      connection.agent.request(
        acp.AGENT_METHODS.session_set_mode,
        { sessionId, modeId: normalizedMode },
        { cancellationSignal: reqSignal },
      ),
    );
    if (cached?.modes) {
      cached.modes = { ...cached.modes, currentModeId: normalizedMode };
      sessionStates.set(sessionId, cached);
    }
  };

  const cancelSession = async (sessionId: string): Promise<void> => {
    if (closedFlag || connection.signal.aborted) {
      return;
    }
    try {
      await connection.agent.notify(acp.AGENT_METHODS.session_cancel, { sessionId });
    } catch {
      // Idempotent best-effort cancel notification.
    }
  };

  const handle: AcpClientHandle = {
    id: clientId,
    initialized,
    executable: options.executable,
    profile: options.profile,
    closed: closedPromise,
    get isClosed() {
      return closedFlag;
    },

    async authenticate(methodId?: string, signal?: AbortSignal): Promise<void> {
      const chosenMethodId =
        methodId ??
        initialized.authMethods[0]?.id ??
        options.config.authMethod;
      await runRequest(options.config.authTimeoutMs, signal, (reqSignal) =>
        connection.agent.request(
          acp.AGENT_METHODS.authenticate,
          { methodId: chosenMethodId },
          { cancellationSignal: reqSignal },
        ),
      );
    },

    async logout(signal?: AbortSignal): Promise<void> {
      await runRequest(options.config.requestTimeoutMs, signal, (reqSignal) =>
        connection.agent.request(
          acp.AGENT_METHODS.logout,
          {},
          { cancellationSignal: reqSignal },
        ),
      );
    },

    setCallbacks(callbacks?: AcpTurnCallbacks): void {
      persistentCallbacks = callbacks;
    },

    async newSession(setup: AcpSessionSetup, signal?: AbortSignal): Promise<acp.NewSessionResponse> {
      const sysMeta = antigravitySessionMeta(initialized.capabilities, setup.systemPrompt);
      const mergedMeta = mergeSessionMeta(setup.meta, sysMeta);

      const req: acp.NewSessionRequest = {
        cwd: setup.cwd,
        mcpServers: [...(setup.mcpServers ?? [])],
        ...(setup.additionalDirectories?.length
          ? { additionalDirectories: [...setup.additionalDirectories] }
          : {}),
        ...(mergedMeta && Object.keys(mergedMeta).length > 0 ? { _meta: mergedMeta } : {}),
      };

      const resp = (await runRequest(options.config.requestTimeoutMs, signal, (reqSignal) =>
        connection.agent.request(acp.AGENT_METHODS.session_new, req, {
          cancellationSignal: reqSignal,
        }),
      )) as NewSessionResponseLike;

      const state: CachedSessionState = {
        configOptions: resp.configOptions ?? undefined,
        modes: resp.modes ?? undefined,
        legacyModels: resp.models ?? undefined,
      };
      sessionStates.set(resp.sessionId, state);

      let latestConfigOptions = resp.configOptions ?? undefined;
      if (setup.model) {
        const currentModel = latestConfigOptions?.find(
          (opt) => opt.category === 'model' || opt.id === 'model',
        );
        const currentVal =
          currentModel?.type === 'select'
            ? currentModel.currentValue
            : resp.models?.currentModelId;
        if (currentVal !== setup.model) {
          const updated = await setSessionModel(resp.sessionId, setup.model, signal);
          if (updated) {
            latestConfigOptions = [...updated];
          }
        }
      }

      if (setup.thoughtLevel) {
        const currentThought = latestConfigOptions?.find(
          (opt) => opt.category === 'thought_level' || opt.id === 'thought_level',
        );
        const currentVal =
          currentThought?.type === 'select' ? currentThought.currentValue : undefined;
        if (currentVal !== setup.thoughtLevel) {
          const updated = await setSessionThoughtLevel(
            resp.sessionId,
            setup.thoughtLevel,
            signal,
          );
          if (updated) {
            latestConfigOptions = [...updated];
          }
        }
      }

      if (setup.mode) {
        const normalized = antigravitySessionMode(setup.mode, resp.modes?.availableModes);
        if (resp.modes?.currentModeId !== normalized) {
          await setSessionMode(resp.sessionId, normalized, signal);
        }
      }

      return latestConfigOptions !== resp.configOptions
        ? { ...resp, configOptions: latestConfigOptions ?? resp.configOptions }
        : resp;
    },

    async loadSession(
      params: acp.LoadSessionRequest,
      signal?: AbortSignal,
    ): Promise<acp.LoadSessionResponse> {
      const resp = (await runRequest(options.config.requestTimeoutMs, signal, (reqSignal) =>
        connection.agent.request(acp.AGENT_METHODS.session_load, params, {
          cancellationSignal: reqSignal,
        }),
      )) as LoadSessionResponseLike;

      sessionStates.set(params.sessionId, {
        configOptions: resp.configOptions ?? undefined,
        modes: resp.modes ?? undefined,
        legacyModels: resp.models ?? undefined,
      });
      return resp;
    },

    setSessionModel,
    setSessionThoughtLevel,
    setSessionMode,
    setSessionConfigOption,

    async prompt(
      params: acp.PromptRequest,
      callbacks?: AcpTurnCallbacks,
      signal?: AbortSignal,
    ): Promise<AcpPromptResult> {
      if (closedFlag) {
        throw fatalError ?? new AntigravityAcpError('ACP client is closed', 'TRANSPORT');
      }
      if (activePromptSessionId !== undefined || activePromptPromise !== undefined) {
        throw new AntigravityAcpError(
          'An ACP prompt is already in flight on this client',
          'INVALID_REQUEST',
        );
      }

      activePromptSessionId = params.sessionId;
      turnCallbacks = callbacks;
      promptAccumulator = {
        sessionId: params.sessionId,
        text: '',
        reasoning: '',
        configOptions: sessionStates.get(params.sessionId)?.configOptions,
      };

      const merged = mergeSignals(options.config.promptTimeoutMs, signal);

      try {
        const rpcPromise = connection.agent.request(
          acp.AGENT_METHODS.session_prompt,
          params,
        );
        activePromptPromise = rpcPromise;
        const clearActivePrompt = (): void => {
          if (activePromptPromise === rpcPromise) {
            activePromptPromise = undefined;
          }
        };
        void rpcPromise.then(clearActivePrompt, clearActivePrompt);

        const abortPromise = new Promise<never>((_, reject) => {
          const onAbort = (): void => {
            void Promise.race([
              cancelSession(params.sessionId),
              delayMs(CANCEL_FLUSH_GRACE_MS),
            ]).finally(() => {
              reject(
                merged.didTimeout()
                  ? new AntigravityAcpError(
                      `ACP prompt timed out after ${options.config.promptTimeoutMs}ms`,
                      'TIMEOUT',
                    )
                  : new AntigravityAcpError('ACP prompt aborted', 'ABORTED'),
              );
            });
          };
          if (merged.signal.aborted) {
            onAbort();
          } else {
            merged.signal.addEventListener('abort', onAbort, { once: true });
          }
        });

        const response = await Promise.race([rpcPromise, abortPromise]);
        await pendingUpdateChain;

        const cached = sessionStates.get(params.sessionId);
        return {
          sessionId: params.sessionId,
          stopReason: response.stopReason,
          text: promptAccumulator.text,
          reasoning: promptAccumulator.reasoning,
          usage: response.usage ?? null,
          configOptions: promptAccumulator.configOptions ?? cached?.configOptions,
          modes: cached?.modes ?? null,
          meta: response._meta ?? null,
        };
      } catch (err) {
        await pendingUpdateChain.catch(() => {});
        throw wrapError(err);
      } finally {
        merged.cleanup();
        turnCallbacks = undefined;
        promptAccumulator = undefined;
        activePromptSessionId = undefined;
      }
    },

    cancel: cancelSession,

    async discoverModels(cwd: string, signal?: AbortSignal): Promise<readonly DiscoveredModel[]> {
      const resp = (await handle.newSession({ cwd, mcpServers: [] }, signal)) as NewSessionResponseLike;
      const models = parseModelsAndThinking({
        configOptions: resp.configOptions,
        models: resp.models,
      });

      if (initialized.capabilities?.sessionCapabilities?.close) {
        await runRequest(options.config.requestTimeoutMs, signal, (reqSignal) =>
          connection.agent.request(
            acp.AGENT_METHODS.session_close,
            { sessionId: resp.sessionId },
            { cancellationSignal: reqSignal },
          ),
        ).catch(() => {});
        sessionStates.delete(resp.sessionId);
      }

      return models;
    },

    close: closeClient,
  };

  return handle;
}
