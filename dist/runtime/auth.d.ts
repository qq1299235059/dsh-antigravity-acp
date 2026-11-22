import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { RuntimeConfig } from '../shared/config.js';
import type { AcpClientHandle, AntigravityExecutable, AntigravityProfile } from '../shared/contracts.js';
import { type InternalAntigravityProfile } from './profile.js';
/** Options for {@link runCodeLogin}. */
export interface RunCodeLoginOptions {
    readonly config: RuntimeConfig;
    readonly executable: AntigravityExecutable;
    readonly subprocess: SubprocessRuntime;
    readonly onAuthUrl: (url: string) => void | Promise<void>;
    readonly readCode: () => Promise<string>;
    readonly signal?: AbortSignal;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly homeDir?: string;
    readonly platform?: NodeJS.Platform;
    readonly cwd?: string;
}
/** Options for {@link runLoopbackLogin}. */
export interface RunLoopbackLoginOptions {
    readonly config: RuntimeConfig;
    readonly connectClient: (params: {
        readonly profile: InternalAntigravityProfile;
        readonly onAuthUrl: (url: string) => void;
        readonly signal: AbortSignal;
    }) => Promise<AcpClientHandle>;
    readonly onAuthUrl?: (url: string) => void;
    readonly suppressBrowser?: boolean;
    readonly signal?: AbortSignal;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly homeDir?: string;
    readonly platform?: NodeJS.Platform;
}
/**
 * Inspect whether the configured Antigravity profile currently holds usable credentials.
 */
export declare function checkProfileAuth(config: RuntimeConfig, env?: Readonly<Record<string, string | undefined>>, homeDir?: string, platform?: NodeJS.Platform): Promise<AntigravityProfile>;
/**
 * Run interactive headless code login via `agy acp --login`.
 */
export declare function runCodeLogin(options: RunCodeLoginOptions): Promise<AntigravityProfile>;
/**
 * Run loopback OAuth login through a caller-supplied ACP client connector.
 */
export declare function runLoopbackLogin(options: RunLoopbackLoginOptions): Promise<AntigravityProfile>;
/**
 * Remove stored OAuth credentials and account files from an isolated profile.
 */
export declare function clearProfileAuth(profile: AntigravityProfile | InternalAntigravityProfile): Promise<void>;
//# sourceMappingURL=auth.d.ts.map