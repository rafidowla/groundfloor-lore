/**
 * postgres/postgresGraphDirected.ts — direction-preserving reads for
 * PostgresGraph. Mirrors `engines/sqlite/sqliteGraphDirected.ts`
 * operation-for-operation, on the SAME shared `graphShared/traverseBfs.ts`
 * BFS core. Every statement slices `workspace_id = $1` (see
 * postgresGraphReads.ts' header).
 */

import { normalizeTag } from '../normalizeTags.js';
import type { DirectedTraversalResult, LoreNodeSummary } from '../../providers/types.js';
import { cacheKey } from '../cache.js';
import { LoreGraphError } from '../loreGraphError.js';
import { shapeDepth, shapeLimit } from '../callTally.js';
import { runDirectedTraverseBfs, type FrontierEdgeCandidate } from '../graphShared/traverseBfs.js';
import type { PostgresReadCtx } from './postgresGraphReads.js';
import { DEFAULT_LIST_NODES_CAP } from './postgresGraphReads.js';
import { frontierEdgesSql } from './postgresEdgeSql.js';
import { chunkIds, PgParams } from './postgresGraphRow.js';

const TRAVERSE_NODE_CAP = 10_000;

/** One frontier level's directed edges, grouped by frontier node — see the sqlite reads' fetchFrontierEdges doc comment for the sub-order rationale. */
async function fetchDirectedFrontier(
    ctx: PostgresReadCtx,
    frontier: string[],
): Promise<Map<string, Array<{ to: string; relation: string; direction: 'out' | 'in' }>>> {
    const merged = new Map<string, Array<{ to: string; relation: string; direction: 'out' | 'in' }>>();
    for (const id of frontier) merged.set(id, []);
    for (const chunk of chunkIds(frontier)) {
        const outRows = await ctx.pool.query(
            frontierEdgesSql('out', true),
            [ctx.workspaceId, chunk],
        );
        for (const r of outRows.rows as Array<{ from_id: string; to_id: string; relation: string }>) {
            merged.get(r.from_id)!.push({ to: r.to_id, relation: r.relation, direction: 'out' });
        }
        const inRows = await ctx.pool.query(
            frontierEdgesSql('in', true),
            [ctx.workspaceId, chunk],
        );
        for (const r of inRows.rows as Array<{ from_id: string; to_id: string; relation: string }>) {
            merged.get(r.from_id)!.push({ to: r.to_id, relation: r.relation, direction: 'in' });
        }
    }
    return merged;
}

export async function traverseDirected(
    ctx: PostgresReadCtx,
    nodeId: string,
    maxDepth: number = 2,
): Promise<DirectedTraversalResult[]> {
    const clampedDepth = Math.min(Math.max(Math.trunc(maxDepth), 1), 5);
    if (!Number.isInteger(clampedDepth) || clampedDepth < 1 || clampedDepth > 5) {
        throw new LoreGraphError(`Invalid traversal depth ${maxDepth}`, 'traverseDirected', null);
    }
    ctx.tally?.record('traverseDirected', shapeDepth(clampedDepth));

    const memoKey = cacheKey('traverseDirected', ctx.workspaceId, ctx.readCache.epoch, { nodeId, maxDepth: clampedDepth });
    return ctx.readCache.memoize<DirectedTraversalResult[]>(memoKey, async () => {
        try {
            const { steps, capped } = await runDirectedTraverseBfs(
                nodeId,
                clampedDepth,
                TRAVERSE_NODE_CAP,
                (frontier) => fetchDirectedFrontier(ctx, frontier),
            );
            if (capped) {
                console.error(`[PostgresGraph] traverseDirected from '${nodeId}' hit the ${TRAVERSE_NODE_CAP}-node cap — results truncated (high-degree subgraph)`);
            }
            if (!ctx.readGetNodesByIds) {
                throw new LoreGraphError('traverseDirected requires readGetNodesByIds on the read context', 'traverseDirected', null);
            }
            const hydrated = await ctx.readGetNodesByIds(steps.map((s) => s.to));
            const results: DirectedTraversalResult[] = steps.map((s) => ({
                node: hydrated.get(s.to) ?? ({ id: s.to } as DirectedTraversalResult['node']),
                depth: s.depth,
                relation: s.relation,
                direction: s.direction,
                via: s.via,
            }));
            return results.sort((a, b) => a.depth - b.depth);
        } catch (error) {
            if (error instanceof LoreGraphError) throw error;
            throw new LoreGraphError(`Failed to traverse from '${nodeId}'`, 'traverseDirected', error);
        }
    });
}

/** `id`, `type`, `label` only — narrower projection of listNodes' filters/ordering, verbatim. */
export async function listNodeSummaries(
    ctx: PostgresReadCtx,
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

    const ordered = opts?.ordered !== false;
    const key = cacheKey('listNodeSummaries', ctx.workspaceId, ctx.readCache.epoch, {
        type: type ?? null, tag: tag ?? null, project, ecosystem, limit: effectiveLimit ?? 'all', ordered,
    });
    return ctx.readCache.memoize<LoreNodeSummary[]>(key, async () => {
        try {
            const params = new PgParams();
            params.add(ctx.workspaceId);
            const filters: string[] = [];
            if (type) { filters.push(`type = ${params.add(type)}`); }
            if (tag) {
                filters.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(nodes.tags::jsonb) je WHERE je = ${params.add(normalizeTag(tag))})`);
            }
            if (project !== '*') { filters.push(`project = ${params.add(project)}`); }
            if (ecosystem !== '*') {
                filters.push(`(ecosystem = ${params.add(ecosystem)} OR ecosystem = '*' OR ecosystem = '')`);
            }
            // 3.27.1: `id ASC` tie-break, same rule and index as listNodes.
            const where = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';
            let sql = `SELECT id, type, label FROM nodes WHERE workspace_id = $1${where}`;
            if (ordered) sql += ' ORDER BY "updatedAt" DESC, id ASC';
            if (effectiveLimit !== undefined) { sql += ` LIMIT ${params.add(effectiveLimit)}::int`; }
            const res = await ctx.pool.query(sql, params.values);
            return res.rows.map((row) => ({ id: String(row['id']), type: String(row['type'] ?? ''), label: String(row['label'] ?? '') }));
        } catch (error) {
            throw new LoreGraphError('Failed to list node summaries', 'listNodeSummaries', error);
        }
    });
}
