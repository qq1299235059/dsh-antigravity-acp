import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createStderrAuthScanner,
  createStdoutAuthFilter,
  MAX_STDOUT_LINE_BYTES,
} from '../../src/acp/stdout-filter.js';
import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
} from '../../src/runtime/profile.js';
import { AntigravityAcpError } from '../../src/shared/errors.js';

function collectStreamOutput(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    stream.on('error', reject);
  });
}

describe('acp/stdout-filter', () => {
  it('strips stdout auth URL lines across split chunks while preserving NDJSON lines', async () => {
    const authUrls: string[] = [];
    const errors: Error[] = [];
    const filter = createStdoutAuthFilter({
      onAuthUrl: (url) => authUrls.push(url),
      onProtocolError: (err) => errors.push(err),
    });

    const outputPromise = collectStreamOutput(filter);
    const validAuthUrl =
      'https://accounts.google.com/o/oauth2/auth?client_id=abc&redirect_uri=http://127.0.0.1:43210/cb&state=xyz';

    const line1 = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n';
    const authLine = `${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${validAuthUrl}\r\n`;
    const line2 = '{"jsonrpc":"2.0","method":"session/update","params":{"text":"你好世界"}}\n';

    const fullPayload = Buffer.from(line1 + authLine + line2, 'utf8');
    // Feed in tiny odd-byte chunks to split both auth line and multi-byte UTF-8 characters.
    for (let offset = 0; offset < fullPayload.byteLength; offset += 7) {
      filter.write(fullPayload.subarray(offset, offset + 7));
    }
    filter.end();

    const output = await outputPromise;
    expect(errors).toEqual([]);
    expect(authUrls).toEqual([validAuthUrl]);
    expect(output).toBe(line1 + line2);
  });

  it('triggers AGY_AUTH_REQUIRED when auth line arrives without an onAuthUrl handler', async () => {
    const protocolErrors: Error[] = [];
    const filter = createStdoutAuthFilter({
      onProtocolError: (err) => protocolErrors.push(err),
    });

    const outputPromise = collectStreamOutput(filter);
    const authUrl = 'https://accounts.google.com/o/oauth2/auth?client_id=abc&state=s1';
    filter.write(`${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${authUrl}\n`);
    filter.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    filter.end();

    const output = await outputPromise;
    expect(output).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]).toBeInstanceOf(AntigravityAcpError);
    expect((protocolErrors[0] as AntigravityAcpError).code).toBe('AGY_AUTH_REQUIRED');
  });

  it('fails the stream directly with AGY_AUTH_REQUIRED when neither handler nor onProtocolError is supplied', async () => {
    const filter = createStdoutAuthFilter();
    const source = new PassThrough();
    source.pipe(filter);

    const outputPromise = collectStreamOutput(filter);
    source.write(
      `${ANTIGRAVITY_AUTH_STDOUT_PREFIX}https://accounts.google.com/o/oauth2/auth?client_id=abc\n`,
    );
    source.end();

    await expect(outputPromise).rejects.toMatchObject({
      name: 'AntigravityAcpError',
      code: 'AGY_AUTH_REQUIRED',
    });
  });

  it('rejects untrusted non-Google auth URLs and never invokes onAuthUrl', async () => {
    const authUrls: string[] = [];
    const errors: Error[] = [];
    const filter = createStdoutAuthFilter({
      onAuthUrl: (url) => authUrls.push(url),
      onProtocolError: (err) => errors.push(err),
    });

    const outputPromise = collectStreamOutput(filter);
    filter.write(`${ANTIGRAVITY_AUTH_STDOUT_PREFIX}https://evil.example.com/phish\n`);
    filter.end();

    const output = await outputPromise;
    expect(output).toBe('');
    expect(authUrls).toEqual([]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as AntigravityAcpError).code).toBe('AGY_AUTH_REQUIRED');
  });

  it('enforces the 16 MiB maximum single-line length', async () => {
    const errors: Error[] = [];
    const filter = createStdoutAuthFilter({
      onProtocolError: (err) => errors.push(err),
    });

    const outputPromise = collectStreamOutput(filter);
    const oversizedChunk = Buffer.alloc(MAX_STDOUT_LINE_BYTES + 128, 0x61);
    filter.write(oversizedChunk);
    filter.write('\n{"jsonrpc":"2.0","id":2,"result":{}}\n');
    filter.end();

    const output = await outputPromise;
    expect(errors).toHaveLength(1);
    expect((errors[0] as AntigravityAcpError).code).toBe('TRANSPORT');
    expect(output).toBe('{"jsonrpc":"2.0","id":2,"result":{}}\n');
  });

  it('scans stderr chunks for both stdout-prefix and JSON-encoded browser marker URLs', () => {
    const urls: string[] = [];
    const scan = createStderrAuthScanner({
      onAuthUrl: (url) => urls.push(url),
    });

    const url1 = 'https://accounts.google.com/o/oauth2/auth?client_id=one&state=1';
    const url2 = 'https://accounts.google.com/o/oauth2/auth?client_id=two&state=2';

    // Split across multiple calls
    scan(`[stderr] ${ANTIGRAVITY_AUTH_STDOUT_PREFIX}https://accounts.google.com`);
    scan('/o/oauth2/auth?client_id=one&state=1\r\n');
    scan(`${ANTIGRAVITY_AUTH_BROWSER_MARKER}${JSON.stringify(url2)}\n`);
    // Invalid URLs and malformed JSON must be silently ignored
    scan(`${ANTIGRAVITY_AUTH_BROWSER_MARKER}"https://not-google.example.com"\n`);
    scan(`${ANTIGRAVITY_AUTH_BROWSER_MARKER}{not-json\n`);

    expect(urls).toEqual([url1, url2]);
  });
});
