/**
 * sqlite/sqliteGraphWrites.ts — write-side operations for SqliteGraph.
 *
 * Mirrors `surreal/surrealGraphWrites.ts` operation-for-operation and
 * return-shape-for-return-shape (including the three `supersedeNode`
 * refusal reasons and the "count of ACTUALLY MATCHED rows" semantics on the
 * batch mark-stale/stamp verbs), so the two engines cannot be told apart by
 * a caller. better-sqlite3 is synchronous, so there is no read-decide-write
 * race inside a single call the way there can be against a network
 * database — every function here still returns a Promise (the
 * `LoreGraphHandle` contract is async), but never awaits mid-transaction.
 */

import type { LoreEdge, LoreNode } from '../../providers/types.js';
import { LoreGraphError } from '../loreGraphError.js';
import { tagsToArray } from '../normalizeTags.js';
import { wouldCreateSupersedeCycle } from '../graphShared/supersedeCycle.js';
import type { SqliteDb } from './sqliteGraphSchema.js';
import { fromSqliteNodeRow, NODE_WRITE_COLUMNS, SQLITE_OUTCOME_COUNTER_SEED, toNodeRow } from './sqliteGraphRow.js';

function sqliteError(message: string, operation: string, error: unknown): LoreGraphError {
    return new LoreGraphError(message, operation, error);
}

/** Read one raw (parsed) node row, or null. Internal helper — not the public `getNode`. */
function readRawNode(db: SqliteDb, id: string): Record<string, unknown> | null {
    const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? fromSqliteNodeRow(row) : null;
}

/**
 * upsertNode — create or update by id, preserving `createdAt` on update.
 * Synchronous read-decide-write (no interleaving is possible mid-call —
 * better-sqlite3 never yields to the event loop), so there is no TOCTOU
 * window here the way there is against SurrealDB; `SqliteGraph` still wraps
 * every call in the same per-id `KeyedMutex` SurrealGraph uses, for ordering
 * parity under concurrent ASYNC callers (two upserts for the same id
 * started back-to-back must still apply in call order, not whichever's
 * microtask happens to reach the synchronous DB call first).
 */
export async function upsertNode(
    db: SqliteDb,
    node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
): Promise<LoreNode> {
    try {
        const now = new Date().toISOString();
        const existing = readRawNode(db, node.id);
        const isInsert = existing === null;
        const createdAt = !isInsert && typeof existing!['createdAt'] === 'string'
            ? (existing!['createdAt'] as string)
            : now;
        const doc = isInsert
            ? { ...SQLITE_OUTCOME_COUNTER_SEED, ...toNodeRow(node, createdAt, now) }
            : toNodeRow(node, createdAt, now, existing!);

        const cols = isInsert
            ? [...NODE_WRITE_COLUMNS, ...Object.keys(SQLITE_OUTCOME_COUNTER_SEED)]
            : [...NODE_WRITE_COLUMNS];
        const setClause = cols.map((c) => `${c} = @${c}`).join(', ');
        db.prepare(
            `INSERT INTO nodes (id, ${cols.join(', ')}) VALUES (@id, ${cols.map((c) => `@${c}`).join(', ')}) `
            + `ON CONFLICT(id) DO UPDATE SET ${setClause}`,
        ).run({ id: node.id, ...doc });

        return {
            ...node,
            tags: tagsToArray(node.tags),
            createdAt,
            updatedAt: now,
            syncedAt: null,
        };
    } catch (error) {
        if (error instanceof LoreGraphError) throw error;
        throw sqliteError(`Failed to upsert node '${node.id}'`, 'upsertNode', error);
    }
}

/**
 * importRaw — internal bulk loader for the (future) Surreal→SQLite
 * migration step: writes nodes/edges VERBATIM, preserving `createdAt` /
 * `updatedAt` exactly as given rather than stamping `now()`. NOT part of
 * `LoreGraphHandle` — no caller reaches this through the public interface.
 */
export async function importRaw(
    db: SqliteDb,
    nodes: LoreNode[],
    edges: LoreEdge[],
): Promise<{ nodeCount: number; edgeCount: number }> {
    const insertNode = db.prepare(
        `INSERT INTO nodes (id, ${NODE_WRITE_COLUMNS.join(', ')}, success_count, failure_count, partial_count, confirmation_score)
         VALUES (@id, ${NODE_WRITE_COLUMNS.map((c) => `@${c}`).join(', ')}, @success_count, @failure_count, @partial_count, @confirmation_score)
         ON CONFLICT(id) DO UPDATE SET ${NODE_WRITE_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')},
             success_count = excluded.success_count, failure_count = excluded.failure_count,
             partial_count = excluded.partial_count, confirmation_score = excluded.confirmation_score`,
    );
    const insertEdge = db.prepare(
        `INSERT INTO edges (source_id, target_id, relation, confidence, confidenceScore)
         VALUES (@source_id, @target_id, @relation, @confidence, @confidenceScore)
         ON CONFLICT(source_id, target_id, relation) DO UPDATE SET
             confidence = excluded.confidence, confidenceScore = excluded.confidenceScore`,
    );
    const run = db.transaction((ns: LoreNode[], es: LoreEdge[]) => {
        for (const n of ns) {
            const asWrite = toNodeRow(n, n.createdAt, n.updatedAt);
            insertNode.run({
                id: n.id,
                ...asWrite,
                success_count: n.success_count ?? 0,
                failure_count: n.failure_count ?? 0,
                partial_count: n.partial_count ?? 0,
                confirmation_score: n.confirmation_score ?? 0,
            });
        }
        for (const e of es) {
            insertEdge.run({
                source_id: e.sourceId,
                target_id: e.targetId,
                relation: e.relation,
                confidence: e.confidence ?? 'extracted',
                confidenceScore: e.confidenceScore ?? 1.0,
            });
        }
    });
    run(nodes, edges);
    return { nodeCount: nodes.length, edgeCount: edges.length };
}

/** deleteNode — remove a node and every edge touching it, in one transaction. */
export async function deleteNode(db: SqliteDb, id: string): Promise<boolean> {
    try {
        const run = db.transaction((nodeId: string): boolean => {
            const exists = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(nodeId);
            if (!exists) return false;
            db.prepare('DELETE FROM edges WHERE source_id = ? OR target_id = ?').run(nodeId, nodeId);
            db.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
            return true;
        });
        return run(id);
    } catch (error) {
        throw sqliteError(`Failed to delete node '${id}'`, 'deleteNode', error);
    }
}

/**
 * addEdge — create or update a directed relation for the (source, target,
 * relation) triple. Missing endpoints fail loudly (NW-BULK), same as
 * SurrealGraph. `ON CONFLICT ... DO UPDATE` is the native SQLite expression
 * of "idempotent per triple, refresh confidence on a repeat write" —
 * SurrealGraph does the equivalent via an adjacency scan because SurrealQL
 * has no primary-key upsert; SQLite has one, so this uses it directly
 * rather than copying that workaround.
 */
export async function addEdge(db: SqliteDb, edge: LoreEdge): Promise<void> {
    try {
        const present = new Set(
            (db.prepare('SELECT id FROM nodes WHERE id IN (?, ?)').all(edge.sourceId, edge.targetId) as Array<{ id: string }>)
                .map((r) => r.id),
        );
        if (!present.has(edge.sourceId) || !present.has(edge.targetId)) {
            const which = [
                present.has(edge.sourceId) ? null : `source '${edge.sourceId}'`,
                present.has(edge.targetId) ? null : `target '${edge.targetId}'`,
            ].filter(Boolean).join(' and ');
            throw new LoreGraphError(
                `edge_endpoint_missing: ${which} not found — the node must be written `
                + '(and committed) before its edges',
                'addEdge',
            );
        }
        db.prepare(
            `INSERT INTO edges (source_id, target_id, relation, confidence, confidenceScore)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(source_id, target_id, relation) DO UPDATE SET
                 confidence = excluded.confidence, confidenceScore = excluded.confidenceScore`,
        ).run(edge.sourceId, edge.targetId, edge.relation, edge.confidence ?? 'extracted', edge.confidenceScore ?? 1.0);
    } catch (error) {
        if (error instanceof LoreGraphError) throw error;
        throw sqliteError(`Failed to add edge ${edge.sourceId} → ${edge.targetId}`, 'addEdge', error);
    }
}

/** deleteEdge — remove the edge matching the directed triple. Returns the count removed (0 or 1). */
export async function deleteEdge(db: SqliteDb, sourceId: string, targetId: string, relation: string): Promise<number> {
    try {
        const result = db.prepare('DELETE FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?')
            .run(sourceId, targetId, relation);
        return result.changes;
    } catch (error) {
        throw sqliteError(`Failed to delete edge ${sourceId} -[${relation}]-> ${targetId}`, 'deleteEdge', error);
    }
}

/** pruneInferredLoreEdges — delete every edge whose relation starts with the given prefix. */
export async function pruneInferredLoreEdges(db: SqliteDb, relationPrefix: string): Promise<number> {
    try {
        // instr(relation, prefix) = 1 is a literal "starts with" test — no
        // LIKE wildcard characters in `relationPrefix` need escaping.
        const result = db.prepare('DELETE FROM edges WHERE instr(relation, ?) = 1').run(relationPrefix);
        return result.changes;
    } catch (error) {
        throw sqliteError(`Failed to prune inferred edges with prefix '${relationPrefix}'`, 'pruneInferredLoreEdges', error);
    }
}

/**
 * supersedeNode — mark `oldId` as superseded by `newId`. Same three refusal
 * reasons as SurrealGraph, same cycle guard (the SHARED
 * `wouldCreateSupersedeCycle`), same `validUntil` auto-stamp-if-unset rule.
 */
export async function supersedeNode(
    db: SqliteDb,
    getNode: (id: string) => Promise<LoreNode | null>,
    oldId: string,
    newId: string,
    reason?: string,
): Promise<{ ok: boolean; reason?: string }> {
    if (oldId === newId) return { ok: false, reason: 'self' };
    const oldNode = await getNode(oldId);
    if (!oldNode) return { ok: false, reason: 'old-not-found' };
    const newNode = await getNode(newId);
    if (!newNode) return { ok: false, reason: 'new-not-found' };

    const cyclic = await wouldCreateSupersedeCycle(
        oldId,
        newNode.supersededBy,
        async (id) => (await getNode(id))?.supersededBy,
    );
    if (cyclic) return { ok: false, reason: 'cycle' };

    try {
        const supersededAt = new Date().toISOString();
        const validUntil = !oldNode.validUntil ? supersededAt : undefined;
        db.prepare(
            `UPDATE nodes SET supersededBy = ?, supersededAt = ?, supersededReason = ?`
            + `${validUntil !== undefined ? ', validUntil = ?' : ''} WHERE id = ?`,
        ).run(...(validUntil !== undefined
            ? [newId, supersededAt, reason ?? '', validUntil, oldId]
            : [newId, supersededAt, reason ?? '', oldId]));
        return { ok: true };
    } catch (error) {
        throw sqliteError(`Failed to supersede node '${oldId}' with '${newId}'`, 'supersedeNode', error);
    }
}

/** unsupersedeNode — clear the three supersession fields, and `validUntil` iff it was the auto-stamp. */
export async function unsupersedeNode(
    db: SqliteDb,
    getNode: (id: string) => Promise<LoreNode | null>,
    id: string,
): Promise<boolean> {
    const node = await getNode(id);
    if (!node) return false;
    try {
        const clearValidUntil = Boolean(node.validUntil) && node.validUntil === node.supersededAt;
        db.prepare(
            `UPDATE nodes SET supersededBy = '', supersededAt = '', supersededReason = ''`
            + `${clearValidUntil ? `, validUntil = ''` : ''} WHERE id = ?`,
        ).run(id);
        return true;
    } catch (error) {
        throw sqliteError(`Failed to un-supersede node '${id}'`, 'unsupersedeNode', error);
    }
}

/** markStaleByTags — set `stale = 1` on every node carrying ANY of the tags. Exact, lowercased membership. */
export async function markStaleByTags(db: SqliteDb, tags: string[]): Promise<number> {
    const normalized = tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (normalized.length === 0) return 0;
    try {
        const placeholders = normalized.map(() => '?').join(', ');
        const result = db.prepare(
            `UPDATE nodes SET stale = 1 WHERE EXISTS (
                 SELECT 1 FROM json_each(nodes.tags) je WHERE je.value IN (${placeholders})
             )`,
        ).run(...normalized);
        return result.changes;
    } catch (error) {
        throw sqliteError(`Failed to mark nodes stale by tags [${tags.join(', ')}]`, 'markStaleByTags', error);
    }
}

/** findNodeIdsByTags — every node id carrying ANY of the tags, read-only. */
export async function findNodeIdsByTags(db: SqliteDb, tags: string[]): Promise<string[]> {
    const normalized = tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (normalized.length === 0) return [];
    try {
        const placeholders = normalized.map(() => '?').join(', ');
        const rows = db.prepare(
            `SELECT id FROM nodes WHERE EXISTS (
                 SELECT 1 FROM json_each(nodes.tags) je WHERE je.value IN (${placeholders})
             )`,
        ).all(...normalized) as Array<{ id: string }>;
        return rows.map((r) => r.id);
    } catch (error) {
        throw sqliteError(`Failed to find nodes by tags [${tags.join(', ')}]`, 'findNodeIdsByTags', error);
    }
}

/** markStaleByIds — set `stale = 1` on exactly the given ids. Idempotent; a since-deleted id is silently skipped. */
export async function markStaleByIds(db: SqliteDb, ids: string[]): Promise<number> {
    const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)));
    if (unique.length === 0) return 0;
    try {
        const placeholders = unique.map(() => '?').join(', ');
        const result = db.prepare(`UPDATE nodes SET stale = 1 WHERE id IN (${placeholders})`).run(...unique);
        return result.changes;
    } catch (error) {
        throw sqliteError(`Failed to mark ${unique.length} node(s) stale by id`, 'markStaleByIds', error);
    }
}

/**
 * stampAccessTimes — local-only coldness telemetry. Does NOT bump the
 * caller's read-cache epoch (that decision lives in `SqliteGraph`, which
 * deliberately skips it for this call, mirroring SurrealGraph) and does NOT
 * touch `updatedAt`/`syncedAt`. Best-effort per group — one bad group is
 * logged and skipped, never thrown, so a background flush can't take down
 * the read path that triggered it.
 */
export async function stampAccessTimes(
    db: SqliteDb,
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
            const placeholders = group.ids.map(() => '?').join(', ');
            const result = group.retrievedAt
                ? db.prepare(`UPDATE nodes SET lastAccessedAt = ?, last_retrieved_at = ? WHERE id IN (${placeholders})`)
                    .run(group.accessedAt, group.retrievedAt, ...group.ids)
                : db.prepare(`UPDATE nodes SET lastAccessedAt = ? WHERE id IN (${placeholders})`)
                    .run(group.accessedAt, ...group.ids);
            stamped += result.changes;
        } catch (error) {
            console.error(
                `[SqliteGraph] stampAccessTimes: skipped a group of ${group.ids.length} pending stamp(s): ${(error as Error).message}`,
            );
        }
    }
    return stamped;
}
