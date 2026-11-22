import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolSchema } from '@deepseek-ai/dsh-llm';
import { PrivateMcpBridge } from '../../src/mcp/bridge.js';
import { MAX_MCP_TOOLS, sanitizeToolCatalog } from '../../src/mcp/schema.js';
import { AntigravityAcpError } from '../../src/shared/errors.js';

function getAuthHeader(bridge: PrivateMcpBridge): string {
  const cfg = bridge.getMcpServerConfig();
  if (!('type' in cfg) || cfg.type !== 'http') {
    throw new Error('Expected http MCP config');
  }
  const auth = cfg.headers.find((h: { name: string; value: string }) => h.name.toLowerCase() === 'authorization');
  if (!auth) {
    throw new Error('Missing Authorization header');
  }
  return auth.value;
}

describe('sanitizeToolCatalog', () => {
  it('expands local $defs/$definitions $refs, handles cycles, cleans empty enums, and enforces object root', () => {
    const tools: ToolSchema[] = [
      {
        name: 'search_files',
        description: 'Search files in workspace',
        parameters: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $defs: {
            Mode: {
              type: 'string',
              enum: ['', 'glob', 'regex'],
            },
            Node: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                child: { $ref: '#/$defs/Node' },
              },
            },
          },
          definitions: {
            EmptyOnlyEnum: {
              type: 'string',
              enum: [''],
            },
          },
          properties: {
            mode: { $ref: '#/$defs/Mode' },
            tag: { $ref: '#/definitions/EmptyOnlyEnum' },
            tree: { $ref: '#/$defs/Node' },
          },
          required: ['mode'],
          additionalProperties: false,
        },
      },
    ];

    const sanitized = sanitizeToolCatalog(tools);
    expect(sanitized).toHaveLength(1);
    const schema = sanitized[0].inputSchema as Record<string, any>;
    expect(schema.type).toBe('object');
    expect(schema.$defs).toBeUndefined();
    expect(schema.definitions).toBeUndefined();
    expect(schema.$schema).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.mode).toEqual({ type: 'string', enum: ['glob', 'regex'] });
    expect(schema.properties.tag).toEqual({ type: 'string' });
    // Cyclic $ref breaks cleanly without stack overflow.
    expect(schema.properties.tree.type).toBe('object');
    expect(schema.properties.tree.properties.label).toEqual({ type: 'string' });
    expect(schema.properties.tree.properties.child).toEqual({ type: 'object' });
  });

  it('rejects empty/invalid names, duplicates, non-object schemas, >256 tools, and >128KiB definitions', () => {
    expect(() =>
      sanitizeToolCatalog([{ name: '', description: 'x', parameters: {} }]),
    ).toThrowError(AntigravityAcpError);

    try {
      sanitizeToolCatalog([{ name: 'bad name!', description: 'x', parameters: {} }]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AntigravityAcpError);
      expect((error as AntigravityAcpError).code).toBe('AGY_TOOL_CATALOG_INVALID');
    }

    try {
      sanitizeToolCatalog([
        { name: 'dup', description: '1', parameters: {} },
        { name: 'dup', description: '2', parameters: {} },
      ]);
      expect.unreachable();
    } catch (error) {
      expect((error as AntigravityAcpError).code).toBe('AGY_TOOL_CATALOG_INVALID');
    }

    try {
      sanitizeToolCatalog([
        {
          name: 'bad_root',
          description: 'not object',
          parameters: { type: 'string' },
        },
      ]);
      expect.unreachable();
    } catch (error) {
      expect((error as AntigravityAcpError).code).toBe('AGY_TOOL_CATALOG_INVALID');
    }

    const tooMany: ToolSchema[] = Array.from({ length: MAX_MCP_TOOLS + 1 }, (_, idx) => ({
      name: `tool_${idx}`,
      description: 't',
      parameters: {},
    }));
    expect(() => sanitizeToolCatalog(tooMany)).toThrowError(/256/);

    const hugeDesc = 'x'.repeat(130 * 1024);
    try {
      sanitizeToolCatalog([
        {
          name: 'huge_tool',
          description: hugeDesc,
          parameters: { type: 'object', properties: {} },
        },
      ]);
      expect.unreachable();
    } catch (error) {
      expect((error as AntigravityAcpError).code).toBe('AGY_TOOL_CATALOG_INVALID');
    }
  });
});

describe('PrivateMcpBridge', () => {
  const bridges: PrivateMcpBridge[] = [];

  afterEach(async () => {
    while (bridges.length > 0) {
      await bridges.pop()!.close();
    }
  });

  async function startBridge(options?: ConstructorParameters<typeof PrivateMcpBridge>[0]) {
    const bridge = new PrivateMcpBridge(options);
    bridges.push(bridge);
    await bridge.start();
    return bridge;
  }

  it('binds on 127.0.0.1, enforces Bearer auth (401), HTTP methods, and 413 payload limit', async () => {
    const bridge = await startBridge();
    expect(bridge.endpointUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const noAuth = await fetch(bridge.endpointUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(noAuth.status).toBe(401);

    const badAuth = await fetch(bridge.endpointUrl, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(badAuth.status).toBe(401);

    const auth = getAuthHeader(bridge);

    const getRes = await fetch(bridge.endpointUrl, {
      method: 'GET',
      headers: { authorization: auth },
    });
    expect(getRes.status).toBe(405);

    const delRes = await fetch(bridge.endpointUrl, {
      method: 'DELETE',
      headers: { authorization: auth },
    });
    expect(delRes.status).toBe(200);

    const notFound = await fetch(bridge.endpointUrl.replace('/mcp', '/other'), {
      method: 'POST',
      headers: { authorization: auth },
      body: '{}',
    });
    expect(notFound.status).toBe(404);

    const hugePayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { blob: 'a'.repeat(1024 * 1024 + 100) },
    });
    const tooLarge = await fetch(bridge.endpointUrl, {
      method: 'POST',
      headers: {
        authorization: auth,
        'content-type': 'application/json',
      },
      body: hugePayload,
    });
    expect(tooLarge.status).toBe(413);

    // Also verify streaming chunked body without Content-Length triggers 413 cleanly.
    const chunkedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(300 * 1024).fill(97);
        for (let i = 0; i < 4; i += 1) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    const chunkedTooLarge = await fetch(bridge.endpointUrl, {
      method: 'POST',
      headers: {
        authorization: auth,
        'content-type': 'application/json',
      },
      body: chunkedStream,
      duplex: 'half',
    } as RequestInit);
    expect(chunkedTooLarge.status).toBe(413);
  });

  it('handles initialize, notifications/initialized, and tools/list', async () => {
    const bridge = await startBridge();
    bridge.setTools([
      {
        name: 'read_note',
        description: 'Reads a note',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ]);
    const auth = getAuthHeader(bridge);

    const initRes = await fetch(bridge.endpointUrl, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(initRes.status).toBe(200);
    const initJson = (await initRes.json()) as any;
    expect(initJson).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'dsh-antigravity-mcp-bridge',
          version: '0.1.0',
        },
      },
    });

    const notifRes = await fetch(bridge.endpointUrl, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notifRes.status).toBe(202);

    const listRes = await fetch(bridge.endpointUrl, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as any;
    expect(listJson.result.tools).toHaveLength(1);
    expect(listJson.result.tools[0].name).toBe('read_note');
  });

  it('parks tools/call until deliverToolResults, propagates isError, and validates unknown tools', async () => {
    const bridge = await startBridge();
    bridge.setTools([
      {
        name: 'echo',
        description: 'Echo text',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ]);
    const auth = getAuthHeader(bridge);

    const parkedCalls: Array<{ id: any; name: string; argumentsJson: string }> = [];
    bridge.setTurnListener({
      onToolCallParked(call) {
        parkedCalls.push(call);
      },
    });

    const unknownRes = await fetch(bridge.endpointUrl, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'missing_tool', arguments: {} },
      }),
    });
    const unknownJson = (await unknownRes.json()) as any;
    expect(unknownJson.error.code).toBe(-32602);

    // Start two concurrent parked tool calls.
    const req1 = fetch(bridge.endpointUrl, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: 'hello' } },
      }),
    });
    const req2 = fetch(bridge.endpointUrl, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: 'fail' } },
      }),
    });

    await vi.waitFor(() => {
      expect(parkedCalls).toHaveLength(2);
    });
    expect(bridge.pendingCount).toBe(2);

    bridge.deliverToolResults(
      new Map([
        [parkedCalls[0].id, { content: 'echo:hello', isError: false }],
        [parkedCalls[1].id, { content: 'boom', isError: true }],
      ]),
    );

    const [res1, res2] = await Promise.all([req1, req2]);
    const json1 = (await res1.json()) as any;
    const json2 = (await res2.json()) as any;

    expect(json1.result).toEqual({
      content: [{ type: 'text', text: 'echo:hello' }],
      isError: false,
    });
    expect(json2.result).toEqual({
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    });
    expect(bridge.pendingCount).toBe(0);
  });

  it('rejects pending count exceeding 64 with AGY_SESSION_LIMIT', async () => {
    const bridge = await startBridge({ maxPendingCalls: 64 });
    bridge.setTools([
      { name: 'noop', description: 'noop', parameters: { type: 'object', properties: {} } },
    ]);
    bridge.setTurnListener({ onToolCallParked: () => {} });
    const auth = getAuthHeader(bridge);

    const openPromises: Array<Promise<Response | void>> = [];
    for (let i = 0; i < 64; i += 1) {
      openPromises.push(
        fetch(bridge.endpointUrl, {
          method: 'POST',
          headers: { authorization: auth, 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: i + 1,
            method: 'tools/call',
            params: { name: 'noop', arguments: {} },
          }),
        }).catch(() => {}),
      );
    }

    try {
      await vi.waitFor(() => {
        expect(bridge.pendingCount).toBe(64);
      });

      const overflowRes = await fetch(bridge.endpointUrl, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 65,
          method: 'tools/call',
          params: { name: 'noop', arguments: {} },
        }),
      });
      const overflowJson = (await overflowRes.json()) as any;
      expect(overflowJson.error.data?.code).toBe('AGY_SESSION_LIMIT');
    } finally {
      bridge.abortAll(new AntigravityAcpError('cleanup', 'ABORTED'));
      await Promise.allSettled(openPromises);
    }
  });

  it('times out parked tool calls with AGY_TOOL_TIMEOUT and cleans up on abortAll/close', async () => {
    const bridge = await startBridge({ toolTimeoutMs: 40 });
    bridge.setTools([
      { name: 'slow', description: 'slow', parameters: { type: 'object', properties: {} } },
    ]);
    const errors: Error[] = [];
    bridge.setTurnListener({
      onToolCallParked: () => {},
      onToolCallError: (err) => errors.push(err),
    });
    const auth = getAuthHeader(bridge);

    const timedOutRes = await fetch(bridge.endpointUrl, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'slow', arguments: {} },
      }),
    });
    const timedOutJson = (await timedOutRes.json()) as any;
    expect(timedOutJson.error.data?.code).toBe('AGY_TOOL_TIMEOUT');
    expect(errors).toHaveLength(1);
    expect((errors[0] as AntigravityAcpError).code).toBe('AGY_TOOL_TIMEOUT');
    expect(bridge.pendingCount).toBe(0);
  });
});
