/**
 * sqlite/sqliteGraphDirected.ts — SQLite half of the direction-preserving
 * reads. Mirrors `surreal/surrealGraphDirected.ts` operation-for-operation,
 * on the SAME shared `graphShared/traverseBfs.ts` BFS core.
 */

import type { DirectedTraversalResult, LoreNodeSummary } from '../../providers/types.js';
import { cacheKey } from '../cache.js';
import { LoreGraphError } from '../loreGraphError.js';
import { DEFAULT_LIST_NODES_CAP } from '../loreNodeRow.js';
import { shapeDepth, shapeLimit } from '../callTally.js';
import { runDirectedTraverseBfs } from '../graphShared/traverseBfs.js';
import type { SqliteDb } from './sqliteGraphSchema.js';
import type { SqliteReadCtx } from './sqliteGraphReads.js';

const TRAVERSE_NODE_CAP = 10_000;
const CHUNK_SIZE = 256;

/** One frontier level's directed edges, grouped by frontier node — see sqliteGraphReads' fetchFrontierEdges doc comment for the sub-order rationale. */
async function fetchDirectedFrontier(
    db: SqliteDb,
    frontier: string[],
): Promise<Map<string, Array<{ to: string; relation: string; direction: 'out' | 'in' }>>> {
    const merged = new Map<string, Array<{ to: string; relation: string; direction: 'out' | 'in' }>>();
    for (const id of frontier) merged.set(id, []);
    for (let i = 0; i < frontier.length; i += CHUNK_SIZE) {
        const chunk = frontier.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        const outRows = db.prepare(
            `SELECT source_id AS from_id, target_id AS to_id, relation FROM edges WHERE source_id IN (${placeholders}) ORDER BY source_id, target_id, relation`,
        ).all(...chunk) as Array<{ from_id: string; to_id: string; relation: string }>;
        for (const r of outRows) merged.get(r.from_id)!.push({ to: r.to_id, relation: r.relation, direction: 'out' });
        const inRows = db.prepare(
            `SELECT target_id AS from_id, source_id AS to_id, relation FROM edges WHERE target_id IN (${placeholders}) ORDER BY target_id, source_id, relation`,
        ).all(...chunk) as Array<{ from_id: string; to_id: string; relation: string }>;
        for (const r of inRows) merged.get(r.from_id)!.push({ to: r.to_id, relation: r.relation, direction: 'in' });
    }
    return merged;
}

export async function traverseDirected(
    ctx: SqliteReadCtx,
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
                (frontier) => fetchDirectedFrontier(ctx.db, frontier),
            );
            if (capped) {
                console.error(`[SqliteGraph] traverseDirected from '${nodeId}' hit the ${TRAVERSE_NODE_CAP}-node cap — results truncated (high-degree subgraph)`);
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
    ctx: SqliteReadCtx,
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
            const filters: string[] = [];
            const params: unknown[] = [];
            if (type) { filters.push('type = ?'); params.push(type); }
            if (tag) {
                filters.push('EXISTS (SELECT 1 FROM json_each(nodes.tags) je WHERE je.value = ?)');
                params.push(tag.toLowerCase());
            }
            if (project !== '*') { filters.push('project = ?'); params.push(project); }
            if (ecosystem !== '*') {
                filters.push(`(ecosystem = ? OR ecosystem = '*' OR ecosystem = '')`);
                params.push(ecosystem);
            }
            const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
            let sql = `SELECT id, type, label FROM nodes${where}`;
            if (ordered) sql += ' ORDER BY updatedAt DESC';
            if (effectiveLimit !== undefined) { sql += ' LIMIT ?'; params.push(effectiveLimit); }
            const rows = ctx.db.prepare(sql).all(...params) as Array<{ id: string; type: string; label: string }>;
            return rows.map((row) => ({ id: row.id, type: String(row.type ?? ''), label: String(row.label ?? '') }));
        } catch (error) {
            throw new LoreGraphError('Failed to list node summaries', 'listNodeSummaries', error);
        }
    });
}
