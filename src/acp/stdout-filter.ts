import { Transform, type TransformCallback } from 'node:stream';
import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  parseAntigravityAuthorizationUrl,
} from '../runtime/profile.js';
import { AntigravityAcpError } from '../shared/errors.js';

/** Maximum single NDJSON line length buffered from ACP stdout (16 MiB). */
export const MAX_STDOUT_LINE_BYTES = 16 * 1024 * 1024;

const MAX_STDERR_LINE_CHARS = 1024 * 1024;
const NEWLINE_BYTE = 0x0a;
const NEWLINE_BUF = Buffer.from([NEWLINE_BYTE]);

/** Options for {@link createStdoutAuthFilter}. */
export interface StdoutAuthFilterOptions {
  /** Invoked when Antigravity prints an interactive OAuth URL on stdout. */
  readonly onAuthUrl?: (url: string) => void;
  /** Invoked on oversized lines, invalid auth URLs, or headless auth-required lines. */
  readonly onProtocolError?: (error: Error) => void;
}

/** Options for {@link createStderrAuthScanner}. */
export interface StderrAuthScannerOptions {
  /** Invoked when Antigravity or the BROWSER interceptor logs an auth URL on stderr. */
  readonly onAuthUrl?: (url: string) => void;
}

function validateAndExtractAuthUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new AntigravityAcpError('Empty Antigravity authorization URL', 'AGY_AUTH_REQUIRED');
  }
  const parsed = parseAntigravityAuthorizationUrl(trimmed);
  if (!parsed) {
    throw new AntigravityAcpError('Invalid Antigravity authorization URL', 'AGY_AUTH_REQUIRED');
  }
  return parsed.url;
}

/**
 * Create a {@link Transform} stream that buffers `\n`-delimited lines up to 16 MiB,
 * intercepts Antigravity auth URL lines on stdout before they reach `ndJsonStream`,
 * and forwards valid NDJSON lines unchanged.
 */
export function createStdoutAuthFilter(options?: StdoutAuthFilterOptions): Transform {
  let bufferedChunks: Buffer[] = [];
  let bufferedBytes = 0;
  let discardUntilNewline = false;
  let fatalErrored = false;

  const emitProtocolError = (error: Error, failStream: (err: Error) => void): boolean => {
    if (options?.onProtocolError) {
      options.onProtocolError(error);
      return false;
    }
    fatalErrored = true;
    failStream(error);
    return true;
  };

  const handleCompleteLine = (
    lineBuf: Buffer,
    pushFn: (chunk: Buffer) => void,
    failStream: (err: Error) => void,
    appendNewline: boolean,
  ): boolean => {
    const decoded = lineBuf.toString('utf8');
    const withoutCr = decoded.endsWith('\r') ? decoded.slice(0, -1) : decoded;
    const trimmedStart = withoutCr.trimStart();

    if (trimmedStart.startsWith(ANTIGRAVITY_AUTH_STDOUT_PREFIX)) {
      const rawUrl = trimmedStart.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length);
      let validatedUrl: string;
      try {
        validatedUrl = validateAndExtractAuthUrl(rawUrl);
      } catch (err) {
        const wrapped =
          err instanceof Error
            ? err
            : new AntigravityAcpError(String(err), 'AGY_AUTH_REQUIRED', { cause: err });
        return emitProtocolError(wrapped, failStream);
      }

      if (options?.onAuthUrl) {
        options.onAuthUrl(validatedUrl);
        return false;
      }

      return emitProtocolError(
        new AntigravityAcpError(
          'Antigravity ACP requires interactive sign-in (run `login` first)',
          'AGY_AUTH_REQUIRED',
        ),
        failStream,
      );
    }

    pushFn(appendNewline ? Buffer.concat([lineBuf, NEWLINE_BUF]) : lineBuf);
    return false;
  };

  return new Transform({
    transform(chunk: Buffer | Uint8Array | string, _encoding: BufferEncoding, callback: TransformCallback) {
      if (fatalErrored) {
        callback();
        return;
      }

      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      let stopped = false;

      const failStream = (err: Error): void => {
        stopped = true;
        callback(err);
      };

      while (start < buf.byteLength) {
        const newlineIdx = buf.indexOf(NEWLINE_BYTE, start);

        if (discardUntilNewline) {
          if (newlineIdx === -1) {
            start = buf.byteLength;
            break;
          }
          discardUntilNewline = false;
          start = newlineIdx + 1;
          continue;
        }

        if (newlineIdx === -1) {
          const tailLen = buf.byteLength - start;
          if (bufferedBytes + tailLen > MAX_STDOUT_LINE_BYTES) {
            bufferedChunks = [];
            bufferedBytes = 0;
            discardUntilNewline = true;
            if (
              emitProtocolError(
                new AntigravityAcpError(
                  `ACP stdout line exceeded ${MAX_STDOUT_LINE_BYTES} byte limit`,
                  'TRANSPORT',
                ),
                failStream,
              )
            ) {
              return;
            }
            break;
          }
          bufferedChunks.push(Buffer.from(buf.subarray(start)));
          bufferedBytes += tailLen;
          start = buf.byteLength;
          break;
        }

        const segLen = newlineIdx - start;
        if (bufferedBytes + segLen > MAX_STDOUT_LINE_BYTES) {
          bufferedChunks = [];
          bufferedBytes = 0;
          start = newlineIdx + 1;
          if (
            emitProtocolError(
              new AntigravityAcpError(
                `ACP stdout line exceeded ${MAX_STDOUT_LINE_BYTES} byte limit`,
                'TRANSPORT',
              ),
              failStream,
            )
          ) {
            return;
          }
          continue;
        }

        const segment = buf.subarray(start, newlineIdx);
        const lineBuf =
          bufferedChunks.length > 0
            ? Buffer.concat([...bufferedChunks, Buffer.from(segment)])
            : Buffer.from(segment);
        bufferedChunks = [];
        bufferedBytes = 0;
        start = newlineIdx + 1;

        if (handleCompleteLine(lineBuf, (out) => this.push(out), failStream, true)) {
          return;
        }
      }

      if (!stopped) {
        callback();
      }
    },

    flush(callback: TransformCallback) {
      if (fatalErrored) {
        callback();
        return;
      }

      let stopped = false;
      const failStream = (err: Error): void => {
        stopped = true;
        callback(err);
      };

      if (!discardUntilNewline && bufferedBytes > 0) {
        const trailing =
          bufferedChunks.length === 1 ? bufferedChunks[0] : Buffer.concat(bufferedChunks);
        bufferedChunks = [];
        bufferedBytes = 0;
        if (handleCompleteLine(trailing, (out) => this.push(out), failStream, false)) {
          return;
        }
      }

      bufferedChunks = [];
      bufferedBytes = 0;
      if (!stopped) {
        callback();
      }
    },
  });
}

function tryExtractMarkerUrl(line: string): string | undefined {
  const markerIdx = line.indexOf(ANTIGRAVITY_AUTH_BROWSER_MARKER);
  if (markerIdx === -1) {
    return undefined;
  }

  let payload = line.slice(markerIdx + ANTIGRAVITY_AUTH_BROWSER_MARKER.length).trim();
  if (payload.startsWith(':') || payload.startsWith('=')) {
    payload = payload.slice(1).trim();
  }
  if (!payload) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === 'string') {
      return parsed;
    }
    if (typeof parsed === 'object' && parsed !== null && 'url' in parsed) {
      const candidate = (parsed as { url?: unknown }).url;
      return typeof candidate === 'string' ? candidate : undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/**
 * Create a stateful line scanner for stderr chunks that detects Antigravity auth URLs
 * emitted via stdout-style prefixes or the `BROWSER` interceptor JSON marker.
 */
export function createStderrAuthScanner(
  options?: StderrAuthScannerOptions,
): (chunk: string) => void {
  let pending = '';

  const scanLine = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      return;
    }

    const prefixIdx = line.indexOf(ANTIGRAVITY_AUTH_STDOUT_PREFIX);
    if (prefixIdx !== -1) {
      const rawUrl = line.slice(prefixIdx + ANTIGRAVITY_AUTH_STDOUT_PREFIX.length);
      try {
        const valid = validateAndExtractAuthUrl(rawUrl);
        options?.onAuthUrl?.(valid);
        return;
      } catch {
        // Ignore non-authoritative or invalid stderr log text.
      }
    }

    const markerCandidate = tryExtractMarkerUrl(line);
    if (markerCandidate !== undefined) {
      try {
        const valid = validateAndExtractAuthUrl(markerCandidate);
        options?.onAuthUrl?.(valid);
      } catch {
        // Ignore invalid or untrusted auth URLs from stderr.
      }
    }
  };

  return (chunk: string): void => {
    if (!chunk) {
      return;
    }
    pending += chunk;

    let searchFrom = 0;
    while (true) {
      const newlineIdx = pending.indexOf('\n', searchFrom);
      if (newlineIdx === -1) {
        break;
      }
      scanLine(pending.slice(searchFrom, newlineIdx));
      searchFrom = newlineIdx + 1;
    }

    pending = searchFrom > 0 ? pending.slice(searchFrom) : pending;
    if (pending.length > MAX_STDERR_LINE_CHARS) {
      pending = '';
    }
  };
}
