import type { Context } from '@deepseek-ai/cordis';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { spawnAcpClient } from './acp/client.js';
import { AcpWorkerPool } from './acp/pool.js';
import {
  checkProfileAuth,
  clearProfileAuth,
  runCodeLogin,
  runLoopbackLogin,
} from './runtime/auth.js';
import {
  AntigravityInstaller,
  createAntigravityInstaller,
  type AntigravityInstallerOptions,
} from './runtime/installer.js';
import {
  prepareAntigravityProfile,
  resolveProfileSnapshot,
  validateAuthConfig,
  validateProxyUrl,
  type InternalAntigravityProfile,
} from './runtime/profile.js';
import { probeAntigravityQuota } from './runtime/quota.js';
import { RuntimeConfigSchema, type RuntimeConfig } from './shared/config.js';
import type {
  AcpClientHandle,
  AcpTurnCallbacks,
  AcpWorkerLease,
  AcquireWorkerOptions,
  AntigravityExecutable,
  AntigravityProfile,
  AntigravityRuntimeService,
  AntigravityStatusSnapshot,
  DiscoveredModel,
  QuotaSnapshot,
} from './shared/contracts.js';
import { AntigravityAcpError, redactSensitiveText } from './shared/errors.js';

export const name = 'antigravity-runtime';
export const inject = ['subprocess'];
export const Config = RuntimeConfigSchema;

/** Optional logger interface accepted by {@link createAntigravityRuntimeService}. */
export interface RuntimeServiceLogger {
  debug?(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

/** Injectable options for {@link createAntigravityRuntimeService}. */
export interface RuntimeServiceOptions {
  readonly logger?: RuntimeServiceLogger;
  readonly installerOptions?: AntigravityInstallerOptions;
  readonly skipVersionCheck?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly fetch?: typeof globalThis.fetch;
}

function isHeadlessEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): boolean {
  if (env['SSH_CONNECTION'] || env['SSH_TTY']) {
    return true;
  }
  if (platform === 'linux' && !env['DISPLAY'] && !env['WAYLAND_DISPLAY']) {
    return true;
  }
  return false;
}

function shouldFallbackToCodeLogin(error: unknown): boolean {
  if (error instanceof AntigravityAcpError) {
    const lower = error.message.toLowerCase();
    return (
      error.code === 'AGY_AUTH_REQUIRED' ||
      lower.includes('no browser') ||
      lower.includes('browser')
    );
  }
  if (error instanceof Error) {
    return error.message.toLowerCase().includes('no browser');
  }
  return false;
}

function raceWithAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new AntigravityAcpError('Operation aborted', 'ABORTED', { cause: signal.reason }));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new AntigravityAcpError('Operation aborted', 'ABORTED', { cause: signal.reason }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Create a standalone {@link AntigravityRuntimeService} backed by the given {@link SubprocessRuntime}.
 */
export function createAntigravityRuntimeService(
  subprocess: SubprocessRuntime,
  config: RuntimeConfig,
  options: RuntimeServiceOptions = {},
): AntigravityRuntimeService {
  const envInput = options.env ?? process.env;
  const homeDir = options.homeDir;
  const activePlatform = options.platform ?? process.platform;
  const installer = createAntigravityInstaller(config, {
    ...options.installerOptions,
    subprocess,
    env: options.installerOptions?.env ?? envInput,
    homeDir: options.installerOptions?.homeDir ?? homeDir,
    platform: options.installerOptions?.platform ?? activePlatform,
    fetch: options.installerOptions?.fetch ?? options.fetch,
  });

  const disposeController = new AbortController();
  let disposed = false;
  let cachedModels: readonly DiscoveredModel[] | undefined;
  let lastQuota: QuotaSnapshot | undefined;
  let inflightDiscovery: Promise<readonly DiscoveredModel[]> | undefined;

  const resolveExecutable = (signal?: AbortSignal): Promise<AntigravityExecutable> =>
    installer.resolveExecutable({
      signal,
      allowDownload: config.autoDownload,
    });

  const ensureInstalled = async (signal?: AbortSignal): Promise<AntigravityExecutable> => {
    try {
      return await installer.resolveExecutable({
        signal,
        allowDownload: false,
      });
    } catch (error: unknown) {
      if (
        error instanceof AntigravityAcpError &&
        error.code === 'AGY_NOT_INSTALLED' &&
        !config.binaryPath?.trim()
      ) {
        return installer.installManaged({ signal });
      }
      throw error;
    }
  };

  let prepareQueue: Promise<void> = Promise.resolve();
  const prepareProfile = (opts?: {
    readonly suppressBrowser?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<InternalAntigravityProfile> => {
    if (opts?.signal?.aborted) {
      return Promise.reject(
        new AntigravityAcpError('Profile preparation aborted', 'ABORTED', {
          cause: opts.signal.reason,
        }),
      );
    }
    const run = prepareQueue.then(() =>
      prepareAntigravityProfile(config, {
        env: envInput,
        homeDir,
        platform: activePlatform,
        suppressBrowser: opts?.suppressBrowser,
      }),
    );
    prepareQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return raceWithAbortSignal(run, opts?.signal);
  };

  const createPool = (): AcpWorkerPool =>
    new AcpWorkerPool({
      subprocess,
      config,
      resolveExecutable,
      prepareProfile,
      skipVersionCheck: options.skipVersionCheck,
    });

  let pool = createPool();

  const service: AntigravityRuntimeService = {
    config,
    resolveExecutable,
    ensureInstalled,

    resolveProfile(): AntigravityProfile {
      return resolveProfileSnapshot(config, envInput, homeDir, activePlatform);
    },

    async checkAuth(signal?: AbortSignal): Promise<AntigravityProfile> {
      if (signal?.aborted) {
        throw new AntigravityAcpError('Auth check aborted', 'ABORTED', { cause: signal.reason });
      }
      return checkProfileAuth(config, envInput, homeDir, activePlatform);
    },

    async login(loginOpts): Promise<AntigravityProfile> {
      if (disposed) {
        throw new AntigravityAcpError('Antigravity runtime has been disposed', 'ABORTED');
      }
      if (loginOpts?.signal?.aborted) {
        throw new AntigravityAcpError('Login aborted', 'ABORTED', {
          cause: loginOpts.signal.reason,
        });
      }

      const effectiveConfig: RuntimeConfig = {
        ...config,
        ...(loginOpts?.authMethod !== undefined ? { authMethod: loginOpts.authMethod } : {}),
        ...(loginOpts?.apiKey !== undefined ? { apiKey: loginOpts.apiKey } : {}),
      };
      validateAuthConfig(effectiveConfig, envInput, activePlatform);

      if (
        effectiveConfig.authMethod === 'gemini-api-key' ||
        effectiveConfig.authMethod === 'agent-platform'
      ) {
        const prepared = await prepareAntigravityProfile(effectiveConfig, {
          env: envInput,
          homeDir,
          platform: activePlatform,
          suppressBrowser: true,
        });
        if (!prepared.hasApiKey) {
          throw new AntigravityAcpError(
            `Missing API key for auth method "${effectiveConfig.authMethod}"`,
            'AGY_AUTH_REQUIRED',
          );
        }
        cachedModels = undefined;
        return resolveProfileSnapshot(effectiveConfig, envInput, homeDir, activePlatform);
      }

      const executable = await ensureInstalled(loginOpts?.signal);
      const requestedMode = loginOpts?.mode ?? 'auto';

      const invokeCodeLogin = async (): Promise<AntigravityProfile> => {
        if (!loginOpts?.readCode) {
          throw new AntigravityAcpError(
            'Code login requires a readCode callback to accept the authorization code',
            'INVALID_REQUEST',
          );
        }
        return runCodeLogin({
          config: effectiveConfig,
          executable,
          subprocess,
          onAuthUrl: (url) => loginOpts.onAuthUrl?.(url, 'code'),
          readCode: loginOpts.readCode,
          signal: loginOpts.signal,
          env: envInput,
          homeDir,
          platform: activePlatform,
        });
      };

      const invokeLoopbackLogin = async (): Promise<AntigravityProfile> =>
        runLoopbackLogin({
          config: effectiveConfig,
          connectClient: ({ profile, onAuthUrl, signal }) =>
            spawnAcpClient({
              subprocess,
              executable,
              profile,
              config: effectiveConfig,
              cwd: profile.profileDir,
              onAuthUrl,
              suppressBrowser: Boolean(loginOpts?.onAuthUrl),
              skipVersionCheck: options.skipVersionCheck,
              signal,
            }),
          onAuthUrl: loginOpts?.onAuthUrl
            ? (url) => loginOpts.onAuthUrl!(url, 'loopback')
            : undefined,
          suppressBrowser: Boolean(loginOpts?.onAuthUrl),
          signal: loginOpts?.signal,
          env: envInput,
          homeDir,
          platform: activePlatform,
        });

      let resultProfile: AntigravityProfile;
      if (requestedMode === 'code') {
        resultProfile = await invokeCodeLogin();
      } else if (requestedMode === 'loopback') {
        resultProfile = await invokeLoopbackLogin();
      } else if (isHeadlessEnvironment(envInput, activePlatform) && loginOpts?.readCode) {
        resultProfile = await invokeCodeLogin();
      } else {
        try {
          resultProfile = await invokeLoopbackLogin();
        } catch (error: unknown) {
          if (
            loginOpts?.readCode &&
            !loginOpts.signal?.aborted &&
            shouldFallbackToCodeLogin(error)
          ) {
            resultProfile = await invokeCodeLogin();
          } else {
            throw error;
          }
        }
      }

      cachedModels = undefined;
      return resultProfile;
    },

    async logout(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) {
        throw new AntigravityAcpError('Logout aborted', 'ABORTED', { cause: signal.reason });
      }
      cachedModels = undefined;
      lastQuota = undefined;

      const oldPool = pool;
      if (!disposed) {
        pool = createPool();
      }
      await oldPool.dispose();

      const snapshot = resolveProfileSnapshot(config, envInput, homeDir, activePlatform);
      await clearProfileAuth(snapshot);
    },

    async listModels(listOpts): Promise<readonly DiscoveredModel[]> {
      if (listOpts?.signal?.aborted) {
        throw new AntigravityAcpError('Model discovery aborted', 'ABORTED', {
          cause: listOpts.signal.reason,
        });
      }
      if (!listOpts?.refresh && cachedModels !== undefined && cachedModels.length > 0) {
        return cachedModels;
      }

      if (inflightDiscovery === undefined) {
        const cwd = listOpts?.cwd ?? process.cwd();
        const task = (async (): Promise<readonly DiscoveredModel[]> => {
          const lease = await pool.acquireWorker({
            cwd,
            reuseSession: false,
            signal: disposeController.signal,
          });
          try {
            const models = await lease.client.discoverModels(cwd, disposeController.signal);
            cachedModels = models;
            return models;
          } finally {
            await lease.release().catch(() => {});
          }
        })();
        inflightDiscovery = task.finally(() => {
          if (inflightDiscovery === task) {
            inflightDiscovery = undefined;
          }
        });
      }

      return raceWithAbortSignal(inflightDiscovery, listOpts?.signal);
    },

    async getQuota(signal?: AbortSignal): Promise<QuotaSnapshot> {
      const snapshot = await probeAntigravityQuota(config, {
        signal,
        env: envInput,
        homeDir,
        platform: activePlatform,
        fetch: options.fetch,
      });
      lastQuota = snapshot;
      return snapshot;
    },

    async getStatus(signal?: AbortSignal): Promise<AntigravityStatusSnapshot> {
      let executable: AntigravityExecutable | undefined;
      try {
        executable = await installer.resolveExecutable({
          signal,
          allowDownload: false,
        });
      } catch (error: unknown) {
        if (error instanceof AntigravityAcpError && error.code === 'ABORTED') {
          throw error;
        }
        executable = undefined;
      }

      const profile = resolveProfileSnapshot(config, envInput, homeDir, activePlatform);
      const stats = pool.getStats();

      return {
        installed: executable !== undefined,
        ...(executable !== undefined ? { executable } : {}),
        profile,
        activeLeases: stats.activeLeases,
        idleWorkers: stats.idleWorkers,
        maxConcurrentSessions: stats.maxConcurrentSessions,
        ...(lastQuota !== undefined ? { lastQuota } : {}),
      };
    },

    acquireWorker(acquireOpts: AcquireWorkerOptions): Promise<AcpWorkerLease> {
      return pool.acquireWorker(acquireOpts);
    },

    spawnClient(spawnOpts?: {
      readonly cwd?: string;
      readonly signal?: AbortSignal;
      readonly callbacks?: AcpTurnCallbacks;
      readonly onAuthUrl?: (url: string) => void;
      readonly suppressBrowser?: boolean;
    }): Promise<AcpClientHandle> {
      return pool.spawnClient(spawnOpts);
    },

    async warmup(signal?: AbortSignal): Promise<void> {
      if (config.proxyUrl?.trim()) {
        validateProxyUrl(config.proxyUrl);
      }
      await resolveExecutable(signal);
      await prepareProfile({ suppressBrowser: true, signal });
      const profile = resolveProfileSnapshot(config, envInput, homeDir, activePlatform);
      if (profile.authenticated) {
        await service.listModels({ refresh: true, signal });
      }
    },

    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      disposeController.abort();
      cachedModels = undefined;
      await pool.dispose();
    },
  };

  return service;
}

/**
 * Cordis plugin providing the shared `ctx.antigravityRuntime` service.
 * Named exports only (DSH Cordis loader requirement).
 */
export function apply(ctx: Context, config: RuntimeConfig): void {
  const logger = ctx.logger(name);
  const service = createAntigravityRuntimeService(ctx.subprocess, config, { logger });

  ctx.provide('antigravityRuntime', service);

  const warmupController = new AbortController();
  if (config.autoWarmup) {
    void service.warmup(warmupController.signal).catch((error: unknown) => {
      if (warmupController.signal.aborted) {
        return;
      }
      const message =
        error instanceof Error ? redactSensitiveText(error.message) : String(error);
      logger.warn(`antigravity autoWarmup failed: ${message}`);
    });
  }

  ctx.effect(
    () => async () => {
      warmupController.abort();
      await service.dispose();
    },
    `${name}.lifecycle`,
  );
}

// Re-export shared taxonomy, config schemas, contracts, and core helpers via named exports.
export {
  AntigravityAcpError,
  redactSensitiveText,
  toLlmError,
  type AntigravityAcpErrorOptions,
  type AntigravityBuiltinErrorCode,
  type AntigravityCustomErrorCode,
  type AntigravityErrorCode,
} from './shared/errors.js';

export {
  AuthMethodSchema,
  LlmPluginConfigSchema,
  PermissionFallbackSchema,
  PermissionModeSchema,
  RuntimeConfigSchema,
  SubagentPluginConfigSchema,
  type AntigravityAuthMethod,
  type AntigravityPermissionFallback,
  type AntigravityPermissionMode,
  type LlmPluginConfig,
  type LlmPluginConfigInput,
  type ModelOverrideConfig,
  type RuntimeConfig,
  type RuntimeConfigInput,
  type SubagentPluginConfig,
  type SubagentPluginConfigInput,
} from './shared/config.js';

export type {
  AcpClientHandle,
  AcpInitializeSummary,
  AcpPromptResult,
  AcpSessionSetup,
  AcpTurnCallbacks,
  AcpWorkerLease,
  AcquireWorkerOptions,
  AntigravityExecutable,
  AntigravityProfile,
  AntigravityRuntimeService,
  AntigravityStatusSnapshot,
  DiscoveredModel,
  QuotaSnapshot,
  QuotaWindow,
  ThinkingOption,
} from './shared/contracts.js';

export {
  ANTIGRAVITY_CLI_MANIFEST_BASE,
  MINIMUM_AGY_VERSION,
  antigravityCliTarget,
  compareSemver,
  parseAntigravityCliRelease,
  tryParseSemver,
  type AntigravityCliReleaseAsset,
  type ParsedSemver,
} from './runtime/release.js';

export {
  AntigravityInstaller,
  createAntigravityInstaller,
  type AntigravityInstallerOptions,
} from './runtime/installer.js';

export {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  buildAcpSpawnArgs,
  buildAntigravityEnvironment,
  prepareAntigravityProfile,
  removedEnvironmentKeys,
  resolveDefaultProfileDir,
  resolveProfilePaths,
  resolveProfileSnapshot,
  validateAuthConfig,
  validateLoginResponse,
  validateProxyUrl,
  parseAntigravityAuthorizationUrl,
  type InternalAntigravityProfile,
  type ParsedAntigravityAuthorizationUrl,
  type PrepareAntigravityProfileOptions,
  type ResolvedProfilePaths,
} from './runtime/profile.js';

export {
  checkProfileAuth,
  clearProfileAuth,
  runCodeLogin,
  runLoopbackLogin,
  type RunCodeLoginOptions,
  type RunLoopbackLoginOptions,
} from './runtime/auth.js';

export { probeAntigravityQuota, type ProbeAntigravityQuotaOptions } from './runtime/quota.js';

export { spawnAcpClient, type SpawnAcpClientOptions } from './acp/client.js';
export {
  AcpWorkerPool,
  type AcpPoolStats,
  type AcpWorkerPoolOptions,
  type SpawnIsolatedClientOptions,
} from './acp/pool.js';
export {
  antigravityAppendsSystemPrompt,
  antigravityClientInfo,
  antigravitySessionMeta,
  antigravitySessionMode,
  antigravityToolOutlivesPrompt,
  isMcpToolCallMeta,
  isSignInRequiredError,
  normalizeStopReasonToLlm,
  parseModelsAndThinking,
  selectPermissionOption,
} from './acp/protocol.js';
