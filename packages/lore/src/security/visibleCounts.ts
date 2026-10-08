/**
 * visibleCounts.ts — visible-only node / edge counts for a BOUND non-operator.
 *
 * Contract: aggregate numbers shown to an app token must be what that token
 * could count by reading its own rows — never totals that include rows it
 * cannot see. Three kinds of caller (see countAudience):
 *   - unbound  → 'raw': callers keep their original code path byte-for-byte,
 *                zero extra lookups (this module is never entered).
 *   - operator → 'raw': bound, but a daemon operator (exportAllowedForCurrentActor):
 *                true totals, response unchanged.
 *   - otherwise → 'visible': use the helpers below.
 *
 * Visibility is decided ONLY by actorRowVisibility() (security/scopeFilter.ts).
 * Every scan is bounded on every engine: at most `cap` (default
 * SCOPE_PAGE_FILL_MAX_SCAN) raw rows per kind. When more raw rows exist the
 * returned numbers are a LOWER BOUND (`lowerBound: true`); callers label the
 * response `countScope: 'visible'` + `countsLowerBound: true` and render the
 * number as `<n>+` (formatVisibleCount).
 *
 * Paging: `bulkListProjected` (sqlite, surreal) when the engine has it and no
 * type filter is needed; otherwise `bulkList` (all engines, SQL-side type
 * filter, rows carry top-level `security_scopes` / `language`). Never
 * `listNodes`.
 *
 * Callers must have short-circuited on countAudience() — these helpers assume a
 * bound actor and throw nothing for an unbound one (every row is "visible").
 */

import type { LoreEdge } from '../providers/types.js';
import type { LoreGraphHandle } from '../storage/loreStorageClient.js';
import { actorRowVisibility } from './scopeFilter.js';
import { getCurrentActorScopes } from './actorContext.js';
import { exportAllowedForCurrentActor } from './exportGate.js';
import { SCOPE_PAGE_FILL_MAX_SCAN } from './scopePageFill.js';

/** Rows per engine round trip. */
const PAGE_SIZE = 1000;
/** Endpoint ids hydrated per getNodesByIds call. */
const HYDRATE_CHUNK = 500;

/**
 * 'raw' for an unbound caller or a daemon operator (true totals, no new fields);
 * 'visible' for a bound non-operator. Unbound does nothing else.
 */
export function countAudience(): 'raw' | 'visible' {
    if (getCurrentActorScopes() === undefined) return 'raw';
    return exportAllowedForCurrentActor() ? 'raw' : 'visible';
}

/** Graph surface the node scans need; satisfied by every LoreGraphHandle. */
export type VisibleCountGraph = Pick<LoreGraphHandle, 'bulkList'> & {
    bulkListProjected?: (
        project: string,
        columns: readonly string[],
        limit: number,
        cursor: { updatedAt: string; id: string } | null,
    ) => Promise<{ rows: Array<Record<string, unknown>>; nextCursor: { updatedAt: string; id: string } | null }>;
};

/** Graph surface the edge scans need. */
export type VisibleEdgeGraph = Pick<LoreGraphHandle, 'queryEdges' | 'getNodesByIds'>;

export interface VisibleNodeCountOptions {
    /** Count only nodes of this type. */
    type?: string;
    /** Max raw rows to scan. Default SCOPE_PAGE_FILL_MAX_SCAN; tests lower it. */
    cap?: number;
    byType?: boolean;
    byLanguage?: boolean;
}

export interface VisibleNodeCounts {
    nodeCount: number;
    typeBreakdown?: Record<string, number>;
    languageBreakdown?: Record<string, number>;
    /** Raw rows examined (visible or not). */
    scanned: number;
    /** True when raw rows remained beyond the cap: the numbers are a lower bound. */
    lowerBound: boolean;
}

/** Walk raw node rows (id, type, language, security_scopes) up to the cap. */
async function scanNodeRows(
    graph: VisibleCountGraph,
    type: string | undefined,
    cap: number,
    needLanguage: boolean,
    onRow: (row: Record<string, unknown>) => void,
): Promise<{ scanned: number; lowerBound: boolean }> {
    let scanned = 0;
    let cursor: { updatedAt: string; id: string } | null = null;
    // bulkList rows do not carry `language` on every engine; the projection does.
    // A projected scan cannot filter by type in SQL, so it filters client-side
    // (and `scanned` then counts every row of the workspace, not just that type).
    const projected = typeof graph.bulkListProjected === 'function' && (type === undefined || needLanguage);
    for (;;) {
        const room = cap - scanned;
        if (room <= 0) return { scanned, lowerBound: true };
        const limit = Math.min(PAGE_SIZE, room);
        let rows: Array<Record<string, unknown>>;
        let next: { updatedAt: string; id: string } | null;
        if (projected) {
            const page = await graph.bulkListProjected!('*', ['type', 'language', 'security_scopes'], limit, cursor);
            rows = page.rows;
            next = page.nextCursor;
        } else {
            const page = await graph.bulkList({ ...(type !== undefined ? { types: [type] } : {}), limit, cursor });
            rows = page.nodes;
            next = page.hasMore ? page.nextCursor : null;
        }
        for (const row of rows) {
            if (projected && type !== undefined && row['type'] !== type) continue;
            onRow(row);
        }
        scanned += rows.length;
        if (!next || rows.length === 0) return { scanned, lowerBound: false };
        cursor = next;
        // Cap reached exactly on a page boundary with rows remaining: the loop
        // top reports the lower bound; if the page was the last one `next` is
        // null and the count is exact.
    }
}

/**
 * Visit every VISIBLE node row within the cap (rows are the engine's raw
 * records: id, type, label, metadata, language, security_scopes, ...). The
 * building block for counts, per-type breakdowns and visible-row samples.
 */
export async function forEachVisibleNode(
    graph: VisibleCountGraph,
    opts: { type?: string; cap?: number; byLanguage?: boolean },
    onRow: (row: Record<string, unknown>) => void,
): Promise<{ scanned: number; lowerBound: boolean }> {
    const visible = actorRowVisibility();
    return scanNodeRows(graph, opts.type, opts.cap ?? SCOPE_PAGE_FILL_MAX_SCAN, opts.byLanguage === true, (row) => {
        if (visible && !visible(row as { security_scopes?: unknown })) return;
        onRow(row);
    });
}

/**
 * Visible-only node count, optionally per type / per language. Language
 * breakdown keys follow the engine convention: empty / null language → 'null'.
 * The language breakdown needs an engine that returns `language` (the
 * bulkListProjected engines do); elsewhere every row falls under 'null'.
 */
export async function countVisibleNodes(
    graph: VisibleCountGraph,
    opts: VisibleNodeCountOptions = {},
): Promise<VisibleNodeCounts> {
    let nodeCount = 0;
    const typeBreakdown: Record<string, number> = {};
    const languageBreakdown: Record<string, number> = {};
    const { scanned, lowerBound } = await forEachVisibleNode(graph, opts, (row) => {
        nodeCount++;
        if (opts.byType) {
            const t = String(row['type'] ?? '');
            typeBreakdown[t] = (typeBreakdown[t] ?? 0) + 1;
        }
        if (opts.byLanguage) {
            const lang = row['language'];
            const k = typeof lang === 'string' && lang.length > 0 ? lang : 'null';
            languageBreakdown[k] = (languageBreakdown[k] ?? 0) + 1;
        }
    });
    return {
        nodeCount,
        ...(opts.byType ? { typeBreakdown } : {}),
        ...(opts.byLanguage ? { languageBreakdown } : {}),
        scanned,
        lowerBound,
    };
}

export interface VisibleEdgeCountOptions {
    relation?: string;
    /** Count only edges whose source / target node has this type. */
    sourceType?: string;
    targetType?: string;
    /** Max raw edge rows to scan. Default SCOPE_PAGE_FILL_MAX_SCAN. */
    cap?: number;
}

export interface VisibleEdgeCounts {
    edgeCount: number;
    /** Raw edge rows examined. */
    scanned: number;
    lowerBound: boolean;
}

interface EndpointInfo { visible: boolean; type: string }

/**
 * Visit every edge within the cap whose BOTH endpoints exist and are visible to
 * the bound actor (the rule mcp/edgeEndpointGate.ts applies to the single-edge
 * doors: a hidden endpoint answers as if it did not exist), after the optional
 * relation / endpoint-type filters. `scanned` counts raw edge rows examined.
 */
export async function forEachVisibleEdge(
    graph: VisibleEdgeGraph,
    opts: VisibleEdgeCountOptions,
    onEdge: (edge: LoreEdge) => void,
): Promise<{ scanned: number; lowerBound: boolean }> {
    const visible = actorRowVisibility();
    const cap = opts.cap ?? SCOPE_PAGE_FILL_MAX_SCAN;
    const info = new Map<string, EndpointInfo | null>();
    const relation = opts.relation ? { relation: opts.relation } : {};
    let scanned = 0;
    for (;;) {
        const room = cap - scanned;
        if (room <= 0) {
            // Probe one row past the cap to tell "exactly cap" from "more".
            const more = await graph.queryEdges({ ...relation, limit: 1, offset: scanned });
            return { scanned, lowerBound: more.length > 0 };
        }
        const want = Math.min(PAGE_SIZE, room);
        const page = await graph.queryEdges({ ...relation, limit: want, offset: scanned });
        if (page.length === 0) return { scanned, lowerBound: false };
        const need = [...new Set(page.flatMap((e) => [e.sourceId, e.targetId]))].filter((id) => !info.has(id));
        for (let i = 0; i < need.length; i += HYDRATE_CHUNK) {
            const chunk = need.slice(i, i + HYDRATE_CHUNK);
            const nodes = await graph.getNodesByIds(chunk);
            for (const id of chunk) {
                const n = nodes.get(id);
                info.set(id, n ? { visible: !visible || visible(n as { security_scopes?: unknown }), type: n.type } : null);
            }
        }
        for (const e of page) {
            const s = info.get(e.sourceId);
            const t = info.get(e.targetId);
            if (!s || !t || !s.visible || !t.visible) continue;
            if (opts.sourceType !== undefined && s.type !== opts.sourceType) continue;
            if (opts.targetType !== undefined && t.type !== opts.targetType) continue;
            onEdge(e);
        }
        scanned += page.length;
        if (page.length < want) return { scanned, lowerBound: false };
    }
}

/** Visible-only edge count: an edge counts only if BOTH endpoints are visible. */
export async function countVisibleEdges(
    graph: VisibleEdgeGraph,
    opts: VisibleEdgeCountOptions = {},
): Promise<VisibleEdgeCounts> {
    let edgeCount = 0;
    const { scanned, lowerBound } = await forEachVisibleEdge(graph, opts, () => { edgeCount++; });
    return { edgeCount, scanned, lowerBound };
}

/** Render a visible-only number: `<n>+` when it is a lower bound. */
export function formatVisibleCount(n: number, lowerBound: boolean): string {
    return lowerBound ? `${n.toLocaleString('en-US')}+` : n.toLocaleString('en-US');
}
