import { defineTool, } from '@deepseek-ai/dsh-tools';
import { clearPendingCallOverrides, setPendingCallOverrides } from './overrides.js';
export const DEFAULT_ANTIGRAVITY_TOOL_NAME = 'antigravity_agent';
function normalizeOptionalString(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function parseToolArgs(args) {
    const record = typeof args === 'object' && args !== null && !Array.isArray(args)
        ? args
        : {};
    const description = normalizeOptionalString(record['description']) ?? 'Antigravity task';
    const prompt = typeof record['prompt'] === 'string' ? record['prompt'] : '';
    const cwd = normalizeOptionalString(record['cwd']);
    const model = normalizeOptionalString(record['model']);
    const thought_level = normalizeOptionalString(record['thought_level']);
    return {
        description,
        prompt,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(thought_level !== undefined ? { thought_level } : {}),
    };
}
function extractOutputText(output) {
    const chunks = [];
    for (const block of output) {
        if (block.type === 'text' && block.text.length > 0) {
            chunks.push(block.text);
        }
    }
    return chunks.join('\n\n').trim();
}
function usesNestedRequestActivationSpec(subagents) {
    const candidate = subagents;
    if (typeof candidate.rootOf === 'function' || typeof candidate.namesOf === 'function') {
        return false;
    }
    try {
        const source = candidate.startActivation?.toString?.();
        if (typeof source === 'string' && source.includes('spec.request')) {
            return true;
        }
    }
    catch {
        // Ignore native/proxy toString failures
    }
    return false;
}
function parseCanonicalOutput(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    const record = value;
    if (typeof record['subagentId'] !== 'string' ||
        typeof record['provider'] !== 'string' ||
        typeof record['stopReason'] !== 'string' ||
        typeof record['outputText'] !== 'string') {
        return undefined;
    }
    return {
        subagentId: record['subagentId'],
        provider: record['provider'],
        ...(typeof record['model'] === 'string' ? { model: record['model'] } : {}),
        ...(typeof record['thoughtLevel'] === 'string' ? { thoughtLevel: record['thoughtLevel'] } : {}),
        stopReason: record['stopReason'],
        outputText: record['outputText'],
    };
}
/**
 * Create the model-facing `antigravity_agent` DSH tool that executes tasks through
 * `ctx.subagents.startActivation({ delivery: 'caller' })` backed by {@link AntigravitySubagentProvider}.
 */
export function createAntigravitySubagentTool(options) {
    const initialConfig = options.getConfig();
    const toolName = normalizeOptionalString(options.toolName ?? initialConfig.toolName) ??
        DEFAULT_ANTIGRAVITY_TOOL_NAME;
    return defineTool({
        name: toolName,
        description: 'Delegate a self-contained coding, research, analysis, or review subtask to an isolated Antigravity ACP subagent (powered by your configured Antigravity CLI model & OAuth). The subagent runs autonomously in its own context and returns its final response directly. Include all required file paths, constraints, and goals in `prompt`. Omit `model` and `thought_level` to use the defaults configured in Settings -> Antigravity ACP -> Subagent.',
        parameters: {
            description: {
                type: 'string',
                required: true,
                description: 'Short (3-5 word) summary of the delegated task, shown in the UI.',
            },
            prompt: {
                type: 'string',
                required: true,
                description: 'Complete, self-contained instructions for the Antigravity subagent. It cannot see parent chat history, so include relevant files, context, constraints, and expected output.',
            },
            cwd: {
                type: 'string',
                description: 'Optional working directory for the subagent (relative paths resolve from your current directory; omit to inherit parent directory).',
            },
            model: {
                type: 'string',
                description: 'Optional Antigravity model ID override for this call only (omit to use Settings -> Antigravity ACP -> Subagent model).',
            },
            thought_level: {
                type: 'string',
                description: 'Optional thinking/reasoning level override (e.g. low, medium, high). Omit to use configured default.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    subagentId: { type: 'string', required: true },
                    provider: { type: 'string', required: true },
                    model: { type: 'string' },
                    thoughtLevel: { type: 'string' },
                    stopReason: { type: 'string', required: true },
                    outputText: { type: 'string', required: true },
                },
            },
            render: (_rawArgs, rawValue) => {
                const parsed = parseCanonicalOutput(rawValue);
                if (!parsed) {
                    return [{ type: 'text', text: '' }];
                }
                const metaParts = [
                    parsed.model ? `model=${parsed.model}` : undefined,
                    parsed.thoughtLevel ? `thought=${parsed.thoughtLevel}` : undefined,
                    parsed.stopReason !== 'completed' ? `stopReason=${parsed.stopReason}` : undefined,
                ].filter((part) => part !== undefined);
                const body = parsed.outputText || '(Antigravity subagent finished with empty text output.)';
                const header = metaParts.length > 0 ? `[Antigravity (${metaParts.join(', ')})]\n` : '';
                return [{ type: 'text', text: `${header}${body}` }];
            },
        },
        isConcurrencySafe: () => true,
        presentCall(rawArgs) {
            const args = parseToolArgs(rawArgs);
            const effectiveConfig = options.getConfig();
            const targetModel = args.model ?? effectiveConfig.defaultModel;
            const targetThought = args.thought_level ?? effectiveConfig.defaultThoughtLevel;
            const detailParts = [
                targetModel ? `model: ${targetModel}` : undefined,
                targetThought ? `thinking: ${targetThought}` : undefined,
                args.cwd ? `cwd: ${args.cwd}` : undefined,
            ].filter((part) => part !== undefined);
            return {
                card: 'generic',
                kind: 'other',
                title: `Antigravity: ${args.description}`,
                ...(detailParts.length > 0 ? { rawInput: detailParts.join(' | ') } : {}),
            };
        },
        presentResult(rawArgs, toolResult) {
            const args = parseToolArgs(rawArgs);
            return {
                card: 'generic',
                title: toolResult.isError
                    ? `Antigravity Failed: ${args.description}`
                    : `Antigravity Completed: ${args.description}`,
            };
        },
        async execute(rawArgs, exec) {
            const parent = exec.agent;
            if (!parent) {
                throw new Error(`${toolName} tool requires a calling agent (exec.agent was undefined)`);
            }
            exec.signal.throwIfAborted();
            const args = parseToolArgs(rawArgs);
            if (args.prompt.trim().length === 0) {
                throw new Error(`${toolName} requires a non-empty prompt`);
            }
            const activeConfig = options.getConfig();
            const providerName = activeConfig.providerName?.trim() || 'antigravity';
            const effectiveModel = args.model ?? activeConfig.defaultModel;
            const effectiveThoughtLevel = args.thought_level ?? activeConfig.defaultThoughtLevel;
            const promptBlocks = [{ type: 'text', text: args.prompt }];
            if (args.model !== undefined || args.thought_level !== undefined) {
                setPendingCallOverrides(promptBlocks, {
                    ...(args.model !== undefined ? { model: args.model } : {}),
                    ...(args.thought_level !== undefined ? { thoughtLevel: args.thought_level } : {}),
                });
            }
            let activation;
            try {
                const activationSpec = usesNestedRequestActivationSpec(options.subagents)
                    ? {
                        provider: providerName,
                        label: args.description,
                        delivery: 'caller',
                        signal: exec.signal,
                        request: {
                            ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
                            prompt: promptBlocks,
                            parent,
                        },
                    }
                    : {
                        provider: providerName,
                        label: args.description,
                        delivery: 'caller',
                        signal: exec.signal,
                        ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
                        prompt: promptBlocks,
                        parent,
                    };
                activation = await options.subagents.startActivation(activationSpec);
            }
            finally {
                clearPendingCallOverrides(promptBlocks);
            }
            let disposalPromise;
            let rejectAbortRace;
            const abortRace = new Promise((_resolve, reject) => {
                rejectAbortRace = reject;
            });
            const onAbort = () => {
                disposalPromise ??= activation.dispose().catch(() => { });
                rejectAbortRace?.(exec.signal.reason instanceof Error
                    ? exec.signal.reason
                    : new Error('Antigravity subagent execution cancelled'));
            };
            if (exec.signal.aborted) {
                onAbort();
            }
            else {
                exec.signal.addEventListener('abort', onAbort, { once: true });
            }
            let result;
            try {
                result = await Promise.race([activation.result, abortRace]);
            }
            catch (error) {
                if (disposalPromise !== undefined || exec.signal.aborted) {
                    await (disposalPromise ?? activation.dispose().catch(() => { }));
                    await activation.result.catch(() => { });
                }
                throw error;
            }
            finally {
                exec.signal.removeEventListener('abort', onAbort);
            }
            const outputText = extractOutputText(result.output);
            if (result.stopReason === 'error') {
                const message = result.diagnostic || outputText || 'Antigravity ACP subagent execution failed';
                throw new Error(message);
            }
            if (result.stopReason === 'aborted') {
                const abortReason = exec.signal.aborted
                    ? exec.signal.reason instanceof Error
                        ? exec.signal.reason
                        : new Error('Antigravity ACP subagent execution aborted')
                    : new Error(result.diagnostic || 'Antigravity ACP subagent execution aborted');
                throw abortReason;
            }
            return {
                subagentId: activation.childId,
                provider: providerName,
                ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
                ...(effectiveThoughtLevel !== undefined ? { thoughtLevel: effectiveThoughtLevel } : {}),
                stopReason: result.stopReason,
                outputText,
            };
        },
    });
}
//# sourceMappingURL=tool.js.map