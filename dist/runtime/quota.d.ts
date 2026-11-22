import type { RuntimeConfig } from '../shared/config.js';
import type { QuotaSnapshot } from '../shared/contracts.js';
/** Options for {@link probeAntigravityQuota}. */
export interface ProbeAntigravityQuotaOptions {
    readonly fetch?: typeof globalThis.fetch;
    readonly signal?: AbortSignal;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly homeDir?: string;
    readonly platform?: NodeJS.Platform;
    readonly now?: () => Date;
    readonly timeoutMs?: number;
}
/**
 * Probe Cloud Code Assist quota endpoints using the active profile's OAuth credentials.
 */
export declare function probeAntigravityQuota(config: RuntimeConfig, options?: ProbeAntigravityQuotaOptions): Promise<QuotaSnapshot>;
//# sourceMappingURL=quota.d.ts.map