import type * as acp from '@agentclientprotocol/sdk';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { type ResolvedSubagentStartRequest, type SubagentCapabilities, type SubagentProvider, type SubagentRun } from '@deepseek-ai/dsh-subagent';
import type { AntigravityPermissionFallback, AntigravityPermissionMode, SubagentPluginConfig } from '../shared/config.js';
import type { AntigravityRuntimeService } from '../shared/contracts.js';
/** Minimal logger surface accepted by {@link AntigravitySubagentProvider}. */
export interface SubagentProviderLogger {
    debug?(message: string, ...args: unknown[]): void;
    info?(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error?(message: string, ...args: unknown[]): void;
}
/**
 * Evaluate an ACP `session/request_permission` prompt according to the configured
 * {@link AntigravityPermissionMode} and {@link AntigravityPermissionFallback}.
 */
export declare function resolveSubagentPermission(request: acp.RequestPermissionRequest, permissionMode: AntigravityPermissionMode, permissionFallback: AntigravityPermissionFallback): acp.RequestPermissionResponse;
/**
 * Out-of-process DSH {@link SubagentProvider} backed by isolated `agy acp` workers.
 *
 * Each run spawns an independent ACP subprocess with no DSH tool bridge (`mcpServers: []`),
 * allowing Antigravity's native agent loop to execute autonomously within `request.cwd`
 * under the configured permission policy.
 */
export declare class AntigravitySubagentProvider implements SubagentProvider {
    private readonly runtime;
    private readonly attachments?;
    private readonly logger?;
    readonly name: string;
    readonly capabilities: SubagentCapabilities;
    readonly inheritsParentContext = false;
    private readonly resolveConfig;
    constructor(runtime: AntigravityRuntimeService, configOrResolver: SubagentPluginConfig | (() => SubagentPluginConfig), attachments?: AttachmentStore | undefined, logger?: SubagentProviderLogger | undefined);
    start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>;
}
//# sourceMappingURL=provider.d.ts.map