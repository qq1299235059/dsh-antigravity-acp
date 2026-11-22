import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLIENT_JS_PATH = path.join(REPO_ROOT, 'src', 'client.js');

interface DescriptorSpec {
  id: string;
  service: string;
  namespace: string;
  method: string;
  invocation: { kind: string };
  parameters: Array<{
    name: string;
    wire: string;
    source: string;
    acceptsUndefined?: boolean;
    codec: { mode: string; typeSymbol: string; create: () => { parse: (v: unknown) => unknown } };
  }>;
  result: {
    mode: string;
    typeSymbol: string;
    create: () => { parse: (v: unknown) => unknown };
    decode?: (v: unknown) => unknown;
  };
}

interface ClientExports {
  inject: string[];
  apply: (ctx: unknown) => void;
  ANTIGRAVITY_CONTROL_DESCRIPTORS: DescriptorSpec[];
  AntigravitySettingsSection: (props: Record<string, unknown>) => VNode;
  AntigravitySectionIcon: (props: Record<string, unknown>) => VNode;
  default?: unknown;
}

interface VNode {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<VNode | string | number>;
}

function flattenChildren(raw: unknown[]): Array<VNode | string | number> {
  const result: Array<VNode | string | number> = [];
  for (const item of raw) {
    if (Array.isArray(item)) {
      result.push(...flattenChildren(item));
    } else if (item !== null && item !== undefined && typeof item !== 'boolean') {
      if (typeof item === 'string' || typeof item === 'number' || (typeof item === 'object' && 'type' in item)) {
        result.push(item as VNode | string | number);
      }
    }
  }
  return result;
}

function createReactTestHarness() {
  interface HookSlot {
    state?: unknown;
    ref?: { current: unknown };
    deps?: unknown[];
    cleanup?: (() => void) | void;
    effectFn?: () => (() => void) | void;
    pendingEffect?: boolean;
    callback?: unknown;
  }

  let currentHooks: HookSlot[] = [];
  let hookIndex = 0;
  let scheduleRender: (() => void) | null = null;

  function depsChanged(prev: unknown[] | undefined, next: unknown[] | undefined): boolean {
    if (prev === undefined || next === undefined) return true;
    if (prev.length !== next.length) return true;
    for (let i = 0; i < prev.length; i += 1) {
      if (!Object.is(prev[i], next[i])) return true;
    }
    return false;
  }

  const ReactStub = {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): VNode {
      return {
        type,
        props: props ? { ...props } : {},
        children: flattenChildren(children),
      };
    },
    useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
      const idx = hookIndex++;
      if (!currentHooks[idx]) {
        const value = typeof initial === 'function' ? (initial as () => T)() : initial;
        currentHooks[idx] = { state: value };
      }
      const slot = currentHooks[idx];
      const setState = (next: T | ((prev: T) => T)) => {
        const resolved = typeof next === 'function' ? (next as (prev: T) => T)(slot.state as T) : next;
        if (!Object.is(slot.state, resolved)) {
          slot.state = resolved;
          scheduleRender?.();
        }
      };
      return [slot.state as T, setState];
    },
    useRef<T>(initial: T): { current: T } {
      const idx = hookIndex++;
      if (!currentHooks[idx]) {
        currentHooks[idx] = { ref: { current: initial } };
      }
      return currentHooks[idx].ref as { current: T };
    },
    useEffect(fn: () => (() => void) | void, deps?: unknown[]): void {
      const idx = hookIndex++;
      const prev = currentHooks[idx];
      if (!prev) {
        currentHooks[idx] = { deps, effectFn: fn, pendingEffect: true };
      } else if (depsChanged(prev.deps, deps)) {
        prev.deps = deps;
        prev.effectFn = fn;
        prev.pendingEffect = true;
      }
    },
    useCallback<T extends (...args: never[]) => unknown>(fn: T, deps?: unknown[]): T {
      const idx = hookIndex++;
      const prev = currentHooks[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        currentHooks[idx] = { callback: fn, deps };
      }
      return currentHooks[idx].callback as T;
    },
  };

  function mount<P extends Record<string, unknown>>(Component: (props: P) => VNode, initialProps: P) {
    currentHooks = [];
    let props = initialProps;
    let tree: VNode | null = null;
    let mounted = true;
    let renderQueued = false;

    const flushEffects = () => {
      for (const slot of currentHooks) {
        if (slot && slot.pendingEffect && slot.effectFn) {
          slot.pendingEffect = false;
          if (typeof slot.cleanup === 'function') {
            slot.cleanup();
          }
          slot.cleanup = slot.effectFn();
        }
      }
    };

    const renderNow = () => {
      if (!mounted) return;
      renderQueued = false;
      hookIndex = 0;
      tree = Component(props);
      flushEffects();
    };

    scheduleRender = () => {
      if (!mounted || renderQueued) return;
      renderQueued = true;
      renderNow();
    };

    renderNow();

    return {
      getTree(): VNode {
        if (!tree) throw new Error('Component did not render a tree');
        return tree;
      },
      rerender(nextProps: P) {
        props = nextProps;
        renderNow();
      },
      unmount() {
        mounted = false;
        for (const slot of currentHooks) {
          if (slot && typeof slot.cleanup === 'function') {
            slot.cleanup();
            slot.cleanup = undefined;
          }
        }
      },
    };
  }

  return { ReactStub, mount };
}

function findAll(node: VNode | string | number, predicate: (n: VNode) => boolean): VNode[] {
  if (typeof node !== 'object' || node === null) return [];
  const matches: VNode[] = [];
  if (predicate(node)) matches.push(node);
  for (const child of node.children) {
    matches.push(...findAll(child, predicate));
  }
  return matches;
}

function findOne(node: VNode, predicate: (n: VNode) => boolean): VNode {
  const hits = findAll(node, predicate);
  if (hits.length === 0) {
    throw new Error(`Expected matching VNode but found none`);
  }
  return hits[0];
}

function findByAttr(node: VNode, attr: string, value: string): VNode {
  return findOne(node, (n) => n.props[attr] === value);
}

function textContent(node: VNode | string | number): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node.children.map((c) => textContent(c)).join('');
}

async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function loadClientModule(options: {
  reactStub: unknown;
  navigatorLanguage?: string;
  clipboardWriteText?: (text: string) => Promise<void>;
}) {
  const source = fs.readFileSync(CLIENT_JS_PATH, 'utf8');
  let capturedRegistration: { id: string; factory: (req: (id: string) => unknown) => ClientExports } | null = null;
  const requireCalls: string[] = [];

  const sandboxWindow: Record<string, unknown> = {
    __ModuleLoader__: {
      load(reg: { id: string; factory: (req: (id: string) => unknown) => ClientExports }) {
        capturedRegistration = reg;
      },
    },
  };

  const sandboxNavigator: Record<string, unknown> = {
    language: options.navigatorLanguage ?? 'en-US',
    ...(options.clipboardWriteText
      ? { clipboard: { writeText: options.clipboardWriteText } }
      : {}),
  };

  const context = vm.createContext({
    window: sandboxWindow,
    globalThis: undefined as unknown,
    navigator: sandboxNavigator,
    document: undefined,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    Promise,
    Error,
    Object,
    Array,
    Set,
    Map,
    JSON,
    Math,
    String,
    Boolean,
    Number,
    Symbol,
  });
  (context as { globalThis: unknown }).globalThis = context;

  vm.runInContext(source, context, { filename: CLIENT_JS_PATH });

  if (!capturedRegistration) {
    throw new Error('src/client.js did not invoke window.__ModuleLoader__.load');
  }
  const reg = capturedRegistration as {
    id: string;
    factory: (req: (id: string) => unknown) => ClientExports;
  };

  const exports = reg.factory((spec: string) => {
    requireCalls.push(spec);
    if (spec === 'react') return options.reactStub;
    throw new Error(`Unexpected require(${spec}) in pure browser client bundle`);
  });

  return {
    source,
    moduleId: reg.id,
    requireCalls,
    exports,
    setLanguage(lang: string) {
      sandboxNavigator.language = lang;
    },
  };
}

function createStatusFixture(overrides: Record<string, unknown> = {}) {
  return {
    installed: true,
    executable: {
      command: '/opt/antigravity/bin/agy',
      source: 'cached',
      version: '1.5.2',
      cacheDir: '/tmp/cache',
    },
    profile: {
      profileDir: '/tmp/agy-profile',
      authMethod: 'oauth-personal',
      authenticated: false,
      hasApiKey: false,
    },
    config: {
      binaryPath: '',
      autoDownload: true,
      authMethod: 'oauth-personal',
      gcpProject: '',
      gcpLocation: '',
      proxyUrl: '',
      proxyBypass: '',
      hasApiKey: false,
    },
    pool: {
      activeLeases: 0,
      idleWorkers: 1,
      maxConcurrentSessions: 2,
    },
    install: {
      phase: 'idle',
      message: '',
    },
    auth: {
      phase: 'idle',
      message: '',
    },
    models: [],
    updatedAt: '2026-11-22T01:00:00.000Z',
    ...overrides,
  };
}

describe('dsh-antigravity-acp pure browser client (src/client.js)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses __ModuleLoader__.load, requires ONLY react, exports strict inject=["slots","remote"], and contains no Node imports or JSX', () => {
    const { ReactStub } = createReactTestHarness();
    const loaded = loadClientModule({ reactStub: ReactStub });

    expect(loaded.moduleId).toBe('dsh-antigravity-acp');
    expect(loaded.requireCalls).toEqual(['react']);
    expect(loaded.source).not.toMatch(/node:/);
    expect(loaded.source).not.toMatch(/require\(\s*['"](?:fs|path|os|child_process|http|https|crypto)['"]\s*\)/);
    expect(loaded.source).not.toMatch(/react\/jsx-runtime/);

    expect(loaded.exports.inject).toEqual(['slots', 'remote']);
    expect(loaded.exports.inject).not.toContain('remote.antigravityControl');
    expect('default' in loaded.exports).toBe(false);
    expect(typeof loaded.exports.apply).toBe('function');
  });

  it('mounts all 10 strict RPC descriptors, registers settings.section & icon slots, and disposes cleanly', async () => {
    const { ReactStub } = createReactTestHarness();
    const { exports } = loadClientModule({ reactStub: ReactStub });

    const mountCalls: Array<{ package: string; descriptors: DescriptorSpec[] }> = [];
    const mountDispose = vi.fn(async () => {});
    const slotDisposeFns: Array<ReturnType<typeof vi.fn>> = [];
    const slotRegistrations: Array<{ options: Record<string, unknown>; component: unknown }> = [];
    const effectCleanups: Array<() => void> = [];

    const mockStatus = createStatusFixture();
    const recordedRpc: Array<{ method: string; args: unknown[] }> = [];
    const remoteService = {
      status: (...args: unknown[]) => {
        recordedRpc.push({ method: 'status', args });
        return Promise.resolve({ ok: true, value: mockStatus });
      },
      install: (...args: unknown[]) => {
        recordedRpc.push({ method: 'install', args });
        return Promise.resolve({ ok: true, value: mockStatus });
      },
    };

    const ctx = {
      get: (key: string) => (key === 'remote.antigravityControl' ? remoteService : undefined),
      remote: {
        $mount(contribution: { package: string; descriptors: DescriptorSpec[] }) {
          mountCalls.push(contribution);
          return Promise.resolve(mountDispose);
        },
        antigravityControl: remoteService,
      },
      slots: {
        inject(_slotName: string, factory: () => () => void) {
          const dispose = factory();
          return dispose;
        },
        register(options: Record<string, unknown>, component: unknown) {
          slotRegistrations.push({ options, component });
          const dispose = vi.fn();
          slotDisposeFns.push(dispose);
          return dispose;
        },
      },
      effect(fn: () => () => void) {
        effectCleanups.push(fn());
      },
    };

    exports.apply(ctx);

    expect(mountCalls).toHaveLength(1);
    expect(mountCalls[0].package).toBe('dsh-antigravity-acp');
    expect(mountCalls[0].descriptors).toHaveLength(10);

    const zeroArg = ['status', 'installCancel', 'authCancel', 'logout', 'refreshModels', 'refreshQuota'];
    const oneArg = ['install', 'saveConfig', 'authStart', 'authSubmitCode'];
    for (const desc of mountCalls[0].descriptors) {
      expect(desc.id).toBe(`dsh-antigravity-acp#antigravityControl/${desc.method}`);
      expect(desc.service).toBe('antigravityControl');
      expect(desc.namespace).toBe('antigravityControl');
      expect(desc.invocation).toEqual({ kind: 'direct' });
      expect(desc.result.mode).toBe('strict');
      expect(desc.result.typeSymbol).toBe('dsh-antigravity-acp#ControlStatus');
      expect(desc.result.create().parse({ ok: 1 })).toEqual({ ok: 1 });
      expect(desc.result.decode?.({ ok: 1 })).toEqual({ ok: 1 });

      if (zeroArg.includes(desc.method)) {
        expect(desc.parameters).toEqual([]);
      } else if (oneArg.includes(desc.method)) {
        expect(desc.parameters).toHaveLength(1);
        expect(desc.parameters[0]).toMatchObject({
          name: 'input',
          wire: 'input',
          source: 'json',
          acceptsUndefined: true,
        });
        expect(desc.parameters[0].codec.mode).toBe('strict');
        expect(desc.parameters[0].codec.typeSymbol).toBe('dsh-antigravity-acp#ControlInput');
      } else {
        throw new Error(`Unexpected descriptor method: ${desc.method}`);
      }
    }

    expect(slotRegistrations).toHaveLength(2);
    expect(slotRegistrations[0].options).toMatchObject({
      name: 'settings.section',
      id: 'antigravity-acp',
      order: 42,
    });
    expect((slotRegistrations[0].options.label as () => string)()).toBe('Antigravity ACP');
    expect(slotRegistrations[1].options).toMatchObject({
      name: 'settings.section.icon',
      id: 'antigravity-acp',
    });

    const injected = (slotRegistrations[0].options.inject as () => {
      callControl: (m: string, i?: unknown) => Promise<unknown>;
    })();
    expect(typeof injected.callControl).toBe('function');

    // Verify 0-arg call sends 0 args, and 1-arg call strips undefined keys & sends 1 clean object
    await injected.callControl('status');
    await injected.callControl('install', { clearBinaryPath: true, ignored: undefined } as unknown);
    expect(recordedRpc[0]).toEqual({ method: 'status', args: [] });
    expect(recordedRpc[1]).toEqual({ method: 'install', args: [{ clearBinaryPath: true }] });
    expect('ignored' in (recordedRpc[1].args[0] as Record<string, unknown>)).toBe(false);

    // Cleanup disposes slots and remote mount
    for (const cleanup of effectCleanups) {
      cleanup();
    }
    await flushMicrotasks();

    expect(mountDispose).toHaveBeenCalledTimes(1);
    for (const d of slotDisposeFns) {
      expect(d).toHaveBeenCalledTimes(1);
    }
    await expect(injected.callControl('status')).rejects.toThrow(/disposed/i);
  });

  it('cleans up $mount disposer even when disposed before $mount promise resolves', async () => {
    const { ReactStub } = createReactTestHarness();
    const { exports } = loadClientModule({ reactStub: ReactStub });

    let resolveMount!: (dispose: () => Promise<void>) => void;
    const mountDispose = vi.fn(async () => {});
    const effectCleanups: Array<() => void> = [];

    exports.apply({
      remote: {
        $mount: () =>
          new Promise<() => Promise<void>>((resolve) => {
            resolveMount = resolve;
          }),
      },
      slots: {
        inject: (_name: string, factory: () => () => void) => factory(),
        register: () => () => {},
      },
      effect: (fn: () => () => void) => {
        effectCleanups.push(fn());
      },
    });

    for (const cleanup of effectCleanups) {
      cleanup();
    }
    resolveMount(mountDispose);
    await flushMicrotasks();

    expect(mountDispose).toHaveBeenCalledTimes(1);
  });

  it('renders AntigravitySectionIcon with size and active props', () => {
    const { ReactStub } = createReactTestHarness();
    const { exports } = loadClientModule({ reactStub: ReactStub });

    const inactiveSvg = exports.AntigravitySectionIcon({ size: 16, active: false });
    expect(inactiveSvg.type).toBe('svg');
    expect(inactiveSvg.props.width).toBe(16);
    expect(inactiveSvg.props.height).toBe(16);
    expect(inactiveSvg.props['data-active']).toBe('false');
    expect(inactiveSvg.children.length).toBeGreaterThan(0);

    const activeSvg = exports.AntigravitySectionIcon({ size: 24, active: true });
    expect(activeSvg.props.width).toBe(24);
    expect(activeSvg.props.height).toBe(24);
    expect(activeSvg.props['data-active']).toBe('true');
  });

  it('exercises full interactive flows (CLI install/config, OAuth code, API key, logout, models, quota, and error redaction)', async () => {
    const { ReactStub, mount } = createReactTestHarness();
    const clipboardSpy = vi.fn(async () => {});
    const loaded = loadClientModule({
      reactStub: ReactStub,
      navigatorLanguage: 'en-US',
      clipboardWriteText: clipboardSpy,
    });

    let currentStatus = createStatusFixture({
      installed: false,
      executable: undefined,
      config: {
        binaryPath: '/custom/missing/agy',
        autoDownload: true,
        authMethod: 'oauth-personal',
        gcpProject: '',
        gcpLocation: '',
        proxyUrl: '',
        proxyBypass: '',
        hasApiKey: false,
      },
    });

    const rpcLog: Array<{ method: string; args: unknown[] }> = [];
    let failNextSaveConfig = false;

    const remoteService: Record<string, (...args: unknown[]) => Promise<unknown>> = {
      status: async (...args) => {
        rpcLog.push({ method: 'status', args });
        return { ok: true, value: currentStatus };
      },
      install: async (...args) => {
        rpcLog.push({ method: 'install', args });
        const input = (args[0] ?? {}) as { clearBinaryPath?: boolean };
        const prevCfg = currentStatus.config as Record<string, unknown>;
        currentStatus = createStatusFixture({
          ...currentStatus,
          installed: true,
          config: {
            ...prevCfg,
            binaryPath: input.clearBinaryPath ? '' : (prevCfg.binaryPath as string),
          },
          install: {
            phase: 'succeeded',
            message: 'Installed agy 1.5.2',
          },
        });
        return { ok: true, value: currentStatus };
      },
      installCancel: async (...args) => {
        rpcLog.push({ method: 'installCancel', args });
        return { ok: true, value: currentStatus };
      },
      saveConfig: async (...args) => {
        rpcLog.push({ method: 'saveConfig', args });
        if (failNextSaveConfig) {
          failNextSaveConfig = false;
          return {
            ok: false,
            error: {
              code: 'gateway/bad-request',
              message: 'Invalid proxyUrl with Bearer sk-secret-token-123456',
              details: {},
            },
          };
        }
        const patch = args[0] as Record<string, unknown>;
        const prevCfg = currentStatus.config as Record<string, unknown>;
        const nextHasApiKey = patch.clearApiKey ? false : Boolean(patch.apiKey || prevCfg.hasApiKey);
        currentStatus = createStatusFixture({
          ...currentStatus,
          profile: {
            ...(currentStatus.profile as Record<string, unknown>),
            hasApiKey: nextHasApiKey,
          },
          config: {
            ...prevCfg,
            ...(typeof patch.binaryPath === 'string' ? { binaryPath: patch.binaryPath } : {}),
            ...(typeof patch.autoDownload === 'boolean' ? { autoDownload: patch.autoDownload } : {}),
            ...(typeof patch.proxyUrl === 'string' ? { proxyUrl: patch.proxyUrl } : {}),
            ...(typeof patch.proxyBypass === 'string' ? { proxyBypass: patch.proxyBypass } : {}),
            ...(typeof patch.authMethod === 'string' ? { authMethod: patch.authMethod } : {}),
            ...(typeof patch.gcpProject === 'string' ? { gcpProject: patch.gcpProject } : {}),
            ...(typeof patch.gcpLocation === 'string' ? { gcpLocation: patch.gcpLocation } : {}),
            hasApiKey: nextHasApiKey,
          },
        });
        return { ok: true, value: currentStatus };
      },
      authStart: async (...args) => {
        rpcLog.push({ method: 'authStart', args });
        const input = args[0] as Record<string, unknown>;
        if (input.authMethod === 'gemini-api-key') {
          currentStatus = createStatusFixture({
            ...currentStatus,
            profile: {
              ...(currentStatus.profile as Record<string, unknown>),
              authMethod: 'gemini-api-key',
              authenticated: true,
              hasApiKey: true,
            },
            config: {
              ...(currentStatus.config as Record<string, unknown>),
              authMethod: 'gemini-api-key',
              hasApiKey: true,
            },
            auth: { phase: 'succeeded', message: 'API Key configured' },
          });
        } else {
          currentStatus = createStatusFixture({
            ...currentStatus,
            auth: {
              phase: 'awaiting_code',
              mode: 'code',
              authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=abc',
              message: 'Open URL and paste authorization code',
            },
          });
        }
        return { ok: true, value: currentStatus };
      },
      authSubmitCode: async (...args) => {
        rpcLog.push({ method: 'authSubmitCode', args });
        currentStatus = createStatusFixture({
          ...currentStatus,
          profile: {
            ...(currentStatus.profile as Record<string, unknown>),
            authMethod: 'oauth-personal',
            authenticated: true,
            account: 'alice@example.com',
          },
          auth: { phase: 'succeeded', message: 'Signed in as alice@example.com' },
        });
        return { ok: true, value: currentStatus };
      },
      authCancel: async (...args) => {
        rpcLog.push({ method: 'authCancel', args });
        return { ok: true, value: currentStatus };
      },
      logout: async (...args) => {
        rpcLog.push({ method: 'logout', args });
        currentStatus = createStatusFixture({
          ...currentStatus,
          profile: {
            ...(currentStatus.profile as Record<string, unknown>),
            authenticated: false,
            account: undefined,
            hasApiKey: false,
          },
          config: {
            ...(currentStatus.config as Record<string, unknown>),
            hasApiKey: false,
          },
          auth: { phase: 'idle', message: '' },
          models: [],
          quota: undefined,
        });
        return { ok: true, value: currentStatus };
      },
      refreshModels: async (...args) => {
        rpcLog.push({ method: 'refreshModels', args });
        currentStatus = createStatusFixture({
          ...currentStatus,
          models: [
            {
              id: 'gemini-3.1-pro',
              name: 'Gemini 3.1 Pro',
              description: 'Flagship reasoning model',
              isDefault: true,
              defaultThoughtLevel: 'high',
              thinkingOptions: [
                { id: 'low', name: 'Low' },
                { id: 'high', name: 'High' },
              ],
            },
          ],
        });
        return { ok: true, value: currentStatus };
      },
      refreshQuota: async (...args) => {
        rpcLog.push({ method: 'refreshQuota', args });
        currentStatus = createStatusFixture({
          ...currentStatus,
          quota: {
            capturedAt: '2026-11-22T01:05:00.000Z',
            account: 'alice@example.com',
            tier: 'pro',
            exhausted: false,
            windows: [
              {
                id: 'pro-daily',
                label: 'Pro Daily',
                remainingFraction: 0.72,
                resetInSeconds: 3900,
              },
            ],
          },
        });
        return { ok: true, value: currentStatus };
      },
    };

    let sectionInjectFn: (() => { callControl: (m: string, i?: unknown) => Promise<unknown> }) | null = null;
    loaded.exports.apply({
      remote: {
        $mount: () => Promise.resolve(async () => {}),
        antigravityControl: remoteService,
      },
      slots: {
        inject: (_name: string, factory: () => () => void) => factory(),
        register(opts: Record<string, unknown>) {
          if (opts.name === 'settings.section') {
            sectionInjectFn = opts.inject as typeof sectionInjectFn;
          }
          return () => {};
        },
      },
      effect() {},
    });

    const { callControl } = sectionInjectFn!();
    const view = mount(loaded.exports.AntigravitySettingsSection, { callControl });
    await flushMicrotasks();

    // 1. Initial load called status() with 0 args and synced binaryPath
    expect(rpcLog[0]).toEqual({ method: 'status', args: [] });
    expect(findByAttr(view.getTree(), 'data-acp-input', 'binaryPath').props.value).toBe('/custom/missing/agy');

    // Custom binaryPath exposes install-managed button
    await (findByAttr(view.getTree(), 'data-acp-action', 'install-managed').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    expect(rpcLog.at(-1)).toEqual({ method: 'install', args: [{ clearBinaryPath: true }] });
    expect(findByAttr(view.getTree(), 'data-acp-input', 'binaryPath').props.value).toBe('');

    // Plain install({})
    await (findByAttr(view.getTree(), 'data-acp-action', 'install').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    expect(rpcLog.at(-1)).toEqual({ method: 'install', args: [{}] });

    // Edit runtime fields & saveConfig
    (findByAttr(view.getTree(), 'data-acp-input', 'proxyUrl').props.onChange as (e: unknown) => void)({
      target: { value: 'http://127.0.0.1:7890' },
    });
    (findByAttr(view.getTree(), 'data-acp-input', 'proxyBypass').props.onChange as (e: unknown) => void)({
      target: { value: 'localhost,127.0.0.1' },
    });
    (findByAttr(view.getTree(), 'data-acp-input', 'autoDownload').props.onChange as (e: unknown) => void)({
      target: { checked: false },
    });
    await (findByAttr(view.getTree(), 'data-acp-action', 'save-runtime').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    expect(rpcLog.at(-1)).toEqual({
      method: 'saveConfig',
      args: [
        {
          binaryPath: '',
          autoDownload: false,
          proxyUrl: 'http://127.0.0.1:7890',
          proxyBypass: 'localhost,127.0.0.1',
        },
      ],
    });

    // OAuth code login flow: authStart -> renders authUrl -> copy -> submitCode
    await (findByAttr(view.getTree(), 'data-acp-action', 'auth-start-code').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    expect(rpcLog.at(-1)).toEqual({
      method: 'authStart',
      args: [{ mode: 'code', authMethod: 'oauth-personal' }],
    });

    const authUrlBox = findByAttr(
      view.getTree(),
      'data-acp-auth-url',
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=abc',
    );
    expect(textContent(authUrlBox)).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    const openLink = findByAttr(view.getTree(), 'data-acp-action', 'open-auth-url');
    expect(openLink.props.href).toBe('https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=abc');
    expect(openLink.props.target).toBe('_blank');

    (findByAttr(view.getTree(), 'data-acp-action', 'copy-auth-url').props.onClick as () => void)();
    await flushMicrotasks();
    expect(clipboardSpy).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=abc',
    );

    (findByAttr(view.getTree(), 'data-acp-input', 'authCode').props.onChange as (e: unknown) => void)({
      target: { value: '  4/0A-sample-auth-code  ' },
    });
    await (findByAttr(view.getTree(), 'data-acp-action', 'auth-submit-code').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    expect(rpcLog.at(-1)).toEqual({
      method: 'authSubmitCode',
      args: [{ code: '4/0A-sample-auth-code' }],
    });
    expect(textContent(findByAttr(view.getTree(), 'data-acp-badge', 'auth'))).toContain('alice@example.com');

    // Refresh models & quota (0 args)
    await (findByAttr(view.getTree(), 'data-acp-action', 'refresh-models').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    expect(rpcLog.at(-1)).toEqual({ method: 'refreshModels', args: [] });
    expect(textContent(findByAttr(view.getTree(), 'data-acp-list', 'models'))).toContain('Gemini 3.1 Pro');

    await (findByAttr(view.getTree(), 'data-acp-action', 'refresh-quota').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    expect(rpcLog.at(-1)).toEqual({ method: 'refreshQuota', args: [] });
    const quotaList = findByAttr(view.getTree(), 'data-acp-list', 'quota');
    expect(textContent(quotaList)).toContain('Pro Daily');
    expect(textContent(quotaList)).toContain('Remaining 72%');

    // Logout (0 args)
    await (findByAttr(view.getTree(), 'data-acp-action', 'logout').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    expect(rpcLog.at(-1)).toEqual({ method: 'logout', args: [] });

    // API key auth + clearKey
    (findByAttr(view.getTree(), 'data-acp-auth-method', 'gemini-api-key').props.onClick as () => void)();
    (findByAttr(view.getTree(), 'data-acp-input', 'apiKey').props.onChange as (e: unknown) => void)({
      target: { value: 'AIzaTestKey1234567890' },
    });
    await (findByAttr(view.getTree(), 'data-acp-action', 'auth-save-api-key').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    expect(rpcLog.at(-1)).toEqual({
      method: 'authStart',
      args: [{ authMethod: 'gemini-api-key', apiKey: 'AIzaTestKey1234567890' }],
    });
    // Raw API key is cleared from form after save
    expect(findByAttr(view.getTree(), 'data-acp-input', 'apiKey').props.value).toBe('');

    await (findByAttr(view.getTree(), 'data-acp-action', 'clear-api-key').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    expect(rpcLog.at(-1)).toEqual({
      method: 'saveConfig',
      args: [{ clearApiKey: true }],
    });

    // Error envelope handling + secret redaction
    failNextSaveConfig = true;
    await (findByAttr(view.getTree(), 'data-acp-action', 'save-runtime').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    const errBanner = findByAttr(view.getTree(), 'data-acp-banner', 'error');
    expect(textContent(errBanner)).toContain('Bearer [REDACTED]');
    expect(textContent(errBanner)).not.toContain('sk-secret-token-123456');

    // Enterprise oauth-business flow (gcpProject + gcpLocation) + save-gcp + authCancel
    (findByAttr(view.getTree(), 'data-acp-auth-method', 'oauth-business').props.onClick as () => void)();
    (findByAttr(view.getTree(), 'data-acp-input', 'gcpProject').props.onChange as (e: unknown) => void)({
      target: { value: 'my-gcp-project' },
    });
    (findByAttr(view.getTree(), 'data-acp-input', 'gcpLocation').props.onChange as (e: unknown) => void)({
      target: { value: 'us-central1' },
    });
    await (findByAttr(view.getTree(), 'data-acp-action', 'save-gcp').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    expect(rpcLog.at(-1)).toEqual({
      method: 'saveConfig',
      args: [
        {
          authMethod: 'oauth-business',
          gcpProject: 'my-gcp-project',
          gcpLocation: 'us-central1',
        },
      ],
    });
    await (findByAttr(view.getTree(), 'data-acp-action', 'auth-start-code').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    expect(rpcLog.at(-1)).toEqual({
      method: 'authStart',
      args: [
        {
          mode: 'code',
          authMethod: 'oauth-business',
          gcpProject: 'my-gcp-project',
          gcpLocation: 'us-central1',
        },
      ],
    });
    await (findByAttr(view.getTree(), 'data-acp-action', 'auth-cancel').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    expect(rpcLog.at(-1)).toEqual({ method: 'authCancel', args: [] });

    // Failed authStart response inside snapshot keeps apiKey draft, shows redacted auth error, and shows no false success notice
    (findByAttr(view.getTree(), 'data-acp-auth-method', 'gemini-api-key').props.onClick as () => void)();
    (findByAttr(view.getTree(), 'data-acp-input', 'apiKey').props.onChange as (e: unknown) => void)({
      target: { value: 'AIzaSecretKey1234567890' },
    });
    const origAuthStart = remoteService.authStart;
    remoteService.authStart = async (...args) => {
      rpcLog.push({ method: 'authStart', args });
      currentStatus = createStatusFixture({
        ...currentStatus,
        auth: {
          phase: 'failed',
          message: 'Verification failed',
          error: 'Invalid API key AIzaSecretKey1234567890',
        },
      });
      return { ok: true, value: currentStatus };
    };
    await (findByAttr(view.getTree(), 'data-acp-action', 'auth-save-api-key').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    remoteService.authStart = origAuthStart;
    expect(findAll(view.getTree(), (n) => n.props['data-acp-banner'] === 'notice')).toHaveLength(0);
    expect(findByAttr(view.getTree(), 'data-acp-input', 'apiKey').props.value).toBe('AIzaSecretKey1234567890');
    const authBox = findByAttr(view.getTree(), 'data-acp-auth-phase', 'failed');
    expect(textContent(authBox)).toContain('[REDACTED]');
    expect(textContent(authBox)).not.toContain('AIzaSecretKey1234567890');

    // Bilingual zh-CN copy check
    loaded.setLanguage('zh-CN');
    view.rerender({ callControl });
    expect(textContent(findByAttr(view.getTree(), 'data-acp-action', 'install'))).toContain('安装 / 更新 Antigravity CLI');

    view.unmount();
  });

  it('auto-polls every 1500ms while active without overwriting dirty draft fields, supports installCancel, and stops polling when finished or unmounted', async () => {
    vi.useFakeTimers();
    const { ReactStub, mount } = createReactTestHarness();
    const { exports } = loadClientModule({ reactStub: ReactStub });

    let statusCount = 0;
    let pollPhase: 'running' | 'succeeded' = 'running';

    const callControl = vi.fn(async (method: string) => {
      if (method === 'status') {
        statusCount += 1;
        return createStatusFixture({
          installed: pollPhase === 'succeeded',
          config: {
            binaryPath: '/server/path/agy',
            autoDownload: true,
            authMethod: 'oauth-personal',
            gcpProject: '',
            gcpLocation: '',
            proxyUrl: '',
            proxyBypass: '',
            hasApiKey: false,
          },
          install: {
            phase: pollPhase,
            message: pollPhase === 'running' ? 'Downloading...' : 'Done',
          },
        });
      }
      if (method === 'installCancel') {
        pollPhase = 'succeeded';
        return createStatusFixture({
          installed: false,
          install: { phase: 'cancelled', message: 'Cancelled' },
        });
      }
      return createStatusFixture();
    });

    const view = mount(exports.AntigravitySettingsSection, { callControl });
    await flushMicrotasks();
    expect(statusCount).toBe(1);

    // Dirty the binaryPath draft
    (findByAttr(view.getTree(), 'data-acp-input', 'binaryPath').props.onChange as (e: unknown) => void)({
      target: { value: '/user/edited/agy' },
    });

    // Advance 1500ms -> polls once and preserves user's dirty draft
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();
    expect(statusCount).toBe(2);
    expect(findByAttr(view.getTree(), 'data-acp-input', 'binaryPath').props.value).toBe('/user/edited/agy');

    // install-cancel button appears while running and invokes installCancel() with 0 args
    await (findByAttr(view.getTree(), 'data-acp-action', 'install-cancel').props.onClick as () => Promise<void>)();
    await flushMicrotasks();
    expect(callControl).toHaveBeenCalledWith('installCancel');

    // Further timer advances must NOT trigger extra polls after non-running phase
    await vi.advanceTimersByTimeAsync(4500);
    await flushMicrotasks();
    expect(statusCount).toBe(2);

    view.unmount();

    // Also verify unmount stops polling immediately even while phase is still running
    pollPhase = 'running';
    statusCount = 0;
    const view2 = mount(exports.AntigravitySettingsSection, { callControl });
    await flushMicrotasks();
    expect(statusCount).toBe(1);
    view2.unmount();
    await vi.advanceTimersByTimeAsync(4500);
    await flushMicrotasks();
    expect(statusCount).toBe(1);
  });
});
