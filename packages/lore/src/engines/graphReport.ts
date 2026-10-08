/**
 * graphReport.ts — Human-readable Markdown digest of the graph (Phase 2 / C4).
 *
 * Answers: "what does Lore know, without me having to query it?"
 *
 * The report is a read-only artifact — no mutations, pure aggregation
 * over the live graph. Intended outputs:
 *   - `lore report` → stdout (for `grep`, `less`)
 *   - `lore report --output GRAPH_REPORT.md` → committed artifact
 *   - Auto-regenerated at the end of `lore reconsume` (follow-up)
 *   - Viewable in the UI as a read-only panel (not wired in C4 scope)
 *
 * Content:
 *   - Scope header (project, ecosystem, timestamp)
 *   - Summary: node + edge counts, type breakdown, confidence breakdown
 *   - Top 20 nodes by degree (hubs — the most-referenced knowledge)
 *   - Top 10 recently-updated nodes
 *   - Orphans (no edges — candidates for `lore reconnect`)
 *   - Followup block (known gaps the user should act on)
 *
 * Formatter only — the four aggregates below (edge-confidence tally, hub
 * ranking, recently-updated, orphans) are computed engine-agnostically in
 * `graphReportAggregates.ts` (one concern per file; see that file's header
 * for why raw Cypher went away without either local engine gaining new methods).
 */

import type { ReportGraph } from './graphReportAggregates.js';
import {
    computeEdgeAggregates,
    computeOrphans,
    computeRecentlyUpdated,
    computeTopHubs,
    computeVisibleSummary,
    type EdgeAggregates,
} from './graphReportAggregates.js';
import { defaultScanCap, formatVisibleCount } from '../security/visibleCounts.js';

export interface ReportOptions {
    project?: string;
    /** Hard cap on top-N listings. */
    topN?: number;
    /**
     * Bound actors only (security/scopeFilter.actorRowVisibility): hubs,
     * recently-updated and orphan rows the actor cannot see are omitted, so no
     * hidden node's id/label/type is listed.
     */
    rowVisible?: (row: { security_scopes?: unknown }) => boolean;
    /**
     * Bound NON-operator only (security/visibleCounts.countAudience() ===
     * 'visible'): the Summary (Nodes, Edges, Nodes by type, Edges by
     * confidence) and the hub degrees count only visible nodes and edges whose
     * both endpoints are visible, each walk bounded to the scan cap; a capped
     * number renders as `<n>+`. Unbound / operator callers leave this unset and
     * get the workspace-wide aggregates unchanged. `cap` is for tests.
     */
    visibleCounts?: { cap?: number };
}

/** Literal caps the source Cypher used for these two sections — NOT
 *  affected by `--topN`, which only bounds the hub listing. */
const RECENT_LIMIT = 10;
const ORPHAN_LIMIT = 20;

/**
 * writeGraphReport — produce the markdown. Reads from the graph, returns
 * the full text. Callers write to disk or stdout.
 */
export async function writeGraphReport(
    graph: ReportGraph,
    opts: ReportOptions = {},
): Promise<string> {
    const topN = opts.topN ?? 20;

    // ─── Summary ────────────────────────────────────────────────
    const visible = opts.visibleCounts ? await computeVisibleSummary(graph, opts.visibleCounts.cap) : undefined;
    const stats = visible
        ? { nodeCount: visible.nodes.count, edgeCount: visible.edges.count, typeBreakdown: visible.nodes.typeBreakdown }
        : await graph.getStats();
    const nodesCapped = visible?.nodes.lowerBound ?? false;
    const edgesCapped = visible?.edges.lowerBound ?? false;
    const num = (n: number, capped: boolean): string => (visible ? formatVisibleCount(n, capped) : String(n));

    // One paged edge walk feeds the confidence tally, the hub degree map,
    // and the orphan-exclusion set — see graphReportAggregates.ts.
    const { confidenceByTier, degreeById, endpointIds }: EdgeAggregates = visible?.edges ?? await computeEdgeAggregates(graph);
    const topHubsRows = await computeTopHubs(graph, degreeById, topN, opts.rowVisible);
    // Bound non-operator: the node walks are bounded by the same raw-row cap.
    const walkCap = visible ? { cap: opts.visibleCounts?.cap ?? defaultScanCap(), lowerBound: false } : undefined;
    const recentBudget = walkCap && { ...walkCap };
    const orphanBudget = walkCap && { ...walkCap };
    const recentRows = await computeRecentlyUpdated(graph, RECENT_LIMIT, opts.rowVisible, recentBudget);
    // With a capped edge walk most endpoints are unknown, so "no edge seen" does
    // not mean "no edge": the orphan list is omitted rather than listed wrongly.
    const orphansUnreliable = edgesCapped;
    const orphanRows = orphansUnreliable ? [] : await computeOrphans(graph, endpointIds, ORPHAN_LIMIT, opts.rowVisible, orphanBudget);
    const anyCapped = nodesCapped || edgesCapped || (recentBudget?.lowerBound ?? false) || (orphanBudget?.lowerBound ?? false);

    // ─── Markdown assembly ──────────────────────────────────────
    const lines: string[] = [];
    const now = new Date().toISOString();

    lines.push('# Lore Graph Report');
    lines.push('');
    lines.push(`Generated: ${now}`);
    if (opts.project) lines.push(`Scope: project=\`${opts.project}\``);
    lines.push('');

    lines.push('## Summary');
    lines.push('');
    lines.push(`- **Nodes**: ${num(stats.nodeCount, nodesCapped)}`);
    lines.push(`- **Edges**: ${num(stats.edgeCount, edgesCapped)}`);
    if (visible) lines.push('', '_Counts cover items visible to this caller._');
    if (visible && anyCapped) lines.push('', '_Counts marked + are lower bounds: the scan limit was reached._');
    lines.push('');
    lines.push('### Nodes by type');
    lines.push('');
    // Tie-break on type name. `getStats().typeBreakdown` is an object whose key
    // order is whatever each engine's aggregate query returned, so a bare
    // `count DESC` left every tie to the storage engine — the same section
    // rendered in a different row order across graph engines for identical
    // data. Pre-existing (the sort has always lived in the formatter, not in
    // the Cypher); surfaced by the cross-engine document comparison in
    // test/cli-engine-parity-unit.ts, which failed on the third consecutive
    // run and passed on the first two.
    const types = Object.entries(stats.typeBreakdown).sort(
        (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    if (types.length === 0) {
        lines.push('_(no nodes yet)_');
    } else {
        lines.push('| Type | Count |');
        lines.push('|---|---:|');
        for (const [t, n] of types) lines.push(`| ${t} | ${num(n, nodesCapped)} |`);
    }
    lines.push('');

    lines.push('### Edges by confidence');
    lines.push('');
    lines.push('| Tier | Count |');
    lines.push('|---|---:|');
    for (const tier of ['extracted', 'inferred', 'ambiguous']) {
        lines.push(`| ${tier} | ${num(confidenceByTier[tier] ?? 0, edgesCapped)} |`);
    }
    lines.push('');

    lines.push(`## Top ${topHubsRows.length} hubs (most-connected nodes)`);
    lines.push('');
    if (topHubsRows.length === 0) {
        lines.push('_(no hubs — either the graph has no edges yet, or `lore reconnect` hasn\'t run)_');
    } else {
        lines.push('| Degree | Type | Label | ID |');
        lines.push('|---:|---|---|---|');
        for (const r of topHubsRows) {
            lines.push(`| ${visible ? formatVisibleCount(r.deg, edgesCapped) : r.deg} | ${r.type} | ${escapePipe(r.label)} | \`${r.id}\` |`);
        }
    }
    lines.push('');

    lines.push('## Recently updated');
    lines.push('');
    if (recentRows.length === 0) {
        lines.push('_(no nodes with updatedAt timestamps)_');
    } else {
        lines.push('| Updated | Type | Label | ID |');
        lines.push('|---|---|---|---|');
        for (const r of recentRows) {
            const when = r.updatedAt.slice(0, 19).replace('T', ' ');
            lines.push(`| ${when} | ${r.type} | ${escapePipe(r.label)} | \`${r.id}\` |`);
        }
    }
    lines.push('');

    lines.push('## Orphans (no edges yet)');
    lines.push('');
    if (orphansUnreliable) {
        lines.push('_(not shown — too many edges to scan)_');
    } else if (orphanRows.length === 0) {
        lines.push('_None — every node has at least one edge._');
    } else {
        lines.push(`${orphanRows.length} node(s) without edges — candidates for \`lore reconnect\`:`);
        lines.push('');
        lines.push('| Type | Label | ID |');
        lines.push('|---|---|---|');
        for (const r of orphanRows) {
            lines.push(`| ${r.type} | ${escapePipe(r.label)} | \`${r.id}\` |`);
        }
    }
    lines.push('');

    lines.push('---');
    lines.push('');
    lines.push('_Generated by `lore report`. Regenerate after large ingests or after `lore reconsume`._');
    lines.push('');

    return lines.join('\n');
}

/** Escape pipe characters so they don't break markdown tables. */
function escapePipe(s: string): string {
    return s.replace(/\|/g, '\\|');
}
