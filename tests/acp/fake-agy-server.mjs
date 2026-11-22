#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const AUTH_STDOUT_PREFIX = 'Open the following link to authenticate the ACP server: ';
const AUTH_BROWSER_MARKER = '__DSH_ANTIGRAVITY_AUTH_URL__';
const DEFAULT_AUTH_URL =
  'https://accounts.google.com/o/oauth2/auth?client_id=fake-agy-client&redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2Fcallback&response_type=code&state=fake-state';
const DEFAULT_CODE_LOGIN_URL =
  'https://accounts.google.com/o/oauth2/auth?client_id=fake-agy-client&redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob&response_type=code&state=fake-code-state';

const args = process.argv.slice(2);

function readArgFlag(flagName) {
  const idx = args.indexOf(flagName);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

if (args.includes('--login')) {
  const loginUrl = process.env.FAKE_AGY_LOGIN_URL || DEFAULT_CODE_LOGIN_URL;
  process.stdout.write(`${AUTH_STDOUT_PREFIX}${loginUrl}\n`);

  let inputBuf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    inputBuf += chunk;
    const nl = inputBuf.indexOf('\n');
    if (nl === -1) {
      return;
    }
    const line = inputBuf.slice(0, nl).trim();
    if (!line || line.includes('invalid') || process.env.FAKE_AGY_LOGIN_FAIL === '1') {
      process.stderr.write('Invalid authorization code\n');
      process.exit(1);
    }

    const geminiDir = readArgFlag('--gemini-dir');
    const appDataDir = readArgFlag('--app-data-dir') || 'antigravity-acp';
    if (geminiDir && process.env.FAKE_AGY_WRITE_TOKEN === '1') {
      const tokenDir = path.join(geminiDir, appDataDir);
      fs.mkdirSync(tokenDir, { recursive: true });
      fs.writeFileSync(
        path.join(tokenDir, 'oauth_creds.json'),
        JSON.stringify({
          access_token: 'fake-access-token',
          refresh_token: 'fake-refresh-token',
          expiry_date: Date.now() + 3600_000,
        }),
        'utf8',
      );
    }
    process.exit(0);
  });
  process.stdin.resume();
} else {
  runAcpServer();
}

function runAcpServer() {
  if (process.env.FAKE_AGY_CRASH === 'startup') {
    process.stderr.write('Simulated startup crash\n');
    process.exit(1);
  }

  let clientInfo = null;
  let clientCapabilities = null;
  let nextRpcId = 1000;
  const sessions = new Map();
  const pendingOutgoingRequests = new Map();
  const activePromptControllers = new Map();

  function writeJson(msg) {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  function sendResponse(id, result) {
    writeJson({ jsonrpc: '2.0', id, result });
  }

  function sendError(id, code, message, data) {
    writeJson({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        ...(data !== undefined ? { data } : {}),
      },
    });
  }

  function sendNotification(method, params) {
    writeJson({ jsonrpc: '2.0', method, params });
  }

  function sendClientRequest(method, params) {
    const id = nextRpcId++;
    return new Promise((resolve, reject) => {
      pendingOutgoingRequests.set(id, { resolve, reject });
      writeJson({ jsonrpc: '2.0', id, method, params });
    });
  }

  function buildDefaultConfigOptions(model = 'gemini-2.5-pro', thoughtLevel = 'medium') {
    return [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: model,
        options: [
          {
            value: 'gemini-2.5-pro',
            name: 'Gemini 2.5 Pro',
            description: 'High-capability Gemini reasoning model',
          },
          {
            value: 'gemini-2.5-flash',
            name: 'Gemini 2.5 Flash',
            description: 'Fast low-latency Gemini model',
          },
        ],
      },
      {
        id: 'thought_level',
        name: 'Thinking Level',
        category: 'thought_level',
        type: 'select',
        currentValue: thoughtLevel,
        options: [
          { value: 'off', name: 'Off' },
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
    ];
  }

  function buildDefaultModes(mode = 'default') {
    return {
      currentModeId: mode,
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'auto', name: 'Auto' },
      ],
    };
  }

  function emitAuthDecorationsIfConfigured(phase) {
    const emitPhase = process.env.FAKE_AGY_EMIT_AUTH_LINE_ON || 'initialize';
    if (process.env.FAKE_AGY_EMIT_AUTH_LINE && emitPhase === phase) {
      const authUrl =
        process.env.FAKE_AGY_EMIT_AUTH_LINE === '1'
          ? DEFAULT_AUTH_URL
          : process.env.FAKE_AGY_EMIT_AUTH_LINE;
      process.stdout.write(`${AUTH_STDOUT_PREFIX}${authUrl}\n`);
    }
    if (process.env.FAKE_AGY_EMIT_BROWSER_MARKER && emitPhase === phase) {
      const authUrl =
        process.env.FAKE_AGY_EMIT_BROWSER_MARKER === '1'
          ? DEFAULT_AUTH_URL
          : process.env.FAKE_AGY_EMIT_BROWSER_MARKER;
      process.stderr.write(`${AUTH_BROWSER_MARKER}${JSON.stringify(authUrl)}\n`);
    }
  }

  async function callMcpHttp(mcpServer, method, params, isNotification = false, signal) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    for (const h of mcpServer.headers || []) {
      headers[h.name] = h.value;
    }

    const body = isNotification
      ? { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }
      : { jsonrpc: '2.0', id: randomUUID(), method, ...(params !== undefined ? { params } : {}) };

    const res = await fetch(mcpServer.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (isNotification) {
      return undefined;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP HTTP ${res.status}: ${text}`);
    }
    const payload = await res.json();
    if (payload.error) {
      throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
    }
    return payload.result;
  }

  function synthesizeToolArgs(toolDef) {
    if (process.env.FAKE_AGY_MCP_TOOL_ARGS) {
      return JSON.parse(process.env.FAKE_AGY_MCP_TOOL_ARGS);
    }
    const schema = toolDef?.inputSchema;
    const props = schema && typeof schema.properties === 'object' ? schema.properties : {};
    const required = Array.isArray(schema?.required) ? schema.required : [];
    const result = {};
    for (const key of required) {
      const prop = props?.[key];
      if (!prop || prop.type === 'string') {
        result[key] = 'test-value';
      } else if (prop.type === 'number' || prop.type === 'integer') {
        result[key] = 1;
      } else if (prop.type === 'boolean') {
        result[key] = true;
      } else if (prop.type === 'array') {
        result[key] = [];
      } else if (prop.type === 'object') {
        result[key] = {};
      }
    }
    return result;
  }

  async function ensureMcpInitialized(session, signal) {
    const httpServer = (session.mcpServers || []).find((s) => s && s.type === 'http');
    if (!httpServer) {
      throw new Error('No HTTP MCP server configured on session');
    }
    if (!session.mcpInitialized) {
      await callMcpHttp(
        httpServer,
        'initialize',
        {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'fake-agy-server', version: '1.5.2' },
        },
        false,
        signal,
      );
      await callMcpHttp(httpServer, 'notifications/initialized', {}, true, signal);
      session.mcpInitialized = true;
    }
    const listResult = await callMcpHttp(httpServer, 'tools/list', {}, false, signal);
    return { httpServer, tools: listResult?.tools || [] };
  }

  function extractPromptText(promptBlocks) {
    const parts = [];
    for (const block of promptBlocks || []) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (block?.type === 'image') {
        parts.push(`[image:${block.mimeType}]`);
      }
    }
    return parts.join('\n');
  }

  function emitText(sessionId, text) {
    if (!text) return;
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    });
  }

  function emitThought(sessionId, text) {
    if (!text) return;
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text },
      },
    });
  }

  function standardPermissionOptions() {
    return [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
      { optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' },
    ];
  }

  function isAllowOptionId(optionId) {
    return optionId === 'allow_once' || optionId === 'allow_always';
  }

  async function handlePrompt(id, params) {
    const session = sessions.get(params.sessionId);
    if (!session) {
      sendError(id, -32602, `Unknown sessionId: ${params.sessionId}`);
      return;
    }

    if (process.env.FAKE_AGY_CRASH === 'prompt' || process.env.FAKE_AGY_CRASH === '1') {
      emitText(session.id, 'partial-before-crash');
      process.stderr.write('Simulated prompt crash\n');
      process.exit(1);
    }

    const controller = new AbortController();
    const cancelPrompt = () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };
    activePromptControllers.set(session.id, { cancel: cancelPrompt, id });

    try {
      const delayMs = Number(process.env.FAKE_AGY_DELAY_MS || 0);
      if (Number.isFinite(delayMs) && delayMs > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          controller.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (controller.signal.aborted) {
          sendResponse(id, { stopReason: 'cancelled' });
          return;
        }
      }

      if (process.env.FAKE_AGY_NATIVE_TOOL === '1') {
        const permResp = await sendClientRequest('session/request_permission', {
          sessionId: session.id,
          toolCall: {
            toolCallId: `native-${randomUUID().slice(0, 8)}`,
            kind: process.env.FAKE_AGY_PERMISSION_KIND || 'execute',
            title: process.env.FAKE_AGY_PERMISSION_TITLE || 'Run shell command',
            rawInput: { command: 'echo native' },
          },
          options: standardPermissionOptions(),
        });

        if (controller.signal.aborted) {
          sendResponse(id, { stopReason: 'cancelled' });
          return;
        }

        const outcome = permResp?.outcome;
        if (outcome?.outcome === 'selected' && isAllowOptionId(outcome.optionId)) {
          const toolCallId = `native-exec-${randomUUID().slice(0, 6)}`;
          sendNotification('session/update', {
            sessionId: session.id,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: 'Run shell command',
              kind: 'execute',
              status: 'in_progress',
              rawInput: { command: 'echo native' },
            },
          });
          sendNotification('session/update', {
            sessionId: session.id,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: 'completed',
              rawOutput: { stdout: 'native\n' },
            },
          });
          emitText(session.id, 'Native tool executed');
          sendResponse(id, { stopReason: 'end_turn' });
          return;
        }

        sendResponse(id, {
          stopReason: controller.signal.aborted ? 'cancelled' : 'refusal',
        });
        return;
      }

      if (process.env.FAKE_AGY_PERMISSION_PROMPT === '1') {
        const permResp = await sendClientRequest('session/request_permission', {
          sessionId: session.id,
          toolCall: {
            toolCallId: `perm-${randomUUID().slice(0, 8)}`,
            kind: process.env.FAKE_AGY_PERMISSION_KIND || 'execute',
            title: process.env.FAKE_AGY_PERMISSION_TITLE || 'Execute command',
            rawInput: { command: 'echo hello' },
          },
          options: standardPermissionOptions(),
        });

        if (controller.signal.aborted) {
          sendResponse(id, { stopReason: 'cancelled' });
          return;
        }

        const outcome = permResp?.outcome;
        if (outcome?.outcome === 'selected' && isAllowOptionId(outcome.optionId)) {
          emitText(session.id, `Permission allowed:${outcome.optionId}`);
          sendResponse(id, { stopReason: 'end_turn' });
        } else {
          const rejectReason =
            outcome?.outcome === 'cancelled'
              ? 'Permission cancelled'
              : `Permission rejected:${outcome?.optionId || 'none'}`;
          emitText(session.id, rejectReason);
          sendResponse(id, {
            stopReason: process.env.FAKE_AGY_PERMISSION_REJECT_STOP_REASON || 'refusal',
          });
        }
        return;
      }

      if (process.env.FAKE_AGY_EMPTY_RESPONSE === '1') {
        sendResponse(id, {
          stopReason: process.env.FAKE_AGY_STOP_REASON || 'end_turn',
          usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
        });
        return;
      }

      if (process.env.FAKE_AGY_THOUGHT) {
        const thoughtText =
          process.env.FAKE_AGY_THOUGHT === '1'
            ? 'Thinking through the problem...'
            : process.env.FAKE_AGY_THOUGHT;
        emitThought(session.id, thoughtText);
      }

      if (process.env.FAKE_AGY_PARALLEL_TOOLS) {
        const { httpServer, tools } = await ensureMcpInitialized(session, controller.signal);
        const count = Math.max(
          2,
          Number.isFinite(Number(process.env.FAKE_AGY_PARALLEL_TOOLS)) &&
            Number(process.env.FAKE_AGY_PARALLEL_TOOLS) > 1
            ? Number(process.env.FAKE_AGY_PARALLEL_TOOLS)
            : 2,
        );

        const invocations = [];
        for (let i = 0; i < count; i++) {
          const toolDef = tools[i % Math.max(1, tools.length)] || { name: 'echo' };
          const toolArgs = synthesizeToolArgs(toolDef);
          const perm = await sendClientRequest('session/request_permission', {
            sessionId: session.id,
            toolCall: {
              toolCallId: `mcp-p-${i + 1}`,
              kind: 'execute',
              title: `${httpServer.name}/${toolDef.name}`,
              name: toolDef.name,
              rawInput: toolArgs,
              _meta: { is_mcp_tool_call: true, mcpServer: httpServer.name },
            },
            options: standardPermissionOptions(),
          });
          if (perm?.outcome?.outcome !== 'selected' || !isAllowOptionId(perm.outcome.optionId)) {
            sendResponse(id, { stopReason: 'cancelled' });
            return;
          }
          invocations.push(
            callMcpHttp(
              httpServer,
              'tools/call',
              { name: toolDef.name, arguments: toolArgs },
              false,
              controller.signal,
            ),
          );
        }

        const results = await Promise.all(invocations);
        if (controller.signal.aborted) {
          sendResponse(id, { stopReason: 'cancelled' });
          return;
        }
        const summary = results
          .map((r, idx) => {
            const text = (r?.content || []).map((c) => c.text || '').join('');
            return `[${idx}:${r?.isError ? 'err' : 'ok'}]${text}`;
          })
          .join(' ');
        emitText(session.id, `Parallel results: ${summary}`);
        sendResponse(id, {
          stopReason: process.env.FAKE_AGY_STOP_REASON || 'end_turn',
          usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
        });
        return;
      }

      if (process.env.FAKE_AGY_MCP_TOOL_CALL) {
        const { httpServer, tools } = await ensureMcpInitialized(session, controller.signal);
        let desiredName = process.env.FAKE_AGY_MCP_TOOL_NAME;
        let explicitArgs;
        if (process.env.FAKE_AGY_MCP_TOOL_CALL.trim().startsWith('{')) {
          const parsedCfg = JSON.parse(process.env.FAKE_AGY_MCP_TOOL_CALL);
          desiredName = desiredName || parsedCfg.name;
          explicitArgs = parsedCfg.arguments;
        }

        const toolDef =
          tools.find((t) => t.name === desiredName) ||
          tools[0] || { name: desiredName || 'echo' };
        const rounds = Math.max(1, Number(process.env.FAKE_AGY_MCP_ROUNDS || 1));
        const roundSummaries = [];

        for (let r = 0; r < rounds; r++) {
          const toolArgs = explicitArgs ?? synthesizeToolArgs(toolDef);
          const perm = await sendClientRequest('session/request_permission', {
            sessionId: session.id,
            toolCall: {
              toolCallId: `mcp-r${r + 1}`,
              kind: 'execute',
              title: `${httpServer.name}/${toolDef.name}`,
              name: toolDef.name,
              rawInput: toolArgs,
              _meta: { is_mcp_tool_call: true, mcpServer: httpServer.name },
            },
            options: standardPermissionOptions(),
          });
          if (perm?.outcome?.outcome !== 'selected' || !isAllowOptionId(perm.outcome.optionId)) {
            sendResponse(id, { stopReason: 'cancelled' });
            return;
          }

          const res = await callMcpHttp(
            httpServer,
            'tools/call',
            { name: toolDef.name, arguments: toolArgs },
            false,
            controller.signal,
          );
          if (controller.signal.aborted) {
            sendResponse(id, { stopReason: 'cancelled' });
            return;
          }
          const resultText = (res?.content || []).map((c) => c.text || '').join('');
          roundSummaries.push(`${res?.isError ? 'ERROR:' : ''}${resultText}`);
        }

        emitText(session.id, `Tool result: ${roundSummaries.join(' | ')}`);
        sendResponse(id, {
          stopReason: process.env.FAKE_AGY_STOP_REASON || 'end_turn',
          usage: { inputTokens: 18, outputTokens: 12, totalTokens: 30 },
        });
        return;
      }

      if (process.env.FAKE_AGY_ECHO_CONTEXT === '1') {
        const contextPayload = {
          clientInfo,
          clientCapabilities,
          sessionMeta: session.meta ?? null,
          model: session.model,
          thoughtLevel: session.thoughtLevel,
          mode: session.mode,
          cwd: session.cwd,
          additionalDirectories: session.additionalDirectories ?? [],
          mcpServerCount: session.mcpServers.length,
          prompt: params.prompt,
          envSample: {
            GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? null,
            GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? null,
            GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT ?? null,
            GEMINI_HOME: process.env.GEMINI_HOME ?? null,
            AGY_ACP_FORCE_FILE_STORAGE: process.env.AGY_ACP_FORCE_FILE_STORAGE ?? null,
            SSH_CONNECTION: process.env.SSH_CONNECTION ?? null,
            BROWSER: process.env.BROWSER ?? null,
          },
        };
        emitText(session.id, JSON.stringify(contextPayload));
      } else {
        const promptText = extractPromptText(params.prompt);
        const reply =
          process.env.FAKE_AGY_REPLY_TEXT ||
          `[${session.model}/${session.thoughtLevel}] ${promptText}`;
        emitText(session.id, reply);
      }

      sendNotification('session/update', {
        sessionId: session.id,
        update: {
          sessionUpdate: 'usage_update',
          used: 120,
          size: 128000,
        },
      });

      sendResponse(id, {
        stopReason: process.env.FAKE_AGY_STOP_REASON || 'end_turn',
        usage: {
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
          ...(process.env.FAKE_AGY_THOUGHT ? { thoughtTokens: 5 } : {}),
        },
      });
    } catch (err) {
      if (controller.signal.aborted) {
        sendResponse(id, { stopReason: 'cancelled' });
        return;
      }
      sendError(id, -32603, err instanceof Error ? err.message : String(err));
    } finally {
      activePromptControllers.delete(session.id);
    }
  }

  async function handleRequest(msg) {
    const { id, method, params } = msg;

    switch (method) {
      case 'initialize': {
        if (process.env.FAKE_AGY_CRASH === 'initialize') {
          process.stderr.write('Simulated initialize crash\n');
          process.exit(1);
        }
        clientInfo = params?.clientInfo ?? null;
        clientCapabilities = params?.clientCapabilities ?? null;
        emitAuthDecorationsIfConfigured('initialize');

        if (process.env.FAKE_AGY_AUTH_REQUIRED === 'initialize') {
          sendError(id, -32000, 'Authentication required');
          return;
        }

        const version = process.env.FAKE_AGY_VERSION || '1.5.2';
        const appendSys = process.env.FAKE_AGY_SYSTEM_PROMPT_APPEND !== '0';
        const supportsImages = process.env.FAKE_AGY_CAP_IMAGES !== '0';
        const capsMeta = appendSys
          ? { antigravity: { systemPrompt: { append: true } } }
          : {};

        sendResponse(id, {
          protocolVersion: 1,
          agentInfo: {
            name: 'antigravity-acp',
            title: 'Antigravity ACP (Fake)',
            version,
          },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              image: supportsImages,
              audio: false,
              embeddedContext: true,
            },
            mcpCapabilities: {
              http: true,
              sse: false,
            },
            sessionCapabilities: {
              close: {},
            },
            _meta: capsMeta,
          },
          authMethods: [
            { id: 'oauth-personal', name: 'Google OAuth (Personal)' },
            { id: 'gemini-api-key', name: 'Gemini API Key' },
          ],
        });
        return;
      }

      case 'authenticate': {
        emitAuthDecorationsIfConfigured('authenticate');
        if (process.env.FAKE_AGY_AUTH_REQUIRED === 'no_browser') {
          sendError(id, -32603, 'No browser is available here');
          return;
        }
        if (process.env.FAKE_AGY_AUTH_FAIL === '1') {
          sendError(id, -32000, 'Authentication failed');
          return;
        }
        sendResponse(id, {});
        return;
      }

      case 'logout': {
        sendResponse(id, {});
        return;
      }

      case 'session/new': {
        emitAuthDecorationsIfConfigured('new_session');
        if (
          process.env.FAKE_AGY_AUTH_REQUIRED === '1' ||
          process.env.FAKE_AGY_AUTH_REQUIRED === 'new_session'
        ) {
          sendError(id, -32000, 'Authentication required');
          return;
        }
        if (process.env.FAKE_AGY_AUTH_REQUIRED === 'no_browser') {
          sendError(id, -32603, 'No browser is available here');
          return;
        }

        const sessionId = `agy-sess-${randomUUID().slice(0, 8)}`;
        const session = {
          id: sessionId,
          cwd: params.cwd,
          additionalDirectories: params.additionalDirectories ?? [],
          mcpServers: params.mcpServers ?? [],
          meta: params._meta ?? null,
          model: 'gemini-2.5-pro',
          thoughtLevel: 'medium',
          mode: 'default',
          mcpInitialized: false,
        };
        sessions.set(sessionId, session);

        sendResponse(id, {
          sessionId,
          modes: buildDefaultModes(session.mode),
          configOptions: buildDefaultConfigOptions(session.model, session.thoughtLevel),
        });
        return;
      }

      case 'session/load': {
        const existing = sessions.get(params.sessionId) || {
          id: params.sessionId,
          cwd: params.cwd,
          additionalDirectories: params.additionalDirectories ?? [],
          mcpServers: params.mcpServers ?? [],
          meta: params._meta ?? null,
          model: 'gemini-2.5-pro',
          thoughtLevel: 'medium',
          mode: 'default',
          mcpInitialized: false,
        };
        existing.mcpServers = params.mcpServers ?? existing.mcpServers;
        sessions.set(params.sessionId, existing);
        sendResponse(id, {
          modes: buildDefaultModes(existing.mode),
          configOptions: buildDefaultConfigOptions(existing.model, existing.thoughtLevel),
        });
        return;
      }

      case 'session/set_mode': {
        const session = sessions.get(params.sessionId);
        if (!session) {
          sendError(id, -32602, `Unknown sessionId: ${params.sessionId}`);
          return;
        }
        if (params.modeId !== 'default' && params.modeId !== 'auto') {
          sendError(id, -32602, `Unsupported session mode: ${params.modeId}`);
          return;
        }
        session.mode = params.modeId;
        sendNotification('session/update', {
          sessionId: session.id,
          update: {
            sessionUpdate: 'current_mode_update',
            currentModeId: session.mode,
          },
        });
        sendResponse(id, {});
        return;
      }

      case 'session/set_config_option': {
        const session = sessions.get(params.sessionId);
        if (!session) {
          sendError(id, -32602, `Unknown sessionId: ${params.sessionId}`);
          return;
        }
        if (params.configId === 'model') {
          session.model = String(params.value);
        } else if (params.configId === 'thought_level') {
          session.thoughtLevel = String(params.value);
        } else {
          sendError(id, -32602, `Unknown configId: ${params.configId}`);
          return;
        }
        const configOptions = buildDefaultConfigOptions(session.model, session.thoughtLevel);
        sendNotification('session/update', {
          sessionId: session.id,
          update: {
            sessionUpdate: 'config_option_update',
            configOptions,
          },
        });
        sendResponse(id, { configOptions });
        return;
      }

      case 'session/close': {
        sessions.delete(params.sessionId);
        sendResponse(id, {});
        return;
      }

      case 'session/prompt': {
        await handlePrompt(id, params);
        return;
      }

      default: {
        sendError(id, -32601, `Method not found: ${method}`);
      }
    }
  }

  function handleNotification(msg) {
    if (msg.method === 'session/cancel') {
      const entry = activePromptControllers.get(msg.params?.sessionId);
      entry?.cancel();
      return;
    }
    if (msg.method === '$/cancel_request') {
      const reqId = msg.params?.requestId;
      for (const entry of activePromptControllers.values()) {
        if (entry.id === reqId) {
          entry.cancel();
        }
      }
    }
  }

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let start = 0;
    while (true) {
      const nl = buffer.indexOf('\n', start);
      if (nl === -1) {
        break;
      }
      const line = buffer.slice(start, nl).trim();
      start = nl + 1;
      if (!line) {
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg && typeof msg === 'object') {
        if ('method' in msg && 'id' in msg) {
          void handleRequest(msg);
        } else if ('method' in msg) {
          handleNotification(msg);
        } else if ('id' in msg) {
          const pending = pendingOutgoingRequests.get(msg.id);
          if (pending) {
            pendingOutgoingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message || 'Client RPC error'));
            } else {
              pending.resolve(msg.result);
            }
          }
        }
      }
    }
    buffer = start > 0 ? buffer.slice(start) : buffer;
  });

  process.stdin.on('end', () => {
    process.exit(0);
  });
  process.stdin.resume();
}
