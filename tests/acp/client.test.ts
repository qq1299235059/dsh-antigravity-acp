import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnAcpClient } from '../../src/acp/client.js';
import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  prepareAntigravityProfile,
} from '../../src/runtime/profile.js';
import { RuntimeConfigSchema, type RuntimeConfig } from '../../src/shared/config.js';
import type { AntigravityExecutable } from '../../src/shared/contracts.js';

const FAKE_SERVER_PATH = fileURLToPath(new URL('./fake-agy-server.mjs', import.meta.url));

function createTestConfig(profileDir: string, overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    ...RuntimeConfigSchema({ profileDir }),
    handshakeTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
    promptTimeoutMs: 10_000,
    authTimeoutMs: 10_000,
    ...overrides,
  };
}

function fakeExecutable(version = '1.5.2'): AntigravityExecutable {
  return {
    command: process.execPath,
    argsPrefix: [FAKE_SERVER_PATH, 'acp'],
    source: 'configured',
    version,
  };
}

describe('acp/client', () => {
  const tempDirs: string[] = [];
  const contexts: Context[] = [];

  async function setupRuntime(profileOverrides?: Partial<RuntimeConfig>) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-client-test-'));
    tempDirs.push(tempDir);

    const ctx = new Context();
    await ctx.plugin(LocalSubprocessRuntime);
    contexts.push(ctx);

    const config = createTestConfig(path.join(tempDir, 'profile'), profileOverrides);
    const profile = await prepareAntigravityProfile(config);
    return { tempDir, ctx, config, profile };
  }

  afterEach(async () => {
    while (contexts.length > 0) {
      const ctx = contexts.pop()!;
      await ctx.fiber.dispose().catch(() => {});
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('completes initialize handshake, creates session with systemPrompt.append, model, thought_level, and streams deltas', async () => {
    const { tempDir, ctx, config, profile } = await setupRuntime();
    const client = await spawnAcpClient({
      subprocess: ctx.subprocess,
      executable: fakeExecutable('1.5.2'),
      profile,
      config,
      cwd: tempDir,
      env: {
        FAKE_AGY_ECHO_CONTEXT: '1',
        FAKE_AGY_THOUGHT: 'Deep reasoning...',
        GEMINI_API_KEY: 'should-be-scrubbed',
        GOOGLE_CLOUD_PROJECT: 'should-be-scrubbed',
      },
    });

    try {
      expect(client.initialized.agentVersion).toBe('1.5.2');
      expect(client.initialized.supportsImages).toBe(true);
      expect(client.initialized.supportsMcpHttp).toBe(true);

      const session = await client.newSession({
        cwd: tempDir,
        mcpServers: [],
        systemPrompt: 'Always reply in JSON',
        model: 'gemini-2.5-flash',
        thoughtLevel: 'high',
        mode: 'yolo',
      });

      const textChunks: string[] = [];
      const thoughtChunks: string[] = [];
      const usageUpdates: number[] = [];

      const result = await client.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'hello world' }],
        },
        {
          onTextDelta: (delta) => textChunks.push(delta),
          onThoughtDelta: (delta) => thoughtChunks.push(delta),
          onUsageUpdate: (usage) => usageUpdates.push(usage.used),
        },
      );

      expect(result.stopReason).toBe('end_turn');
      expect(thoughtChunks.join('')).toBe('Deep reasoning...');
      expect(result.reasoning).toBe('Deep reasoning...');
      expect(usageUpdates).toEqual([120]);
      expect(result.usage?.inputTokens).toBe(12);

      const echoed = JSON.parse(textChunks.join('')) as Record<string, unknown>;
      expect(echoed['clientInfo']).toEqual({
        name: 'dsh-antigravity-acp',
        title: 'DSH Antigravity ACP',
        version: '0.1.0',
      });
      expect(echoed['clientCapabilities']).toEqual({
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      });
      expect(echoed['sessionMeta']).toEqual({
        antigravity: { systemPrompt: { append: 'Always reply in JSON' } },
      });
      expect(echoed['model']).toBe('gemini-2.5-flash');
      expect(echoed['thoughtLevel']).toBe('high');
      expect(echoed['mode']).toBe('default');

      const envSample = echoed['envSample'] as Record<string, unknown>;
      expect(envSample['GEMINI_API_KEY']).toBeNull();
      expect(envSample['GOOGLE_CLOUD_PROJECT']).toBeNull();
      expect(envSample['GEMINI_HOME']).toBe(profile.geminiHome);
      expect(envSample['AGY_ACP_FORCE_FILE_STORAGE']).toBe('1');
      expect(envSample['SSH_CONNECTION']).toBe('127.0.0.1 0 127.0.0.1 0');
    } finally {
      await client.close();
    }
  });

  it('sends legacy zed clientInfo for 1.5.0 and rejects < 1.5.0 unless skipVersionCheck is true', async () => {
    const { tempDir, ctx, config, profile } = await setupRuntime();

    const client150 = await spawnAcpClient({
      subprocess: ctx.subprocess,
      executable: fakeExecutable('1.5.0'),
      profile,
      config,
      cwd: tempDir,
      env: { FAKE_AGY_VERSION: '1.5.0', FAKE_AGY_ECHO_CONTEXT: '1' },
    });

    try {
      const sess = await client150.newSession({ cwd: tempDir });
      const res = await client150.prompt({
        sessionId: sess.sessionId,
        prompt: [{ type: 'text', text: 'check' }],
      });
      const echoed = JSON.parse(res.text) as Record<string, unknown>;
      expect(echoed['clientInfo']).toEqual({ name: 'zed', version: '0.0.0' });
    } finally {
      await client150.close();
    }

    await expect(
      spawnAcpClient({
        subprocess: ctx.subprocess,
        executable: fakeExecutable('1.4.9'),
        profile,
        config,
        cwd: tempDir,
        env: { FAKE_AGY_VERSION: '1.4.9' },
      }),
    ).rejects.toMatchObject({
      name: 'AntigravityAcpError',
      code: 'AGY_VERSION_UNSUPPORTED',
    });

    const skipped = await spawnAcpClient({
      subprocess: ctx.subprocess,
      executable: fakeExecutable('1.4.9'),
      profile,
      config,
      cwd: tempDir,
      skipVersionCheck: true,
      env: { FAKE_AGY_VERSION: '1.4.9' },
    });
    await skipped.close();
  });

  it('strips stdout auth lines and invokes onAuthUrl without breaking JSON-RPC, and captures stderr marker', async () => {
    const { tempDir, ctx, config, profile } = await setupRuntime();
    const seenUrls: string[] = [];

    const client = await spawnAcpClient({
      subprocess: ctx.subprocess,
      executable: fakeExecutable('1.5.2'),
      profile,
      config,
      cwd: tempDir,
      callbacks: {
        onAuthUrl: (url) => seenUrls.push(url),
      },
      env: {
        FAKE_AGY_EMIT_AUTH_LINE: '1',
        FAKE_AGY_EMIT_BROWSER_MARKER: '1',
      },
    });

    try {
      const models = await client.discoverModels(tempDir);
      expect(models.length).toBeGreaterThanOrEqual(2);
      expect(models[0]?.thinkingOptions?.length).toBeGreaterThanOrEqual(3);
      expect(seenUrls.length).toBeGreaterThanOrEqual(1);
      expect(seenUrls[0]).toContain('https://accounts.google.com/o/oauth2/auth');
    } finally {
      await client.close();
    }
  });

  it('fails with AGY_AUTH_REQUIRED on stdout auth line without handler and on -32000 / no-browser RPC errors', async () => {
    const { tempDir, ctx, config, profile } = await setupRuntime();

    await expect(
      spawnAcpClient({
        subprocess: ctx.subprocess,
        executable: fakeExecutable('1.5.2'),
        profile,
        config,
        cwd: tempDir,
        env: { FAKE_AGY_EMIT_AUTH_LINE: '1' },
      }),
    ).rejects.toMatchObject({
      code: 'AGY_AUTH_REQUIRED',
    });

    const clientNoBrowser = await spawnAcpClient({
      subprocess: ctx.subprocess,
      executable: fakeExecutable('1.5.2'),
      profile,
      config,
      cwd: tempDir,
      env: { FAKE_AGY_AUTH_REQUIRED: 'no_browser' },
    });
    try {
      await expect(clientNoBrowser.newSession({ cwd: tempDir })).rejects.toMatchObject({
        code: 'AGY_AUTH_REQUIRED',
      });
    } finally {
      await clientNoBrowser.close();
    }
  });

  it('aborts an in-flight prompt via AbortSignal and handles subprocess crashes gracefully', async () => {
    const { tempDir, ctx, config, profile } = await setupRuntime();

    const delayedClient = await spawnAcpClient({
      subprocess: ctx.subprocess,
      executable: fakeExecutable('1.5.2'),
      profile,
      config,
      cwd: tempDir,
      env: { FAKE_AGY_DELAY_MS: '5000' },
    });
    try {
      const sess = await delayedClient.newSession({ cwd: tempDir });
      const abortController = new AbortController();
      const promptPromise = delayedClient.prompt(
        { sessionId: sess.sessionId, prompt: [{ type: 'text', text: 'slow' }] },
        undefined,
        abortController.signal,
      );
      setTimeout(() => abortController.abort(), 50);
      await expect(promptPromise).rejects.toMatchObject({ code: 'ABORTED' });
    } finally {
      await delayedClient.close();
    }

    const crashingClient = await spawnAcpClient({
      subprocess: ctx.subprocess,
      executable: fakeExecutable('1.5.2'),
      profile,
      config,
      cwd: tempDir,
      env: { FAKE_AGY_CRASH: 'prompt' },
    });
    try {
      const sess = await crashingClient.newSession({ cwd: tempDir });
      await expect(
        crashingClient.prompt({
          sessionId: sess.sessionId,
          prompt: [{ type: 'text', text: 'boom' }],
        }),
      ).rejects.toMatchObject({ code: 'TRANSPORT' });
      await crashingClient.closed;
      expect(crashingClient.isClosed).toBe(true);
    } finally {
      await crashingClient.close();
    }
  });

  it('supports setSessionMode, setSessionConfigOption, loadSession, authenticate, logout, and requestPermission callbacks', async () => {
    const { tempDir, ctx, config, profile } = await setupRuntime();
    const modeUpdates: string[] = [];
    const configUpdateCounts: number[] = [];

    const client = await spawnAcpClient({
      subprocess: ctx.subprocess,
      executable: fakeExecutable('1.5.2'),
      profile,
      config,
      cwd: tempDir,
      env: { FAKE_AGY_PERMISSION_PROMPT: '1' },
    });

    try {
      await client.authenticate('oauth-personal');
      const sess = await client.newSession({ cwd: tempDir });
      client.setCallbacks?.({
        onModeUpdate: (modeId) => modeUpdates.push(modeId),
        onConfigOptionsUpdate: (opts) => configUpdateCounts.push(opts.length),
      });

      await client.setSessionMode(sess.sessionId, 'auto');
      const cfgResp = await client.setSessionConfigOption(sess.sessionId, 'thought_level', 'low');
      expect(cfgResp.configOptions.length).toBeGreaterThanOrEqual(2);
      expect(modeUpdates).toEqual(['auto']);
      expect(configUpdateCounts).toEqual([2]);

      const loaded = await client.loadSession?.({
        sessionId: sess.sessionId,
        cwd: tempDir,
        mcpServers: [],
      });
      expect(loaded?.modes?.currentModeId).toBe('auto');

      // Default requestPermission fallback rejects when no onRequestPermission is supplied
      const deniedResult = await client.prompt({
        sessionId: sess.sessionId,
        prompt: [{ type: 'text', text: 'need perm' }],
      });
      expect(deniedResult.stopReason).toBe('refusal');
      expect(deniedResult.text).toBe('Permission rejected:reject_once');

      // Explicit per-turn onRequestPermission allows allow_once
      const allowedResult = await client.prompt(
        {
          sessionId: sess.sessionId,
          prompt: [{ type: 'text', text: 'need perm' }],
        },
        {
          onRequestPermission: () => ({
            outcome: { outcome: 'selected', optionId: 'allow_once' },
          }),
        },
      );
      expect(allowedResult.stopReason).toBe('end_turn');
      expect(allowedResult.text).toBe('Permission allowed:allow_once');

      await client.logout?.();
    } finally {
      await client.close();
    }
  });

  it('enforces promptTimeoutMs and advertises optional fs capabilities only when callbacks are provided', async () => {
    const { tempDir, ctx, config, profile } = await setupRuntime({
      promptTimeoutMs: 120,
    });

    const timeoutClient = await spawnAcpClient({
      subprocess: ctx.subprocess,
      executable: fakeExecutable('1.5.2'),
      profile,
      config,
      cwd: tempDir,
      env: { FAKE_AGY_DELAY_MS: '5000' },
    });
    try {
      const sess = await timeoutClient.newSession({ cwd: tempDir });
      await expect(
        timeoutClient.prompt({
          sessionId: sess.sessionId,
          prompt: [{ type: 'text', text: 'timeout me' }],
        }),
      ).rejects.toMatchObject({ code: 'TIMEOUT' });
    } finally {
      await timeoutClient.close();
    }

    const fsClient = await spawnAcpClient({
      subprocess: ctx.subprocess,
      executable: fakeExecutable('1.5.2'),
      profile,
      config: { ...config, promptTimeoutMs: 10_000 },
      cwd: tempDir,
      env: { FAKE_AGY_ECHO_CONTEXT: '1' },
      callbacks: {
        onReadTextFile: async () => ({ content: 'ok' }),
      },
    });
    try {
      const sess = await fsClient.newSession({ cwd: tempDir });
      const res = await fsClient.prompt({
        sessionId: sess.sessionId,
        prompt: [{ type: 'text', text: 'check caps' }],
      });
      const echoed = JSON.parse(res.text) as { clientCapabilities: Record<string, unknown> };
      expect(echoed.clientCapabilities).toEqual({
        fs: { readTextFile: true, writeTextFile: false },
        terminal: false,
      });
    } finally {
      await fsClient.close();
    }
  });

  it('strips auth URLs and browser markers from stderrTail in AntigravityAcpError on process crash', async () => {
    const { tempDir, ctx, config, profile } = await setupRuntime();
    const capturedUrls: string[] = [];

    const client = await spawnAcpClient({
      subprocess: ctx.subprocess,
      executable: fakeExecutable('1.5.2'),
      profile,
      config,
      cwd: tempDir,
      callbacks: {
        onAuthUrl: (url) => capturedUrls.push(url),
      },
      env: {
        FAKE_AGY_EMIT_BROWSER_MARKER:
          'https://accounts.google.com/o/oauth2/auth?client_id=leak-test&redirect_uri=http%3A%2F%2F127.0.0.1%3A9999%2Fcb&state=secret-state',
        FAKE_AGY_CRASH: 'prompt',
      },
    });

    try {
      expect(capturedUrls).toHaveLength(1);
      expect(capturedUrls[0]).toContain('accounts.google.com');

      const sess = await client.newSession({ cwd: tempDir });
      let thrown: unknown;
      try {
        await client.prompt({
          sessionId: sess.sessionId,
          prompt: [{ type: 'text', text: 'crash after marker' }],
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      const errObj = thrown as { code?: string; message: string };
      expect(errObj.code).toBe('TRANSPORT');
      expect(errObj.message).toContain('Simulated prompt crash');
      expect(errObj.message).not.toContain('accounts.google.com');
      expect(errObj.message).not.toContain('leak-test');
      expect(errObj.message).not.toContain(ANTIGRAVITY_AUTH_BROWSER_MARKER);
      expect(errObj.message).not.toContain(ANTIGRAVITY_AUTH_STDOUT_PREFIX);
    } finally {
      await client.close();
    }
  });
});
