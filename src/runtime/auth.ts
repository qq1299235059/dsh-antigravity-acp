import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { RuntimeConfig } from '../shared/config.js';
import type {
  AcpClientHandle,
  AntigravityExecutable,
  AntigravityProfile,
} from '../shared/contracts.js';
import { AntigravityAcpError, redactSensitiveText } from '../shared/errors.js';
import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  type InternalAntigravityProfile,
  type ParsedAntigravityAuthorizationUrl,
  buildAntigravityEnvironment,
  parseAntigravityAuthorizationUrl,
  prepareAntigravityProfile,
  resolveProfileSnapshot,
  validateAuthConfig,
  validateLoginResponse,
} from './profile.js';

const MAX_DIAGNOSTIC_TAIL_CHARS = 8_192;
const ACCOUNTS_GOOGLE_URL_RE = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/;
const ACCOUNTS_GOOGLE_URL_GLOBAL_RE = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/gi;

function sanitizeDiagnosticText(text: string): string {
  return redactSensitiveText(text).replace(ACCOUNTS_GOOGLE_URL_GLOBAL_RE, '[REDACTED_AUTH_URL]');
}

function sanitizeLoginDiagnosticLine(line: string): string | null {
  if (
    line.includes(ANTIGRAVITY_AUTH_STDOUT_PREFIX) ||
    line.includes(ANTIGRAVITY_AUTH_BROWSER_MARKER)
  ) {
    return null;
  }
  return sanitizeDiagnosticText(line);
}

/** Options for {@link runCodeLogin}. */
export interface RunCodeLoginOptions {
  readonly config: RuntimeConfig;
  readonly executable: AntigravityExecutable;
  readonly subprocess: SubprocessRuntime;
  readonly onAuthUrl: (url: string) => void | Promise<void>;
  readonly readCode: () => Promise<string>;
  readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
}

/** Options for {@link runLoopbackLogin}. */
export interface RunLoopbackLoginOptions {
  readonly config: RuntimeConfig;
  readonly connectClient: (params: {
    readonly profile: InternalAntigravityProfile;
    readonly onAuthUrl: (url: string) => void;
    readonly signal: AbortSignal;
  }) => Promise<AcpClientHandle>;
  readonly onAuthUrl?: (url: string) => void;
  readonly suppressBrowser?: boolean;
  readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
}

function appendBoundedTail(current: string, addition: string): string {
  const combined = current + addition;
  if (combined.length <= MAX_DIAGNOSTIC_TAIL_CHARS) {
    return combined;
  }
  return combined.slice(combined.length - MAX_DIAGNOSTIC_TAIL_CHARS);
}

function createCombinedAbortSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): {
  readonly signal: AbortSignal;
  readonly didTimeout: () => boolean;
  readonly cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Authentication timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function extractAuthUrlFromLine(line: string): ParsedAntigravityAuthorizationUrl | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const stdoutPrefixIdx = trimmed.indexOf(ANTIGRAVITY_AUTH_STDOUT_PREFIX);
  if (stdoutPrefixIdx !== -1) {
    const candidate = trimmed.slice(stdoutPrefixIdx + ANTIGRAVITY_AUTH_STDOUT_PREFIX.length).trim();
    const parsed = parseAntigravityAuthorizationUrl(candidate);
    if (parsed) {
      return parsed;
    }
  }

  const markerIdx = trimmed.indexOf(ANTIGRAVITY_AUTH_BROWSER_MARKER);
  if (markerIdx !== -1) {
    const rawJson = trimmed.slice(markerIdx + ANTIGRAVITY_AUTH_BROWSER_MARKER.length).trim();
    try {
      const decoded: unknown = JSON.parse(rawJson);
      if (typeof decoded === 'string') {
        const parsed = parseAntigravityAuthorizationUrl(decoded);
        if (parsed) {
          return parsed;
        }
      } else if (
        typeof decoded === 'object' &&
        decoded !== null &&
        typeof (decoded as { url?: unknown }).url === 'string'
      ) {
        const parsed = parseAntigravityAuthorizationUrl((decoded as { url: string }).url);
        if (parsed) {
          return parsed;
        }
      }
    } catch {
      // Fall through to generic URL scan
    }
  }

  const urlMatch = ACCOUNTS_GOOGLE_URL_RE.exec(trimmed);
  if (urlMatch) {
    return parseAntigravityAuthorizationUrl(urlMatch[0]);
  }

  return null;
}

async function writeStdinLine(handle: SubprocessHandle, line: string): Promise<void> {
  const stdin = handle.stdin;
  if (!stdin || stdin.destroyed || stdin.writableEnded) {
    throw new AntigravityAcpError(
      'Cannot submit authorization code because login process stdin is closed',
      'AUTH',
    );
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      stdin.off('error', onError);
      reject(
        new AntigravityAcpError(
          `Failed to write authorization code to login process: ${redactSensitiveText(err.message)}`,
          'AUTH',
          { cause: err },
        ),
      );
    };
    stdin.once('error', onError);
    stdin.write(`${line}\n`, 'utf8', (err) => {
      stdin.off('error', onError);
      if (err) {
        reject(
          new AntigravityAcpError(
            `Failed to write authorization code to login process: ${redactSensitiveText(err.message)}`,
            'AUTH',
            { cause: err },
          ),
        );
      } else {
        resolve();
      }
    });
  });
}

/**
 * Inspect whether the configured Antigravity profile currently holds usable credentials.
 */
export async function checkProfileAuth(
  config: RuntimeConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir: string = os.homedir(),
  platform?: NodeJS.Platform,
): Promise<AntigravityProfile> {
  return resolveProfileSnapshot(config, env, homeDir, platform);
}

/**
 * Run interactive headless code login via `agy acp --login`.
 */
export async function runCodeLogin(options: RunCodeLoginOptions): Promise<AntigravityProfile> {
  const envInput = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const activePlatform = options.platform ?? process.platform;

  if (options.signal?.aborted) {
    throw new AntigravityAcpError('Login aborted', 'ABORTED', { cause: options.signal.reason });
  }

  validateAuthConfig(options.config, envInput, activePlatform);

  const profile = await prepareAntigravityProfile(options.config, {
    env: envInput,
    homeDir,
    platform: activePlatform,
    suppressBrowser: true,
  });

  const args = [
    ...options.executable.argsPrefix,
    '--login',
    '--gemini-dir',
    profile.geminiHome,
    '--app-data-dir',
    'antigravity-acp',
    ...options.config.extraArgs,
  ];
  const childEnv = buildAntigravityEnvironment(profile, options.config, envInput);
  const { signal, didTimeout, cleanup } = createCombinedAbortSignal(
    options.config.authTimeoutMs,
    options.signal,
  );

  let handle: SubprocessHandle;
  try {
    handle = options.subprocess.spawn({
      argv: [options.executable.command, ...args],
      cwd: options.cwd ?? profile.profileDir,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3_000,
      env: childEnv,
      signal,
    });
  } catch (error) {
    cleanup();
    if (options.signal?.aborted) {
      throw new AntigravityAcpError('Login aborted', 'ABORTED', { cause: error });
    }
    throw new AntigravityAcpError(
      `Failed to spawn Antigravity login process: ${redactSensitiveText((error as Error)?.message ?? String(error))}`,
      'AUTH',
      { cause: error },
    );
  }

  handle.stdin?.on('error', () => {
    // Prevent unhandled stream error if child closes stdin early
  });

  let stdoutBuffer = '';
  let stderrBuffer = '';
  let diagnosticTail = '';
  let authUrlHandled = false;
  let authInteractionCompleted = false;
  let pendingAuthPromise: Promise<void> | null = null;
  let authInteractionError: unknown = null;

  const handleParsedLine = (line: string) => {
    const sanitizedLine = sanitizeLoginDiagnosticLine(line);
    if (sanitizedLine !== null) {
      diagnosticTail = appendBoundedTail(diagnosticTail, `${sanitizedLine}\n`);
    }
    if (authUrlHandled) {
      return;
    }
    const parsed = extractAuthUrlFromLine(line);
    if (!parsed) {
      return;
    }
    authUrlHandled = true;
    pendingAuthPromise = (async () => {
      try {
        await options.onAuthUrl(parsed.url);
        const rawCode = await options.readCode();
        const validated = validateLoginResponse(parsed, rawCode);
        await writeStdinLine(handle, validated.code);
      } catch (err) {
        authInteractionError = err instanceof Error ? err : new Error(String(err));
        handle.terminate();
      } finally {
        authInteractionCompleted = true;
      }
    })();
  };

  const attachReader = (stream: NodeJS.ReadableStream | undefined, isStdout: boolean) => {
    if (!stream) {
      return;
    }
    stream.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let buffer = (isStdout ? stdoutBuffer : stderrBuffer) + text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      if (isStdout) {
        stdoutBuffer = buffer;
      } else {
        stderrBuffer = buffer;
      }
      for (const line of lines) {
        handleParsedLine(line);
      }
    });
    stream.on('end', () => {
      const rem = isStdout ? stdoutBuffer : stderrBuffer;
      if (rem) {
        if (isStdout) {
          stdoutBuffer = '';
        } else {
          stderrBuffer = '';
        }
        handleParsedLine(rem);
      }
    });
  };

  attachReader(handle.stdout, true);
  attachReader(handle.stderr, false);

  try {
    const outcome = await handle.done;
    if (pendingAuthPromise && !authInteractionCompleted) {
      await Promise.race([
        pendingAuthPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
    } else if (pendingAuthPromise) {
      await pendingAuthPromise;
    }
    if (authInteractionError) {
      if (authInteractionError instanceof AntigravityAcpError) {
        throw authInteractionError;
      }
      if (options.signal?.aborted) {
        throw new AntigravityAcpError('Login aborted', 'ABORTED', {
          cause: authInteractionError,
        });
      }
      const msg =
        authInteractionError instanceof Error
          ? authInteractionError.message
          : String(authInteractionError);
      throw new AntigravityAcpError(sanitizeDiagnosticText(msg), 'AUTH', {
        cause: authInteractionError,
      });
    }
    if (didTimeout()) {
      throw new AntigravityAcpError(
        `Antigravity login timed out after ${options.config.authTimeoutMs}ms`,
        'TIMEOUT',
      );
    }
    if (options.signal?.aborted) {
      throw new AntigravityAcpError('Antigravity login aborted', 'ABORTED', {
        cause: options.signal.reason,
      });
    }
    if (!authUrlHandled) {
      const tail = diagnosticTail.trim();
      throw new AntigravityAcpError(
        tail
          ? `Antigravity login exited before emitting an authorization URL: ${tail}`
          : 'Antigravity login exited before emitting an authorization URL',
        'AUTH',
      );
    }
    if (outcome.exitCode !== 0 || outcome.signal !== null) {
      const tail = diagnosticTail.trim();
      throw new AntigravityAcpError(
        `Antigravity login failed (exitCode=${String(outcome.exitCode)}, signal=${String(outcome.signal)})${tail ? `: ${tail}` : ''}`,
        'AUTH',
      );
    }

    return resolveProfileSnapshot(options.config, envInput, homeDir, activePlatform);
  } catch (error) {
    handle.terminate();
    if (error instanceof AntigravityAcpError) {
      throw error;
    }
    if (didTimeout()) {
      throw new AntigravityAcpError(
        `Antigravity login timed out after ${options.config.authTimeoutMs}ms`,
        'TIMEOUT',
        { cause: error },
      );
    }
    if (options.signal?.aborted) {
      throw new AntigravityAcpError('Antigravity login aborted', 'ABORTED', { cause: error });
    }
    throw new AntigravityAcpError(
      `Antigravity login failed: ${sanitizeDiagnosticText((error as Error)?.message ?? String(error))}`,
      'AUTH',
      { cause: error },
    );
  } finally {
    handle.terminate();
    cleanup();
  }
}

/**
 * Run loopback OAuth login through a caller-supplied ACP client connector.
 */
export async function runLoopbackLogin(
  options: RunLoopbackLoginOptions,
): Promise<AntigravityProfile> {
  const envInput = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const activePlatform = options.platform ?? process.platform;

  if (options.signal?.aborted) {
    throw new AntigravityAcpError('Login aborted', 'ABORTED', { cause: options.signal.reason });
  }

  validateAuthConfig(options.config, envInput, activePlatform);

  const profile = await prepareAntigravityProfile(options.config, {
    env: envInput,
    homeDir,
    platform: activePlatform,
    suppressBrowser: options.suppressBrowser ?? Boolean(options.onAuthUrl),
  });

  const { signal, didTimeout, cleanup } = createCombinedAbortSignal(
    options.config.authTimeoutMs,
    options.signal,
  );

  const forwardAuthUrl = (rawUrl: string) => {
    const parsed = parseAntigravityAuthorizationUrl(rawUrl);
    if (parsed) {
      options.onAuthUrl?.(parsed.url);
    }
  };

  let client: AcpClientHandle | undefined;
  try {
    client = await options.connectClient({
      profile,
      onAuthUrl: forwardAuthUrl,
      signal,
    });

    const advertisedMethods = client.initialized.authMethods;
    const matchedMethod = advertisedMethods.find((m) => m.id === options.config.authMethod);
    const methodId = matchedMethod?.id ?? options.config.authMethod;

    await client.authenticate(methodId, signal);
    return resolveProfileSnapshot(options.config, envInput, homeDir, activePlatform);
  } catch (error) {
    if (error instanceof AntigravityAcpError) {
      throw error;
    }
    if (didTimeout()) {
      throw new AntigravityAcpError(
        `Antigravity loopback login timed out after ${options.config.authTimeoutMs}ms`,
        'TIMEOUT',
        { cause: error },
      );
    }
    if (options.signal?.aborted) {
      throw new AntigravityAcpError('Antigravity loopback login aborted', 'ABORTED', {
        cause: error,
      });
    }
    throw new AntigravityAcpError(
      `Antigravity loopback login failed: ${sanitizeDiagnosticText((error as Error)?.message ?? String(error))}`,
      'AUTH',
      { cause: error },
    );
  } finally {
    cleanup();
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

/**
 * Remove stored OAuth credentials and account files from an isolated profile.
 */
export async function clearProfileAuth(
  profile: AntigravityProfile | InternalAntigravityProfile,
): Promise<void> {
  const internal = profile as Partial<InternalAntigravityProfile>;
  const geminiHome = internal.geminiHome ?? path.join(profile.profileDir, '.gemini');
  const acpDirectory = internal.acpDirectory ?? path.join(geminiHome, 'antigravity-acp');
  const tokenPath = internal.tokenPath ?? path.join(acpDirectory, 'oauth_creds.json');
  const cliTokenPath = internal.cliTokenPath ?? path.join(geminiHome, 'oauth_creds.json');

  const filesToRemove = new Set([
    tokenPath,
    cliTokenPath,
    path.join(acpDirectory, 'antigravity_oauth_creds.json'),
    path.join(geminiHome, 'antigravity_oauth_creds.json'),
    path.join(acpDirectory, 'google_accounts.json'),
    path.join(geminiHome, 'google_accounts.json'),
    path.join(acpDirectory, 'mcp-oauth-tokens-v2.json'),
    path.join(geminiHome, 'mcp-oauth-tokens-v2.json'),
  ]);

  await Promise.all(
    [...filesToRemove].map((filePath) => fs.promises.rm(filePath, { force: true })),
  );
}
