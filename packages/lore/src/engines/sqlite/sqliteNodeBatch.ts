/**
 * sqlite/sqliteNodeBatch.ts - 3.35.0: SQLite's `commitNodeBatch` (see graphShared/nodeBatch.ts).
 *
 * ONE `db.transaction(...).immediate()` (R7: the synchronous statement layer - a transaction callback
 * cannot await). `BEGIN IMMEDIATE` takes the database write lock up front, so a second connection (another
 * daemon on the same file) waits for it and then judges its checks against the committed state: a plain
 * SELECT of a check's revision inside the transaction is therefore already safe, and no "touch" is needed.
 * Nothing in the transaction awaits, so no other write in this process can interleave with it either.
 *
 * Every judgement (check, cas revision, insert existence) happens INSIDE the transaction, before the first
 * write; a failed one rolls the whole transaction back by throwing a private sentinel, so a half-applied
 * batch is impossible. ATOMIC SUPERSEDE (3.35.0 q): the optional `supersedes` argument runs inside the SAME transaction,
 * after the successor write: each link's guarded mark (the exact UPDATE the non-atomic `supersedeNode` uses, incl.
 * the `validUntil` auto-stamp-if-unset), the successor's +1-per-mark revision bump, and the `supersedes` edges
 * (`INSERT ... ON CONFLICT DO NOTHING`). A refused mark throws the sentinel, which rolls the successor back too.
 * (Before 3.35.0 the SQLite `supersedeNode` already ran mark + successor bump in one transaction, but the successor
 * write and the edge were separate statements/transactions - hence a partial supersede was possible there too.)
 * SQLite has no CME analogue: `contention` is never produced (a busy database waits
 * for `busy_timeout`; an exhausted wait surfaces as a thrown engine error, which is not an outcome).
 */
import type { NodeBatchCheck, NodeBatchOutcome, NodeBatchSupersedes, NodeBatchWrite } from '../graphShared/nodeBatch.js';
import { assertNodeBatchShape, batchLandedRevision, supersedeMarkCount, traceNodeBatch } from '../graphShared/nodeBatch.js';
import { RevisionConflictError } from '../graphShared/revision.js';
import type { SqliteDb } from './sqliteGraphSchema.js';
import { writeNodeSync } from './sqliteGraphWrites.js';

type Refusal = Extract<NodeBatchOutcome, { ok: false; code: 'precondition' | 'revision' | 'exists' | 'supersede' }>;

class BatchRefused extends Error {
    constructor(readonly outcome: Refusal) { super(`node batch refused: ${outcome.code}`); }
}

const storedRevision = (db: SqliteDb, id: string): { exists: boolean; revision: number } => {
    const row = db.prepare('SELECT revision FROM nodes WHERE id = ?').get(id) as { revision: number | null } | undefined;
    return { exists: row !== undefined, revision: row?.revision ?? 0 };
};

/** Run the batch. Throws only for an engine error (nothing was applied); every domain refusal is an outcome. */
export function commitSqliteNodeBatch(db: SqliteDb, checks: NodeBatchCheck[], writes: NodeBatchWrite[], supersedes?: NodeBatchSupersedes): NodeBatchOutcome {
    assertNodeBatchShape(checks, writes, supersedes);
    const run = db.transaction((): Record<string, number> => {
        for (let i = 0; i < checks.length; i++) {
            const c = checks[i]!;
            const { revision } = storedRevision(db, c.id);
            if (revision !== c.revision) throw new BatchRefused({ ok: false, code: 'precondition', index: i, id: c.id, actual: revision });
        }
        const revisions: Record<string, number> = {};
        for (let k = 0; k < writes.length; k++) {
            const w = writes[k]!;
            const { exists, revision } = storedRevision(db, w.node.id);
            if (w.kind === 'insert') {
                if (exists) throw new BatchRefused({ ok: false, code: 'exists', index: k, id: w.node.id });
            } else if ((!exists && w.mustExist) || revision !== w.expectedRevision) {
                throw new BatchRefused({ ok: false, code: 'revision', index: k, id: w.node.id, actual: revision });
            }
            try {
                writeNodeSync(db, w.node, {
                    mode: 'conditional', expectedRevision: w.kind === 'cas' ? w.expectedRevision : 0,
                    updatedAt: w.updatedAt, mustExist: w.kind === 'cas' ? w.mustExist : false,
                });
            } catch (e) {
                if (e instanceof RevisionConflictError) throw new BatchRefused({ ok: false, code: 'revision', index: k, id: w.node.id, actual: e.actual });
                throw e;
            }
            revisions[w.node.id] = batchLandedRevision(w, supersedes);
        }
        if (supersedes) applySupersedes(db, supersedes);
        return revisions;
    });
    let out: NodeBatchOutcome;
    try {
        out = { ok: true, revisions: run.immediate() };
    } catch (e) {
        if (!(e instanceof BatchRefused)) throw e;
        out = e.outcome;
    }
    traceNodeBatch('sqlite', checks.length, writes.length, out.ok ? 'ok' : out.code);
    return out;
}

/** The supersede half, run inside the batch transaction right after the successor write. Throws {@link BatchRefused} on a refused mark. */
function applySupersedes(db: SqliteDb, s: NodeBatchSupersedes): void {
    const mark = db.prepare(
        `UPDATE nodes SET supersededBy = ?, supersededAt = ?, supersededReason = ?, revision = revision + 1,
             validUntil = CASE WHEN validUntil IS NULL OR validUntil = '' THEN ? ELSE validUntil END WHERE id = ?
         AND (supersededBy IS NULL OR supersededBy = '' OR supersededBy = ?)`,
    );
    s.links.forEach((l, i) => {
        if (!l.mark) return;
        if (mark.run(s.successorId, s.supersededAt, s.reason, s.supersededAt, l.targetId, s.successorId).changes < 1) {
            throw new BatchRefused({ ok: false, code: 'supersede', index: i, id: l.targetId });
        }
    });
    const marks = supersedeMarkCount(s);
    if (marks > 0) db.prepare('UPDATE nodes SET revision = revision + ? WHERE id = ?').run(marks, s.successorId);
    const edge = db.prepare(
        `INSERT INTO edges (source_id, target_id, relation, confidence, confidenceScore) VALUES (?, ?, 'supersedes', 'extracted', 1.0)
         ON CONFLICT(source_id, target_id, relation) DO NOTHING`,
    );
    for (const l of s.links) if (l.edge) edge.run(s.successorId, l.targetId);
}
