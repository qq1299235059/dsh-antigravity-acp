import type * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  antigravityAppendsSystemPrompt,
  antigravityClientInfo,
  antigravitySessionMeta,
  antigravitySessionMode,
  antigravityToolOutlivesPrompt,
  isMcpToolCallMeta,
  isSignInRequiredError,
  normalizeStopReasonToLlm,
  parseModelsAndThinking,
  selectPermissionOption,
} from '../../src/acp/protocol.js';
import { AntigravityAcpError } from '../../src/shared/errors.js';

describe('acp/protocol', () => {
  describe('antigravityClientInfo', () => {
    it('returns legacy zed clientInfo for versions below 1.5.1', () => {
      expect(antigravityClientInfo('1.5.0')).toEqual({ name: 'zed', version: '0.0.0' });
      expect(antigravityClientInfo('1.4.9')).toEqual({ name: 'zed', version: '0.0.0' });
      expect(antigravityClientInfo('v1.5.1-rc.1')).toEqual({ name: 'zed', version: '0.0.0' });
    });

    it('returns modern dsh-antigravity-acp clientInfo for >= 1.5.1 or unknown versions', () => {
      const modern = { name: 'dsh-antigravity-acp', title: 'DSH Antigravity ACP', version: '0.1.0' };
      expect(antigravityClientInfo('1.5.1')).toEqual(modern);
      expect(antigravityClientInfo('1.5.2')).toEqual(modern);
      expect(antigravityClientInfo('v2.0.0')).toEqual(modern);
      expect(antigravityClientInfo(undefined)).toEqual(modern);
      expect(antigravityClientInfo(null)).toEqual(modern);
      expect(antigravityClientInfo('dev-build')).toEqual(modern);
    });
  });

  describe('system prompt capability & meta', () => {
    it('detects _meta.antigravity.systemPrompt.append === true', () => {
      expect(antigravityAppendsSystemPrompt(undefined)).toBe(false);
      expect(antigravityAppendsSystemPrompt({ _meta: {} })).toBe(false);
      expect(
        antigravityAppendsSystemPrompt({
          _meta: { antigravity: { systemPrompt: { append: false } } },
        }),
      ).toBe(false);
      expect(
        antigravityAppendsSystemPrompt({
          _meta: { antigravity: { systemPrompt: { append: 'yes' } } },
        }),
      ).toBe(false);
      expect(
        antigravityAppendsSystemPrompt({
          _meta: { antigravity: { systemPrompt: { append: true } } },
        }),
      ).toBe(true);
    });

    it('builds session meta only when supported and non-empty', () => {
      const caps: acp.AgentCapabilities = {
        _meta: { antigravity: { systemPrompt: { append: true } } },
      };
      expect(antigravitySessionMeta(caps, 'Follow strict rules')).toEqual({
        antigravity: { systemPrompt: { append: 'Follow strict rules' } },
      });
      expect(antigravitySessionMeta(caps, '   ')).toBeUndefined();
      expect(antigravitySessionMeta(caps, undefined)).toBeUndefined();
      expect(antigravitySessionMeta({}, 'Follow strict rules')).toBeUndefined();
    });
  });

  describe('antigravitySessionMode', () => {
    it('maps yolo and auto_edit to default and guards auto against availableModes', () => {
      expect(antigravitySessionMode('yolo', [{ id: 'default' }, { id: 'auto' }])).toBe('default');
      expect(antigravitySessionMode('auto_edit', [{ id: 'default' }, { id: 'auto' }])).toBe('default');
      expect(antigravitySessionMode('auto', [{ id: 'default' }, { id: 'auto' }])).toBe('auto');
      expect(antigravitySessionMode('auto', [{ id: 'default' }])).toBe('default');
      expect(antigravitySessionMode('auto')).toBe('default');
      expect(antigravitySessionMode('default')).toBe('default');
      expect(antigravitySessionMode('plan', [{ id: 'default' }, { id: 'plan' }])).toBe('plan');
      expect(antigravitySessionMode('plan', [{ id: 'default' }])).toBe('default');
    });
  });

  describe('selectPermissionOption', () => {
    const allOptions: acp.PermissionOption[] = [
      { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'aa', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'r1', name: 'Reject once', kind: 'reject_once' },
      { optionId: 'ra', name: 'Always reject', kind: 'reject_always' },
    ];

    it('selects exact option when present', () => {
      expect(selectPermissionOption(allOptions, 'allow_once')?.optionId).toBe('a1');
      expect(selectPermissionOption(allOptions, 'allow_always')?.optionId).toBe('aa');
      expect(selectPermissionOption(allOptions, 'reject_once')?.optionId).toBe('r1');
      expect(selectPermissionOption(allOptions, 'reject_always')?.optionId).toBe('ra');
    });

    it('falls back within polarity without crossing allow/reject boundary', () => {
      const onlyAlways: acp.PermissionOption[] = [
        { optionId: 'aa', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'ra', name: 'Always reject', kind: 'reject_always' },
      ];
      expect(selectPermissionOption(onlyAlways, 'allow_once')?.optionId).toBe('aa');
      expect(selectPermissionOption(onlyAlways, 'reject_once')?.optionId).toBe('ra');

      const onlyAllow: acp.PermissionOption[] = [
        { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
      ];
      expect(selectPermissionOption(onlyAllow, 'reject_once')).toBeUndefined();
    });
  });

  describe('parseModelsAndThinking', () => {
    it('parses flat and grouped configOptions with thought_level ThinkingOption[]', () => {
      const configOptions: acp.SessionConfigOption[] = [
        {
          id: 'model_select',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gemini-2.5-pro',
          options: [
            {
              group: 'google',
              name: 'Google',
              options: [
                {
                  value: 'gemini-2.5-pro',
                  name: 'Gemini 2.5 Pro',
                  description: 'Primary reasoning model',
                  _meta: { contextWindow: 1_000_000, inputModalities: ['text', 'image'] },
                },
                {
                  value: 'gemini-2.5-flash',
                  name: 'Gemini 2.5 Flash',
                },
              ],
            },
          ],
        },
        {
          id: 'thinking_cfg',
          name: 'Thought Level',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'off', name: 'Off', description: 'Disable thinking' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ];

      const models = parseModelsAndThinking({ configOptions });
      expect(models).toEqual([
        {
          id: 'gemini-2.5-pro',
          name: 'Gemini 2.5 Pro',
          description: 'Primary reasoning model',
          contextWindow: 1_000_000,
          inputModalities: ['text', 'image'],
          defaultThoughtLevel: 'medium',
          thinkingOptions: [
            { id: 'off', name: 'Off', description: 'Disable thinking', configId: 'thinking_cfg' },
            { id: 'medium', name: 'Medium', configId: 'thinking_cfg' },
            { id: 'high', name: 'High', configId: 'thinking_cfg' },
          ],
          isDefault: true,
        },
        {
          id: 'gemini-2.5-flash',
          name: 'Gemini 2.5 Flash',
          defaultThoughtLevel: 'medium',
          thinkingOptions: [
            { id: 'off', name: 'Off', description: 'Disable thinking', configId: 'thinking_cfg' },
            { id: 'medium', name: 'Medium', configId: 'thinking_cfg' },
            { id: 'high', name: 'High', configId: 'thinking_cfg' },
          ],
          isDefault: false,
        },
      ]);
    });

    it('falls back to legacy models.availableModels when configOptions lacks a model selector', () => {
      const models = parseModelsAndThinking({
        configOptions: [
          {
            id: 'thought_level',
            name: 'Thinking',
            category: 'thought_level',
            type: 'select',
            currentValue: 'low',
            options: [{ value: 'low', name: 'Low' }],
          },
        ],
        models: {
          currentModelId: 'gemini-legacy',
          availableModels: [
            { modelId: 'gemini-legacy', name: 'Gemini Legacy', description: 'Legacy model' },
          ],
        },
      });

      expect(models).toEqual([
        {
          id: 'gemini-legacy',
          name: 'Gemini Legacy',
          description: 'Legacy model',
          defaultThoughtLevel: 'low',
          thinkingOptions: [{ id: 'low', name: 'Low', configId: 'thought_level' }],
          isDefault: true,
        },
      ]);
    });
  });

  describe('error & tool predicates', () => {
    it('detects sign-in required errors across RPC codes, data, and causes', () => {
      expect(isSignInRequiredError({ code: -32000, message: 'Auth required' })).toBe(true);
      expect(
        isSignInRequiredError({ code: -32603, message: 'No browser is available here' }),
      ).toBe(true);
      expect(
        isSignInRequiredError({
          code: -32603,
          message: 'Internal error',
          data: { details: 'No browser is available here to open login' },
        }),
      ).toBe(true);
      expect(isSignInRequiredError(new AntigravityAcpError('Sign in', 'AGY_AUTH_REQUIRED'))).toBe(
        true,
      );
      expect(
        isSignInRequiredError(
          new Error('wrapper', { cause: { code: -32000, message: 'Auth required' } }),
        ),
      ).toBe(true);

      expect(isSignInRequiredError({ code: -32603, message: 'Unexpected crash' })).toBe(false);
      expect(isSignInRequiredError({ code: -32602, message: 'Invalid params' })).toBe(false);
      expect(isSignInRequiredError(null)).toBe(false);
    });

    it('detects MCP tool call metadata accurately', () => {
      expect(isMcpToolCallMeta({ is_mcp_tool_call: true })).toBe(true);
      expect(isMcpToolCallMeta({ is_mcp_tool_call: false })).toBe(false);
      expect(isMcpToolCallMeta({ is_mcp_tool_call: 'true' })).toBe(false);
      expect(isMcpToolCallMeta(null)).toBe(false);
      expect(isMcpToolCallMeta(undefined)).toBe(false);
    });

    it('identifies tools that outlive a prompt turn', () => {
      expect(
        antigravityToolOutlivesPrompt({
          kind: 'execute',
          title: 'Run dev server',
          rawInput: { command: 'npm run dev', background: true },
        }),
      ).toBe(true);
      expect(
        antigravityToolOutlivesPrompt({
          kind: 'execute',
          title: 'Start background process',
          rawInput: '{"run_in_background":true}',
        }),
      ).toBe(true);
      expect(
        antigravityToolOutlivesPrompt({
          kind: 'execute',
          title: 'Run tests',
          rawInput: { command: 'npm test' },
        }),
      ).toBe(false);
      expect(
        antigravityToolOutlivesPrompt({
          kind: 'read',
          title: 'Read file',
          rawInput: { path: 'README.md' },
        }),
      ).toBe(false);
    });

    it('normalizes ACP stop reasons to LLM stop reasons', () => {
      expect(normalizeStopReasonToLlm('end_turn')).toBe('stop');
      expect(normalizeStopReasonToLlm('max_tokens')).toBe('max-tokens');
      expect(normalizeStopReasonToLlm('max_turn_requests')).toBe('error');
      expect(normalizeStopReasonToLlm('refusal')).toBe('error');
      expect(normalizeStopReasonToLlm('cancelled')).toBe('error');
    });
  });
});
