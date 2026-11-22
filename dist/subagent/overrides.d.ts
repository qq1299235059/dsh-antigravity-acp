import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SubagentPluginConfig, SubagentUiOverrides } from '../shared/config.js';
/** Per-invocation overrides passed from `antigravity_agent` tool arguments. */
export interface AntigravitySubagentCallOverrides {
    readonly model?: string;
    readonly thoughtLevel?: string;
}
/**
 * Attach per-call model/thinking overrides keyed on the request's `prompt` block array.
 * Safe for external `SubagentStartRequest` calls because DSH preserves `request.prompt` by reference.
 */
export declare function setPendingCallOverrides(prompt: readonly ContentBlock[], overrides: AntigravitySubagentCallOverrides): void;
/** Read and remove any attached per-call overrides for a subagent start request. */
export declare function consumePendingCallOverrides(prompt: readonly ContentBlock[]): AntigravitySubagentCallOverrides | undefined;
/** Clear unconsumed per-call overrides (e.g. if activation startup throws before `provider.start`). */
export declare function clearPendingCallOverrides(prompt: readonly ContentBlock[]): void;
/**
 * Merge persisted/live UI subagent overrides onto a base {@link SubagentPluginConfig}.
 */
export declare function mergeSubagentConfigWithOverrides(baseConfig: SubagentPluginConfig, overrides?: SubagentUiOverrides): SubagentPluginConfig;
//# sourceMappingURL=overrides.d.ts.map