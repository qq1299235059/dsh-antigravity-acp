import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { InternalAntigravityProfile } from '../runtime/profile.js';
import type { RuntimeConfig } from '../shared/config.js';
import type { AcpClientHandle, AcpTurnCallbacks, AcpWorkerLease, AcquireWorkerOptions, AntigravityExecutable } from '../shared/contracts.js';
import { type SpawnAcpClientOptions } from './client.js';
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
/**
 * Bounded concurrency pool managing warm ACP subprocess workers with session affinity,
 * FIFO queueing, idle recycling, and isolated one-shot spawning.
 */
export declare class AcpWorkerPool {
    private readonly options;
    private readonly spawnClientFn;
    private readonly maxConcurrent;
    private readonly maxQueueSize;
    private readonly idleWorkers;
    private readonly activeWorkers;
    private readonly sessionAffinity;
    private readonly unpooledClients;
    private readonly waitQueue;
    private pendingSpawns;
    private disposed;
    private disposePromise?;
    constructor(options: AcpWorkerPoolOptions);
    private get busyCount();
    private get totalWorkers();
    private pruneClosedIdleWorkers;
    private clearIdleTimer;
    private removeIdleWorker;
    private destroyWorker;
    private scheduleIdleReaper;
    private selectIdleWorker;
    private spawnPooledWorker;
    private createLease;
    private activateWorkerForOptions;
    private tryStartAcquire;
    private drainWaitQueue;
    /**
     * Acquire an exclusive ACP worker lease, preferring warm workers with matching `sessionKey`
     * affinity and queueing FIFO up to 64 waiters when concurrency is saturated.
     */
    acquireWorker(options: AcquireWorkerOptions): Promise<ManagedAcpWorkerLease>;
    /**
     * Spawn an unpooled, isolated one-shot ACP client (used by subagents and standalone CLI calls).
     */
    spawnClient(options?: SpawnIsolatedClientOptions): Promise<AcpClientHandle>;
    /** Return live pool lease, idle worker, and queue statistics. */
    getStats(): AcpPoolStats;
    /** Dispose the pool, rejecting all queued waiters and closing every managed client. */
    dispose(): Promise<void>;
}
//# sourceMappingURL=pool.d.ts.map