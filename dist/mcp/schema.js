import { createHash } from 'node:crypto';
import { AntigravityAcpError } from '../shared/errors.js';
/** Maximum number of DSH tools accepted by the private MCP bridge. */
export const MAX_MCP_TOOLS = 256;
/** Maximum UTF-8 JSON byte size allowed for a single sanitized MCP tool definition. */
export const MAX_MCP_TOOL_BYTES = 128 * 1024;
const MAX_PRE_SANITIZE_TOOL_BYTES = 2 * 1024 * 1024;
const MAX_SCHEMA_DEPTH = 64;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:/-]{1,256}$/;
function isPlainRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function unescapeJsonPointerSegment(segment) {
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
function resolveLocalJsonPointer(root, pointer) {
    if (pointer === '#') {
        return root;
    }
    if (!pointer.startsWith('#/')) {
        return undefined;
    }
    const segments = pointer.slice(2).split('/').map(unescapeJsonPointerSegment);
    let current = root;
    for (const segment of segments) {
        if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
            return undefined;
        }
        if (Array.isArray(current)) {
            const index = Number(segment);
            if (!Number.isInteger(index) || index < 0 || index >= current.length) {
                return undefined;
            }
            current = current[index];
            continue;
        }
        if (isPlainRecord(current) && Object.hasOwn(current, segment)) {
            current = current[segment];
            continue;
        }
        return undefined;
    }
    return current;
}
const META_KEYS = new Set(['$schema', '$id', '$defs', 'definitions']);
function sanitizeSchemaNode(node, root, activeRefs, depth, isRoot = false) {
    if (depth > MAX_SCHEMA_DEPTH) {
        return {};
    }
    if (Array.isArray(node)) {
        return node.map((item) => sanitizeSchemaNode(item, root, activeRefs, depth + 1));
    }
    if (!isPlainRecord(node)) {
        return node;
    }
    let working = node;
    // Expand local JSON Pointer $refs with cycle protection.
    if (typeof node.$ref === 'string') {
        const ref = node.$ref;
        const { $ref: _ignoredRef, ...siblings } = node;
        if (ref.startsWith('#') && !activeRefs.has(ref)) {
            const target = resolveLocalJsonPointer(root, ref);
            if (isPlainRecord(target)) {
                activeRefs.add(ref);
                try {
                    const expandedTarget = sanitizeSchemaNode(target, root, activeRefs, depth + 1, false);
                    const sanitizedSiblings = sanitizeSchemaNode(siblings, root, activeRefs, depth + 1, false);
                    const merged = {
                        ...(isPlainRecord(expandedTarget) ? expandedTarget : {}),
                        ...(isPlainRecord(sanitizedSiblings) ? sanitizedSiblings : {}),
                    };
                    if (isRoot) {
                        return finalizeRootObjectSchema(merged, root, activeRefs, depth);
                    }
                    return merged;
                }
                finally {
                    activeRefs.delete(ref);
                }
            }
        }
        // Cyclic or unresolvable $ref: drop $ref and preserve safe sibling hints.
        working = Object.keys(siblings).length > 0 ? siblings : { type: 'object' };
    }
    const out = {};
    for (const [key, value] of Object.entries(working)) {
        if (META_KEYS.has(key)) {
            continue;
        }
        if (key === 'properties' || key === 'patternProperties') {
            if (isPlainRecord(value)) {
                const mapped = {};
                for (const [propName, propSchema] of Object.entries(value)) {
                    mapped[propName] = sanitizeSchemaNode(propSchema, root, activeRefs, depth + 1);
                }
                out[key] = mapped;
            }
            continue;
        }
        if (key === 'additionalProperties') {
            if (typeof value === 'boolean') {
                out[key] = value;
            }
            else if (isPlainRecord(value)) {
                out[key] = sanitizeSchemaNode(value, root, activeRefs, depth + 1);
            }
            continue;
        }
        if (key === 'items' || key === 'not') {
            if (isPlainRecord(value) || Array.isArray(value)) {
                out[key] = sanitizeSchemaNode(value, root, activeRefs, depth + 1);
            }
            continue;
        }
        if (key === 'anyOf' || key === 'oneOf' || key === 'allOf' || key === 'prefixItems') {
            if (Array.isArray(value)) {
                out[key] = value.map((branch) => sanitizeSchemaNode(branch, root, activeRefs, depth + 1));
            }
            continue;
        }
        if (key === 'enum') {
            if (Array.isArray(value)) {
                const isStringEnum = working.type === 'string' || value.every((entry) => typeof entry === 'string');
                const cleaned = isStringEnum
                    ? value.filter((entry) => typeof entry !== 'string' || entry.length > 0)
                    : value;
                if (cleaned.length > 0) {
                    out.enum = cleaned;
                }
            }
            continue;
        }
        if (key === 'required') {
            if (Array.isArray(value)) {
                const reqs = value.filter((entry) => typeof entry === 'string' && entry.length > 0);
                if (reqs.length > 0) {
                    out.required = reqs;
                }
            }
            continue;
        }
        out[key] = isPlainRecord(value) || Array.isArray(value)
            ? sanitizeSchemaNode(value, root, activeRefs, depth + 1)
            : value;
    }
    if (isRoot) {
        return finalizeRootObjectSchema(out, root, activeRefs, depth);
    }
    return out;
}
function finalizeRootObjectSchema(schema, _root, _activeRefs, _depth) {
    if (schema.type !== undefined && schema.type !== 'object') {
        throw new AntigravityAcpError(`Tool input schema root must have type "object", received ${JSON.stringify(schema.type)}`, 'AGY_TOOL_CATALOG_INVALID');
    }
    const finalized = {
        ...schema,
        type: 'object',
        properties: isPlainRecord(schema.properties) ? schema.properties : {},
    };
    return finalized;
}
/**
 * Validate and sanitize a DSH tool catalog for MCP `tools/list` exposure.
 */
export function sanitizeToolCatalog(tools) {
    if (!tools || tools.length === 0) {
        return [];
    }
    if (tools.length > MAX_MCP_TOOLS) {
        throw new AntigravityAcpError(`Tool catalog contains ${tools.length} tools, exceeding the limit of ${MAX_MCP_TOOLS}`, 'AGY_TOOL_CATALOG_INVALID');
    }
    const seenNames = new Set();
    const sanitized = [];
    for (let index = 0; index < tools.length; index += 1) {
        const tool = tools[index];
        if (!isPlainRecord(tool)) {
            throw new AntigravityAcpError(`Tool entry at index ${index} must be an object`, 'AGY_TOOL_CATALOG_INVALID');
        }
        const name = tool.name;
        if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
            throw new AntigravityAcpError(`Invalid tool name at index ${index}: ${JSON.stringify(name)}`, 'AGY_TOOL_CATALOG_INVALID');
        }
        if (seenNames.has(name)) {
            throw new AntigravityAcpError(`Duplicate tool name in catalog: "${name}"`, 'AGY_TOOL_CATALOG_INVALID');
        }
        seenNames.add(name);
        const description = tool.description ?? '';
        if (typeof description !== 'string') {
            throw new AntigravityAcpError(`Tool "${name}" description must be a string`, 'AGY_TOOL_CATALOG_INVALID');
        }
        if (!isPlainRecord(tool.parameters)) {
            throw new AntigravityAcpError(`Tool "${name}" parameters must be a JSON Schema object`, 'AGY_TOOL_CATALOG_INVALID');
        }
        let rawJson;
        try {
            rawJson = JSON.stringify(tool);
        }
        catch (error) {
            throw new AntigravityAcpError(`Tool "${name}" schema is not JSON-serializable`, 'AGY_TOOL_CATALOG_INVALID', { cause: error });
        }
        if (Buffer.byteLength(rawJson, 'utf8') > MAX_PRE_SANITIZE_TOOL_BYTES) {
            throw new AntigravityAcpError(`Tool "${name}" raw schema exceeds maximum pre-sanitization size`, 'AGY_TOOL_CATALOG_INVALID');
        }
        if (tool.parameters.type !== undefined && tool.parameters.type !== 'object') {
            throw new AntigravityAcpError(`Tool "${name}" parameters root must be an object schema, received ${JSON.stringify(tool.parameters.type)}`, 'AGY_TOOL_CATALOG_INVALID');
        }
        const activeRefs = new Set();
        const inputSchema = sanitizeSchemaNode(tool.parameters, tool.parameters, activeRefs, 0, true);
        const entry = {
            name,
            description,
            inputSchema,
        };
        const byteSize = Buffer.byteLength(JSON.stringify(entry), 'utf8');
        if (byteSize > MAX_MCP_TOOL_BYTES) {
            throw new AntigravityAcpError(`Sanitized tool "${name}" definition is ${byteSize} bytes, exceeding ${MAX_MCP_TOOL_BYTES} bytes`, 'AGY_TOOL_CATALOG_INVALID');
        }
        sanitized.push(entry);
    }
    return sanitized;
}
/**
 * Compute a deterministic SHA-256 signature over a sanitized MCP tool catalog.
 */
export function computeToolCatalogSignature(tools) {
    const hash = createHash('sha256');
    hash.update(JSON.stringify(tools));
    return hash.digest('hex');
}
//# sourceMappingURL=schema.js.map