/**
 * surrealGraphReads.ts — read-side query surface for SurrealGraph.
 *
 * Deliberate mirror of engines/localGraphReads.ts: same function set
 * (getNode / getNodesByIds / traverse / search / listNodes), same cache keys,
 * same clamps, same caps, same contract semantics — with SurrealQL where that
 * file has Cypher. Phase 2 asserts the two agree on a fixture; keeping the
 * structures aligned is what makes that assertion meaningful rather than a
 * coincidence.
 *
 * Two things are SHARED outright rather than re-implemented, so parity holds
 * by construction:
 *   - `rowToLoreNode` (localGraphReads.ts) — the row → LoreNode field mapper.
 *     The ArcadeDB engine already reuses it the same way
 *     (engines/arcade/arcadeGraphStore.ts). Stored field names follow a
 *     shared column-naming convention precisely so the mapper needs no translation beyond unwrapping
 *     the record id.
 *   - `rankSearchResults` + `SEARCH_SCAN_CAP` (searchRanking.ts) — the single
 *     source of truth for keyword-search ordering across every backend.
 *
 * Injection posture: every caller value reaches SurrealDB as a bound variable
 * (`$q`, `$ids`, …) or a bound `RecordId` object. Query text is assembled only
 * from fixed fragments and integers this module clamped itself. No escape
 * helper exists here, by design — see surrealRecordId.ts.
 */

import type { LoreNode, TraversalResult } from '../../providers/types.js';
import type { ReadCache } from '../cache.js';
import type { CallTally } from '../callTally.js';
import { shapeDepth, shapeLimit } from '../callTally.js';
import { cacheKey } from '../cache.js';
import { LoreGraphError } from '../loreGraphError.js';
import type { SurrealFeatures } from './surrealConnection.js';
import { redactSurrealLog, surrealError } from './surrealError.js';
import { DEFAULT_LIST_NODES_CAP, rowToLoreNode } from '../loreNodeRow.js';
import { rankSearchResults, SEARCH_SCAN_CAP, keywordSearchTerms } from '../searchRanking.js';
import { metaArrayContainsPattern, metaArraysContainAll } from '../metaArrayFilter.js';
import { EDGE_TABLE, NODE_TABLE, normalizeRow, ridToId, toNodeRid } from './surrealRecordId.js';
import { runTraverseBfs, type FrontierEdgeCandidate } from '../graphShared/traverseBfs.js';

/**
 * Runs one SurrealQL statement and returns its rows. Bound from SurrealGraph
 * so these functions never touch the connection or its lifecycle.
 */
export type SurrealQuery = (
    sql: string,
    vars?: Record<string, unknown>,
) => Promise<Array<Record<string, unknown>>>;

/** Same shape as localGraphReads.ReadCtx, with a SurrealQL runner. */
export interface SurrealReadCtx {
    query: SurrealQuery;
    readCache: ReadCache;
    workspaceId: string;
    /**
     * Which optional accelerations this connection actually applied. Resolved
     * once at open, not read from the environment per query — a read path must
     * never assume an index exists that `applySurrealSchema` did not define.
     */
    features?: SurrealFeatures;
    /** Per-instance operation counter; see engines/callTally.ts. */
    tally?: CallTally;
    /**
     * Batch node hydration, injected so `surrealGraphDirected` can reuse it
     * without importing this module's internals back the other way (which
     * would be circular).
     */
    readGetNodesByIds?: (ids: string[]) => Promise<Map<string, LoreNode>>;
}

/**
 * Chunk size for id-list reads. Matches localGraphReads' SW-16 constant.
 * SurrealDB binds the whole array as one CBOR value so it has no prepared-
 * parameter ceiling of its own, but keeping the chunking identical bounds peak
 * row memory the same way on both engines.
 */
const CHUNK_SIZE = 256;

/** Mirrors localGraphReads' TRAVERSE_NODE_CAP — bounds a high-degree BFS. */
const TRAVERSE_NODE_CAP = 10_000;

/** getNode — point lookup. Memoized on (workspace, epoch, id). */
export async function getNode(ctx: SurrealReadCtx, id: string): Promise<LoreNode | null> {
    ctx.tally?.record('getNode');
    const key = cacheKey('getNode', ctx.workspaceId, ctx.readCache.epoch, { id });
    return ctx.readCache.memoize<LoreNode | null>(key, async () => {
        try {
            const rows = await ctx.query('SELECT * FROM $rid', { rid: toNodeRid(id, 'getNode') });
            if (rows.length === 0) return null;
            return rowToLoreNode(normalizeRow(rows[0]!));
        } catch (error) {
            throw surrealError(`Failed to get node '${id}'`, 'getNode', error);
        }
    });
}

/**
 * getNodesByIds — batch hydrate. Dedupes + drops empties, chunks, returns a
 * Map with missing ids simply absent (no nulls) and no filtering — the same
 * contract localGraphReads documents.
 *
 * `SELECT * FROM $ids` fetches the records DIRECTLY by id.
 * `SELECT * FROM node WHERE id IN $ids` is the obvious spelling and is a FULL
 * TABLE SCAN — measured on an 8 000-node store: 7.915 ms/op scanning vs
 * 0.150 ms/op fetching, and the scan cost grows with the corpus while the
 * fetch does not. Recall hydrates a batch per seed per workspace, so the scan
 * form turns a hot path quadratic.
 */
export async function getNodesByIds(ctx: SurrealReadCtx, ids: string[]): Promise<Map<string, LoreNode>> {
    ctx.tally?.record('getNodesByIds', shapeLimit(ids.length));
    const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)));
    if (unique.length === 0) return new Map();
    try {
        // Hydrate into a scratch map first (chunk fetch order is not the
        // requested order), then build the RETURNED map by walking `unique`
        // — so Map iteration order always follows the caller's requested id
        // order, on every engine, regardless of fetch/row order.
        const hydrated = new Map<string, LoreNode>();
        for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
            const chunk = unique.slice(i, i + CHUNK_SIZE);
            const rows = await ctx.query('SELECT * FROM $ids', {
                ids: chunk.map((id) => toNodeRid(id, 'getNodesByIds')),
            });
            for (const row of rows) {
                // A record fetch yields one slot per requested id; absent
                // records come back empty and must not become phantom nodes.
                if (row['id'] == null) continue;
                const node = rowToLoreNode(normalizeRow(row));
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
        throw surrealError(`Failed to batch-get ${unique.length} node(s)`, 'getNodesByIds', error);
    }
}

/** traverse — memoized on (workspace, epoch, nodeId, clampedDepth). */
export async function traverse(
    ctx: SurrealReadCtx,
    nodeId: string,
    maxDepth: number = 2,
): Promise<TraversalResult[]> {
    ctx.tally?.record('traverse', shapeDepth(Math.min(Math.max(Math.trunc(maxDepth), 1), 5)));
    const memoKey = cacheKey('traverse', ctx.workspaceId, ctx.readCache.epoch, {
        nodeId,
        maxDepth: Math.min(Math.max(Math.trunc(maxDepth), 1), 5),
    });
    return ctx.readCache.memoize<TraversalResult[]>(memoKey, () => traverseUncached(ctx, nodeId, maxDepth));
}

/** One frontier hop: the edges touching a set of nodes, either direction. */
interface FrontierEdge extends FrontierEdgeCandidate {
    /** The frontier node this edge was reached FROM. */
    from: string;
}

async function traverseUncached(
    ctx: SurrealReadCtx,
    nodeId: string,
    maxDepth: number,
): Promise<TraversalResult[]> {
    const clampedDepth = Math.min(Math.max(Math.trunc(maxDepth), 1), 5);
    if (!Number.isInteger(clampedDepth) || clampedDepth < 1 || clampedDepth > 5) {
        throw new LoreGraphError(`Invalid traversal depth ${maxDepth}`, 'traverse', null);
    }

    try {
        // ONE query per depth level, not one per frontier node: SurrealDB
        // matches the whole frontier in a single edge scan. The prior local
        // graph engine issued 2 queries per frontier node because it couldn't
        // parse the recursive form — the round-trip count differs, the
        // observable result does not. The walk itself (visited-set
        // bookkeeping, node-cap enforcement, discovery sub-order) is the
        // SHARED `runTraverseBfs` — see graphShared/traverseBfs.ts.
        const { steps, capped } = await runTraverseBfs(
            nodeId,
            clampedDepth,
            TRAVERSE_NODE_CAP,
            (frontier) => fetchFrontierEdges(ctx, frontier),
        );
        if (capped) {
            console.error(redactSurrealLog(
                `[SurrealGraph] traverse from '${nodeId}' hit the ${TRAVERSE_NODE_CAP}-node cap `
                + '— results truncated (high-degree subgraph)',
            ));
        }

        // Hydrate every reached node in ONE batched read. LocalGraph hydrates
        // inline from its traversal projection; batching here gives the FULL
        // node shape (the projection LocalGraph uses is a documented subset —
        // see the traverse RETURN alias list), so a Surreal traversal result
        // is never *less* hydrated than a search result.
        const hydrated = await getNodesByIds(ctx, steps.map((s) => s.id));
        const results: TraversalResult[] = steps.map((s) => ({
            node: hydrated.get(s.id) ?? ({ id: s.id } as LoreNode),
            depth: s.depth,
            relation: s.relation,
        }));
        return results.sort((a, b) => a.depth - b.depth);
    } catch (error) {
        throw surrealError(`Failed to traverse from '${nodeId}'`, 'traverse', error);
    }
}

/**
 * fetchFrontierEdges — every edge with an endpoint in `frontier`, grouped by
 * the frontier node it was reached from.
 *
 * Uses SurrealDB's GRAPH projection (`->edge` / `<-edge` off a bound record
 * array), NOT a predicate over the edge table. Both return the same rows; the
 * difference is that the graph form walks the adjacency structure while
 * `WHERE in IN $ids OR out IN $ids` scans every edge in the workspace on every
 * hop. Measured on a 4 000-node / 8 000-edge store: 16.085 ms/op scanning vs
 * 0.205 ms/op via the graph projection — 78×, and the gap widens linearly with
 * corpus size, so at real scale the scan form is the difference between a
 * usable traversal and an unusable one.
 *
 * Outgoing edges are grouped before incoming ones for each frontier node,
 * matching LocalGraph's `[...outRows, ...inRows]` discovery order.
 */
async function fetchFrontierEdges(
    ctx: SurrealReadCtx,
    frontier: string[],
): Promise<Map<string, FrontierEdge[]>> {
    const merged = new Map<string, FrontierEdge[]>();
    for (let i = 0; i < frontier.length; i += CHUNK_SIZE) {
        const chunk = frontier.slice(i, i + CHUNK_SIZE);
        const rows = await ctx.query(
            `SELECT id, ->${EDGE_TABLE}.{ relation: relation, other: out } AS outgoing,`
            + ` <-${EDGE_TABLE}.{ relation: relation, other: in } AS incoming`
            + ' FROM $ids',
            { ids: chunk.map((id) => toNodeRid(id, 'traverse')) },
        );
        for (const row of rows) {
            const from = ridToId(row['id']);
            const edges: FrontierEdge[] = [];
            // Tagged with direction so the SHARED `sortFrontierEdges`
            // (graphShared/traverseBfs.ts) can enforce "outgoing before
            // incoming, then (relation, other id)" regardless of what order
            // this query happens to return rows in — this loop's own order
            // is no longer load-bearing.
            for (const [key, direction] of [['outgoing', 'out'], ['incoming', 'in']] as const) {
                const list = row[key];
                if (!Array.isArray(list)) continue;
                for (const entry of list) {
                    const e = entry as { relation?: unknown; other?: unknown };
                    const to = ridToId(e.other);
                    if (!to) continue;
                    edges.push({
                        from,
                        to,
                        direction,
                        relation: typeof e.relation === 'string' ? e.relation : 'related_to',
                    });
                }
            }
            merged.set(from, edges);
        }
    }
    // Frontier nodes with no edges get an empty list rather than being absent,
    // so the caller's `?? []` is never load-bearing.
    for (const id of frontier) if (!merged.has(id)) merged.set(id, []);
    return merged;
}

/**
 * ftsCandidates — the candidate set under the opt-in full-text path.
 *
 * TWO queries, merged here, rather than one `label @1@ $q OR content @2@ $q OR
 * $q IN tags`. The single-statement form measures WORSE than the plain
 * substring scan it replaces (60.3 ms vs 93.4 ms at 20k, against 19.2 ms for
 * the FTS half alone): one un-indexed `IN tags` disjunct forces a full scan
 * and the indexes stop being used at all. Split, the FTS half stays indexed
 * and only the tag half scans — 46.9 ms measured.
 *
 * Tag matching is UNCHANGED (exact membership). Only label/content matching
 * moves from substring to whole-word, which is the documented trade.
 *
 * De-duplication is by id and keeps first-seen order; the shared ranker
 * re-orders afterwards, so the merge order is not load-bearing.
 */
async function ftsCandidates(
    ctx: SurrealReadCtx,
    scoped: string,
    tail: string,
    vars: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
    const [textRows, tagRows] = await Promise.all([
        ctx.query(
            `SELECT * FROM ${NODE_TABLE} WHERE (label @1@ $q OR content @2@ $q)${scoped}${tail}`,
            vars,
        ),
        ctx.query(`SELECT * FROM ${NODE_TABLE} WHERE $q IN tags${scoped}${tail}`, vars),
    ]);
    const seen = new Set<string>();
    const merged: Array<Record<string, unknown>> = [];
    for (const row of [...textRows, ...tagRows]) {
        const id = ridToId(row['id']);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push(row);
    }
    return merged;
}

/**
 * search — keyword search over label/content/tags, scoped by project/ecosystem,
 * ordered by the SHARED ranker. Limit clamped 1..1000; candidate scan capped at
 * SEARCH_SCAN_CAP with the same `ORDER BY updatedAt DESC, id ASC` pre-order
 * LocalGraph uses, so the retained window is the same rows.
 *
 * Match surface is intentionally identical to LocalGraph's post-P15 behaviour,
 * including its one documented gap: tags match by EXACT membership
 * (`$q IN tags`), not substring. Cloud substring-matches tags; local does not.
 * Matching cloud here would silently break Phase 2's local-vs-Surreal set
 * parity, so this engine sides with the engine it is being compared against.
 */
export async function search(
    ctx: SurrealReadCtx,
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
        q: query.toLowerCase(),
        limit: clampedLimit,
        project,
        ecosystem,
        excludeHidden,
        types,
        entities,
        topics,
    });
    const cached = await ctx.readCache.memoize<{ nodes: LoreNode[]; scanCapHit: boolean }>(key, async () => {
        try {
            // $q is still used by the opt-in FTS candidate path below.
            const vars: Record<string, unknown> = { q: query.toLowerCase(), scanCap: SEARCH_SCAN_CAP };
            // AND-of-significant-terms keyword match (see keywordSearchTerms
            // in searchRanking.ts): a multi-word query whose terms are all
            // present but scattered still matches — the previous whole-phrase
            // string::contains silently returned nothing, which also starved
            // recall's keyword fallback/supplement paths. Same term list the
            // shared ranker gates on, so the DB candidate set and the in-JS
            // match filter cannot disagree.
            const terms = keywordSearchTerms(query);
            const filters: string[] = [];
            if (project !== '*') {
                filters.push('project = $project');
                vars['project'] = project;
            }
            if (ecosystem !== '*') {
                // '*'/''/NONE = unscoped row (core/ecosystemMatch.ts).
                filters.push("(ecosystem = $ecosystem OR ecosystem = '*' OR ecosystem = '' OR ecosystem = NONE)");
                vars['ecosystem'] = ecosystem;
            }
            if (excludeHidden) {
                filters.push('(status = NONE OR status != "archived")');
                filters.push('(supersededAt = NONE OR supersededAt = "")');
            }
            if (types && types.length > 0) {
                filters.push('type IN $types');
                vars['types'] = types;
            }
            // E2 — entities/topics pushdown into the keyword leg. `metadata`
            // is stored as a JSON STRING and this SurrealDB build has no
            // JSON-string decode function (parse::json, encoding::json::decode,
            // type::object and <object> are all rejected), so the predicate is
            // a regex over the encoded string — see metaArrayFilter.ts for the
            // pattern and why it can over- but never under-match. The
            // `type::is_string` guard comes first: string::matches() THROWS on
            // NONE/NULL/non-string, and nodes written without metadata store
            // NONE, which would fail the whole search. Values are bound as
            // `$eN` / `$tpN`, never interpolated. Exactness is restored on the
            // fetched rows below (metaArraysContainAll) before ranking.
            // The plain `string::contains` on the JSON-encoded value is
            // implied by the regex (same needle) and rejects most rows before
            // the regex runs.
            entities?.forEach((e, i) => {
                filters.push(`(type::is_string(metadata) AND string::contains(metadata, $en${i}) AND string::matches(metadata, $e${i}))`);
                vars[`en${i}`] = JSON.stringify(e);
                vars[`e${i}`] = metaArrayContainsPattern('entities', e);
            });
            topics?.forEach((t, i) => {
                filters.push(`(type::is_string(metadata) AND string::contains(metadata, $tpn${i}) AND string::matches(metadata, $tp${i}))`);
                vars[`tpn${i}`] = JSON.stringify(t);
                vars[`tp${i}`] = metaArrayContainsPattern('topics', t);
            });
            const scoped = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';
            const tail = ' ORDER BY updatedAt DESC, id ASC LIMIT $scanCap';

            const termMatchClause = terms.length > 0
                ? terms.map((t, i) => {
                    vars[`t${i}`] = t;
                    // Tag branch stays EXACT membership ($tN IN tags), the
                    // documented local-vs-cloud gap — see the search()
                    // docstring above. `content ?? ''` guards a NONE column
                    // on a pre-existing row written before nodeService.ts /
                    // toNodeDocument started coercing missing content to ''
                    // (2026-08-21) — string::lowercase(NONE) throws and takes
                    // down search for the WHOLE workspace, not just that row.
                    return `(string::contains(string::lowercase(label ?? ''), $t${i})`
                        + ` OR string::contains(string::lowercase(content ?? ''), $t${i})`
                        + ` OR $t${i} IN tags)`;
                }).join(' AND ')
                : 'true';
            // Tags are exact-match fields. A punctuation-bearing tag such as
            // "q1-7-xsect" must therefore match that exact query before the
            // keyword tokenizer splits it into q1/7/xsect terms.
            const matchClause = terms.length > 0
                ? `($q IN tags OR (${termMatchClause}))`
                : termMatchClause;

            // Candidate set. Ranking is the SAME shared function either way —
            // only WHICH rows become candidates differs, which is what keeps
            // the FTS path's ordering identical to the default path's.
            const rows = ctx.features?.fts
                ? await ftsCandidates(ctx, scoped, tail, vars)
                : await ctx.query(
                    `SELECT * FROM ${NODE_TABLE} WHERE ${matchClause}${scoped}${tail}`,
                    vars,
                );

            const fetched = rows.map((row) => rowToLoreNode(normalizeRow(row)));
            const scanCapHit = fetched.length >= SEARCH_SCAN_CAP;
            const candidates = (entities?.length || topics?.length)
                ? fetched.filter((n) => metaArraysContainAll(n.metadata, entities, topics))
                : fetched;
            if (scanCapHit) {
                // The query text is caller content — the double quotes make
                // redactError hash it, so operators still see WHICH query
                // (stable tag) without the terms landing in a log file.
                console.warn(redactSurrealLog(
                    `[SurrealGraph:search] scan cap hit (${SEARCH_SCAN_CAP}) for query "${query}" `
                    + `project=${project} — results may be incomplete (matches older than the `
                    + `${SEARCH_SCAN_CAP} most-recently-updated were dropped before ranking). `
                    + 'Narrow the query or raise LORE_SEARCH_SCAN_CAP.',
                ));
            }
            return { nodes: rankSearchResults(candidates, query, clampedLimit), scanCapHit };
        } catch (error) {
            throw surrealError(`Failed to search for '${query}'`, 'search', error);
        }
    });
    if (signals) signals.scanCapHit = cached.scanCapHit;
    return cached.nodes;
}

/**
 * listNodes — filtered enumeration, most-recently-updated first. Applies the
 * SW-18 cap logic verbatim: `{ unbounded: true }` opts out, an explicit limit
 * is clamped to 10k, otherwise DEFAULT_LIST_NODES_CAP.
 */
export async function listNodes(
    ctx: SurrealReadCtx,
    type?: string,
    tag?: string,
    project: string = '*',
    ecosystem: string = '*',
    limit?: number,
    opts?: { unbounded?: boolean },
): Promise<LoreNode[]> {
    ctx.tally?.record('listNodes', shapeLimit(limit, opts?.unbounded));
    let effectiveLimit: number | undefined;
    if (opts?.unbounded) {
        effectiveLimit = undefined;
    } else if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
        effectiveLimit = Math.min(Math.floor(limit), 10_000);
    } else {
        effectiveLimit = DEFAULT_LIST_NODES_CAP;
    }
    const key = cacheKey('listNodes', ctx.workspaceId, ctx.readCache.epoch, {
        type: type ?? null,
        tag: tag ?? null,
        project,
        ecosystem,
        limit: effectiveLimit ?? 'all',
    });
    return ctx.readCache.memoize<LoreNode[]>(key, async () => {
        try {
            const vars: Record<string, unknown> = {};
            let sql = `SELECT * FROM ${NODE_TABLE} WHERE true`;
            if (type) {
                sql += ' AND type = $type';
                vars['type'] = type;
            }
            if (tag) {
                // Exact membership; tags are lowercased on store, so fold here
                // too. Same model as LocalGraph and every other endpoint.
                sql += ' AND $tag IN tags';
                vars['tag'] = tag.toLowerCase();
            }
            if (project !== '*') {
                sql += ' AND project = $project';
                vars['project'] = project;
            }
            if (ecosystem !== '*') {
                // '*'/''/NONE = unscoped row (core/ecosystemMatch.ts).
                sql += " AND (ecosystem = $ecosystem OR ecosystem = '*' OR ecosystem = '' OR ecosystem = NONE)";
                vars['ecosystem'] = ecosystem;
            }
            sql += ' ORDER BY updatedAt DESC';
            if (effectiveLimit !== undefined) {
                sql += ' LIMIT $limit';
                vars['limit'] = effectiveLimit;
            }
            const rows = await ctx.query(sql, vars);
            return rows.map((row) => rowToLoreNode(normalizeRow(row)));
        } catch (error) {
            throw surrealError('Failed to list nodes', 'listNodes', error);
        }
    });
}

// Re-exported from the shared node-row module rather than redeclared: a second copy
// of this cap would be a silent parity fork the first time one moved.
export { DEFAULT_LIST_NODES_CAP };
