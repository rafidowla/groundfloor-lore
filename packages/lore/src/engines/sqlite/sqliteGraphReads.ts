/**
 * sqlite/sqliteGraphReads.ts — read-side query surface for SqliteGraph.
 *
 * Mirrors `surreal/surrealGraphReads.ts` function-for-function: same cache
 * keys, same clamps, same caps, same contract semantics, SQL where that
 * file has SurrealQL. Reuses the SAME shared primitives that file does —
 * `rowToLoreNode`, `rankSearchResults`/`SEARCH_SCAN_CAP`/`keywordSearchTerms`
 * — so parity holds by construction, not by review, and the SAME
 * `graphShared/traverseBfs.ts` BFS core extracted in step 1a.
 */

import type { LoreNode, TraversalResult } from '../../providers/types.js';
import type { ReadCache } from '../cache.js';
import type { CallTally } from '../callTally.js';
import { shapeDepth, shapeLimit } from '../callTally.js';
import { cacheKey } from '../cache.js';
import { LoreGraphError } from '../loreGraphError.js';
import { DEFAULT_LIST_NODES_CAP, rowToLoreNode } from '../loreNodeRow.js';
import { rankSearchResults, SEARCH_SCAN_CAP, keywordSearchTerms } from '../searchRanking.js';
import { metaArraysContainAll } from '../metaArrayFilter.js';
import { runTraverseBfs, type FrontierEdgeCandidate } from '../graphShared/traverseBfs.js';
import type { SqliteDb } from './sqliteGraphSchema.js';
import { fromSqliteNodeRow } from './sqliteGraphRow.js';

/** Mirrors surrealGraphReads' TRAVERSE_NODE_CAP. */
const TRAVERSE_NODE_CAP = 10_000;
/** Mirrors surrealGraphReads' CHUNK_SIZE for id-list reads. */
const CHUNK_SIZE = 256;

export interface SqliteReadCtx {
    db: SqliteDb;
    readCache: ReadCache;
    workspaceId: string;
    tally?: CallTally;
    readGetNodesByIds?: (ids: string[]) => Promise<Map<string, LoreNode>>;
}

function sqliteError(message: string, operation: string, error: unknown): LoreGraphError {
    return new LoreGraphError(message, operation, error);
}

/** getNode — point lookup. Memoized on (workspace, epoch, id). */
export async function getNode(ctx: SqliteReadCtx, id: string): Promise<LoreNode | null> {
    ctx.tally?.record('getNode');
    const key = cacheKey('getNode', ctx.workspaceId, ctx.readCache.epoch, { id });
    return ctx.readCache.memoize<LoreNode | null>(key, async () => {
        try {
            const row = ctx.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
            if (!row) return null;
            return rowToLoreNode(fromSqliteNodeRow(row));
        } catch (error) {
            throw sqliteError(`Failed to get node '${id}'`, 'getNode', error);
        }
    });
}

/** getNodesByIds — batch hydrate. Same contract as surrealGraphReads: dedupe, drop empties, chunk, Map with missing ids absent. */
export async function getNodesByIds(ctx: SqliteReadCtx, ids: string[]): Promise<Map<string, LoreNode>> {
    ctx.tally?.record('getNodesByIds', shapeLimit(ids.length));
    const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)));
    if (unique.length === 0) return new Map();
    try {
        // Hydrate into a scratch map first (an `IN (...)` scan's row order is
        // not the requested order), then build the RETURNED map by walking
        // `unique` — so Map iteration order always follows the caller's
        // requested id order, matching the Surreal engine.
        const hydrated = new Map<string, LoreNode>();
        for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
            const chunk = unique.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map(() => '?').join(', ');
            const rows = ctx.db.prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`).all(...chunk) as Array<Record<string, unknown>>;
            for (const row of rows) {
                const node = rowToLoreNode(fromSqliteNodeRow(row));
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
        throw sqliteError(`Failed to batch-get ${unique.length} node(s)`, 'getNodesByIds', error);
    }
}

/**
 * fetchFrontierEdges — one frontier level's edges, both directions, grouped
 * by the frontier node reached FROM, each tagged with `direction`. The
 * SHARED `sortFrontierEdges` (graphShared/traverseBfs.ts) enforces
 * "outgoing before incoming, then (relation, other id)" from that tag — this
 * function's own row order is not load-bearing, so the two queries below
 * need no particular order of their own beyond determinism per call.
 */
async function fetchFrontierEdges(
    db: SqliteDb,
    frontier: string[],
): Promise<Map<string, FrontierEdgeCandidate[]>> {
    const merged = new Map<string, FrontierEdgeCandidate[]>();
    for (const id of frontier) merged.set(id, []);
    for (let i = 0; i < frontier.length; i += CHUNK_SIZE) {
        const chunk = frontier.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        const outRows = db.prepare(
            `SELECT source_id AS from_id, target_id AS to_id, relation FROM edges WHERE source_id IN (${placeholders})`,
        ).all(...chunk) as Array<{ from_id: string; to_id: string; relation: string }>;
        for (const r of outRows) merged.get(r.from_id)!.push({ to: r.to_id, relation: r.relation, direction: 'out' });
        const inRows = db.prepare(
            `SELECT target_id AS from_id, source_id AS to_id, relation FROM edges WHERE target_id IN (${placeholders})`,
        ).all(...chunk) as Array<{ from_id: string; to_id: string; relation: string }>;
        for (const r of inRows) merged.get(r.from_id)!.push({ to: r.to_id, relation: r.relation, direction: 'in' });
    }
    return merged;
}

/** traverse — memoized on (workspace, epoch, nodeId, clampedDepth). */
export async function traverse(ctx: SqliteReadCtx, nodeId: string, maxDepth: number = 2): Promise<TraversalResult[]> {
    ctx.tally?.record('traverse', shapeDepth(Math.min(Math.max(Math.trunc(maxDepth), 1), 5)));
    const memoKey = cacheKey('traverse', ctx.workspaceId, ctx.readCache.epoch, {
        nodeId,
        maxDepth: Math.min(Math.max(Math.trunc(maxDepth), 1), 5),
    });
    return ctx.readCache.memoize<TraversalResult[]>(memoKey, () => traverseUncached(ctx, nodeId, maxDepth));
}

async function traverseUncached(ctx: SqliteReadCtx, nodeId: string, maxDepth: number): Promise<TraversalResult[]> {
    const clampedDepth = Math.min(Math.max(Math.trunc(maxDepth), 1), 5);
    if (!Number.isInteger(clampedDepth) || clampedDepth < 1 || clampedDepth > 5) {
        throw new LoreGraphError(`Invalid traversal depth ${maxDepth}`, 'traverse', null);
    }
    try {
        const { steps, capped } = await runTraverseBfs(
            nodeId,
            clampedDepth,
            TRAVERSE_NODE_CAP,
            (frontier) => fetchFrontierEdges(ctx.db, frontier),
        );
        if (capped) {
            console.error(
                `[SqliteGraph] traverse from '${nodeId}' hit the ${TRAVERSE_NODE_CAP}-node cap `
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
        throw sqliteError(`Failed to traverse from '${nodeId}'`, 'traverse', error);
    }
}

export { fetchFrontierEdges as sqliteFetchFrontierEdges };

/**
 * search — keyword search, same contract as `surrealGraphReads.search`:
 * candidate predicate is `lore_lower(label|content)` substring OR exact tag
 * membership, AND-of-significant-terms, scoped by project/ecosystem,
 * `ORDER BY updatedAt DESC, id ASC LIMIT SEARCH_SCAN_CAP` pre-order, then
 * the SHARED `rankSearchResults`.
 */
export async function search(
    ctx: SqliteReadCtx,
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

            // Two INDEPENDENT param lists, built in the SAME order their
            // clauses appear in the SQL text below (matchClause first, then
            // the scope filters) — positional `?` placeholders bind by
            // array order, so a single shared `params` array that filters
            // push into BEFORE the match-clause params are computed (scope
            // is decided first, above the term loop) silently misaligns the
            // moment both a scope filter AND search terms are present. Kept
            // as two lists and concatenated in SQL order, rather than one
            // list callers must remember to push into in the right spot.
            const matchParams: unknown[] = [];
            const termClauses: string[] = [];
            for (const t of terms) {
                termClauses.push(
                    `(instr(lore_lower(label), ?) > 0 OR instr(lore_lower(content), ?) > 0 `
                    + `OR EXISTS (SELECT 1 FROM json_each(nodes.tags) je WHERE je.value = ?))`,
                );
                matchParams.push(t, t, t);
            }
            const termMatchClause = terms.length > 0 ? termClauses.join(' AND ') : '1';
            let matchClause: string;
            if (terms.length > 0) {
                matchClause = `(EXISTS (SELECT 1 FROM json_each(nodes.tags) je2 WHERE je2.value = ?) OR (${termMatchClause}))`;
                matchParams.unshift(q);
            } else {
                matchClause = termMatchClause;
            }

            const filters: string[] = [];
            const scopeParams: unknown[] = [];
            if (project !== '*') { filters.push('project = ?'); scopeParams.push(project); }
            if (ecosystem !== '*') {
                filters.push(`(ecosystem = ? OR ecosystem = '*' OR ecosystem = '')`);
                scopeParams.push(ecosystem);
            }
            if (excludeHidden) {
                filters.push(`(status != 'archived')`);
                filters.push(`(supersededAt = '')`);
            }
            if (types && types.length > 0) {
                filters.push(`type IN (${types.map(() => '?').join(', ')})`);
                scopeParams.push(...types);
            }
            // E2 — entities/topics pushdown into the keyword leg: one
            // `json_each` EXISTS per requested value, ANDed (ALL-of, same as
            // retrieveFilters.ts passesEntitiesTopicsProject). json_each()
            // THROWS "malformed JSON" on an invalid document (e.g. metadata
            // ''), which would fail the whole search, and SQLite may reorder
            // top-level AND terms — so the guard is a CASE, whose WHEN arms
            // are evaluated in order. The json_type check keeps a scalar
            // `"entities": "Acme"` from matching (json_each over a scalar
            // yields that scalar); `type = 'text'` keeps only string elements.
            const metaExists = (pathKey: '$.entities' | '$.topics'): string =>
                'CASE WHEN json_valid(nodes.metadata) IS NOT 1 THEN 0'
                + ` WHEN json_type(nodes.metadata, '${pathKey}') IS NOT 'array' THEN 0`
                + ` ELSE EXISTS (SELECT 1 FROM json_each(nodes.metadata, '${pathKey}') je WHERE je.type = 'text' AND je.value = ?) END`;
            for (const e of entities ?? []) {
                filters.push(metaExists('$.entities'));
                scopeParams.push(e);
            }
            for (const t of topics ?? []) {
                filters.push(metaExists('$.topics'));
                scopeParams.push(t);
            }

            const scoped = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';
            const sql = `SELECT * FROM nodes WHERE ${matchClause}${scoped} ORDER BY updatedAt DESC, id ASC LIMIT ?`;
            const rows = ctx.db.prepare(sql).all(...matchParams, ...scopeParams, SEARCH_SCAN_CAP) as Array<Record<string, unknown>>;

            const fetched = rows.map((row) => rowToLoreNode(fromSqliteNodeRow(row)));
            const scanCapHit = fetched.length >= SEARCH_SCAN_CAP;
            // Exactness backstop, identical to the surreal engine (cheap: rows
            // already passed the SQL predicate).
            const candidates = (entities?.length || topics?.length)
                ? fetched.filter((n) => metaArraysContainAll(n.metadata, entities, topics))
                : fetched;
            if (scanCapHit) {
                console.warn(
                    `[SqliteGraph:search] scan cap hit (${SEARCH_SCAN_CAP}) for query "${query}" `
                    + `project=${project} — results may be incomplete. Narrow the query or raise LORE_SEARCH_SCAN_CAP.`,
                );
            }
            return { nodes: rankSearchResults(candidates, query, clampedLimit), scanCapHit };
        } catch (error) {
            throw sqliteError(`Failed to search for '${query}'`, 'search', error);
        }
    });
    if (signals) signals.scanCapHit = cached.scanCapHit;
    return cached.nodes;
}

/** listNodes — filtered enumeration, most-recently-updated first. Same SW-18 cap logic as surrealGraphReads.listNodes. */
export async function listNodes(
    ctx: SqliteReadCtx,
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
            let sql = `SELECT * FROM nodes${where} ORDER BY updatedAt DESC`;
            if (effectiveLimit !== undefined) { sql += ' LIMIT ?'; params.push(effectiveLimit); }
            const rows = ctx.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
            return rows.map((row) => rowToLoreNode(fromSqliteNodeRow(row)));
        } catch (error) {
            throw sqliteError('Failed to list nodes', 'listNodes', error);
        }
    });
}

export { DEFAULT_LIST_NODES_CAP };
