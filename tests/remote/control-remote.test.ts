import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service, type Fiber } from '@deepseek-ai/cordis';
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { remoteErrorOf, type InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runtimePlugin from '../../src/index.js';
import * as subagentPlugin from '../../src/subagent-plugin.js';
import type { AntigravityControlStatusSnapshot } from '../../src/shared/contracts.js';
import {
  registerAntigravityControlRemote,
  type TypertHostContribution,
} from '../../src/remote/control-remote.js';

const FAKE_SERVER_PATH = fileURLToPath(new URL('../acp/fake-agy-server.mjs', import.meta.url));

function assertJsonSafe(value: unknown, pathLabel = '$', ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error(`Non-JSON-safe number at ${pathLabel}: ${String(value)}`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`Non-JSON-safe value at ${pathLabel}: ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new Error(`Cyclic object at ${pathLabel}`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      expect(Object.getOwnPropertySymbols(value)).toHaveLength(0);
      expect(Object.keys(value)).toHaveLength(value.length);
      for (let i = 0; i < value.length; i += 1) {
        if (!Object.hasOwn(value, i)) {
          throw new Error(`Sparse array slot at ${pathLabel}[${i}]`);
        }
        assertJsonSafe(value[i], `${pathLabel}[${i}]`, ancestors);
      }
      return;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`Non-plain object prototype at ${pathLabel}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`Symbol property at ${pathLabel}`);
    }
    for (const key of Reflect.ownKeys(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || !desc.enumerable || !('value' in desc)) {
        throw new Error(`Non-data or non-enumerable property at ${pathLabel}.${String(key)}`);
      }
      if (desc.value === undefined) {
        throw new Error(`Explicit undefined property at ${pathLabel}.${String(key)}`);
      }
      assertJsonSafe(desc.value, `${pathLabel}.${String(key)}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function createFakeAgyBinary(binDir: string, extraEnv?: Record<string, string>): string {
  fs.mkdirSync(binDir, { recursive: true });
  const fakeBinaryPath = path.join(binDir, process.platform === 'win32' ? 'agy.cmd' : 'agy');
  if (process.platform === 'win32') {
    const envLines = Object.entries(extraEnv ?? {}).map(([k, v]) => `set "${k}=${v}"`);
    fs.writeFileSync(
      fakeBinaryPath,
      ['@echo off', ...envLines, `"${process.execPath}" "${FAKE_SERVER_PATH}" %*`, ''].join('\r\n'),
      'utf8',
    );
  } else {
    const envLines = Object.entries(extraEnv ?? {}).map(
      ([k, v]) => `export ${k}=${JSON.stringify(v)}`,
    );
    fs.writeFileSync(
      fakeBinaryPath,
      ['#!/bin/sh', ...envLines, `exec "${process.execPath}" "${FAKE_SERVER_PATH}" "$@"`].join(
        '\n',
      ) + '\n',
      { encoding: 'utf8', mode: 0o755 },
    );
  }
  return fakeBinaryPath;
}

class MockTypertRegistry extends Service {
  readonly contributions = new Map<string, TypertHostContribution>();
  readonly endpoints = new Map<string, InvocationDescriptor>();
  disposedCount = 0;

  constructor(ctx: Context) {
    super(ctx, 'typert');
  }

  register(contribution: TypertHostContribution): () => void {
    const pkgKey = `${contribution.package}#${contribution.face}`;
    if (this.contributions.has(pkgKey)) {
      throw new Error(`Duplicate Typert package contribution: ${pkgKey}`);
    }
    this.contributions.set(pkgKey, contribution);
    for (const inv of contribution.invocations) {
      this.endpoints.set(`${inv.namespace}/${inv.method}`, inv);
    }
    return () => {
      this.disposedCount += 1;
      this.contributions.delete(pkgKey);
      for (const inv of contribution.invocations) {
        this.endpoints.delete(`${inv.namespace}/${inv.method}`);
      }
    };
  }
}

async function pollUntil(
  fn: () => Promise<AntigravityControlStatusSnapshot>,
  predicate: (snap: AntigravityControlStatusSnapshot) => boolean,
  timeoutMs = 5_000,
): Promise<AntigravityControlStatusSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!predicate(last)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out polling status; last=${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
    last = await fn();
  }
  return last;
}

describe('antigravityControl Typert remote & UI store', () => {
  const tempDirs: string[] = [];
  const fibers: Fiber[] = [];

  afterEach(async () => {
    while (fibers.length > 0) {
      const fiber = fibers.pop()!;
      await fiber.dispose().catch(() => {});
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers valid strict Typert descriptors and invokes cleanly through Cordis proxy without #private errors', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ctrl-contract-'));
    tempDirs.push(tempDir);
    const profileDir = path.join(tempDir, 'profile');
    const fakeBin = createFakeAgyBinary(path.join(tempDir, 'bin'), {
      FAKE_AGY_WRITE_TOKEN: '1',
    });

    const ctx = new Context();
    let typert!: MockTypertRegistry;
    const scope = await ctx.plugin(async (scopeCtx) => {
      await scopeCtx.plugin(LocalSubprocessRuntime);
      await scopeCtx.plugin(MockTypertRegistry);
      typert = scopeCtx.get('typert') as unknown as MockTypertRegistry;
      await scopeCtx.plugin(runtimePlugin, {
        binaryPath: fakeBin,
        profileDir,
        autoDownload: false,
      });
    });
    fibers.push(scope);

    // Named exports only
    expect('default' in runtimePlugin).toBe(false);
    expect('default' in subagentPlugin).toBe(false);

    // Check Typert contribution contract
    const contrib = typert.contributions.get('dsh-antigravity-acp#host');
    expect(contrib).toBeDefined();
    expect(contrib!.invocations).toHaveLength(14);

    const expectedZeroArg = new Set([
      'status',
      'installCancel',
      'authCancel',
      'logout',
      'refreshModels',
      'refreshQuota',
      'checkUpdate',
      'cancelPluginUpdate',
    ]);
    const expectedOneArg = new Set([
      'installCli',
      'saveConfig',
      'saveSubagentConfig',
      'authStart',
      'authSubmitCode',
      'updatePlugin',
    ]);

    for (const desc of contrib!.invocations) {
      expect(desc.id).toBe(`dsh-antigravity-acp#antigravityControl/${desc.method}`);
      expect(desc.service).toBe('antigravityControl');
      expect(desc.namespace).toBe('antigravityControl');
      expect(desc.invocation).toEqual({ kind: 'direct' });
      expect(desc.result.mode).toBe('strict');
      if (desc.result.mode === 'strict') {
        expect(desc.result.typeSymbol.length).toBeGreaterThan(0);
        expect(typeof desc.result.create).toBe('function');
      }

      if (expectedZeroArg.has(desc.method)) {
        expect(desc.parameters).toEqual([]);
      } else {
        expect(expectedOneArg.has(desc.method)).toBe(true);
        expect(desc.parameters).toHaveLength(1);
        const param = desc.parameters[0];
        expect(param.name).toBe('input');
        expect(param.wire).toBe('input');
        expect(param.source).toBe('json');
        expect(param.acceptsUndefined).toBe(true);
        expect(param.codec.mode).toBe('strict');
        if (param.codec.mode === 'strict') {
          expect(param.codec.typeSymbol.length).toBeGreaterThan(0);
          expect(typeof param.codec.create).toBe('function');
        }
      }
    }

    // Strict input codec validation errors throw RemoteError('gateway/bad-request')
    const saveDesc = typert.endpoints.get('antigravityControl/saveConfig')!;
    const saveCodec = saveDesc.parameters[0].codec;
    expect(saveCodec.mode).toBe('strict');
    if (saveCodec.mode === 'strict') {
      const parser = saveCodec.create();
      expect(() => parser.parse('not-an-object')).toThrow();
      try {
        parser.parse({ authMethod: 'bogus-method' });
        expect.unreachable('Should reject invalid authMethod');
      } catch (err) {
        expect(remoteErrorOf(err)?.code).toBe('gateway/bad-request');
      }
      try {
        parser.parse({ proxyUrl: 'ftp://invalid-proxy.example' });
        expect.unreachable('Should reject unsupported proxyUrl');
      } catch (err) {
        expect(remoteErrorOf(err)?.code).toBe('gateway/bad-request');
      }
    }

    const submitDesc = typert.endpoints.get('antigravityControl/authSubmitCode')!;
    if (submitDesc.parameters[0].codec.mode === 'strict') {
      const parser = submitDesc.parameters[0].codec.create();
      try {
        parser.parse({ code: '   ' });
        expect.unreachable('Should reject blank code');
      } catch (err) {
        expect(remoteErrorOf(err)?.code).toBe('gateway/bad-request');
      }
    }

    // Invoke through Cordis Proxy ctx.get('antigravityControl') (must not break on #private)
    const control = ctx.get('antigravityControl');
    expect(control).toBeDefined();
    const statusSnap = await control!.status();
    assertJsonSafe(statusSnap);
    expect(statusSnap.installed).toBe(true);
    expect(statusSnap.executable?.command).toBe(fakeBin);
    expect(statusSnap.executable?.source).toBe('configured');
    expect(statusSnap.profile.profileDir).toBe(path.resolve(profileDir));
    expect(statusSnap.profile.authenticated).toBe(false);
    expect(statusSnap.config).toEqual({
      binaryPath: fakeBin,
      autoDownload: false,
      authMethod: 'oauth-personal',
      gcpProject: '',
      gcpLocation: '',
      proxyUrl: '',
      proxyBypass: '',
      hasApiKey: false,
    });
    expect(statusSnap.subagent).toEqual({
      providerName: 'antigravity',
      toolName: 'antigravity_agent',
      defaultModel: '',
      defaultThoughtLevel: '',
      permissionMode: 'default',
      permissionFallback: 'reject',
      systemPromptAppend: '',
    });
    expect(statusSnap.install.phase).toBe('idle');
    expect(statusSnap.auth.phase).toBe('idle');
    expect(statusSnap.pluginUpdate).toMatchObject({
      packageName: 'dsh-antigravity-acp',
      currentVersion: '0.3.0',
      phase: 'idle',
      updateAvailable: false,
      reason: 'unchecked',
      canAutoUpdate: false,
      restartRequired: false,
    });
    expect(statusSnap.models).toEqual([]);

    await scope.dispose();
    fibers.pop();
    expect(typert.disposedCount).toBe(1);
    expect(typert.contributions.size).toBe(0);
  });

  it('persists non-secret config and secrets separately, masks secrets, and reloads overrides on fresh apply()', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ctrl-store-'));
    tempDirs.push(tempDir);
    const profileDir = path.join(tempDir, 'profile');
    const fakeBin = createFakeAgyBinary(path.join(tempDir, 'bin'));
    const secretKey = 'AIzaTestSecretKeyDoNotLeak12345';

    const ctx1 = new Context();
    const scope1 = await ctx1.plugin(async (scopeCtx) => {
      await scopeCtx.plugin(LocalSubprocessRuntime);
      await scopeCtx.plugin(MockTypertRegistry);
      await scopeCtx.plugin(runtimePlugin, {
        profileDir,
        autoDownload: false,
      });
    });
    fibers.push(scope1);

    const ctrl1 = ctx1.get('antigravityControl')!;
    const saved = await ctrl1.saveConfig({
      binaryPath: fakeBin,
      autoDownload: true,
      authMethod: 'gemini-api-key',
      gcpProject: 'proj-alpha',
      gcpLocation: 'us-central1',
      proxyUrl: 'http://127.0.0.1:7890',
      proxyBypass: 'localhost,127.0.0.1',
      apiKey: secretKey,
    });
    assertJsonSafe(saved);
    expect(JSON.stringify(saved)).not.toContain(secretKey);
    expect(saved.config).toEqual({
      binaryPath: fakeBin,
      autoDownload: true,
      authMethod: 'gemini-api-key',
      gcpProject: 'proj-alpha',
      gcpLocation: 'us-central1',
      proxyUrl: 'http://127.0.0.1:7890',
      proxyBypass: 'localhost,127.0.0.1',
      hasApiKey: true,
    });
    expect(saved.profile.hasApiKey).toBe(true);
    expect(saved.profile.authenticated).toBe(true);
    expect(saved.installed).toBe(true);

    // Check split disk files
    const uiConfigPath = path.join(profileDir, runtimePlugin.UI_CONFIG_FILENAME);
    const uiSecretsPath = path.join(profileDir, runtimePlugin.UI_SECRETS_FILENAME);
    const configFileText = fs.readFileSync(uiConfigPath, 'utf8');
    const secretsFileText = fs.readFileSync(uiSecretsPath, 'utf8');
    expect(configFileText).not.toContain(secretKey);
    expect(JSON.parse(configFileText)).toEqual({
      binaryPath: fakeBin,
      autoDownload: true,
      authMethod: 'gemini-api-key',
      gcpProject: 'proj-alpha',
      gcpLocation: 'us-central1',
      proxyUrl: 'http://127.0.0.1:7890',
      proxyBypass: 'localhost,127.0.0.1',
    });
    expect(JSON.parse(secretsFileText)).toEqual({ apiKey: secretKey });

    await scope1.dispose();
    fibers.pop();

    // Fresh Context + fresh apply() with default base config reloads persisted UI overrides!
    const ctx2 = new Context();
    const scope2 = await ctx2.plugin(async (scopeCtx) => {
      await scopeCtx.plugin(LocalSubprocessRuntime);
      await scopeCtx.plugin(MockTypertRegistry);
      await scopeCtx.plugin(runtimePlugin, {
        profileDir,
        autoDownload: false,
      });
    });
    fibers.push(scope2);

    const ctrl2 = ctx2.get('antigravityControl')!;
    const reloaded = await ctrl2.status();
    assertJsonSafe(reloaded);
    expect(JSON.stringify(reloaded)).not.toContain(secretKey);
    expect(reloaded.config).toEqual({
      binaryPath: fakeBin,
      autoDownload: true,
      authMethod: 'gemini-api-key',
      gcpProject: 'proj-alpha',
      gcpLocation: 'us-central1',
      proxyUrl: 'http://127.0.0.1:7890',
      proxyBypass: 'localhost,127.0.0.1',
      hasApiKey: true,
    });
    expect(reloaded.profile.authenticated).toBe(true);

    // Clear apiKey and proxyUrl via saveConfig
    const cleared = await ctrl2.saveConfig({
      clearApiKey: true,
      proxyUrl: '',
      proxyBypass: '',
    });
    assertJsonSafe(cleared);
    expect(cleared.config.hasApiKey).toBe(false);
    expect(cleared.config.proxyUrl).toBe('');
    expect(cleared.config.proxyBypass).toBe('');
    expect(cleared.profile.authenticated).toBe(false);
    expect(fs.readFileSync(uiSecretsPath, 'utf8')).not.toContain(secretKey);
  });

  it('supports background install with progress, single-flight, installCancel, and clearBinaryPath', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ctrl-install-'));
    tempDirs.push(tempDir);
    const profileDir = path.join(tempDir, 'profile');
    const fakeBin = createFakeAgyBinary(path.join(tempDir, 'bin'));

    // First test progress + installCancel on a slow installManaged mock
    const ctx = new Context();
    await ctx.plugin(MockTypertRegistry);

    let cancelTriggered = false;
    let releaseInstall!: () => void;
    let installCalls = 0;

    const mockRuntime = {
      config: {
        authMethod: 'oauth-personal' as const,
        autoDownload: false,
        binaryPath: '/nonexistent/custom/agy',
        extraArgs: [],
        maxConcurrentSessions: 2,
        queueTimeoutMs: 1000,
        handshakeTimeoutMs: 1000,
        requestTimeoutMs: 1000,
        authTimeoutMs: 1000,
        promptTimeoutMs: 1000,
        idleRecycleMs: 1000,
        autoWarmup: false,
        profileDir,
      },
      resolveProfile: () => ({
        profileDir,
        authMethod: 'oauth-personal' as const,
        authenticated: false,
        hasApiKey: false,
      }),
      getStatus: async () => ({
        installed: Boolean(mockRuntime.config.binaryPath === fakeBin),
        ...(mockRuntime.config.binaryPath === fakeBin
          ? {
              executable: {
                command: fakeBin,
                argsPrefix: ['acp'],
                source: 'downloaded' as const,
                version: '1.5.9',
              },
            }
          : {}),
        profile: mockRuntime.resolveProfile(),
        activeLeases: 0,
        idleWorkers: 0,
        maxConcurrentSessions: 2,
      }),
      updateConfig: async (patch: Partial<typeof mockRuntime.config>) => {
        if ('binaryPath' in patch) {
          if (patch.binaryPath === undefined) {
            delete (mockRuntime.config as { binaryPath?: string }).binaryPath;
          } else {
            mockRuntime.config.binaryPath = patch.binaryPath;
          }
        }
        return mockRuntime.config;
      },
      installManaged: async (opts?: {
        signal?: AbortSignal;
        onProgress?: (msg: string) => void;
      }) => {
        installCalls += 1;
        opts?.onProgress?.('Fetching manifest...');
        await new Promise<void>((resolve, reject) => {
          releaseInstall = resolve;
          opts?.signal?.addEventListener(
            'abort',
            () => {
              cancelTriggered = true;
              reject(new runtimePlugin.AntigravityAcpError('Aborted', 'ABORTED'));
            },
            { once: true },
          );
        });
        mockRuntime.config.binaryPath = fakeBin;
        return {
          command: fakeBin,
          argsPrefix: ['acp'],
          source: 'downloaded' as const,
          version: '1.5.9',
        };
      },
    } as unknown as runtimePlugin.AntigravityRuntimeService;

    const control = runtimePlugin.registerAntigravityControlRemote(ctx, mockRuntime, {
      profileDir,
    });
    fibers.push(ctx.fiber);

    // Start installCli with clearBinaryPath: true
    const first = await control.installCli({ clearBinaryPath: true });
    assertJsonSafe(first);
    expect(mockRuntime.config.binaryPath).toBeUndefined();
    expect(first.install.phase).toBe('running');
    expect(first.install.message).toContain('Fetching manifest');

    // Second concurrent installCli() must not double-spawn
    const second = await control.installCli({});
    assertJsonSafe(second);
    expect(installCalls).toBe(1);

    // Cancel install
    const cancelled = await control.installCancel();
    assertJsonSafe(cancelled);
    expect(cancelTriggered).toBe(true);
    expect(cancelled.install.phase).toBe('cancelled');

    // Run another install to completion
    const startedAgain = await control.installCli({});
    assertJsonSafe(startedAgain);
    expect(installCalls).toBe(2);
    releaseInstall();
    const succeeded = await pollUntil(
      () => control.status(),
      (s) => s.install.phase === 'succeeded',
    );
    assertJsonSafe(succeeded);
    expect(succeeded.installed).toBe(true);
    expect(succeeded.executable?.version).toBe('1.5.9');
    expect(succeeded.install.finishedAt).toBeDefined();
  });

  it('completes real OAuth code flow via fake-agy-server, clears authUrl, supports authCancel and logout', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ctrl-oauth-'));
    tempDirs.push(tempDir);
    const profileDir = path.join(tempDir, 'profile');
    const fakeBin = createFakeAgyBinary(path.join(tempDir, 'bin'), {
      FAKE_AGY_WRITE_TOKEN: '1',
    });

    const ctx = new Context();
    const scope = await ctx.plugin(async (scopeCtx) => {
      await scopeCtx.plugin(LocalSubprocessRuntime);
      await scopeCtx.plugin(MockTypertRegistry);
      await scopeCtx.plugin(runtimePlugin, {
        binaryPath: fakeBin,
        profileDir,
        autoDownload: false,
        authTimeoutMs: 10_000,
      });
    });
    fibers.push(scope);

    const ctrl = ctx.get('antigravityControl')!;

    // Reject oauth-business when gcpProject missing
    await expect(
      ctrl.authStart({ mode: 'code', authMethod: 'oauth-business', gcpProject: '' }),
    ).rejects.toMatchObject({ code: 'gateway/bad-request' });

    // Reject authSubmitCode when no flow active
    await expect(ctrl.authSubmitCode({ code: 'some-code' })).rejects.toMatchObject({
      code: 'gateway/bad-request',
    });

    // Start code login -> wait for awaiting_code & authUrl
    const started = await ctrl.authStart({ mode: 'code', authMethod: 'oauth-personal' });
    assertJsonSafe(started);

    const awaiting = await pollUntil(
      () => ctrl.status(),
      (s) => s.auth.phase === 'awaiting_code' && Boolean(s.auth.authUrl),
    );
    assertJsonSafe(awaiting);
    expect(awaiting.auth.mode).toBe('code');
    expect(awaiting.auth.authUrl).toContain('https://accounts.google.com/o/oauth2/auth');

    // Submit code -> authUrl cleared immediately, then reaches succeeded & authenticated
    const exchanging = await ctrl.authSubmitCode({ code: 'valid-auth-code-12345' });
    assertJsonSafe(exchanging);
    expect(exchanging.auth.phase).toBe('exchanging');
    expect('authUrl' in exchanging.auth).toBe(false);

    const succeeded = await pollUntil(
      () => ctrl.status(),
      (s) => s.auth.phase === 'succeeded',
    );
    assertJsonSafe(succeeded);
    expect(succeeded.profile.authenticated).toBe(true);
    expect('authUrl' in succeeded.auth).toBe(false);

    // Logout clears credentials and resets auth phase
    const loggedOut = await ctrl.logout();
    assertJsonSafe(loggedOut);
    expect(loggedOut.profile.authenticated).toBe(false);
    expect(loggedOut.auth.phase).toBe('idle');
    expect(loggedOut.models).toEqual([]);

    // Start code login again and cancel via authCancel()
    await ctrl.authStart({ mode: 'code' });
    await pollUntil(
      () => ctrl.status(),
      (s) => s.auth.phase === 'awaiting_code' && Boolean(s.auth.authUrl),
    );
    const cancelled = await ctrl.authCancel();
    assertJsonSafe(cancelled);
    expect(cancelled.auth.phase).toBe('cancelled');
    expect('authUrl' in cancelled.auth).toBe(false);

    // Start code login again and call logout() while pending -> stays idle
    await ctrl.authStart({ mode: 'code' });
    await pollUntil(
      () => ctrl.status(),
      (s) => s.auth.phase === 'awaiting_code',
    );
    const loggedOutMidFlow = await ctrl.logout();
    await new Promise((r) => setTimeout(r, 40));
    const afterWait = await ctrl.status();
    assertJsonSafe(loggedOutMidFlow);
    assertJsonSafe(afterWait);
    expect(afterWait.auth.phase).toBe('idle');
  }, 15_000);

  it('refreshes models and quota, strips raw/undefined/NaN fields, and redacts secrets & auth URLs from errors', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ctrl-models-quota-'));
    tempDirs.push(tempDir);
    const profileDir = path.join(tempDir, 'profile');
    const customApiSecret = 'sk-custom-secret-value-9876';
    const leakedOAuthUrl =
      'https://accounts.google.com/o/oauth2/auth?client_id=test&code=secret-code-1&state=secret-state-1';

    let shouldFailModels = false;
    let shouldFailQuota = false;
    let shouldFailInstall = false;

    const ctx = new Context();
    await ctx.plugin(MockTypertRegistry);

    const mockRuntime = {
      config: {
        authMethod: 'gemini-api-key' as const,
        apiKey: customApiSecret,
        autoDownload: false,
        extraArgs: [],
        maxConcurrentSessions: 2,
        queueTimeoutMs: 1000,
        handshakeTimeoutMs: 1000,
        requestTimeoutMs: 1000,
        authTimeoutMs: 1000,
        promptTimeoutMs: 1000,
        idleRecycleMs: 1000,
        autoWarmup: false,
        profileDir,
      },
      resolveProfile: () => ({
        profileDir,
        authMethod: 'gemini-api-key' as const,
        authenticated: true,
        hasApiKey: true,
      }),
      getStatus: async () => ({
        installed: true,
        executable: {
          command: '/usr/bin/agy',
          argsPrefix: ['acp'],
          source: 'path' as const,
          version: undefined,
        },
        profile: mockRuntime.resolveProfile(),
        activeLeases: 1,
        idleWorkers: 1,
        maxConcurrentSessions: 2,
      }),
      listModels: async () => {
        if (shouldFailModels) {
          throw new Error(
            `Model probe failed with Bearer ya29.secretTokenVal and ${customApiSecret} at ${leakedOAuthUrl}`,
          );
        }
        return [
          {
            id: 'gemini-2.5-pro',
            name: 'Gemini 2.5 Pro',
            description: undefined,
            isDefault: true,
            defaultThoughtLevel: 'medium',
            thinkingOptions: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
            ],
          },
        ];
      },
      getQuota: async () => {
        if (shouldFailQuota) {
          throw new Error(
            `Quota probe failed via http://alice:superpass@127.0.0.1:8888 using AIzaSyTestGoogleApiKeyValue12345`,
          );
        }
        return {
          capturedAt: '2026-11-22T01:30:00.000Z',
          account: 'user@example.com',
          tier: undefined,
          exhausted: false,
          windows: [
            {
              id: 'flash',
              label: 'Flash',
              remainingFraction: 0.75,
              usedFraction: Number.NaN, // must be stripped cleanly by stripUndefinedJson
              resetAt: undefined,
            },
          ],
          raw: { secretShouldNotAppear: true },
        };
      },
      installManaged: async () => {
        if (shouldFailInstall) {
          throw new Error(`Install error leaking ${leakedOAuthUrl} and ${customApiSecret}`);
        }
        return {
          command: '/usr/bin/agy',
          argsPrefix: ['acp'],
          source: 'downloaded' as const,
        };
      },
      login: async () => {
        throw new Error(`Auth failed: Bearer ya29.abc123 and ${leakedOAuthUrl}`);
      },
    } as unknown as runtimePlugin.AntigravityRuntimeService;

    const control = runtimePlugin.registerAntigravityControlRemote(ctx, mockRuntime, {
      profileDir,
    });
    fibers.push(ctx.fiber);

    const withModels = await control.refreshModels();
    assertJsonSafe(withModels);
    expect(withModels.models).toEqual([
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        isDefault: true,
        defaultThoughtLevel: 'medium',
        thinkingOptions: [
          { id: 'low', name: 'Low' },
          { id: 'high', name: 'High' },
        ],
      },
    ]);
    expect('modelsError' in withModels).toBe(false);

    const withQuota = await control.refreshQuota();
    assertJsonSafe(withQuota);
    expect(withQuota.quota).toEqual({
      capturedAt: '2026-11-22T01:30:00.000Z',
      account: 'user@example.com',
      exhausted: false,
      windows: [
        {
          id: 'flash',
          label: 'Flash',
          remainingFraction: 0.75,
        },
      ],
    });
    expect(JSON.stringify(withQuota)).not.toContain('secretShouldNotAppear');

    // Error redaction across models, quota, install, and auth
    shouldFailModels = true;
    shouldFailQuota = true;
    shouldFailInstall = true;

    const errModels = await control.refreshModels();
    assertJsonSafe(errModels);
    expect(errModels.modelsError).toBeDefined();
    expect(errModels.modelsError).not.toContain('ya29.');
    expect(errModels.modelsError).not.toContain(customApiSecret);
    expect(errModels.modelsError).not.toContain('accounts.google.com');

    const errQuota = await control.refreshQuota();
    assertJsonSafe(errQuota);
    expect(errQuota.quotaError).toBeDefined();
    expect(errQuota.quotaError).not.toContain('alice:superpass');
    expect(errQuota.quotaError).not.toContain('AIzaSy');

    const errInstall = await control.installCli({});
    const failedInstall = await pollUntil(
      () => control.status(),
      (s) => s.install.phase === 'failed',
    );
    assertJsonSafe(errInstall);
    assertJsonSafe(failedInstall);
    expect(failedInstall.install.error).not.toContain('accounts.google.com');
    expect(failedInstall.install.error).not.toContain(customApiSecret);

    const errAuth = await control.authStart({ authMethod: 'gemini-api-key' });
    assertJsonSafe(errAuth);
    expect(errAuth.auth.phase).toBe('failed');
    expect(errAuth.auth.error).not.toContain('ya29.');
    expect(errAuth.auth.error).not.toContain('accounts.google.com');
  });

  it('handles corrupt UI store files resiliently and validates authStart for api-key and loopback modes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ctrl-resilience-'));
    tempDirs.push(tempDir);
    const profileDir = path.join(tempDir, 'profile');
    fs.mkdirSync(profileDir, { recursive: true });

    // Corrupt JSON and invalid field values must not crash loadUiOverrides
    fs.writeFileSync(path.join(profileDir, runtimePlugin.UI_CONFIG_FILENAME), '{corrupt json', 'utf8');
    fs.writeFileSync(path.join(profileDir, runtimePlugin.UI_SECRETS_FILENAME), '[]', 'utf8');
    expect(runtimePlugin.loadUiOverrides(profileDir)).toEqual({});

    fs.writeFileSync(
      path.join(profileDir, runtimePlugin.UI_CONFIG_FILENAME),
      JSON.stringify({
        binaryPath: '   ',
        authMethod: 'unknown-method',
        autoDownload: 'not-bool',
        proxyUrl: 'ftp://invalid',
        gcpProject: '  valid-proj  ',
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(profileDir, runtimePlugin.UI_SECRETS_FILENAME),
      JSON.stringify({ apiKey: '' }),
      'utf8',
    );
    expect(runtimePlugin.loadUiOverrides(profileDir)).toEqual({
      gcpProject: 'valid-proj',
    });

    // Test gemini-api-key authStart & loopback authStart with fake-agy-server
    const fakeBin = createFakeAgyBinary(path.join(tempDir, 'bin'), {
      FAKE_AGY_EMIT_AUTH_LINE: '1',
      FAKE_AGY_EMIT_AUTH_LINE_ON: 'authenticate',
    });

    const ctx = new Context();
    const scope = await ctx.plugin(async (scopeCtx) => {
      await scopeCtx.plugin(LocalSubprocessRuntime);
      await scopeCtx.plugin(MockTypertRegistry);
      await scopeCtx.plugin(runtimePlugin, {
        binaryPath: fakeBin,
        profileDir,
        autoDownload: false,
        authTimeoutMs: 10_000,
        handshakeTimeoutMs: 10_000,
      });
    });
    fibers.push(scope);

    const ctrl = ctx.get('antigravityControl')!;

    // gemini-api-key without key throws gateway/bad-request
    await expect(
      ctrl.authStart({ authMethod: 'gemini-api-key' }),
    ).rejects.toMatchObject({ code: 'gateway/bad-request' });

    // gemini-api-key with key succeeds without leaking apiKey
    const keySecret = 'AIzaTestKeyForAuthStart123456';
    const apiKeyRes = await ctrl.authStart({
      authMethod: 'gemini-api-key',
      apiKey: keySecret,
    });
    assertJsonSafe(apiKeyRes);
    expect(apiKeyRes.auth.phase).toBe('succeeded');
    expect(apiKeyRes.profile.authenticated).toBe(true);
    expect(apiKeyRes.profile.hasApiKey).toBe(true);
    expect(JSON.stringify(apiKeyRes)).not.toContain(keySecret);

    // Loopback OAuth flow via fake-agy-server
    const loopbackStart = await ctrl.authStart({
      mode: 'loopback',
      authMethod: 'oauth-personal',
    });
    assertJsonSafe(loopbackStart);
    const loopbackDone = await pollUntil(
      () => ctrl.status(),
      (s) => s.auth.phase === 'succeeded',
    );
    assertJsonSafe(loopbackDone);
    expect('authUrl' in loopbackDone.auth).toBe(false);
  });

  it('persists saveSubagentConfig without clobbering runtime config, reloads overrides across restart, and activates headless without typert', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ctrl-subagent-'));
    tempDirs.push(tempDir);
    const profileDir = path.join(tempDir, 'profile');
    const fakeBin = createFakeAgyBinary(path.join(tempDir, 'bin'));

    class MockSubagents extends Service {
      readonly providers = new Map<string, SubagentProvider>();
      constructor(c: Context) {
        super(c, 'subagents');
      }
      registerProvider(p: SubagentProvider): () => void {
        this.providers.set(p.name, p);
        return () => {
          this.providers.delete(p.name);
        };
      }
      getProvider(name: string): SubagentProvider | undefined {
        return this.providers.get(name);
      }
      resolveMaxDepth(): undefined {
        return undefined;
      }
    }

    // 1. Mount runtime + control + subagent-plugin, save both runtime & subagent configs.
    const ctx1 = new Context();
    let changedEvents = 0;
    const scope1 = await ctx1.plugin(async (scopeCtx) => {
      await scopeCtx.plugin(LocalSubprocessRuntime);
      await scopeCtx.plugin(MockTypertRegistry);
      await scopeCtx.plugin(MockSubagents);
      await scopeCtx.plugin(runtimePlugin, {
        binaryPath: fakeBin,
        profileDir,
        autoDownload: false,
      });
      await scopeCtx.plugin(subagentPlugin, {
        providerName: 'antigravity',
        toolName: 'antigravity_agent',
        permissionMode: 'default',
        permissionFallback: 'reject',
      });
    });
    fibers.push(scope1);
    ctx1.antigravityRuntime.onSubagentChanged?.(() => {
      changedEvents += 1;
    });

    await ctx1.antigravityControl.saveConfig({ proxyBypass: 'localhost,127.0.0.1' });
    const afterSubSave = await ctx1.antigravityControl.saveSubagentConfig({
      defaultModel: 'gemini-3-pro',
      defaultThoughtLevel: 'high',
      permissionMode: 'auto_edit',
      permissionFallback: 'cancel',
      systemPromptAppend: 'Respond concisely.',
    });
    assertJsonSafe(afterSubSave);
    expect(changedEvents).toBe(1);
    expect(afterSubSave.config.proxyBypass).toBe('localhost,127.0.0.1');
    expect(afterSubSave.subagent).toEqual({
      providerName: 'antigravity',
      toolName: 'antigravity_agent',
      defaultModel: 'gemini-3-pro',
      defaultThoughtLevel: 'high',
      permissionMode: 'auto_edit',
      permissionFallback: 'cancel',
      systemPromptAppend: 'Respond concisely.',
    });

    // Reject invalid permissionMode cleanly via remoteErrorOf
    await expect(
      ctx1.antigravityControl.saveSubagentConfig({
        permissionMode: 'invalid-mode' as never,
      }),
    ).rejects.toMatchObject({ name: expect.stringMatching(/RemoteError|Error/) });

    // Saving runtime config again must NOT wipe subagent section in ui-config.json
    const afterRuntimeSave = await ctx1.antigravityControl.saveConfig({ proxyBypass: 'localhost' });
    expect(afterRuntimeSave.subagent.defaultModel).toBe('gemini-3-pro');

    // Empty string clears defaultModel without disturbing other fields
    const afterClear = await ctx1.antigravityControl.saveSubagentConfig({ defaultModel: '' });
    expect(afterClear.subagent.defaultModel).toBe('');
    expect(afterClear.subagent.defaultThoughtLevel).toBe('high');

    // Re-set model before reload check
    await ctx1.antigravityControl.saveSubagentConfig({ defaultModel: 'gemini-2.5-pro' });
    await scope1.dispose();
    fibers.pop();

    // 2. Restart headless (NO typert): verify persisted subagent overrides reload cleanly on startup
    const ctx2 = new Context();
    const scope2 = await ctx2.plugin(async (scopeCtx) => {
      await scopeCtx.plugin(LocalSubprocessRuntime);
      await scopeCtx.plugin(MockSubagents);
      await scopeCtx.plugin(runtimePlugin, {
        binaryPath: fakeBin,
        profileDir,
        autoDownload: false,
      });
      await scopeCtx.plugin(subagentPlugin, {
        providerName: 'antigravity',
      });
    });
    fibers.push(scope2);

    expect(ctx2.get('antigravityControl')).toBeUndefined();
    expect(ctx2.antigravityRuntime.getSubagentConfig?.()).toEqual({
      defaultModel: 'gemini-2.5-pro',
      defaultThoughtLevel: 'high',
      permissionMode: 'auto_edit',
      permissionFallback: 'cancel',
      systemPromptAppend: 'Respond concisely.',
    });
  });

  it('supports checkUpdate, updatePlugin with Cordis pluginManager + progress events, cancelPluginUpdate, and HMR-safe dispose', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ctrl-update-'));
    tempDirs.push(tempDir);

    const dshProfileDir = path.join(tempDir, 'dsh-profile-web');
    const pkgDir = path.join(dshProfileDir, 'node_modules', 'dsh-antigravity-acp');
    const agyProfileDir = path.join(tempDir, 'agy-profile');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(agyProfileDir, { recursive: true });

    const oldSha = 'a'.repeat(40);
    const newSha = 'b'.repeat(40);
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-antigravity-acp',
        version: '0.1.0',
        repository: { url: 'git+https://github.com/qq1299235059/dsh-antigravity-acp.git' },
      }),
    );
    fs.writeFileSync(
      path.join(dshProfileDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        dependencies: {
          'dsh-antigravity-acp': 'github:qq1299235059/dsh-antigravity-acp',
        },
        dsh: { profile: { bundles: ['dsh-antigravity-acp'] } },
      }),
    );
    fs.writeFileSync(
      path.join(dshProfileDir, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      dsh-antigravity-acp:\n        specifier: github:qq1299235059/dsh-antigravity-acp\n        version: https://codeload.github.com/qq1299235059/dsh-antigravity-acp/tar.gz/${oldSha}(zod@4.6.7)\n`,
    );

    const fakeBin = createFakeAgyBinary(path.join(tempDir, 'bin'));
    const installCalls: Array<{ spec: string; requestId?: string }> = [];
    const cancelCalls: string[] = [];
    let deferNextInstall = false;
    const deferredResolvers: Array<
      (res: {
        changed: boolean;
        application: 'applied' | 'restart-required' | 'cancelled' | 'failed';
        restartReason?: string;
        version?: string;
      }) => void
    > = [];

    class MockPluginManagerService extends Service {
      constructor(ctx: Context) {
        super(ctx, 'pluginManager');
      }

      async installBundle(
        spec: string,
        opts?: { enabled?: boolean; requestId?: string },
      ) {
        installCalls.push({ spec, requestId: opts?.requestId });
        if (deferNextInstall) {
          return await new Promise((resolve) => {
            deferredResolvers.push(resolve);
          });
        }
        (this.ctx as unknown as { emit(e: string, p: unknown): void }).emit(
          'plugin-manager/install-state',
          { requestId: opts?.requestId, phase: 'installing' },
        );
        // Simulate pnpm writing updated files on disk
        fs.writeFileSync(
          path.join(pkgDir, 'package.json'),
          JSON.stringify({
            name: 'dsh-antigravity-acp',
            version: '0.2.0',
            repository: { url: 'git+https://github.com/qq1299235059/dsh-antigravity-acp.git' },
          }),
        );
        fs.writeFileSync(
          path.join(dshProfileDir, 'package.json'),
          JSON.stringify({
            name: 'dsh-profile-web',
            dependencies: {
              'dsh-antigravity-acp': spec,
            },
            dsh: { profile: { bundles: ['dsh-antigravity-acp'] } },
          }),
        );
        (this.ctx as unknown as { emit(e: string, p: unknown): void }).emit(
          'plugin-manager/install-state',
          { requestId: opts?.requestId, phase: 'applying' },
        );
        return {
          changed: true,
          application: 'restart-required' as const,
          restartReason: 'package-moved',
          version: '0.2.0',
        };
      }

      async cancelInstall(requestId: string) {
        cancelCalls.push(requestId);
        const resolve = deferredResolvers.shift();
        resolve?.({
          changed: false,
          application: 'cancelled',
        });
        return { status: 'cancelled' as const };
      }
    }

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/commits/main')) {
        return new Response(
          JSON.stringify({
            sha: newSha,
            html_url: `https://github.com/qq1299235059/dsh-antigravity-acp/commit/${newSha}`,
            commit: {
              message: 'feat: self-update support',
              committer: { date: '2026-11-22T06:30:00Z' },
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/${newSha}/package.json`) || url.endsWith('/main/package.json')) {
        return new Response(JSON.stringify({ name: 'dsh-antigravity-acp', version: '0.2.0' }), {
          status: 200,
        });
      }
      return new Response('not found', { status: 404 });
    });

    const ctx = new Context();
    let control!: ReturnType<typeof registerAntigravityControlRemote>;
    const scope = await ctx.plugin(async (scopeCtx) => {
      await scopeCtx.plugin(LocalSubprocessRuntime);
      await scopeCtx.plugin(MockTypertRegistry);
      await scopeCtx.plugin(MockPluginManagerService);
      const rt = runtimePlugin.createAntigravityRuntimeService(scopeCtx.get('subprocess')!, {
        ...runtimePlugin.RuntimeConfigSchema({}),
        binaryPath: fakeBin,
        profileDir: agyProfileDir,
        autoDownload: false,
      });
      control = registerAntigravityControlRemote(scopeCtx, rt, {
        profileDir: agyProfileDir,
        dshProfileDir,
        packageRootDir: pkgDir,
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      });
    });
    fibers.push(scope);

    // Reject foreign / invalid targetSpec strictly with gateway/bad-request
    await expect(
      control.updatePlugin({ targetSpec: 'github:attacker/malicious#main' }),
    ).rejects.toMatchObject({ code: 'gateway/bad-request' });

    // checkUpdate detects newer version & commit and preserves JSON safety
    const checked = await control.checkUpdate();
    assertJsonSafe(checked);
    expect(checked.pluginUpdate).toMatchObject({
      currentVersion: '0.1.0',
      currentCommit: oldSha,
      latestVersion: '0.2.0',
      latestCommit: newSha,
      updateAvailable: true,
      reason: 'newer-version',
      canAutoUpdate: true,
      phase: 'idle',
      installSpec: `github:qq1299235059/dsh-antigravity-acp#${newSha}`,
    });

    // updatePlugin runs installBundle and settles with restartRequired: true
    await control.updatePlugin({});
    const updated = await pollUntil(
      () => control.status(),
      (s) => s.pluginUpdate.phase === 'succeeded',
    );
    assertJsonSafe(updated);
    expect(installCalls).toHaveLength(1);
    expect(installCalls[0].spec).toBe(`github:qq1299235059/dsh-antigravity-acp#${newSha}`);
    expect(updated.pluginUpdate).toMatchObject({
      phase: 'succeeded',
      currentVersion: '0.2.0',
      currentCommit: newSha,
      updateAvailable: false,
      restartRequired: true,
      restartReason: 'package-moved',
    });

    // Verify cancelPluginUpdate cancels an in-flight update, whereas dispose() NEVER calls cancelInstall
    deferNextInstall = true;
    await control.updatePlugin({
      targetSpec: `github:qq1299235059/dsh-antigravity-acp#${oldSha}`,
    });
    const cancellingSnap = await control.cancelPluginUpdate();
    assertJsonSafe(cancellingSnap);
    expect(cancelCalls).toHaveLength(1);
    expect(cancellingSnap.pluginUpdate.phase).toBe('cancelled');

    // Now start another in-flight update and dispose() service -> cancelInstall MUST NOT be called again (HMR safety)
    deferNextInstall = true;
    await control.updatePlugin({
      targetSpec: `github:qq1299235059/dsh-antigravity-acp#${newSha}`,
    });
    expect(installCalls).toHaveLength(3);
    const cancelCountBeforeDispose = cancelCalls.length;
    await scope.dispose();
    fibers.pop();
    expect(cancelCalls).toHaveLength(cancelCountBeforeDispose);
    while (deferredResolvers.length > 0) {
      deferredResolvers.shift()?.({ changed: false, application: 'cancelled' });
    }
  });
});
