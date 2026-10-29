/**
 * postgres/postgresGraphWrites.ts — write-side operations for PostgresGraph.
 *
 * Mirrors `engines/sqlite/sqliteGraphWrites.ts` operation-for-operation and
 * return-shape-for-return-shape (including the three `supersedeNode` refusal
 * reasons and the "count of ACTUALLY MATCHED rows" semantics on the batch
 * mark-stale/stamp verbs). better-sqlite3 was synchronous, so a single call
 * could never interleave; here every statement is an async round-trip, so the
 * caller's per-id `KeyedMutex` (PostgresGraph.nodeWriteChain / edgeWriteChain,
 * the same `KeyedMutex` SqliteGraph takes) is what preserves write ordering
 * under concurrent async callers — and the guarded statements (revision CAS,
 * supersede claim) are what make a cross-process race an explicit refusal
 * rather than a lost update, exactly as on SQLite.
 *
 * `writeNode` is the one INSERT .. ON CONFLICT DO UPDATE every upsert flavour
 * shares. The revision is computed IN SQL (`nodes.revision + 1`), never
 * read-then-written, so a second connection cannot lose a bump:
 *   bump        INSERT revision 1;  UPDATE revision + 1.
 *   keep        INSERT revision 1;  UPDATE revision unchanged (counter-only writes).
 *   conditional INSERT expected+1;  UPDATE revision + 1 WHERE revision = expected.
 *   replay      INSERT payload rev; UPDATE revision = payload rev WHERE revision < payload rev.
 * The statement RETURNs the post-write revision; zero rows back means the
 * DO UPDATE's guard refused — the postgres form of sqlite's `res.changes === 0`.
 * As on SQLite, the conflict-update branch refreshes ONLY `NODE_WRITE_COLUMNS`
 * (+ the revision): the outcome counters (`success_count`, …) are owned by the
 * record_outcome path, so an ordinary upsert never resets them, and on insert
 * they are seeded to 0 exactly like `SQLITE_OUTCOME_COUNTER_SEED` — a caller's
 * in-memory counter value is never persisted by this path.
 */

import type { LoreEdge, LoreNode } from '../../providers/types.js';
import type { Pool } from 'pg';
import { resolveEdgeProvenance } from '../../providers/edgeProvenance.js';
import { skOf } from './postgresEdgeSql.js';
import { tagsToArray, normalizeTag } from '../normalizeTags.js';
import { LoreGraphError } from '../loreGraphError.js';
import { wouldCreateSupersedeCycle } from '../graphShared/supersedeCycle.js';
import { supersedeGuardVerdict, type SupersedeResult } from '../graphShared/supersedeGuard.js';
import { NodeAlreadyExistsError } from '../graphShared/conditionalInsert.js';
import { RevisionConflictError } from '../graphShared/revision.js';
import { PartitionKeyImmutableError } from '../graphShared/partitionKey.js';
import { withTransaction } from './postgresClient.js';
import { toPgTimestamp } from './postgresAsOfSchema.js';
import {
    fromPgNodeRow,
    isUniqueViolation,
    NODE_WRITE_COLUMNS,
    OUTCOME_COUNTER_SEED,
    pgError,
    PgParams,
    pgColumn,
    toNodeRow,
    type PgQueryable,
} from './postgresGraphRow.js';

const WS = 'workspace_id';

// The seed is a `as const` object; this alias gives the dynamic-key lookups in
// writeNode/insertNodeIfAbsent a typed, named binding (keys are exactly the
// four counter columns; anything else falls through to the document value).
const OUTCOME_COUNTER_SEED_BY_COLUMN: Record<string, number> = OUTCOME_COUNTER_SEED;

/** Read one raw (parsed) node row, or null. Internal helper — not the public `getNode`. */
export async function readRawNode(db: PgQueryable, workspaceId: string, id: string): Promise<Record<string, unknown> | null> {
    const res = await db.query(`SELECT * FROM nodes WHERE ${WS} = $1 AND id = $2`, [workspaceId, id]);
    return res.rows.length > 0 ? fromPgNodeRow(res.rows[0]) : null;
}

/**
 * upsertNode — create or update by id, preserving `createdAt` on update.
 * Ordering under concurrent async callers is the constructor's per-id
 * KeyedMutex, exactly as on SQLite; the guarded statement is what keeps a
 * cross-process race from losing a revision bump.
 */
export async function upsertNode(
    db: PgQueryable, workspaceId: string,
    node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
): Promise<LoreNode> {
    return writeNode(db, workspaceId, node, { mode: 'bump', updatedAt: new Date().toISOString() });
}

/**
 * upsertNodeKeepRevision — upsert that does NOT move the revision. For writes that
 * only refresh derived counters (outcome success/failure/partial counts and the
 * confirmation score): they are not content changes, so a caller holding a
 * revision must not see it move. A node that does not exist yet is created at 1.
 */
export async function upsertNodeKeepRevision(
    db: PgQueryable, workspaceId: string,
    node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
): Promise<LoreNode> {
    return writeNode(db, workspaceId, node, { mode: 'keep', updatedAt: new Date().toISOString() });
}

/**
 * upsertNodeAtRevision — upsert that lands ONLY if the stored revision is still
 * `expectedRevision` (an absent row counts as 0), writing `updatedAt` as given
 * and revision = expected + 1. A mismatch throws RevisionConflictError carrying
 * the revision actually stored, so the caller can re-read and retry. With
 * `mustExist` (an `ifRevision` write: "update the node that is at n") the
 * statement is a pure UPDATE, so a row that is absent, or deleted by another
 * connection after any read, is a conflict and is never created.
 */
export async function upsertNodeAtRevision(
    db: PgQueryable, workspaceId: string,
    node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
    expectedRevision: number,
    updatedAt: string,
    mustExist = false,
): Promise<LoreNode> {
    return writeNode(db, workspaceId, node, { mode: 'conditional', expectedRevision, updatedAt, mustExist });
}

/**
 * replayNodeAtRevision — outbox replay of a node payload that carries a
 * `revision`. Applies only when the row is absent or its revision is LOWER than
 * the payload's, writing the payload's revision and `updatedAt` verbatim (no
 * bump, no new timestamp). Returns whether anything was written.
 */
export async function replayNodeAtRevision(db: PgQueryable, workspaceId: string, node: LoreNode): Promise<boolean> {
    const revision = node.revision ?? 0;
    try {
        await writeNode(db, workspaceId, node, {
            mode: 'replay', revision,
            updatedAt: node.updatedAt || new Date().toISOString(),
            createdAt: node.createdAt || undefined,
        });
        return true;
    } catch (error) {
        if (error instanceof RevisionConflictError) return false;
        throw error;
    }
}

export type NodeWriteMode =
    | { mode: 'bump'; updatedAt: string }
    | { mode: 'keep'; updatedAt: string }
    | { mode: 'conditional'; updatedAt: string; expectedRevision: number; mustExist?: boolean }
    | { mode: 'replay'; updatedAt: string; revision: number; createdAt?: string };

async function storedRevisionOf(db: PgQueryable, workspaceId: string, id: string): Promise<number> {
    const res = await db.query(`SELECT revision FROM nodes WHERE ${WS} = $1 AND id = $2`, [workspaceId, id]);
    return res.rows.length > 0 ? Number(res.rows[0]!['revision'] ?? 0) : 0;
}

/** A zero-row guarded write: if the stored non-empty key differs from the one we tried to write, that is the refusal. */
async function assertKeyNotRaced(db: PgQueryable, workspaceId: string, id: string, attempted: string): Promise<void> {
    const res = await db.query(`SELECT partition_key FROM nodes WHERE ${WS} = $1 AND id = $2`, [workspaceId, id]);
    const stored = res.rows.length > 0 ? String(res.rows[0]!['partition_key'] ?? '') : '';
    if (stored !== '' && stored !== attempted) throw new PartitionKeyImmutableError(id, stored, attempted);
}

/**
 * writeNode — the async postgres twin of sqliteGraphWrites' `writeNodeSync`
 * (same statements, same errors: RevisionConflictError / LoreGraphError).
 * `commitNodeBatch` calls it inside its one transaction, with the
 * transaction's client, so the batch's writes share the unit of work.
 */
export async function writeNode(
    db: PgQueryable,
    workspaceId: string,
    node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
    m: NodeWriteMode,
): Promise<LoreNode> {
    try {
        const now = m.updatedAt;
        const existing = await readRawNode(db, workspaceId, node.id);
        const isInsert = existing === null;
        // ifRevision never creates: an absent row is a conflict (actual 0), judged before anything is written.
        if (isInsert && m.mode === 'conditional' && m.mustExist) throw new RevisionConflictError(node.id, m.expectedRevision, 0);
        const createdAt = !isInsert && typeof existing!['createdAt'] === 'string'
            ? (existing!['createdAt'] as string)
            : ((m.mode === 'replay' && m.createdAt) || now);
        const doc = isInsert
            ? { ...toNodeRow(node, createdAt, now) }
            : toNodeRow(node, createdAt, now, existing!);

        if (m.mode === 'conditional' && m.mustExist) {
            // mustExist: a pure UPDATE, so a row deleted by another connection after the read above is a conflict, not an insert.
            const upd = new PgParams();
            const sets = NODE_WRITE_COLUMNS.map((c) => `${pgColumn(c)} = ${upd.add(doc[c])}`).join(', ');
            const ws = upd.add(workspaceId);
            const idp = upd.add(node.id);
            const expected = upd.add(m.expectedRevision);
            const res = await db.query(
                `UPDATE nodes SET ${sets}, revision = nodes.revision + 1`
                + ` WHERE ${WS} = ${ws} AND id = ${idp} AND revision = ${expected}`
                + ` AND (nodes.partition_key = '' OR nodes.partition_key = ${upd.add(doc['partition_key'])}) RETURNING revision`,
                upd.values,
            );
            if (res.rows.length === 0) {
                await assertKeyNotRaced(db, workspaceId, node.id, String(doc['partition_key']));
                const actual = await storedRevisionOf(db, workspaceId, node.id);
                throw new RevisionConflictError(node.id, m.expectedRevision, actual);
            }
            const stored = Number(res.rows[0]!['revision']);
            return {
                ...node,
                tags: tagsToArray(node.tags),
                createdAt,
                updatedAt: now,
                syncedAt: null,
                revision: stored,
                ...(doc['partition_key'] ? { partitionKey: doc['partition_key'] as string } : {}),
            };
        }

        // INSERT .. ON CONFLICT (workspace_id, id) DO UPDATE. Placeholders are
        // minted in statement order: $1 workspace, $2 id, then the write
        // columns, then the insert revision, then (conditional/replay) the
        // guard value. The DO UPDATE SET refreshes only NODE_WRITE_COLUMNS;
        // the counters ride in on the INSERT branch alone (see file header).
        const insertCols = [...NODE_WRITE_COLUMNS, ...Object.keys(OUTCOME_COUNTER_SEED)];
        const insertValues = insertCols.map((c) => (
            OUTCOME_COUNTER_SEED_BY_COLUMN[c] ?? doc[c]
        ));
        const insertRevision = m.mode === 'bump' || m.mode === 'keep'
            ? 1
            : m.mode === 'conditional' ? m.expectedRevision + 1 : m.revision;
        const values: unknown[] = [workspaceId, node.id, ...insertValues, insertRevision];
        let updateRevision: string;
        // L3: partition_key is immutable once non-empty. The JS check in toNodeRow covers the read-then-write
        // path; this guard covers a concurrent writer that keyed the row after our read (0 rows -> re-read ->
        // PartitionKeyImmutableError below).
        const guards = ["(nodes.partition_key = '' OR nodes.partition_key = EXCLUDED.partition_key)"];
        if (m.mode === 'conditional') {
            values.push(m.expectedRevision);
            updateRevision = 'nodes.revision + 1';
            guards.unshift(`nodes.revision = $${values.length}`);
        } else if (m.mode === 'replay') {
            values.push(m.revision);
            const rev = `$${values.length}`;
            updateRevision = rev;
            guards.unshift(`nodes.revision < ${rev}`);
        } else {
            updateRevision = m.mode === 'keep' ? 'nodes.revision' : 'nodes.revision + 1';
        }
        const guard = ` WHERE ${guards.join(' AND ')}`;
        const setClause = NODE_WRITE_COLUMNS.map((c) => `${pgColumn(c)} = EXCLUDED.${pgColumn(c)}`).join(', ');
        const insertPlaceholders = insertValues.map((_, i) => `$${i + 3}`).join(', ');
        const res = await db.query(
            `INSERT INTO nodes (${WS}, id, ${insertCols.map(pgColumn).join(', ')}, revision)`
            + ` VALUES ($1, $2, ${insertPlaceholders}, $${insertValues.length + 3})`
            + ` ON CONFLICT (${WS}, id) DO UPDATE SET ${setClause}, revision = ${updateRevision}${guard}`
            + ` RETURNING revision`,
            values,
        );
        if (res.rows.length === 0) {
            await assertKeyNotRaced(db, workspaceId, node.id, String(doc['partition_key']));
            const actual = await storedRevisionOf(db, workspaceId, node.id);
            throw new RevisionConflictError(
                node.id,
                m.mode === 'conditional' ? m.expectedRevision : m.mode === 'replay' ? m.revision : 0,
                actual,
            );
        }
        const stored = Number(res.rows[0]!['revision']);
        return {
            ...node,
            tags: tagsToArray(node.tags),
            createdAt,
            updatedAt: now,
            syncedAt: null,
            revision: stored,
            ...(doc['partition_key'] ? { partitionKey: doc['partition_key'] as string } : {}),
        };
    } catch (error) {
        if (error instanceof LoreGraphError || error instanceof RevisionConflictError || error instanceof PartitionKeyImmutableError) throw error;
        throw pgError(`Failed to upsert node '${node.id}'`, 'upsertNode', error);
    }
}

/**
 * insertNodeIfAbsent — conditional-writes R1. A plain INSERT (no ON CONFLICT):
 * the PRIMARY KEY rejects a duplicate id even when another connection created
 * it after any read, and that rejection (SQLSTATE 23505) is reported as
 * NodeAlreadyExistsError. Counter seeds go in on insert exactly as
 * `upsertNode`'s insert branch does (always 0 — see the file header).
 */
export async function insertNodeIfAbsent(
    db: PgQueryable, workspaceId: string,
    node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
): Promise<LoreNode> {
    try {
        const now = new Date().toISOString();
        const doc = { ...toNodeRow(node, now, now) };
        const cols = [...NODE_WRITE_COLUMNS, ...Object.keys(OUTCOME_COUNTER_SEED)];
        const values = cols.map((c) => (
            OUTCOME_COUNTER_SEED_BY_COLUMN[c] ?? doc[c]
        ));
        const placeholders = values.map((_, i) => `$${i + 3}`).join(', ');
        await db.query(
            `INSERT INTO nodes (${WS}, id, ${cols.map(pgColumn).join(', ')}, revision)`
            + ` VALUES ($1, $2, ${placeholders}, $${values.length + 3})`,
            [workspaceId, node.id, ...values, 1],
        );
        return { ...node, tags: tagsToArray(node.tags), createdAt: now, updatedAt: now, syncedAt: null, revision: 1, ...(doc['partition_key'] ? { partitionKey: doc['partition_key'] as string } : {}) };
    } catch (error) {
        if (isUniqueViolation(error)) throw new NodeAlreadyExistsError(node.id);
        if (error instanceof LoreGraphError) throw error;
        throw pgError(`Failed to insert node '${node.id}'`, 'insertNodeIfAbsent', error);
    }
}

/**
 * importRaw — internal bulk loader for a future migration step: writes
 * nodes/edges VERBATIM, preserving `createdAt`/`updatedAt` exactly as given
 * rather than stamping `now()`. Access times (`lastAccessedAt` /
 * `last_retrieved_at`, normally written only by `stampAccessTimes`) are
 * preserved too. NOT part of `LoreGraphHandle` — no caller reaches this
 * through the public interface. (Migrate-graph INTO postgres stays refused at
 * the route layer; this loader exists for parity with SqliteGraph, nothing more.)
 */
export async function importRaw(
    pool: Pool, workspaceId: string,
    nodes: LoreNode[], edges: LoreEdge[],
): Promise<{ nodeCount: number; edgeCount: number }> {
    const nodeCols = [...NODE_WRITE_COLUMNS, 'success_count', 'failure_count', 'partial_count', 'confirmation_score', 'lastAccessedAt', 'last_retrieved_at', 'revision'];
    const insertNodeSql = `INSERT INTO nodes (${WS}, id, ${nodeCols.map(pgColumn).join(', ')})`
        + ` VALUES ($1, $2, ${nodeCols.map((_, i) => `$${i + 3}`).join(', ')})`
        + ` ON CONFLICT (${WS}, id) DO UPDATE SET ${nodeCols.map((c) => `${pgColumn(c)} = EXCLUDED.${pgColumn(c)}`).join(', ')}`;
    // Verbatim import: supplied provenance (incl. validTo) is kept; an edge with none is stamped 'import'.
    // The nodes of this call are written first in the same transaction, so the sk subselects resolve.
    const insertEdgeSql = `INSERT INTO edges (${WS}, relation, confidence, "confidenceScore",`
        + ` src_sk, dst_sk, origin, policy_version, model_fingerprint, created_at, valid_to, partition_key)`
        + ` SELECT $1, $4, $5, $6, s.sk, t.sk, $7, $8, $9, $10, $11, s.partition_key`
        + ` FROM nodes s, nodes t WHERE s.workspace_id = $1 AND s.id = $2 AND t.workspace_id = $1 AND t.id = $3`
        + ` ON CONFLICT (${WS}, src_sk, dst_sk, relation) DO UPDATE SET`
        + ` confidence = EXCLUDED.confidence, "confidenceScore" = EXCLUDED."confidenceScore", origin = EXCLUDED.origin,`
        + ` policy_version = EXCLUDED.policy_version, model_fingerprint = EXCLUDED.model_fingerprint,`
        + ` created_at = EXCLUDED.created_at, valid_to = EXCLUDED.valid_to, partition_key = EXCLUDED.partition_key`;

    let written = 0;
    await withTransaction(pool, async (client) => {
        for (const n of nodes) {
            const asWrite = toNodeRow(n, n.createdAt, n.updatedAt);
            await client.query(insertNodeSql, [
                workspaceId,
                n.id,
                ...NODE_WRITE_COLUMNS.map((c) => asWrite[c]),
                n.success_count ?? 0,
                n.failure_count ?? 0,
                n.partial_count ?? 0,
                n.confirmation_score ?? 0,
                n.lastAccessedAt ?? '',
                n.last_retrieved_at ?? '',
                typeof n.revision === 'number' && Number.isFinite(n.revision) ? n.revision : 0,
            ]);
        }
        for (const e of edges) {
            const pv = resolveEdgeProvenance(e.provenance, 'import');
            // Layout 2 has no way to store an edge whose endpoint node does not exist: such an edge inserts 0 rows (counted below).
            written += (await client.query(insertEdgeSql, [
                workspaceId, e.sourceId, e.targetId, e.relation,
                e.confidence ?? 'extracted', e.confidenceScore ?? 1.0,
                pv.origin, pv.policyVersion, pv.modelFingerprint, pv.createdAt, e.provenance?.validTo ?? null,
            ])).rowCount ?? 0;
        }
    });
    return { nodeCount: nodes.length, edgeCount: written };
}

/** deleteNode — remove a node and every edge touching it, in one transaction. */
export async function deleteNode(pool: Pool, workspaceId: string, id: string): Promise<boolean> {
    try {
        return await withTransaction(pool, async (client) => {
            // The durable link opt-out dies with the node; cleared before the existence check so a flag recorded
            // for a node that was never written (or is already gone) cannot outlive its id.
            await client.query(`DELETE FROM link_optout WHERE ${WS} = $1 AND node_id = $2`, [workspaceId, id]);
            const found = await client.query(`SELECT sk FROM nodes WHERE ${WS} = $1 AND id = $2`, [workspaceId, id]);
            if (found.rows.length === 0) return false;
            // Source side via the primary-key prefix, target side via the 8-byte dst_sk index. Soft-invalidated edges go too.
            const sk = (found.rows[0] as { sk: string }).sk;
            await client.query(`DELETE FROM edges WHERE ${WS} = $1 AND src_sk = $2`, [workspaceId, sk]);
            await client.query(`DELETE FROM edges WHERE dst_sk = $1 AND ${WS} = $2`, [sk, workspaceId]);
            await client.query(`DELETE FROM nodes WHERE ${WS} = $1 AND id = $2`, [workspaceId, id]);
            return true;
        });
    } catch (error) {
        throw pgError(`Failed to delete node '${id}'`, 'deleteNode', error);
    }
}

/**
 * deleteNodes — `deleteNode` for many ids in ONE transaction (one commit instead of one per node; on a real disk the
 * per-node commit flush, not the SQL, is what a 10k-node delete spends its time on). Same effect per id: its link opt-out,
 * every edge touching it (soft-invalidated included) and the node go. Returns the ids that existed. All-or-nothing: a
 * failure rolls the whole call back and throws (callers fall back to the per-node path).
 */
export async function deleteNodes(pool: Pool, workspaceId: string, ids: string[]): Promise<Set<string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Set();
    try {
        return await withTransaction(pool, async (client) => {
            await client.query(`DELETE FROM link_optout WHERE ${WS} = $1 AND node_id = ANY($2::text[])`, [workspaceId, unique]);
            const found = await client.query(`SELECT id, sk FROM nodes WHERE ${WS} = $1 AND id = ANY($2::text[])`, [workspaceId, unique]);
            const rows = found.rows as Array<{ id: string; sk: string }>;
            if (rows.length === 0) return new Set<string>();
            const sks = rows.map((r) => r.sk);
            await client.query(`DELETE FROM edges WHERE ${WS} = $1 AND src_sk = ANY($2::bigint[])`, [workspaceId, sks]);
            await client.query(`DELETE FROM edges WHERE dst_sk = ANY($2::bigint[]) AND ${WS} = $1`, [workspaceId, sks]);
            await client.query(`DELETE FROM nodes WHERE ${WS} = $1 AND id = ANY($2::text[])`, [workspaceId, rows.map((r) => r.id)]);
            return new Set(rows.map((r) => r.id));
        });
    } catch (error) {
        throw pgError(`Failed to delete ${unique.length} nodes`, 'deleteNodes', error);
    }
}

/**
 * addEdge — create or update a directed relation for the (source, target,
 * relation) triple. Missing endpoints fail loudly (NW-BULK), same as
 * SurrealGraph/SqliteGraph. `ON CONFLICT ... DO UPDATE` is the native
 * expression of "idempotent per triple, refresh confidence on a repeat write".
 */
export async function addEdge(db: PgQueryable, workspaceId: string, edge: LoreEdge): Promise<void> {
    try {
        const present = await db.query(
            `SELECT id, sk, partition_key FROM nodes WHERE ${WS} = $1 AND id = ANY($2)`, [workspaceId, [edge.sourceId, edge.targetId]],
        );
        const skById = new Map<string, string>((present.rows as Array<{ id: string; sk: string }>).map((r) => [r.id, r.sk]));
        // L3: the edge inherits its SOURCE node's partition key.
        const srcKey = String((present.rows as Array<{ id: string; partition_key: string | null }>).find((r) => r.id === edge.sourceId)?.partition_key ?? '');
        const presentIds = new Set<string>(skById.keys());
        if (!presentIds.has(edge.sourceId) || !presentIds.has(edge.targetId)) {
            const which = [
                presentIds.has(edge.sourceId) ? null : `source '${edge.sourceId}'`,
                presentIds.has(edge.targetId) ? null : `target '${edge.targetId}'`,
            ].filter(Boolean).join(' and ');
            throw new LoreGraphError(
                `edge_endpoint_missing: ${which} not found — the node must be written `
                + '(and committed) before its edges',
                'addEdge',
            );
        }
        // Re-asserting an edge re-validates it (valid_to cleared) and restamps who asserted it; created_at stays the first write.
        const pv = resolveEdgeProvenance(edge.provenance, 'caller');
        await db.query(
            `INSERT INTO edges (${WS}, src_sk, dst_sk, relation, confidence, "confidenceScore",`
            + ` origin, policy_version, model_fingerprint, created_at, partition_key)`
            + ` VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`
            + ` ON CONFLICT (${WS}, src_sk, dst_sk, relation) DO UPDATE SET`
            + ` confidence = EXCLUDED.confidence, "confidenceScore" = EXCLUDED."confidenceScore", origin = EXCLUDED.origin,`
            + ` policy_version = EXCLUDED.policy_version, model_fingerprint = EXCLUDED.model_fingerprint,`
            + ` created_at = COALESCE(edges.created_at, EXCLUDED.created_at), valid_to = NULL, partition_key = EXCLUDED.partition_key`,
            [workspaceId, skById.get(edge.sourceId), skById.get(edge.targetId), edge.relation, edge.confidence ?? 'extracted', edge.confidenceScore ?? 1.0,
                pv.origin, pv.policyVersion, pv.modelFingerprint, pv.createdAt, srcKey],
        );
    } catch (error) {
        if (error instanceof LoreGraphError) throw error;
        throw pgError(`Failed to add edge ${edge.sourceId} → ${edge.targetId}`, 'addEdge', error);
    }
}

/** deleteEdge — remove the edge matching the directed triple. Returns the count removed (0 or 1). */
export async function deleteEdge(
    db: PgQueryable, workspaceId: string, sourceId: string, targetId: string, relation: string,
): Promise<number> {
    try {
        const res = await db.query(
            `DELETE FROM edges WHERE ${WS} = $1 AND src_sk = ${skOf('$1', '$2')} AND dst_sk = ${skOf('$1', '$3')} AND relation = $4`,
            [workspaceId, sourceId, targetId, relation],
        );
        return res.rowCount ?? 0;
    } catch (error) {
        throw pgError(`Failed to delete edge ${sourceId} -[${relation}]-> ${targetId}`, 'deleteEdge', error);
    }
}

/** pruneInferredLoreEdges — delete every edge whose relation starts with the given prefix. */
export async function pruneInferredLoreEdges(db: PgQueryable, workspaceId: string, relationPrefix: string): Promise<number> {
    try {
        // position(prefix in relation) = 1 is a literal "starts with" test — no
        // LIKE wildcard characters in `relationPrefix` need escaping.
        const res = await db.query(
            `DELETE FROM edges WHERE ${WS} = $1 AND position($2 in relation) = 1`, [workspaceId, relationPrefix],
        );
        return res.rowCount ?? 0;
    } catch (error) {
        throw pgError(`Failed to prune inferred edges with prefix '${relationPrefix}'`, 'pruneInferredLoreEdges', error);
    }
}

/**
 * supersedeNode — mark `oldId` as superseded by `newId`. Same three refusal
 * reasons as SurrealGraph/SqliteGraph, same cycle guard (the SHARED
 * `wouldCreateSupersedeCycle`), same `validUntil` auto-stamp-if-unset rule.
 * The claim and the successor's bump are one transaction — a second
 * connection cannot claim between the guarded UPDATE and the bump.
 */
export async function supersedeNode(
    pool: Pool, workspaceId: string,
    getNode: (id: string) => Promise<LoreNode | null>,
    oldId: string, newId: string, reason?: string,
): Promise<SupersedeResult> {
    if (oldId === newId) return { ok: false, reason: 'self' };
    const oldNode = await getNode(oldId);
    if (!oldNode) return { ok: false, reason: 'old-not-found' };
    const newNode = await getNode(newId);
    if (!newNode) return { ok: false, reason: 'new-not-found' };
    // Conditional-writes R2: one successor per node. Checked here on the read
    // node and again inside the UPDATE (a second connection can claim between).
    const early = supersedeGuardVerdict(oldNode.supersededBy, newId);
    if (early) return early;

    const cyclic = await wouldCreateSupersedeCycle(
        oldId,
        newNode.supersededBy,
        async (id) => (await getNode(id))?.supersededBy,
    );
    if (cyclic) return { ok: false, reason: 'cycle' };

    try {
        const supersededAt = new Date().toISOString();
        const validUntil = !oldNode.validUntil ? supersededAt : undefined;
        // Phase 2a: the claim bumps the OLD node's revision in the same UPDATE; the NEW
        // node (otherwise untouched) is bumped in the same transaction — both sides of
        // an accepted supersede move, an idempotent retry (early return above) moves neither.
        const changes = await withTransaction(pool, async (client) => {
            const p = new PgParams();
            const validUntilSet = validUntil !== undefined
                ? `, "validUntil" = ${p.add(validUntil)}, valid_until_at = ${p.add(toPgTimestamp(validUntil))}::timestamptz`
                : '';
            const res = await client.query(
                `UPDATE nodes SET supersededBy = ${p.add(newId)}, supersededAt = ${p.add(supersededAt)},`
                + ` supersededReason = ${p.add(reason ?? '')}, revision = revision + 1${validUntilSet}`
                + ` WHERE ${WS} = ${p.add(workspaceId)} AND id = ${p.add(oldId)}`
                + ` AND (supersededBy IS NULL OR supersededBy = '' OR supersededBy = ${p.add(newId)})`,
                p.values,
            );
            const claimed = res.rowCount ?? 0;
            if (claimed >= 1) {
                await client.query(
                    `UPDATE nodes SET revision = revision + 1 WHERE ${WS} = $1 AND id = $2`, [workspaceId, newId],
                );
            }
            return claimed;
        });
        if (changes < 1) {
            const now = await getNode(oldId);
            if (!now) return { ok: false, reason: 'old-not-found' };
            return supersedeGuardVerdict(now.supersededBy, newId) ?? { ok: false, reason: 'old-not-found' };
        }
        return { ok: true };
    } catch (error) {
        throw pgError(`Failed to supersede node '${oldId}' with '${newId}'`, 'supersedeNode', error);
    }
}

/** unsupersedeNode — clear the three supersession fields, and `validUntil` iff it was the auto-stamp. */
export async function unsupersedeNode(
    db: PgQueryable, workspaceId: string,
    getNode: (id: string) => Promise<LoreNode | null>,
    id: string,
): Promise<boolean> {
    const node = await getNode(id);
    if (!node) return false;
    try {
        const clearValidUntil = Boolean(node.validUntil) && node.validUntil === node.supersededAt;
        // Phase 2a: bump only when there was a supersession to clear (the CASE reads the
        // pre-update row); un-superseding a current node changes nothing.
        await db.query(
            `UPDATE nodes SET supersededBy = '', supersededAt = '', supersededReason = '',`
            + ` revision = revision + CASE WHEN supersededBy <> '' THEN 1 ELSE 0 END`
            + `${clearValidUntil ? `, "validUntil" = '', valid_until_at = NULL` : ''} WHERE ${WS} = $1 AND id = $2`,
            [workspaceId, id],
        );
        return true;
    } catch (error) {
        throw pgError(`Failed to un-supersede node '${id}'`, 'unsupersedeNode', error);
    }
}

/** markStaleByTags — set `stale = 1` on every node carrying ANY of the tags. Exact, lowercased membership. */
export async function markStaleByTags(db: PgQueryable, workspaceId: string, tags: string[]): Promise<number> {
    const normalized = tags.map((t) => normalizeTag(t)).filter(Boolean);
    if (normalized.length === 0) return 0;
    try {
        const params = new PgParams();
        const ws = params.add(workspaceId);
        const tagsParam = params.add(normalized);
        const res = await db.query(
            // Phase 2a: only a node that actually turns stale bumps — which also keeps an outbox
            // replay of a mark_stale chunk (ids already stale) from bumping a second time.
            `UPDATE nodes SET stale = 1, revision = revision + CASE WHEN stale = 1 THEN 0 ELSE 1 END`
            + ` WHERE ${WS} = ${ws} AND EXISTS (`
            + `SELECT 1 FROM jsonb_array_elements_text(nodes.tags::jsonb) je WHERE je = ANY(${tagsParam}))`,
            params.values,
        );
        return res.rowCount ?? 0;
    } catch (error) {
        throw pgError(`Failed to mark nodes stale by tags [${tags.join(', ')}]`, 'markStaleByTags', error);
    }
}

/** findNodeIdsByTags — every node id carrying ANY of the tags, read-only. */
export async function findNodeIdsByTags(db: PgQueryable, workspaceId: string, tags: string[]): Promise<string[]> {
    const normalized = tags.map((t) => normalizeTag(t)).filter(Boolean);
    if (normalized.length === 0) return [];
    try {
        const params = new PgParams();
        const ws = params.add(workspaceId);
        const tagsParam = params.add(normalized);
        const res = await db.query(
            `SELECT id FROM nodes WHERE ${WS} = ${ws} AND EXISTS (`
            + `SELECT 1 FROM jsonb_array_elements_text(nodes.tags::jsonb) je WHERE je = ANY(${tagsParam}))`,
            params.values,
        );
        return (res.rows as Array<{ id: string }>).map((r) => r.id);
    } catch (error) {
        throw pgError(`Failed to find nodes by tags [${tags.join(', ')}]`, 'findNodeIdsByTags', error);
    }
}

/** markStaleByIds — set `stale = 1` on exactly the given ids. Idempotent; a since-deleted id is silently skipped. */
export async function markStaleByIds(db: PgQueryable, workspaceId: string, ids: string[]): Promise<number> {
    const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)));
    if (unique.length === 0) return 0;
    try {
        const res = await db.query(
            // Phase 2a: only a node that actually turns stale bumps — which also keeps an outbox
            // replay of a mark_stale chunk (ids already stale) from bumping a second time.
            `UPDATE nodes SET stale = 1, revision = revision + CASE WHEN stale = 1 THEN 0 ELSE 1 END`
            + ` WHERE ${WS} = $1 AND id = ANY($2)`,
            [workspaceId, unique],
        );
        return res.rowCount ?? 0;
    } catch (error) {
        throw pgError(`Failed to mark ${unique.length} node(s) stale by id`, 'markStaleByIds', error);
    }
}

/**
 * stampAccessTimes — local-only coldness telemetry. Does NOT bump the
 * caller's read-cache epoch (that decision lives in `PostgresGraph`, which
 * deliberately skips it for this call, mirroring SurrealGraph/SqliteGraph) and
 * does NOT touch `updatedAt`/`syncedAt`. Best-effort per group — one bad group
 * is logged and skipped, never thrown, so a background flush can't take down
 * the read path that triggered it.
 */
export async function stampAccessTimes(
    db: PgQueryable, workspaceId: string,
    entries: Array<{ id: string; accessedAt: string; retrievedAt?: string }>,
): Promise<number> {
    const valid = entries.filter(
        (e) => typeof e.id === 'string' && e.id.length > 0 && typeof e.accessedAt === 'string' && e.accessedAt.length > 0,
    );
    if (valid.length === 0) return 0;

    const groups = new Map<string, { accessedAt: string; retrievedAt?: string; ids: string[] }>();
    for (const e of valid) {
        const key = `${e.accessedAt} ${e.retrievedAt ?? ''}`;
        const existing = groups.get(key);
        if (existing) existing.ids.push(e.id);
        else groups.set(key, { accessedAt: e.accessedAt, retrievedAt: e.retrievedAt, ids: [e.id] });
    }

    let stamped = 0;
    for (const group of groups.values()) {
        try {
            const res = group.retrievedAt
                ? await db.query(
                    `UPDATE nodes SET lastaccessedat = $2, last_retrieved_at = $3 WHERE ${WS} = $1 AND id = ANY($4)`,
                    [workspaceId, group.accessedAt, group.retrievedAt, group.ids],
                )
                : await db.query(
                    `UPDATE nodes SET lastaccessedat = $2 WHERE ${WS} = $1 AND id = ANY($3)`,
                    [workspaceId, group.accessedAt, group.ids],
                );
            stamped += res.rowCount ?? 0;
        } catch (error) {
            console.error(
                `[PostgresGraph] stampAccessTimes: skipped a group of ${group.ids.length} pending stamp(s): ${(error as Error).message}`,
            );
        }
    }
    return stamped;
}
