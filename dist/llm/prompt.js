import { createHash } from 'node:crypto';
import { fileHandleText, offloadedImageText, textOnlyImageText, } from '@deepseek-ai/dsh-llm';
import { AntigravityAcpError } from '../shared/errors.js';
/** Maximum raw byte size allowed per inline image block (10 MiB). */
export const MAX_SINGLE_IMAGE_BYTES = 10 * 1024 * 1024;
/** Maximum combined raw byte size of inline images in one request (50 MiB). */
export const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;
const TRUNCATION_MARKER = '\n...[middle truncated]...\n';
/**
 * Count leading `role: 'system'` messages in a request message array.
 */
export function countLeadingSystemMessages(messages) {
    let count = 0;
    while (count < messages.length && messages[count].role === 'system') {
        count += 1;
    }
    return count;
}
function extractTextFromBlocks(content) {
    const parts = [];
    for (const block of content) {
        if (block.type === 'text' && block.text.length > 0) {
            parts.push(block.text);
        }
    }
    return parts.join('\n');
}
/**
 * Combine `options.system` and any leading `role: 'system'` message text into one prompt string.
 */
export function extractSystemPrompt(options) {
    const parts = [];
    if (typeof options.system === 'string' && options.system.trim().length > 0) {
        parts.push(options.system);
    }
    const leadingCount = countLeadingSystemMessages(options.messages);
    for (let i = 0; i < leadingCount; i += 1) {
        const text = extractTextFromBlocks(options.messages[i].content);
        if (text.trim().length > 0) {
            parts.push(text);
        }
    }
    return parts.join('\n\n');
}
function acpBlockByteLength(block) {
    if (block.type === 'text') {
        return Buffer.byteLength(block.text, 'utf8');
    }
    if (block.type === 'image') {
        return Buffer.byteLength(block.data, 'utf8') + Buffer.byteLength(block.mimeType, 'utf8');
    }
    return Buffer.byteLength(JSON.stringify(block), 'utf8');
}
function segmentByteLength(segment) {
    let total = 0;
    for (const block of segment.blocks) {
        total += acpBlockByteLength(block);
    }
    return total;
}
function totalSegmentsByteLength(segments) {
    let total = 0;
    for (const segment of segments) {
        total += segmentByteLength(segment);
    }
    return total;
}
function sliceUtf8Head(text, maxBytes) {
    if (maxBytes <= 0 || text.length === 0) {
        return '';
    }
    let end = 0;
    let bytes = 0;
    for (const char of text) {
        const charBytes = Buffer.byteLength(char, 'utf8');
        if (bytes + charBytes > maxBytes) {
            break;
        }
        bytes += charBytes;
        end += char.length;
    }
    return text.slice(0, end);
}
function sliceUtf8Tail(text, maxBytes) {
    if (maxBytes <= 0 || text.length === 0) {
        return '';
    }
    const chars = [...text];
    let start = chars.length;
    let bytes = 0;
    for (let i = chars.length - 1; i >= 0; i -= 1) {
        const charBytes = Buffer.byteLength(chars[i], 'utf8');
        if (bytes + charBytes > maxBytes) {
            break;
        }
        bytes += charBytes;
        start = i;
    }
    return chars.slice(start).join('');
}
function middleTruncateUtf8(text, maxBytes) {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
        return text;
    }
    const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
    if (maxBytes <= markerBytes + 8) {
        return sliceUtf8Head(text, Math.max(0, maxBytes));
    }
    const available = maxBytes - markerBytes;
    const headBudget = Math.floor(available / 2);
    const tailBudget = available - headBudget;
    return `${sliceUtf8Head(text, headBudget)}${TRUNCATION_MARKER}${sliceUtf8Tail(text, tailBudget)}`;
}
function mergeAdjacentTextBlocks(blocks) {
    const merged = [];
    for (const block of blocks) {
        if (block.type === 'text') {
            if (block.text.length === 0) {
                continue;
            }
            const prev = merged.at(-1);
            if (prev && prev.type === 'text') {
                merged[merged.length - 1] = {
                    type: 'text',
                    text: `${prev.text}\n${block.text}`,
                };
            }
            else {
                merged.push(block);
            }
        }
        else {
            merged.push(block);
        }
    }
    return merged;
}
function findCurrentTurnStartIndex(messages) {
    if (messages.length === 0) {
        return 0;
    }
    const lastIndex = messages.length - 1;
    if (messages[lastIndex].role === 'user') {
        let idx = lastIndex;
        while (idx > 0 && messages[idx - 1].role === 'user') {
            idx -= 1;
        }
        return idx;
    }
    return lastIndex;
}
/**
 * Convert a slice of DSH conversation messages into ACP {@link acp.ContentBlock}s,
 * enforcing image capability/size limits and `maxPromptBytes` trimming rules.
 */
export async function buildTurnMessagesAndBlocks(options) {
    const { messages, systemPrompt, includeSystemPromptInTurn = false, supportsImages, strictUnsupportedContent = false, attachments, maxPromptBytes, signal, } = options;
    const nonLeading = messages.slice(countLeadingSystemMessages(messages));
    const currentStartIndex = findCurrentTurnStartIndex(nonLeading);
    const multiMessage = nonLeading.length > 1;
    let totalImageBytes = 0;
    const renderContentBlocks = async (content, isCurrent) => {
        const out = [];
        for (const block of content) {
            signal?.throwIfAborted();
            switch (block.type) {
                case 'text': {
                    if (block.text.length > 0) {
                        out.push({ type: 'text', text: block.text });
                    }
                    break;
                }
                case 'reasoning': {
                    // Omit historical reasoning from re-serialized turns to avoid polluting model output.
                    break;
                }
                case 'tool-call': {
                    out.push({
                        type: 'text',
                        text: `[Tool Call: ${block.name} (id=${block.id}) args=${block.arguments}]`,
                    });
                    break;
                }
                case 'tool-addition': {
                    out.push({
                        type: 'text',
                        text: `[Tool Added: ${block.toolName}]`,
                    });
                    break;
                }
                case 'tool-removal': {
                    out.push({
                        type: 'text',
                        text: `[Tool Removed: ${block.toolName}]`,
                    });
                    break;
                }
                case 'file': {
                    let hostPath;
                    try {
                        hostPath = attachments?.fileHostPath(block.attachment);
                    }
                    catch {
                        hostPath = undefined;
                    }
                    out.push({
                        type: 'text',
                        text: fileHandleText(block.attachment, hostPath),
                    });
                    break;
                }
                case 'image': {
                    if (block.offloaded === true) {
                        out.push({
                            type: 'text',
                            text: offloadedImageText(block.attachment),
                        });
                        break;
                    }
                    if (!supportsImages) {
                        if (strictUnsupportedContent) {
                            throw new AntigravityAcpError('Target model or ACP server does not support image inputs', 'UNSUPPORTED_CONTENT');
                        }
                        out.push({
                            type: 'text',
                            text: textOnlyImageText(block.attachment),
                        });
                        break;
                    }
                    if (!attachments) {
                        if (strictUnsupportedContent) {
                            throw new AntigravityAcpError('AttachmentStore is not available to read image attachments', 'UNSUPPORTED_CONTENT');
                        }
                        const digest = String(block.attachment.attachmentId).slice(7, 15);
                        out.push({
                            type: 'text',
                            text: `[image omitted because attachment store is unavailable; attachment sha256:${digest}]`,
                        });
                        break;
                    }
                    const stored = await attachments.readImage(block.attachment, signal);
                    const rawBytes = stored.data.byteLength;
                    if (rawBytes > MAX_SINGLE_IMAGE_BYTES) {
                        throw new AntigravityAcpError(`Image attachment exceeds single-image limit of ${MAX_SINGLE_IMAGE_BYTES} bytes`, 'UNSUPPORTED_CONTENT');
                    }
                    if (totalImageBytes + rawBytes > MAX_TOTAL_IMAGE_BYTES) {
                        if (!isCurrent && !strictUnsupportedContent) {
                            out.push({
                                type: 'text',
                                text: offloadedImageText(block.attachment),
                            });
                            break;
                        }
                        throw new AntigravityAcpError(`Combined image attachments exceed total limit of ${MAX_TOTAL_IMAGE_BYTES} bytes`, 'UNSUPPORTED_CONTENT');
                    }
                    totalImageBytes += rawBytes;
                    out.push({
                        type: 'image',
                        data: Buffer.from(stored.data).toString('base64'),
                        mimeType: stored.ref.mediaType,
                    });
                    break;
                }
                default: {
                    // Forward-compatible fallback for unknown extension content blocks.
                    out.push({
                        type: 'text',
                        text: JSON.stringify(block),
                    });
                    break;
                }
            }
        }
        return out;
    };
    const systemSegments = [];
    if (includeSystemPromptInTurn && systemPrompt && systemPrompt.trim().length > 0) {
        systemSegments.push({
            isCurrent: false,
            blocks: [
                {
                    type: 'text',
                    text: `<system_instructions>\n${systemPrompt}\n</system_instructions>`,
                },
            ],
        });
    }
    const nonCurrentSegments = [];
    const currentSegments = [];
    for (let i = 0; i < nonLeading.length; i += 1) {
        const message = nonLeading[i];
        const isCurrent = i >= currentStartIndex;
        const inner = await renderContentBlocks(message.content, isCurrent);
        let rolePrefix;
        if (message.role === 'tool') {
            rolePrefix = `[Tool Result (callId=${message.toolCallId}${message.isError ? ', isError=true' : ''})]`;
        }
        else if (message.role === 'assistant') {
            rolePrefix = '[Assistant]';
        }
        else if (message.role === 'developer') {
            rolePrefix = '[Developer]';
        }
        else if (message.role === 'system') {
            rolePrefix = '[System]';
        }
        else if (message.role === 'user' && multiMessage) {
            rolePrefix = '[User]';
        }
        const blocks = [];
        if (rolePrefix) {
            if (inner.length > 0 && inner[0].type === 'text') {
                blocks.push({ type: 'text', text: `${rolePrefix}\n${inner[0].text}` });
                blocks.push(...inner.slice(1));
            }
            else {
                blocks.push({ type: 'text', text: rolePrefix });
                blocks.push(...inner);
            }
        }
        else {
            blocks.push(...inner);
        }
        const merged = mergeAdjacentTextBlocks(blocks);
        if (merged.length === 0) {
            continue;
        }
        const segment = { blocks: merged, isCurrent };
        if (isCurrent) {
            currentSegments.push(segment);
        }
        else {
            nonCurrentSegments.push(segment);
        }
    }
    const allSegments = () => [
        ...systemSegments,
        ...nonCurrentSegments,
        ...currentSegments,
    ];
    const fixedCurrentBytes = totalSegmentsByteLength(currentSegments);
    if (fixedCurrentBytes > maxPromptBytes) {
        throw new AntigravityAcpError(`Current user turn (${fixedCurrentBytes} bytes) exceeds maxPromptBytes (${maxPromptBytes})`, 'CONTEXT_WINDOW_EXCEEDED');
    }
    // Step 1: Trim oldest non-current rounds while retaining the newest non-current item as a truncation candidate.
    while (totalSegmentsByteLength(allSegments()) > maxPromptBytes && nonCurrentSegments.length > 1) {
        nonCurrentSegments.shift();
    }
    // Step 2: Middle-truncate large non-current text blocks if still over budget.
    if (totalSegmentsByteLength(allSegments()) > maxPromptBytes && nonCurrentSegments.length === 1) {
        const target = nonCurrentSegments[0];
        const systemBytes = totalSegmentsByteLength(systemSegments);
        const remainingBudget = maxPromptBytes - systemBytes - fixedCurrentBytes;
        // Strip any non-current images if their byte size exceeds budget.
        for (let i = 0; i < target.blocks.length; i += 1) {
            if (segmentByteLength(target) <= remainingBudget) {
                break;
            }
            if (target.blocks[i].type === 'image') {
                target.blocks[i] = {
                    type: 'text',
                    text: '[earlier image omitted to fit prompt byte budget]',
                };
            }
        }
        if (segmentByteLength(target) > remainingBudget && remainingBudget >= 64) {
            // Distribute remaining budget across text blocks, prioritizing middle-truncation of the largest text blocks.
            let nonTextBytes = 0;
            const textIndices = [];
            for (let i = 0; i < target.blocks.length; i += 1) {
                const blk = target.blocks[i];
                if (blk.type === 'text') {
                    textIndices.push(i);
                }
                else {
                    nonTextBytes += acpBlockByteLength(blk);
                }
            }
            const textBudgetTotal = Math.max(0, remainingBudget - nonTextBytes);
            const totalTextBytes = textIndices.reduce((acc, idx) => acc + acpBlockByteLength(target.blocks[idx]), 0);
            if (totalTextBytes > textBudgetTotal && textIndices.length > 0) {
                let allocated = 0;
                for (let k = 0; k < textIndices.length; k += 1) {
                    const idx = textIndices[k];
                    const block = target.blocks[idx];
                    if (block.type !== 'text') {
                        continue;
                    }
                    const share = k === textIndices.length - 1
                        ? Math.max(0, textBudgetTotal - allocated)
                        : Math.floor((acpBlockByteLength(block) / totalTextBytes) * textBudgetTotal);
                    allocated += share;
                    target.blocks[idx] = {
                        type: 'text',
                        text: middleTruncateUtf8(block.text, share),
                    };
                }
            }
        }
    }
    // Step 3: If still over budget (e.g., remaining non-current segment couldn't shrink enough), drop it.
    while (totalSegmentsByteLength(allSegments()) > maxPromptBytes && nonCurrentSegments.length > 0) {
        nonCurrentSegments.shift();
    }
    // Step 4: If an inline system instruction preamble pushes total over budget, middle-truncate it so current turn stays intact.
    if (totalSegmentsByteLength(allSegments()) > maxPromptBytes && systemSegments.length > 0) {
        const budgetForSystem = Math.max(0, maxPromptBytes - fixedCurrentBytes);
        const sysBlock = systemSegments[0]?.blocks[0];
        if (sysBlock && sysBlock.type === 'text') {
            if (budgetForSystem < 64) {
                systemSegments.length = 0;
            }
            else {
                systemSegments[0].blocks[0] = {
                    type: 'text',
                    text: middleTruncateUtf8(sysBlock.text, budgetForSystem),
                };
            }
        }
    }
    const finalBlocks = [];
    for (const segment of allSegments()) {
        for (const block of segment.blocks) {
            if (block.type === 'text' && block.text.length === 0) {
                continue;
            }
            finalBlocks.push(block);
        }
    }
    return finalBlocks;
}
function sha256Json(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/**
 * Deterministic SHA-256 fingerprint for an individual DSH {@link RequestMessage}.
 */
export function hashRequestMessage(message) {
    const base = {
        role: message.role,
        content: message.content,
    };
    if (message.role === 'tool') {
        base.toolCallId = message.toolCallId;
        base.isError = Boolean(message.isError);
    }
    return sha256Json(base);
}
/**
 * Compute exact and text/tool fallback fingerprints for emitted assistant {@link ContentBlock}s.
 */
export function computeAssistantFingerprints(blocks) {
    const exact = sha256Json(blocks.map((block) => {
        if (block.type === 'text' || block.type === 'reasoning') {
            return { type: block.type, text: block.text };
        }
        if (block.type === 'tool-call') {
            return {
                type: block.type,
                id: block.id,
                name: block.name,
                arguments: block.arguments,
            };
        }
        return block;
    }));
    const visibleOnly = sha256Json(blocks
        .filter((block) => block.type !== 'reasoning')
        .map((block) => {
        if (block.type === 'text') {
            return { type: block.type, text: block.text };
        }
        if (block.type === 'tool-call') {
            return {
                type: block.type,
                id: block.id,
                name: block.name,
                arguments: block.arguments,
            };
        }
        return block;
    }));
    return exact === visibleOnly ? [exact] : [exact, visibleOnly];
}
/**
 * Deterministic configuration fingerprint governing ACP session reuse compatibility.
 */
export function computeSessionConfigHash(input) {
    return sha256Json({
        systemPrompt: input.systemPrompt,
        model: input.model,
        reasoningEffort: input.reasoningEffort ?? null,
        toolsSignature: input.toolsSignature,
    });
}
/**
 * Tracks per-session SHA-256 history fingerprints so strictly extending turns send only deltas
 * and any compaction, rewind, or config/tool/model/system change forces a clean session rebuild.
 */
export class SessionReuseTracker {
    sessions = new Map();
    get(sessionKey) {
        return this.sessions.get(sessionKey);
    }
    delete(sessionKey) {
        this.sessions.delete(sessionKey);
    }
    clear() {
        this.sessions.clear();
    }
    keys() {
        return [...this.sessions.keys()];
    }
    plan(input) {
        const { sessionKey, provider, reuseEnabled, configHash, messages } = input;
        if (!reuseEnabled || !sessionKey) {
            return { canReuse: false, deltaMessages: messages };
        }
        const tracked = this.sessions.get(sessionKey);
        if (!tracked) {
            return { canReuse: false, deltaMessages: messages };
        }
        if (tracked.configHash !== configHash || tracked.provider !== provider) {
            return { canReuse: false, deltaMessages: messages };
        }
        const prefixLen = tracked.sentMessageHashes.length;
        if (messages.length <= prefixLen) {
            return { canReuse: false, deltaMessages: messages };
        }
        for (let i = 0; i < prefixLen; i += 1) {
            if (hashRequestMessage(messages[i]) !== tracked.sentMessageHashes[i]) {
                return { canReuse: false, deltaMessages: messages };
            }
        }
        let deltaStart = prefixLen;
        const nextMessage = messages[deltaStart];
        if (nextMessage?.role === 'assistant') {
            if (nextMessage.source.provider !== provider) {
                return { canReuse: false, deltaMessages: messages };
            }
            const incomingFingerprints = computeAssistantFingerprints(nextMessage.content);
            const matchesRecorded = incomingFingerprints.some((fp) => tracked.assistantFingerprints.includes(fp));
            if (!matchesRecorded) {
                return { canReuse: false, deltaMessages: messages };
            }
            deltaStart += 1;
        }
        if (deltaStart >= messages.length) {
            return { canReuse: false, deltaMessages: messages };
        }
        const deltaMessages = messages.slice(deltaStart);
        if (deltaMessages.some((message) => message.role === 'system')) {
            return { canReuse: false, deltaMessages: messages };
        }
        return {
            canReuse: true,
            tracked,
            deltaMessages,
        };
    }
    record(session) {
        // Refresh insertion order for LRU tracking.
        this.sessions.delete(session.sessionKey);
        this.sessions.set(session.sessionKey, session);
    }
}
//# sourceMappingURL=prompt.js.map