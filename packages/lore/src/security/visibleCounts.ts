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
 * `listNodes`. A scan ends only on an empty page or the engine's explicit end
 * signal (null cursor / `hasMore: false`): engines may return SHORT pages
 * before the end (client-side filtering, Arcade's 1000-row clamp), so a short
 * page is never read as "last page".
 *
 * bulkList rows on some engines (Arcade) do not carry the projected lifecycle
 * columns a caller asked for in `extraColumns`; for the visible rows of such a
 * page the missing columns are filled from the full node (getNodesByIds, 500
 * ids per call), so the scan stays within the same raw-row cap.
 *
 * `language`: the projected engines (sqlite, surreal) return it per row;
 * dataplane bulkList rows carry it too (recordToLoreNode); the arcade node type
 * has no `language` property at all (arcadeSchema NODE_PROPS), so its rows fall
 * under 'null' — the same answer cellLanguageBreakdown gives there.
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

let scanCapOverride: number | undefined;
/** TEST ONLY: lower the default scan cap for every surface (undefined restores it). */
export function setVisibleScanCapForTests(cap: number | undefined): void { scanCapOverride = cap; }
export const defaultScanCap = (): number => scanCapOverride ?? SCOPE_PAGE_FILL_MAX_SCAN;

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
export type VisibleCountGraph = Pick<LoreGraphHandle, 'bulkList'> & Partial<Pick<LoreGraphHandle, 'getNodesByIds'>> & {
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
    /** Count only nodes tagged with this project (the getStats projectFilter). */
    project?: string;
    /** Extra columns the projected scan should return (bulkList rows already carry them). */
    extraColumns?: readonly string[];
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

/**
 * Walk raw node rows (id, type, language, security_scopes) up to the cap, one
 * page at a time. `onPage` receives each page's rows and whether they came from
 * the projection (which already carries every requested column).
 */
async function scanNodeRows(
    graph: VisibleCountGraph,
    type: string | undefined,
    cap: number,
    needLanguage: boolean,
    project: string | undefined,
    extraColumns: readonly string[],
    onPage: (rows: Array<Record<string, unknown>>, projected: boolean) => Promise<void>,
): Promise<{ scanned: number; lowerBound: boolean }> {
    let scanned = 0;
    let cursor: { updatedAt: string; id: string } | null = null;
    // bulkList rows do not carry `language` on every engine; the projection does.
    // A projected scan cannot filter by type in SQL, so it filters client-side
    // (and `scanned` then counts every row of the workspace, not just that type).
    const projected = typeof graph.bulkListProjected === 'function' && (type === undefined || needLanguage);
    const fetchPage = async (limit: number): Promise<{ rows: Array<Record<string, unknown>>; next: { updatedAt: string; id: string } | null }> => {
        if (projected) {
            const page = await graph.bulkListProjected!(
                project ?? '*', [...new Set(['type', 'language', 'security_scopes', ...extraColumns])], limit, cursor,
            );
            return { rows: page.rows, next: page.nextCursor };
        }
        const page = await graph.bulkList({
            ...(type !== undefined ? { types: [type] } : {}),
            ...(project !== undefined ? { project } : {}),
            limit, cursor,
        });
        return { rows: page.nodes as unknown as Array<Record<string, unknown>>, next: page.hasMore ? page.nextCursor : null };
    };
    for (;;) {
        const room = cap - scanned;
        if (room <= 0) {
            // The previous page ended at the cap with a non-null cursor. The
            // engine may still be at its end (exactly `cap` rows), so peek one
            // raw row: only a row that actually exists makes this a lower bound.
            const peek = await fetchPage(1);
            return { scanned, lowerBound: peek.rows.length > 0 };
        }
        const { rows, next } = await fetchPage(Math.min(PAGE_SIZE, room));
        await onPage(type !== undefined && projected ? rows.filter((r) => r['type'] === type) : rows, projected);
        scanned += rows.length;
        if (!next || rows.length === 0) return { scanned, lowerBound: false };
        cursor = next;
    }
}

/**
 * Visit every VISIBLE node row within the cap (rows are the engine's raw
 * records: id, type, label, metadata, language, security_scopes, ...). The
 * building block for counts, per-type breakdowns and visible-row samples.
 */
export async function forEachVisibleNode(
    graph: VisibleCountGraph,
    opts: { type?: string; cap?: number; byLanguage?: boolean; project?: string; extraColumns?: readonly string[] },
    onRow: (row: Record<string, unknown>) => void,
): Promise<{ scanned: number; lowerBound: boolean }> {
    const visible = actorRowVisibility();
    const extra = opts.extraColumns ?? [];
    return scanNodeRows(graph, opts.type, opts.cap ?? defaultScanCap(), opts.byLanguage === true, opts.project, extra, async (rows, projected) => {
        const seen = visible ? rows.filter((row) => visible(row as { security_scopes?: unknown })) : rows;
        if (!projected && extra.length > 0 && graph.getNodesByIds) await fillMissingColumns(graph.getNodesByIds.bind(graph), seen, extra);
        for (const row of seen) onRow(row);
    });
}

/**
 * bulkList rows (Arcade) omit lifecycle columns the projection would carry.
 * For the rows of this page that lack a requested column, copy it from the full
 * node. Only visible rows are hydrated and the page is already inside the cap.
 */
async function fillMissingColumns(
    getNodesByIds: NonNullable<VisibleCountGraph['getNodesByIds']>,
    rows: Array<Record<string, unknown>>,
    columns: readonly string[],
): Promise<void> {
    const lacking = rows.filter((r) => columns.some((c) => !(c in r)));
    for (let i = 0; i < lacking.length; i += HYDRATE_CHUNK) {
        const chunk = lacking.slice(i, i + HYDRATE_CHUNK);
        const nodes = await getNodesByIds(chunk.map((r) => String(r['id'] ?? '')));
        for (const row of chunk) {
            const node = nodes.get(String(row['id'] ?? '')) as unknown as Record<string, unknown> | undefined;
            if (!node) continue;
            for (const c of columns) if (!(c in row) && c in node) row[c] = node[c];
        }
    }
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
            // Empty types stay out of the breakdown, as in every engine's getStats.
            const t = String(row['type'] ?? '');
            if (t) typeBreakdown[t] = (typeBreakdown[t] ?? 0) + 1;
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
    /** Count only edges whose BOTH endpoints are tagged with this project (the getStats projectFilter). */
    project?: string;
    /** Max raw edge rows to scan. Default SCOPE_PAGE_FILL_MAX_SCAN. */
    cap?: number;
}

export interface VisibleEdgeCounts {
    edgeCount: number;
    /** Raw edge rows examined. */
    scanned: number;
    lowerBound: boolean;
}

export interface EndpointInfo { visible: boolean; type: string; project: string }

/**
 * Visit every edge within the cap whose BOTH endpoints exist and are visible to
 * the bound actor (the rule mcp/edgeEndpointGate.ts applies to the single-edge
 * doors: a hidden endpoint answers as if it did not exist), after the optional
 * relation / endpoint-type filters. `scanned` counts raw edge rows examined.
 */
export async function forEachVisibleEdge(
    graph: VisibleEdgeGraph,
    opts: VisibleEdgeCountOptions,
    onEdge: (edge: LoreEdge, source: EndpointInfo, target: EndpointInfo) => void,
): Promise<{ scanned: number; lowerBound: boolean }> {
    const visible = actorRowVisibility();
    const cap = opts.cap ?? defaultScanCap();
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
                info.set(id, n ? { visible: !visible || visible(n as { security_scopes?: unknown }), type: n.type, project: n.project ?? '' } : null);
            }
        }
        for (const e of page) {
            const s = info.get(e.sourceId);
            const t = info.get(e.targetId);
            if (!s || !t || !s.visible || !t.visible) continue;
            if (opts.sourceType !== undefined && s.type !== opts.sourceType) continue;
            if (opts.targetType !== undefined && t.type !== opts.targetType) continue;
            if (opts.project !== undefined && (s.project !== opts.project || t.project !== opts.project)) continue;
            onEdge(e, s, t);
        }
        scanned += page.length;
        // No short-page stop: engines clamp or filter client-side and return
        // short pages mid-scan. The next round ends on an empty page.
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
