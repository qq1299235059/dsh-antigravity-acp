import { describe, expect, it } from 'vitest';
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import {
  MessageId,
  ToolCallId,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  type RequestMessage,
} from '@deepseek-ai/dsh-llm';
import {
  SessionReuseTracker,
  buildTurnMessagesAndBlocks,
  computeAssistantFingerprints,
  computeSessionConfigHash,
  extractSystemPrompt,
  hashRequestMessage,
} from '../../src/llm/prompt.js';
import { AntigravityAcpError } from '../../src/shared/errors.js';

function fakeImageRef(bytes = 12, name = 'photo.png'): ImageAttachmentRef {
  return {
    attachmentId: 'sha256:0123456789abcdef0123456789abcdef' as any,
    mediaType: 'image/png',
    bytes,
    width: 10,
    height: 10,
    name,
  };
}

describe('prompt serialization and session reuse', () => {
  it('extracts and combines options.system with leading system messages', () => {
    const sys1 = createSystemMessage('Lead policy');
    const u1 = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } });
    expect(
      extractSystemPrompt({
        system: 'Inline system',
        messages: [sys1, u1],
      }),
    ).toBe('Inline system\n\nLead policy');
  });

  it('encodes images via AttachmentStore when supported and degrades gracefully when unsupported or missing', async () => {
    const ref = fakeImageRef(4);
    const pngBytes = new Uint8Array([137, 80, 78, 71]);
    const mockAttachments = {
      readImage: async () => ({ ref, data: pngBytes }),
      fileHostPath: () => undefined,
    } as unknown as AttachmentStore;

    const userWithImage: RequestMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this' },
        { type: 'image', attachment: ref },
      ],
    };

    const blocksSupported = await buildTurnMessagesAndBlocks({
      messages: [userWithImage],
      supportsImages: true,
      attachments: mockAttachments,
      maxPromptBytes: 100_000,
    });
    expect(blocksSupported).toEqual([
      { type: 'text', text: 'Look at this' },
      {
        type: 'image',
        data: Buffer.from(pngBytes).toString('base64'),
        mimeType: 'image/png',
      },
    ]);

    const blocksNoImages = await buildTurnMessagesAndBlocks({
      messages: [userWithImage],
      supportsImages: false,
      attachments: mockAttachments,
      maxPromptBytes: 100_000,
    });
    const noImgText = blocksNoImages
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(noImgText).toContain('Look at this');
    expect(noImgText).toContain('text only');

    await expect(
      buildTurnMessagesAndBlocks({
        messages: [userWithImage],
        supportsImages: false,
        strictUnsupportedContent: true,
        attachments: mockAttachments,
        maxPromptBytes: 100_000,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' });

    const blocksNoStore = await buildTurnMessagesAndBlocks({
      messages: [userWithImage],
      supportsImages: true,
      attachments: undefined,
      maxPromptBytes: 100_000,
    });
    const noStoreText = blocksNoStore
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(noStoreText).toContain('unavailable');
  });

  it('rejects images exceeding 10 MiB limit with UNSUPPORTED_CONTENT', async () => {
    const ref = fakeImageRef(11 * 1024 * 1024);
    const mockAttachments = {
      readImage: async () => ({ ref, data: new Uint8Array(11 * 1024 * 1024) }),
    } as unknown as AttachmentStore;

    try {
      await buildTurnMessagesAndBlocks({
        messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }] }],
        supportsImages: true,
        attachments: mockAttachments,
        maxPromptBytes: 50_000_000,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AntigravityAcpError);
      expect((error as AntigravityAcpError).code).toBe('UNSUPPORTED_CONTENT');
    }
  });

  it('trims oldest non-current rounds and middle-truncates large non-current text while preserving current turn', async () => {
    const old1 = createUserMessage({
      content: [{ type: 'text', text: 'OLD_ROUND_1_' + 'x'.repeat(300) }],
      source: { kind: 'user' },
    });
    const old2 = createAssistantMessage({
      content: [{ type: 'text', text: 'HEAD_MARKER_' + 'y'.repeat(1200) + '_TAIL_MARKER' }],
      source: { provider: 'antigravity-acp', model: 'gemini' },
    });
    const current = createUserMessage({
      content: [{ type: 'text', text: 'CURRENT_USER_PROMPT_MUST_SURVIVE' }],
      source: { kind: 'user' },
    });

    const blocks = await buildTurnMessagesAndBlocks({
      messages: [old1, old2, current],
      supportsImages: false,
      maxPromptBytes: 400,
    });

    const combined = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    const blockUtf8Bytes = blocks.reduce(
      (sum, b) => sum + (b.type === 'text' ? Buffer.byteLength(b.text, 'utf8') : 0),
      0,
    );
    expect(combined).toContain('CURRENT_USER_PROMPT_MUST_SURVIVE');
    expect(combined).not.toContain('OLD_ROUND_1_');
    expect(combined).toContain('middle truncated');
    expect(combined).toContain('HEAD_MARKER_');
    expect(combined).toContain('_TAIL_MARKER');
    expect(blockUtf8Bytes).toBeLessThanOrEqual(400);
  });
});

describe('SessionReuseTracker exact delta and invalidation', () => {
  it('returns only delta messages on strict extension and forces rebuild on changes', () => {
    const tracker = new SessionReuseTracker();
    const sys = createSystemMessage('sys');
    const u1 = createUserMessage({ content: [{ type: 'text', text: 'turn 1' }], source: { kind: 'user' } });
    const a1 = createAssistantMessage({
      content: [{ type: 'text', text: 'reply 1' }],
      source: { provider: 'antigravity-acp', model: 'm1' },
    });
    const tr1 = createToolResultMessage({
      callId: ToolCallId('c1'),
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
    const u2 = createUserMessage({ content: [{ type: 'text', text: 'turn 2' }], source: { kind: 'user' } });

    const cfg1 = computeSessionConfigHash({
      systemPrompt: 'sys',
      model: 'm1',
      reasoningEffort: 'low',
      toolsSignature: 't1',
    });

    tracker.record({
      sessionKey: 'antigravity-acp:s1',
      provider: 'antigravity-acp',
      acpSessionId: 'acp-1',
      workerId: 'w-1',
      configHash: cfg1,
      sentMessageHashes: [sys, u1].map(hashRequestMessage),
      assistantFingerprints: computeAssistantFingerprints(a1.content),
      supportsImages: true,
      appendsSystemPrompt: true,
    });

    const reusePlan = tracker.plan({
      sessionKey: 'antigravity-acp:s1',
      provider: 'antigravity-acp',
      reuseEnabled: true,
      configHash: cfg1,
      messages: [sys, u1, a1, tr1, u2],
    });
    expect(reusePlan.canReuse).toBe(true);
    if (reusePlan.canReuse) {
      expect(reusePlan.deltaMessages).toEqual([tr1, u2]);
    }

    // Compaction / rewrite of u1 -> rebuild.
    const u1Edited = createUserMessage({
      content: [{ type: 'text', text: 'compacted summary' }],
      source: { kind: 'user' },
    });
    const compactedPlan = tracker.plan({
      sessionKey: 'antigravity-acp:s1',
      provider: 'antigravity-acp',
      reuseEnabled: true,
      configHash: cfg1,
      messages: [sys, u1Edited, u2],
    });
    expect(compactedPlan.canReuse).toBe(false);

    // Rewind -> shorter list -> rebuild.
    const rewindPlan = tracker.plan({
      sessionKey: 'antigravity-acp:s1',
      provider: 'antigravity-acp',
      reuseEnabled: true,
      configHash: cfg1,
      messages: [sys, u1],
    });
    expect(rewindPlan.canReuse).toBe(false);

    // Config change (e.g. model / tools / system) -> rebuild.
    const cfgChanged = computeSessionConfigHash({
      systemPrompt: 'sys',
      model: 'm2',
      reasoningEffort: 'low',
      toolsSignature: 't1',
    });
    const modelChangedPlan = tracker.plan({
      sessionKey: 'antigravity-acp:s1',
      provider: 'antigravity-acp',
      reuseEnabled: true,
      configHash: cfgChanged,
      messages: [sys, u1, a1, u2],
    });
    expect(modelChangedPlan.canReuse).toBe(false);

    // Different message id check unused warning clean.
    expect(MessageId('m')).toBeDefined();
  });
});
