/**
 * atomicSupersede.ts - 3.35.0 (q): write-time `supersedes` as ONE atomic commit.
 *
 * Before 3.35.0 a write with `supersedes: [old, ...]` was three separate things: the successor's own write, then
 * per target a mark (`supersededBy`) and a `supersedes` edge. Any failure between them left a partial supersede
 * (Nokshi M1): a successor with no mark, a mark with no edge. On a graph with the node-batch primitive
 * (ArcadeDB, SQLite) the successor write, every mark and every edge now travel in ONE `commitNodeBatch`
 * (engines/graphShared/nodeBatch.ts, `supersedes` argument), retried on contention by the one retry helper
 * (engines/graphShared/nodeBatchRetry.ts). A definite failure leaves nothing: no successor, no mark, no edge,
 * no revision bump.
 *
 * ENGINES. ArcadeDB and SQLite: atomic (this module). Dataplane and SurrealDB have no `commitNodeBatch`
 * (no per-node revision, no multi-statement script primitive), so {@link newSupersedeIntent} returns undefined and
 * callers keep the existing non-atomic path (`runSupersessionApply`) unchanged. We do NOT answer `not_supported`
 * there: a supersede is an established, documented write on those engines and refusing it would be a regression;
 * the plan (section 4) only requires `not_supported` for NEW capabilities that cannot be emulated.
 *
 * RE-SEND REPAIR. The plan is judged afresh on EVERY attempt from what is stored: a target already marked by this
 * successor needs no mark (idempotent), a target whose `supersedes` edge exists needs no edge. A re-send of a
 * 3.34-style partial supersede therefore writes exactly the missing half, inside the same transaction, and the
 * targets where one half was already in place and the other was not are reported as `repaired`.
 *
 * OUTBOX. The successor's `node.upsert` row is the caller's (writeNodeAtRevision). The edge rows (`edge.upsert`,
 * one-way) are owned here, under the per-edge locks: recorded `pending_commit` BEFORE the commit (once per target,
 * however many attempts), flipped ready after it, taken back on any definite failure. An outcome-unknown commit
 * leaves them for the settle sweep (outbox/pendingCommit.ts decides edge rows by the target's mark). Marks have no
 * outbox row, as before: the mark is a field of the target node, and `supersededBy` is read from the graph.
 */
import type { LoreNode } from '../providers/types.js';
import type { OutboxStore } from '../outbox/types.js';
import { commitHotRows, recordHotWrite } from '../outbox/hotLane.js';
import { hasNodeBatchSupport, type NodeBatchNodeInput, type NodeBatchSupersedeLink } from '../engines/graphShared/nodeBatch.js';
import { alreadySupersededMessage, supersedeGuardVerdict } from '../engines/graphShared/supersedeGuard.js';
import { hasRevisionSupport } from '../engines/graphShared/revision.js';
import { isOutcomeUnknown } from '../engines/graphShared/writeOutcome.js';
import { withEdgeLocks } from './nodeWriteLock.js';

export const WRITE_TIME_SUPERSEDE_REASON = 'supersedes (write-time enforcement, D5)';

/** The write's supersede was refused with nothing written: another successor holds a target, or a target is gone. */
export class SupersedeRefusedError extends Error {
    constructor(readonly code: 'already_superseded' | 'supersedes_apply_failed', message: string) {
        super(message);
        this.name = 'SupersedeRefusedError';
    }
}

export const isSupersedeRefused = (e: unknown): e is SupersedeRefusedError =>
    e instanceof SupersedeRefusedError || (e as { name?: unknown } | null)?.name === 'SupersedeRefusedError';

/** What a write needs to commit its `supersedes` atomically, and what the commit reports back (`applied`, `repaired`). */
export interface SupersedeIntent {
    successorId: string;
    /** De-duplicated, the successor itself excluded (a node cannot supersede itself). */
    targets: string[];
    workspace: string;
    initiator: string;
    store?: OutboxStore;
    /** Set once the atomic commit landed: the caller skips the non-atomic apply. */
    applied: boolean;
    /** Targets whose supersede was half in place (mark xor edge) and was completed by this commit. */
    repaired: string[];
    /** Marks the committed batch wrote (each bumped the successor's revision once). */
    marks: number;
}

type SupersedeReadGraph = {
    getNode(id: string): Promise<LoreNode | null>;
    queryEdges?(q: { source?: string; target?: string; relation?: string; limit: number; offset: number }): Promise<unknown[]>;
};

/** An intent when this write can supersede atomically on this graph; undefined = keep the existing path. */
export function newSupersedeIntent(
    graph: unknown, successorId: string, supersedes: readonly string[] | undefined,
    ctx: { workspace: string; initiator: string; store?: OutboxStore },
): SupersedeIntent | undefined {
    if (!supersedes || supersedes.length === 0) return undefined;
    if (!hasNodeBatchSupport(graph) || !hasRevisionSupport(graph) || typeof (graph as { getNode?: unknown }).getNode !== 'function') return undefined;
    const targets = [...new Set(supersedes)].filter((t) => t !== successorId);
    if (targets.length === 0) return undefined;
    return { successorId, targets, ...ctx, applied: false, repaired: [], marks: 0 };
}

const edgeTriple = (successorId: string, t: string) => ({ sourceId: successorId, targetId: t, relation: 'supersedes' });

/** Judge every target against the graph as it is now. Throws {@link SupersedeRefusedError}. */
export async function planSupersedeLinks(graph: SupersedeReadGraph, intent: SupersedeIntent): Promise<{ links: NodeBatchSupersedeLink[]; repaired: string[] }> {
    const links: NodeBatchSupersedeLink[] = [];
    const repaired: string[] = [];
    for (const t of intent.targets) {
        const row = await graph.getNode(t);
        if (!row) throw new SupersedeRefusedError('supersedes_apply_failed', `supersedes target '${t}' was not found (old-not-found); nothing was written`);
        const verdict = supersedeGuardVerdict(row.supersededBy, intent.successorId);
        if (verdict && !verdict.ok) {
            throw new SupersedeRefusedError('already_superseded', alreadySupersededMessage(t, verdict.supersededBy ?? 'another node'));
        }
        const marked = verdict !== null; // already ours: nothing to mark
        const edgeThere = typeof graph.queryEdges === 'function'
            && (await graph.queryEdges({ source: intent.successorId, target: t, relation: 'supersedes', limit: 1, offset: 0 })).length > 0;
        links.push({ targetId: t, mark: !marked, edge: !edgeThere });
        if (marked !== edgeThere) repaired.push(t);
    }
    return { links, repaired };
}

/** Owns the edge outbox rows of one atomic supersede across retry attempts. */
export class SupersedeEdgeRows {
    private readonly rows = new Map<string, string>();
    constructor(private readonly intent: SupersedeIntent) {}

    /** Record (once per target, however many attempts) the pending_commit row of every link that still needs its edge. */
    async record(links: readonly NodeBatchSupersedeLink[]): Promise<void> {
        const { store, workspace, initiator, successorId } = this.intent;
        if (!store) return;
        for (const l of links) {
            if (!l.edge || this.rows.has(l.targetId)) continue;
            const entry = await recordHotWrite(store, {
                workspace, operationKind: 'edge.upsert', initiator, operation: 'edge.upsert', pendingCommit: true,
                // One-way: replay treats a missing flag as true and would also write old -[supersedes]-> new.
                payload: { ...edgeTriple(successorId, l.targetId), confidence: 'extracted', confidenceScore: 1.0, bidirectional: false },
            });
            this.rows.set(l.targetId, entry.id);
        }
    }

    /** The commit landed: flip the rows ready. */
    async commit(): Promise<void> { await commitHotRows(this.intent.store, [...this.rows.values()]); }

    /** The commit definitely did not happen: take every row back. */
    async retract(): Promise<void> {
        const { store } = this.intent;
        if (!store) return;
        for (const id of this.rows.values()) {
            try { if (store.removeIfPending) await store.removeIfPending(id); else await store.remove(id); }
            catch (err) { console.error(`[supersede] could not retract edge outbox row ${id}: ${(err as Error).message}`); }
        }
        this.rows.clear();
    }

    /** True when `err` leaves the commit's outcome open (rows must stay for the settle sweep). */
    static leavesRows = isOutcomeUnknown;
}

/**
 * Run `body` (which commits the batch) holding the per-edge locks of every `supersedes` triple, with the edge
 * rows settled around it: flipped on success, retracted on any definite failure, left on an unknown outcome.
 * `body` receives the rows helper to record from inside its per-attempt `prepare`.
 */
export async function withSupersedeEdges<T>(intent: SupersedeIntent, body: (rows: SupersedeEdgeRows) => Promise<T>): Promise<T> {
    const rows = new SupersedeEdgeRows(intent);
    return withEdgeLocks(intent.workspace, intent.targets.map((t) => edgeTriple(intent.successorId, t)), async () => {
        let out: T;
        try { out = await body(rows); }
        catch (err) {
            if (!SupersedeEdgeRows.leavesRows(err)) await rows.retract();
            throw err;
        }
        await rows.commit();
        return out;
    });
}

/** Needed by callers that build the successor `NodeBatchNodeInput`. */
export type { NodeBatchNodeInput };
