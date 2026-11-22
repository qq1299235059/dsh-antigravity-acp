import type { ToolSchema } from '@deepseek-ai/dsh-llm';
/** Maximum number of DSH tools accepted by the private MCP bridge. */
export declare const MAX_MCP_TOOLS = 256;
/** Maximum UTF-8 JSON byte size allowed for a single sanitized MCP tool definition. */
export declare const MAX_MCP_TOOL_BYTES: number;
/** MCP tool definition produced from a DSH {@link ToolSchema}. */
export interface SanitizedMcpTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
}
/**
 * Validate and sanitize a DSH tool catalog for MCP `tools/list` exposure.
 */
export declare function sanitizeToolCatalog(tools: readonly ToolSchema[] | undefined): SanitizedMcpTool[];
/**
 * Compute a deterministic SHA-256 signature over a sanitized MCP tool catalog.
 */
export declare function computeToolCatalogSignature(tools: readonly SanitizedMcpTool[]): string;
//# sourceMappingURL=schema.d.ts.map