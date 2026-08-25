/**
 * nodeFieldLimits.ts — Per-field size cap for node text content (audit fix #2).
 *
 * Before fix #2, every text field on store_node / nodeUpsert (content, label,
 * metadata, evidence, anchors) was an unbounded `z.string()`. A single write
 * could hand the engine a multi-megabyte payload (a 20 MB string was accepted
 * in the live probe), pinning memory on embed and bloating LanceDB/Kùzu in one
 * shot. The per-workspace *storage* quota catches the cumulative total but
 * nothing bounded a single call — the classic slow-loris / OOM-by-one-request
 * shape.
 *
 * The cap applies at TWO layers (defense in depth):
 *   1. The MCP `store_node` Zod schema (.max on each text field) → fast 400
 *      before any work, and surfaces a clear field name to the caller.
 *   2. `nodeServiceUpsert` (the shared write core used by MCP, REST, and the
 *      embedded `createLore()` path) → guards nodeData directly so a caller
 *      that bypasses Zod (e.g. the embedded library API) is still bounded.
 *
 * 256 KB per field comfortably fits any normal decision/note/convention
 * (typical writes are <10 KB) while blocking the 20 MB DoS payload by 80×.
 * Total-node bound remains the workspace quota's job; this is the per-field
 * front door.
 */

/** Max UTF-8 byte length of any single text field on a node. 256 KB. */
export const MAX_NODE_FIELD_BYTES = 256 * 1024;

/** The node text fields capped by the per-field limit. Used both for the
 *  Zod schema (capped variants) and the nodeService guard (iteration). */
export const CAPPED_NODE_TEXT_FIELDS = [
    'content',
    'label',
    'metadata',
    'evidence',
    'anchors',
] as const;

/** Returns the UTF-8 byte length of a string value (0 for non-strings). */
export function utf8ByteLength(value: unknown): number {
    if (typeof value !== 'string') return 0;
    return Buffer.byteLength(value, 'utf8');
}

/** True when `value` is a string whose UTF-8 byte length exceeds the cap. */
export function exceedsNodeFieldCap(value: unknown): boolean {
    return typeof value === 'string' && utf8ByteLength(value) > MAX_NODE_FIELD_BYTES;
}
