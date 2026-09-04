/**
 * nodeFieldLimits.ts — Per-field size cap for node text content (audit fix #2).
 *
 * Before fix #2, every text field on store_node / nodeUpsert (content, label,
 * metadata, evidence, anchors) was an unbounded `z.string()`. A single write
 * could hand the engine a multi-megabyte payload (a 20 MB string was accepted
 * in the live probe), pinning memory on embed and bloating LanceDB/SurrealDB in one
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

/**
 * Supersession-lifecycle fields on a node (findings 5+13 QA round, A4).
 *
 * These are set exactly ONE way on a healthy write: `LoreGraph.supersedeNode`
 * / `unsupersedeNode`, called from the `supersede_node` MCP tool and the
 * `POST /api/node/supersede` REST route — both of which cap `reason` at
 * `MAX_NODE_FIELD_BYTES` before it ever reaches the graph. A caller that
 * instead hands them to an ordinary node UPSERT (nodeData) bypasses that cap
 * entirely, because upsert's job is to merge whatever fields it is given.
 *
 * The shared write core (`core/nodeService.ts` nodeUpsert) guards this, but
 * NOT by rejecting the fields outright: `mcp/bulkIngestCancel.ts`'s
 * cooperative-cancel rollback is a legitimate caller that restores a node by
 * round-tripping its exact previous snapshot — including these fields — back
 * through nodeUpsert. nodeService instead compares each field against
 * `hooks.previousState` (which callers cannot forge; bulkIngest resolves it
 * itself from the graph) and rejects only a value that DIFFERS from what is
 * already on the node — a value that could never have been read back from
 * the graph unless it had already passed the cap on the way in. Engine-
 * internal migration tooling that legitimately carries these fields across
 * an engine swap (see `engines/upsertLifecycle.ts`) calls `graph.upsertNode`
 * directly — it does not go through nodeService, so it is unaffected either way.
 */
export const SUPERSEDE_LIFECYCLE_FIELDS = ['supersededBy', 'supersededAt', 'supersededReason'] as const;
