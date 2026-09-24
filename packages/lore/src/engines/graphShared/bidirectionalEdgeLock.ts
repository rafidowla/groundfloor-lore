import type { KeyedMutex } from '../writeQueue.js';

/**
 * graphShared/bidirectionalEdgeLock.ts — shared serialization for
 * `addBidirectionalEdge` across SurrealGraph and SqliteGraph.
 *
 * Both engines' `addBidirectionalEdge` computed a forward key and a reverse
 * key (`src|tgt|relation` / `tgt|src|relation`) and locked them as two
 * NESTED `KeyedMutex.run()` calls, ordered so concurrent callers always take
 * the two locks in the same order (deadlock-avoidance for the *ordinary*
 * two-different-keys case).
 *
 * That breaks for a SELF-LOOP edge (`sourceId === targetId`, same
 * relation): forward and reverse keys are then the IDENTICAL string, so the
 * "outer" and "inner" `run()` calls target the SAME key. `KeyedMutex.run`
 * stores the in-flight promise for a key BEFORE its op settles
 * (writeQueue.ts), so the inner call's `chains.get(key)` reads back the
 * OUTER call's own still-pending promise and chains onto it — the outer
 * can't resolve until the inner op runs, and the inner op can't start until
 * the outer's promise (which IS the inner's predecessor) resolves.
 * Permanent deadlock, found 2026-09-18 (adjacent to an unrelated
 * outbox-replicator hang) — SqliteGraph inherited the exact pattern when it
 * was built, so both engines had it.
 *
 * Fix: when the two keys collide, take ONE lock instead of two nested ones.
 * Per-triple serialization is unaffected — a concurrent `addEdge` /
 * `addBidirectionalEdge` on the same triple still queues behind this call
 * either way, because every caller for that triple locks the same key.
 */
export async function runBidirectionalEdgeWrite<T>(
    chain: KeyedMutex,
    forwardKey: string,
    reverseKey: string,
    op: () => Promise<T>,
): Promise<T> {
    if (forwardKey === reverseKey) {
        return chain.run(forwardKey, op);
    }
    const [outerKey, innerKey] = forwardKey <= reverseKey ? [forwardKey, reverseKey] : [reverseKey, forwardKey];
    return chain.run(outerKey, () => chain.run(innerKey, op));
}
