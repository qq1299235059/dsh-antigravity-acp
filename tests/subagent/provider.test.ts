import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import {
  AttachmentId,
  type AttachmentStore,
  type ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment';
import { brandString } from '@deepseek-ai/dsh-brand';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { NO_START_CAPABILITIES, SubagentError } from '@deepseek-ai/dsh-subagent';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnAcpClient } from '../../src/acp/client.js';
import { AcpWorkerPool } from '../../src/acp/pool.js';
import { prepareAntigravityProfile, resolveProfileSnapshot } from '../../src/runtime/profile.js';
import {
  RuntimeConfigSchema,
  SubagentPluginConfigSchema,
  type RuntimeConfig,
  type SubagentPluginConfigInput,
} from '../../src/shared/config.js';
import type {
  AntigravityExecutable,
  AntigravityRuntimeService,
} from '../../src/shared/contracts.js';
import {
  AntigravitySubagentProvider,
  type SubagentProviderLogger,
} from '../../src/subagent/provider.js';
import { createAntigravitySubagentTool } from '../../src/subagent/tool.js';
import {
  registerAntigravitySubagentSkill,
  registerAntigravitySystemPrompt,
} from '../../src/subagent/skill.js';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolsService, type ToolExecution } from '@deepseek-ai/dsh-tools';

const FAKE_SERVER_PATH = fileURLToPath(new URL('../acp/fake-agy-server.mjs', import.meta.url));

interface SubagentTestHarness {
  readonly tempDir: string;
  readonly workDir: string;
  readonly ctx: Context;
  readonly subprocessFiber: { dispose: () => Promise<void> };
  readonly pool: AcpWorkerPool;
  readonly runtime: AntigravityRuntimeService;
  readonly provider: AntigravitySubagentProvider;
  readonly warnings: string[];
  readonly spawnedClients: Array<{ isClosed: boolean }>;
}

describe('AntigravitySubagentProvider', () => {
  const harnesses: SubagentTestHarness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      const h = harnesses.pop()!;
      await h.pool.dispose().catch(() => {});
      await h.subprocessFiber.dispose().catch(() => {});
      fs.rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  async function createHarness(options?: {
    readonly fakeEnv?: Record<string, string>;
    readonly subagentConfig?: SubagentPluginConfigInput;
    readonly attachments?: AttachmentStore;
  }): Promise<SubagentTestHarness> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-subagent-test-'));
    const workDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(workDir, { recursive: true });

    const ctx = new Context();
    const subprocessFiber = await ctx.plugin(LocalSubprocessRuntime);

    const runtimeConfig: RuntimeConfig = {
      ...RuntimeConfigSchema({ profileDir: path.join(tempDir, 'profile') }),
      handshakeTimeoutMs: 10_000,
      requestTimeoutMs: 10_000,
      promptTimeoutMs: 15_000,
      queueTimeoutMs: 10_000,
    };

    const executable: AntigravityExecutable = {
      command: process.execPath,
      argsPrefix: [FAKE_SERVER_PATH, 'acp'],
      source: 'configured',
      version: '1.5.2',
    };

    const spawnedClients: Array<{ isClosed: boolean }> = [];

    const pool = new AcpWorkerPool({
      subprocess: ctx.subprocess,
      config: runtimeConfig,
      resolveExecutable: async () => executable,
      prepareProfile: async (opts) =>
        prepareAntigravityProfile(runtimeConfig, { suppressBrowser: opts?.suppressBrowser }),
      skipVersionCheck: true,
      spawnClientFn: async (spawnOpts) => {
        const client = await spawnAcpClient({
          ...spawnOpts,
          env: {
            ...spawnOpts.env,
            ...options?.fakeEnv,
          },
        });
        spawnedClients.push(client);
        return client;
      },
    });

    const runtime: AntigravityRuntimeService = {
      config: runtimeConfig,
      resolveExecutable: async () => executable,
      ensureInstalled: async () => executable,
      resolveProfile: () => resolveProfileSnapshot(runtimeConfig),
      checkAuth: async () => resolveProfileSnapshot(runtimeConfig),
      login: async () => resolveProfileSnapshot(runtimeConfig),
      logout: async () => {},
      listModels: async () => [],
      getQuota: async () => ({
        capturedAt: new Date().toISOString(),
        windows: [],
        exhausted: false,
      }),
      getStatus: async () => {
        const stats = pool.getStats();
        return {
          installed: true,
          executable,
          profile: resolveProfileSnapshot(runtimeConfig),
          activeLeases: stats.activeLeases,
          idleWorkers: stats.idleWorkers,
          maxConcurrentSessions: stats.maxConcurrentSessions,
        };
      },
      acquireWorker: (acquireOpts) => pool.acquireWorker(acquireOpts),
      spawnClient: (spawnOpts) =>
        pool.spawnClient({
          ...spawnOpts,
          env: options?.fakeEnv,
        }),
      warmup: async () => {},
      dispose: () => pool.dispose(),
    };

    const warnings: string[] = [];
    const logger: SubagentProviderLogger = {
      warn: (msg) => warnings.push(String(msg)),
    };

    const config = SubagentPluginConfigSchema(options?.subagentConfig ?? {});
    const provider = new AntigravitySubagentProvider(
      runtime,
      config,
      options?.attachments,
      logger,
    );

    const harness: SubagentTestHarness = {
      tempDir,
      workDir,
      ctx,
      subprocessFiber,
      pool,
      runtime,
      provider,
      warnings,
      spawnedClients,
    };
    harnesses.push(harness);
    return harness;
  }

  function makeParent(): Agent {
    return { id: brandString<SessionId>('parent-session') } as unknown as Agent;
  }

  it('exposes out-of-process capabilities and completes a prompt with configured model, thought level, and systemPromptAppend', async () => {
    const h = await createHarness({
      fakeEnv: {
        FAKE_AGY_ECHO_CONTEXT: '1',
      },
      subagentConfig: {
        providerName: 'antigravity-custom',
        defaultModel: 'gemini-2.5-flash',
        defaultThoughtLevel: 'high',
        systemPromptAppend: 'Keep subagent edits scoped to workspace.',
        permissionMode: 'auto',
      },
    });

    expect(h.provider.name).toBe('antigravity-custom');
    expect(h.provider.capabilities).toEqual(NO_START_CAPABILITIES);
    expect(h.provider.inheritsParentContext).toBe(false);

    const controller = new AbortController();
    const run = await h.provider.start({
      cwd: h.workDir,
      prompt: [{ type: 'text', text: 'Inspect files' }],
      parent: makeParent(),
      signal: controller.signal,
    });

    expect(typeof run.id).toBe('string');
    const result = await run.result;
    expect(result.stopReason).toBe('completed');
    expect(result.diagnostic).toBeUndefined();
    expect(result.output).toHaveLength(1);
    expect(result.output[0].type).toBe('text');

    const echoed = JSON.parse(
      result.output[0].type === 'text' ? result.output[0].text : '{}',
    ) as {
      mcpServerCount: number;
      model: string;
      thoughtLevel: string;
      mode: string;
      cwd: string;
      sessionMeta?: { antigravity?: { systemPrompt?: { append?: string } } };
      prompt: Array<{ type: string; text?: string }>;
    };

    expect(echoed.mcpServerCount).toBe(0);
    expect(echoed.model).toBe('gemini-2.5-flash');
    expect(echoed.thoughtLevel).toBe('high');
    expect(echoed.mode).toBe('auto');
    expect(echoed.cwd).toBe(h.workDir);
    expect(echoed.sessionMeta?.antigravity?.systemPrompt?.append).toBe(
      'Keep subagent edits scoped to workspace.',
    );
    expect(echoed.prompt).toEqual([{ type: 'text', text: 'Inspect files' }]);

    await run.dispose();
    await run.dispose();
    expect(h.spawnedClients.every((c) => c.isClosed)).toBe(true);
  });

  it('handles permissionMode yolo, auto_edit, and default (reject vs cancel)', async () => {
    const yolo = await createHarness({
      fakeEnv: {
        FAKE_AGY_PERMISSION_PROMPT: '1',
        FAKE_AGY_PERMISSION_KIND: 'execute',
      },
      subagentConfig: { permissionMode: 'yolo' },
    });
    const yoloRun = await yolo.provider.start({
      cwd: yolo.workDir,
      prompt: [{ type: 'text', text: 'Run cmd' }],
      parent: makeParent(),
      signal: new AbortController().signal,
    });
    const yoloRes = await yoloRun.result;
    expect(yoloRes.stopReason).toBe('completed');
    expect(yoloRes.output).toEqual([{ type: 'text', text: 'Permission allowed:allow_once' }]);
    await yoloRun.dispose();

    const defaultReject = await createHarness({
      fakeEnv: {
        FAKE_AGY_PERMISSION_PROMPT: '1',
        FAKE_AGY_PERMISSION_KIND: 'execute',
      },
      subagentConfig: { permissionMode: 'default', permissionFallback: 'reject' },
    });
    const rejectRun = await defaultReject.provider.start({
      cwd: defaultReject.workDir,
      prompt: [{ type: 'text', text: 'Run cmd' }],
      parent: makeParent(),
      signal: new AbortController().signal,
    });
    const rejectRes = await rejectRun.result;
    expect(rejectRes.stopReason).toBe('refusal');
    expect(rejectRes.output).toEqual([{ type: 'text', text: 'Permission rejected:reject_once' }]);
    await rejectRun.dispose();

    const defaultCancel = await createHarness({
      fakeEnv: {
        FAKE_AGY_PERMISSION_PROMPT: '1',
        FAKE_AGY_PERMISSION_KIND: 'execute',
      },
      subagentConfig: { permissionMode: 'default', permissionFallback: 'cancel' },
    });
    const cancelRun = await defaultCancel.provider.start({
      cwd: defaultCancel.workDir,
      prompt: [{ type: 'text', text: 'Run cmd' }],
      parent: makeParent(),
      signal: new AbortController().signal,
    });
    const cancelRes = await cancelRun.result;
    expect(cancelRes.stopReason).toBe('refusal');
    expect(cancelRes.output).toEqual([{ type: 'text', text: 'Permission cancelled' }]);
    await cancelRun.dispose();

    const autoEditAllow = await createHarness({
      fakeEnv: {
        FAKE_AGY_PERMISSION_PROMPT: '1',
        FAKE_AGY_PERMISSION_KIND: 'edit',
      },
      subagentConfig: { permissionMode: 'auto_edit', permissionFallback: 'reject' },
    });
    const editRun = await autoEditAllow.provider.start({
      cwd: autoEditAllow.workDir,
      prompt: [{ type: 'text', text: 'Edit file' }],
      parent: makeParent(),
      signal: new AbortController().signal,
    });
    const editRes = await editRun.result;
    expect(editRes.stopReason).toBe('completed');
    expect(editRes.output).toEqual([{ type: 'text', text: 'Permission allowed:allow_once' }]);
    await editRun.dispose();

    const autoEditDenyExec = await createHarness({
      fakeEnv: {
        FAKE_AGY_PERMISSION_PROMPT: '1',
        FAKE_AGY_PERMISSION_KIND: 'execute',
      },
      subagentConfig: { permissionMode: 'auto_edit', permissionFallback: 'reject' },
    });
    const execRun = await autoEditDenyExec.provider.start({
      cwd: autoEditDenyExec.workDir,
      prompt: [{ type: 'text', text: 'Exec cmd' }],
      parent: makeParent(),
      signal: new AbortController().signal,
    });
    const execRes = await execRun.result;
    expect(execRes.stopReason).toBe('refusal');
    expect(execRes.output).toEqual([{ type: 'text', text: 'Permission rejected:reject_once' }]);
    await execRun.dispose();
  });

  it('settles as aborted on AbortSignal cancellation and supports idempotent mid-turn disposal', async () => {
    const h = await createHarness({
      fakeEnv: {
        FAKE_AGY_DELAY_MS: '5000',
      },
      subagentConfig: {
        disposeEofGraceMs: 250,
        disposeGraceMs: 300,
      },
    });

    const controller1 = new AbortController();
    const run1 = await h.provider.start({
      cwd: h.workDir,
      prompt: [{ type: 'text', text: 'Slow task' }],
      parent: makeParent(),
      signal: controller1.signal,
    });
    controller1.abort();
    const res1 = await run1.result;
    expect(res1.stopReason).toBe('aborted');
    await run1.dispose();

    const run2 = await h.provider.start({
      cwd: h.workDir,
      prompt: [{ type: 'text', text: 'Slow task 2' }],
      parent: makeParent(),
      signal: new AbortController().signal,
    });
    const [d1, d2, res2] = await Promise.all([run2.dispose(), run2.dispose(), run2.result]);
    expect(d1).toBeUndefined();
    expect(d2).toBeUndefined();
    expect(res2.stopReason).toBe('aborted');
    expect(h.spawnedClients.every((c) => c.isClosed)).toBe(true);
  });

  it('never rejects run.result on child crash after start; resolves stopReason error with redacted diagnostic', async () => {
    const h = await createHarness({
      fakeEnv: {
        FAKE_AGY_CRASH: 'prompt',
      },
    });

    const run = await h.provider.start({
      cwd: h.workDir,
      prompt: [{ type: 'text', text: 'Trigger crash' }],
      parent: makeParent(),
      signal: new AbortController().signal,
    });

    const result = await run.result;
    expect(result.stopReason).toBe('error');
    expect(result.output).toEqual([{ type: 'text', text: 'partial-before-crash' }]);
    expect(typeof result.diagnostic).toBe('string');
    expect(result.diagnostic!.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(result.diagnostic!, 'utf8')).toBeLessThanOrEqual(4096);

    await run.dispose();
  });

  it('cleans up spawned client before rejecting on startup failure and validates pre-start conditions', async () => {
    const h = await createHarness({
      fakeEnv: {
        FAKE_AGY_AUTH_REQUIRED: 'new_session',
      },
    });

    await expect(
      h.provider.start({
        cwd: h.workDir,
        prompt: [{ type: 'text', text: 'Needs auth' }],
        parent: makeParent(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();

    expect(h.spawnedClients).toHaveLength(1);
    expect(h.spawnedClients[0].isClosed).toBe(true);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      h.provider.start({
        cwd: h.workDir,
        prompt: [{ type: 'text', text: 'Aborted' }],
        parent: makeParent(),
        signal: aborted.signal,
      }),
    ).rejects.toThrow();

    await expect(
      h.provider.start({
        cwd: 'relative/path',
        prompt: [{ type: 'text', text: 'Bad cwd' }],
        parent: makeParent(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/absolute path/i);

    await expect(
      h.provider.start({
        cwd: h.workDir,
        prompt: [{ type: 'text', text: 'Bad cap' }],
        parent: makeParent(),
        signal: new AbortController().signal,
        maxDepth: 2,
      }),
    ).rejects.toBeInstanceOf(SubagentError);
  });

  it('forwards image attachments when supported and degrades offloaded images cleanly', async () => {
    const imageRef: ImageAttachmentRef = {
      attachmentId: AttachmentId('sha256:0123456789abcdef0123456789abcdef'),
      mediaType: 'image/png',
      bytes: 4,
      width: 10,
      height: 10,
      name: 'pixel.png',
    };
    const fakeAttachments = {
      readImage: vi.fn(async (ref: ImageAttachmentRef) => ({
        ref,
        data: Uint8Array.from([137, 80, 78, 71]),
      })),
    } as unknown as AttachmentStore;

    const h = await createHarness({
      fakeEnv: {
        FAKE_AGY_ECHO_CONTEXT: '1',
      },
      attachments: fakeAttachments,
    });

    const run = await h.provider.start({
      cwd: h.workDir,
      prompt: [
        { type: 'text', text: 'Check image' },
        { type: 'image', attachment: imageRef },
        { type: 'image', attachment: imageRef, offloaded: true },
      ],
      parent: makeParent(),
      signal: new AbortController().signal,
    });

    const result = await run.result;
    expect(result.stopReason).toBe('completed');
    const echoed = JSON.parse(
      result.output[0].type === 'text' ? result.output[0].text : '{}',
    ) as { prompt: Array<{ type: string; mimeType?: string; data?: string; text?: string }> };
    expect(echoed.prompt[0]).toEqual({ type: 'text', text: 'Check image' });
    expect(echoed.prompt[1]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from([137, 80, 78, 71]).toString('base64'),
    });
    expect(echoed.prompt[2].type).toBe('text');
    expect(echoed.prompt[2].text).toContain('image omitted');
    await run.dispose();
  });

  it('supports antigravity_agent tool across legacy nested and flattened startActivation shapes, per-call overrides, abort cleanup, and error propagation', async () => {
    const h = await createHarness({
      fakeEnv: { FAKE_AGY_ECHO_CONTEXT: '1' },
      subagentConfig: {
        defaultModel: 'gemini-2.5-pro',
        defaultThoughtLevel: 'medium',
        permissionMode: 'yolo',
      },
    });

    // Legacy 0.2.2-rc.1 shape (`startActivation` checks `spec.request`)
    const legacySubagents = {
      startActivation(spec: {
        provider: string;
        label: string;
        delivery: string;
        signal: AbortSignal;
        request: { cwd?: string; prompt: any[]; parent: Agent };
      }) {
        const prompt = spec.request.prompt;
        const cwd = spec.request.cwd ?? h.workDir;
        return h.provider
          .start({
            cwd,
            prompt,
            parent: spec.request.parent,
            label: spec.label,
            signal: spec.signal,
          })
          .then((run) => ({
            childId: run.id,
            name: spec.label,
            result: run.result,
            dispose: () => run.dispose(),
          }));
      },
    } as unknown as import('@deepseek-ai/dsh-subagent').SubagentRuntime;

    const tool = createAntigravitySubagentTool({
      subagents: legacySubagents,
      getConfig: () =>
        SubagentPluginConfigSchema({
          defaultModel: 'gemini-2.5-pro',
          defaultThoughtLevel: 'medium',
          permissionMode: 'yolo',
        }),
    });

    expect(tool.isConcurrencySafe?.({ description: 'x', prompt: 'y' })).toBe(true);
    expect(tool.presentCall?.({ description: 'Analyze code', prompt: 'p' })).toMatchObject({
      card: 'generic',
      title: 'Antigravity: Analyze code',
    });
    expect(
      tool.presentResult?.(
        { description: 'Analyze code', prompt: 'p' },
        { content: [{ type: 'text', text: 'done' }], isError: false },
      ),
    ).toMatchObject({
      card: 'generic',
      title: 'Antigravity Completed: Analyze code',
    });

    const exec = {
      agent: makeParent(),
      signal: new AbortController().signal,
      callId: brandString('tc-1') as ToolExecution['callId'],
      rootCallId: brandString('tc-1') as ToolExecution['callId'],
      name: 'antigravity_agent',
      arguments: {},
      token: Symbol('exec') as ToolExecution['token'],
      deferContext: () => {},
      concludeTurn: () => {},
    };

    const res = (await tool.execute(
      {
        description: 'Per-call override',
        prompt: 'Check override behavior',
        cwd: h.workDir,
        model: 'gemini-3-pro',
        thought_level: 'high',
      },
      exec,
    )) as { model?: string; thoughtLevel?: string; outputText: string };

    expect(res.model).toBe('gemini-3-pro');
    expect(res.thoughtLevel).toBe('high');
    const echoed = JSON.parse(res.outputText) as { model?: string; thoughtLevel?: string };
    expect(echoed.model).toBe('gemini-3-pro');
    expect(echoed.thoughtLevel).toBe('high');

    // Abort during slow run cleans up spawned ACP client
    const slowH = await createHarness({
      fakeEnv: { FAKE_AGY_DELAY_MS: '5000' },
      subagentConfig: { disposeEofGraceMs: 150, disposeGraceMs: 200 },
    });
    const abortCtrl = new AbortController();
    let childStarted!: () => void;
    const childStartedPromise = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const slowTool = createAntigravitySubagentTool({
      subagents: {
        startActivation: async (spec: any) => {
          const run = await slowH.provider.start({
            cwd: spec.cwd ?? slowH.workDir,
            prompt: spec.prompt,
            parent: spec.parent,
            label: spec.label,
            signal: spec.signal,
          });
          childStarted();
          return {
            childId: run.id,
            name: run.id,
            result: run.result,
            dispose: () => run.dispose(),
          };
        },
      } as unknown as import('@deepseek-ai/dsh-subagent').SubagentRuntime,
      getConfig: () => SubagentPluginConfigSchema({}),
    });
    void childStartedPromise.then(() => abortCtrl.abort(new Error('User cancelled')));
    await expect(
      slowTool.execute(
        { description: 'Slow job', prompt: 'Wait', cwd: slowH.workDir },
        { ...exec, signal: abortCtrl.signal },
      ),
    ).rejects.toThrow(/User cancelled|aborted/i);
    expect(slowH.spawnedClients.every((c) => c.isClosed)).toBe(true);
  });

  it('registers antigravity-subagent via skill.register fallback and hides systemPrompt section when tool is restricted', async () => {
    const registered: Array<{ name: string; content: string }> = [];
    const disposeSkill = registerAntigravitySubagentSkill({
      skills: {
        register: (skill) => {
          registered.push({ name: skill.name, content: skill.content });
          return () => {};
        },
      },
      getConfig: () => SubagentPluginConfigSchema({ defaultModel: 'gemini-3-pro' }),
    });
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe('antigravity-subagent');
    expect(registered[0].content).toContain('gemini-3-pro');
    disposeSkill();

    const ctx = new Context();
    await ctx.plugin(ToolsService);
    await ctx.plugin(SystemPrompt);
    ctx.tools.setExecutor({
      describe: (tools) => ({
        schemas: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        knownNames: tools.map((t) => t.name),
      }),
      execute: async () => ({
        results: [],
        additionalContexts: [],
        concluded: false,
      }),
    });
    const tool = createAntigravitySubagentTool({
      subagents: {} as unknown as import('@deepseek-ai/dsh-subagent').SubagentRuntime,
      getConfig: () => SubagentPluginConfigSchema({}),
    });
    const unregTool = ctx.tools.register(tool);
    const unregPrompt = registerAntigravitySystemPrompt({
      systemPrompt: ctx.systemPrompt,
      tools: ctx.tools,
      toolDefinition: tool,
      getConfig: () => SubagentPluginConfigSchema({}),
    });

    const visiblePrompt = await ctx.systemPrompt.assemble();
    expect(visiblePrompt.sections.some((s) => s.name === 'tool:antigravity_agent')).toBe(true);

    unregTool();
    const hiddenPrompt = await ctx.systemPrompt.assemble();
    const hiddenSection = hiddenPrompt.sections.find(
      (s) => s.name === 'tool:antigravity_agent',
    );
    expect(!hiddenSection || hiddenSection.text === '').toBe(true);
    unregPrompt();
  });
});
