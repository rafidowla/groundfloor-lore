/**
 * postgres/postgresNodeBatch.ts - 3.35.0: Postgres' `commitNodeBatch` (see
 * graphShared/nodeBatch.ts).
 * ONE transaction (withTransaction): every id the batch can move — checks,
 * writes, and supersede-mark targets — is locked up front by
 * `SELECT id, revision FROM nodes WHERE workspace_id = $1 AND id = ANY($2)
 * ORDER BY id FOR UPDATE`, ids deduped and SORTED, so two overlapping batches
 * take their row locks in the same order and cannot deadlock each other into
 * an unrecoverable cycle (the postgres counterpart of SQLite's
 * `BEGIN IMMEDIATE`, which took the whole-file write lock instead). The
 * judgments read the LOCKED revisions off that select; every write is the
 * same guarded statement `sqliteGraphWrites.writeNode` runs; a refused
 * judgment throws a private sentinel which rolls the whole transaction back,
 * so a half-applied batch is impossible.
 *
 * ATOMIC SUPERSEDE (3.35.0 q): the optional `supersedes` argument runs inside
 * the SAME transaction, after the successor write: each link's guarded mark
 * (the exact UPDATE the non-atomic `supersedeNode` uses, incl. the
 * `validUntil` auto-stamp-if-unset), the successor's +1-per-mark revision
 * bump, and the `supersedes` edges (`INSERT ... ON CONFLICT DO NOTHING`). A
 * refused mark throws the sentinel, which rolls the successor back too.
 *
 * Outcome mapping (the one place this engine diverges from SQLite, per the
 * design §3 — SQLite has no concurrent-modification abort at all, so it
 * never produces `contention`):
 *   - SQLSTATE `40001` (serialization_failure) / `40P01` (deadlock_detected)
 *     -> `{ ok: false, code: 'contention' }`: Postgres aborted the unit of
 *     work before committing anything; the shared bounded retry
 *     (graphShared/nodeBatchRetry.ts — the CALLER's, exactly as around
 *     ArcadeGraphStore) re-reads, re-judges and re-submits, and throws the
 *     shared NodeBatchContentionError only when every attempt is exhausted.
 *   - statement/connection timeout (SQLSTATE `57014`, driver connection
 *     timeout) -> `{ ok: false, code: 'unknown' }`: the transaction MAY have
 *     committed; the retry helper settles by re-reading, never by blind replay.
 *   - every other engine failure is THROWN (nothing was applied) — the same
 *     "the server refused the command" rule ArcadeDB's primitive follows.
 * The primitive never retries; `traceNodeBatch`/`LORE_NODE_BATCH_TRACE` is
 * honoured exactly as the SQLite and ArcadeDB primitives honour it.
 */
import type { Pool, PoolClient } from 'pg';
import {
    assertNodeBatchShape, batchLandedRevision, supersedeMarkCount, traceNodeBatch,
    type NodeBatchCheck, type NodeBatchOutcome, type NodeBatchSupersedes, type NodeBatchWrite,
} from '../graphShared/nodeBatch.js';
import { RevisionConflictError } from '../graphShared/revision.js';
import { classifyPostgresError, withTransaction } from './postgresClient.js';
import { writeNode } from './postgresGraphWrites.js';
import { PgParams } from './postgresGraphRow.js';
import { skOf } from './postgresEdgeSql.js';
import { toPgTimestamp } from './postgresAsOfSchema.js';

type Refusal = Extract<NodeBatchOutcome, { ok: false; code: 'precondition' | 'revision' | 'exists' | 'supersede' }>;

class BatchRefused extends Error {
    constructor(readonly outcome: Refusal) { super(`node batch refused: ${outcome.code}`); }
}

/** Every id this batch can move, deduped and sorted — the FOR UPDATE lock order. */
function batchLockIds(checks: readonly NodeBatchCheck[], writes: readonly NodeBatchWrite[], supersedes?: NodeBatchSupersedes): string[] {
    const ids = new Set<string>();
    for (const c of checks) ids.add(c.id);
    for (const w of writes) ids.add(w.node.id);
    if (supersedes) for (const l of supersedes.links) { if (l.mark) ids.add(l.targetId); }
    return Array.from(ids).sort();
}

/** Run the batch. Throws only for an engine error (nothing was applied); every domain refusal is an outcome. */
export async function commitPostgresNodeBatch(
    pool: Pool,
    workspaceId: string,
    checks: NodeBatchCheck[],
    writes: NodeBatchWrite[],
    supersedes?: NodeBatchSupersedes,
): Promise<NodeBatchOutcome> {
    assertNodeBatchShape(checks, writes, supersedes);
    const lockIds = batchLockIds(checks, writes, supersedes);

    let revisions: Record<string, number>;
    try {
        revisions = await withTransaction(pool, async (client) => {
            // Lock first, sorted, so overlapping batches acquire in the same order.
            const locked = await client.query(
                'SELECT id, revision FROM nodes WHERE workspace_id = $1 AND id = ANY($2) ORDER BY id FOR UPDATE',
                [workspaceId, lockIds],
            );
            const revById = new Map<string, number>();
            for (const row of locked.rows) revById.set(String(row['id']), Number(row['revision'] ?? 0));
            const stored = (id: string): { exists: boolean; revision: number } => ({
                exists: revById.has(id),
                revision: revById.get(id) ?? 0,
            });

            for (let i = 0; i < checks.length; i++) {
                const c = checks[i]!;
                const { revision } = stored(c.id);
                if (revision !== c.revision) {
                    throw new BatchRefused({ ok: false, code: 'precondition', index: i, id: c.id, actual: revision });
                }
            }
            const landed: Record<string, number> = {};
            for (let k = 0; k < writes.length; k++) {
                const w = writes[k]!;
                const { exists, revision } = stored(w.node.id);
                if (w.kind === 'insert') {
                    if (exists) throw new BatchRefused({ ok: false, code: 'exists', index: k, id: w.node.id });
                } else if ((!exists && w.mustExist) || revision !== w.expectedRevision) {
                    throw new BatchRefused({ ok: false, code: 'revision', index: k, id: w.node.id, actual: revision });
                }
                try {
                    await writeNode(client, workspaceId, w.node, {
                        mode: 'conditional', expectedRevision: w.kind === 'cas' ? w.expectedRevision : 0,
                        updatedAt: w.updatedAt, mustExist: w.kind === 'cas' ? w.mustExist : false,
                    });
                } catch (e) {
                    if (e instanceof RevisionConflictError) {
                        throw new BatchRefused({ ok: false, code: 'revision', index: k, id: w.node.id, actual: e.actual });
                    }
                    throw e;
                }
                landed[w.node.id] = batchLandedRevision(w, supersedes);
            }
            if (supersedes) await applySupersedes(client, workspaceId, supersedes);
            return landed;
        });
    } catch (e) {
        if (e instanceof BatchRefused) {
            traceNodeBatch('postgres', checks.length, writes.length, e.outcome.code);
            return e.outcome;
        }
        const cls = classifyPostgresError(e);
        if (cls === 'contention') {
            traceNodeBatch('postgres', checks.length, writes.length, 'contention');
            // Nothing was committed (Postgres aborted the unit of work): the shared
            // nodeBatchRetry re-judges and re-submits; its exhaustion is the shared
            // NodeBatchContentionError (toNodeBatchContention's class).
            return { ok: false, code: 'contention' };
        }
        if (cls === 'timeout') {
            traceNodeBatch('postgres', checks.length, writes.length, 'unknown');
            // The transaction MAY have committed (statement timeout on the commit
            // round-trip): never replayed blindly — settleNodeBatchUnknown re-reads.
            return { ok: false, code: 'unknown' };
        }
        throw e;
    }
    traceNodeBatch('postgres', checks.length, writes.length, 'ok');
    return { ok: true, revisions };
}

/** The supersede half, run inside the batch transaction right after the successor write. Throws {@link BatchRefused} on a refused mark. */
async function applySupersedes(client: PoolClient, workspaceId: string, s: NodeBatchSupersedes): Promise<void> {
    for (let i = 0; i < s.links.length; i++) {
        const l = s.links[i]!;
        if (!l.mark) continue;
        const p = new PgParams();
        const res = await client.query(
            `UPDATE nodes SET supersededBy = ${p.add(s.successorId)}, supersededAt = ${p.add(s.supersededAt)},`
            + ` supersededReason = ${p.add(s.reason)}, revision = revision + 1,`
            + ` "validUntil" = CASE WHEN COALESCE("validUntil", '') = '' THEN ${p.add(s.supersededAt)} ELSE "validUntil" END,`
            + ` valid_until_at = CASE WHEN COALESCE("validUntil", '') = '' THEN ${p.add(toPgTimestamp(s.supersededAt))}::timestamptz ELSE valid_until_at END`
            + ` WHERE workspace_id = ${p.add(workspaceId)} AND id = ${p.add(l.targetId)}`
            + ` AND (supersededBy IS NULL OR supersededBy = '' OR supersededBy = ${p.add(s.successorId)})`,
            p.values,
        );
        if ((res.rowCount ?? 0) < 1) {
            throw new BatchRefused({ ok: false, code: 'supersede', index: i, id: l.targetId });
        }
    }
    const marks = supersedeMarkCount(s);
    if (marks > 0) {
        await client.query(
            'UPDATE nodes SET revision = revision + $1 WHERE workspace_id = $2 AND id = $3',
            [marks, workspaceId, s.successorId],
        );
    }
    for (const l of s.links) {
        if (!l.edge) continue;
        await client.query(
            `INSERT INTO edges (workspace_id, relation, confidence, "confidenceScore", src_sk, dst_sk, origin, created_at, partition_key)`
            + ` VALUES ($1, 'supersedes', 'extracted', 1.0, ${skOf('$1', '$2')}, ${skOf('$1', '$3')}, 'caller', now(),`
            + ` COALESCE((SELECT partition_key FROM nodes WHERE workspace_id = $1 AND id = $2), ''))`
            + ` ON CONFLICT (workspace_id, src_sk, dst_sk, relation) DO UPDATE SET valid_to = NULL`,
            [workspaceId, s.successorId, l.targetId],
        );
    }
}
