import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpWorkerPool } from '../../src/acp/pool.js';
import { prepareAntigravityProfile } from '../../src/runtime/profile.js';
import { RuntimeConfigSchema, type RuntimeConfig } from '../../src/shared/config.js';
import type {
  AcpClientHandle,
  AcpTurnCallbacks,
  AntigravityExecutable,
} from '../../src/shared/contracts.js';

const FAKE_SERVER_PATH = fileURLToPath(new URL('./fake-agy-server.mjs', import.meta.url));

function makeMockClient(id: string): AcpClientHandle & { closeCount: number; callbacksHistory: Array<AcpTurnCallbacks | undefined> } {
  let closed = false;
  let sessionSeq = 0;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const callbacksHistory: Array<AcpTurnCallbacks | undefined> = [];

  const handle: AcpClientHandle & {
    closeCount: number;
    callbacksHistory: Array<AcpTurnCallbacks | undefined>;
  } = {
    id,
    closeCount: 0,
    callbacksHistory,
    initialized: {
      protocolVersion: 1,
      agentName: 'mock',
      agentVersion: '1.5.2',
      authMethods: [],
      supportsImages: true,
      supportsAudio: false,
      supportsEmbeddedContext: true,
      supportsLoadSession: true,
      supportsMcpHttp: true,
      supportsMcpSse: false,
    },
    executable: {
      command: 'mock',
      argsPrefix: [],
      source: 'configured',
      version: '1.5.2',
    },
    profile: {
      profileDir: '/tmp/mock',
      authMethod: 'oauth-personal',
      authenticated: true,
      hasApiKey: false,
    },
    closed: closedPromise,
    get isClosed() {
      return closed;
    },
    async authenticate() {},
    setCallbacks(cbs) {
      callbacksHistory.push(cbs);
    },
    async newSession() {
      sessionSeq += 1;
      return { sessionId: `${id}-sess-${sessionSeq}` };
    },
    async setSessionMode() {},
    async setSessionConfigOption() {
      return { configOptions: [] };
    },
    async prompt(params) {
      return {
        sessionId: params.sessionId,
        stopReason: 'end_turn',
        text: 'ok',
        reasoning: '',
      };
    },
    async cancel() {},
    async discoverModels() {
      return [];
    },
    async close() {
      handle.closeCount += 1;
      if (!closed) {
        closed = true;
        resolveClosed();
      }
    },
  };
  return handle;
}

function createTestConfig(profileDir: string, overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    ...RuntimeConfigSchema({ profileDir }),
    maxConcurrentSessions: 2,
    queueTimeoutMs: 5_000,
    handshakeTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
    promptTimeoutMs: 10_000,
    idleRecycleMs: 0,
    ...overrides,
  };
}

describe('acp/pool', () => {
  const tempDirs: string[] = [];
  const contexts: Context[] = [];
  const pools: AcpWorkerPool[] = [];

  async function setupEnv(configOverrides?: Partial<RuntimeConfig>) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pool-test-'));
    tempDirs.push(tempDir);

    const ctx = new Context();
    await ctx.plugin(LocalSubprocessRuntime);
    contexts.push(ctx);

    const config = createTestConfig(path.join(tempDir, 'profile'), configOverrides);
    const profile = await prepareAntigravityProfile(config);
    const executable: AntigravityExecutable = {
      command: process.execPath,
      argsPrefix: [FAKE_SERVER_PATH, 'acp'],
      source: 'configured',
      version: '1.5.2',
    };
    return { tempDir, ctx, config, profile, executable };
  }

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop()!;
      await pool.dispose().catch(() => {});
    }
    while (contexts.length > 0) {
      const ctx = contexts.pop()!;
      await ctx.fiber.dispose().catch(() => {});
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces maxConcurrentSessions, FIFO wait queue, and session affinity with real fake-agy-server', async () => {
    const { tempDir, ctx, config, profile, executable } = await setupEnv({
      maxConcurrentSessions: 2,
    });

    const pool = new AcpWorkerPool({
      subprocess: ctx.subprocess,
      config,
      resolveExecutable: async () => executable,
      prepareProfile: async () => profile,
    });
    pools.push(pool);

    const lease1 = await pool.acquireWorker({
      cwd: tempDir,
      sessionKey: 'conv-1',
      setup: { cwd: tempDir },
    });
    const lease2 = await pool.acquireWorker({
      cwd: tempDir,
      sessionKey: 'conv-2',
      setup: { cwd: tempDir },
    });

    expect(pool.getStats()).toEqual({
      activeLeases: 2,
      idleWorkers: 0,
      queuedWaiters: 0,
      maxConcurrentSessions: 2,
    });

    const acquisitionOrder: string[] = [];
    const queued1 = pool
      .acquireWorker({ cwd: tempDir, sessionKey: 'conv-1' })
      .then((lease) => {
        acquisitionOrder.push('q1');
        return lease;
      });
    const queued2 = pool
      .acquireWorker({ cwd: tempDir, sessionKey: 'conv-3', setup: { cwd: tempDir } })
      .then((lease) => {
        acquisitionOrder.push('q2');
        return lease;
      });

    expect(pool.getStats().queuedWaiters).toBe(2);

    const firstClientId = lease1.client.id;
    const firstSessionId = lease1.sessionId;
    await lease1.release();

    const lease1Reacquired = await queued1;
    expect(lease1Reacquired.client.id).toBe(firstClientId);
    expect(lease1Reacquired.sessionId).toBe(firstSessionId);

    await lease2.release();
    const lease3 = await queued2;
    expect(acquisitionOrder).toEqual(['q1', 'q2']);

    await lease1Reacquired.release();
    await lease3.release();

    expect(pool.getStats().activeLeases).toBe(0);
    expect(pool.getStats().idleWorkers).toBe(2);
  });

  it('recycles workers when requested, handles queue timeout/abort, and enforces max queue size 64', async () => {
    const { tempDir, ctx, config, profile, executable } = await setupEnv({
      maxConcurrentSessions: 1,
      queueTimeoutMs: 120,
    });

    let spawnCount = 0;
    const spawnedClients: ReturnType<typeof makeMockClient>[] = [];
    const pool = new AcpWorkerPool({
      subprocess: ctx.subprocess,
      config,
      resolveExecutable: async () => executable,
      prepareProfile: async () => profile,
      spawnClientFn: async () => {
        spawnCount += 1;
        const client = makeMockClient(`w-${spawnCount}`);
        spawnedClients.push(client);
        return client;
      },
    });
    pools.push(pool);

    const holder = await pool.acquireWorker({
      cwd: tempDir,
      sessionKey: 's1',
      setup: { cwd: tempDir },
    });

    const abortController = new AbortController();
    const abortedWait = pool.acquireWorker({
      cwd: tempDir,
      sessionKey: 's2',
      signal: abortController.signal,
    });
    abortController.abort();
    await expect(abortedWait).rejects.toMatchObject({ code: 'ABORTED' });

    const timedOutWait = pool.acquireWorker({ cwd: tempDir, sessionKey: 's3' });
    await expect(timedOutWait).rejects.toMatchObject({ code: 'TIMEOUT' });

    // Saturate max queue size (64)
    const queuePool = new AcpWorkerPool({
      subprocess: ctx.subprocess,
      config: { ...config, queueTimeoutMs: 30_000 },
      resolveExecutable: async () => executable,
      prepareProfile: async () => profile,
      spawnClientFn: async () => makeMockClient('cap'),
    });
    pools.push(queuePool);

    const capHolder = await queuePool.acquireWorker({ cwd: tempDir });
    const queued: Promise<unknown>[] = [];
    for (let i = 0; i < 64; i++) {
      const p = queuePool.acquireWorker({ cwd: tempDir });
      p.catch(() => {});
      queued.push(p);
    }
    await expect(queuePool.acquireWorker({ cwd: tempDir })).rejects.toMatchObject({
      code: 'AGY_SESSION_LIMIT',
    });

    await queuePool.dispose();
    await expect(queued[0]).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(queued[63]).rejects.toMatchObject({ code: 'ABORTED' });
    await capHolder.release();

    await holder.release({ recycle: true, reason: 'test recycle' });
    expect(spawnedClients[0]?.closeCount).toBe(1);
    expect(pool.getStats().idleWorkers).toBe(0);
  });

  it('reaps idle workers after idleRecycleMs while never reaping active leases', async () => {
    const { tempDir, ctx, config, profile, executable } = await setupEnv({
      maxConcurrentSessions: 2,
      idleRecycleMs: 80,
    });

    let seq = 0;
    const spawned: ReturnType<typeof makeMockClient>[] = [];
    const pool = new AcpWorkerPool({
      subprocess: ctx.subprocess,
      config,
      resolveExecutable: async () => executable,
      prepareProfile: async () => profile,
      spawnClientFn: async () => {
        seq += 1;
        const c = makeMockClient(`idle-${seq}`);
        spawned.push(c);
        return c;
      },
    });
    pools.push(pool);

    const idleLease = await pool.acquireWorker({ cwd: tempDir, sessionKey: 'idle-s' });
    const activeLease = await pool.acquireWorker({ cwd: tempDir, sessionKey: 'active-s' });

    await idleLease.release();
    await new Promise((resolve) => setTimeout(resolve, 160));

    expect(spawned[0]?.isClosed).toBe(true);
    expect(spawned[1]?.isClosed).toBe(false);
    expect(pool.getStats().idleWorkers).toBe(0);
    expect(pool.getStats().activeLeases).toBe(1);

    await activeLease.release();
  });

  it('supports isolated spawnClient outside pool cap and closes everything on dispose()', async () => {
    const { tempDir, ctx, config, profile, executable } = await setupEnv({
      maxConcurrentSessions: 1,
    });

    let seq = 0;
    const spawned: ReturnType<typeof makeMockClient>[] = [];
    const pool = new AcpWorkerPool({
      subprocess: ctx.subprocess,
      config,
      resolveExecutable: async () => executable,
      prepareProfile: async () => profile,
      spawnClientFn: async () => {
        seq += 1;
        const c = makeMockClient(`iso-${seq}`);
        spawned.push(c);
        return c;
      },
    });
    pools.push(pool);

    const leased = await pool.acquireWorker({ cwd: tempDir });
    const isolated = await pool.spawnClient({ cwd: tempDir });

    expect(pool.getStats().activeLeases).toBe(1);
    expect(leased.client.id).not.toBe(isolated.id);

    await pool.dispose();
    await pool.dispose(); // idempotent

    expect(spawned.every((c) => c.isClosed)).toBe(true);
    await expect(pool.acquireWorker({ cwd: tempDir })).rejects.toMatchObject({ code: 'TRANSPORT' });
  });

  it('evicts LRU idle workers on capacity, respects reuseSession:false, supports asyncDispose, and cleans up failed setup', async () => {
    const { tempDir, ctx, config, profile, executable } = await setupEnv({
      maxConcurrentSessions: 2,
    });

    let seq = 0;
    const spawned: ReturnType<typeof makeMockClient>[] = [];
    const pool = new AcpWorkerPool({
      subprocess: ctx.subprocess,
      config,
      resolveExecutable: async () => executable,
      prepareProfile: async () => profile,
      spawnClientFn: async () => {
        seq += 1;
        const c = makeMockClient(`lru-${seq}`);
        if (seq === 4) {
          c.newSession = async () => {
            throw new Error('newSession boom');
          };
        }
        spawned.push(c);
        return c;
      },
    });
    pools.push(pool);

    // Fill pool with two keyed idle workers: s1 then s2
    {
      await using l1 = await pool.acquireWorker({
        cwd: tempDir,
        sessionKey: 's1',
        setup: { cwd: tempDir },
      });
      expect(l1.sessionId).toBe('lru-1-sess-1');
    }
    {
      await using l2 = await pool.acquireWorker({
        cwd: tempDir,
        sessionKey: 's2',
        setup: { cwd: tempDir },
      });
      expect(l2.sessionId).toBe('lru-2-sess-1');
    }

    // Reusing s1 with reuseSession:false must close lru-1 and allocate fresh worker lru-3
    const freshS1 = await pool.acquireWorker({
      cwd: tempDir,
      sessionKey: 's1',
      reuseSession: false,
      setup: { cwd: tempDir },
    });
    expect(freshS1.client.id).toBe('lru-3');
    expect(spawned[0]?.isClosed).toBe(true);
    await freshS1.release();

    // Failed setup on new worker lru-4 must destroy lru-4 without leaking concurrency slot
    await expect(
      pool.acquireWorker({
        cwd: tempDir,
        sessionKey: 's3',
        setup: { cwd: tempDir },
      }),
    ).rejects.toThrow('newSession boom');
    expect(spawned[3]?.isClosed).toBe(true);
    expect(pool.getStats().activeLeases).toBe(0);
  });
});
