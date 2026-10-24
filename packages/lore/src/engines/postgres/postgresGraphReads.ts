/**
 * postgres/postgresGraphReads.ts — read-side query surface for PostgresGraph.
 *
 * Mirrors `engines/sqlite/sqliteGraphReads.ts` function-for-function: same
 * cache keys, same clamps, same caps, same contract semantics — SQL where
 * that file has SQLite. Reuses the SAME shared primitives that file does —
 * `rowToLoreNode` (via the shared `fromSqliteNodeRow` row mapper), `rankSearchResults`
 * / `SEARCH_SCAN_CAP` / `keywordSearchTerms`, `metaArraysContainAll` and the SAME
 * `graphShared/traverseBfs.ts` BFS core — so parity holds by construction.
 *
 * The one structural difference from the SQLite engine: every statement here
 * slices on `workspace_id = $1` (one Postgres database holds many workspaces;
 * SQLite got isolation from one file per workspace).
 */

import { normalizeTag } from '../normalizeTags.js';
import type { LoreNode, TraversalResult } from '../../providers/types.js';
import type { ReadCache } from '../cache.js';
import type { CallTally } from '../callTally.js';
import { shapeDepth, shapeLimit } from '../callTally.js';
import { cacheKey } from '../cache.js';
import { LoreGraphError } from '../loreGraphError.js';
import { DEFAULT_LIST_NODES_CAP, rowToLoreNode } from '../loreNodeRow.js';
import { keywordMatchClause } from './postgresKeywordMatch.js';
import { rankSearchResults, SEARCH_SCAN_CAP, keywordSearchTerms } from '../searchRanking.js';
import { metaArraysContainAll } from '../metaArrayFilter.js';
import { runTraverseBfs, type FrontierEdgeCandidate } from '../graphShared/traverseBfs.js';
import type { Pool } from 'pg';
import { frontierEdgesSql } from './postgresEdgeSql.js';
import { chunkIds, fromPgNodeRow, pgError, PgParams, type PgRow } from './postgresGraphRow.js';

/** Mirrors surrealGraphReads'/sqliteGraphReads' TRAVERSE_NODE_CAP. */
const TRAVERSE_NODE_CAP = 10_000;

export interface PostgresReadCtx {
    pool: Pool;
    readCache: ReadCache;
    workspaceId: string;
    tally?: CallTally;
    readGetNodesByIds?: (ids: string[]) => Promise<Map<string, LoreNode>>;
}

/**
 * tagAnyOf — the SQL predicate "nodes.tags (a JSON array in TEXT) contains
 * ANY of the given values". This is the postgres expression of the sqlite
 * reads' `EXISTS (SELECT 1 FROM json_each(nodes.tags) je WHERE je.value …)`.
 * Values may arrive as one parameter (exact membership) or an array
 * (`= ANY($n)`) — same shape as the sqlite `IN (...)` forms.
 */
export function tagAnyOf(params: PgParams, values: readonly string[]): string {
    return `EXISTS (SELECT 1 FROM jsonb_array_elements_text(nodes.tags::jsonb) je WHERE je = ANY(${params.add(values)}))`;
}

/** tagEquals — exact single-tag membership, the one-value form of {@link tagAnyOf}. */
export function tagEquals(params: PgParams, value: string): string {
    return `EXISTS (SELECT 1 FROM jsonb_array_elements_text(nodes.tags::jsonb) je WHERE je = ${params.add(value)})`;
}

/**
 * metadataStringArrayContains — the postgres form of the sqlite search's
 * `metaExists` CASE: a node matches when `metadata[key]` is a JSON array
 * holding the string `value` among its STRING elements. Malformed/scalar
 * metadata matches nothing instead of throwing the whole search — the
 * sqlite CASE guards with `json_valid`, this guards with `pg_input_is_valid`
 * (PG 16+; PG 16 is the tested version). `jsonb_array_elements` (not `_text`)
 * plus the `jsonb_typeof = 'string'` test is the exact mirror of sqlite's
 * `je.type = 'text' AND je.value = ?` — a numeric element must not match its
 * own text form. Over/under-matching is additionally corrected by the JS
 * `metaArraysContainAll` backstop the shared search runs on every candidate.
 */
export function metadataStringArrayContains(params: PgParams, key: 'entities' | 'topics', value: string): string {
    const meta = 'nodes.metadata::jsonb';
    return 'CASE WHEN NOT pg_input_is_valid(nodes.metadata, \'jsonb\') THEN false'
        + ` WHEN jsonb_typeof(${meta}) IS DISTINCT FROM 'object' THEN false`
        + ` WHEN jsonb_typeof(${meta}->'${key}') IS DISTINCT FROM 'array' THEN false`
        + ` ELSE EXISTS (SELECT 1 FROM jsonb_array_elements(${meta}->'${key}') je`
        + ` WHERE jsonb_typeof(je.value) = 'string' AND je.value #>> '{}' = ${params.add(value)}) END`;
}

/** getNode — point lookup. Memoized on (workspace, epoch, id). */
export async function getNode(ctx: PostgresReadCtx, id: string): Promise<LoreNode | null> {
    ctx.tally?.record('getNode');
    const key = cacheKey('getNode', ctx.workspaceId, ctx.readCache.epoch, { id });
    return ctx.readCache.memoize<LoreNode | null>(key, async () => {
        try {
            const res = await ctx.pool.query(
                'SELECT * FROM nodes WHERE workspace_id = $1 AND id = $2',
                [ctx.workspaceId, id],
            );
            if (res.rows.length === 0) return null;
            return rowToLoreNode(fromPgNodeRow(res.rows[0] as PgRow));
        } catch (error) {
            throw pgError(`Failed to get node '${id}'`, 'getNode', error);
        }
    });
}

/** getNodesByIds — batch hydrate. Same contract as the sqlite reads: dedupe, drop empties, chunk, Map with missing ids absent. */
export async function getNodesByIds(ctx: PostgresReadCtx, ids: string[]): Promise<Map<string, LoreNode>> {
    ctx.tally?.record('getNodesByIds', shapeLimit(ids.length));
    const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)));
    if (unique.length === 0) return new Map();
    try {
        // Hydrate into a scratch map first (`= ANY(...)` row order is not the
        // requested order), then build the RETURNED map by walking `unique` —
        // Map iteration order always follows the caller's requested id order,
        // matching the SQLite engine.
        const hydrated = new Map<string, LoreNode>();
        for (const chunk of chunkIds(unique)) {
            const res = await ctx.pool.query(
                'SELECT * FROM nodes WHERE workspace_id = $1 AND id = ANY($2)',
                [ctx.workspaceId, chunk],
            );
            for (const row of res.rows) {
                const node = rowToLoreNode(fromPgNodeRow(row as PgRow));
                hydrated.set(node.id, node);
            }
        }
        const out = new Map<string, LoreNode>();
        for (const id of unique) {
            const node = hydrated.get(id);
            if (node) out.set(id, node);
        }
        return out;
    } catch (error) {
        throw pgError(`Failed to batch-get ${unique.length} node(s)`, 'getNodesByIds', error);
    }
}

/**
 * fetchFrontierEdges — one frontier level's edges, both directions, grouped
 * by the frontier node reached FROM, each tagged with `direction`. The
 * SHARED `sortFrontierEdges` (graphShared/traverseBfs.ts) enforces
 * "outgoing before incoming, then (relation, other id)" from that tag — this
 * function's own row order is not load-bearing (it is deterministic per call
 * via the composite edge index).
 */
export async function fetchFrontierEdges(
    pool: Pool,
    workspaceId: string,
    frontier: string[],
): Promise<Map<string, FrontierEdgeCandidate[]>> {
    const merged = new Map<string, FrontierEdgeCandidate[]>();
    for (const id of frontier) merged.set(id, []);
    for (const chunk of chunkIds(frontier)) {
        const outRows = await pool.query(
            frontierEdgesSql('out', false),
            [workspaceId, chunk],
        );
        for (const r of outRows.rows as Array<{ from_id: string; to_id: string; relation: string }>) {
            merged.get(r.from_id)!.push({ to: r.to_id, relation: r.relation, direction: 'out' });
        }
        const inRows = await pool.query(
            frontierEdgesSql('in', false),
            [workspaceId, chunk],
        );
        for (const r of inRows.rows as Array<{ from_id: string; to_id: string; relation: string }>) {
            merged.get(r.from_id)!.push({ to: r.to_id, relation: r.relation, direction: 'in' });
        }
    }
    return merged;
}

/** traverse — memoized on (workspace, epoch, nodeId, clampedDepth). */
export async function traverse(ctx: PostgresReadCtx, nodeId: string, maxDepth: number = 2): Promise<TraversalResult[]> {
    ctx.tally?.record('traverse', shapeDepth(Math.min(Math.max(Math.trunc(maxDepth), 1), 5)));
    const memoKey = cacheKey('traverse', ctx.workspaceId, ctx.readCache.epoch, {
        nodeId,
        maxDepth: Math.min(Math.max(Math.trunc(maxDepth), 1), 5),
    });
    return ctx.readCache.memoize<TraversalResult[]>(memoKey, () => traverseUncached(ctx, nodeId, maxDepth));
}

async function traverseUncached(ctx: PostgresReadCtx, nodeId: string, maxDepth: number): Promise<TraversalResult[]> {
    const clampedDepth = Math.min(Math.max(Math.trunc(maxDepth), 1), 5);
    if (!Number.isInteger(clampedDepth) || clampedDepth < 1 || clampedDepth > 5) {
        throw new LoreGraphError(`Invalid traversal depth ${maxDepth}`, 'traverse', null);
    }
    try {
        const { steps, capped } = await runTraverseBfs(
            nodeId,
            clampedDepth,
            TRAVERSE_NODE_CAP,
            (frontier) => fetchFrontierEdges(ctx.pool, ctx.workspaceId, frontier),
        );
        if (capped) {
            console.error(
                `[PostgresGraph] traverse from '${nodeId}' hit the ${TRAVERSE_NODE_CAP}-node cap `
                + '— results truncated (high-degree subgraph)',
            );
        }
        const hydrated = await getNodesByIds(ctx, steps.map((s) => s.id));
        const results: TraversalResult[] = steps.map((s) => ({
            node: hydrated.get(s.id) ?? ({ id: s.id } as LoreNode),
            depth: s.depth,
            relation: s.relation,
        }));
        return results.sort((a, b) => a.depth - b.depth);
    } catch (error) {
        throw pgError(`Failed to traverse from '${nodeId}'`, 'traverse', error);
    }
}

/**
 * search — keyword search, same contract as the sqlite reads: candidate
 * predicate is `lower(label|content)` substring OR exact tag membership,
 * AND-of-significant-terms, scoped by project/ecosystem,
 * `ORDER BY "updatedAt" DESC, id ASC LIMIT SEARCH_SCAN_CAP` pre-order, then
 * the SHARED `rankSearchResults` (which re-checks the whole predicate in JS
 * with `String.toLowerCase()`, the same case-fold the sqlite engine registers
 * as `lore_lower` — the SQL pushdown only narrows the candidate scan).
 */
export async function search(
    ctx: PostgresReadCtx,
    query: string,
    limit: number = 20,
    project: string = '*',
    ecosystem: string = '*',
    excludeHidden: boolean = false,
    signals?: { scanCapHit: boolean },
    types?: string[],
    entities?: string[],
    topics?: string[],
): Promise<LoreNode[]> {
    ctx.tally?.record('search', shapeLimit(limit));
    const clampedLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000);
    const key = cacheKey('search', ctx.workspaceId, ctx.readCache.epoch, {
        q: query.toLowerCase(), limit: clampedLimit, project, ecosystem, excludeHidden, types, entities, topics,
    });
    const cached = await ctx.readCache.memoize<{ nodes: LoreNode[]; scanCapHit: boolean }>(key, async () => {
        try {
            const q = query.toLowerCase();
            const terms = keywordSearchTerms(query);

            // ONE PgParams for the whole statement: placeholder numbers are
            // minted in add() order (workspace slice first, then the match
            // clause, then the scope filters, then the limit), so the SQL
            // text and the values array can never misalign (the failure the
            // sqlite two-arrays comment guards against with positional `?`).
            const params = new PgParams();
            params.add(ctx.workspaceId);

            // Index-served candidate predicate (postgresKeywordMatch.ts: LIKE + tag containment, CNF).
            const matchClause = keywordMatchClause(params, terms, q);

            const filters: string[] = [];
            if (project !== '*') { filters.push(`project = ${params.add(project)}`); }
            if (ecosystem !== '*') {
                filters.push(`(ecosystem = ${params.add(ecosystem)} OR ecosystem = '*' OR ecosystem = '')`);
            }
            if (excludeHidden) {
                filters.push(`(status != 'archived')`);
                filters.push(`(supersededat = '')`);
            }
            if (types && types.length > 0) {
                filters.push(`type = ANY(${params.add(types)})`);
            }
            for (const e of entities ?? []) filters.push(metadataStringArrayContains(params, 'entities', e));
            for (const t of topics ?? []) filters.push(metadataStringArrayContains(params, 'topics', t));

            const scoped = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';
            const sql = `SELECT * FROM nodes WHERE workspace_id = $1`
                + ` AND ${matchClause}${scoped} ORDER BY "updatedAt" DESC, id ASC LIMIT ${params.add(SEARCH_SCAN_CAP)}::int`;
            const rows = await ctx.pool.query(sql, params.values);

            const fetched = rows.rows.map((row) => rowToLoreNode(fromPgNodeRow(row as PgRow)));
            const scanCapHit = fetched.length >= SEARCH_SCAN_CAP;
            // Exactness backstop, identical to the surreal/sqlite engines (cheap: rows already passed the SQL predicate).
            const candidates = (entities?.length || topics?.length)
                ? fetched.filter((n) => metaArraysContainAll(n.metadata, entities, topics))
                : fetched;
            if (scanCapHit) {
                console.warn(
                    `[PostgresGraph:search] scan cap hit (${SEARCH_SCAN_CAP}) for query "${query}" `
                    + `project=${project} — results may be incomplete. Narrow the query or raise LORE_SEARCH_SCAN_CAP.`,
                );
            }
            return { nodes: rankSearchResults(candidates, query, clampedLimit), scanCapHit };
        } catch (error) {
            throw pgError(`Failed to search for '${query}'`, 'search', error);
        }
    });
    if (signals) signals.scanCapHit = cached.scanCapHit;
    return cached.nodes;
}

/** listNodes — filtered enumeration, most-recently-updated first. Same SW-18 cap logic as the sqlite reads. */
export async function listNodes(
    ctx: PostgresReadCtx,
    type?: string,
    tag?: string,
    project: string = '*',
    ecosystem: string = '*',
    limit?: number,
    opts?: { unbounded?: boolean },
): Promise<LoreNode[]> {
    ctx.tally?.record('listNodes', shapeLimit(limit, opts?.unbounded));
    let effectiveLimit: number | undefined;
    if (opts?.unbounded) effectiveLimit = undefined;
    else if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
        effectiveLimit = Math.min(Math.floor(limit), 10_000);
    } else effectiveLimit = DEFAULT_LIST_NODES_CAP;

    const key = cacheKey('listNodes', ctx.workspaceId, ctx.readCache.epoch, {
        type: type ?? null, tag: tag ?? null, project, ecosystem, limit: effectiveLimit ?? 'all',
    });
    return ctx.readCache.memoize<LoreNode[]>(key, async () => {
        try {
            const params = new PgParams();
            params.add(ctx.workspaceId);
            const filters: string[] = [];
            if (type) { filters.push(`type = ${params.add(type)}`); }
            if (tag) filters.push(tagEquals(params, normalizeTag(tag)));
            if (project !== '*') { filters.push(`project = ${params.add(project)}`); }
            if (ecosystem !== '*') {
                filters.push(`(ecosystem = ${params.add(ecosystem)} OR ecosystem = '*' OR ecosystem = '')`);
            }
            // 3.27.1: `id ASC` tie-break. A reindex stamps thousands of rows with one
            // updatedAt, so `ORDER BY "updatedAt" DESC` alone leaves the order among ties
            // (and therefore any "first N" slice) to the planner. idx_nodes_updatedAt is
            // (workspace_id, "updatedAt" DESC, id), so this reads straight off the index.
            const where = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';
            let sql = `SELECT * FROM nodes WHERE workspace_id = $1${where}`
                + ' ORDER BY "updatedAt" DESC, id ASC';
            if (effectiveLimit !== undefined) { sql += ` LIMIT ${params.add(effectiveLimit)}::int`; }
            const res = await ctx.pool.query(sql, params.values);
            return res.rows.map((row) => rowToLoreNode(fromPgNodeRow(row as PgRow)));
        } catch (error) {
            throw pgError('Failed to list nodes', 'listNodes', error);
        }
    });
}

/**
 * listNodesAsOf - nodes valid at instant `atMs`, as ONE SQL predicate over the
 * real TIMESTAMPTZ columns (postgresAsOfSchema.ts; inclusive on both ends, NULL
 * bound = open), with keyset paging on the listNodes order (`updatedAt` DESC,
 * `id` ASC): `after` resumes strictly after that (updatedAt, id) pair. The
 * LIMIT applies AFTER the predicate, so a page is full whenever enough
 * matches exist. Uncached (a moving `at` would only churn the read cache).
 */
export async function listNodesAsOf(
    ctx: PostgresReadCtx,
    atMs: number,
    o: {
        type?: string; tag?: string; project?: string; ecosystem?: string;
        limit?: number; unbounded?: boolean; after?: { updatedAt: string; id: string };
    } = {},
): Promise<LoreNode[]> {
    const { type, tag, project = '*', ecosystem = '*', after } = o;
    let effectiveLimit: number | undefined;
    if (o.unbounded) effectiveLimit = undefined;
    else if (typeof o.limit === 'number' && Number.isFinite(o.limit) && o.limit > 0) {
        effectiveLimit = Math.min(Math.floor(o.limit), 10_000);
    } else effectiveLimit = DEFAULT_LIST_NODES_CAP;
    try {
        const params = new PgParams();
        params.add(ctx.workspaceId);
        const at = `${params.add(new Date(atMs).toISOString())}::timestamptz`;
        const filters: string[] = [
            `(valid_from_at IS NULL OR valid_from_at <= ${at})`,
            `(valid_until_at IS NULL OR valid_until_at >= ${at})`,
        ];
        if (type) filters.push(`type = ${params.add(type)}`);
        if (tag) filters.push(tagEquals(params, normalizeTag(tag)));
        if (project !== '*') filters.push(`project = ${params.add(project)}`);
        if (ecosystem !== '*') {
            filters.push(`(ecosystem = ${params.add(ecosystem)} OR ecosystem = '*' OR ecosystem = '')`);
        }
        if (after) {
            const u = params.add(after.updatedAt);
            filters.push(`("updatedAt" < ${u} OR ("updatedAt" = ${u} AND id > ${params.add(after.id)}))`);
        }
        let sql = `SELECT * FROM nodes WHERE workspace_id = $1 AND ${filters.join(' AND ')}`
            + ' ORDER BY "updatedAt" DESC, id ASC';
        if (effectiveLimit !== undefined) sql += ` LIMIT ${params.add(effectiveLimit)}::int`;
        const res = await ctx.pool.query(sql, params.values);
        return res.rows.map((row) => rowToLoreNode(fromPgNodeRow(row as PgRow)));
    } catch (error) {
        throw pgError('Failed to list nodes as of', 'listNodesAsOf', error);
    }
}

export { DEFAULT_LIST_NODES_CAP };
