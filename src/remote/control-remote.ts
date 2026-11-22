import type { Context } from '@deepseek-ai/cordis';
import {
  RemoteError,
  TypertRemoteService,
  type InvocationDescriptor,
  type TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol';
import { validateAuthConfig, validateProxyUrl } from '../runtime/profile.js';
import type { AntigravityAuthMethod, RuntimeConfig } from '../shared/config.js';
import type {
  AntigravityAuthStartInput,
  AntigravityAuthSubmitCodeInput,
  AntigravityAuthTaskState,
  AntigravityControlModelSummary,
  AntigravityControlStatusSnapshot,
  AntigravityInstallInput,
  AntigravityInstallTaskState,
  AntigravityRuntimeService,
  AntigravitySaveConfigInput,
  DiscoveredModel,
  QuotaSnapshot,
  QuotaWindow,
} from '../shared/contracts.js';
import { AntigravityAcpError, redactSensitiveText } from '../shared/errors.js';
import { saveUiOverrides } from './ui-store.js';

export const ANTIGRAVITY_CONTROL_PACKAGE = 'dsh-antigravity-acp';
export const ANTIGRAVITY_CONTROL_SERVICE_KEY = 'antigravityControl';
export const ANTIGRAVITY_CONTROL_NAMESPACE = 'antigravityControl';

const ACCOUNTS_GOOGLE_URL_GLOBAL_RE = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/gi;

const VALID_AUTH_METHODS = new Set<AntigravityAuthMethod>([
  'oauth-personal',
  'oauth-business',
  'gemini-api-key',
  'agent-platform',
]);

const VALID_AUTH_MODES = new Set<'code' | 'loopback'>(['code', 'loopback']);

/** Optional logger interface accepted by {@link AntigravityControlService}. */
export interface AntigravityControlLogger {
  debug?(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

/** Injectable options for {@link AntigravityControlService} and {@link registerAntigravityControlRemote}. */
export interface AntigravityControlOptions {
  readonly logger?: AntigravityControlLogger;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly profileDir?: string;
}

interface DeferredCodePrompt {
  settled: boolean;
  readonly resolve: (code: string) => void;
  readonly reject: (error: Error) => void;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function badRequest(message: string): RemoteError<'gateway/bad-request'> {
  return new RemoteError('gateway/bad-request', message, {});
}

/**
 * Recursively omit `undefined` properties and non-finite numbers so returned payloads satisfy
 * `dsh-api-gateway`'s strict `assertJsonValue` wire invariant.
 */
export function stripUndefinedJson<T>(value: T): T {
  const visit = (current: unknown): unknown => {
    if (current === undefined) {
      return undefined;
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        return undefined;
      }
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    if (Array.isArray(current)) {
      const items: unknown[] = [];
      for (const entry of current) {
        const cleaned = visit(entry);
        if (cleaned !== undefined) {
          items.push(cleaned);
        }
      }
      return items;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
      const cleaned = visit(entry);
      if (cleaned !== undefined) {
        out[key] = cleaned;
      }
    }
    return out;
  };

  return visit(value) as T;
}

/**
 * Sanitize diagnostic text before surfacing it over RPC by scrubbing credentials,
 * proxy userinfo, Google OAuth URLs, and any known active secret literals.
 */
export function sanitizeControlError(
  error: unknown,
  extraSecrets: readonly (string | undefined)[] = [],
): string {
  let raw =
    error instanceof Error
      ? error.message || error.name || 'Unknown error'
      : typeof error === 'string'
        ? error
        : String(error ?? 'Unknown error');

  for (const secret of extraSecrets) {
    if (secret && secret.length >= 4) {
      raw = raw.split(secret).join('[REDACTED]');
    }
  }

  const redacted = redactSensitiveText(raw)
    .replace(ACCOUNTS_GOOGLE_URL_GLOBAL_RE, '[REDACTED_AUTH_URL]')
    .trim();

  return redacted || 'Unknown error';
}

function assertOptionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(record, field) || record[field] === undefined) {
    return undefined;
  }
  const value = record[field];
  if (typeof value !== 'string') {
    throw badRequest(`Field "${field}" must be a string`);
  }
  return value;
}

function assertOptionalBoolean(
  record: Record<string, unknown>,
  field: string,
): boolean | undefined {
  if (!Object.hasOwn(record, field) || record[field] === undefined) {
    return undefined;
  }
  const value = record[field];
  if (typeof value !== 'boolean') {
    throw badRequest(`Field "${field}" must be a boolean`);
  }
  return value;
}

function parseInstallInput(value: unknown): AntigravityInstallInput | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    throw badRequest('install input must be a plain object');
  }
  const clearBinaryPath = assertOptionalBoolean(value, 'clearBinaryPath');
  return clearBinaryPath !== undefined ? { clearBinaryPath } : {};
}

function parseSaveConfigInput(value: unknown): AntigravitySaveConfigInput {
  if (!isPlainRecord(value)) {
    throw badRequest('saveConfig input must be a plain object');
  }

  const binaryPath = assertOptionalString(value, 'binaryPath');
  const autoDownload = assertOptionalBoolean(value, 'autoDownload');
  const gcpProject = assertOptionalString(value, 'gcpProject');
  const gcpLocation = assertOptionalString(value, 'gcpLocation');
  const proxyUrl = assertOptionalString(value, 'proxyUrl');
  const proxyBypass = assertOptionalString(value, 'proxyBypass');
  const apiKey = assertOptionalString(value, 'apiKey');
  const clearApiKey = assertOptionalBoolean(value, 'clearApiKey');

  let authMethod: AntigravityAuthMethod | undefined;
  if (Object.hasOwn(value, 'authMethod') && value['authMethod'] !== undefined) {
    const rawMethod = value['authMethod'];
    if (
      typeof rawMethod !== 'string' ||
      !VALID_AUTH_METHODS.has(rawMethod as AntigravityAuthMethod)
    ) {
      throw badRequest(
        'authMethod must be one of oauth-personal, oauth-business, gemini-api-key, agent-platform',
      );
    }
    authMethod = rawMethod as AntigravityAuthMethod;
  }

  if (proxyUrl !== undefined && proxyUrl.trim() !== '') {
    try {
      validateProxyUrl(proxyUrl.trim());
    } catch (error: unknown) {
      throw badRequest(sanitizeControlError(error));
    }
  }

  return stripUndefinedJson<AntigravitySaveConfigInput>({
    ...(binaryPath !== undefined ? { binaryPath } : {}),
    ...(autoDownload !== undefined ? { autoDownload } : {}),
    ...(authMethod !== undefined ? { authMethod } : {}),
    ...(gcpProject !== undefined ? { gcpProject } : {}),
    ...(gcpLocation !== undefined ? { gcpLocation } : {}),
    ...(proxyUrl !== undefined ? { proxyUrl } : {}),
    ...(proxyBypass !== undefined ? { proxyBypass } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(clearApiKey !== undefined ? { clearApiKey } : {}),
  });
}

function parseAuthStartInput(value: unknown): AntigravityAuthStartInput | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    throw badRequest('authStart input must be a plain object');
  }

  let mode: 'code' | 'loopback' | undefined;
  if (Object.hasOwn(value, 'mode') && value['mode'] !== undefined) {
    const rawMode = value['mode'];
    if (typeof rawMode !== 'string' || !VALID_AUTH_MODES.has(rawMode as 'code' | 'loopback')) {
      throw badRequest('mode must be "code" or "loopback"');
    }
    mode = rawMode as 'code' | 'loopback';
  }

  let authMethod: AntigravityAuthMethod | undefined;
  if (Object.hasOwn(value, 'authMethod') && value['authMethod'] !== undefined) {
    const rawMethod = value['authMethod'];
    if (
      typeof rawMethod !== 'string' ||
      !VALID_AUTH_METHODS.has(rawMethod as AntigravityAuthMethod)
    ) {
      throw badRequest(
        'authMethod must be one of oauth-personal, oauth-business, gemini-api-key, agent-platform',
      );
    }
    authMethod = rawMethod as AntigravityAuthMethod;
  }

  const apiKey = assertOptionalString(value, 'apiKey');
  const gcpProject = assertOptionalString(value, 'gcpProject');
  const gcpLocation = assertOptionalString(value, 'gcpLocation');

  return stripUndefinedJson<AntigravityAuthStartInput>({
    ...(mode !== undefined ? { mode } : {}),
    ...(authMethod !== undefined ? { authMethod } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(gcpProject !== undefined ? { gcpProject } : {}),
    ...(gcpLocation !== undefined ? { gcpLocation } : {}),
  });
}

function parseAuthSubmitCodeInput(value: unknown): AntigravityAuthSubmitCodeInput {
  if (!isPlainRecord(value)) {
    throw badRequest('authSubmitCode input must be a plain object');
  }
  const code = assertOptionalString(value, 'code');
  if (!code || code.trim().length === 0) {
    throw badRequest('Authorization code must be a non-empty string');
  }
  return { code: code.trim() };
}

function parseStatusResult(value: unknown): AntigravityControlStatusSnapshot {
  if (!isPlainRecord(value)) {
    throw badRequest('Control status snapshot must be a plain object');
  }
  return value as unknown as AntigravityControlStatusSnapshot;
}

const CONTROL_STATUS_RESULT_CODEC: TypertCodec<AntigravityControlStatusSnapshot> = {
  mode: 'strict',
  typeSymbol: 'dsh-antigravity-acp#ControlStatus',
  create: () => ({
    parse: parseStatusResult,
  }),
};

function makeInputCodec<T>(
  typeSymbol: string,
  parser: (value: unknown) => T,
): TypertCodec<T> {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({
      parse: parser,
    }),
  };
}

function makeDirectDescriptor(
  method: string,
  inputCodec?: TypertCodec,
): InvocationDescriptor {
  return {
    id: `${ANTIGRAVITY_CONTROL_PACKAGE}#${ANTIGRAVITY_CONTROL_NAMESPACE}/${method}`,
    service: ANTIGRAVITY_CONTROL_SERVICE_KEY,
    namespace: ANTIGRAVITY_CONTROL_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: inputCodec
      ? [
          {
            name: 'input',
            wire: 'input',
            source: 'json',
            acceptsUndefined: true,
            codec: inputCodec,
          },
        ]
      : [],
    result: CONTROL_STATUS_RESULT_CODEC,
  };
}

/** Strict Typert invocation descriptors matching the browser UI client verbatim. */
export const ANTIGRAVITY_CONTROL_INVOCATIONS: readonly InvocationDescriptor[] = [
  makeDirectDescriptor('status'),
  makeDirectDescriptor(
    'install',
    makeInputCodec('dsh-antigravity-acp#ControlInstallInput', parseInstallInput),
  ),
  makeDirectDescriptor('installCancel'),
  makeDirectDescriptor(
    'saveConfig',
    makeInputCodec('dsh-antigravity-acp#ControlSaveConfigInput', parseSaveConfigInput),
  ),
  makeDirectDescriptor(
    'authStart',
    makeInputCodec('dsh-antigravity-acp#ControlAuthStartInput', parseAuthStartInput),
  ),
  makeDirectDescriptor(
    'authSubmitCode',
    makeInputCodec('dsh-antigravity-acp#ControlAuthSubmitCodeInput', parseAuthSubmitCodeInput),
  ),
  makeDirectDescriptor('authCancel'),
  makeDirectDescriptor('logout'),
  makeDirectDescriptor('refreshModels'),
  makeDirectDescriptor('refreshQuota'),
];

function mapDiscoveredModels(
  models: readonly DiscoveredModel[],
): AntigravityControlModelSummary[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    ...(model.description !== undefined ? { description: model.description } : {}),
    ...(model.isDefault !== undefined ? { isDefault: model.isDefault } : {}),
    ...(model.defaultThoughtLevel !== undefined
      ? { defaultThoughtLevel: model.defaultThoughtLevel }
      : {}),
    ...(model.thinkingOptions !== undefined
      ? {
          thinkingOptions: model.thinkingOptions.map((opt) => ({
            id: opt.id,
            name: opt.name,
          })),
        }
      : {}),
  }));
}

function mapQuotaWindow(window: QuotaWindow): QuotaWindow {
  return {
    id: window.id,
    ...(window.label !== undefined ? { label: window.label } : {}),
    ...(window.remainingFraction !== undefined
      ? { remainingFraction: window.remainingFraction }
      : {}),
    ...(window.usedFraction !== undefined ? { usedFraction: window.usedFraction } : {}),
    ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
    ...(window.resetInSeconds !== undefined ? { resetInSeconds: window.resetInSeconds } : {}),
    ...(window.limit !== undefined ? { limit: window.limit } : {}),
    ...(window.remaining !== undefined ? { remaining: window.remaining } : {}),
    ...(window.unit !== undefined ? { unit: window.unit } : {}),
  };
}

function mapQuotaForControl(
  quota: QuotaSnapshot,
): NonNullable<AntigravityControlStatusSnapshot['quota']> {
  return {
    capturedAt: quota.capturedAt,
    ...(quota.account !== undefined ? { account: quota.account } : {}),
    ...(quota.tier !== undefined ? { tier: quota.tier } : {}),
    exhausted: quota.exhausted,
    windows: quota.windows.map(mapQuotaWindow),
  };
}

function buildRuntimeConfigPatchFromSaveInput(
  input: AntigravitySaveConfigInput,
): Partial<RuntimeConfig> {
  const patch: Partial<RuntimeConfig> = {};

  if (input.binaryPath !== undefined) {
    patch.binaryPath = input.binaryPath.trim() || undefined;
  }
  if (input.autoDownload !== undefined) {
    patch.autoDownload = input.autoDownload;
  }
  if (input.authMethod !== undefined) {
    patch.authMethod = input.authMethod;
  }
  if (input.gcpProject !== undefined) {
    patch.gcpProject = input.gcpProject.trim() || undefined;
  }
  if (input.gcpLocation !== undefined) {
    patch.gcpLocation = input.gcpLocation.trim() || undefined;
  }
  if (input.proxyUrl !== undefined) {
    patch.proxyUrl = input.proxyUrl.trim() || undefined;
  }
  if (input.proxyBypass !== undefined) {
    patch.proxyBypass = input.proxyBypass.trim() || undefined;
  }
  if (input.clearApiKey === true) {
    patch.apiKey = undefined;
  } else if (input.apiKey !== undefined && input.apiKey.trim() !== '') {
    patch.apiKey = input.apiKey.trim();
  }

  return patch;
}

/**
 * Cordis Typert Remote service exposing Antigravity runtime control, installation,
 * OAuth/API-key authentication, model discovery, and quota probing to the DSH UI.
 *
 * NOTE: Uses TypeScript `private` fields only (never ES `#private`), because Cordis
 * wraps service instances in `Proxy` objects when resolving `ctx.get('antigravityControl')`.
 */
export class AntigravityControlService extends TypertRemoteService {
  private readonly runtime: AntigravityRuntimeService;
  private readonly logger?: AntigravityControlLogger;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly platform: NodeJS.Platform;
  private readonly profileDirOverride?: string;

  private installState: AntigravityInstallTaskState = {
    phase: 'idle',
    message: '',
  };
  private installAbort: AbortController | null = null;

  private authState: AntigravityAuthTaskState = {
    phase: 'idle',
    message: '',
  };
  private authAbort: AbortController | null = null;
  private pendingCodeDeferred: DeferredCodePrompt | null = null;

  private models: AntigravityControlModelSummary[] = [];
  private modelsError: string | undefined = undefined;
  private lastQuota: QuotaSnapshot | undefined = undefined;
  private quotaError: string | undefined = undefined;
  private disposed = false;

  constructor(
    ctx: Context,
    runtime: AntigravityRuntimeService,
    options: AntigravityControlOptions = {},
  ) {
    super(ctx, ANTIGRAVITY_CONTROL_SERVICE_KEY);
    this.runtime = runtime;
    this.logger = options.logger;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.profileDirOverride = options.profileDir;
  }

  private resolveProfileDir(): string {
    return this.profileDirOverride ?? this.runtime.resolveProfile().profileDir;
  }

  private activeSecrets(extra?: string): string[] {
    const secrets: string[] = [];
    if (this.runtime.config.apiKey) {
      secrets.push(this.runtime.config.apiKey);
    }
    if (extra && extra.trim()) {
      secrets.push(extra.trim());
    }
    return secrets;
  }

  private buildAuthSnapshot(): AntigravityAuthTaskState {
    const includeAuthUrl =
      this.authState.phase === 'awaiting_code' || this.authState.phase === 'awaiting_browser';
    return {
      phase: this.authState.phase,
      ...(this.authState.mode !== undefined ? { mode: this.authState.mode } : {}),
      ...(includeAuthUrl && this.authState.authUrl !== undefined
        ? { authUrl: this.authState.authUrl }
        : {}),
      message: this.authState.message,
      ...(this.authState.startedAt !== undefined ? { startedAt: this.authState.startedAt } : {}),
      ...(this.authState.finishedAt !== undefined
        ? { finishedAt: this.authState.finishedAt }
        : {}),
      ...(this.authState.error !== undefined ? { error: this.authState.error } : {}),
    };
  }

  private cancelActiveAuthInternal(
    reasonMessage: string,
    nextPhase: 'cancelled' | 'idle',
  ): void {
    const abort = this.authAbort;
    const deferred = this.pendingCodeDeferred;
    const previousMode = this.authState.mode;
    const previousStartedAt = this.authState.startedAt;

    this.authAbort = null;
    this.pendingCodeDeferred = null;

    if (nextPhase === 'idle') {
      this.authState = {
        phase: 'idle',
        message: '',
      };
    } else {
      this.authState = {
        phase: 'cancelled',
        ...(previousMode !== undefined ? { mode: previousMode } : {}),
        message: reasonMessage,
        ...(previousStartedAt !== undefined ? { startedAt: previousStartedAt } : {}),
        finishedAt: new Date().toISOString(),
      };
    }

    deferred?.reject(new AntigravityAcpError(reasonMessage, 'ABORTED'));
    abort?.abort(new AntigravityAcpError(reasonMessage, 'ABORTED'));
  }

  async status(): Promise<AntigravityControlStatusSnapshot> {
    const snap = await this.runtime.getStatus();
    const cfg = this.runtime.config;
    const effectiveQuota = snap.lastQuota ?? this.lastQuota;

    const snapshot: AntigravityControlStatusSnapshot = {
      installed: snap.installed,
      ...(snap.executable
        ? {
            executable: {
              command: snap.executable.command,
              source: snap.executable.source,
              ...(snap.executable.version !== undefined
                ? { version: snap.executable.version }
                : {}),
              ...(snap.executable.cacheDir !== undefined
                ? { cacheDir: snap.executable.cacheDir }
                : {}),
            },
          }
        : {}),
      profile: {
        profileDir: snap.profile.profileDir,
        authMethod: snap.profile.authMethod,
        authenticated: snap.profile.authenticated,
        ...(snap.profile.account !== undefined ? { account: snap.profile.account } : {}),
        ...(snap.profile.gcpProject !== undefined
          ? { gcpProject: snap.profile.gcpProject }
          : {}),
        ...(snap.profile.gcpLocation !== undefined
          ? { gcpLocation: snap.profile.gcpLocation }
          : {}),
        hasApiKey: snap.profile.hasApiKey,
      },
      config: {
        binaryPath: cfg.binaryPath ?? '',
        autoDownload: cfg.autoDownload,
        authMethod: cfg.authMethod,
        gcpProject: cfg.gcpProject ?? '',
        gcpLocation: cfg.gcpLocation ?? '',
        proxyUrl: cfg.proxyUrl ?? '',
        proxyBypass: cfg.proxyBypass ?? '',
        hasApiKey: snap.profile.hasApiKey,
      },
      pool: {
        activeLeases: snap.activeLeases,
        idleWorkers: snap.idleWorkers,
        maxConcurrentSessions: snap.maxConcurrentSessions,
      },
      install: {
        phase: this.installState.phase,
        message: this.installState.message,
        ...(this.installState.startedAt !== undefined
          ? { startedAt: this.installState.startedAt }
          : {}),
        ...(this.installState.finishedAt !== undefined
          ? { finishedAt: this.installState.finishedAt }
          : {}),
        ...(this.installState.error !== undefined ? { error: this.installState.error } : {}),
      },
      auth: this.buildAuthSnapshot(),
      models: this.models.map((m) => ({
        id: m.id,
        name: m.name,
        ...(m.description !== undefined ? { description: m.description } : {}),
        ...(m.isDefault !== undefined ? { isDefault: m.isDefault } : {}),
        ...(m.defaultThoughtLevel !== undefined
          ? { defaultThoughtLevel: m.defaultThoughtLevel }
          : {}),
        ...(m.thinkingOptions !== undefined
          ? {
              thinkingOptions: m.thinkingOptions.map((opt) => ({
                id: opt.id,
                name: opt.name,
              })),
            }
          : {}),
      })),
      ...(this.modelsError !== undefined ? { modelsError: this.modelsError } : {}),
      ...(effectiveQuota !== undefined ? { quota: mapQuotaForControl(effectiveQuota) } : {}),
      ...(this.quotaError !== undefined ? { quotaError: this.quotaError } : {}),
      updatedAt: new Date().toISOString(),
    };

    return stripUndefinedJson(snapshot);
  }

  async install(input?: AntigravityInstallInput): Promise<AntigravityControlStatusSnapshot> {
    const parsed = parseInstallInput(input);
    if (this.disposed) {
      throw badRequest('Antigravity control service has been disposed');
    }

    if (this.installAbort !== null) {
      return await this.status();
    }

    if (parsed?.clearBinaryPath === true && this.runtime.config.binaryPath) {
      await saveUiOverrides(this.resolveProfileDir(), { binaryPath: '' }, this.platform);
      await this.runtime.updateConfig?.({ binaryPath: undefined });
    }

    const abort = new AbortController();
    this.installAbort = abort;
    const startedAt = new Date().toISOString();
    this.installState = {
      phase: 'running',
      message: 'Starting Antigravity CLI installation...',
      startedAt,
    };

    const runInstall = async (): Promise<void> => {
      try {
        const onProgress = (message: string): void => {
          if (this.installAbort !== abort || abort.signal.aborted || this.disposed) {
            return;
          }
          this.installState = {
            phase: 'running',
            message: sanitizeControlError(message, this.activeSecrets()),
            startedAt,
          };
        };

        const exe = this.runtime.installManaged
          ? await this.runtime.installManaged({ signal: abort.signal, onProgress })
          : await this.runtime.ensureInstalled(abort.signal);

        if (this.installAbort !== abort || this.disposed) {
          return;
        }
        this.installState = {
          phase: 'succeeded',
          message: exe.version
            ? `Antigravity CLI ${exe.version} installed (${exe.command})`
            : `Antigravity CLI installed (${exe.command})`,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      } catch (error: unknown) {
        if (this.installAbort !== abort || this.disposed) {
          return;
        }
        const isAborted =
          abort.signal.aborted ||
          (error instanceof AntigravityAcpError && error.code === 'ABORTED');
        const safeErr = sanitizeControlError(error, this.activeSecrets());
        this.installState = {
          phase: isAborted ? 'cancelled' : 'failed',
          message: isAborted ? 'Installation cancelled' : safeErr,
          startedAt,
          finishedAt: new Date().toISOString(),
          ...(!isAborted ? { error: safeErr } : {}),
        };
      } finally {
        if (this.installAbort === abort) {
          this.installAbort = null;
        }
      }
    };

    const task = runInstall();
    // Allow fast synchronous/in-memory installs to report initial progress or finish cleanly without blocking slow downloads.
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20);
        timer.unref?.();
      }),
    ]);

    return await this.status();
  }

  async installCancel(): Promise<AntigravityControlStatusSnapshot> {
    if (this.installAbort !== null) {
      const abort = this.installAbort;
      const startedAt = this.installState.startedAt;
      this.installAbort = null;
      this.installState = {
        phase: 'cancelled',
        message: 'Installation cancelled',
        ...(startedAt !== undefined ? { startedAt } : {}),
        finishedAt: new Date().toISOString(),
      };
      abort.abort(new AntigravityAcpError('Installation cancelled', 'ABORTED'));
    }
    return await this.status();
  }

  async saveConfig(input: AntigravitySaveConfigInput): Promise<AntigravityControlStatusSnapshot> {
    const parsed = parseSaveConfigInput(input);
    const previousMethod = this.runtime.config.authMethod;

    await saveUiOverrides(this.resolveProfileDir(), parsed, this.platform);
    const runtimePatch = buildRuntimeConfigPatchFromSaveInput(parsed);
    await this.runtime.updateConfig?.(runtimePatch);

    if (
      parsed.clearApiKey === true ||
      parsed.apiKey !== undefined ||
      (parsed.authMethod !== undefined && parsed.authMethod !== previousMethod)
    ) {
      this.modelsError = undefined;
      this.quotaError = undefined;
      if (parsed.authMethod !== undefined && parsed.authMethod !== previousMethod) {
        this.models = [];
        this.lastQuota = undefined;
      }
    } else {
      this.quotaError = undefined;
    }

    await this.runtime.checkAuth().catch((error: unknown) => {
      this.logger?.debug?.(
        `checkAuth after saveConfig failed: ${sanitizeControlError(error, this.activeSecrets())}`,
      );
    });

    return await this.status();
  }

  async authStart(input?: AntigravityAuthStartInput): Promise<AntigravityControlStatusSnapshot> {
    const parsed = parseAuthStartInput(input);
    if (this.disposed) {
      throw badRequest('Antigravity control service has been disposed');
    }

    if (this.authAbort !== null) {
      return await this.status();
    }

    const configSavePatch: AntigravitySaveConfigInput = {
      ...(parsed?.authMethod !== undefined ? { authMethod: parsed.authMethod } : {}),
      ...(parsed?.gcpProject !== undefined ? { gcpProject: parsed.gcpProject } : {}),
      ...(parsed?.gcpLocation !== undefined ? { gcpLocation: parsed.gcpLocation } : {}),
      ...(parsed?.apiKey !== undefined && parsed.apiKey.trim() !== ''
        ? { apiKey: parsed.apiKey.trim() }
        : {}),
    };

    const prospectiveConfig: RuntimeConfig = { ...this.runtime.config };
    if (configSavePatch.authMethod !== undefined) {
      prospectiveConfig.authMethod = configSavePatch.authMethod;
    }
    if (configSavePatch.gcpProject !== undefined) {
      const trimmed = configSavePatch.gcpProject.trim();
      if (trimmed) {
        prospectiveConfig.gcpProject = trimmed;
      } else {
        delete prospectiveConfig.gcpProject;
      }
    }
    if (configSavePatch.gcpLocation !== undefined) {
      const trimmed = configSavePatch.gcpLocation.trim();
      if (trimmed) {
        prospectiveConfig.gcpLocation = trimmed;
      } else {
        delete prospectiveConfig.gcpLocation;
      }
    }
    if (configSavePatch.apiKey !== undefined) {
      prospectiveConfig.apiKey = configSavePatch.apiKey;
    }

    const effectiveMethod = prospectiveConfig.authMethod;
    if (effectiveMethod === 'oauth-business' && !prospectiveConfig.gcpProject?.trim()) {
      throw badRequest('oauth-business authentication requires gcpProject');
    }

    try {
      validateAuthConfig(prospectiveConfig, this.env, this.platform);
    } catch (error: unknown) {
      throw badRequest(sanitizeControlError(error, this.activeSecrets(parsed?.apiKey)));
    }

    if (Object.keys(configSavePatch).length > 0) {
      await saveUiOverrides(this.resolveProfileDir(), configSavePatch, this.platform);
      const runtimePatch = buildRuntimeConfigPatchFromSaveInput(configSavePatch);
      await this.runtime.updateConfig?.(runtimePatch);
    }

    const startedAt = new Date().toISOString();

    if (effectiveMethod === 'gemini-api-key' || effectiveMethod === 'agent-platform') {
      this.authState = {
        phase: 'starting',
        message: 'Validating API key authentication...',
        startedAt,
      };
      try {
        await this.runtime.login({
          authMethod: effectiveMethod,
          ...(configSavePatch.apiKey !== undefined ? { apiKey: configSavePatch.apiKey } : {}),
        });
        this.authState = {
          phase: 'succeeded',
          message: `Authenticated with ${effectiveMethod}`,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
        this.modelsError = undefined;
        this.quotaError = undefined;
        if (!this.disposed) {
          void this.refreshModels().catch(() => {});
        }
      } catch (error: unknown) {
        const safeErr = sanitizeControlError(error, this.activeSecrets(parsed?.apiKey));
        this.authState = {
          phase: 'failed',
          message: safeErr,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: safeErr,
        };
      }
      return await this.status();
    }

    const requestedMode: 'code' | 'loopback' = parsed?.mode ?? 'code';
    const abort = new AbortController();
    this.authAbort = abort;

    let deferred: DeferredCodePrompt | null = null;
    let codePromise: Promise<string> | undefined;
    if (requestedMode === 'code') {
      let resolveCode!: (code: string) => void;
      let rejectCode!: (error: Error) => void;
      codePromise = new Promise<string>((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
      });
      codePromise.catch(() => {});
      deferred = {
        settled: false,
        resolve: (code: string) => {
          if (deferred && !deferred.settled) {
            deferred.settled = true;
            resolveCode(code);
          }
        },
        reject: (error: Error) => {
          if (deferred && !deferred.settled) {
            deferred.settled = true;
            rejectCode(error);
          }
        },
      };
      this.pendingCodeDeferred = deferred;
    }

    this.authState = {
      phase: 'starting',
      mode: requestedMode,
      message:
        requestedMode === 'code'
          ? 'Starting OAuth authorization code flow...'
          : 'Starting local loopback OAuth login...',
      startedAt,
    };

    let notifyFirstProgress!: () => void;
    const firstProgressPromise = new Promise<void>((resolve) => {
      notifyFirstProgress = resolve;
    });

    const runOAuth = async (): Promise<void> => {
      try {
        await this.runtime.login({
          authMethod: effectiveMethod,
          mode: requestedMode,
          onAuthUrl: (url, kind) => {
            if (this.authAbort !== abort || abort.signal.aborted || this.disposed) {
              return;
            }
            this.authState = {
              phase: kind === 'code' ? 'awaiting_code' : 'awaiting_browser',
              mode: kind,
              authUrl: url,
              message:
                kind === 'code'
                  ? 'Open the authorization link, complete sign-in, and submit the authorization code.'
                  : 'Complete sign-in in the browser window (or open the authorization link below).',
              startedAt,
            };
            notifyFirstProgress();
          },
          ...(requestedMode === 'code' && codePromise ? { readCode: () => codePromise! } : {}),
          signal: abort.signal,
        });

        if (this.pendingCodeDeferred === deferred) {
          this.pendingCodeDeferred = null;
        }
        if (this.authAbort !== abort || this.disposed) {
          return;
        }
        this.authAbort = null;
        this.authState = {
          phase: 'succeeded',
          mode: requestedMode,
          message: 'Authentication succeeded',
          startedAt,
          finishedAt: new Date().toISOString(),
        };
        this.modelsError = undefined;
        this.quotaError = undefined;
        if (!this.disposed) {
          void this.refreshModels().catch(() => {});
        }
      } catch (error: unknown) {
        if (this.pendingCodeDeferred === deferred) {
          this.pendingCodeDeferred = null;
        }
        if (this.authAbort !== abort || this.disposed) {
          return;
        }
        this.authAbort = null;
        const isAborted =
          abort.signal.aborted ||
          (error instanceof AntigravityAcpError && error.code === 'ABORTED');
        const safeErr = sanitizeControlError(error, this.activeSecrets(parsed?.apiKey));
        this.authState = {
          phase: isAborted ? 'cancelled' : 'failed',
          mode: requestedMode,
          message: isAborted ? 'Authentication cancelled' : safeErr,
          startedAt,
          finishedAt: new Date().toISOString(),
          ...(!isAborted ? { error: safeErr } : {}),
        };
      } finally {
        notifyFirstProgress();
      }
    };

    const loginTask = runOAuth();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      firstProgressPromise,
      loginTask,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 30);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    return await this.status();
  }

  async authSubmitCode(
    input: AntigravityAuthSubmitCodeInput,
  ): Promise<AntigravityControlStatusSnapshot> {
    const parsed = parseAuthSubmitCodeInput(input);
    const deferred = this.pendingCodeDeferred;
    if (!deferred || deferred.settled) {
      throw badRequest('No pending authorization code login is waiting for a code');
    }

    const startedAt = this.authState.startedAt;
    this.authState = {
      phase: 'exchanging',
      mode: 'code',
      message: 'Exchanging authorization code...',
      ...(startedAt !== undefined ? { startedAt } : {}),
    };
    this.pendingCodeDeferred = null;
    deferred.resolve(parsed.code);

    return await this.status();
  }

  async authCancel(): Promise<AntigravityControlStatusSnapshot> {
    if (this.authAbort !== null || this.pendingCodeDeferred !== null) {
      this.cancelActiveAuthInternal('Authentication cancelled', 'cancelled');
    }
    return await this.status();
  }

  async logout(): Promise<AntigravityControlStatusSnapshot> {
    if (this.authAbort !== null || this.pendingCodeDeferred !== null) {
      this.cancelActiveAuthInternal('Logged out', 'idle');
    } else {
      this.authState = {
        phase: 'idle',
        message: '',
      };
    }

    await this.runtime.logout();
    await saveUiOverrides(this.resolveProfileDir(), { clearApiKey: true }, this.platform);
    await this.runtime.updateConfig?.({ apiKey: undefined });

    this.models = [];
    this.modelsError = undefined;
    this.lastQuota = undefined;
    this.quotaError = undefined;

    return await this.status();
  }

  async refreshModels(): Promise<AntigravityControlStatusSnapshot> {
    try {
      const discovered = await this.runtime.listModels({ refresh: true });
      this.models = mapDiscoveredModels(discovered);
      this.modelsError = undefined;
    } catch (error: unknown) {
      this.modelsError = sanitizeControlError(error, this.activeSecrets());
    }
    return await this.status();
  }

  async refreshQuota(): Promise<AntigravityControlStatusSnapshot> {
    try {
      const quota = await this.runtime.getQuota();
      this.lastQuota = quota;
      this.quotaError = undefined;
    } catch (error: unknown) {
      this.quotaError = sanitizeControlError(error, this.activeSecrets());
    }
    return await this.status();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (this.installAbort !== null) {
      const installAbort = this.installAbort;
      this.installAbort = null;
      installAbort.abort(new AntigravityAcpError('Control service disposed', 'ABORTED'));
    }

    if (this.authAbort !== null || this.pendingCodeDeferred !== null) {
      this.cancelActiveAuthInternal('Control service disposed', 'cancelled');
    }
  }
}

/** Structural contribution accepted by DSH `TypertRegistry.register(...)`. */
export interface TypertHostContribution {
  readonly package: string;
  readonly face: 'host' | 'client';
  readonly schemas: readonly [];
  readonly model: {
    readonly services: readonly [];
    readonly events: readonly [];
    readonly objects: readonly [];
  };
  readonly invocations: readonly InvocationDescriptor[];
}

interface TypertHostRegistryLike {
  register?(contribution: TypertHostContribution): (() => void | Promise<void>) | void;
}

/**
 * Instantiate {@link AntigravityControlService} and register strict Typert invocation descriptors
 * on `ctx.typert`, withdrawing both cleanly when the Cordis scope disposes.
 */
export function registerAntigravityControlRemote(
  ctx: Context,
  runtime: AntigravityRuntimeService,
  options: AntigravityControlOptions = {},
): AntigravityControlService {
  const service = new AntigravityControlService(ctx, runtime, options);

  const typert = ctx.get('typert') as TypertHostRegistryLike | undefined;
  const disposeTypert = typert?.register?.({
    package: ANTIGRAVITY_CONTROL_PACKAGE,
    face: 'host',
    schemas: [],
    model: {
      services: [],
      events: [],
      objects: [],
    },
    invocations: [...ANTIGRAVITY_CONTROL_INVOCATIONS],
  });

  ctx.effect(
    () => async () => {
      service.dispose();
      await disposeTypert?.();
    },
    'antigravityControl.lifecycle',
  );

  return service;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    antigravityControl: AntigravityControlService;
  }
}
