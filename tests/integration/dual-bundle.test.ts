import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service, type Fiber } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { brandString } from '@deepseek-ai/dsh-brand';
import {
  BlockAssembler,
  LlmError,
  LlmRuntime,
  createToolResultMessage,
  createUserMessage,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import * as runtimePlugin from '../../src/index.js';
import * as llmPlugin from '../../src/llm-plugin.js';
import * as subagentPlugin from '../../src/subagent-plugin.js';

const FAKE_SERVER_PATH = fileURLToPath(new URL('../acp/fake-agy-server.mjs', import.meta.url));

class TestSubagentRegistry extends Service {
  private readonly providers = new Map<string, SubagentProvider>();

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
}

function createTestSubprocessClass(
  fakeBinaryPath: string,
  subagentCwd: string,
): typeof LocalSubprocessRuntime {
  return class DualBundleSubprocessRuntime extends LocalSubprocessRuntime {
    override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      if (spec.argv[0] === fakeBinaryPath) {
        const isSubagent = path.resolve(spec.cwd) === path.resolve(subagentCwd);
        return super.spawn({
          ...spec,
          argv: [process.execPath, FAKE_SERVER_PATH, ...spec.argv.slice(1)],
          env: {
            ...spec.env,
            ...(isSubagent
              ? { FAKE_AGY_REPLY_TEXT: 'Subagent task completed independently' }
              : { FAKE_AGY_MCP_TOOL_CALL: '1', FAKE_AGY_MCP_TOOL_NAME: 'calc' }),
          },
        });
      }
      return super.spawn(spec);
    }
  };
}

async function collectStream(stream: AsyncIterable<StreamChunk>): Promise<{
  chunks: StreamChunk[];
  assembler: BlockAssembler;
}> {
  const chunks: StreamChunk[] = [];
  const assembler = new BlockAssembler();
  for await (const chunk of stream) {
    chunks.push(chunk);
    assembler.push(chunk);
  }
  return { chunks, assembler };
}

describe('dual-bundle Cordis 4.1.0 integration', () => {
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

  it('enforces Cordis 4.1.0 named-export & array-inject metadata across all 3 plugin rows', () => {
    expect('default' in runtimePlugin).toBe(false);
    expect('default' in llmPlugin).toBe(false);
    expect('default' in subagentPlugin).toBe(false);

    expect(runtimePlugin.name).toBe('antigravity-runtime');
    expect(runtimePlugin.inject).toEqual(['subprocess']);
    expect(typeof runtimePlugin.apply).toBe('function');

    expect(llmPlugin.name).toBe('llm-antigravity-acp');
    expect(llmPlugin.inject).toEqual(['llm', 'antigravityRuntime']);
    expect(typeof llmPlugin.apply).toBe('function');

    expect(subagentPlugin.name).toBe('subagent-antigravity-acp');
    expect(subagentPlugin.inject).toEqual(['subagents', 'antigravityRuntime']);
    expect(typeof subagentPlugin.apply).toBe('function');
  });

  it('mounts all 3 plugins in Cordis, runs LLM tool roundtrip and Subagent concurrently, and disposes cleanly', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-dual-bundle-'));
    tempDirs.push(tempDir);

    const binDir = path.join(tempDir, 'bin');
    const profileDir = path.join(tempDir, 'profile');
    const llmWorkDir = path.join(tempDir, 'llm-cwd');
    const subagentWorkDir = path.join(tempDir, 'subagent-cwd');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(llmWorkDir, { recursive: true });
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
    const modelsUpdatedProviders: string[] = [];
    let runtimeFiber!: Fiber;
    let llmPluginFiber!: Fiber;
    let subagentPluginFiber!: Fiber;

    const bundleScope = await ctx.plugin(async (scopeCtx) => {
      scopeCtx.on('llm/models-updated', (provider) => {
        modelsUpdatedProviders.push(provider);
      });

      await scopeCtx.plugin(createTestSubprocessClass(fakeBinaryPath, subagentWorkDir));
      await scopeCtx.plugin(LlmRuntime);
      await scopeCtx.plugin(TestSubagentRegistry);

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

      llmPluginFiber = await scopeCtx.plugin(llmPlugin, {
        providerId: 'antigravity-acp',
        providerName: 'Antigravity ACP Test',
        bridgeParkSettleMs: 15,
      });

      subagentPluginFiber = await scopeCtx.plugin(subagentPlugin, {
        providerName: 'antigravity',
        permissionMode: 'yolo',
      });
    });
    scopeFibers.push(bundleScope);

    expect(runtimeFiber.state).toBe(2 /* FiberState.ACTIVE */);
    expect(llmPluginFiber.state).toBe(2 /* FiberState.ACTIVE */);
    expect(subagentPluginFiber.state).toBe(2 /* FiberState.ACTIVE */);

    const providerInfo = ctx.llm.listProviders();
    expect(providerInfo).toEqual([
      { id: 'antigravity-acp', name: 'Antigravity ACP Test' },
    ]);

    const subagentsService = ctx.get('subagents') as unknown as TestSubagentRegistry;
    const subagentProvider = subagentsService.getProvider('antigravity');
    expect(subagentProvider).toBeDefined();
    expect(subagentsService.resolveMaxDepth('provider-managed')).toBeUndefined();

    const tools: ToolSchema[] = [
      {
        name: 'calc',
        description: 'Evaluate arithmetic expression',
        parameters: {
          type: 'object',
          properties: { expr: { type: 'string' } },
          required: ['expr'],
        },
      },
    ];
    const llmSessionId = brandString<SessionId>('dual-bundle-llm-session');
    const userMsg = createUserMessage({
      content: [{ type: 'text', text: 'Compute 6*7 with calc' }],
      source: { kind: 'user' },
    });

    const runLlmRoundtrip = async (): Promise<string> => {
      const seg1 = await collectStream(
        ctx.llm.stream({
          provider: 'antigravity-acp',
          model: 'gemini-2.5-pro',
          sessionId: llmSessionId,
          tools,
          messages: [userMsg],
        }),
      );
      expect(seg1.assembler.finish).toEqual({ kind: 'tool-calls' });
      const toolCalls = seg1.assembler
        .blocks()
        .filter((b) => b.type === 'tool-call');
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe('calc');

      const assistantMsg = seg1.assembler.message({
        provider: 'antigravity-acp',
        model: 'gemini-2.5-pro',
      });
      const toolResultMsg = createToolResultMessage({
        callId: toolCalls[0].id,
        content: [{ type: 'text', text: '42' }],
        isError: false,
      });

      const seg2 = await collectStream(
        ctx.llm.stream({
          provider: 'antigravity-acp',
          model: 'gemini-2.5-pro',
          sessionId: llmSessionId,
          tools,
          messages: [userMsg, assistantMsg, toolResultMsg],
        }),
      );
      expect(seg2.assembler.finish).toEqual({ kind: 'stop' });
      return seg2.assembler
        .blocks()
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    };

    const runSubagentTask = async (): Promise<string> => {
      const run = await subagentProvider!.start!({
        cwd: subagentWorkDir,
        prompt: [{ type: 'text', text: 'Independent subagent job' }],
        parent: { id: brandString<SessionId>('parent-root') } as unknown as Agent,
        signal: new AbortController().signal,
      });
      try {
        const res = await run.result;
        expect(res.stopReason).toBe('completed');
        return res.output.map((b) => (b.type === 'text' ? b.text : '')).join('');
      } finally {
        await run.dispose();
      }
    };

    const [llmText, subagentText] = await Promise.all([
      runLlmRoundtrip(),
      runSubagentTask(),
    ]);

    expect(llmText).toBe('Tool result: 42');
    expect(subagentText).toBe('Subagent task completed independently');

    // Give initial background refreshModels a moment if still settling
    await new Promise((r) => setTimeout(r, 50));
    expect(modelsUpdatedProviders).toContain('antigravity-acp');

    const runtimeService = ctx.antigravityRuntime;
    const statusBeforeStop = await runtimeService.getStatus();
    expect(statusBeforeStop.installed).toBe(true);
    expect(statusBeforeStop.executable?.source).toBe('configured');
    expect(statusBeforeStop.activeLeases).toBe(0);

    // Clean disposal via Cordis fiber disposal tears down all 3 plugins and runtime pool.
    await bundleScope.dispose();
    scopeFibers.pop();

    const statusAfterStop = await runtimeService.getStatus();
    expect(statusAfterStop.activeLeases).toBe(0);
    expect(statusAfterStop.idleWorkers).toBe(0);
    expect(ctx.get('antigravityRuntime')).toBeUndefined();
    expect(ctx.get('llm')).toBeUndefined();
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
