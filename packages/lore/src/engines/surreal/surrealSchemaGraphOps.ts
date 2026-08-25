/**
 * surreal/surrealSchemaGraphOps.ts — the SurrealDB half of the schema-safety
 * port (`schemas/substrate/schemaGraphOps.ts`).
 *
 * This is what lets blast radius, the pre-destructive-change snapshot, and the
 * migration runner work on a SurrealDB-backed workspace. Before it existed the
 * whole subsystem was refused there (`assertKuzuGraphSubstrate`), because the
 * Kùzu code path would have read an EMPTY Kùzu `LoreNode` table and reported a
 * confident zero — an empty snapshot, a blast radius of nothing, a destructive
 * change waved through. The refusal was correct; this is the fix it was
 * holding the door for.
 *
 * Two rules this file must keep:
 *
 *  1. **Never answer approximately.** Every count here is exact. A safety
 *     mechanism that under-reports is worse than one that fails: the caller
 *     acts on it. Anything that cannot be answered exactly must throw, not
 *     guess.
 *  2. **Ids cross into SurrealQL as bound `RecordId` objects, never as query
 *     text** — see `surrealRecordId.ts`. There is deliberately no escaping
 *     helper in this engine and this file does not introduce one.
 *
 * Paging note: `pageNodesByType` orders by record id ASC, not by the raw Lore
 * id string the Kùzu implementation orders on. Both are deterministic and
 * strictly increasing, which is all the migration cursor requires (it needs
 * "resume exactly where the last batch stopped", not cross-engine identical
 * ordering — a workspace lives on one engine).
 */

import type {
    NodeMetaRow,
    SchemaGraphOps,
    SchemaRow,
} from '../../schemas/substrate/schemaGraphOps.js';
import { parseMetadata } from '../../schemas/substrate/schemaGraphOps.js';
import { EDGE_TABLE, NODE_TABLE, ridToId, toNodeRid } from './surrealRecordId.js';
import { surrealError } from './surrealError.js';

/** The one-statement query primitive SurrealGraph hands us. */
export type SurrealQueryFn = (
    sql: string,
    vars?: Record<string, unknown>,
) => Promise<Array<Record<string, unknown>>>;

/**
 * What this class needs from SurrealGraph.
 *
 * Reads are raw SurrealQL here; every MUTATION delegates to the engine verb
 * that already exists and is already tested. That split is deliberate. A
 * hand-rolled batch `DELETE $rids` looked obvious and actually failed against
 * SurrealDB's maintained count view ("Deletion for a view but no record exists
 * for that view") — the proven per-node path does the detach in the order the
 * view expects. Reimplementing a write that the engine already implements is
 * how a safety subsystem acquires a corruption bug of its own.
 */
export interface SurrealSchemaOpsDeps {
    query: SurrealQueryFn;
    deleteNode(id: string): Promise<boolean>;
    deleteEdge(sourceId: string, targetId: string, relation: string): Promise<number>;
    addEdge(edge: { sourceId: string; targetId: string; relation: string }): Promise<void>;
    upsertNode(node: Record<string, unknown>): Promise<unknown>;
}

/** First numeric field of a `count()` projection, exact. */
function countOf(rows: Array<Record<string, unknown>>): number {
    const row = rows[0];
    if (!row) return 0;
    const v = row['c'] ?? row['count'] ?? Object.values(row)[0];
    return Number(v ?? 0);
}

export class SurrealSchemaGraphOps implements SchemaGraphOps {
    public readonly engine = 'surreal' as const;

    private readonly query: SurrealQueryFn;

    constructor(private readonly deps: SurrealSchemaOpsDeps) {
        this.query = deps.query;
    }

    /* ── counts ────────────────────────────────────────────────────── */

    async countNodesByType(type: string): Promise<number> {
        try {
            return countOf(await this.query(
                `SELECT count() AS c FROM ${NODE_TABLE} WHERE type = $type GROUP ALL`,
                { type },
            ));
        } catch (error) {
            throw surrealError(`countNodesByType('${type}')`, 'schemaOps', error);
        }
    }

    async countEdgesByRelation(relation: string): Promise<number> {
        try {
            return countOf(await this.query(
                `SELECT count() AS c FROM ${EDGE_TABLE} WHERE relation = $relation GROUP ALL`,
                { relation },
            ));
        } catch (error) {
            throw surrealError(`countEdgesByRelation('${relation}')`, 'schemaOps', error);
        }
    }

    async countInboundEdgesToType(type: string): Promise<number> {
        try {
            return countOf(await this.query(
                `SELECT count() AS c FROM ${EDGE_TABLE} WHERE out.type = $type GROUP ALL`,
                { type },
            ));
        } catch (error) {
            throw surrealError(`countInboundEdgesToType('${type}')`, 'schemaOps', error);
        }
    }

    /* ── dumps ─────────────────────────────────────────────────────── */

    async listNodesByType(type: string): Promise<SchemaRow[]> {
        try {
            const rows = await this.query(
                `SELECT * FROM ${NODE_TABLE} WHERE type = $type`,
                { type },
            );
            // The snapshot is written verbatim and read back by rollback, so
            // the record id is normalised to the raw Lore id here — a
            // `RecordId` object would not survive the JSONL round-trip.
            return rows.map((r) => ({ ...r, id: ridToId(r['id']) }));
        } catch (error) {
            throw surrealError(`listNodesByType('${type}')`, 'schemaOps', error);
        }
    }

    async listEdgesByRelation(relation: string): Promise<SchemaRow[]> {
        try {
            const rows = await this.query(
                `SELECT *, in AS sourceRid, out AS targetRid
                 FROM ${EDGE_TABLE} WHERE relation = $relation`,
                { relation },
            );
            return rows.map((r) => ({
                ...r,
                sourceId: ridToId(r['sourceRid'] ?? r['in']),
                targetId: ridToId(r['targetRid'] ?? r['out']),
            }));
        } catch (error) {
            throw surrealError(`listEdgesByRelation('${relation}')`, 'schemaOps', error);
        }
    }

    /* ── paging ────────────────────────────────────────────────────── */

    async pageNodesByType(type: string, afterId: string, limit: number): Promise<NodeMetaRow[]> {
        try {
            // An empty cursor means "from the beginning" — omit the predicate
            // rather than synthesising a sentinel record id.
            const scoped = afterId ? ' AND id > $after' : '';
            const vars: Record<string, unknown> = { type, limit };
            if (afterId) vars['after'] = toNodeRid(afterId, 'pageNodesByType');
            const rows = await this.query(
                `SELECT id, metadata FROM ${NODE_TABLE}
                 WHERE type = $type${scoped}
                 ORDER BY id ASC LIMIT $limit`,
                vars,
            );
            return rows.map((r) => ({ id: ridToId(r['id']), metadata: r['metadata'] }));
        } catch (error) {
            throw surrealError(`pageNodesByType('${type}')`, 'schemaOps', error);
        }
    }

    async sampleNodesByType(type: string, sampleN: number): Promise<SchemaRow[]> {
        try {
            const rows = await this.query(
                `SELECT id, label FROM ${NODE_TABLE} WHERE type = $type LIMIT $n`,
                { type, n: sampleN },
            );
            return rows.map((r) => ({ id: ridToId(r['id']), label: r['label'] }));
        } catch (error) {
            throw surrealError(`sampleNodesByType('${type}')`, 'schemaOps', error);
        }
    }

    async sampleEdgesByRelation(relation: string, sampleN: number): Promise<SchemaRow[]> {
        try {
            const rows = await this.query(
                `SELECT in, out, relation FROM ${EDGE_TABLE}
                 WHERE relation = $relation LIMIT $n`,
                { relation, n: sampleN },
            );
            return rows.map((r) => ({
                sourceId: ridToId(r['in']),
                targetId: ridToId(r['out']),
                relation: r['relation'],
            }));
        } catch (error) {
            throw surrealError(`sampleEdgesByRelation('${relation}')`, 'schemaOps', error);
        }
    }

    /* ── mutations ─────────────────────────────────────────────────── */

    /**
     * Detach-delete up to `limit` rows of `type`.
     *
     * Deliberately two statements, not one: the incident edges must go first,
     * or SurrealDB leaves edge rows pointing at a deleted record. This mirrors
     * `surrealGraphWrites.deleteNode`, which is the tested reference for
     * detach semantics on this engine.
     */
    async deleteNodesByType(type: string, limit: number): Promise<number> {
        let victims: Array<Record<string, unknown>>;
        try {
            victims = await this.query(
                `SELECT id FROM ${NODE_TABLE} WHERE type = $type ORDER BY id ASC LIMIT $limit`,
                { type, limit },
            );
        } catch (error) {
            throw surrealError(`deleteNodesByType('${type}') scan`, 'schemaOps', error);
        }
        let removed = 0;
        for (const row of victims) {
            const id = ridToId(row['id']);
            if (!id) continue;
            // Detach semantics (incident edges first, then the row) live in
            // surrealGraphWrites.deleteNode. Do not inline them here.
            if (await this.deps.deleteNode(id)) removed++;
        }
        return removed;
    }

    async deleteEdgesByRelation(relation: string, limit: number): Promise<number> {
        let victims: Array<Record<string, unknown>>;
        try {
            victims = await this.query(
                `SELECT in, out, relation FROM ${EDGE_TABLE}
                 WHERE relation = $relation LIMIT $limit`,
                { relation, limit },
            );
        } catch (error) {
            throw surrealError(`deleteEdgesByRelation('${relation}') scan`, 'schemaOps', error);
        }
        let removed = 0;
        for (const row of victims) {
            const sourceId = ridToId(row['in']);
            const targetId = ridToId(row['out']);
            if (!sourceId || !targetId) continue;
            removed += await this.deps.deleteEdge(sourceId, targetId, relation);
        }
        return removed;
    }

    async getNodeMetadata(id: string): Promise<Record<string, unknown> | null> {
        try {
            const rows = await this.query('SELECT metadata FROM $rid', {
                rid: toNodeRid(id, 'getNodeMetadata'),
            });
            return rows.length > 0 ? parseMetadata(rows[0]!['metadata']) : null;
        } catch (error) {
            throw surrealError(`getNodeMetadata('${id}')`, 'schemaOps', error);
        }
    }

    async setNodeMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
        try {
            // Metadata is stored as a JSON STRING on this engine too, matching
            // the Kùzu column, so a snapshot round-trips byte-identically.
            await this.query('UPDATE $rid SET metadata = $json', {
                rid: toNodeRid(id, 'setNodeMetadata'),
                json: JSON.stringify(metadata),
            });
        } catch (error) {
            throw surrealError(`setNodeMetadata('${id}')`, 'schemaOps', error);
        }
    }

    async setNodeType(id: string, newType: string): Promise<void> {
        try {
            await this.query('UPDATE $rid SET type = $newType', {
                rid: toNodeRid(id, 'setNodeType'),
                newType,
            });
        } catch (error) {
            throw surrealError(`setNodeType('${id}')`, 'schemaOps', error);
        }
    }

    /**
     * Restore a snapshot row via the engine's own `upsertNode` (correct tag,
     * metadata and edge-safety handling), then repair the two fields
     * `upsertNode` cannot accept directly (`createdAt`/`syncedAt` are
     * excluded from its signature — a normal write always stamps fresh
     * values there). Matches `KuzuSchemaGraphOps.restoreNode`'s 13-field
     * MERGE exactly, field for field, with ONE deliberate difference:
     * `updatedAt` is NOT restored from the snapshot — `upsertNode` stamps
     * it fresh, same as the Kùzu reference does explicitly
     * (`updatedAt: new Date().toISOString()`). A rollback is a real write
     * happening now; `createdAt` is identity/history and gets restored,
     * `updatedAt` reflects when THIS write happened.
     */
    async restoreNode(props: Record<string, unknown>): Promise<void> {
        const id = String(props['id'] ?? '');
        if (!id) return;
        try {
            await this.deps.upsertNode({
                id,
                type: String(props['type'] ?? ''),
                label: String(props['label'] ?? ''),
                content: String(props['content'] ?? ''),
                tags: Array.isArray(props['tags'])
                    ? props['tags']
                    : typeof props['tags'] === 'string' && props['tags']
                        ? String(props['tags']).split(',').map((t) => t.trim()).filter(Boolean)
                        : [],
                project: String(props['project'] ?? '*'),
                ecosystem: String(props['ecosystem'] ?? '*'),
                metadata: typeof props['metadata'] === 'string'
                    ? props['metadata']
                    : JSON.stringify(props['metadata'] ?? {}),
                language: props['language'] ?? null,
                ephemeral: Boolean(props['ephemeral'] ?? false),
                ttl_ms: (props['ttl_ms'] as number | null | undefined) ?? null,
            });
            const createdAt = props['createdAt'];
            const syncedAt = props['syncedAt'];
            const restore: Record<string, unknown> = {};
            if (typeof createdAt === 'string' && createdAt) restore['createdAt'] = createdAt;
            if (typeof syncedAt === 'string' && syncedAt) restore['syncedAt'] = syncedAt;
            if (Object.keys(restore).length > 0) {
                const sets = Object.keys(restore).map((k) => `${k} = $${k}`).join(', ');
                await this.query(`UPDATE $rid SET ${sets}`, {
                    rid: toNodeRid(id, 'restoreNode'),
                    ...restore,
                });
            }
        } catch (error) {
            throw surrealError(`restoreNode('${id}')`, 'schemaOps', error);
        }
    }

    async createEdge(sourceId: string, targetId: string, relation: string): Promise<void> {
        try {
            await this.deps.addEdge({ sourceId, targetId, relation });
        } catch (error) {
            throw surrealError(
                `createEdge('${sourceId}' -> '${targetId}')`, 'schemaOps', error,
            );
        }
    }
}
