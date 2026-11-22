#!/usr/bin/env node
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { type AntigravityAuthMethod, type RuntimeConfigInput } from './shared/config.js';
/**
 * Lightweight standalone {@link SubprocessRuntime} implemented purely on Node's `child_process`
 * so the CLI works independently without `@deepseek-ai/dsh-subprocess-local`.
 */
export declare function createStandaloneSubprocessRuntime(): SubprocessRuntime;
/** Parsed CLI invocation arguments. */
export interface ParsedCliArgs {
    readonly command: string;
    readonly help: boolean;
    readonly json: boolean;
    readonly loginMode: 'auto' | 'code' | 'loopback';
    readonly noOpen: boolean;
    readonly refresh: boolean;
    readonly strict: boolean;
    readonly cwd?: string;
    readonly configOverrides: RuntimeConfigInput;
    readonly apiKey?: string;
    readonly authMethod?: AntigravityAuthMethod;
}
/** Parse CLI arguments into subcommand + flags. */
export declare function parseCliArgs(argv: readonly string[]): ParsedCliArgs;
export declare function renderCliHelp(): string;
interface CliIo {
    stdout(line: string): void;
    stderr(line: string): void;
    readLine(prompt: string): Promise<string>;
}
/** Execute the CLI against `argv`. Returns process exit code. */
export declare function runCli(argv: readonly string[], io?: CliIo): Promise<number>;
export {};
//# sourceMappingURL=cli.d.ts.map