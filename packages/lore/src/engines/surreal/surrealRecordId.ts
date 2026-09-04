/**
 * surrealRecordId.ts — Lore node id ⇄ SurrealDB record id mapping.
 *
 * Lore ids are opaque caller-chosen strings (`decision-foo`, `person:sarah`,
 * `app/[slug]/page.tsx`). SurrealDB addresses rows by a *record id* — a
 * (table, id) pair with its own textual syntax (`node:foo`,
 * `node:⟨weird id⟩`). Those two namespaces must never be conflated:
 *
 *   - Every id crossing INTO SurrealQL does so as a bound `RecordId` OBJECT,
 *     never as query text. The driver serializes it over CBOR, so a hostile
 *     id (`x' OR 1=1; --`, `a[b]c`, backticks, angle brackets) is data, not
 *     syntax. This is the structural equivalent of a prepared-statement's
 *     bound parameters, and the reason this engine has no escape helper: see
 *     localGraph.ts's "escapeString was removed in Phase 0 / S2" note — do
 *     NOT reintroduce one here either.
 *   - Every id coming BACK is a `RecordId` object (or its `table:id` string
 *     form under a plain-JSON codec) and is unwrapped to the raw Lore id
 *     before it reaches `rowToLoreNode`, so callers never see Surreal
 *     syntax leak into a `LoreNode.id`.
 *
 * The `lore:`-prefix convention is a CALLER-side concern (getNode's contract
 * is "prefix already stripped", mirroring LocalGraph) — this module is
 * deliberately prefix-agnostic and treats `lore:x` as just another id.
 */

import { RecordId } from 'surrealdb';

import { LoreGraphError } from '../loreGraphError.js';

/** Node table. One row per LoreNode; SCHEMALESS, fields mirror the shared column convention. */
export const NODE_TABLE = 'node';

/** Edge table. A SurrealDB RELATION table (`in`/`out` + relation payload). */
export const EDGE_TABLE = 'edge';

/**
 * Pre-computed count view maintained by SurrealDB. Read by `getStats` when the
 * `countView` feature is on; never written to directly.
 */
export const NODE_COUNT_VIEW = 'node_counts';

/** Full-text index names. Their ORDINAL matters: `@1@` / `@2@` bind to them. */
export const FTS_LABEL_INDEX = 'node_fts_label';
export const FTS_CONTENT_INDEX = 'node_fts_content';

/**
 * Upper bound on an id's byte length. Mirrors the spirit of
 * `assertSafeLanceId`'s size guard: an unbounded id is a memory/DoS vector on
 * every substrate that indexes it, and no legitimate Lore id is near this.
 */
const MAX_ID_BYTES = 1024;

/**
 * assertBindableId — reject ids that binding cannot make safe.
 *
 * Escaping/quoting is NOT the control here (record ids are bound as objects),
 * so this guard is deliberately narrow — exactly the residue that binding
 * cannot fix, matching the post-2026-08-04 `assertSafeLanceId` policy:
 * non-strings, empty ids, NUL bytes, and oversized ids. Every printable
 * character — quotes, brackets, backticks, semicolons, angle brackets — is
 * legal and must round-trip.
 */
export function assertBindableId(id: unknown, operation: string): string {
    if (typeof id !== 'string') {
        throw new LoreGraphError(
            `invalid_node_id: expected a string, received ${typeof id}`,
            operation,
        );
    }
    if (id.length === 0) {
        throw new LoreGraphError('invalid_node_id: empty id', operation);
    }
    if (id.includes('\0')) {
        // Named without echoing the id itself — the NUL byte is the finding.
        throw new LoreGraphError('invalid_node_id: contains a NUL byte', operation);
    }
    const bytes = Buffer.byteLength(id, 'utf8');
    if (bytes > MAX_ID_BYTES) {
        throw new LoreGraphError(
            `invalid_node_id: ${bytes} bytes exceeds the ${MAX_ID_BYTES}-byte cap`,
            operation,
        );
    }
    return id;
}

/** toNodeRid — bind a Lore node id as a `node:<id>` record id object. */
export function toNodeRid(id: string, operation = 'toNodeRid'): RecordId<typeof NODE_TABLE> {
    return new RecordId(NODE_TABLE, assertBindableId(id, operation));
}

/**
 * ridToId — unwrap a SurrealDB record id back to the raw Lore id.
 *
 * Handles the three shapes a row's `id` can arrive in:
 *   1. `RecordId` instance (the CBOR codec's native form — the normal path).
 *   2. `{ tb, id }` plain object (structured-clone / JSON round-trips).
 *   3. `"node:⟨a[b]c⟩"` textual form (defensive; only under a JSON codec).
 *
 * The textual branch strips the `table:` prefix and unwraps the `⟨…⟩` (or
 * back-tick) quoting SurrealDB adds for ids outside its bare alphabet — the
 * exact case a bracketed Next.js route id (`app/[slug]/page.tsx`) hits.
 */
export function ridToId(value: unknown): string {
    if (value instanceof RecordId) return String(value.id);
    if (value && typeof value === 'object') {
        const maybe = value as { id?: unknown; tb?: unknown };
        if (typeof maybe.tb === 'string' && maybe.id !== undefined) return String(maybe.id);
    }
    if (typeof value !== 'string') return '';
    return unquoteRecordIdText(value);
}

/**
 * unquoteRecordIdText — `"node:⟨a[b]c⟩"` → `a[b]c`.
 *
 * Only the FIRST colon separates table from id (a Lore id may itself contain
 * colons, e.g. `person:sarah` stored as `node:⟨person:sarah⟩`).
 */
function unquoteRecordIdText(text: string): string {
    const colon = text.indexOf(':');
    const raw = colon === -1 ? text : text.slice(colon + 1);
    if (raw.startsWith('⟨') && raw.endsWith('⟩') && raw.length >= 2) {
        return raw.slice(1, -1).replace(/\\⟩/g, '⟩');
    }
    if (raw.startsWith('`') && raw.endsWith('`') && raw.length >= 2) {
        return raw.slice(1, -1);
    }
    return raw;
}

/**
 * normalizeRow — make a SurrealDB document consumable by the shared
 * `rowToLoreNode` mapper.
 *
 * The stored field names deliberately mirror the same column convention LocalGraph uses, so
 * the ONLY translation needed is unwrapping the record id. Reusing the same
 * mapper (as the ArcadeDB engine already does) is what makes cross-engine
 * field coercion identical by construction rather than by review.
 */
export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
    return { ...row, id: ridToId(row['id']) };
}
