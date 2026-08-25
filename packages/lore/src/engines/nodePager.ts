/**
 * nodePager.ts — engine-agnostic paged node scan and raw query-rows type.
 *
 * Relocated out of `graphBulkList.ts` and `graphEdges.ts` (Kùzu-Cypher
 * files, slated for deletion in the Kùzu removal) because nothing here
 * touches an engine: every export either types a raw query surface or
 * walks pages through a `NodePager` function parameter. Both engines
 * expose a `bulkListProjected` method that IS a `NodePager`
 * (`engines/localGraph.ts`, `engines/surreal/surrealGraph.ts`), and the
 * maintenance family (consistency sweep, freshness, corpus health,
 * supersession candidates, retention, deferred surfacing) drives it
 * through `forEachNodePage` so peak heap is one bounded page. Relocating
 * before the Kùzu-Cypher remainder of the source files is deleted is
 * load-bearing — see docs/audit/KUZU-REMOVAL-*.md.
 *
 * Not relocated with them: `pagerFromQueryRows` — it adapts a raw Cypher
 * `queryRows` over Kùzu's own `bulkListProjected`, so it stays in
 * `graphBulkList.ts` and dies with the Cypher it wraps.
 */

import type { BulkListCursor } from '../providers/types.js';

/**
 * Run a Cypher read and return raw rows. This is the
 * `getGraphContext().queryRows` surface, threaded in so query logic can
 * live beside its helpers (single concern) while LocalGraph stays a thin
 * delegator. Defined in `graphEdges.ts` before the Kùzu removal; its
 * engine-agnostic consumers (`deferred.ts`, `freshnessEngine.ts`,
 * `diagnostics/consistency.ts`, `graphBulkList.ts`) now import it from
 * here.
 */
export type QueryRows = (cypher: string, params?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;

/** Default page size for maintenance scans. Matches the bulk-list cap so the
 *  keyset walk is a single, well-understood page-size across the codebase. */
export const DEFAULT_MAINTENANCE_PAGE_SIZE = 1000;

/** One page of a projected keyset scan: the raw rows plus the cursor to resume
 *  after them (null when the page was the last). */
export interface ProjectedNodePage {
    rows: Array<Record<string, unknown>>;
    nextCursor: BulkListCursor | null;
}

/**
 * forEachNodePage — drive a `NodePager` to completion, handing each
 * bounded page to `onPage`. Peak heap is one page's worth of the projected
 * columns, regardless of total node count. The visitor sees the SAME nodes in
 * the SAME order an unbounded `listNodes` scan would have produced.
 */
export async function forEachNodePage(
    page: NodePager,
    project: string,
    columns: readonly string[],
    onPage: (rows: Array<Record<string, unknown>>) => void | Promise<void>,
    pageSize: number = DEFAULT_MAINTENANCE_PAGE_SIZE,
): Promise<void> {
    let cursor: BulkListCursor | null = null;
    do {
        const { rows, nextCursor } = await page(project, columns, pageSize, cursor);
        if (rows.length > 0) await onPage(rows);
        cursor = nextCursor;
    } while (cursor);
}

/**
 * The engine-agnostic paged node scan.
 *
 * Both engines implement this; it is the replacement for five callers that
 * reached `getGraphContext().queryRows` with hand-written Cypher to walk every
 * node in bounded pages. `id` and `updatedAt` are always returned regardless of
 * `columns`, because they are the cursor.
 */
export type NodePager = (
    project: string,
    columns: readonly string[],
    limit: number,
    cursor: BulkListCursor | null,
) => Promise<ProjectedNodePage>;

/**
 * collectSupersededEligible — retention-sweep helper. Pages the whole
 * workspace projecting only id + supersededAt (no content) and returns the
 * nodes whose supersededAt is a valid timestamp strictly before `cutoffMs`.
 * Extracted so the retention sweep in mcp/services.ts stays within its
 * file-size budget while getting the bounded-heap scan.
 */
export async function collectSupersededEligible(
    /**
     * A `NodePager` — NOT a raw-Cypher `queryRows`. It took the latter, which
     * made the retention sweep Kùzu-only: a Surreal-backed workspace has no
     * `getGraphContext()` to hand it, so the sweep silently reported a clean
     * zero. Both engines implement `bulkListProjected`, which IS a `NodePager`.
     */
    page: NodePager,
    cutoffMs: number,
): Promise<Array<{ id: string; supersededAt: string }>> {
    const eligible: Array<{ id: string; supersededAt: string }> = [];
    await forEachNodePage(page, '*', ['supersededAt'], (rows) => {
        for (const r of rows) {
            const sAt = (r['supersededAt'] as string) || '';
            const t = sAt ? Date.parse(sAt) : NaN;
            if (Number.isFinite(t) && t < cutoffMs) {
                eligible.push({ id: String(r['id'] ?? ''), supersededAt: sAt });
            }
        }
    });
    return eligible;
}
