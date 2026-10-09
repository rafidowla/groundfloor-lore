/**
 * revision.ts — the shared vocabulary of the per-node `revision` (conditional
 * writes, phase 2a).
 *
 * A node's `revision` is an integer that only goes up. The DATABASE computes
 * every bump (`revision = revision + 1` inside the same INSERT/UPDATE), so two
 * daemons writing one id concurrently end at +2, never +1.
 *
 * Three write modes exist at the engine level:
 *
 *   - plain       `upsertNode(node)`                  bump by 1, unconditionally.
 *   - conditional `upsertNodeAtRevision(node, r, at, mustExist?)` bump to r+1 ONLY if the stored
 *                 revision is still r (absent row == 0; with `mustExist` an absent row is a
 *                 conflict instead, so an `ifRevision` write never creates); otherwise throws
 *                 {@link RevisionConflictError}. `at` is the `updatedAt` the caller
 *                 already stamped (and recorded in the outbox payload).
 *   - replay      `replayNodeAtRevision(node)`        apply ONLY if the row is absent or
 *                 its revision is LOWER than node.revision; then write node.revision
 *                 and node.updatedAt verbatim (no bump). Returns whether it applied.
 *
 * Conditional and replay are optional graph verbs ({@link RevisionedGraph});
 * a graph without them (surreal, dataplane) simply has no revision and keeps
 * its legacy behaviour everywhere.
 */
import type { LoreNode } from '../../providers/types.js';

/** The stored revision no longer matches the one the caller based its write on. */
export class RevisionConflictError extends Error {
    readonly code = 'revision_conflict';
    constructor(readonly id: string, readonly expected: number, readonly actual: number) {
        super(`revision_conflict: ${id} is at revision ${actual}, expected ${expected}`);
        this.name = 'RevisionConflictError';
    }
}

export const isRevisionConflict = (e: unknown): e is RevisionConflictError =>
    e instanceof RevisionConflictError || (e as { name?: unknown } | null)?.name === 'RevisionConflictError';

type NodeInput = Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>;

/** Optional revision verbs a graph may expose. */
export interface RevisionedGraph {
    /** `mustExist` (an `ifRevision` write): an absent row is a conflict (actual 0), never an insert. */
    upsertNodeAtRevision?(node: NodeInput, expectedRevision: number, updatedAt: string, mustExist?: boolean): Promise<LoreNode>;
    replayNodeAtRevision?(node: LoreNode): Promise<boolean>;
    /** Upsert that leaves the revision unchanged — for counter-only writes (see {@link upsertKeepingRevision}). */
    upsertNodeKeepRevision?(node: NodeInput): Promise<LoreNode>;
}

export const hasRevisionSupport = (g: unknown): g is Required<RevisionedGraph> =>
    typeof (g as RevisionedGraph | null)?.upsertNodeAtRevision === 'function'
    && typeof (g as RevisionedGraph | null)?.replayNodeAtRevision === 'function';

/** A stored row's revision: rows from before the field existed read 0. */
export const revisionOf = (node: { revision?: unknown } | null | undefined): number =>
    typeof node?.revision === 'number' && Number.isFinite(node.revision) ? node.revision : 0;

/** Bounded retries for a conditional write that lost the race to another daemon. */
export const MAX_REVISION_ATTEMPTS = 5;

/** The revision stamped on an outbox node payload, or undefined for a legacy payload. */
export function payloadRevision(payload: Record<string, unknown>): number | undefined {
    const r = payload['revision'];
    return typeof r === 'number' && Number.isFinite(r) && r >= 1 ? r : undefined;
}

/**
 * Replay a `node.upsert` payload. A payload carrying a `revision` on a graph that
 * tracks revisions goes through the gate (applied only when the stored row is
 * absent or older, written verbatim, never bumped). Everything else — legacy
 * payloads, graphs without revision — runs `fallback`, today's behaviour.
 */
export async function replayNodePayload(
    graph: unknown,
    payload: Record<string, unknown>,
    fallback: () => Promise<unknown>,
): Promise<unknown> {
    if (payloadRevision(payload) !== undefined && hasRevisionSupport(graph)) {
        return graph.replayNodeAtRevision(payload as unknown as LoreNode);
    }
    return fallback();
}

/**
 * Write a node whose only change is a derived counter (outcome success/failure/
 * partial counts, confirmation score): those are not content changes and must not
 * move the revision. Graphs without the keep verb (surreal, dataplane) have no
 * revision, so the plain upsert is exactly right there.
 */
export function upsertKeepingRevision(
    graph: { upsertNode(node: any): Promise<LoreNode> } & RevisionedGraph,
    node: LoreNode,
): Promise<LoreNode> {
    return typeof graph.upsertNodeKeepRevision === 'function' ? graph.upsertNodeKeepRevision(node) : graph.upsertNode(node);
}
