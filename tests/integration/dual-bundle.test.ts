import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service, type Fiber } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { brandString } from '@deepseek-ai/dsh-brand';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SubagentActivation, SubagentActivationSpec, SubagentProvider } from '@deepseek-ai/dsh-subagent';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolsService, type ToolExecution } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import * as runtimePlugin from '../../src/index.js';
import * as subagentPlugin from '../../src/subagent-plugin.js';

const FAKE_SERVER_PATH = fileURLToPath(new URL('../acp/fake-agy-server.mjs', import.meta.url));

class TestSubagentRegistry extends Service {
  private readonly providers = new Map<string, SubagentProvider>();
  readonly startCalls: Record<string, unknown>[] = [];

  constructor(ctx: Context) {
    super(ctx, 'subagents');
  }

  registerProvider(provider: SubagentProvider): () => void {
    const disposeEffect = this.ctx.effect(() => {
      if (this.providers.has(provider.name)) {
        throw new Error(`Duplicate subagent provider "${provider.name}"`);
      }
      this.providers.set(provider.name, provider);
      return () => {
        this.providers.delete(provider.name);
      };
    }, `testSubagents.registerProvider(${provider.name})`);
    return () => {
      void disposeEffect();
    };
  }

  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name);
  }

  resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined {
    return configured === 'provider-managed' ? undefined : (configured ?? 1);
  }

  async startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation> {
    const rawSpec = spec as unknown as Record<string, unknown>;
    this.startCalls.push(rawSpec);
    const provider = this.providers.get(spec.provider);
    if (!provider || !provider.start) {
      throw new Error(`Missing subagent provider: ${spec.provider}`);
    }
    const maybeNested = rawSpec['request'] as Record<string, unknown> | undefined;
    const cwd = (maybeNested?.['cwd'] ?? spec.cwd) as string | undefined;
    const prompt = (maybeNested?.['prompt'] ?? spec.prompt) as SubagentActivationSpec['prompt'];
    const parent = (maybeNested?.['parent'] ?? spec.parent) as Agent;
    const run = await provider.start({
      cwd: cwd ?? process.cwd(),
      prompt,
      parent,
      label: spec.label,
      signal: spec.signal,
    });
    return {
      childId: run.id,
      name: spec.name ?? run.id,
      result: run.result,
      dispose: () => run.dispose(),
    };
  }
}

class TestSkillRegistry extends Service {
  readonly providerFactories: Array<(control: { signal: AbortSignal; invalidate(): void }) => {
    readonly name: string;
    list(): Promise<readonly Record<string, unknown>[]>;
    get(candidate: unknown): Promise<Record<string, unknown> | undefined>;
  }> = [];
  invalidations = 0;

  constructor(ctx: Context) {
    super(ctx, 'skills');
  }

  registerProvider(
    create: (control: { signal: AbortSignal; invalidate(): void }) => {
      readonly name: string;
      list(): Promise<readonly Record<string, unknown>[]>;
      get(candidate: unknown): Promise<Record<string, unknown> | undefined>;
    },
  ): () => void {
    const controller = new AbortController();
    const provider = create({
      signal: controller.signal,
      invalidate: () => {
        this.invalidations += 1;
      },
    });
    return this.ctx.effect(() => {
      const factory = () => provider;
      this.providerFactories.push(factory);
      return () => {
        controller.abort();
        const idx = this.providerFactories.indexOf(factory);
        if (idx >= 0) {
          this.providerFactories.splice(idx, 1);
        }
      };
    }, `testSkills.registerProvider(${provider.name})`);
  }
}

function createTestSubprocessClass(
  fakeBinaryPath: string,
  extraEnv?: Readonly<Record<string, string>>,
): typeof LocalSubprocessRuntime {
  return class SubagentIntegrationSubprocess extends LocalSubprocessRuntime {
    override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      if (spec.argv[0] === fakeBinaryPath) {
        return super.spawn({
          ...spec,
          argv: [process.execPath, FAKE_SERVER_PATH, ...spec.argv.slice(1)],
          env: {
            ...spec.env,
            FAKE_AGY_REPLY_TEXT: 'Subagent task completed independently',
            ...extraEnv,
          },
        });
      }
      return super.spawn(spec);
    }
  };
}

describe('subagent bundle Cordis 4.1.0 integration', () => {
  const tempDirs: string[] = [];
  const scopeFibers: Fiber[] = [];

  afterEach(async () => {
    while (scopeFibers.length > 0) {
      const fiber = scopeFibers.pop()!;
      await fiber.dispose().catch(() => {});
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces Cordis 4.1.0 named-export & array-inject metadata for runtime and subagent plugins', () => {
    expect('default' in runtimePlugin).toBe(false);
    expect('default' in subagentPlugin).toBe(false);

    expect(runtimePlugin.name).toBe('antigravity-runtime');
    expect(runtimePlugin.inject).toEqual(['subprocess']);
    expect(typeof runtimePlugin.apply).toBe('function');

    expect(subagentPlugin.name).toBe('subagent-antigravity-acp');
    expect(subagentPlugin.inject).toEqual(['subagents', 'antigravityRuntime']);
    expect(typeof subagentPlugin.apply).toBe('function');
  });

  it('registers provider, antigravity_agent tool, skill, and systemPrompt; picks up live subagent model overrides; and disposes cleanly', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-subagent-bundle-'));
    tempDirs.push(tempDir);

    const binDir = path.join(tempDir, 'bin');
    const profileDir = path.join(tempDir, 'profile');
    const subagentWorkDir = path.join(tempDir, 'subagent-cwd');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(subagentWorkDir, { recursive: true });

    const fakeBinaryPath = path.join(
      binDir,
      process.platform === 'win32' ? 'agy.cmd' : 'agy',
    );
    if (process.platform === 'win32') {
      fs.writeFileSync(
        fakeBinaryPath,
        `@echo off\r\n"${process.execPath}" "${FAKE_SERVER_PATH}" %*\r\n`,
        'utf8',
      );
    } else {
      fs.writeFileSync(
        fakeBinaryPath,
        `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SERVER_PATH}" "$@"\n`,
        { encoding: 'utf8', mode: 0o755 },
      );
    }

    const ctx = new Context();
    let runtimeFiber!: Fiber;
    let subagentPluginFiber!: Fiber;

    const bundleScope = await ctx.plugin(async (scopeCtx) => {
      await scopeCtx.plugin(
        createTestSubprocessClass(fakeBinaryPath, { FAKE_AGY_ECHO_CONTEXT: '1' }),
      );
      await scopeCtx.plugin(TestSubagentRegistry);
      await scopeCtx.plugin(ToolsService);
      await scopeCtx.plugin(SystemPrompt);
      await scopeCtx.plugin(TestSkillRegistry);

      runtimeFiber = await scopeCtx.plugin(runtimePlugin, {
        binaryPath: fakeBinaryPath,
        profileDir,
        autoDownload: false,
        maxConcurrentSessions: 2,
        handshakeTimeoutMs: 10_000,
        requestTimeoutMs: 10_000,
        promptTimeoutMs: 15_000,
        queueTimeoutMs: 10_000,
      });

      subagentPluginFiber = await scopeCtx.plugin(subagentPlugin, {
        providerName: 'antigravity',
        permissionMode: 'yolo',
        defaultModel: 'gemini-2.5-pro',
      });
    });
    scopeFibers.push(bundleScope);

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

    expect(runtimeFiber.state).toBe(2 /* FiberState.ACTIVE */);
    expect(subagentPluginFiber.state).toBe(2 /* FiberState.ACTIVE */);

    // No main LLM provider mounted
    expect(ctx.get('llm')).toBeUndefined();

    // Verify tool registration on ctx.tools
    const toolDef = ctx.tools.get('antigravity_agent');
    expect(toolDef).toBeDefined();
    expect(toolDef?.name).toBe('antigravity_agent');

    // Verify systemPrompt section registration
    const assembled = await ctx.systemPrompt.assemble();
    expect(
      assembled.sections.some(
        (s) => s.name === 'tool:antigravity_agent' && s.text.includes('antigravity_agent'),
      ),
    ).toBe(true);

    // Verify skill provider registration & live dynamic content
    const skillRegistry = ctx.get('skills') as unknown as TestSkillRegistry;
    expect(skillRegistry.providerFactories).toHaveLength(1);
    const skillProvider = skillRegistry.providerFactories[0]({
      signal: new AbortController().signal,
      invalidate: () => {},
    });
    const candidates = await skillProvider.list();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe('antigravity-subagent');
    const skillDocBefore = await skillProvider.get(candidates[0]);
    expect(skillDocBefore?.content).toContain('gemini-2.5-pro');

    // Invoke tool directly with mock ToolRunContext
    const parentAgent = {
      id: brandString<SessionId>('parent-root'),
    } as unknown as Agent;
    const toolExec = {
      agent: parentAgent,
      signal: new AbortController().signal,
      callId: brandString('call-1') as ToolExecution['callId'],
      rootCallId: brandString('call-1') as ToolExecution['callId'],
      name: 'antigravity_agent',
      arguments: {},
      token: Symbol('exec') as ToolExecution['token'],
      deferContext: () => {},
      concludeTurn: () => {},
    };

    const callResult = (await toolDef!.execute(
      {
        description: 'Run independent check',
        prompt: 'Perform subagent work',
        cwd: subagentWorkDir,
      },
      toolExec,
    )) as { subagentId: string; model?: string; stopReason: string; outputText: string };

    expect(callResult.model).toBe('gemini-2.5-pro');
    expect(callResult.stopReason).toBe('completed');
    expect(JSON.parse(callResult.outputText)).toMatchObject({
      model: 'gemini-2.5-pro',
    });

    // Live UI override update changes active model for next call and invalidates skill
    ctx.antigravityRuntime.updateSubagentConfig?.({
      defaultModel: 'gemini-2.5-flash',
      defaultThoughtLevel: 'high',
      permissionMode: 'auto',
    });
    expect(skillRegistry.invalidations).toBeGreaterThanOrEqual(1);
    const skillDocAfter = await skillProvider.get(candidates[0]);
    expect(skillDocAfter?.content).toContain('gemini-2.5-flash');

    const callResult2 = (await toolDef!.execute(
      {
        description: 'Run with updated model',
        prompt: 'Verify updated model selection',
        cwd: subagentWorkDir,
      },
      toolExec,
    )) as { model?: string; thoughtLevel?: string; outputText: string };

    expect(callResult2.model).toBe('gemini-2.5-flash');
    expect(callResult2.thoughtLevel).toBe('high');
    expect(JSON.parse(callResult2.outputText)).toMatchObject({
      model: 'gemini-2.5-flash',
      thoughtLevel: 'high',
      mode: 'auto',
    });

    const runtimeService = ctx.antigravityRuntime;
    const statusBeforeStop = await runtimeService.getStatus();
    expect(statusBeforeStop.installed).toBe(true);
    expect(statusBeforeStop.executable?.source).toBe('configured');
    expect(statusBeforeStop.activeLeases).toBe(0);

    // Unloading subagent plugin alone withdraws tool, skill, and provider while host services remain live.
    await subagentPluginFiber.dispose();
    expect(ctx.tools.get('antigravity_agent')).toBeUndefined();
    expect(
      (ctx.get('subagents') as unknown as TestSubagentRegistry).getProvider('antigravity'),
    ).toBeUndefined();
    expect(skillRegistry.providerFactories).toHaveLength(0);

    // Clean disposal via Cordis fiber disposal tears down runtime pool and remaining host services.
    await bundleScope.dispose();
    scopeFibers.pop();

    const statusAfterStop = await runtimeService.getStatus();
    expect(statusAfterStop.activeLeases).toBe(0);
    expect(statusAfterStop.idleWorkers).toBe(0);
    expect(ctx.get('antigravityRuntime')).toBeUndefined();
    expect(ctx.get('tools')).toBeUndefined();
    expect(ctx.get('subagents')).toBeUndefined();
  });

  it('runs standalone CLI help and status without requiring dsh-subprocess-local', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cli-test-'));
    tempDirs.push(tempDir);

    const fakeBin = path.join(tempDir, process.platform === 'win32' ? 'agy.cmd' : 'agy');
    fs.writeFileSync(fakeBin, '#!/bin/sh\necho ok\n', { encoding: 'utf8', mode: 0o755 });

    const outLines: string[] = [];
    const errLines: string[] = [];
    const helpExit = await runCli(['--help'], {
      stdout: (line) => outLines.push(line),
      stderr: (line) => errLines.push(line),
      readLine: async () => '',
    });
    expect(helpExit).toBe(0);
    expect(errLines).toHaveLength(0);
    expect(outLines.join('\n')).toContain('dsh-antigravity-acp');
    expect(outLines.join('\n')).toContain('login [--code|--loopback]');

    const statusOut: string[] = [];
    const statusErr: string[] = [];
    const statusExit = await runCli(
      ['status', '--profile-dir', path.join(tempDir, 'prof'), '--binary-path', fakeBin, '--json'],
      {
        stdout: (line) => statusOut.push(line),
        stderr: (line) => statusErr.push(line),
        readLine: async () => '',
      },
    );
    expect(statusExit).toBe(0);
    expect(statusErr).toHaveLength(0);
    const parsed = JSON.parse(statusOut.join('\n')) as {
      installed: boolean;
      executable?: { command: string; source: string };
      profile: { authMethod: string };
    };
    expect(parsed.installed).toBe(true);
    expect(parsed.executable?.command).toBe(fakeBin);
    expect(parsed.executable?.source).toBe('configured');
    expect(parsed.profile.authMethod).toBe('oauth-personal');
  });

  it('maps custom AGY_* codes through toLlmError both with and without LlmError.fromFailure', () => {
    const custom = new runtimePlugin.AntigravityAcpError(
      'Native tool denied (Bearer secret-token)',
      'AGY_NATIVE_TOOLS_BLOCKED',
      { status: 403, retryAfterMs: 1500 },
    );

    const viaFromFailure = runtimePlugin.toLlmError(custom);
    expect(viaFromFailure).toBeInstanceOf(LlmError);
    expect(viaFromFailure.code).toBe('AGY_NATIVE_TOOLS_BLOCKED');
    expect(viaFromFailure.message).toBe('Native tool denied (Bearer [REDACTED])');
    expect(viaFromFailure.failure.status).toBe(403);
    expect(viaFromFailure.failure.providerRetryAfterMs).toBe(1500);

    const llmErrorStatic = LlmError as unknown as { fromFailure?: typeof LlmError.fromFailure };
    const originalFromFailure = llmErrorStatic.fromFailure;
    try {
      llmErrorStatic.fromFailure = undefined;
      const viaFallback = runtimePlugin.toLlmError(custom);
      expect(viaFallback).toBeInstanceOf(LlmError);
      expect(viaFallback.code).toBe('AGY_NATIVE_TOOLS_BLOCKED');
      expect(viaFallback.message).toBe('Native tool denied (Bearer [REDACTED])');
      expect(viaFallback.failure.status).toBe(403);
      expect(viaFallback.failure.providerRetryAfterMs).toBe(1500);
    } finally {
      llmErrorStatic.fromFailure = originalFromFailure;
    }
  });
});
