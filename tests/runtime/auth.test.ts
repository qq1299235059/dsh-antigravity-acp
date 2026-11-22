import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkProfileAuth,
  clearProfileAuth,
  runCodeLogin,
  runLoopbackLogin,
} from '../../src/runtime/auth.js';
import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  prepareAntigravityProfile,
} from '../../src/runtime/profile.js';
import { RuntimeConfigSchema } from '../../src/shared/config.js';
import type { AcpClientHandle } from '../../src/shared/contracts.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'agy-auth-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createMockSubprocessRuntime(
  behavior: (spec: SubprocessSpawnSpec, io: {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    resolveDone: (outcome: SubprocessOutcome) => void;
    terminated: () => boolean;
  }) => void,
): { runtime: SubprocessRuntime; specs: SubprocessSpawnSpec[]; wasTerminated: () => boolean } {
  const specs: SubprocessSpawnSpec[] = [];
  let terminated = false;

  const runtime = {
    resolveExecutable: vi.fn(async (cmd: string) => cmd),
    terminalEnvironment: vi.fn(async () => ({ platform: 'posix' as const })),
    spawnTerminal: vi.fn(),
    spawn: vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => {
      specs.push(spec);
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let settled = false;
      let resolveDone!: (outcome: SubprocessOutcome) => void;
      const done = new Promise<SubprocessOutcome>((resolve) => {
        resolveDone = (outcome) => {
          if (!settled) {
            settled = true;
            stdout.end();
            stderr.end();
            resolve(outcome);
          }
        };
      });

      const handle: SubprocessHandle = {
        stdin,
        stdout,
        stderr,
        control: undefined,
        collected: {},
        done,
        terminate: () => {
          terminated = true;
          resolveDone({ exitCode: null, signal: 'SIGTERM' });
        },
        waitForExit: async () => true,
      };

      behavior(spec, {
        stdin,
        stdout,
        stderr,
        resolveDone,
        terminated: () => terminated,
      });

      return handle;
    }),
  } as unknown as SubprocessRuntime;

  return { runtime, specs, wasTerminated: () => terminated };
}

describe('auth.ts', () => {
  it('checkProfileAuth reports auth status accurately', async () => {
    const root = makeTempDir();
    const config = RuntimeConfigSchema({ profileDir: path.join(root, 'p') });
    expect((await checkProfileAuth(config)).authenticated).toBe(false);

    const prepared = await prepareAntigravityProfile(config);
    fs.writeFileSync(
      prepared.tokenPath,
      JSON.stringify({ refresh_token: '1//rt', email: 'alice@example.com' }),
    );
    const snap = await checkProfileAuth(config);
    expect(snap.authenticated).toBe(true);
    expect(snap.account).toBe('alice@example.com');
  });

  it('runCodeLogin spawns --login, parses stdout auth URL, writes code to stdin, and refreshes profile', async () => {
    const root = makeTempDir();
    const profileDir = path.join(root, 'code-prof');
    const config = RuntimeConfigSchema({
      profileDir,
      authMethod: 'oauth-personal',
      extraArgs: ['--quiet'],
    });
    const authUrl =
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&response_type=code&state=st42';

    const { runtime, specs } = createMockSubprocessRuntime((spec, io) => {
      let received = '';
      io.stdin.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
        if (received.includes('\n')) {
          const geminiIdx = spec.argv.indexOf('--gemini-dir');
          const geminiHome = spec.argv[geminiIdx + 1]!;
          fs.writeFileSync(
            path.join(geminiHome, 'oauth_creds.json'),
            JSON.stringify({
              access_token: 'ya29.fresh_access',
              refresh_token: '1//fresh_refresh',
              email: 'cli-user@example.com',
            }),
          );
          io.resolveDone({ exitCode: 0, signal: null });
        }
      });

      queueMicrotask(() => {
        io.stdout.write(`${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${authUrl}\n`);
      });
    });

    const seenUrls: string[] = [];
    const result = await runCodeLogin({
      config,
      executable: { command: '/usr/local/bin/agy', argsPrefix: ['acp'], source: 'path' },
      subprocess: runtime,
      onAuthUrl: (url) => {
        seenUrls.push(url);
      },
      readCode: async () =>
        'https://codeassist.google.com/authcode?code=4/0AValidAuthCode123&state=st42',
    });

    expect(seenUrls).toEqual([authUrl]);
    expect(result.authenticated).toBe(true);
    expect(result.account).toBe('cli-user@example.com');
    expect(specs[0]!.argv).toEqual([
      '/usr/local/bin/agy',
      'acp',
      '--login',
      '--gemini-dir',
      path.join(profileDir, '.gemini'),
      '--app-data-dir',
      'antigravity-acp',
      '--quiet',
    ]);
    expect(specs[0]!.env?.SSH_CONNECTION).toBe('127.0.0.1 0 127.0.0.1 0');
    expect(specs[0]!.env?.AGY_ACP_FORCE_FILE_STORAGE).toBe('1');
  });

  it('runCodeLogin also captures BROWSER marker on stderr and fails cleanly on bad state or exit code', async () => {
    const root = makeTempDir();
    const config = RuntimeConfigSchema({ profileDir: path.join(root, 'stderr-prof') });
    const authUrl =
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&response_type=code&state=st99';

    const { runtime, wasTerminated } = createMockSubprocessRuntime((_spec, io) => {
      queueMicrotask(() => {
        io.stderr.write(`${ANTIGRAVITY_AUTH_BROWSER_MARKER}${JSON.stringify(authUrl)}\n`);
      });
    });

    await expect(
      runCodeLogin({
        config,
        executable: { command: 'agy', argsPrefix: ['acp'], source: 'path' },
        subprocess: runtime,
        onAuthUrl: () => {},
        readCode: async () => 'https://codeassist.google.com/authcode?code=4/0ABad&state=WRONG',
      }),
    ).rejects.toMatchObject({ code: 'AUTH' });
    expect(wasTerminated()).toBe(true);

    const earlyExit = createMockSubprocessRuntime((_spec, io) => {
      queueMicrotask(() => {
        io.stderr.write('Bearer ya29.secret_should_be_redacted failed\n');
        io.resolveDone({ exitCode: 1, signal: null });
      });
    });

    await expect(
      runCodeLogin({
        config,
        executable: { command: 'agy', argsPrefix: ['acp'], source: 'path' },
        subprocess: earlyExit.runtime,
        onAuthUrl: () => {},
        readCode: async () => 'unused-code-1234',
      }),
    ).rejects.toSatisfy(
      (err: Error) => !err.message.includes('ya29.secret_should_be_redacted'),
    );
  });

  it('runCodeLogin never leaks OAuth auth URLs in error diagnostics on non-zero exit', async () => {
    const root = makeTempDir();
    const config = RuntimeConfigSchema({ profileDir: path.join(root, 'leak-prof') });
    const secretUrl =
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&response_type=code&code_challenge=secretChallenge123&state=st_leak_check';

    const failingLogin = createMockSubprocessRuntime((_spec, io) => {
      let received = '';
      io.stdin.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
        if (received.includes('\n')) {
          io.stderr.write(`OAuth exchange failed for ${secretUrl}\n`);
          io.resolveDone({ exitCode: 1, signal: null });
        }
      });

      queueMicrotask(() => {
        io.stdout.write(`${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${secretUrl}\n`);
        io.stderr.write(`${ANTIGRAVITY_AUTH_BROWSER_MARKER}${JSON.stringify(secretUrl)}\n`);
      });
    });

    let caught: unknown;
    try {
      await runCodeLogin({
        config,
        executable: { command: 'agy', argsPrefix: ['acp'], source: 'path' },
        subprocess: failingLogin.runtime,
        onAuthUrl: () => {},
        readCode: async () => '4/0AValidAuthCode123',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ code: 'AUTH' });
    const message = (caught as Error).message;
    expect(message).not.toContain('accounts.google.com');
    expect(message).not.toContain('secretChallenge123');
    expect(message).not.toContain('st_leak_check');
    expect(message).not.toContain(ANTIGRAVITY_AUTH_BROWSER_MARKER);
    expect(message).toContain('OAuth exchange failed for [REDACTED_AUTH_URL]');
  });

  it('runLoopbackLogin invokes authenticate, surfaces onAuthUrl, closes client, and refreshes snapshot', async () => {
    const root = makeTempDir();
    const config = RuntimeConfigSchema({
      profileDir: path.join(root, 'loopback-prof'),
      authMethod: 'oauth-personal',
    });

    const closeMock = vi.fn(async () => {});
    const authenticateMock = vi.fn(async (_methodId?: string) => {});
    const seenUrls: string[] = [];
    const loopbackUrl =
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&redirect_uri=http%3A%2F%2F127.0.0.1%3A9999%2Fcb&response_type=code&state=abc';

    const result = await runLoopbackLogin({
      config,
      onAuthUrl: (u) => seenUrls.push(u),
      connectClient: async ({ profile, onAuthUrl }) => {
        const fakeClient = {
          id: 'client-1',
          initialized: {
            protocolVersion: 1,
            authMethods: [{ id: 'oauth-personal', name: 'Personal Google' }],
            supportsImages: false,
            supportsAudio: false,
            supportsEmbeddedContext: false,
            supportsLoadSession: false,
            supportsMcpHttp: true,
            supportsMcpSse: false,
          },
          executable: { command: 'agy', argsPrefix: ['acp'], source: 'path' as const },
          profile,
          closed: Promise.resolve(),
          isClosed: false,
          authenticate: async (methodId?: string) => {
            await authenticateMock(methodId);
            onAuthUrl(loopbackUrl);
            fs.writeFileSync(
              profile.tokenPath,
              JSON.stringify({ refresh_token: '1//loopback-rt', email: 'loop@example.com' }),
            );
          },
          newSession: vi.fn(),
          setSessionMode: vi.fn(),
          setSessionConfigOption: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          discoverModels: vi.fn(),
          close: closeMock,
        } as unknown as AcpClientHandle;
        return fakeClient;
      },
    });

    expect(authenticateMock).toHaveBeenCalledWith('oauth-personal');
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(seenUrls).toEqual([loopbackUrl]);
    expect(result.authenticated).toBe(true);
    expect(result.account).toBe('loop@example.com');
  });

  it('clearProfileAuth removes credential files while keeping settings.json', async () => {
    const root = makeTempDir();
    const config = RuntimeConfigSchema({ profileDir: path.join(root, 'clear-prof') });
    const profile = await prepareAntigravityProfile(config);

    fs.writeFileSync(profile.tokenPath, '{"refresh_token":"rt1"}');
    fs.writeFileSync(profile.cliTokenPath, '{"refresh_token":"rt2"}');
    fs.writeFileSync(path.join(profile.acpDirectory, 'google_accounts.json'), '{"active":"a@b.c"}');

    await clearProfileAuth(profile);

    expect(fs.existsSync(profile.tokenPath)).toBe(false);
    expect(fs.existsSync(profile.cliTokenPath)).toBe(false);
    expect(fs.existsSync(path.join(profile.acpDirectory, 'google_accounts.json'))).toBe(false);
    expect(fs.existsSync(path.join(profile.acpDirectory, 'settings.json'))).toBe(true);
    expect((await checkProfileAuth(config)).authenticated).toBe(false);
  });
});
