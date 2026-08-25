/**
 * surrealGraphDirected.ts — SurrealDB half of the direction-preserving reads.
 *
 * Mirrors `engines/localGraphDirected.ts` operation-for-operation. The two must
 * agree exactly, including same-depth sub-order, because the parity suite
 * compares them element by element — see `test/parity-surreal-graph-unit.ts`.
 *
 * Why direction needs its own operation at all: `traverse()` merges the
 * outgoing and incoming frontiers and returns `{ node, depth, relation }`, so a
 * caller cannot tell which way any edge pointed. Atlas refuses to use it for
 * call-graph work for exactly that reason ("would merge in/out and invert") and
 * pulls every edge in the workspace into memory instead. See the
 * `DirectedTraversalResult` doc in `providers/types.ts`.
 *
 * The SurrealDB shape differs from Kùzu's in ONE respect that is deliberate:
 * it fetches a whole frontier level per query rather than one query per node
 * per direction. Same results, same order, fewer round trips — the ordering is
 * reconstructed by iterating the frontier in order and outgoing-before-incoming
 * within each node, which is the discovery order LocalGraph produces.
 */

import type { DirectedTraversalResult, LoreNodeSummary } from '../../providers/types.js';
import type { SurrealReadCtx } from './surrealGraphReads.js';
import { cacheKey } from '../cache.js';
import { surrealError } from './surrealError.js';
import { DEFAULT_LIST_NODES_CAP } from '../loreNodeRow.js';
import { shapeDepth, shapeLimit } from '../callTally.js';
import { EDGE_TABLE, NODE_TABLE, ridToId, toNodeRid } from './surrealRecordId.js';

/** Same bound and reason as the Kùzu side: a high-degree node. */
const TRAVERSE_NODE_CAP = 10_000;
/** Matches `surrealGraphReads`' own chunking of id lists. */
const CHUNK_SIZE = 256;

interface DirectedEdge { from: string; to: string; relation: string; direction: 'out' | 'in' }

/**
 * One query per frontier level, returning outgoing and incoming edges as
 * SEPARATE projections so the direction survives — the merge that
 * `fetchFrontierEdges` performs is exactly what this must not do.
 */
async function fetchDirectedFrontier(
    ctx: SurrealReadCtx,
    frontier: string[],
): Promise<Map<string, DirectedEdge[]>> {
    const merged = new Map<string, DirectedEdge[]>();
    for (let i = 0; i < frontier.length; i += CHUNK_SIZE) {
        const chunk = frontier.slice(i, i + CHUNK_SIZE);
        const rows = await ctx.query(
            `SELECT id, ->${EDGE_TABLE}.{ relation: relation, other: out } AS outgoing,`
            + ` <-${EDGE_TABLE}.{ relation: relation, other: in } AS incoming`
            + ' FROM $ids',
            { ids: chunk.map((id) => toNodeRid(id, 'traverseDirected')) },
        );
        for (const row of rows) {
            const from = ridToId(row['id']);
            const edges: DirectedEdge[] = [];
            // Outgoing before incoming, matching LocalGraph's discovery order.
            for (const [key, direction] of [['outgoing', 'out'], ['incoming', 'in']] as const) {
                const list = row[key];
                if (!Array.isArray(list)) continue;
                for (const entry of list) {
                    const e = entry as { relation?: unknown; other?: unknown };
                    const to = ridToId(e.other);
                    if (!to) continue;
                    edges.push({
                        from, to, direction,
                        relation: typeof e.relation === 'string' ? e.relation : 'related_to',
                    });
                }
            }
            merged.set(from, edges);
        }
    }
    for (const id of frontier) if (!merged.has(id)) merged.set(id, []);
    return merged;
}

export async function traverseDirected(
    ctx: SurrealReadCtx,
    nodeId: string,
    maxDepth: number = 2,
): Promise<DirectedTraversalResult[]> {
    const clampedDepth = Math.min(Math.max(Math.trunc(maxDepth), 1), 5);
    if (!Number.isInteger(clampedDepth) || clampedDepth < 1 || clampedDepth > 5) {
        throw surrealError(`Invalid traversal depth ${maxDepth}`, 'traverseDirected', null);
    }
    ctx.tally?.record('traverseDirected', shapeDepth(clampedDepth));

    const memoKey = cacheKey('traverseDirected', ctx.workspaceId, ctx.readCache.epoch, {
        nodeId, maxDepth: clampedDepth,
    });
    return ctx.readCache.memoize<DirectedTraversalResult[]>(memoKey, async () => {
        try {
            const visited = new Set<string>([nodeId]);
            const results: DirectedTraversalResult[] = [];
            // Audit cluster 5 (2026-08-17): emit EVERY distinct directed edge,
            // not just the first one that reached each node — the documented
            // contract is "rebuild a directed subgraph", which needs all of
            // them. `visited` still gates EXPANSION (a node is expanded once);
            // `emitted` dedupes exact (via, direction, relation, to) triples.
            const emitted = new Set<string>();
            let frontier: string[] = [nodeId];
            let capped = false;

            bfs:
            for (let depth = 1; depth <= clampedDepth; depth++) {
                const byFrontier = await fetchDirectedFrontier(ctx, frontier);
                const nextFrontier: string[] = [];
                // Iterate the FRONTIER in order, not the query result, so the
                // same-depth sub-order matches LocalGraph's.
                for (const currentId of frontier) {
                    for (const edge of byFrontier.get(currentId) ?? []) {
                        // Contract: the seed itself is never returned.
                        if (edge.to === nodeId) continue;
                        const edgeKey = `${currentId}|${edge.direction}|${edge.relation}|${edge.to}`;
                        if (!emitted.has(edgeKey)) {
                            emitted.add(edgeKey);
                            results.push({
                                node: { id: edge.to } as DirectedTraversalResult['node'],
                                depth,
                                relation: edge.relation,
                                direction: edge.direction,
                                via: currentId,
                            });
                            if (results.length >= TRAVERSE_NODE_CAP) { capped = true; break bfs; }
                        }
                        if (!visited.has(edge.to)) {
                            visited.add(edge.to);
                            nextFrontier.push(edge.to);
                        }
                    }
                }
                if (nextFrontier.length === 0) break;
                frontier = nextFrontier;
            }
            if (capped) {
                console.error(`[SurrealGraph] traverseDirected from '${nodeId}' hit the ${TRAVERSE_NODE_CAP}-node cap — results truncated (high-degree subgraph)`);
            }

            // Hydrate in one batch, preserving push order (and therefore the
            // sub-order) — the same two-phase shape `traverse` uses.
            // The hook is optional on the ctx type (cloud/test contexts build a
            // bare ctx), but SurrealGraph always supplies it. Without it the
            // results would carry id-only stubs, which is a silently wrong
            // answer — so its absence is an error, not a fallback.
            if (!ctx.readGetNodesByIds) {
                throw surrealError('traverseDirected requires readGetNodesByIds on the read context',
                    'traverseDirected', null);
            }
            const hydrated = await ctx.readGetNodesByIds(results.map((r) => r.node.id));
            for (const r of results) {
                const full = hydrated.get(r.node.id);
                if (full) r.node = full;
            }
            return results.sort((a, b) => a.depth - b.depth);
        } catch (error) {
            throw surrealError(`Failed to traverse from '${nodeId}'`, 'traverseDirected', error);
        }
    });
}

/**
 * `id`, `type`, `label` only.
 *
 * Filters, casing, cap semantics and ordering are copied from
 * `surrealGraphReads.listNodes` verbatim so the two return the same rows in the
 * same order, narrower. This is where the projection win lives: SurrealDB
 * materialises whole documents, so asking for three fields instead of all of
 * them is the difference between 163.9 ms and 87.1 ms on 19,237 nodes.
 */
export async function listNodeSummaries(
    ctx: SurrealReadCtx,
    type?: string,
    tag?: string,
    project: string = '*',
    ecosystem: string = '*',
    limit?: number,
    opts?: { unbounded?: boolean; ordered?: boolean },
): Promise<LoreNodeSummary[]> {
    ctx.tally?.record('listNodeSummaries', shapeLimit(limit, opts?.unbounded));

    let effectiveLimit: number | undefined;
    if (opts?.unbounded) effectiveLimit = undefined;
    else if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
        effectiveLimit = Math.min(Math.floor(limit), 10_000);
    } else effectiveLimit = DEFAULT_LIST_NODES_CAP;

    const key = cacheKey('listNodeSummaries', ctx.workspaceId, ctx.readCache.epoch, {
        type: type ?? null, tag: tag ?? null, project, ecosystem,
        limit: effectiveLimit ?? 'all',
        ordered: opts?.ordered !== false,
    });
    return ctx.readCache.memoize<LoreNodeSummary[]>(key, async () => {
        try {
            const vars: Record<string, unknown> = {};
            // `updatedAt` is in the projection because SurrealDB requires the
            // ORDER BY key to be selected ("Missing order idiom `updatedAt` in
            // statement selection") — it is dropped from the result below. One
            // extra timestamp is still far cheaper than every document's
            // `content`, which is the field this read exists to avoid.
            // `updatedAt` is only in the projection to satisfy the ORDER BY —
            // SurrealDB rejects an order key that is not selected ("Missing
            // order idiom `updatedAt` in statement selection"). When the caller
            // opts out of ordering, it comes out of the projection too, and
            // that is where the real saving is: 389.8 ms -> 133.9 ms on 19,237
            // nodes, against `listNodes`' 547.2 ms.
            const ordered = opts?.ordered !== false;
            let sql = ordered
                ? `SELECT id, type, label, updatedAt FROM ${NODE_TABLE} WHERE true`
                : `SELECT id, type, label FROM ${NODE_TABLE} WHERE true`;
            if (type) { sql += ' AND type = $type'; vars['type'] = type; }
            if (tag) { sql += ' AND $tag IN tags'; vars['tag'] = tag.toLowerCase(); }
            if (project !== '*') { sql += ' AND project = $project'; vars['project'] = project; }
            // '*'/''/NONE = unscoped row, matches any scope (core/ecosystemMatch.ts).
            if (ecosystem !== '*') { sql += " AND (ecosystem = $ecosystem OR ecosystem = '*' OR ecosystem = '' OR ecosystem = NONE)"; vars['ecosystem'] = ecosystem; }
            if (ordered) sql += ' ORDER BY updatedAt DESC';
            if (effectiveLimit !== undefined) { sql += ' LIMIT $limit'; vars['limit'] = effectiveLimit; }
            const rows = await ctx.query(sql, vars);
            return rows.map((row) => ({
                id: ridToId(row['id']),
                type: String(row['type'] ?? ''),
                label: String(row['label'] ?? ''),
            }));
        } catch (error) {
            throw surrealError('Failed to list node summaries', 'listNodeSummaries', error);
        }
    });
}
