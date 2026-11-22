#!/usr/bin/env node
import { spawn as nodeSpawn, spawnSync, type ChildProcess } from 'node:child_process';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { delimiter, extname, isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessRuntime,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess';
import {
  RuntimeConfigSchema,
  type AntigravityAuthMethod,
  type RuntimeConfig,
  type RuntimeConfigInput,
} from './shared/config.js';
import { AntigravityAcpError, redactSensitiveText } from './shared/errors.js';
import { validateProxyUrl } from './runtime/profile.js';
import { MINIMUM_AGY_VERSION, compareSemver } from './runtime/release.js';
import { checkPluginUpdate } from './runtime/updater.js';
import { createAntigravityRuntimeService } from './index.js';

const SENSITIVE_PARENT_ENV_RE =
  /(?:^|_)(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|CREDENTIALS|PRIVATE_KEY|AUTH_TOKEN|ACCESS_KEY|SESSION_KEY)(?:_|$)/i;

function buildScrubbedChildEnv(extra?: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper.startsWith('DSH_')) continue;
    if (SENSITIVE_PARENT_ENV_RE.test(upper)) continue;
    base[key] = value;
  }

  if (!extra) {
    return base;
  }

  if (process.platform !== 'win32') {
    const merged: NodeJS.ProcessEnv = { ...base };
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
    return merged;
  }

  let entries = Object.entries(base);
  for (const [key, value] of Object.entries(extra)) {
    const upper = key.toUpperCase();
    entries = entries.filter(([existing]) => existing.toUpperCase() !== upper);
    if (value !== undefined) {
      entries.push([key, value]);
    }
  }
  return Object.fromEntries(entries);
}

class BoundedOutputReader implements SubprocessOutputReader {
  private buffer: Buffer = Buffer.alloc(0);
  private totalBytes = 0;
  private droppedBytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.totalBytes += chunk.byteLength;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > this.maxBytes) {
      this.droppedBytes = this.totalBytes - this.maxBytes;
      this.buffer = this.buffer.subarray(this.buffer.byteLength - this.maxBytes);
    }
  }

  readFrom(fromByte: number): SubprocessOutputRead {
    if (fromByte < this.droppedBytes) {
      return {
        text: this.buffer.toString('utf8'),
        nextOffset: this.totalBytes,
        lossy: true,
      };
    }
    const offset = Math.max(0, fromByte - this.droppedBytes);
    return {
      text: this.buffer.subarray(offset).toString('utf8'),
      nextOffset: this.totalBytes,
      lossy: false,
    };
  }
}

function isCollectMode(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return typeof mode === 'object' && mode !== null;
}

function terminateChildProcessTree(
  child: ChildProcess,
  sig: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (pid === undefined || pid <= 0) {
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      try {
        child.kill();
      } catch {
        // Ignore already-exited child.
      }
    }
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // Ignore already-exited child.
    }
  }
}

/**
 * Lightweight standalone {@link SubprocessRuntime} implemented purely on Node's `child_process`
 * so the CLI works independently without `@deepseek-ai/dsh-subprocess-local`.
 */
export function createStandaloneSubprocessRuntime(): SubprocessRuntime {
  const resolveExecutable = async (
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> => {
    if (!command) {
      throw new Error('cli-subprocess: command must be non-empty');
    }
    signal?.throwIfAborted();
    const mergedEnv = buildScrubbedChildEnv(env);
    const absolute = isAbsolute(command);
    if (!absolute && (command.includes('/') || (process.platform === 'win32' && command.includes('\\')))) {
      throw new Error(
        `cli-subprocess: relative command path ${JSON.stringify(command)} is not allowed`,
      );
    }

    let candidates: string[];
    if (absolute) {
      candidates = [command];
    } else {
      const pathRaw =
        process.platform === 'win32'
          ? Object.entries(mergedEnv).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? ''
          : mergedEnv['PATH'] ?? '';
      const pathExtRaw =
        process.platform === 'win32'
          ? Object.entries(mergedEnv).find(([k]) => k.toUpperCase() === 'PATHEXT')?.[1] ??
            '.COM;.EXE;.BAT;.CMD'
          : '';
      const extensions =
        process.platform === 'win32' && extname(command) === ''
          ? pathExtRaw.split(';').filter(Boolean)
          : [''];
      candidates = pathRaw
        .split(delimiter)
        .filter(Boolean)
        .flatMap((dir) => extensions.map((ext) => resolve(dir, `${command}${ext}`)));
    }

    for (const candidate of candidates) {
      signal?.throwIfAborted();
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        if (process.platform !== 'win32') {
          await access(candidate, fsConstants.X_OK);
        }
        return candidate;
      } catch {
        // Try next candidate.
      }
    }

    throw new AntigravityAcpError(
      `Executable ${JSON.stringify(command)} was not found`,
      'AGY_NOT_INSTALLED',
    );
  };

  const spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0) {
      throw new Error('cli-subprocess: graceMs must be a positive finite number');
    }
    if (spec.signal?.aborted) {
      const err = new Error('aborted before spawn');
      err.name = 'AbortError';
      throw err;
    }
    const [program, ...restArgs] = spec.argv;
    if (!program) {
      throw new Error('cli-subprocess: argv[0] must be non-empty');
    }

    const childEnv = buildScrubbedChildEnv(spec.env);
    const stdio: ('ignore' | 'pipe' | 'inherit')[] = [
      spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe',
      spec.stdio.stdout === 'inherit' ? 'inherit' : 'pipe',
      spec.stdio.stderr === 'inherit' ? 'inherit' : 'pipe',
    ];

    const isWindowsBatch =
      process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(program);
    const spawnProgram = isWindowsBatch ? process.env['ComSpec'] || 'cmd.exe' : program;
    const spawnArgs = isWindowsBatch
      ? ['/d', '/s', '/c', program, ...restArgs]
      : restArgs;

    const child = nodeSpawn(spawnProgram, spawnArgs, {
      cwd: spec.cwd,
      env: childEnv,
      stdio,
      detached: process.platform !== 'win32',
      windowsHide: process.platform === 'win32',
    });

    const stdoutCollector = isCollectMode(spec.stdio.stdout)
      ? new BoundedOutputReader(spec.stdio.stdout.maxBytes)
      : undefined;
    const stderrCollector = isCollectMode(spec.stdio.stderr)
      ? new BoundedOutputReader(spec.stdio.stderr.maxBytes)
      : undefined;

    if (stdoutCollector && child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => stdoutCollector.push(chunk));
    }
    if (stderrCollector && child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => stderrCollector.push(chunk));
    }

    if (typeof spec.stdio.stdin === 'object' && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(spec.stdio.stdin.data);
    }

    let exited = false;
    let terminationStarted = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const exitWaiters = new Set<() => void>();

    const markExited = (): void => {
      if (exited) return;
      exited = true;
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      spec.signal?.removeEventListener('abort', onAbort);
      for (const wake of exitWaiters) {
        wake();
      }
      exitWaiters.clear();
    };

    const done = new Promise<SubprocessOutcome>((resolveDone, rejectDone) => {
      let settled = false;
      child.once('error', (error) => {
        markExited();
        if (settled) return;
        settled = true;
        rejectDone(error);
      });
      child.once('close', (exitCode, signal) => {
        markExited();
        if (settled) return;
        settled = true;
        resolveDone({ exitCode, signal });
      });
    });

    const terminate = (): void => {
      if (exited || terminationStarted) {
        return;
      }
      terminationStarted = true;
      terminateChildProcessTree(child, 'SIGTERM');
      if (process.platform !== 'win32') {
        graceTimer = setTimeout(() => {
          graceTimer = undefined;
          if (!exited) {
            terminateChildProcessTree(child, 'SIGKILL');
          }
        }, spec.graceMs);
        graceTimer.unref?.();
      }
    };

    const onAbort = (): void => {
      terminate();
    };
    spec.signal?.addEventListener('abort', onAbort, { once: true });

    const waitForExit = async (signal?: AbortSignal): Promise<boolean> => {
      if (exited) return true;
      if (signal?.aborted) return false;
      return await new Promise<boolean>((resolveWait) => {
        const onFinish = (): void => {
          signal?.removeEventListener('abort', onSignalAbort);
          resolveWait(true);
        };
        const onSignalAbort = (): void => {
          exitWaiters.delete(onFinish);
          resolveWait(false);
        };
        exitWaiters.add(onFinish);
        signal?.addEventListener('abort', onSignalAbort, { once: true });
      });
    };

    return {
      stdin: spec.stdio.stdin === 'pipe' ? child.stdin ?? undefined : undefined,
      stdout:
        spec.stdio.stdout === 'pipe'
          ? (child.stdout as Readable | null) ?? undefined
          : undefined,
      stderr:
        spec.stdio.stderr === 'pipe'
          ? (child.stderr as Readable | null) ?? undefined
          : undefined,
      control: undefined,
      collected: {
        ...(stdoutCollector ? { stdout: stdoutCollector } : {}),
        ...(stderrCollector ? { stderr: stderrCollector } : {}),
      },
      done,
      terminate,
      waitForExit,
    };
  };

  const terminalEnvironment = async (
    signal?: AbortSignal,
  ): Promise<SubprocessTerminalEnvironment> => {
    signal?.throwIfAborted();
    const platform = process.platform === 'win32' ? 'windows' : 'posix';
    const defaultShell =
      platform === 'windows'
        ? process.env['ComSpec'] || undefined
        : process.env['SHELL'] || userInfo().shell || undefined;
    return { platform, ...(defaultShell ? { defaultShell } : {}) };
  };

  const spawnTerminal = async (
    _spec: SubprocessTerminalSpawnSpec,
  ): Promise<SubprocessTerminalHandle> => {
    throw new AntigravityAcpError(
      'Standalone CLI subprocess adapter does not support PTY terminal allocation',
      'UNSUPPORTED_OPTION',
    );
  };

  return {
    resolveExecutable,
    spawn,
    terminalEnvironment,
    spawnTerminal,
  } as unknown as SubprocessRuntime;
}

/** Parsed CLI invocation arguments. */
export interface ParsedCliArgs {
  readonly command: string;
  readonly help: boolean;
  readonly json: boolean;
  readonly loginMode: 'auto' | 'code' | 'loopback';
  readonly noOpen: boolean;
  readonly refresh: boolean;
  readonly strict: boolean;
  readonly cwd?: string;
  readonly configOverrides: RuntimeConfigInput;
  readonly apiKey?: string;
  readonly authMethod?: AntigravityAuthMethod;
}

const VALID_AUTH_METHODS = new Set<AntigravityAuthMethod>([
  'oauth-personal',
  'oauth-business',
  'gemini-api-key',
  'agent-platform',
]);

function consumeValue(argv: readonly string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new AntigravityAcpError(`Flag ${flag} requires a value`, 'INVALID_REQUEST');
  }
  return next;
}

/** Parse CLI arguments into subcommand + flags. */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  let command: string | undefined;
  let help = false;
  let json = false;
  let loginMode: 'auto' | 'code' | 'loopback' = 'auto';
  let noOpen = false;
  let refresh = false;
  let strict = false;
  let cwd: string | undefined;
  let apiKey: string | undefined;
  let authMethod: AntigravityAuthMethod | undefined;
  const configOverrides: RuntimeConfigInput = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--code') {
      loginMode = 'code';
      continue;
    }
    if (arg === '--loopback') {
      loginMode = 'loopback';
      continue;
    }
    if (arg === '--no-open') {
      noOpen = true;
      continue;
    }
    if (arg === '--refresh') {
      refresh = true;
      continue;
    }
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--no-auto-download') {
      configOverrides.autoDownload = false;
      continue;
    }
    if (arg === '--profile-dir') {
      configOverrides.profileDir = consumeValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--cache-dir') {
      configOverrides.cacheDir = consumeValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--binary-path') {
      configOverrides.binaryPath = consumeValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--auth-method') {
      const value = consumeValue(argv, i, arg) as AntigravityAuthMethod;
      if (!VALID_AUTH_METHODS.has(value)) {
        throw new AntigravityAcpError(
          `Unsupported auth method "${value}". Expected one of: oauth-personal, oauth-business, gemini-api-key, agent-platform`,
          'INVALID_REQUEST',
        );
      }
      authMethod = value;
      configOverrides.authMethod = value;
      i += 1;
      continue;
    }
    if (arg === '--api-key') {
      apiKey = consumeValue(argv, i, arg);
      configOverrides.apiKey = apiKey;
      i += 1;
      continue;
    }
    if (arg === '--gcp-project') {
      configOverrides.gcpProject = consumeValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--gcp-location') {
      configOverrides.gcpLocation = consumeValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--proxy-url') {
      configOverrides.proxyUrl = consumeValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--proxy-bypass') {
      configOverrides.proxyBypass = consumeValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--cwd') {
      cwd = resolve(consumeValue(argv, i, arg));
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new AntigravityAcpError(`Unknown option: ${arg}`, 'INVALID_REQUEST');
    }
    if (command === undefined) {
      command = arg;
    } else {
      throw new AntigravityAcpError(`Unexpected positional argument: ${arg}`, 'INVALID_REQUEST');
    }
  }

  return {
    command: command ?? (help ? 'help' : 'help'),
    help: help || command === undefined || command === 'help',
    json,
    loginMode,
    noOpen,
    refresh,
    strict,
    cwd,
    configOverrides,
    apiKey,
    authMethod,
  };
}

export function renderCliHelp(): string {
  return [
    'dsh-antigravity-acp — Antigravity CLI (agy acp) runtime & authentication helper',
    '',
    'Usage:',
    '  dsh-antigravity-acp <command> [options]',
    '',
    'Commands:',
    '  status                 Show executable, isolated profile, auth, and pool status',
    '  install                Resolve or download and verify the managed agy CLI binary',
    '  login [--code|--loopback]  Authenticate the isolated Antigravity profile',
    '  logout                 Clear stored OAuth credentials and recycle runtime workers',
    '  models                 List discovered Antigravity models and thinking levels',
    '  quota                  Probe account quota summary via Cloud Code Assist',
    '  check-update           Check GitHub and Antigravity CLI manifest for updates',
    '  doctor                 Run environment, binary, auth, proxy, and ACP diagnostics',
    '  help, --help           Show this help text',
    '',
    'Options:',
    '  --profile-dir <dir>    Override isolated Antigravity profile directory',
    '  --cache-dir <dir>      Override managed runtime download cache directory',
    '  --binary-path <path>   Explicit path to agy / antigravity executable',
    '  --auth-method <method> oauth-personal | oauth-business | gemini-api-key | agent-platform',
    '  --api-key <key>        Explicit API key for gemini-api-key / agent-platform',
    '  --gcp-project <id>     Google Cloud project id',
    '  --gcp-location <loc>   Google Cloud location/region',
    '  --proxy-url <url>      Outbound HTTP/HTTPS/SOCKS proxy URL',
    '  --proxy-bypass <list>  Comma-separated NO_PROXY list',
    '  --code                 Force headless stdin authorization code login',
    '  --loopback             Force local loopback OAuth login',
    '  --no-open              Do not attempt to open browser automatically during login',
    '  --refresh              Bypass cached models and probe ACP session/new',
    '  --cwd <dir>            Working directory used for model discovery / ACP handshake',
    '  --no-auto-download     Disable automatic managed binary download',
    '  --strict               Exit non-zero in doctor when optional checks warn',
    '  --json                 Emit structured JSON output',
    '  -h, --help             Show this help text',
  ].join('\n');
}

function tryOpenBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      const child = nodeSpawn('rundll32', ['url.dll,FileProtocolHandler', url], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
      child.unref();
      return;
    }
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = nodeSpawn(opener, [url], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
  } catch {
    // Best-effort browser launch only; URL is always printed for manual open.
  }
}

interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
  readLine(prompt: string): Promise<string>;
}

const DEFAULT_IO: CliIo = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
  readLine: async (prompt) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      return (await rl.question(prompt)).trim();
    } finally {
      rl.close();
    }
  },
};

function parseNodeVersion(): { major: number; minor: number; ok: boolean } {
  const [majorStr = '0', minorStr = '0'] = process.versions.node.split('.');
  const major = Number(majorStr);
  const minor = Number(minorStr);
  const ok = major > 22 || (major === 22 && minor >= 19);
  return { major, minor, ok };
}

/** Execute the CLI against `argv`. Returns process exit code. */
export async function runCli(
  argv: readonly string[],
  io: CliIo = DEFAULT_IO,
): Promise<number> {
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (error: unknown) {
    const msg = error instanceof Error ? redactSensitiveText(error.message) : String(error);
    io.stderr(`Error: ${msg}`);
    io.stderr('Run "dsh-antigravity-acp --help" for usage.');
    return 1;
  }

  if (parsed.help) {
    io.stdout(renderCliHelp());
    return 0;
  }

  let config: RuntimeConfig;
  try {
    config = RuntimeConfigSchema(parsed.configOverrides);
  } catch (error: unknown) {
    const msg = error instanceof Error ? redactSensitiveText(error.message) : String(error);
    io.stderr(`Configuration error: ${msg}`);
    return 1;
  }

  const subprocess = createStandaloneSubprocessRuntime();
  const runtime = createAntigravityRuntimeService(subprocess, config);

  try {
    switch (parsed.command) {
      case 'status': {
        const status = await runtime.getStatus();
        if (parsed.json) {
          io.stdout(JSON.stringify(status, null, 2));
        } else {
          io.stdout(`Installed: ${status.installed ? 'yes' : 'no'}`);
          if (status.executable) {
            io.stdout(
              `Executable: ${status.executable.command} (source=${status.executable.source}${status.executable.version ? `, version=${status.executable.version}` : ''})`,
            );
          }
          io.stdout(`Profile Dir: ${status.profile.profileDir}`);
          io.stdout(`Auth Method: ${status.profile.authMethod}`);
          io.stdout(
            `Authenticated: ${status.profile.authenticated ? 'yes' : 'no'}${status.profile.account ? ` (${status.profile.account})` : ''}`,
          );
          if (status.profile.gcpProject) {
            io.stdout(
              `GCP Project: ${status.profile.gcpProject}${status.profile.gcpLocation ? ` (${status.profile.gcpLocation})` : ''}`,
            );
          }
          io.stdout(
            `Pool: active=${status.activeLeases}, idle=${status.idleWorkers}, maxConcurrent=${status.maxConcurrentSessions}`,
          );
        }
        return 0;
      }

      case 'install': {
        const exe = await runtime.ensureInstalled();
        if (parsed.json) {
          io.stdout(JSON.stringify(exe, null, 2));
        } else {
          io.stdout(
            `Antigravity CLI ready: ${exe.command} (source=${exe.source}${exe.version ? `, version=${exe.version}` : ''})`,
          );
        }
        return 0;
      }

      case 'login': {
        const printUrl = parsed.json ? io.stderr : io.stdout;
        const profile = await runtime.login({
          authMethod: parsed.authMethod,
          apiKey: parsed.apiKey,
          mode: parsed.loginMode,
          onAuthUrl: (url, kind) => {
            printUrl(`Open the following link to authenticate (${kind}):`);
            printUrl(url);
            if (kind === 'loopback' && !parsed.noOpen) {
              tryOpenBrowser(url);
            }
          },
          readCode: () => io.readLine('Paste authorization code or callback URL: '),
        });
        if (parsed.json) {
          io.stdout(JSON.stringify(profile, null, 2));
        } else {
          io.stdout(
            `Authenticated (${profile.authMethod})${profile.account ? ` as ${profile.account}` : ''} in ${profile.profileDir}`,
          );
        }
        return 0;
      }

      case 'logout': {
        await runtime.logout();
        if (parsed.json) {
          io.stdout(JSON.stringify({ ok: true }));
        } else {
          io.stdout('Cleared stored Antigravity credentials.');
        }
        return 0;
      }

      case 'models': {
        const models = await runtime.listModels({
          cwd: parsed.cwd ?? process.cwd(),
          refresh: parsed.refresh,
        });
        if (parsed.json) {
          io.stdout(JSON.stringify(models, null, 2));
        } else if (models.length === 0) {
          io.stdout('No models reported by Antigravity ACP.');
        } else {
          for (const model of models) {
            const extras: string[] = [];
            if (model.isDefault) extras.push('default');
            if (model.contextWindow) extras.push(`ctx=${model.contextWindow}`);
            if (model.inputModalities?.length) {
              extras.push(`in=${model.inputModalities.join(',')}`);
            }
            if (model.thinkingOptions?.length) {
              extras.push(
                `thinking=[${model.thinkingOptions.map((opt) => opt.id).join(',')}]`,
              );
            }
            io.stdout(
              `${model.id} — ${model.name}${extras.length > 0 ? ` (${extras.join('; ')})` : ''}`,
            );
          }
        }
        return 0;
      }

      case 'quota': {
        const snapshot = await runtime.getQuota();
        if (parsed.json) {
          io.stdout(JSON.stringify(snapshot, null, 2));
        } else {
          io.stdout(
            `Quota captured at ${snapshot.capturedAt}${snapshot.account ? ` for ${snapshot.account}` : ''}${snapshot.tier ? ` [${snapshot.tier}]` : ''}`,
          );
          io.stdout(`Exhausted: ${snapshot.exhausted ? 'yes' : 'no'}`);
          for (const window of snapshot.windows) {
            const pct =
              window.remainingFraction !== undefined
                ? `${Math.round(window.remainingFraction * 100)}% remaining`
                : window.remaining !== undefined && window.limit !== undefined
                  ? `${window.remaining}/${window.limit}${window.unit ? ` ${window.unit}` : ''}`
                  : 'unknown';
            const reset = window.resetAt ? ` (resets ${window.resetAt})` : '';
            io.stdout(`  - ${window.label ?? window.id}: ${pct}${reset}`);
          }
        }
        return 0;
      }

      case 'check-update': {
        const statusSnap = await runtime.getStatus();
        const update = await checkPluginUpdate({
          cliInstalledVersion: statusSnap.executable?.version,
        });
        if (parsed.json) {
          io.stdout(JSON.stringify(update, null, 2));
        } else {
          io.stdout(
            `Plugin: ${update.packageName} v${update.currentVersion}${update.currentCommit ? ` (${update.currentCommit.slice(0, 7)})` : ''}`,
          );
          io.stdout(
            `Latest (${update.branch}): ${update.latestVersion ? `v${update.latestVersion}` : 'unknown'}${update.latestCommit ? ` (${update.latestCommit.slice(0, 7)})` : ''}`,
          );
          if (update.latestMessage) {
            io.stdout(
              `Latest Commit: ${update.latestMessage}${update.latestDate ? ` (${update.latestDate})` : ''}`,
            );
          }
          if (update.updateAvailable) {
            io.stdout(
              `Update available (${update.reason}). Run: dsh plugin --profile web add ${update.installSpec}`,
            );
          } else {
            io.stdout(`Status: up to date (${update.reason})`);
          }
          if (update.cliLatestVersion) {
            const installedCli = statusSnap.executable?.version;
            io.stdout(
              `Antigravity CLI: ${installedCli ? `v${installedCli}` : 'not installed'} / latest v${update.cliLatestVersion}${update.cliUpdateAvailable ? ' (update available)' : ''}`,
            );
          }
        }
        return 0;
      }

      case 'doctor': {
        const checks: Array<{
          readonly name: string;
          readonly status: 'pass' | 'warn' | 'fail';
          readonly detail: string;
        }> = [];

        const nodeInfo = parseNodeVersion();
        checks.push({
          name: 'node',
          status: nodeInfo.ok ? 'pass' : 'fail',
          detail: `Node.js ${process.versions.node} (requires >= 22.19)`,
        });

        if (config.proxyUrl?.trim()) {
          try {
            validateProxyUrl(config.proxyUrl);
            checks.push({
              name: 'proxy',
              status: 'pass',
              detail: `Proxy URL valid (${redactSensitiveText(config.proxyUrl)})`,
            });
          } catch (error: unknown) {
            checks.push({
              name: 'proxy',
              status: 'fail',
              detail: error instanceof Error ? redactSensitiveText(error.message) : String(error),
            });
          }
        } else {
          checks.push({
            name: 'proxy',
            status: 'pass',
            detail: 'No explicit proxy configured',
          });
        }

        const status = await runtime.getStatus();
        if (status.installed && status.executable) {
          let versionOk = true;
          if (status.executable.version) {
            try {
              versionOk = compareSemver(status.executable.version, MINIMUM_AGY_VERSION) >= 0;
            } catch {
              versionOk = true;
            }
          }
          checks.push({
            name: 'executable',
            status: versionOk ? 'pass' : 'fail',
            detail: `${status.executable.command} (source=${status.executable.source}${status.executable.version ? `, version=${status.executable.version}` : ''})`,
          });
        } else {
          checks.push({
            name: 'executable',
            status: 'warn',
            detail: 'Antigravity CLI not found locally (run "dsh-antigravity-acp install")',
          });
        }

        const auth = await runtime.checkAuth();
        checks.push({
          name: 'auth',
          status: auth.authenticated ? 'pass' : 'warn',
          detail: auth.authenticated
            ? `Authenticated via ${auth.authMethod}${auth.account ? ` (${auth.account})` : ''}`
            : `Not authenticated for ${auth.authMethod} in ${auth.profileDir} (run "dsh-antigravity-acp login")`,
        });

        if (status.installed) {
          try {
            const client = await runtime.spawnClient({
              cwd: parsed.cwd ?? process.cwd(),
              suppressBrowser: true,
            });
            try {
              checks.push({
                name: 'acp-handshake',
                status: 'pass',
                detail: `ACP protocol v${client.initialized.protocolVersion} (${client.initialized.agentName ?? 'antigravity'} ${client.initialized.agentVersion ?? 'unknown'})`,
              });
            } finally {
              await client.close(1000).catch(() => {});
            }
          } catch (error: unknown) {
            checks.push({
              name: 'acp-handshake',
              status: 'fail',
              detail:
                error instanceof Error ? redactSensitiveText(error.message) : String(error),
            });
          }
        }

        const hasFailure = checks.some((c) => c.status === 'fail');
        const hasWarning = checks.some((c) => c.status === 'warn');

        if (parsed.json) {
          io.stdout(JSON.stringify({ ok: !hasFailure, checks }, null, 2));
        } else {
          for (const check of checks) {
            io.stdout(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);
          }
        }

        if (hasFailure || (parsed.strict && hasWarning)) {
          return 1;
        }
        return 0;
      }

      default:
        io.stderr(`Unknown command: ${parsed.command}`);
        io.stderr('Run "dsh-antigravity-acp --help" for usage.');
        return 1;
    }
  } catch (error: unknown) {
    const safeMsg =
      error instanceof Error ? redactSensitiveText(error.message) : redactSensitiveText(String(error));
    const code = error instanceof AntigravityAcpError ? `[${error.code}] ` : '';
    io.stderr(`Error: ${code}${safeMsg}`);
    return 1;
  } finally {
    await runtime.dispose().catch(() => {});
  }
}

function isDirectCliExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (isDirectCliExecution()) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
