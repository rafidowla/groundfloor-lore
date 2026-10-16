/**
 * outbox/pendingCommit.ts - 3.35.0 (R3): settle `pending_commit` outbox rows.
 *
 * A write path that records its `node.upsert` row BEFORE the graph commit stores it `pending_commit`
 * (hotLane.ts `pendingCommit`), so the replicator - which only claims `pending`/`failed` rows - cannot
 * replay a predicted revision whose commit has not settled. The writer flips the row ready right after
 * a successful commit (`commitHotRows`) and retracts it on a definite failure (the existing
 * `removeIfPending` retract paths). This module settles the rows nobody finished:
 *
 *   - an OUTCOME-UNKNOWN commit (the request timed out: the write may or may not have landed) leaves the
 *     row `pending_commit` and returns the error to the caller;
 *   - a crash between record and flip (or between record and commit) leaves it behind in the file.
 *
 * Settling asks the graph, never guesses: the node's committed revision is read back.
 *   committed revision >= the row's revision  -> the write landed: flip the row ready (replay is
 *                                                revision-guarded, so it is idempotent);
 *   otherwise                                  -> the write never landed and, because the HTTP/MCP
 *                                                response is sent only AFTER the graph commit, was never
 *                                                acknowledged: retract the row. Retracting waits for the
 *                                                row to be older than a grace period, so a write still in
 *                                                flight (or a request a hung engine applies late) is not
 *                                                retracted from under its writer;
 *   graph unreachable                          -> leave the row pending_commit and retry with the
 *                                                replicator's transient backoff. Never flipped blindly.
 *
 * A graph with no per-node revision (payload carries none) is judged by content: the row counts as
 * committed when the stored node already holds the payload's type/label/content - replaying that
 * is a no-op either way.
 *
 * Which paths use it (3.35.0 (q) adds the `supersedes` edge rows of core/atomicSupersede.ts, settled by the target's mark): core/nodeService.ts (non-revision path), core/nodeServiceConditional.ts
 * (writeNodeAtRevision), mcp/http/routes/bulkWrite.ts (both chunk record sites) and
 * bulkWriteConditional.ts. All other outbox rows are recorded after their commit, or are idempotent
 * deletes/edges whose replay needs no revision, and keep their `pending` status.
 *
 * Designed for slices 3/4 (preconditions, atomic batches): a multi-row write records all its rows
 * `pending_commit`, commits once, and flips them with one `markCommitted(ids)`.
 */
import { revisionOf } from '../engines/graphShared/revision.js';
import { transientBackoffMs } from './failureDisposition.js';
import type { OutboxEntry, OutboxStore } from './types.js';

/** Retract only rows older than this: covers a write in flight and a hung request applied late. */
export const DEFAULT_PENDING_COMMIT_GRACE_MS = 60_000;
export const DEFAULT_PENDING_COMMIT_SWEEP_MS = 1_000;

const envMs = (name: string, dflt: number): number => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n >= 0 && process.env[name] !== undefined && process.env[name] !== '' ? n : dflt;
};

/** The graph read the settle needs: the node as stored now (null when absent). Throws when the graph is unreachable. */
export type CommittedNodeReader = (id: string, workspace?: string) => Promise<Record<string, unknown> | null>;

export interface SettleReport { flipped: number; retracted: number; waiting: number; unreachable: number }

/** True when `node` shows the commit that `payload` (a node.upsert row) was recorded ahead of. */
export function rowCommitted(payload: Record<string, unknown> | undefined, node: Record<string, unknown> | null): boolean {
    if (!node) return false;
    const p = payload ?? {};
    if (typeof p['revision'] === 'number') return revisionOf(node as { revision?: unknown }) >= p['revision'];
    return (['type', 'label', 'content'] as const).every((k) => p[k] === undefined || p[k] === node[k]);
}

/**
 * 3.35.0 (q): the `supersedes` edge row of an atomic supersede (core/atomicSupersede.ts) committed in the same
 * transaction as the mark on its target, so it is judged by the target's `supersededBy`: it names the row's source
 * exactly when the commit landed. Undefined for any other row.
 */
function supersedeEdgeRow(row: OutboxEntry): { sourceId: string; targetId: string } | undefined {
    if (row.operationKind !== 'edge.upsert') return undefined;
    const p = row.payload as { sourceId?: unknown; targetId?: unknown; relation?: unknown } | undefined;
    return p?.relation === 'supersedes' && typeof p.sourceId === 'string' && typeof p.targetId === 'string'
        ? { sourceId: p.sourceId, targetId: p.targetId } : undefined;
}

/**
 * Settle every `pending_commit` row once. Per workspace, a graph read that throws stops that workspace's
 * pass (its rows stay `pending_commit`) and is reported in `unreachable`; other workspaces continue.
 */
export async function settlePendingCommits(deps: {
    store: OutboxStore;
    getNode?: CommittedNodeReader;
    graceMs?: number;
    now?: () => number;
    log?: (m: string) => void;
}): Promise<SettleReport> {
    const { store, getNode } = deps;
    const report: SettleReport = { flipped: 0, retracted: 0, waiting: 0, unreachable: 0 };
    if (typeof store.listPendingCommit !== 'function' || typeof store.markCommitted !== 'function') return report;
    const graceMs = deps.graceMs ?? envMs('LORE_PENDING_COMMIT_GRACE_MS', DEFAULT_PENDING_COMMIT_GRACE_MS);
    const now = deps.now ?? Date.now;
    const rows = await store.listPendingCommit();
    const down = new Set<string>();
    for (const row of rows) {
        const ws = row.workspace ?? '';
        if (down.has(ws)) { report.unreachable++; continue; }
        const sup = supersedeEdgeRow(row);
        const id = sup ? sup.targetId : (row.payload as { id?: unknown } | undefined)?.id;
        // Nothing to ask: a row of another kind, or a substrate without the read. Legacy behaviour (ready), but
        // only once the row is older than the grace - a live writer may still be mid-commit and will flip it itself.
        if ((row.operationKind !== 'node.upsert' && !sup) || typeof id !== 'string' || !getNode) {
            if (now() - Date.parse(row.createdAt) < graceMs) { report.waiting++; continue; }
            report.flipped += await store.markCommitted([row.id]);
            continue;
        }
        let node: Record<string, unknown> | null;
        try { node = await getNode(id, ws); } catch { down.add(ws); report.unreachable++; continue; }
        if (sup ? node?.['supersededBy'] === sup.sourceId : rowCommitted(row.payload, node)) { report.flipped += await store.markCommitted([row.id]); continue; }
        if (now() - Date.parse(row.createdAt) < graceMs) { report.waiting++; continue; }
        if (await retract(store, row)) report.retracted++;
    }
    if ((report.flipped || report.retracted) && deps.log) {
        deps.log(`[outbox] pending_commit settled: ${report.flipped} ready (graph shows the commit), ${report.retracted} retracted (never committed, never acknowledged)`);
    }
    return report;
}

/** Retract one never-committed row. `false` from removeIfPending means a replayer already claimed it - it cannot be, so leave it. */
async function retract(store: OutboxStore, row: OutboxEntry): Promise<boolean> {
    return store.removeIfPending ? await store.removeIfPending(row.id) : (await store.remove(row.id), true);
}

/** Cadence + backoff state for the replicator's sweep. */
export interface PendingCommitSweepState { nextAt: number; failures: number }
export const newPendingCommitSweepState = (): PendingCommitSweepState => ({ nextAt: 0, failures: 0 });

/**
 * One cadence-gated sweep, called from the replicator's maintenance step on every tick (busy or idle),
 * so a restart settles the rows its predecessor left without waiting for new writes. An unreachable
 * graph backs the sweep off with the replicator's transient backoff; it resets on the first success.
 */
export async function sweepPendingCommits(
    state: PendingCommitSweepState,
    deps: { store: OutboxStore; getNode?: CommittedNodeReader; log: (m: string) => void; now?: () => number },
): Promise<void> {
    const now = (deps.now ?? Date.now)();
    if (now < state.nextAt || typeof deps.store.listPendingCommit !== 'function') return;
    const interval = envMs('LORE_PENDING_COMMIT_SWEEP_MS', DEFAULT_PENDING_COMMIT_SWEEP_MS);
    state.nextAt = now + interval;
    try {
        const r = await settlePendingCommits(deps);
        if (r.unreachable > 0) {
            state.failures++;
            state.nextAt = now + Math.max(interval, transientBackoffMs(state.failures, { transientBaseMs: 500, transientCapMs: 60_000, random: Math.random }));
            deps.log(`[outbox] pending_commit settle: graph unreachable for ${r.unreachable} row(s); they stay pending_commit, retrying later`);
        } else state.failures = 0;
    } catch (err) {
        deps.log(`[outbox] pending_commit settle failed: ${(err as Error).message}`);
    }
}
