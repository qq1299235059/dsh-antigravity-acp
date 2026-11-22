import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type * as acp from '@agentclientprotocol/sdk';
import { ToolCallId, type ToolSchema } from '@deepseek-ai/dsh-llm';
import { AntigravityAcpError, redactSensitiveText } from '../shared/errors.js';
import { sanitizeToolCatalog, type SanitizedMcpTool } from './schema.js';

/** Maximum HTTP POST payload accepted by {@link PrivateMcpBridge} (1 MiB). */
export const MAX_BRIDGE_REQUEST_BYTES = 1024 * 1024;

/** Maximum concurrent parked `tools/call` invocations held by {@link PrivateMcpBridge}. */
export const MAX_PENDING_TOOL_CALLS = 64;

/** Result delivered back to a parked MCP `tools/call` request. */
export interface McpToolCallResult {
  readonly content: string;
  readonly isError: boolean;
}

/** Public view of a parked `tools/call` waiting for DSH tool execution. */
export interface ParkedToolCallInfo {
  readonly id: ToolCallId;
  readonly name: string;
  readonly argumentsJson: string;
  readonly createdAt: number;
}

/** Internal record for an in-flight parked HTTP `tools/call` request. */
export interface ParkedToolCall extends ParkedToolCallInfo {
  readonly resolve: (result: McpToolCallResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** Listener notified when the ACP agent invokes a bridged DSH tool. */
export interface PrivateMcpBridgeTurnListener {
  onToolCallParked(call: ParkedToolCallInfo): void;
  onToolCallError?(error: Error): void;
}

/** Options configuring a {@link PrivateMcpBridge} instance. */
export interface PrivateMcpBridgeOptions {
  readonly toolTimeoutMs?: number;
  readonly maxPendingCalls?: number;
  readonly maxRequestBytes?: number;
  readonly serverName?: string;
}

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  if (res.writableEnded || res.destroyed || res.closed) {
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): void {
  sendJson(res, status, {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message: redactSensitiveText(message),
      ...(data !== undefined ? { data } : {}),
    },
  });
}

class PayloadTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds ${MAX_BRIDGE_REQUEST_BYTES} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

async function readLimitedBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const rawLength = req.headers['content-length'];
  if (typeof rawLength === 'string') {
    const parsed = Number(rawLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new PayloadTooLargeError();
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  return await new Promise<string>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };

    const onData = (chunk: Buffer | string): void => {
      if (settled) {
        return;
      }
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      totalBytes += buf.byteLength;
      if (totalBytes > maxBytes) {
        settled = true;
        cleanup();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(buf);
    };

    const onEnd = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, totalBytes).toString('utf8'));
    };

    const onError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onAborted = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error('HTTP request aborted'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/**
 * Private loopback Streamable HTTP MCP server bridging DSH tool calls across an in-flight ACP prompt.
 *
 * Each `tools/call` request validates the tool against the active sanitized catalog, parks an
 * open HTTP response behind a {@link ParkedToolCall}, notifies the active turn listener, and stays
 * open until {@link deliverToolResults} resolves it or a timeout/abort fires.
 */
export class PrivateMcpBridge {
  private readonly token: string;
  private readonly tokenBuffer: Buffer;
  private readonly toolTimeoutMs: number;
  private readonly maxPendingCalls: number;
  private readonly maxRequestBytes: number;
  private readonly serverName: string;

  private server: Server | undefined;
  private startPromise: Promise<void> | undefined;
  private url: string | undefined;
  private closed = false;

  private tools: readonly SanitizedMcpTool[] = [];
  private toolsByName = new Map<string, SanitizedMcpTool>();
  private turnListener: PrivateMcpBridgeTurnListener | undefined;
  private readonly pendingCalls = new Map<ToolCallId, ParkedToolCall>();

  constructor(options?: PrivateMcpBridgeOptions) {
    this.token = randomBytes(32).toString('hex');
    this.tokenBuffer = Buffer.from(this.token, 'utf8');
    this.toolTimeoutMs = options?.toolTimeoutMs ?? 300_000;
    this.maxPendingCalls = options?.maxPendingCalls ?? MAX_PENDING_TOOL_CALLS;
    this.maxRequestBytes = options?.maxRequestBytes ?? MAX_BRIDGE_REQUEST_BYTES;
    this.serverName = options?.serverName ?? 'dsh_tools';
  }

  /** Whether the bridge HTTP server is currently listening. */
  get isListening(): boolean {
    return this.server?.listening === true && !this.closed;
  }

  /** Loopback MCP endpoint URL (`http://127.0.0.1:<port>/mcp`). */
  get endpointUrl(): string {
    if (!this.url) {
      throw new AntigravityAcpError('PrivateMcpBridge has not been started yet', 'TRANSPORT');
    }
    return this.url;
  }

  /** Current count of parked `tools/call` invocations awaiting results. */
  get pendingCount(): number {
    return this.pendingCalls.size;
  }

  /** Snapshot of all currently parked tool calls in insertion order. */
  getPendingCalls(): readonly ParkedToolCallInfo[] {
    return [...this.pendingCalls.values()].map(({ id, name, argumentsJson, createdAt }) => ({
      id,
      name,
      argumentsJson,
      createdAt,
    }));
  }

  /** Whether a parked tool call with `id` is currently pending. */
  hasPendingCall(id: ToolCallId): boolean {
    return this.pendingCalls.has(id);
  }

  /** Update exposed tools from raw DSH tool schemas (validated & sanitized). */
  setTools(tools: readonly ToolSchema[] | undefined): readonly SanitizedMcpTool[] {
    const sanitized = sanitizeToolCatalog(tools);
    this.setSanitizedTools(sanitized);
    return sanitized;
  }

  /** Update exposed tools from an already-sanitized catalog. */
  setSanitizedTools(tools: readonly SanitizedMcpTool[]): void {
    this.tools = tools;
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  /** Register or clear the turn listener notified when `tools/call` parks. */
  setTurnListener(listener: PrivateMcpBridgeTurnListener | undefined): void {
    this.turnListener = listener;
  }

  /** Bind the private HTTP server strictly on `127.0.0.1:0`. */
  async start(): Promise<void> {
    if (this.closed) {
      throw new AntigravityAcpError('PrivateMcpBridge has already been closed', 'ABORTED');
    }
    if (this.isListening) {
      return;
    }
    if (this.startPromise) {
      return await this.startPromise;
    }

    this.startPromise = (async () => {
      const server = createServer((req, res) => {
        void this.handleHttpRequest(req, res);
      });
      // Tool calls can legitimately stay parked for the full toolTimeoutMs window.
      server.requestTimeout = 0;
      server.timeout = 0;
      server.keepAliveTimeout = 2_000;

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
      });

      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        throw new AntigravityAcpError('Failed to bind PrivateMcpBridge loopback port', 'TRANSPORT');
      }

      this.server = server;
      this.url = `http://127.0.0.1:${address.port}/mcp`;
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  /** Return the ACP `McpServer` HTTP descriptor carrying the per-bridge Bearer token. */
  getMcpServerConfig(): acp.McpServer {
    return {
      type: 'http',
      name: this.serverName,
      url: this.endpointUrl,
      headers: [
        {
          name: 'Authorization',
          value: `Bearer ${this.token}`,
        },
      ],
    };
  }

  /**
   * Deliver DSH tool execution results to parked HTTP `tools/call` requests.
   */
  deliverToolResults(results: ReadonlyMap<ToolCallId, McpToolCallResult>): void {
    for (const [id, result] of results.entries()) {
      const parked = this.pendingCalls.get(id);
      if (!parked) {
        continue;
      }
      this.pendingCalls.delete(id);
      clearTimeout(parked.timer);
      parked.resolve(result);
    }
  }

  /**
   * Abort all currently parked HTTP `tools/call` requests with `error`.
   */
  abortAll(error: Error): void {
    if (this.pendingCalls.size === 0) {
      return;
    }
    const entries = [...this.pendingCalls.values()];
    this.pendingCalls.clear();
    for (const parked of entries) {
      clearTimeout(parked.timer);
      parked.reject(error);
    }
  }

  /**
   * Abort pending calls and close all HTTP connections cleanly. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const hadPending = this.pendingCalls.size > 0;
    this.abortAll(new AntigravityAcpError('MCP bridge closed', 'ABORTED'));
    this.turnListener = undefined;

    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }

    if (hadPending) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await new Promise<void>((resolve) => {
      if (!server.listening) {
        server.closeAllConnections?.();
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string') {
      return false;
    }
    const match = authHeader.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      return false;
    }
    const presented = Buffer.from(match[1], 'utf8');
    if (presented.byteLength !== this.tokenBuffer.byteLength) {
      return false;
    }
    return timingSafeEqual(presented, this.tokenBuffer);
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.isAuthorized(req)) {
        sendJson(res, 401, { error: 'Unauthorized' }, { connection: 'close' });
        req.resume();
        return;
      }

      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname !== '/mcp') {
        sendJson(res, 404, { error: 'Not Found' });
        req.resume();
        return;
      }

      const method = (req.method ?? '').toUpperCase();
      if (method === 'GET') {
        sendJson(res, 405, { error: 'Method Not Allowed' }, { allow: 'POST, DELETE' });
        req.resume();
        return;
      }

      if (method === 'DELETE') {
        sendJson(res, 200, { ok: true });
        req.resume();
        return;
      }

      if (method !== 'POST') {
        sendJson(res, 405, { error: 'Method Not Allowed' }, { allow: 'POST, DELETE' });
        req.resume();
        return;
      }

      let rawBody: string;
      try {
        rawBody = await readLimitedBody(req, this.maxRequestBytes);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          req.resume();
          res.writeHead(413, {
            'content-type': 'application/json; charset=utf-8',
            connection: 'close',
          });
          res.end(JSON.stringify({ error: 'Payload Too Large' }));
          const closeTimer = setTimeout(() => {
            if (!req.destroyed) {
              req.destroy();
            }
          }, 250);
          closeTimer.unref?.();
          req.once('end', () => clearTimeout(closeTimer));
          return;
        }
        sendJson(res, 400, { error: 'Failed to read request body' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        sendJsonRpcError(res, 400, null, -32700, 'Parse error');
        return;
      }

      if (!isPlainRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
        sendJsonRpcError(res, 400, null, -32600, 'Invalid JSON-RPC 2.0 request');
        return;
      }

      const rpcReq = parsed as unknown as JsonRpcRequest;
      const hasId = Object.hasOwn(parsed, 'id') && rpcReq.id !== undefined;

      // Notifications do not carry a response id; acknowledge with HTTP 202.
      if (!hasId) {
        if (!res.writableEnded && !res.destroyed) {
          res.writeHead(202, { 'cache-control': 'no-store' });
          res.end();
        }
        return;
      }

      const id = rpcReq.id ?? null;
      await this.handleJsonRpcRequest(rpcReq, id, res);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Internal bridge error';
      sendJsonRpcError(res, 500, null, -32603, msg);
    }
  }

  private async handleJsonRpcRequest(
    rpcReq: JsonRpcRequest,
    id: string | number | null,
    res: ServerResponse,
  ): Promise<void> {
    switch (rpcReq.method) {
      case 'initialize': {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'dsh-antigravity-mcp-bridge',
              version: '0.1.0',
            },
          },
        });
        return;
      }

      case 'ping': {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {},
        });
        return;
      }

      case 'tools/list': {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            tools: this.tools,
          },
        });
        return;
      }

      case 'tools/call': {
        await this.handleToolsCall(rpcReq.params, id, res);
        return;
      }

      default: {
        sendJsonRpcError(res, 200, id, -32601, `Method not found: ${rpcReq.method}`);
      }
    }
  }

  private async handleToolsCall(
    params: unknown,
    id: string | number | null,
    res: ServerResponse,
  ): Promise<void> {
    if (!isPlainRecord(params) || typeof params.name !== 'string' || params.name.length === 0) {
      sendJsonRpcError(res, 200, id, -32602, 'Invalid tools/call params: expected non-empty tool name');
      return;
    }

    const toolName = params.name;
    if (!this.toolsByName.has(toolName)) {
      sendJsonRpcError(res, 200, id, -32602, `Unknown tool: ${toolName}`);
      return;
    }

    const rawArgs = params.arguments;
    if (rawArgs !== undefined && rawArgs !== null && !isPlainRecord(rawArgs)) {
      sendJsonRpcError(res, 200, id, -32602, 'Invalid tools/call arguments: expected JSON object');
      return;
    }

    if (this.pendingCalls.size >= this.maxPendingCalls) {
      sendJsonRpcError(
        res,
        200,
        id,
        -32000,
        `AGY_SESSION_LIMIT: pending MCP tool call count reached ${this.maxPendingCalls}`,
        { code: 'AGY_SESSION_LIMIT' },
      );
      return;
    }

    const listener = this.turnListener;
    if (!listener) {
      sendJsonRpcError(res, 200, id, -32000, 'No active turn listener is attached to MCP bridge');
      return;
    }

    let argumentsJson: string;
    try {
      argumentsJson = JSON.stringify(rawArgs ?? {});
    } catch {
      sendJsonRpcError(res, 200, id, -32602, 'Invalid tools/call arguments: not JSON-serializable');
      return;
    }

    const callId = ToolCallId(randomUUID());
    const createdAt = Date.now();

    let settled = false;
    let closeCleanup: (() => void) | undefined;

    const result = await new Promise<McpToolCallResult>((resolve, reject) => {
      const cleanup = (): void => {
        if (closeCleanup) {
          closeCleanup();
          closeCleanup = undefined;
        }
      };

      const finishResolve = (value: McpToolCallResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };

      const finishReject = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const timer = setTimeout(() => {
        if (!this.pendingCalls.delete(callId)) {
          return;
        }
        const timeoutError = new AntigravityAcpError(
          `MCP tool call "${toolName}" timed out after ${this.toolTimeoutMs}ms`,
          'AGY_TOOL_TIMEOUT',
        );
        this.turnListener?.onToolCallError?.(timeoutError);
        finishReject(timeoutError);
      }, this.toolTimeoutMs);
      timer.unref?.();

      const parked: ParkedToolCall = {
        id: callId,
        name: toolName,
        argumentsJson,
        createdAt,
        resolve: finishResolve,
        reject: finishReject,
        timer,
      };

      const onResClose = (): void => {
        if (!res.writableEnded && this.pendingCalls.delete(callId)) {
          clearTimeout(timer);
          finishReject(new AntigravityAcpError(`HTTP client disconnected before "${toolName}" completed`, 'ABORTED'));
        }
      };
      res.once('close', onResClose);
      closeCleanup = () => {
        res.off('close', onResClose);
      };

      this.pendingCalls.set(callId, parked);

      try {
        listener.onToolCallParked({
          id: callId,
          name: toolName,
          argumentsJson,
          createdAt,
        });
      } catch (error) {
        if (this.pendingCalls.delete(callId)) {
          clearTimeout(timer);
          const err = error instanceof Error ? error : new Error(String(error));
          finishReject(err);
        }
      }
    }).catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      const data = err instanceof AntigravityAcpError ? { code: err.code } : undefined;
      sendJsonRpcError(res, 200, id, -32000, err.message, data);
      return undefined;
    });

    if (!result) {
      return;
    }

    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: result.content,
          },
        ],
        isError: result.isError,
      },
    });
  }
}
