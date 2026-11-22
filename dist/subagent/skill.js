import { DEFAULT_ANTIGRAVITY_TOOL_NAME } from './tool.js';
export const ANTIGRAVITY_SUBAGENT_SKILL_NAME = 'antigravity-subagent';
export const ANTIGRAVITY_SKILL_PROVIDER_NAME = 'dsh-antigravity-acp';
export function renderAntigravitySkillContent(config) {
    const toolName = config.toolName?.trim() || DEFAULT_ANTIGRAVITY_TOOL_NAME;
    const activeModel = config.defaultModel?.trim() || '(Antigravity CLI default)';
    const thoughtLevel = config.defaultThoughtLevel?.trim() || '(Model default)';
    return [
        '# Antigravity ACP Subagent Delegation',
        '',
        `Use the \`${toolName}\` tool to delegate focused coding, repository research, multi-file analysis, or second-opinion review tasks to an isolated Antigravity ACP subagent.`,
        '',
        '## Active Settings',
        `- Tool: \`${toolName}\``,
        `- Default model: \`${activeModel}\``,
        `- Default thinking level: \`${thoughtLevel}\``,
        `- Permission mode: \`${config.permissionMode}\``,
        '',
        '## How to Call Effectively',
        '1. Always write a **self-contained** `prompt`: Antigravity runs in a fresh out-of-process worker with no access to the current conversation history.',
        '2. Specify exact target files/directories, goal, verification criteria, and desired output format.',
        '3. Keep `description` concise (3–5 words) for clean UI status cards.',
        '4. Omit `model` and `thought_level` to use the user-selected configuration in **Settings → Antigravity ACP**, unless a specific override is needed.',
        `5. For independent subtasks, invoke multiple \`${toolName}\` calls in parallel in one turn.`,
        '',
        '## When to Prefer Direct Tools vs Antigravity',
        '- **Prefer direct DSH tools** for single-file reads, quick grep checks, or trivial edits.',
        `- **Prefer \`${toolName}\`** for broad exploration, independent implementation modules, complex debugging second opinions, or offloading long reasoning without filling the parent context window.`,
    ].join('\n');
}
/**
 * Register the `antigravity-subagent` skill on DSH's `ctx.skills` registry.
 * Uses `registerProvider` when supported so the loaded skill body always reflects
 * live model settings from Settings -> Antigravity ACP without churning the skill catalog summary.
 */
export function registerAntigravitySubagentSkill(options) {
    const summaryMeta = {
        name: ANTIGRAVITY_SUBAGENT_SKILL_NAME,
        description: 'Guide for delegating focused coding, codebase research, or review tasks to the Antigravity ACP subagent (`antigravity_agent`) using the configured Antigravity model.',
        whenToUse: 'Load when deciding how to structure prompts or model overrides for the antigravity_agent subagent tool, or when the user invokes /antigravity-subagent.',
        invocation: {
            modelInvocable: true,
            userInvocable: true,
        },
        provider: ANTIGRAVITY_SKILL_PROVIDER_NAME,
        source: 'bundled',
        rank: 600,
        locator: ANTIGRAVITY_SUBAGENT_SKILL_NAME,
    };
    if (typeof options.skills.registerProvider === 'function') {
        let disposeWatcher;
        const disposeProvider = options.skills.registerProvider((control) => {
            disposeWatcher = options.subscribeConfigChange?.(() => {
                if (!control.signal.aborted) {
                    control.invalidate();
                }
            });
            return {
                name: ANTIGRAVITY_SKILL_PROVIDER_NAME,
                list: () => Promise.resolve([summaryMeta]),
                get: async () => ({
                    name: summaryMeta.name,
                    description: summaryMeta.description,
                    whenToUse: summaryMeta.whenToUse,
                    invocation: summaryMeta.invocation,
                    provider: summaryMeta.provider,
                    source: summaryMeta.source,
                    content: renderAntigravitySkillContent(options.getConfig()),
                }),
            };
        });
        return () => {
            disposeWatcher?.();
            disposeProvider();
        };
    }
    if (typeof options.skills.register === 'function') {
        return options.skills.register({
            name: summaryMeta.name,
            description: summaryMeta.description,
            whenToUse: summaryMeta.whenToUse,
            invocation: summaryMeta.invocation,
            source: summaryMeta.source,
            provider: summaryMeta.provider,
            content: renderAntigravitySkillContent(options.getConfig()),
        });
    }
    return () => { };
}
/**
 * Register a lightweight prompt section in `ctx.systemPrompt` (at `TOOL_SUBAGENT` order)
 * whenever the `antigravity_agent` tool is visible in the active agent scope.
 */
export function registerAntigravitySystemPrompt(options) {
    const initialConfig = options.getConfig();
    const toolName = initialConfig.toolName?.trim() || DEFAULT_ANTIGRAVITY_TOOL_NAME;
    const order = options.systemPrompt.getSectionOrder?.('TOOL_SUBAGENT') ?? 2800;
    return options.systemPrompt.section({
        name: `tool:${toolName}`,
        order,
        interpolate: false,
        text: (context) => {
            if (options.tools.get(toolName, context.scope) !== options.toolDefinition) {
                return '';
            }
            return [
                `Antigravity subagent delegation is available via \`${toolName}\` (and detailed instructions in skill \`${ANTIGRAVITY_SUBAGENT_SKILL_NAME}\`).`,
                `Use \`${toolName}\` for self-contained research, coding, or second-opinion subtasks using the configured Antigravity model; always pass standalone context in \`prompt\` because the worker starts isolated without prior chat history.`,
            ].join(' ');
        },
    });
}
//# sourceMappingURL=skill.js.map