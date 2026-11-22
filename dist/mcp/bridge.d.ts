import type * as acp from '@agentclientprotocol/sdk';
import { ToolCallId, type ToolSchema } from '@deepseek-ai/dsh-llm';
import { type SanitizedMcpTool } from './schema.js';
/** Maximum HTTP POST payload accepted by {@link PrivateMcpBridge} (1 MiB). */
export declare const MAX_BRIDGE_REQUEST_BYTES: number;
/** Maximum concurrent parked `tools/call` invocations held by {@link PrivateMcpBridge}. */
export declare const MAX_PENDING_TOOL_CALLS = 64;
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
/**
 * Private loopback Streamable HTTP MCP server bridging DSH tool calls across an in-flight ACP prompt.
 *
 * Each `tools/call` request validates the tool against the active sanitized catalog, parks an
 * open HTTP response behind a {@link ParkedToolCall}, notifies the active turn listener, and stays
 * open until {@link deliverToolResults} resolves it or a timeout/abort fires.
 */
export declare class PrivateMcpBridge {
    private readonly token;
    private readonly tokenBuffer;
    private readonly toolTimeoutMs;
    private readonly maxPendingCalls;
    private readonly maxRequestBytes;
    private readonly serverName;
    private server;
    private startPromise;
    private url;
    private closed;
    private tools;
    private toolsByName;
    private turnListener;
    private readonly pendingCalls;
    constructor(options?: PrivateMcpBridgeOptions);
    /** Whether the bridge HTTP server is currently listening. */
    get isListening(): boolean;
    /** Loopback MCP endpoint URL (`http://127.0.0.1:<port>/mcp`). */
    get endpointUrl(): string;
    /** Current count of parked `tools/call` invocations awaiting results. */
    get pendingCount(): number;
    /** Snapshot of all currently parked tool calls in insertion order. */
    getPendingCalls(): readonly ParkedToolCallInfo[];
    /** Whether a parked tool call with `id` is currently pending. */
    hasPendingCall(id: ToolCallId): boolean;
    /** Update exposed tools from raw DSH tool schemas (validated & sanitized). */
    setTools(tools: readonly ToolSchema[] | undefined): readonly SanitizedMcpTool[];
    /** Update exposed tools from an already-sanitized catalog. */
    setSanitizedTools(tools: readonly SanitizedMcpTool[]): void;
    /** Register or clear the turn listener notified when `tools/call` parks. */
    setTurnListener(listener: PrivateMcpBridgeTurnListener | undefined): void;
    /** Bind the private HTTP server strictly on `127.0.0.1:0`. */
    start(): Promise<void>;
    /** Return the ACP `McpServer` HTTP descriptor carrying the per-bridge Bearer token. */
    getMcpServerConfig(): acp.McpServer;
    /**
     * Deliver DSH tool execution results to parked HTTP `tools/call` requests.
     */
    deliverToolResults(results: ReadonlyMap<ToolCallId, McpToolCallResult>): void;
    /**
     * Abort all currently parked HTTP `tools/call` requests with `error`.
     */
    abortAll(error: Error): void;
    /**
     * Abort pending calls and close all HTTP connections cleanly. Idempotent.
     */
    close(): Promise<void>;
    private isAuthorized;
    private handleHttpRequest;
    private handleJsonRpcRequest;
    private handleToolsCall;
}
//# sourceMappingURL=bridge.d.ts.map