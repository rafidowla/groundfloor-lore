/**
 * graphShared/supersedeCycle.ts — the `supersedeNode` cycle guard, shared by
 * every local graph engine.
 *
 * 3.21 step 1a extraction: `surrealGraphWrites.ts`'s `supersedeNode` walks
 * the NEW node's `supersededBy` chain looking for the OLD node's id, to
 * refuse a supersession that would close a cycle (mirrors the equivalent
 * guard the prior local graph engine had). The walk itself — visited-set
 * bookkeeping, the hop cap, "stop if we've seen this id before" — is plain
 * JS with no engine-specific query shape; only `getSupersededBy` (how to
 * read one node's `supersededBy` field) differs between engines.
 *
 * `findSupersededByPredecessors` (the OTHER supersede-chain walk, "which
 * nodes did THIS one supersede") is not here: on SurrealGraph it is already
 * a single SurrealQL query, and the SQLite engine's design doc specifies it
 * as a recursive CTE — neither side is a JS walk, so there is nothing to
 * share.
 */

/** Same bound as the prior implementation's cycle guard. */
export const MAX_SUPERSEDE_CHAIN_HOPS = 1000;

/**
 * wouldCreateSupersedeCycle — true when walking `startSupersededBy` forward
 * (via `getSupersededBy`) reaches `targetId`, i.e. superseding `targetId`
 * with the node `startSupersededBy` chains from would close a loop.
 *
 * `getSupersededBy(id)` resolves one node's `supersededBy` field (or
 * `null`/`undefined` when the node is missing or not superseded). The walk
 * stops at `MAX_SUPERSEDE_CHAIN_HOPS`, on a repeated id (defensive — a
 * pre-existing cycle elsewhere in the chain must not hang this call), or
 * when the chain runs out.
 */
export async function wouldCreateSupersedeCycle(
    targetId: string,
    startSupersededBy: string | null | undefined,
    getSupersededBy: (id: string) => Promise<string | null | undefined>,
): Promise<boolean> {
    let cursor = startSupersededBy;
    const visited = new Set<string>();
    let hops = 0;
    while (cursor && hops < MAX_SUPERSEDE_CHAIN_HOPS) {
        if (cursor === targetId) return true;
        if (visited.has(cursor)) break;
        visited.add(cursor);
        cursor = await getSupersededBy(cursor);
        hops++;
    }
    return false;
}
