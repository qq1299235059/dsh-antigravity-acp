import { randomUUID } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { InternalAntigravityProfile } from '../runtime/profile.js';
import type { RuntimeConfig } from '../shared/config.js';
import type {
  AcpClientHandle,
  AcpSessionSetup,
  AcpTurnCallbacks,
  AcpWorkerLease,
  AcquireWorkerOptions,
  AntigravityExecutable,
} from '../shared/contracts.js';
import { AntigravityAcpError } from '../shared/errors.js';
import { spawnAcpClient, type SpawnAcpClientOptions } from './client.js';

const DEFAULT_MAX_QUEUE_SIZE = 64;

/** Dependencies and options used to construct {@link AcpWorkerPool}. */
export interface AcpWorkerPoolOptions {
  readonly subprocess: SubprocessRuntime;
  readonly config: RuntimeConfig;
  readonly resolveExecutable: (signal?: AbortSignal) => Promise<AntigravityExecutable>;
  readonly prepareProfile: (options?: {
    readonly suppressBrowser?: boolean;
    readonly signal?: AbortSignal;
  }) => Promise<InternalAntigravityProfile>;
  readonly spawnClientFn?: (options: SpawnAcpClientOptions) => Promise<AcpClientHandle>;
  readonly skipVersionCheck?: boolean;
  readonly maxQueueSize?: number;
}

/** Options accepted by {@link AcpWorkerPool.spawnClient}. */
export interface SpawnIsolatedClientOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly callbacks?: AcpTurnCallbacks;
  readonly onAuthUrl?: (url: string) => void;
  readonly suppressBrowser?: boolean;
  readonly env?: Record<string, string>;
}

/** Snapshot of current pool utilization. */
export interface AcpPoolStats {
  readonly activeLeases: number;
  readonly idleWorkers: number;
  readonly queuedWaiters: number;
  readonly maxConcurrentSessions: number;
}

export type ManagedAcpWorkerLease = AcpWorkerLease & {
  [Symbol.asyncDispose](): Promise<void>;
};

interface PoolWorker {
  readonly id: string;
  readonly client: AcpClientHandle;
  readonly rawClient: AcpClientHandle;
  readonly cwd: string;
  readonly suppressBrowser: boolean;
  readonly createdAt: number;
  sessionKey?: string;
  sessionId?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
}

interface QueuedWaiter {
  readonly options: AcquireWorkerOptions;
  readonly suppressBrowser: boolean;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  cleanupAbort?: () => void;
  resolve: (lease: ManagedAcpWorkerLease) => void;
  reject: (error: Error) => void;
}

function mergeAuthCallbacks(
  callbacks: AcpTurnCallbacks | undefined,
  onAuthUrl: ((url: string) => void) | undefined,
): AcpTurnCallbacks | undefined {
  if (!onAuthUrl) {
    return callbacks;
  }
  if (!callbacks) {
    return { onAuthUrl };
  }
  if (callbacks.onAuthUrl) {
    return callbacks;
  }
  return { ...callbacks, onAuthUrl };
}

function wrapPooledClient(rawClient: AcpClientHandle, worker: PoolWorker): AcpClientHandle {
  return {
    get id() {
      return rawClient.id;
    },
    get initialized() {
      return rawClient.initialized;
    },
    get executable() {
      return rawClient.executable;
    },
    get profile() {
      return rawClient.profile;
    },
    get closed() {
      return rawClient.closed;
    },
    get isClosed() {
      return rawClient.isClosed;
    },
    authenticate: (methodId, signal) => rawClient.authenticate(methodId, signal),
    logout: rawClient.logout ? (signal) => rawClient.logout!(signal) : undefined,
    setCallbacks: rawClient.setCallbacks ? (cbs) => rawClient.setCallbacks!(cbs) : undefined,
    async newSession(setup: AcpSessionSetup, signal?: AbortSignal): Promise<acp.NewSessionResponse> {
      const resp = await rawClient.newSession(setup, signal);
      worker.sessionId = resp.sessionId;
      return resp;
    },
    loadSession: rawClient.loadSession
      ? async (params: acp.LoadSessionRequest, signal?: AbortSignal) => {
          const resp = await rawClient.loadSession!(params, signal);
          worker.sessionId = params.sessionId;
          return resp;
        }
      : undefined,
    setSessionModel: rawClient.setSessionModel
      ? (sessionId, model, signal) => rawClient.setSessionModel!(sessionId, model, signal)
      : undefined,
    setSessionThoughtLevel: rawClient.setSessionThoughtLevel
      ? (sessionId, level, signal) => rawClient.setSessionThoughtLevel!(sessionId, level, signal)
      : undefined,
    setSessionMode: (sessionId, modeId, signal) => rawClient.setSessionMode(sessionId, modeId, signal),
    setSessionConfigOption: (sessionId, configId, value, signal) =>
      rawClient.setSessionConfigOption(sessionId, configId, value, signal),
    prompt: (params, callbacks, signal) => rawClient.prompt(params, callbacks, signal),
    cancel: (sessionId) => rawClient.cancel(sessionId),
    discoverModels: (cwd, signal) => rawClient.discoverModels(cwd, signal),
    close: (graceMs) => rawClient.close(graceMs),
  };
}

/**
 * Bounded concurrency pool managing warm ACP subprocess workers with session affinity,
 * FIFO queueing, idle recycling, and isolated one-shot spawning.
 */
export class AcpWorkerPool {
  private readonly options: AcpWorkerPoolOptions;
  private readonly spawnClientFn: (options: SpawnAcpClientOptions) => Promise<AcpClientHandle>;
  private readonly maxConcurrent: number;
  private readonly maxQueueSize: number;

  private readonly idleWorkers = new Map<string, PoolWorker>();
  private readonly activeWorkers = new Map<string, PoolWorker>();
  private readonly sessionAffinity = new Map<string, string>();
  private readonly unpooledClients = new Set<AcpClientHandle>();
  private readonly waitQueue: QueuedWaiter[] = [];

  private pendingSpawns = 0;
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(options: AcpWorkerPoolOptions) {
    this.options = options;
    this.spawnClientFn = options.spawnClientFn ?? spawnAcpClient;
    this.maxConcurrent = Math.max(1, Math.min(4, Math.floor(options.config.maxConcurrentSessions || 2)));
    this.maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE);
  }

  private get busyCount(): number {
    return this.activeWorkers.size + this.pendingSpawns;
  }

  private get totalWorkers(): number {
    return this.activeWorkers.size + this.pendingSpawns + this.idleWorkers.size;
  }

  private pruneClosedIdleWorkers(): void {
    for (const [id, worker] of this.idleWorkers) {
      if (worker.client.isClosed) {
        this.removeIdleWorker(worker);
      }
    }
  }

  private clearIdleTimer(worker: PoolWorker): void {
    if (worker.idleTimer !== undefined) {
      clearTimeout(worker.idleTimer);
      worker.idleTimer = undefined;
    }
  }

  private removeIdleWorker(worker: PoolWorker): void {
    this.clearIdleTimer(worker);
    this.idleWorkers.delete(worker.id);
    if (worker.sessionKey && this.sessionAffinity.get(worker.sessionKey) === worker.id) {
      this.sessionAffinity.delete(worker.sessionKey);
    }
  }

  private async destroyWorker(worker: PoolWorker): Promise<void> {
    this.clearIdleTimer(worker);
    this.idleWorkers.delete(worker.id);
    this.activeWorkers.delete(worker.id);
    if (worker.sessionKey && this.sessionAffinity.get(worker.sessionKey) === worker.id) {
      this.sessionAffinity.delete(worker.sessionKey);
    }
    try {
      await worker.rawClient.close();
    } catch {
      // Best-effort worker teardown.
    }
  }

  private scheduleIdleReaper(worker: PoolWorker): void {
    this.clearIdleTimer(worker);
    const recycleMs = this.options.config.idleRecycleMs;
    if (recycleMs <= 0 || this.disposed) {
      return;
    }
    const timer = setTimeout(() => {
      worker.idleTimer = undefined;
      if (!this.idleWorkers.has(worker.id) || this.activeWorkers.has(worker.id)) {
        return;
      }
      void this.destroyWorker(worker);
    }, recycleMs);
    timer.unref?.();
    worker.idleTimer = timer;
  }

  private selectIdleWorker(
    options: AcquireWorkerOptions,
    suppressBrowser: boolean,
  ): PoolWorker | undefined {
    this.pruneClosedIdleWorkers();
    const wantReuse = options.reuseSession !== false && options.setup?.reuseSession !== false;

    if (options.sessionKey) {
      const preferredId = this.sessionAffinity.get(options.sessionKey);
      if (preferredId) {
        const preferred = this.idleWorkers.get(preferredId);
        if (
          preferred &&
          !preferred.client.isClosed &&
          preferred.suppressBrowser === suppressBrowser &&
          preferred.cwd === options.cwd
        ) {
          this.removeIdleWorker(preferred);
          if (!wantReuse && preferred.sessionId) {
            void preferred.rawClient.close().catch(() => {});
            return undefined;
          }
          return preferred;
        }
      }
    }

    if (this.totalWorkers < this.maxConcurrent) {
      // Reuse only an unkeyed idle worker with matching cwd/browser so keyed sessions keep affinity.
      for (const worker of this.idleWorkers.values()) {
        if (
          !worker.sessionKey &&
          !worker.client.isClosed &&
          worker.suppressBrowser === suppressBrowser &&
          worker.cwd === options.cwd
        ) {
          this.removeIdleWorker(worker);
          return worker;
        }
      }
      return undefined;
    }

    // Pool is at total capacity; reuse a compatible idle worker or evict LRU to free a slot.
    for (const worker of this.idleWorkers.values()) {
      if (
        !worker.client.isClosed &&
        worker.suppressBrowser === suppressBrowser &&
        worker.cwd === options.cwd &&
        !options.sessionKey &&
        !worker.sessionKey
      ) {
        this.removeIdleWorker(worker);
        return worker;
      }
    }

    const oldest = this.idleWorkers.values().next().value;
    if (oldest) {
      this.removeIdleWorker(oldest);
      void oldest.rawClient.close().catch(() => {});
    }
    return undefined;
  }

  private async spawnPooledWorker(
    options: AcquireWorkerOptions,
    suppressBrowser: boolean,
  ): Promise<PoolWorker> {
    const [executable, profile] = await Promise.all([
      this.options.resolveExecutable(options.signal),
      this.options.prepareProfile({ suppressBrowser, signal: options.signal }),
    ]);

    if (this.disposed) {
      throw new AntigravityAcpError('ACP worker pool has been disposed', 'TRANSPORT');
    }

    const callbacks = mergeAuthCallbacks(options.callbacks, options.onAuthUrl);
    const rawClient = await this.spawnClientFn({
      subprocess: this.options.subprocess,
      executable,
      profile,
      config: this.options.config,
      cwd: options.cwd,
      callbacks,
      onAuthUrl: options.onAuthUrl,
      suppressBrowser,
      skipVersionCheck: this.options.skipVersionCheck,
      signal: options.signal,
    });

    const workerId = randomUUID();
    const worker: PoolWorker = {
      id: workerId,
      rawClient,
      client: undefined as unknown as AcpClientHandle,
      cwd: options.cwd,
      suppressBrowser,
      createdAt: Date.now(),
      sessionKey: options.sessionKey,
    };
    (worker as { client: AcpClientHandle }).client = wrapPooledClient(rawClient, worker);

    void rawClient.closed.then(() => {
      if (this.idleWorkers.get(worker.id) === worker) {
        this.removeIdleWorker(worker);
      }
      if (worker.sessionKey && this.sessionAffinity.get(worker.sessionKey) === worker.id) {
        this.sessionAffinity.delete(worker.sessionKey);
      }
    });

    return worker;
  }

  private createLease(worker: PoolWorker): ManagedAcpWorkerLease {
    let released = false;

    const release = async (releaseOptions?: { recycle?: boolean; reason?: string }): Promise<void> => {
      if (released) {
        return;
      }
      released = true;

      try {
        worker.rawClient.setCallbacks?.(undefined);
      } catch {
        // Ignore callback reset errors during teardown.
      }

      this.activeWorkers.delete(worker.id);

      const shouldRecycle =
        Boolean(releaseOptions?.recycle) || worker.rawClient.isClosed || this.disposed;

      if (shouldRecycle) {
        await this.destroyWorker(worker);
        this.drainWaitQueue();
        return;
      }

      if (worker.sessionKey) {
        this.sessionAffinity.set(worker.sessionKey, worker.id);
      }

      this.idleWorkers.set(worker.id, worker);
      if (this.waitQueue.length > 0) {
        this.drainWaitQueue();
        return;
      }

      this.scheduleIdleReaper(worker);
    };

    return {
      id: `${worker.id}:${randomUUID().slice(0, 8)}`,
      client: worker.client,
      sessionId: worker.sessionId,
      createdAt: worker.createdAt,
      release,
      [Symbol.asyncDispose]: () => release(),
    };
  }

  private async activateWorkerForOptions(
    worker: PoolWorker,
    options: AcquireWorkerOptions,
  ): Promise<ManagedAcpWorkerLease> {
    this.activeWorkers.set(worker.id, worker);
    try {
      const callbacks = mergeAuthCallbacks(options.callbacks, options.onAuthUrl);
      worker.rawClient.setCallbacks?.(callbacks);

      if (options.sessionKey) {
        worker.sessionKey = options.sessionKey;
        this.sessionAffinity.set(options.sessionKey, worker.id);
      } else {
        worker.sessionKey = undefined;
      }

      const wantReuse = options.reuseSession !== false && options.setup?.reuseSession !== false;
      if (!wantReuse) {
        worker.sessionId = undefined;
      }

      if (options.setup) {
        const shouldCreate = !wantReuse || !worker.sessionId;
        if (shouldCreate) {
          const resp = await worker.client.newSession(options.setup, options.signal);
          worker.sessionId = resp.sessionId;
        }
      }

      return this.createLease(worker);
    } catch (err) {
      await this.destroyWorker(worker);
      this.drainWaitQueue();
      throw err;
    }
  }

  private tryStartAcquire(
    options: AcquireWorkerOptions,
    suppressBrowser: boolean,
  ): Promise<ManagedAcpWorkerLease> | undefined {
    if (this.busyCount >= this.maxConcurrent) {
      return undefined;
    }

    const reused = this.selectIdleWorker(options, suppressBrowser);
    if (reused) {
      return this.activateWorkerForOptions(reused, options);
    }

    while (this.totalWorkers >= this.maxConcurrent && this.idleWorkers.size > 0) {
      const oldest = this.idleWorkers.values().next().value;
      if (!oldest) {
        break;
      }
      this.removeIdleWorker(oldest);
      void oldest.rawClient.close().catch(() => {});
    }

    this.pendingSpawns += 1;
    return (async () => {
      let worker: PoolWorker | undefined;
      try {
        worker = await this.spawnPooledWorker(options, suppressBrowser);
        if (this.disposed) {
          await this.destroyWorker(worker);
          throw new AntigravityAcpError('ACP worker pool has been disposed', 'TRANSPORT');
        }
        this.activeWorkers.set(worker.id, worker);
        this.pendingSpawns -= 1;
      } catch (err) {
        this.pendingSpawns -= 1;
        if (worker) {
          await this.destroyWorker(worker);
        }
        this.drainWaitQueue();
        throw err;
      }

      return await this.activateWorkerForOptions(worker, options);
    })();
  }

  private drainWaitQueue(): void {
    while (this.waitQueue.length > 0 && this.busyCount < this.maxConcurrent && !this.disposed) {
      const waiter = this.waitQueue.shift()!;
      if (waiter.settled) {
        continue;
      }
      waiter.settled = true;
      if (waiter.timer !== undefined) {
        clearTimeout(waiter.timer);
      }
      waiter.cleanupAbort?.();

      const leasePromise = this.tryStartAcquire(waiter.options, waiter.suppressBrowser);
      if (!leasePromise) {
        // Capacity filled concurrently; shouldn't happen since busyCount < maxConcurrent.
        waiter.settled = false;
        this.waitQueue.unshift(waiter);
        return;
      }
      leasePromise.then(waiter.resolve, waiter.reject);
    }
  }

  /**
   * Acquire an exclusive ACP worker lease, preferring warm workers with matching `sessionKey`
   * affinity and queueing FIFO up to 64 waiters when concurrency is saturated.
   */
  async acquireWorker(options: AcquireWorkerOptions): Promise<ManagedAcpWorkerLease> {
    if (this.disposed) {
      throw new AntigravityAcpError('ACP worker pool has been disposed', 'TRANSPORT');
    }
    if (options.signal?.aborted) {
      throw new AntigravityAcpError('Worker acquisition aborted', 'ABORTED');
    }

    const suppressBrowser = options.suppressBrowser ?? true;
    const immediate = this.tryStartAcquire(options, suppressBrowser);
    if (immediate) {
      return await immediate;
    }

    if (this.waitQueue.length >= this.maxQueueSize) {
      throw new AntigravityAcpError(
        `ACP worker pool queue limit reached (max ${this.maxQueueSize})`,
        'AGY_SESSION_LIMIT',
      );
    }

    return await new Promise<ManagedAcpWorkerLease>((resolve, reject) => {
      const waiter: QueuedWaiter = {
        options,
        suppressBrowser,
        settled: false,
        resolve,
        reject,
      };

      const removeFromQueue = (): void => {
        const idx = this.waitQueue.indexOf(waiter);
        if (idx !== -1) {
          this.waitQueue.splice(idx, 1);
        }
      };

      const failWaiter = (error: Error): void => {
        if (waiter.settled) {
          return;
        }
        waiter.settled = true;
        if (waiter.timer !== undefined) {
          clearTimeout(waiter.timer);
        }
        waiter.cleanupAbort?.();
        removeFromQueue();
        reject(error);
      };

      const queueTimeoutMs = this.options.config.queueTimeoutMs;
      waiter.timer = setTimeout(() => {
        failWaiter(
          new AntigravityAcpError(
            `Timed out waiting for ACP worker lease after ${queueTimeoutMs}ms`,
            'TIMEOUT',
          ),
        );
      }, queueTimeoutMs);

      if (options.signal) {
        const onAbort = (): void => {
          failWaiter(new AntigravityAcpError('Worker acquisition aborted', 'ABORTED'));
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanupAbort = () => {
          options.signal?.removeEventListener('abort', onAbort);
        };
      }

      this.waitQueue.push(waiter);
    });
  }

  /**
   * Spawn an unpooled, isolated one-shot ACP client (used by subagents and standalone CLI calls).
   */
  async spawnClient(options?: SpawnIsolatedClientOptions): Promise<AcpClientHandle> {
    if (this.disposed) {
      throw new AntigravityAcpError('ACP worker pool has been disposed', 'TRANSPORT');
    }
    if (options?.signal?.aborted) {
      throw new AntigravityAcpError('Aborted before spawning ACP client', 'ABORTED');
    }

    const suppressBrowser = options?.suppressBrowser ?? true;
    const [executable, profile] = await Promise.all([
      this.options.resolveExecutable(options?.signal),
      this.options.prepareProfile({ suppressBrowser, signal: options?.signal }),
    ]);

    if (this.disposed) {
      throw new AntigravityAcpError('ACP worker pool has been disposed', 'TRANSPORT');
    }

    const callbacks = mergeAuthCallbacks(options?.callbacks, options?.onAuthUrl);
    const client = await this.spawnClientFn({
      subprocess: this.options.subprocess,
      executable,
      profile,
      config: this.options.config,
      cwd: options?.cwd ?? process.cwd(),
      env: options?.env,
      callbacks,
      onAuthUrl: options?.onAuthUrl,
      suppressBrowser,
      skipVersionCheck: this.options.skipVersionCheck,
      signal: options?.signal,
    });

    if (this.disposed) {
      await client.close().catch(() => {});
      throw new AntigravityAcpError('ACP worker pool has been disposed', 'TRANSPORT');
    }

    this.unpooledClients.add(client);
    void client.closed.then(() => {
      this.unpooledClients.delete(client);
    });

    return client;
  }

  /** Return live pool lease, idle worker, and queue statistics. */
  getStats(): AcpPoolStats {
    this.pruneClosedIdleWorkers();
    return {
      activeLeases: this.activeWorkers.size,
      idleWorkers: this.idleWorkers.size,
      queuedWaiters: this.waitQueue.length,
      maxConcurrentSessions: this.maxConcurrent,
    };
  }

  /** Dispose the pool, rejecting all queued waiters and closing every managed client. */
  async dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }

    this.disposePromise = (async () => {
      this.disposed = true;

      for (const waiter of this.waitQueue.splice(0)) {
        if (waiter.settled) {
          continue;
        }
        waiter.settled = true;
        if (waiter.timer !== undefined) {
          clearTimeout(waiter.timer);
        }
        waiter.cleanupAbort?.();
        waiter.reject(new AntigravityAcpError('ACP worker pool disposed', 'ABORTED'));
      }

      const toClose: AcpClientHandle[] = [];
      for (const worker of this.idleWorkers.values()) {
        this.clearIdleTimer(worker);
        toClose.push(worker.rawClient);
      }
      for (const worker of this.activeWorkers.values()) {
        toClose.push(worker.rawClient);
      }
      for (const client of this.unpooledClients) {
        toClose.push(client);
      }

      this.idleWorkers.clear();
      this.activeWorkers.clear();
      this.sessionAffinity.clear();
      this.unpooledClients.clear();

      await Promise.allSettled(toClose.map((client) => client.close()));
    })();

    return this.disposePromise;
  }
}
