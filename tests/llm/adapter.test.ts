import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import {
  BlockAssembler,
  LlmError,
  LlmRuntime,
  ReasoningEffortId,
  ToolCallId,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  type LlmFailure,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm';
import { brandString, type Branded } from '@deepseek-ai/dsh-brand';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnAcpClient } from '../../src/acp/client.js';
import { AcpWorkerPool } from '../../src/acp/pool.js';
import { AntigravityLlmAdapter, type AdapterLogger } from '../../src/llm/adapter.js';
import { prepareAntigravityProfile, resolveProfileSnapshot } from '../../src/runtime/profile.js';
import {
  LlmPluginConfigSchema,
  RuntimeConfigSchema,
  type LlmPluginConfigInput,
  type RuntimeConfig,
} from '../../src/shared/config.js';
import type { AntigravityExecutable, AntigravityRuntimeService } from '../../src/shared/contracts.js';

const FAKE_SERVER_PATH = fileURLToPath(new URL('../acp/fake-agy-server.mjs', import.meta.url));

function makeSessionId(id: string): Branded<'SessionId'> {
  return brandString<Branded<'SessionId'>>(id);
}

function assertStreamChunkInvariant(chunks: readonly StreamChunk[]): void {
  let finished = false;
  let usageSeen = false;
  let nextExpectedIndex = 0;
  const openBlocks = new Set<number>();
  const closedBlocks = new Set<number>();

  for (const chunk of chunks) {
    expect(finished).toBe(false);

    switch (chunk.type) {
      case 'block-start': {
        expect(usageSeen).toBe(false);
        expect(chunk.index).toBe(nextExpectedIndex);
        nextExpectedIndex += 1;
        expect(openBlocks.size).toBe(0);
        openBlocks.add(chunk.index);
        break;
      }
      case 'text-delta':
      case 'reasoning-delta':
      case 'tool-call-delta': {
        expect(usageSeen).toBe(false);
        expect(openBlocks.has(chunk.index)).toBe(true);
        expect(closedBlocks.has(chunk.index)).toBe(false);
        break;
      }
      case 'block-end': {
        expect(usageSeen).toBe(false);
        expect(openBlocks.has(chunk.index)).toBe(true);
        openBlocks.delete(chunk.index);
        closedBlocks.add(chunk.index);
        break;
      }
      case 'usage': {
        expect(openBlocks.size).toBe(0);
        usageSeen = true;
        break;
      }
      case 'finish': {
        expect(openBlocks.size).toBe(0);
        finished = true;
        break;
      }
    }
  }

  expect(openBlocks.size).toBe(0);
  expect(finished).toBe(true);
}

interface TestHarness {
  readonly ctx: Context;
  readonly runtime: AntigravityRuntimeService;
  readonly pool: AcpWorkerPool;
  readonly adapter: AntigravityLlmAdapter;
  readonly tempDir: string;
  readonly providerId: string;
  readonly counters: {
    spawns: number;
    newSessions: number;
  };
  readonly loggerWarnings: string[];
}

describe('AntigravityLlmAdapter integration with LlmRuntime & fake-agy-server', () => {
  const harnesses: TestHarness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      const h = harnesses.pop()!;
      await h.adapter.dispose().catch(() => {});
      await h.pool.dispose().catch(() => {});
      await h.ctx.fiber.dispose().catch(() => {});
      fs.rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  async function createHarness(options?: {
    readonly fakeEnv?: Record<string, string>;
    readonly llmConfig?: LlmPluginConfigInput;
    readonly runtimeOverrides?: Partial<RuntimeConfig>;
    readonly unauthenticatedDiscovery?: boolean;
    readonly attachments?: AttachmentStore;
  }): Promise<TestHarness> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-llm-test-'));
    const ctx = new Context();
    await ctx.plugin(LocalSubprocessRuntime);
    await ctx.plugin(LlmRuntime);

    const runtimeConfig: RuntimeConfig = {
      ...RuntimeConfigSchema({ profileDir: path.join(tempDir, 'profile') }),
      handshakeTimeoutMs: 10_000,
      requestTimeoutMs: 10_000,
      promptTimeoutMs: 15_000,
      queueTimeoutMs: 10_000,
      idleRecycleMs: 60_000,
      ...options?.runtimeOverrides,
    };

    const executable: AntigravityExecutable = {
      command: process.execPath,
      argsPrefix: [FAKE_SERVER_PATH, 'acp'],
      source: 'configured',
      version: '1.5.2',
    };

    const counters = { spawns: 0, newSessions: 0 };

    const pool = new AcpWorkerPool({
      subprocess: ctx.subprocess,
      config: runtimeConfig,
      resolveExecutable: async () => executable,
      prepareProfile: async (opts) =>
        prepareAntigravityProfile(runtimeConfig, { suppressBrowser: opts?.suppressBrowser }),
      skipVersionCheck: true,
      spawnClientFn: async (spawnOpts) => {
        counters.spawns += 1;
        const client = await spawnAcpClient({
          ...spawnOpts,
          env: {
            ...spawnOpts.env,
            ...options?.fakeEnv,
          },
        });
        const origNewSession = client.newSession.bind(client);
        return {
          ...client,
          async newSession(setup, signal) {
            counters.newSessions += 1;
            return await origNewSession(setup, signal);
          },
        };
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
      listModels: async ({ cwd, signal } = {}) => {
        if (options?.unauthenticatedDiscovery) {
          throw new Error('Authentication required');
        }
        const lease = await pool.acquireWorker({
          cwd: cwd ?? tempDir,
          reuseSession: false,
          signal,
        });
        try {
          return await lease.client.discoverModels(cwd ?? tempDir, signal);
        } finally {
          await lease.release();
        }
      },
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
      spawnClient: (spawnOpts) => pool.spawnClient(spawnOpts),
      warmup: async () => {},
      dispose: () => pool.dispose(),
    };

    const loggerWarnings: string[] = [];
    const logger: AdapterLogger = {
      warn: (msg) => loggerWarnings.push(String(msg)),
    };

    const llmConfig = LlmPluginConfigSchema(options?.llmConfig ?? {});
    const adapter = new AntigravityLlmAdapter(runtime, llmConfig, {
      attachments: options?.attachments,
      logger,
      cwd: tempDir,
    });
    ctx.llm.registerAdapter([llmConfig.providerId], adapter);

    const harness: TestHarness = {
      ctx,
      runtime,
      pool,
      adapter,
      tempDir,
      providerId: llmConfig.providerId,
      counters,
      loggerWarnings,
    };
    harnesses.push(harness);
    return harness;
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
    assertStreamChunkInvariant(chunks);
    return { chunks, assembler };
  }

  it('exposes providerInfo, placeholder when unauthenticated, and overrides/reasoning when discovered', async () => {
    const unauth = await createHarness({ unauthenticatedDiscovery: true });
    expect(unauth.ctx.llm.listProviders()).toEqual([
      { id: 'antigravity-acp', name: 'Antigravity ACP' },
    ]);
    const placeholder = await unauth.ctx.llm.listModels('antigravity-acp');
    expect(placeholder).toHaveLength(1);
    expect(placeholder[0].id).toBe('server-default');
    expect(placeholder[0].badge).toEqual({ text: 'Sign in / Connect', tone: 'warning' });

    const auth = await createHarness({
      llmConfig: {
        contextWindow: 64_000,
        modelOverrides: {
          'gemini-2.5-pro': {
            name: 'Gemini Pro Custom',
            contextWindow: 256_000,
            defaultThoughtLevel: 'high',
          },
        },
      },
    });
    const models = await auth.ctx.llm.listModels('antigravity-acp');
    expect(models.map((m) => m.id)).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
    expect(models[0].name).toBe('Gemini Pro Custom');

    const resolved = await auth.ctx.llm.resolveModelInfo('antigravity-acp', 'gemini-2.5-pro');
    expect(resolved.context).toEqual({ contextWindow: 256_000 });
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual([
      ReasoningEffortId('off'),
      ReasoningEffortId('low'),
      ReasoningEffortId('medium'),
      ReasoningEffortId('high'),
    ]);
    expect(resolved.reasoning?.defaultEffort).toBe(ReasoningEffortId('high'));

    const fallbackResolved = await auth.ctx.llm.resolveModelInfo(
      'antigravity-acp',
      'custom-unlisted-model',
    );
    expect(fallbackResolved.context).toEqual({ contextWindow: 64_000 });
  });

  it('streams reasoning, text, and usage through LlmRuntime + BlockAssembler', async () => {
    const h = await createHarness({
      fakeEnv: {
        FAKE_AGY_THOUGHT: 'Let me think carefully.',
        FAKE_AGY_REPLY_TEXT: 'Hello from fake Antigravity!',
      },
    });

    const prepared = await h.ctx.llm.prepareCall({
      provider: h.providerId,
      model: 'gemini-2.5-pro',
    });

    const { assembler } = await collectStream(
      prepared.stream({
        ...prepared.config,
        system: 'Be concise.',
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: 'Hi' }],
            source: { kind: 'user' },
          }),
        ],
      }),
    );

    expect(assembler.finish).toEqual({ kind: 'stop' });
    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: 'Let me think carefully.' },
      { type: 'text', text: 'Hello from fake Antigravity!' },
    ]);
    expect(assembler.usage).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      reasoningTokens: 5,
    });
    expect(h.pool.getStats().activeLeases).toBe(0);
  });

  it('validates unsupported sampling options per config.ignoreUnsupportedOptions', async () => {
    const strict = await createHarness({
      llmConfig: { ignoreUnsupportedOptions: false },
    });

    const { chunks: errChunks } = await collectStream(
      strict.ctx.llm.stream({
        provider: strict.providerId,
        model: 'gemini-2.5-pro',
        temperature: 0.7,
        maxTokens: 100,
        stop: ['DONE'],
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: 'Hello' }],
            source: { kind: 'user' },
          }),
        ],
      }),
    );
    const terminal = errChunks.at(-1)!;
    expect(terminal.type).toBe('finish');
    if (terminal.type === 'finish' && terminal.reason.kind === 'error') {
      expect(terminal.reason.failure.code).toBe('UNSUPPORTED_OPTION');
    } else {
      expect.unreachable('Expected error finish chunk');
    }

    const permissive = await createHarness({
      llmConfig: { ignoreUnsupportedOptions: true },
      fakeEnv: { FAKE_AGY_REPLY_TEXT: 'Ignored options ok' },
    });
    const { assembler } = await collectStream(
      permissive.ctx.llm.stream({
        provider: permissive.providerId,
        model: 'gemini-2.5-pro',
        temperature: 0.5,
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: 'Hello' }],
            source: { kind: 'user' },
          }),
        ],
      }),
    );
    expect(assembler.finish).toEqual({ kind: 'stop' });
    expect(permissive.loggerWarnings.some((w) => w.includes('temperature'))).toBe(true);
  });

  it('executes multi-round MCP tool continuation inside the SAME ACP session/prompt and propagates isError', async () => {
    const h = await createHarness({
      fakeEnv: {
        FAKE_AGY_MCP_TOOL_CALL: '1',
        FAKE_AGY_MCP_TOOL_NAME: 'calc',
        FAKE_AGY_MCP_TOOL_ARGS: JSON.stringify({ expr: '1+1' }),
        FAKE_AGY_MCP_ROUNDS: '2',
      },
      llmConfig: { bridgeParkSettleMs: 15 },
    });

    const tools: ToolSchema[] = [
      {
        name: 'calc',
        description: 'Calculate expression',
        parameters: {
          type: 'object',
          properties: { expr: { type: 'string' } },
          required: ['expr'],
        },
      },
    ];
    const sessionId = makeSessionId('sess-multi-round');
    const u1 = createUserMessage({
      content: [{ type: 'text', text: 'Run calc twice' }],
      source: { kind: 'user' },
    });

    // Round 1: model parks MCP call #1.
    const round1 = await collectStream(
      h.ctx.llm.stream({
        provider: h.providerId,
        model: 'gemini-2.5-pro',
        sessionId,
        tools,
        messages: [u1],
      }),
    );
    expect(round1.assembler.finish).toEqual({ kind: 'tool-calls' });
    const round1Calls = round1.assembler
      .blocks()
      .filter((b) => b.type === 'tool-call');
    expect(round1Calls).toHaveLength(1);
    expect(round1Calls[0].name).toBe('calc');
    expect(round1Calls[0].arguments).toBe(JSON.stringify({ expr: '1+1' }));

    const a1 = round1.assembler.message({ provider: h.providerId, model: 'gemini-2.5-pro' });
    const tr1 = createToolResultMessage({
      callId: round1Calls[0].id,
      content: [{ type: 'text', text: '2' }],
      isError: false,
    });

    // Round 2: deliver tool result 1 -> model parks MCP call #2 inside the SAME prompt.
    const round2 = await collectStream(
      h.ctx.llm.stream({
        provider: h.providerId,
        model: 'gemini-2.5-pro',
        sessionId,
        tools,
        messages: [u1, a1, tr1],
      }),
    );
    expect(round2.assembler.finish).toEqual({ kind: 'tool-calls' });
    const round2Calls = round2.assembler
      .blocks()
      .filter((b) => b.type === 'tool-call');
    expect(round2Calls).toHaveLength(1);
    expect(round2Calls[0].id).not.toBe(round1Calls[0].id);

    const a2 = round2.assembler.message({ provider: h.providerId, model: 'gemini-2.5-pro' });
    const tr2 = createToolResultMessage({
      callId: round2Calls[0].id,
      content: [{ type: 'text', text: 'division by zero' }],
      isError: true,
    });

    // Round 3: deliver tool result 2 (with isError: true) -> prompt completes.
    const round3 = await collectStream(
      h.ctx.llm.stream({
        provider: h.providerId,
        model: 'gemini-2.5-pro',
        sessionId,
        tools,
        messages: [u1, a1, tr1, a2, tr2],
      }),
    );
    expect(round3.assembler.finish).toEqual({ kind: 'stop' });
    const finalText = round3.assembler
      .blocks()
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    expect(finalText).toBe('Tool result: 2 | ERROR:division by zero');
    // Only 1 ACP session was created across all 3 streaming segments.
    expect(h.counters.newSessions).toBe(1);
    expect(h.pool.getStats().activeLeases).toBe(0);

    // Follow-up user turn after tool continuation should still reuse the SAME ACP session & bridge.
    const aFinal = round3.assembler.message({ provider: h.providerId, model: 'gemini-2.5-pro' });
    const u2 = createUserMessage({
      content: [{ type: 'text', text: 'Next question' }],
      source: { kind: 'user' },
    });
    let followHistory = [u1, a1, tr1, a2, tr2, aFinal, u2];
    let followRes = await collectStream(
      h.ctx.llm.stream({
        provider: h.providerId,
        model: 'gemini-2.5-pro',
        sessionId,
        tools,
        messages: followHistory,
      }),
    );
    while (followRes.assembler.finish.kind === 'tool-calls') {
      const nextCalls = followRes.assembler.blocks().filter((b) => b.type === 'tool-call');
      const nextAsst = followRes.assembler.message({
        provider: h.providerId,
        model: 'gemini-2.5-pro',
      });
      const nextResults = nextCalls.map((call) =>
        createToolResultMessage({
          callId: call.id,
          content: [{ type: 'text', text: 'follow-ok' }],
          isError: false,
        }),
      );
      followHistory = [...followHistory, nextAsst, ...nextResults];
      followRes = await collectStream(
        h.ctx.llm.stream({
          provider: h.providerId,
          model: 'gemini-2.5-pro',
          sessionId,
          tools,
          messages: followHistory,
        }),
      );
    }
    expect(followRes.assembler.finish).toEqual({ kind: 'stop' });
    expect(
      followRes.assembler
        .blocks()
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(''),
    ).toBe('Tool result: follow-ok | follow-ok');
    expect(h.counters.newSessions).toBe(1);
    expect(h.pool.getStats().activeLeases).toBe(0);
  });

  it('aggregates parallel MCP tool calls within bridgeParkSettleMs and delivers all results together', async () => {
    const h = await createHarness({
      fakeEnv: {
        FAKE_AGY_PARALLEL_TOOLS: '2',
      },
      llmConfig: { bridgeParkSettleMs: 60 },
    });

    const tools: ToolSchema[] = [
      {
        name: 'alpha',
        description: 'Tool alpha',
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      },
      {
        name: 'beta',
        description: 'Tool beta',
        parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      },
    ];
    const sessionId = makeSessionId('sess-parallel');
    const u1 = createUserMessage({
      content: [{ type: 'text', text: 'Run parallel' }],
      source: { kind: 'user' },
    });

    const round1 = await collectStream(
      h.ctx.llm.stream({
        provider: h.providerId,
        model: 'gemini-2.5-pro',
        sessionId,
        tools,
        messages: [u1],
      }),
    );
    expect(round1.assembler.finish).toEqual({ kind: 'tool-calls' });
    const calls = round1.assembler.blocks().filter((b) => b.type === 'tool-call');
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.name)).toEqual(['alpha', 'beta']);

    const a1 = round1.assembler.message({ provider: h.providerId, model: 'gemini-2.5-pro' });
    const tr1 = createToolResultMessage({
      callId: calls[0].id,
      content: [{ type: 'text', text: 'resA' }],
      isError: false,
    });
    const tr2 = createToolResultMessage({
      callId: calls[1].id,
      content: [{ type: 'text', text: 'resB' }],
      isError: true,
    });

    const round2 = await collectStream(
      h.ctx.llm.stream({
        provider: h.providerId,
        model: 'gemini-2.5-pro',
        sessionId,
        tools,
        messages: [u1, a1, tr1, tr2],
      }),
    );
    expect(round2.assembler.finish).toEqual({ kind: 'stop' });
    expect(round2.assembler.blocks()).toEqual([
      { type: 'text', text: 'Parallel results: [0:ok]resA [1:err]resB' },
    ]);
  });

  it('aborts stale parked turn and fails with AGY_TOOL_RESULTS_MISSING when trailing tool results are missing or mismatched', async () => {
    const h = await createHarness({
      fakeEnv: {
        FAKE_AGY_MCP_TOOL_CALL: '1',
      },
      llmConfig: { bridgeParkSettleMs: 15 },
    });

    const tools: ToolSchema[] = [
      { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } },
    ];
    const sessionId = makeSessionId('sess-missing-tr');
    const u1 = createUserMessage({
      content: [{ type: 'text', text: 'Call echo' }],
      source: { kind: 'user' },
    });

    const round1 = await collectStream(
      h.ctx.llm.stream({
        provider: h.providerId,
        model: 'gemini-2.5-pro',
        sessionId,
        tools,
        messages: [u1],
      }),
    );
    expect(round1.assembler.finish).toEqual({ kind: 'tool-calls' });
    const a1 = round1.assembler.message({ provider: h.providerId, model: 'gemini-2.5-pro' });
    const wrongResult = createToolResultMessage({
      callId: ToolCallId('wrong-id'),
      content: [{ type: 'text', text: 'nope' }],
      isError: false,
    });

    const badRound = await collectStream(
      h.ctx.llm.stream({
        provider: h.providerId,
        model: 'gemini-2.5-pro',
        sessionId,
        tools,
        messages: [u1, a1, wrongResult],
      }),
    );
    const finishChunk = badRound.chunks.at(-1)!;
    expect(finishChunk.type).toBe('finish');
    if (finishChunk.type === 'finish' && finishChunk.reason.kind === 'error') {
      expect(finishChunk.reason.failure.code).toBe('AGY_TOOL_RESULTS_MISSING');
    } else {
      expect.unreachable('Expected AGY_TOOL_RESULTS_MISSING failure');
    }
    expect(h.pool.getStats().activeLeases).toBe(0);
  });

  it('blocks native Antigravity tools with AGY_NATIVE_TOOLS_BLOCKED and recycles worker', async () => {
    const h = await createHarness({
      fakeEnv: { FAKE_AGY_NATIVE_TOOL: '1' },
    });

    const { chunks } = await collectStream(
      h.ctx.llm.stream({
        provider: h.providerId,
        model: 'gemini-2.5-pro',
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: 'Try native shell' }],
            source: { kind: 'user' },
          }),
        ],
      }),
    );

    const terminal = chunks.at(-1)!;
    expect(terminal.type).toBe('finish');
    if (terminal.type === 'finish' && terminal.reason.kind === 'error') {
      expect(terminal.reason.failure.code).toBe('AGY_NATIVE_TOOLS_BLOCKED');
    } else {
      expect.unreachable('Expected AGY_NATIVE_TOOLS_BLOCKED failure');
    }

    // Verify direct adapter throw also produces LlmError with custom code via LlmError.fromFailure.
    try {
      for await (const _ of h.adapter.stream({
        provider: h.providerId,
        model: 'gemini-2.5-pro',
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: 'Try native shell again' }],
            source: { kind: 'user' },
          }),
        ],
      })) {
        // drain
      }
      expect.unreachable('Expected adapter.stream to throw LlmError');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).code).toBe('AGY_NATIVE_TOOLS_BLOCKED');
    }
    expect(h.pool.getStats().activeLeases).toBe(0);

    // Regression: native tool whose title merely mentions `dsh_tools` as a substring must still be blocked.
    const spoofedTitleHarness = await createHarness({
      fakeEnv: {
        FAKE_AGY_NATIVE_TOOL: '1',
        FAKE_AGY_PERMISSION_TITLE: 'Read file dsh_tools.ts',
      },
    });
    const spoofedRes = await collectStream(
      spoofedTitleHarness.ctx.llm.stream({
        provider: spoofedTitleHarness.providerId,
        model: 'gemini-2.5-pro',
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: 'Read file dsh_tools.ts' }],
            source: { kind: 'user' },
          }),
        ],
      }),
    );
    const spoofedFinish = spoofedRes.chunks.at(-1)!;
    expect(spoofedFinish.type).toBe('finish');
    if (spoofedFinish.type === 'finish' && spoofedFinish.reason.kind === 'error') {
      expect(spoofedFinish.reason.failure.code).toBe('AGY_NATIVE_TOOLS_BLOCKED');
    } else {
      expect.unreachable('Expected AGY_NATIVE_TOOLS_BLOCKED for spoofed title');
    }
    expect(spoofedTitleHarness.pool.getStats().activeLeases).toBe(0);
  });

  it('reuses ACP session for strictly extending history and rebuilds on model/system/compaction changes', async () => {
    const h = await createHarness({
      fakeEnv: { FAKE_AGY_ECHO_CONTEXT: '1' },
      llmConfig: { reuseSessions: true },
    });

    const sessionId = makeSessionId('sess-reuse');
    const sys1 = createSystemMessage('System A');
    const u1 = createUserMessage({
      content: [{ type: 'text', text: 'FIRST_USER_MSG' }],
      source: { kind: 'user' },
    });

    // Turn 1: fresh session.
    const r1 = await collectStream(
      h.ctx.llm.stream({
        provider: h.providerId,
        model: 'gemini-2.5-pro',
        sessionId,
        messages: [sys1, u1],
      }),
    );
    expect(h.counters.newSessions).toBe(1);
    const echo1 = JSON.parse(
      (r1.assembler.blocks()[0] as { type: 'text'; text: string }).text,
    ) as { prompt: Array<{ text?: string }>; sessionMeta: unknown };
    expect(echo1.prompt.map((p) => p.text).join('\n')).toContain('FIRST_USER_MSG');

    const a1 = r1.assembler.message({ provider: h.providerId, model: 'gemini-2.5-pro' });
    const u2 = createUserMessage({
      content: [{ type: 'text', text: 'SECOND_USER_MSG' }],
      source: { kind: 'user' },
    });

    // Turn 2: strict extension -> MUST reuse ACP session and send ONLY SECOND_USER_MSG delta!
    const r2 = await collectStream(
      h.ctx.llm.stream({
        provider: h.providerId,
        model: 'gemini-2.5-pro',
        sessionId,
        messages: [sys1, u1, a1, u2],
      }),
    );
    expect(h.counters.newSessions).toBe(1);
    const echo2 = JSON.parse(
      (r2.assembler.blocks()[0] as { type: 'text'; text: string }).text,
    ) as { prompt: Array<{ text?: string }> };
    const prompt2Text = echo2.prompt.map((p) => p.text).join('\n');
    expect(prompt2Text).toContain('SECOND_USER_MSG');
    expect(prompt2Text).not.toContain('FIRST_USER_MSG');

    // Turn 3: compaction (edited u1) -> MUST rebuild session cleanly!
    const a2 = r2.assembler.message({ provider: h.providerId, model: 'gemini-2.5-pro' });
    const u1Compacted = createUserMessage({
      content: [{ type: 'text', text: 'COMPACTED_HISTORY' }],
      source: { kind: 'user' },
    });
    const u3 = createUserMessage({
      content: [{ type: 'text', text: 'THIRD_USER_MSG' }],
      source: { kind: 'user' },
    });

    const r3 = await collectStream(
      h.ctx.llm.stream({
        provider: h.providerId,
        model: 'gemini-2.5-pro',
        sessionId,
        messages: [sys1, u1Compacted, a2, u3],
      }),
    );
    expect(h.counters.newSessions).toBe(2);
    const echo3 = JSON.parse(
      (r3.assembler.blocks()[0] as { type: 'text'; text: string }).text,
    ) as { prompt: Array<{ text?: string }> };
    const prompt3Text = echo3.prompt.map((p) => p.text).join('\n');
    expect(prompt3Text).toContain('COMPACTED_HISTORY');
    expect(prompt3Text).toContain('THIRD_USER_MSG');

    // Turn 4: model change -> MUST rebuild session cleanly!
    const a3 = r3.assembler.message({ provider: h.providerId, model: 'gemini-2.5-pro' });
    const u4 = createUserMessage({
      content: [{ type: 'text', text: 'FOURTH_MODEL_SWITCH' }],
      source: { kind: 'user' },
    });
    await collectStream(
      h.ctx.llm.stream({
        provider: h.providerId,
        model: 'gemini-2.5-flash',
        sessionId,
        messages: [sys1, u1Compacted, a2, u3, a3, u4],
      }),
    );
    expect(h.counters.newSessions).toBe(3);
  });

  it('throws EMPTY_RESPONSE on zero-block end_turn and AGY_AUTH_REQUIRED when sign-in is needed', async () => {
    const emptyHarness = await createHarness({
      fakeEnv: { FAKE_AGY_EMPTY_RESPONSE: '1' },
    });
    const emptyRes = await collectStream(
      emptyHarness.ctx.llm.stream({
        provider: emptyHarness.providerId,
        model: 'gemini-2.5-pro',
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: 'Empty please' }],
            source: { kind: 'user' },
          }),
        ],
      }),
    );
    const emptyFinish = emptyRes.chunks.at(-1)!;
    expect(emptyFinish.type).toBe('finish');
    if (emptyFinish.type === 'finish' && emptyFinish.reason.kind === 'error') {
      expect(emptyFinish.reason.failure.code).toBe('EMPTY_RESPONSE');
    } else {
      expect.unreachable('Expected EMPTY_RESPONSE');
    }

    const authHarness = await createHarness({
      fakeEnv: { FAKE_AGY_AUTH_REQUIRED: '1' },
    });
    const authRes = await collectStream(
      authHarness.ctx.llm.stream({
        provider: authHarness.providerId,
        model: 'gemini-2.5-pro',
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: 'Needs auth' }],
            source: { kind: 'user' },
          }),
        ],
      }),
    );
    const authFinish = authRes.chunks.at(-1)!;
    expect(authFinish.type).toBe('finish');
    if (authFinish.type === 'finish' && authFinish.reason.kind === 'error') {
      expect(authFinish.reason.failure.code).toBe('AGY_AUTH_REQUIRED');
    } else {
      expect.unreachable('Expected AGY_AUTH_REQUIRED');
    }
  });

  it('cleans up cleanly on AbortSignal mid-stream and mid-park', async () => {
    // 1. Mid-stream abort
    const midStream = await createHarness({
      fakeEnv: { FAKE_AGY_DELAY_MS: '5000' },
    });
    const ac1 = new AbortController();
    setTimeout(() => ac1.abort(), 80);

    const r1 = await collectStream(
      midStream.ctx.llm.stream({
        provider: midStream.providerId,
        model: 'gemini-2.5-pro',
        signal: ac1.signal,
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: 'Wait slowly' }],
            source: { kind: 'user' },
          }),
        ],
      }),
    );
    const term1 = r1.chunks.at(-1)!;
    expect(term1.type).toBe('finish');
    if (term1.type === 'finish') {
      expect(term1.reason.kind).toBe('aborted');
      if (term1.reason.kind === 'aborted') {
        expect((term1.reason.failure as LlmFailure).code).toBe('ABORTED');
      }
    }
    expect(midStream.pool.getStats().activeLeases).toBe(0);

    // 2. Mid-park abort (parked on tool call, then Round 2 aborted or adapter disposed)
    const midPark = await createHarness({
      fakeEnv: {
        FAKE_AGY_MCP_TOOL_CALL: '1',
      },
      llmConfig: { bridgeParkSettleMs: 15 },
    });
    const tools: ToolSchema[] = [
      { name: 'slow_tool', description: 'slow', parameters: { type: 'object', properties: {} } },
    ];
    const sid = makeSessionId('sess-mid-park-abort');
    const u1 = createUserMessage({
      content: [{ type: 'text', text: 'Call slow_tool' }],
      source: { kind: 'user' },
    });
    const parkedRound = await collectStream(
      midPark.ctx.llm.stream({
        provider: midPark.providerId,
        model: 'gemini-2.5-pro',
        sessionId: sid,
        tools,
        messages: [u1],
      }),
    );
    expect(parkedRound.assembler.finish).toEqual({ kind: 'tool-calls' });
    expect(midPark.pool.getStats().activeLeases).toBe(1);

    // Disposing adapter aborts the parked turn, cancels ACP prompt, closes MCP bridge, and releases lease.
    await midPark.adapter.dispose();
    expect(midPark.pool.getStats().activeLeases).toBe(0);
  });

  it('prepends system prompt fallback when agent does not support systemPrompt.append', async () => {
    const h = await createHarness({
      fakeEnv: {
        FAKE_AGY_SYSTEM_PROMPT_APPEND: '0',
        FAKE_AGY_ECHO_CONTEXT: '1',
      },
    });
    const res = await collectStream(
      h.ctx.llm.stream({
        provider: h.providerId,
        model: 'gemini-2.5-pro',
        system: 'FALLBACK_SYSTEM_RULE',
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: 'USER_QUERY' }],
            source: { kind: 'user' },
          }),
        ],
      }),
    );
    const echoed = JSON.parse(
      (res.assembler.blocks()[0] as { type: 'text'; text: string }).text,
    ) as { prompt: Array<{ text?: string }>; sessionMeta: unknown };
    expect(echoed.sessionMeta).toBeNull();
    const fullPrompt = echoed.prompt.map((p) => p.text).join('\n');
    expect(fullPrompt).toContain('FALLBACK_SYSTEM_RULE');
    expect(fullPrompt).toContain('USER_QUERY');
  });

  it('propagates AGY_TOOL_CATALOG_INVALID, AGY_TOOL_TIMEOUT while parked, and encodes/degrades images', async () => {
    const invalidCatalogHarness = await createHarness();
    const invalidRes = await collectStream(
      invalidCatalogHarness.ctx.llm.stream({
        provider: invalidCatalogHarness.providerId,
        model: 'gemini-2.5-pro',
        tools: [{ name: '', description: 'invalid', parameters: {} }],
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: 'bad tools' }],
            source: { kind: 'user' },
          }),
        ],
      }),
    );
    const invalidFinish = invalidRes.chunks.at(-1)!;
    expect(invalidFinish.type).toBe('finish');
    if (invalidFinish.type === 'finish' && invalidFinish.reason.kind === 'error') {
      expect(invalidFinish.reason.failure.code).toBe('AGY_TOOL_CATALOG_INVALID');
    } else {
      expect.unreachable('Expected AGY_TOOL_CATALOG_INVALID');
    }

    // Timeout while parked between tool-calls and continuation.
    const timeoutHarness = await createHarness({
      fakeEnv: { FAKE_AGY_MCP_TOOL_CALL: '1' },
      llmConfig: { bridgeParkSettleMs: 10, toolTimeoutMs: 80 },
    });
    const tools: ToolSchema[] = [
      { name: 'slow_op', description: 'slow', parameters: { type: 'object', properties: {} } },
    ];
    const sidTimeout = makeSessionId('sess-park-timeout');
    const uTimeout = createUserMessage({
      content: [{ type: 'text', text: 'Call slow_op' }],
      source: { kind: 'user' },
    });
    const rTimeout1 = await collectStream(
      timeoutHarness.ctx.llm.stream({
        provider: timeoutHarness.providerId,
        model: 'gemini-2.5-pro',
        sessionId: sidTimeout,
        tools,
        messages: [uTimeout],
      }),
    );
    const timeoutCall = rTimeout1.assembler.blocks().find((b) => b.type === 'tool-call')!;
    const aTimeout = rTimeout1.assembler.message({
      provider: timeoutHarness.providerId,
      model: 'gemini-2.5-pro',
    });
    await new Promise((r) => setTimeout(r, 150));

    const rTimeout2 = await collectStream(
      timeoutHarness.ctx.llm.stream({
        provider: timeoutHarness.providerId,
        model: 'gemini-2.5-pro',
        sessionId: sidTimeout,
        tools,
        messages: [
          uTimeout,
          aTimeout,
          createToolResultMessage({
            callId: timeoutCall.id,
            content: [{ type: 'text', text: 'too late' }],
            isError: false,
          }),
        ],
      }),
    );
    const timeoutFinish = rTimeout2.chunks.at(-1)!;
    expect(timeoutFinish.type).toBe('finish');
    if (timeoutFinish.type === 'finish' && timeoutFinish.reason.kind === 'error') {
      expect(timeoutFinish.reason.failure.code).toBe('AGY_TOOL_TIMEOUT');
    } else {
      expect.unreachable('Expected AGY_TOOL_TIMEOUT');
    }
    expect(timeoutHarness.pool.getStats().activeLeases).toBe(0);

    // Multimodal image forwarding and text-only ACP server degradation.
    const imgRef: ImageAttachmentRef = {
      attachmentId: 'sha256:abcdef0123456789abcdef0123456789' as any,
      mediaType: 'image/png',
      bytes: 4,
      width: 2,
      height: 2,
      name: 'pixel.png',
    };
    const attachments = {
      readImage: async () => ({ ref: imgRef, data: new Uint8Array([1, 2, 3, 4]) }),
      fileHostPath: () => undefined,
    } as unknown as AttachmentStore;

    const imgSupported = await createHarness({
      fakeEnv: { FAKE_AGY_ECHO_CONTEXT: '1', FAKE_AGY_CAP_IMAGES: '1' },
      attachments,
    });
    const imgRes1 = await collectStream(
      imgSupported.ctx.llm.stream({
        provider: imgSupported.providerId,
        model: 'gemini-2.5-pro',
        messages: [
          createUserMessage({
            content: [
              { type: 'text', text: 'Inspect pixel' },
              { type: 'image', attachment: imgRef },
            ],
            source: { kind: 'user' },
          }),
        ],
      }),
    );
    const echoedImg1 = JSON.parse(
      (imgRes1.assembler.blocks()[0] as { type: 'text'; text: string }).text,
    ) as { prompt: Array<{ type: string; mimeType?: string; data?: string }> };
    expect(echoedImg1.prompt.some((b) => b.type === 'image' && b.mimeType === 'image/png')).toBe(
      true,
    );

    const imgUnsupported = await createHarness({
      fakeEnv: { FAKE_AGY_ECHO_CONTEXT: '1', FAKE_AGY_CAP_IMAGES: '0' },
      attachments,
    });
    const imgRes2 = await collectStream(
      imgUnsupported.ctx.llm.stream({
        provider: imgUnsupported.providerId,
        model: 'gemini-2.5-pro',
        messages: [
          createUserMessage({
            content: [
              { type: 'text', text: 'Inspect pixel' },
              { type: 'image', attachment: imgRef },
            ],
            source: { kind: 'user' },
          }),
        ],
      }),
    );
    const echoedImg2 = JSON.parse(
      (imgRes2.assembler.blocks()[0] as { type: 'text'; text: string }).text,
    ) as { prompt: Array<{ type: string; text?: string }> };
    expect(echoedImg2.prompt.every((b) => b.type === 'text')).toBe(true);
    expect(echoedImg2.prompt.map((b) => b.text).join('\n')).toContain('text only');
  });
});
