/**
 * nodeWriteLock.ts — the ONE per-(workspace, node id) write lock every
 * mutating node path must hold.
 *
 * Why this module exists (root cause it closes):
 *   `core/nodeService.ts` owned a module-private `KeyedMutex` that wrapped
 *   `nodeUpsert()`'s three externally-visible writes (outbox row -> graph
 *   upsert -> verbatim/vector fan-out) so two concurrent same-id upserts
 *   could not land their graph and verbatim writes in opposite orders.
 *   It was never exported, so EVERY other mutating path for the same id —
 *   MCP `delete_node`, `DELETE /api/node/:id`, `POST /api/nodes/bulk`,
 *   `POST /api/nodes/bulk-delete`, changeset delete, prune/restore, and the
 *   outbox replicator's replay — ran its own outbox -> graph -> verbatim
 *   sequence with no serialization beyond `SurrealGraph`'s graph-ONLY
 *   `nodeWriteChain`. A delete interleaving with an upsert reproducibly
 *   left the graph holding the node while the verbatim/search mirror held
 *   a tombstone (or the reverse), with BOTH callers told `ok: true`, and
 *   left the outbox carrying `node.upsert` after `node.delete` — i.e. the
 *   replay order contradicting the executed order.
 *
 *   Same mutex, same key format, now shared: `nodeUpsert()` takes it via
 *   `withNodeLock`, and so does every other node-mutating path.
 *
 * --- THE RE-ENTRANCY RULE (read before wrapping a new call site) --------
 * `KeyedMutex` is NOT re-entrant. Acquiring a key you already hold
 * deadlocks that key forever (the inner acquisition chains behind the
 * outer one, which cannot finish until the inner resolves). So:
 *
 *   1. NEVER call `nodeUpsert()` — or any other already-locked helper, e.g.
 *      `applyChangesetUpsert` or the wrapped delete paths — from inside a
 *      `withNodeLock`/`withNodeLocks` callback. Locked callbacks may only
 *      touch RAW substrate primitives: `graph.upsertNode`,
 *      `graph.deleteNode`, `graph.bulkUpsertNodes`, `graph.markStaleByIds`,
 *      verbatim `store`/`tombstone`/`delete`, `recordHotWrite(Batch)`.
 *   2. NEVER nest `withNodeLock` inside another `withNodeLock` for a key
 *      that may be the same. Need several ids at once? Use `withNodeLocks`,
 *      which de-duplicates and acquires in a canonical (sorted) order.
 *   3. Multi-key acquisition goes through `withNodeLocks` ONLY. It is the
 *      single hold-and-wait acquirer in the codebase, and because it always
 *      acquires in sorted order, two concurrent multi-key acquisitions can
 *      never form a cycle. Single-key holders never wait on a second key,
 *      so they cannot participate in one either.
 *
 * Audited call sites (2026-09-03, updated 2026-09-03 — QA A2 round-4) — all
 * confirmed free of nested acquisition: `nodeService.nodeUpsert`;
 * `mcp/tools/memory/deleteNode.ts`; `mcp/http/routes/nodes-delete.ts`;
 * `mcp/http/routes/bulkWrite.ts` (both the batched `bulkUpsertNodes` branch
 * and the per-item `upsertOne` branch now go through `withNodeLocks` once
 * per CHUNK of at most `BULK_LOCK_CHUNK_SIZE` ids — not once for the whole
 * batch, which held every lock for the full batch's substrate-write time
 * (QA A2 round-4 finding 1) — with each chunk's `recordHotWriteBatch`
 * commit as the first thing done inside that chunk's lock, and a failed
 * chunk item's outbox row retracted before the lock releases (round-4
 * finding 2) — `upsertOne` calls the storage facade's RAW `upsertNode`, not
 * `nodeUpsert`, so it cannot re-enter);
 * `mcp/http/routes/bulkWriteEdgesDelete.ts`'s `handleBulkDelete` (same
 * chunked shape: `withNodeLocks` per chunk, that chunk's `recordHotWriteBatch`
 * first inside it, then each id's raw `deleteNode` + tombstone, with a
 * failed id's `node.delete` row retracted before the lock releases — no
 * per-id `withNodeLock` in the loop, which would now be a re-entrant
 * acquisition of a key the chunk's outer lock already holds);
 * `mcp/changesetWrite.applyChangesetDelete` (its sibling
 * `applyChangesetUpsert` delegates to `nodeUpsert`, which takes the lock
 * ITSELF — that one is deliberately NOT wrapped here); `mcp/tools/
 * lifecycle.ts` and `mcp/http/routes/lifecycle.ts` (raw graph writes);
 * `outbox/wiring.ts`'s replicator `upsertNode`/`deleteNode` substrates (raw
 * graph writes on the replicator's own background loop —
 * `recordHotWrite` never dispatches inline, so a replay can never be
 * entered from inside a lock).
 *
 * 2026-09-03 (X-markstale audit fix) — added: `mcp/tools/memory/
 * markStale.ts` and `mcp/http/routes/retention/policy.ts`'s POST
 * /api/mark-stale (both resolve tag-matched ids via the read-only
 * `graph.findNodeIdsByTags`, then per CHUNK take `withNodeLocks`, record a
 * `node.mark_stale` outbox row, THEN call the raw `graph.markStaleByIds` —
 * same chunked shape as `handleBulkDelete` above, no per-id `withNodeLock`
 * inside the chunk); `outbox/wiring.ts`'s replicator `markStale` substrate
 * (raw graph write on the replicator's own background loop, same
 * never-entered-from-inside-a-lock argument as `upsertNode`/`deleteNode`
 * above — takes `withNodeLocks` itself since a replay's chunk may differ
 * from the live caller's chunk boundaries).
 */

import { KeyedMutex } from '../engines/writeQueue.js';

/** Process-wide, shared by every node-mutating path. */
const nodeWriteLock = new KeyedMutex();

/** The canonical key. NUL cannot occur in a workspace name or a node id,
 *  so `(workspace, id)` cannot be ambiguously encoded. Format is unchanged
 *  from the private `nodeUpsertLock` key this module took over. */
export function nodeLockKey(workspace: string, id: string): string {
    return `${workspace}\u0000${id}`;
}

/**
 * Run `fn` with exclusive access to `(workspace, id)`. Different ids (and
 * different workspaces) never contend. Same-key callers run strictly FIFO
 * in acquisition order; a predecessor's rejection does not propagate.
 *
 * `fn` MUST NOT acquire the same key again — see the re-entrancy rule above.
 */
export async function withNodeLock<T>(
    workspace: string,
    id: string,
    fn: () => Promise<T>,
): Promise<T> {
    return nodeWriteLock.run(nodeLockKey(workspace, id), fn);
}

/**
 * Run `fn` holding ALL of `ids` for `workspace` at once — for a batch that
 * writes many nodes through ONE substrate call (`bulkUpsertNodes`) and so
 * cannot take the locks a node at a time without giving up the batch.
 *
 * Keys are de-duplicated and acquired in sorted order, which is what makes
 * this deadlock-free against every other acquirer (rule 3 above). An empty
 * id list runs `fn` with no lock held.
 */
export async function withNodeLocks<T>(
    workspace: string,
    ids: readonly string[],
    fn: () => Promise<T>,
): Promise<T> {
    const keys = [...new Set(ids)].sort();
    // Build the nested acquisition inside-out so the OUTERMOST acquisition
    // is the lowest sorted key. Each level enters the next only from inside
    // its own critical section, so every key is held for the whole of `fn`.
    let acquire: () => Promise<T> = fn;
    for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i]!;
        const inner = acquire;
        acquire = () => withNodeLock(workspace, key, inner);
    }
    return acquire();
}

/** Test helper — number of keys with an in-flight tail. */
export function nodeWriteLockSize(): number {
    return nodeWriteLock.size();
}

/**
 * Sprint E4 (QA A2 round-4, finding 1) — the maximum ids a single
 * `withNodeLocks` call may hold for a bulk writer's substrate loop.
 *
 * The round-3 fix (ef551757) moved a bulk batch's outbox commit to be the
 * first thing done INSIDE `withNodeLocks(allIds, ...)`, so nothing could
 * land between the commit and the substrate writes for any id in the
 * batch. That closed the ordering race, but `withNodeLocks` does not
 * release ANY of its keys until the whole callback returns — so a batch
 * of 1000 ids now holds all 1000 locks for the FULL duration of the
 * batch's substrate loop, not just each id's own turn. QA round-4
 * reproduced this at ~865-960x amplification: a concurrent single
 * `nodeUpsert()` on ONE of the 1000 ids waited ~10s (the whole batch's
 * wall time) instead of its own write's cost.
 *
 * Fix: CHUNK the batch into `withNodeLocks` calls of at most this many
 * ids each, acquired and released one chunk at a time. Each chunk still
 * runs its own outbox commit as the first thing inside its own lock,
 * ahead of that chunk's substrate writes (bulkWrite.ts /
 * bulkWriteEdgesDelete.ts) — the round-3 ordering guarantee holds WITHIN
 * a chunk, which is all it ever needed: a concurrent single-key writer on
 * an id can only ever be racing the ONE chunk that id is in, never the
 * ids in a different chunk. Releasing between chunks (rather than holding
 * the whole batch, or releasing between the outbox commit and the
 * substrate write within a chunk) is what bounds the worst-case hold to
 * one chunk's substrate-write time without reopening the ordering race
 * the round-3 fix closed.
 *
 * 32-64 is the target range; 50 keeps a chunk's substrate-write time
 * comfortably under the sub-1s p50 bound the round-4 QA repro measures
 * a concurrent single-write against.
 */
export const BULK_LOCK_CHUNK_SIZE = 50;

/** Split `items` into consecutive chunks of at most `size` elements each,
 *  preserving order. Used by bulk writers to bound a `withNodeLocks` call's
 *  id count — see `BULK_LOCK_CHUNK_SIZE` above. */
export function chunkForLocking<T>(items: readonly T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
}

/**
 * Round-E X-edges — the per-(workspace, sourceId, targetId, relation) write
 * lock every edge-mutating path must hold.
 *
 * Root cause this closes: nodes got `withNodeLock`/`withNodeLocks` (above)
 * serializing every node-mutating path's outbox-record -> substrate-write
 * sequence, but edges never got the equivalent. `SurrealGraph.addEdge` takes
 * an INSTANCE-local `edgeWriteChain` (engines/surrealGraph.ts) that only
 * serializes the raw graph write against itself — it does nothing for the
 * outbox-record-then-graph-write ordering (the exact race ef551757/de8367e7
 * fixed for nodes), it is invisible across the several call sites that each
 * resolve their own graph handle (MCP store_edge/delete_edge, REST POST+
 * DELETE /api/edge, the bulk edge endpoints, the outbox replicator's replay),
 * and `deleteEdge`/`addBidirectionalEdge` do not even take it. This lock is
 * the edge-side counterpart of `withNodeLock`/`withNodeLocks`: a SEPARATE
 * `KeyedMutex` instance (edge triples and node ids are different key spaces;
 * sharing one mutex would just make the key string longer for no benefit),
 * same re-entrancy contract, keyed on the directed triple plus workspace so
 * a workspace's own edge namespace can never contend with another's.
 *
 * Same re-entrancy rule as `withNodeLock` above: `KeyedMutex` is NOT
 * re-entrant. `fn` may only touch RAW substrate primitives (`graph.addEdge`,
 * `graph.addBidirectionalEdge`, `graph.deleteEdge`, `recordHotWrite(Batch)`)
 * — never call another already-locked edge helper (or `withEdgeLock`/
 * `withEdgeLocks` again) from inside the callback. A bidirectional edge
 * write touches TWO triples (forward and its mirror); acquire both via
 * `withEdgeLocks`, never two nested `withEdgeLock` calls, for the same
 * sorted-order / deadlock-free reasoning `withNodeLocks` rule 3 documents.
 */
const edgeWriteLock = new KeyedMutex();

/** The canonical edge-lock key. NUL cannot occur in a workspace name, node
 *  id, or relation label, so the 4-tuple cannot be ambiguously encoded. */
export function edgeLockKey(workspace: string, sourceId: string, targetId: string, relation: string): string {
    return `${workspace}\u0000${sourceId}\u0000${targetId}\u0000${relation}`;
}

/**
 * Run `fn` with exclusive access to the directed (workspace, sourceId,
 * targetId, relation) triple. A different triple (including the REVERSE
 * direction of the same pair) never contends with this call — bidirectional
 * writers that need both directions held together must use `withEdgeLocks`.
 *
 * `fn` MUST NOT acquire the same key again — see the re-entrancy rule above.
 */
export async function withEdgeLock<T>(
    workspace: string,
    sourceId: string,
    targetId: string,
    relation: string,
    fn: () => Promise<T>,
): Promise<T> {
    return edgeWriteLock.run(edgeLockKey(workspace, sourceId, targetId, relation), fn);
}

/** One directed edge triple, as used by `withEdgeLocks`. */
export interface EdgeLockTriple {
    sourceId: string;
    targetId: string;
    relation: string;
}

/**
 * Run `fn` holding ALL of `triples` for `workspace` at once — for a
 * bidirectional edge write (forward + reverse triple) or a bulk edge batch
 * that writes many edges through one critical section.
 *
 * Keys are de-duplicated and acquired in sorted order (same construction as
 * `withNodeLocks`), which is what makes this deadlock-free against every
 * other acquirer. An empty triple list runs `fn` with no lock held.
 */
export async function withEdgeLocks<T>(
    workspace: string,
    triples: readonly EdgeLockTriple[],
    fn: () => Promise<T>,
): Promise<T> {
    const keys = [...new Set(triples.map((t) => edgeLockKey(workspace, t.sourceId, t.targetId, t.relation)))].sort();
    let acquire: () => Promise<T> = fn;
    for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i]!;
        const inner = acquire;
        acquire = () => edgeWriteLock.run(key, inner);
    }
    return acquire();
}

/** Test helper — number of edge-lock keys with an in-flight tail. */
export function edgeWriteLockSize(): number {
    return edgeWriteLock.size();
}
