/**
 * arcadeNodeBatch.ts - 3.35.0: ArcadeDB's `commitNodeBatch` (see engines/graphShared/nodeBatch.ts).
 *
 * ONE `sqlscript` request with an explicit BEGIN ... COMMIT. Verified on 26.7.1 (slice-0 experiments
 * E2/E3a/E4/E7):
 *   - a record that was only READ is not validated at commit, so every precondition record is WRITTEN
 *     (`txTouch = ifnull(txTouch,0)+1`, guarded by `ifnull(revision,0) = :r`). A rival commit on that
 *     record then aborts exactly one of the two transactions with a ConcurrentModificationException.
 *     The touch never changes `revision`/`updatedAt` and creates no history or outbox row.
 *   - touches then item writes, each in ASCENDING id order, so two overlapping batches take their
 *     record locks in the same order.
 *   - each guard is `IF ($x[0].count < 1) { ROLLBACK; RETURN {...}; }`; the outcome is read from
 *     `result[0].value`. NEVER `RETURN COUNT` (syntax error on 26.7.1) and NEVER `COMMIT RETRY` (a
 *     guard that fires on a retry is ignored and a false success is reported).
 *   - HTTP: a CME is a 500 from a sqlscript commit (503 from a session commit) - detected by the body's
 *     `exception`, never by status (isArcadeConcurrentModification). A duplicate key is a 409.
 * Every id and every piece of content travels as a BOUND parameter; the script text is generated from
 * numeric indexes only.
 *
 * ATOMIC SUPERSEDE (3.35.0 q): the optional `supersedes` argument adds, to the SAME script and transaction, one
 * guarded mark per link (`UPDATE ... SET supersededBy ... WHERE id = :t AND (supersededBy IS NULL OR '' OR = :sid)`,
 * `IF count < 1 { ROLLBACK; RETURN failed:"supersede" }`) - merged into the id-ordered write phase - then a +k
 * revision bump on the successor (one per mark) and, last, one `supersedes` edge per link whose edge is missing
 * (`CREATE EDGE` guarded by an in-script existence SELECT, so two daemons re-sending the same supersede cannot
 * double it). A guard that fails after the successor statement rolls everything back: no successor, no mark, no
 * edge, no revision bump (verified on 26.7.1, slice 3b E-series).
 *
 * Classification: CME -> `contention`; a REFUSED connect (isArcadeConnectRefused: connect() failed, nothing was
 * sent) -> `refused` (item 9; the retry helper re-submits it on the shared transient budget); duplicate key -> `exists`; duplicate key -> `exists`; a failure that does not say whether
 * the batch committed (timeout, reset, 502/503/504 without a CME body) -> `unknown`; any other server
 * refusal is thrown (nothing was applied). The primitive never retries: the one retry helper
 * (graphShared/nodeBatchRetry.ts) re-reads and re-judges around it.
 */
import type { LoreNode } from '../../providers/types.js';
import { ArcadeHttpError, type ArcadeHttp } from './arcadeHttp.js';
import { isArcadeCommitRecordNotFound, isArcadeConcurrentModification, isArcadeConnectRefused } from './arcadeTransientErrors.js';
import { NODE_TYPE, EDGE_TYPE } from './arcadeSchema.js';
import { NODE_SET_CLAUSE, NODE_INSERT_CLAUSE, nodeWriteParams } from './arcadeNodeWrite.js';
import { revisionOf } from '../graphShared/revision.js';
import {
    assertNodeBatchShape, batchLandedRevision, supersedeMarkCount, traceNodeBatch,
    type NodeBatchCheck, type NodeBatchOutcome, type NodeBatchSupersedes, type NodeBatchWrite,
} from '../graphShared/nodeBatch.js';

export interface ArcadeNodeBatchCtx {
    tenantDb: string;
    http: ArcadeHttp;
    getNode(id: string): Promise<LoreNode | null>;
}

interface BuiltScript { script: string; params: Record<string, unknown> }

/** Prefix every `:name` in a clause so several items' parameters coexist in one script. */
const prefixParams = (clause: string, prefix: string): string => clause.replace(/:([A-Za-z_]+)/g, `:${prefix}$1`);

/**
 * The generated script. `touches` / `writes` carry their ORIGINAL positions (`at`) so a failure reports the
 * index the caller passed even though the script runs in id order. Exported for the contract test.
 */
export function buildNodeBatchScript(
    touches: Array<{ id: string; revision: number; at: number }>,
    writes: Array<{ w: NodeBatchWrite; params: Record<string, unknown>; at: number; insert?: boolean }>,
    supersedes?: NodeBatchSupersedes,
): BuiltScript {
    const params: Record<string, unknown> = {};
    const lines: string[] = ['BEGIN;'];
    const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const sortedTouches = [...touches].sort(byId);
    sortedTouches.forEach((t, j) => {
        params[`t${j}_id`] = t.id;
        params[`t${j}_rev`] = t.revision;
        lines.push(`LET t${j} = UPDATE ${NODE_TYPE} SET txTouch = ifnull(txTouch, 0) + 1 WHERE id = :t${j}_id AND ifnull(revision, 0) = :t${j}_rev;`);
        lines.push(`IF ($t${j}[0].count < 1) { ROLLBACK; RETURN {"failed":"precondition","i":${t.at}}; }`);
    });
    // Writes and supersede marks run in ONE ascending-id pass so overlapping batches lock records in the same order.
    type Item = { id: string; write?: (typeof writes)[number]; mark?: { link: number; targetId: string } };
    const items: Item[] = writes.map((it) => ({ id: it.w.node.id, write: it }));
    if (supersedes) {
        params['sp_sid'] = supersedes.successorId;
        params['sp_at'] = supersedes.supersededAt;
        params['sp_reason'] = supersedes.reason;
        supersedes.links.forEach((l, link) => { if (l.mark) items.push({ id: l.targetId, mark: { link, targetId: l.targetId } }); });
    }
    items.sort(byId);
    let wk = 0;
    let mk = 0;
    for (const item of items) {
        if (item.mark) {
            const j = mk++;
            params[`m${j}_id`] = item.mark.targetId;
            lines.push(`LET m${j} = UPDATE ${NODE_TYPE} SET supersededBy = :sp_sid, supersededAt = :sp_at, supersededReason = :sp_reason, revision = ifnull(revision, 0) + 1 WHERE id = :m${j}_id AND (supersededBy IS NULL OR supersededBy = '' OR supersededBy = :sp_sid);`);
            lines.push(`IF ($m${j}[0].count < 1) { ROLLBACK; RETURN {"failed":"supersede","i":${item.mark.link}}; }`);
            continue;
        }
        const it = item.write!;
        const k = wk++;
        const p = `w${k}_`;
        for (const [name, value] of Object.entries(it.params)) params[`${p}${name}`] = value;
        if (it.w.kind === 'cas' && !it.insert) {
            params[`${p}exp`] = it.w.expectedRevision;
            lines.push(`LET w${k} = UPDATE ${NODE_TYPE} SET ${prefixParams(NODE_SET_CLAUSE, p)} WHERE id = :${p}id AND ifnull(revision, 0) = :${p}exp;`);
            lines.push(`IF ($w${k}[0].count < 1) { ROLLBACK; RETURN {"failed":"revision","i":${it.at}}; }`);
        } else {
            lines.push(`INSERT INTO ${NODE_TYPE} SET ${prefixParams(NODE_INSERT_CLAUSE, p)};`);
        }
    }
    if (supersedes) {
        const marks = supersedeMarkCount(supersedes);
        // The successor was modified once per freshly claimed target (the non-atomic path bumped it per claim too).
        if (marks > 0) {
            params['sp_n'] = marks;
            lines.push(`UPDATE ${NODE_TYPE} SET revision = ifnull(revision, 0) + :sp_n WHERE id = :sp_sid;`);
        }
        params['sp_rel'] = 'supersedes';
        params['sp_conf'] = 'extracted';
        params['sp_score'] = 1.0;
        supersedes.links.filter((l) => l.edge).sort((a, b) => (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0)).forEach((l, j) => {
            params[`e${j}_id`] = l.targetId;
            lines.push(`LET e${j} = SELECT FROM ${EDGE_TYPE} WHERE outV().id = :sp_sid AND inV().id = :e${j}_id AND relation = :sp_rel;`);
            lines.push(`IF ($e${j}.size() < 1) { CREATE EDGE ${EDGE_TYPE} FROM (SELECT FROM ${NODE_TYPE} WHERE id = :sp_sid) TO (SELECT FROM ${NODE_TYPE} WHERE id = :e${j}_id) SET relation = :sp_rel, confidence = :sp_conf, confidenceScore = :sp_score; }`);
        });
    }
    lines.push('COMMIT;', 'RETURN {"ok":true};');
    return { script: lines.join('\n'), params };
}

const isDuplicate = (e: unknown): boolean =>
    e instanceof ArcadeHttpError && (e.status === 409 || /DuplicatedKeyException|duplicat/i.test(e.body));

/** Engine error -> outcome, or rethrow when the server refused the command (nothing applied). */
function classifyScriptError(err: unknown): 'contention' | 'exists' | 'unknown' {
    if (isArcadeConcurrentModification(err)) return 'contention';
    // (A) A commit that lost a race with a delete/replace of a touched record: the whole transaction is aborted
    // (verified live), so it is contention - re-judged and retried like a CME, then the existing 503 `contention`.
    if (isArcadeCommitRecordNotFound(err)) return 'contention';
    if (isDuplicate(err)) return 'exists';
    if (err instanceof ArcadeHttpError) {
        if (err.status === 502 || err.status === 503 || err.status === 504) return 'unknown';
        throw err; // the server refused the command (4xx, plain 500): nothing was applied
    }
    return 'unknown'; // timeout / reset / transport: may or may not have committed
}

export async function commitArcadeNodeBatch(
    ctx: ArcadeNodeBatchCtx, checks: NodeBatchCheck[], writes: NodeBatchWrite[], supersedes?: NodeBatchSupersedes,
): Promise<NodeBatchOutcome> {
    assertNodeBatchShape(checks, writes, supersedes);
    const done = (o: NodeBatchOutcome, tag?: string): NodeBatchOutcome => {
        traceNodeBatch('arcade', checks.length, writes.length, tag ?? (o.ok ? 'ok' : o.code));
        return o;
    };

    // Judge what a read can judge. The script's guards are the authority; these reads supply the row a
    // write is merged with, name an `exists`/`revision` miss without a round-trip, and (D7) find the
    // revision-0 checks that CAN be touched (a node that exists at revision 0) versus the ones on an
    // absent node, which has no record to touch and stays judged in-process (single-daemon).
    const touches: Array<{ id: string; revision: number; at: number }> = [];
    for (let i = 0; i < checks.length; i++) {
        const c = checks[i]!;
        if (c.revision === 0) {
            const row = await ctx.getNode(c.id);
            if (!row) continue; // absent == revision 0: holds, nothing to touch (documented single-daemon gap)
            if (revisionOf(row) !== 0) return done({ ok: false, code: 'precondition', index: i, id: c.id, actual: revisionOf(row) });
        }
        touches.push({ id: c.id, revision: c.revision, at: i });
    }
    const items: Array<{ w: NodeBatchWrite; params: Record<string, unknown>; at: number; insert: boolean }> = [];
    for (let k = 0; k < writes.length; k++) {
        const w = writes[k]!;
        const existing = await ctx.getNode(w.node.id);
        if (w.kind === 'insert') {
            if (existing) return done({ ok: false, code: 'exists', index: k, id: w.node.id });
        } else {
            const actual = revisionOf(existing);
            if ((!existing && w.mustExist) || actual !== w.expectedRevision) {
                return done({ ok: false, code: 'revision', index: k, id: w.node.id, actual });
            }
        }
        // A cas on a row that is ABSENT at read time (expected 0, not mustExist) creates it: there is no record for an
        // UPDATE to match, so it is an INSERT (lands revision 1 = 0 + 1). A rival creating it first is a duplicate key.
        items.push({ w, params: nodeWriteParams(w.node, existing, w.updatedAt), at: k, insert: !existing });
    }

    const { script, params } = buildNodeBatchScript(touches, items, supersedes);
    let res;
    try {
        res = await ctx.http.commandScript(ctx.tenantDb, script, params);
    } catch (err) {
        // Item 9: a refused connect provably sent nothing - say so, so the retry helper may re-submit it.
        if (isArcadeConnectRefused(err)) return done({ ok: false, code: 'refused', cause: err });
        const kind = classifyScriptError(err);
        if (kind === 'exists') {
            // Which INSERT lost? The first one scripted as an insert whose id exists now. A plain `insert` write
            // reports `exists`; a `cas` that tried to create the row lost a revision race (the row is at revision >= 1).
            for (const it of items) {
                if (!it.insert) continue;
                const now = await ctx.getNode(it.w.node.id);
                if (!now) continue;
                return it.w.kind === 'insert'
                    ? done({ ok: false, code: 'exists', index: it.at, id: it.w.node.id })
                    : done({ ok: false, code: 'revision', index: it.at, id: it.w.node.id, actual: revisionOf(now) });
            }
            // The duplicate row cannot be found (deleted again, or a replica read lag). A plain `insert` still means "id taken".
            const plain = items.find((it) => it.w.kind === 'insert');
            if (plain) return done({ ok: false, code: 'exists', index: plain.at, id: plain.w.node.id });
            return done({ ok: false, code: 'unknown' }, 'unknown(duplicate-unlocated)');
        }
        return done({ ok: false, code: kind });
    }

    const value = (res.result?.[0] as { value?: { ok?: boolean; failed?: string; i?: number } } | undefined)?.value;
    if (value?.ok === true) {
        const revisions: Record<string, number> = {};
        for (const w of writes) revisions[w.node.id] = batchLandedRevision(w, supersedes);
        return done({ ok: true, revisions });
    }
    if (value?.failed === 'supersede' && typeof value.i === 'number' && supersedes?.links[value.i]) {
        return done({ ok: false, code: 'supersede', index: value.i, id: supersedes.links[value.i]!.targetId });
    }
    if ((value?.failed === 'precondition' || value?.failed === 'revision') && typeof value.i === 'number') {
        // The transaction rolled back. Re-read for the revision actually stored (best effort, informational).
        const id = value.failed === 'precondition' ? checks[value.i]!.id : writes[value.i]!.node.id;
        const actual = revisionOf(await ctx.getNode(id));
        return done({ ok: false, code: value.failed, index: value.i, id, actual });
    }
    // The script ran but answered something we do not understand: we cannot claim success OR failure.
    return done({ ok: false, code: 'unknown' }, 'unknown(unparsed)');
}
