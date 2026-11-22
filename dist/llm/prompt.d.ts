import type * as acp from '@agentclientprotocol/sdk';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { type ContentBlock, type GenerateOptions, type RequestMessage } from '@deepseek-ai/dsh-llm';
/** Maximum raw byte size allowed per inline image block (10 MiB). */
export declare const MAX_SINGLE_IMAGE_BYTES: number;
/** Maximum combined raw byte size of inline images in one request (50 MiB). */
export declare const MAX_TOTAL_IMAGE_BYTES: number;
/** Options for converting DSH messages into ACP prompt content blocks. */
export interface BuildTurnPromptOptions {
    readonly messages: readonly RequestMessage[];
    readonly systemPrompt?: string;
    readonly includeSystemPromptInTurn?: boolean;
    readonly supportsImages: boolean;
    readonly strictUnsupportedContent?: boolean;
    readonly attachments?: AttachmentStore;
    readonly maxPromptBytes: number;
    readonly signal?: AbortSignal;
}
/**
 * Count leading `role: 'system'` messages in a request message array.
 */
export declare function countLeadingSystemMessages(messages: readonly RequestMessage[]): number;
/**
 * Combine `options.system` and any leading `role: 'system'` message text into one prompt string.
 */
export declare function extractSystemPrompt(options: Pick<GenerateOptions, 'system' | 'messages'>): string;
/**
 * Convert a slice of DSH conversation messages into ACP {@link acp.ContentBlock}s,
 * enforcing image capability/size limits and `maxPromptBytes` trimming rules.
 */
export declare function buildTurnMessagesAndBlocks(options: BuildTurnPromptOptions): Promise<acp.ContentBlock[]>;
/**
 * Deterministic SHA-256 fingerprint for an individual DSH {@link RequestMessage}.
 */
export declare function hashRequestMessage(message: RequestMessage): string;
/**
 * Compute exact and text/tool fallback fingerprints for emitted assistant {@link ContentBlock}s.
 */
export declare function computeAssistantFingerprints(blocks: readonly ContentBlock[]): readonly string[];
/**
 * Deterministic configuration fingerprint governing ACP session reuse compatibility.
 */
export declare function computeSessionConfigHash(input: {
    readonly systemPrompt: string;
    readonly model: string;
    readonly reasoningEffort?: string;
    readonly toolsSignature: string;
}): string;
/** Stored state for a completed turn eligible for ACP session reuse. */
export interface TrackedReusableSession {
    readonly sessionKey: string;
    readonly provider: string;
    readonly acpSessionId: string;
    readonly workerId: string;
    readonly configHash: string;
    readonly sentMessageHashes: readonly string[];
    readonly assistantFingerprints: readonly string[];
    readonly supportsImages: boolean;
    readonly appendsSystemPrompt: boolean;
}
/** Plan decision produced by {@link SessionReuseTracker.plan}. */
export type SessionReusePlan = {
    readonly canReuse: true;
    readonly tracked: TrackedReusableSession;
    readonly deltaMessages: readonly RequestMessage[];
} | {
    readonly canReuse: false;
    readonly deltaMessages: readonly RequestMessage[];
};
/**
 * Tracks per-session SHA-256 history fingerprints so strictly extending turns send only deltas
 * and any compaction, rewind, or config/tool/model/system change forces a clean session rebuild.
 */
export declare class SessionReuseTracker {
    private readonly sessions;
    get(sessionKey: string): TrackedReusableSession | undefined;
    delete(sessionKey: string): void;
    clear(): void;
    keys(): readonly string[];
    plan(input: {
        readonly sessionKey?: string;
        readonly provider: string;
        readonly reuseEnabled: boolean;
        readonly configHash: string;
        readonly messages: readonly RequestMessage[];
    }): SessionReusePlan;
    record(session: TrackedReusableSession): void;
}
//# sourceMappingURL=prompt.d.ts.map