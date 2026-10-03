/**
 * outbox/supersession.ts — cross-kind outbox supersession key derivation
 * (2026-07-05 durability fix).
 *
 * RA-6 (F-S03/S04/S05) skips a stale `status='failed'` outbox row when a
 * NEWER row for the same key already reached 'replicated', so replaying it
 * can't corrupt the newer committed state. The original guard scoped
 * supersession to a SINGLE operationKind, which only caught
 * upsert-supersedes-upsert. That is too narrow: the intended state of an
 * entity is established by the LATEST durably-applied op on it, regardless
 * of whether that op was an upsert or a delete. The dangerous reorderings
 * the narrow guard missed:
 *
 *   (a) a replicated `node.delete` supersedes a failed `node.upsert` on the
 *       same id — else the retried upsert RESURRECTS a deleted node;
 *   (b) a replicated `node.upsert` supersedes a failed `node.delete` on the
 *       same id — else the retried delete DELETES a re-created node;
 *   (c) + (d): the same two directions for edges.
 *
 * REGRESSION FIX (2026-07-05, follow-up to c79e505): the original RA-6 guard
 * keyed EVERY payload.id-carrying kind on `payload.id` and matched same-kind,
 * so EVERY such kind — including `verbatim.upsert` (payload id = `lore:<id>`,
 * see nodeService verbatim fan-out) — had same-kind, same-id supersession.
 * c79e505 replaced that with keyOfEntry(), which returned a family ONLY for
 * node.* / edge.* and null for everything else, so `verbatim.upsert` LOST
 * supersession: an older FAILED verbatim.upsert could later retry and durably
 * OVERWRITE a newer replicated verbatim.upsert on the same id, reverting the
 * vector/BM25 substrate to stale content (recall/search return stale results).
 * The fix restores supersession for every previously-covered kind. At the
 * time there was no verbatim delete/tombstone kind, so `verbatim.upsert` got
 * its OWN family (never cross-superseded another kind) — same-kind
 * supersession only.
 *
 * UPDATE (2026-09-03, A2 finding 2 fix): `verbatim.tombstone` now exists
 * (outbox/types.ts) — every node-delete path records one AFTER its
 * `node.delete` row so replay converges to graph-absent + verbatim-
 * tombstoned. It joins the `verbatim` family and cross-supersedes
 * `verbatim.upsert` on the same id, exactly like `node.upsert`/`node.delete`
 * cross-supersede in the `node` family: without this, a `verbatim.upsert`
 * retried after its sibling `verbatim.tombstone` already replicated would
 * durably resurrect content a delete already tombstoned.
 *
 * This module centralizes the two pieces the fix needs so the replicator
 * (key derivation) and the SQLite store (matching SQL) stay in lock-step:
 *
 *   - `keyOfEntry`            — an outbox entry → its ENTITY FAMILY + a
 *                               canonical identity key, derived IDENTICALLY
 *                               across the family's kinds so upsert/delete on
 *                               the same entity compare equal.
 *   - `supersessionFamilySql` — the family's operationKind set + the SQL
 *                               expression that reproduces `keyOfEntry`'s
 *                               key from a stored `payload` JSON blob.
 *
 * Supersession is scoped BY ENTITY FAMILY: a node op can never supersede an
 * edge op (or vice-versa) even if their key strings collide.
 */

import { log } from '../logger.js';
import type { OutboxEntry } from './types.js';

/**
 * The entity family an outbox key belongs to. Supersession is scoped BY
 * FAMILY: a member of one family never supersedes a member of another, even
 * on a colliding key string.
 *
 *   - 'node'     — node.upsert / node.delete (identity = payload.id). The two
 *                  kinds CROSS-supersede (upsert/delete pair) so the latest
 *                  durably-applied op wins.
 *   - 'edge'     — edge.upsert / edge.delete (identity = the (sourceId,
 *                  targetId, relation) triple). Same cross-supersede pairing.
 *   - 'verbatim' — verbatim.upsert / verbatim.tombstone (identity =
 *                  payload.id = `lore:<id>`). The two kinds CROSS-supersede
 *                  (upsert/tombstone pair, mirroring node) so the latest
 *                  durably-applied op wins.
 */
export type EntityFamily = 'node' | 'edge' | 'verbatim';

/**
 * The `lastError` the replicator stamps on a row it parks as `dead` because a
 * newer same-key write already replicated (RA-6). It is the ONLY marker that
 * distinguishes such a row from a genuinely failed dead-letter: no write is
 * missing, a later write replaced it. Existing hosts' outbox files already hold
 * rows with exactly this text, so readers match on it rather than on a new
 * status. Every writer and reader goes through this constant; do not change the
 * text, or rows already on disk stop being recognised.
 */
export const SUPERSEDED_DEAD_ERROR = 'superseded by newer same-key write (RA-6)';

/** True when a dead row's `lastError` is the RA-6 supersession marker. */
export function isSupersededDeadError(lastError: string | null | undefined): boolean {
    return lastError === SUPERSEDED_DEAD_ERROR;
}

/**
 * Separator joining the edge identity triple into a single key. MUST equal
 * the store's `char(0)` composite (see supersessionFamilySql) so the JS key
 * and the SQL-rebuilt key compare byte-for-byte. NUL (U+0000) is used
 * deliberately: it cannot appear in a JSON string value from an
 * id/relation, so `${sourceId}\0${targetId}\0${relation}` is collision-free
 * (a plain space could appear inside an id/relation and cause false
 * matches). Defined as a constant so no literal control char sits in a
 * template string.
 */
const EDGE_KEY_SEP = String.fromCharCode(0);

/**
 * Map an outbox entry to its entity family + canonical identity key.
 *
 * The key MUST be derived identically for every kind in a family so they
 * compare equal for the same entity:
 *   - node family (node.upsert / node.delete) → key = node id (payload.id)
 *   - edge family (edge.upsert / edge.delete) → the edge identity triple
 *     joined by EDGE_KEY_SEP (NUL), mirroring the store's `char(0)`
 *     composite (see supersessionFamilySql) so JS and SQL keys compare
 *     equal; NUL cannot appear in an id/relation, so it is collision-free.
 *   - verbatim family (verbatim.upsert / verbatim.tombstone) → key =
 *     payload.id (`lore:<id>`), identical derivation to node so the SAME
 *     identity space is compared, but a DIFFERENT family so a verbatim op
 *     never supersedes a node op on a colliding key (and vice-versa). The
 *     two verbatim kinds CROSS-supersede each other (2026-09-03), same
 *     pairing shape as node.upsert/node.delete.
 *
 * Returns null ONLY for kinds with no supersedable identity — i.e. that had
 * none pre-c79e505 either: the batch/marker/notification kinds
 * (verbatim.upsert.batch, sync.vector.mirror, embed.batch/embed.done,
 * load.received/load.done, migration.*, stream.event) whose payloads carry no
 * `payload.id`. Also returns null when a required identity field is
 * missing/blank — the caller then falls through to the normal retry path
 * (no supersession guard).
 *
 * `node.mark_stale` (2026-09-03, X-markstale audit fix) joins this null-key
 * group deliberately rather than the `node` family: its payload carries
 * `ids: string[]` for a whole locked chunk, not one entity's `payload.id`,
 * so it has no single identity to compare against a `node.upsert` /
 * `node.delete` row. It also has no resurrection hazard those two
 * cross-supersede to prevent — replaying a stale mark on an id that was
 * since deleted (or re-created) is a harmless idempotent no-op / soft
 * false-positive flag, not a data-loss reordering.
 */
export function keyOfEntry(entry: OutboxEntry): { family: EntityFamily; key: string } | null {
    const kind = entry.operationKind;
    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    if (kind === 'node.upsert' || kind === 'node.delete') {
        const id = payload['id'];
        if (typeof id !== 'string' || id.length === 0) return null;
        return { family: 'node', key: id };
    }
    if (kind === 'edge.upsert' || kind === 'edge.delete') {
        const sourceId = payload['sourceId'];
        const targetId = payload['targetId'];
        const relation = payload['relation'];
        if (typeof sourceId !== 'string' || sourceId.length === 0
            || typeof targetId !== 'string' || targetId.length === 0
            || typeof relation !== 'string' || relation.length === 0) {
            return null;
        }
        return { family: 'edge', key: `${sourceId}${EDGE_KEY_SEP}${targetId}${EDGE_KEY_SEP}${relation}` };
    }
    if (kind === 'verbatim.upsert' || kind === 'verbatim.tombstone') {
        // payload.id is the canonical `lore:<id>` verbatim key. Same identity
        // derivation as node, but its own family so it never cross-supersedes
        // a node op on a colliding key. The two verbatim kinds cross-supersede
        // each other (2026-09-03) — a delete's tombstone must be able to
        // supersede a stale failed upsert, and vice versa, same as node.
        const id = payload['id'];
        if (typeof id !== 'string' || id.length === 0) return null;
        return { family: 'verbatim', key: id };
    }
    return null;
}

/**
 * SQL fragments the SQLite store uses to find a newer replicated row on the
 * SAME entity across ALL kinds in the family. `keyExpr` reproduces
 * `keyOfEntry`'s key from a row's `payload` JSON so a bound `key` parameter
 * compares equal to it.
 */
export function supersessionFamilySql(family: EntityFamily): { kinds: string; keyExpr: string } {
    // 3.26.0 — `json_extract` raises on a payload that is not valid JSON, so
    // one damaged row made this lookup throw for its whole workspace. Guarded,
    // such a row yields NULL and never equals the bound key.
    const field = (path: string): string => `CASE WHEN json_valid(payload) THEN json_extract(payload, '${path}') END`;
    switch (family) {
        case 'node':
            return {
                kinds: "('node.upsert', 'node.delete')",
                keyExpr: field('$.id'),
            };
        case 'verbatim':
            // verbatim.upsert / verbatim.tombstone cross-supersede (2026-09-03),
            // same keyExpr as node (payload.id), but the disjoint `kinds` set
            // keeps it from matching a node row on a colliding key.
            return {
                kinds: "('verbatim.upsert', 'verbatim.tombstone')",
                keyExpr: field('$.id'),
            };
        case 'edge':
            // char(0) matches keyOfEntry's NUL join; it cannot appear in an
            // id/relation, so the composite is collision-free.
            return {
                kinds: "('edge.upsert', 'edge.delete')",
                keyExpr: `${field('$.sourceId')} || char(0) || ${field('$.targetId')} || char(0) || ${field('$.relation')}`,
            };
    }
}

/**
 * The node id of a stored payload, or NULL when the payload is not valid JSON.
 * `json_extract` raises on malformed JSON, which would fail both the index
 * build and every lookup that reaches the row; one damaged record must not
 * switch the newest-save lookup off for its workspace. The query and the index
 * use this exact text: SQLite only serves a query from an expression index
 * whose expression matches.
 */
const NODE_UPSERT_ID_EXPR = "CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') END";

/** 3.26.0 — OutboxStore.newestNodeUpsertAfter for the SQLite store. Binds:
 *  workspace, node id, sequenceId. Only rows still queued count: a
 *  'replicated' row was already replayed, a 'dead' one never will be. A row
 *  whose payload is not valid JSON never matches. */
export const NEWEST_NODE_UPSERT_AFTER_SQL =
    `SELECT * FROM outbox_entries WHERE workspace = ? AND ${NODE_UPSERT_ID_EXPR} = ?`
    + " AND sequenceId > ? AND operationKind = 'node.upsert'"
    + " AND status IN ('pending', 'failed', 'replicating') ORDER BY sequenceId DESC LIMIT 1";

/** Index for {@link NEWEST_NODE_UPSERT_AFTER_SQL}: without it the lookup scans
 *  the workspace's rows and parses each payload, once per replayed row. */
export const NODE_UPSERT_ID_INDEX_SQL =
    "CREATE INDEX IF NOT EXISTS idx_outbox_node_upsert_id ON outbox_entries"
    + `(workspace, ${NODE_UPSERT_ID_EXPR}, sequenceId) WHERE operationKind = 'node.upsert'`;

interface SqliteHandle {
    exec(sql: string): unknown;
    prepare(sql: string): { get(...params: unknown[]): unknown };
}

/**
 * Create {@link NODE_UPSERT_ID_INDEX_SQL}. Called once when the store opens,
 * as its own statement and not as part of the schema script: a build that
 * fails (a busy or read-only database) must not fail the open. A malformed
 * payload does not fail it: it indexes as NULL. Best-effort: without the index
 * the lookup still answers, by scan. Resolves false when the build failed.
 */
export function ensureNodeUpsertIdIndex(db: Pick<SqliteHandle, 'exec'>): boolean {
    try {
        db.exec(NODE_UPSERT_ID_INDEX_SQL);
        return true;
    } catch (err) {
        log.warn(`[outbox] could not create idx_outbox_node_upsert_id (${(err as Error).message}); newest-save lookups will scan`);
        return false;
    }
}

/** Run {@link NEWEST_NODE_UPSERT_AFTER_SQL}. */
export function newestNodeUpsertRow(db: Pick<SqliteHandle, 'prepare'>, workspace: string, nodeId: string, sequenceId: number): unknown {
    return db.prepare(NEWEST_NODE_UPSERT_AFTER_SQL).get(workspace, nodeId, sequenceId);
}
