import { Transform } from 'node:stream';
/** Maximum single NDJSON line length buffered from ACP stdout (16 MiB). */
export declare const MAX_STDOUT_LINE_BYTES: number;
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
/**
 * Create a {@link Transform} stream that buffers `\n`-delimited lines up to 16 MiB,
 * intercepts Antigravity auth URL lines on stdout before they reach `ndJsonStream`,
 * and forwards valid NDJSON lines unchanged.
 */
export declare function createStdoutAuthFilter(options?: StdoutAuthFilterOptions): Transform;
/**
 * Create a stateful line scanner for stderr chunks that detects Antigravity auth URLs
 * emitted via stdout-style prefixes or the `BROWSER` interceptor JSON marker.
 */
export declare function createStderrAuthScanner(options?: StderrAuthScannerOptions): (chunk: string) => void;
//# sourceMappingURL=stdout-filter.d.ts.map