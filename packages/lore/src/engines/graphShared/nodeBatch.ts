/**
 * nodeBatch.ts - 3.35.0: the engine-neutral `commitNodeBatch` primitive.
 *
 * ONE transaction that (1) validates a set of CHECKS (a node must be at exactly revision r) and (2)
 * applies a set of WRITES (revision-guarded node writes), all or nothing. It exists so a write whose
 * precondition lives on ANOTHER node is safe across daemons sharing one database: a plain read of the
 * precondition node is not validated by ArcadeDB's optimistic transactions, so the primitive WRITES a
 * counter on every precondition record (a "touch"), turning the read into a validated write - a rival
 * commit on that record then aborts one of the two transactions. SQLite takes the write lock with
 * `BEGIN IMMEDIATE`, so a plain SELECT inside the transaction is already safe there.
 *
 * Engines implement {@link NodeBatchCapable} optionally (the shape mirrors `RecallableNotSupported` in
 * providers/recallableTypes.ts): ArcadeDB (engines/arcade/arcadeNodeBatch.ts) and SQLite
 * (engines/sqlite/sqliteNodeBatch.ts). Dataplane and Surreal have no per-node revision and no
 * implementation - callers feature-detect with {@link hasNodeBatchSupport} and keep their existing
 * (single-daemon) path when it is false.
 *
 * Outcome contract (callers: engines/graphShared/nodeBatchRetry.ts, the one retry helper):
 *   ok            every check held and every write landed; `revisions` maps each written id to the
 *                 revision it now holds.
 *   precondition  check `index` (position in the `checks` argument) did not hold; NOTHING was written.
 *   revision      write `index` is a `cas` whose stored revision was not the expected one (or, for a
 *                 `mustExist` write, whose row is absent); NOTHING was written. `actual` = revision found.
 *   exists        write `index` is an `insert` and the id is taken; NOTHING was written.
 *   contention    the engine aborted the transaction on a concurrent modification; NOTHING was written.
 *                 Safe to re-read and re-submit the WHOLE batch.
 *   unknown       the request failed in a way that does not say whether it committed (timeout, reset).
 *                 The caller must SETTLE by re-reading; replaying blindly can double-apply.
 *   supersede     3.35.0 (q): write-time supersession. A target's mark guard failed (another successor holds it,
 *                 or the target is gone); NOTHING was written. `index` = position in `supersedes.links`.
 *   refused       3.35.0 (item 9): the connection to the engine was REFUSED, so provably nothing was sent. Safe to
 *                 re-submit (bounded, nodeBatchRetry.ts); `cause` is the original connect error.
 * An engine error that is none of these (the server refused the command) is thrown.
 *
 * SUPERSEDES (3.35.0 q). An optional third argument turns the batch into an ATOMIC SUPERSEDE: in the same
 * transaction as the successor write, each link's target is marked `supersededBy` the successor (guarded: the
 * target must be unclaimed or already ours) and a `supersedes` edge is created when missing. Whether a link needs
 * the mark and/or the edge was decided by the caller's read just before (`mark` / `edge` flags - a re-send of a
 * 3.34-style partial supersede passes only the missing half); the engine re-guards the mark in the transaction.
 * The successor's revision lands `landedRevision(write) + number of marks` (one bump per freshly claimed target,
 * the same count the non-atomic path produced), and each marked target lands `revision + 1`.
 */
import type { LoreNode } from '../../providers/types.js';

export type NodeBatchNodeInput = Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>;

/** A precondition: node `id` must be at exactly `revision` (0 = absent, or a row that predates revisions). */
export interface NodeBatchCheck { id: string; revision: number }

export type NodeBatchWrite =
    /** Land `expectedRevision + 1` only if the stored revision is still `expectedRevision`; `mustExist` = never create (ifRevision). */
    | { kind: 'cas'; node: NodeBatchNodeInput; expectedRevision: number; mustExist: boolean; updatedAt: string }
    /** Create only (ifAbsent): refused when the id is taken. Lands at revision 1. */
    | { kind: 'insert'; node: NodeBatchNodeInput; updatedAt: string };

export type NodeBatchOutcome =
    | { ok: true; revisions: Record<string, number> }
    | { ok: false; code: 'precondition' | 'revision' | 'exists'; index: number; id: string; actual?: number }
    | { ok: false; code: 'supersede'; index: number; id: string }
    | { ok: false; code: 'contention' }
    | { ok: false; code: 'refused'; cause: unknown }
    | { ok: false; code: 'unknown' };

/** One superseded target: write the `mark` and/or the `supersedes` `edge` (false = already in place, do not write it). */
export interface NodeBatchSupersedeLink { targetId: string; mark: boolean; edge: boolean }

/** The supersede half of an atomic batch: the successor (one of the batch's writes) supersedes `links`' targets. */
export interface NodeBatchSupersedes {
    successorId: string;
    reason: string;
    supersededAt: string;
    links: NodeBatchSupersedeLink[];
}

export interface NodeBatchCapable {
    commitNodeBatch(checks: NodeBatchCheck[], writes: NodeBatchWrite[], supersedes?: NodeBatchSupersedes): Promise<NodeBatchOutcome>;
}

/** What an engine without the primitive answers when asked (never thrown by `hasNodeBatchSupport` callers). */
export interface NodeBatchNotSupported { supported: false; code: 'not_supported'; reason: string }

export const NODE_BATCH_NOT_SUPPORTED: NodeBatchNotSupported = {
    supported: false,
    code: 'not_supported',
    reason: 'this storage engine has no atomic multi-node commit (commitNodeBatch); preconditions stay single-daemon',
};

export const hasNodeBatchSupport = (g: unknown): g is NodeBatchCapable =>
    typeof (g as NodeBatchCapable | null | undefined)?.commitNodeBatch === 'function';

/** Largest batch (D3): 100 writes and 400 distinct lock ids (writes + checks). */
export const MAX_NODE_BATCH_WRITES = 100;
export const MAX_NODE_BATCH_CHECKS = 400;

/** A malformed batch (empty, over the cap, a repeated write id): a programming error, never a runtime outcome. */
export class NodeBatchInvalidError extends Error {
    readonly code = 'node_batch_invalid';
    constructor(message: string) {
        super(`node_batch_invalid: ${message}`);
        this.name = 'NodeBatchInvalidError';
    }
}

/** Shared by every engine so the shape rules cannot drift. */
export function assertNodeBatchShape(checks: readonly NodeBatchCheck[], writes: readonly NodeBatchWrite[], supersedes?: NodeBatchSupersedes): void {
    if (writes.length === 0) throw new NodeBatchInvalidError('a batch needs at least one write');
    if (writes.length > MAX_NODE_BATCH_WRITES) throw new NodeBatchInvalidError(`at most ${MAX_NODE_BATCH_WRITES} writes per batch (got ${writes.length})`);
    if (checks.length > MAX_NODE_BATCH_CHECKS) throw new NodeBatchInvalidError(`at most ${MAX_NODE_BATCH_CHECKS} checks per batch (got ${checks.length})`);
    const seen = new Set<string>();
    for (const w of writes) {
        if (seen.has(w.node.id)) throw new NodeBatchInvalidError(`write id '${w.node.id}' appears twice in one batch`);
        seen.add(w.node.id);
    }
    const checked = new Set<string>();
    for (const c of checks) {
        if (!Number.isInteger(c.revision) || c.revision < 0) throw new NodeBatchInvalidError(`check '${c.id}' needs a non-negative integer revision`);
        if (checked.has(c.id)) throw new NodeBatchInvalidError(`check id '${c.id}' appears twice in one batch`);
        checked.add(c.id);
    }
    if (!supersedes) return;
    if (!seen.has(supersedes.successorId)) throw new NodeBatchInvalidError(`supersedes successor '${supersedes.successorId}' is not one of the batch's writes`);
    const targets = new Set<string>();
    for (const l of supersedes.links) {
        if (l.targetId === supersedes.successorId) throw new NodeBatchInvalidError('a node cannot supersede itself');
        if (seen.has(l.targetId)) throw new NodeBatchInvalidError(`supersedes target '${l.targetId}' is also a write of the same batch`);
        if (targets.has(l.targetId)) throw new NodeBatchInvalidError(`supersedes target '${l.targetId}' appears twice`);
        targets.add(l.targetId);
    }
    if (targets.size + seen.size + checked.size > MAX_NODE_BATCH_CHECKS + MAX_NODE_BATCH_WRITES) throw new NodeBatchInvalidError('too many supersedes targets in one batch');
}

/** The revision a landed write holds (before any supersede bump). */
export const landedRevision = (w: NodeBatchWrite): number => (w.kind === 'cas' ? w.expectedRevision + 1 : 1);

/** Freshly claimed targets: each moves the successor's revision by one. */
export const supersedeMarkCount = (s: NodeBatchSupersedes | undefined): number => s ? s.links.filter((l) => l.mark).length : 0;

/** The revision `w` holds once the batch (with its supersede bumps) has landed. */
export const batchLandedRevision = (w: NodeBatchWrite, s: NodeBatchSupersedes | undefined): number =>
    landedRevision(w) + (s && w.node.id === s.successorId ? supersedeMarkCount(s) : 0);

/** Optional trace of every attempt (LORE_NODE_BATCH_TRACE=1): proves the route used the primitive, not the per-item fallback. */
export function traceNodeBatch(engine: string, checks: number, writes: number, outcome: string): void {
    if (process.env['LORE_NODE_BATCH_TRACE'] !== '1') return;
    console.error(`[node-batch] engine=${engine} checks=${checks} writes=${writes} outcome=${outcome}`);
}
