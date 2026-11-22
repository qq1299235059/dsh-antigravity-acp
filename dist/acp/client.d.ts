import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { type InternalAntigravityProfile } from '../runtime/profile.js';
import type { RuntimeConfig } from '../shared/config.js';
import type { AcpClientHandle, AcpTurnCallbacks, AntigravityExecutable } from '../shared/contracts.js';
/** Options for {@link spawnAcpClient}. */
export interface SpawnAcpClientOptions {
    readonly subprocess: SubprocessRuntime;
    readonly executable: AntigravityExecutable;
    readonly profile: InternalAntigravityProfile;
    readonly config: RuntimeConfig;
    readonly cwd: string;
    readonly env?: Record<string, string>;
    readonly callbacks?: AcpTurnCallbacks;
    readonly onAuthUrl?: (url: string) => void;
    readonly suppressBrowser?: boolean;
    readonly skipVersionCheck?: boolean;
    readonly signal?: AbortSignal;
}
/**
 * Spawn an Antigravity CLI ACP subprocess, negotiate `initialize`, and return a managed {@link AcpClientHandle}.
 */
export declare function spawnAcpClient(options: SpawnAcpClientOptions): Promise<AcpClientHandle>;
//# sourceMappingURL=client.d.ts.map