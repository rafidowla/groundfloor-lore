/**
 * corpusHealthCompute.ts — shared corpus-health aggregation (Feature 7).
 *
 * Both the `corpus_health` MCP tool (mcp/tools/corpusHealth.ts) and its HTTP
 * mirror (mcp/http/routes/corpus.ts) compute the same per-workspace health
 * overview: node counts by status and classification tier, stale counts, the
 * confirmation-score distribution, edge count, and the pre-aggregated AuxStore
 * outcome/corpus counters. The aggregation lives here once so the two surfaces
 * can never report different numbers.
 *
 * Note on graph resolution: callers pass an already-resolved graph. The MCP
 * tool resolves via requireLocalGraph() (cloud mode throws); the HTTP route
 * passes loreGraph directly. This module does not impose a mode policy — it
 * only runs listNodes + getStats on whatever graph it is given.
 */

import type { AuxStore } from '../outbox/auxStore.js';
import { forEachNodePage, type NodePager } from '../engines/nodePager.js';
import type { LoreGraphHandle } from '../storage/loreStorageClient.js';

// Widened when the local graph engine changed: naming the two CONCRETE
// classes silently excluded SurrealGraph (see engines/htmlExport.ts). Need
// more than the shared handle? Feature-detect and refuse — do not re-narrow
// to a class.
type LoreGraph = LoreGraphHandle;

export interface CorpusHealthReport {
    workspace: string;
    total_nodes: number;
    active_nodes: number;
    archived_nodes: number;
    protected_nodes: number;
    foundational_nodes: number;
    tactical_nodes: number;
    observational_nodes: number;
    unclassified_nodes: number;
    stale_nodes: number;
    anchor_stale_nodes: number;
    avg_confirmation_score: number;
    scored_nodes: number;
    edge_count: number;
    outcome_totals: ReturnType<AuxStore['getWorkspaceOutcomeTotals']>;
    corpus_counters: ReturnType<AuxStore['getCorpusCounters']>;
}

/**
 * computeCorpusHealth — derive the health overview for one workspace by
 * listing all its nodes (project scope '*') and aggregating in JS, then
 * folding in the AuxStore counters and the graph's edge count.
 */
export async function computeCorpusHealth(
    graph: LoreGraph,
    auxStore: AuxStore,
    workspace: string,
): Promise<CorpusHealthReport> {
    await graph.initialize();

    let totalNodes = 0;
    let active = 0, archived = 0, protected_ = 0;
    let foundational = 0, tactical = 0, observational = 0, unclassified = 0;
    let staleNodes = 0, anchorStaleNodes = 0;
    let totalScore = 0, scoredNodes = 0;

    // Fold one node's health-relevant fields into the running counters. Takes
    // the coerced field values so both the paged (raw graph row) and the
    // unbounded-fallback (LoreNode) paths produce byte-identical counts.
    const fold = (
        status: string,
        cls: string,
        stale: unknown,
        anchorStale: unknown,
        cs: number,
    ): void => {
        totalNodes++;
        if (status === 'archived') archived++;
        else if (status === 'protected') protected_++;
        else active++;

        if (cls === 'foundational') foundational++;
        else if (cls === 'observational') observational++;
        else if (cls === 'tactical') tactical++;
        else unclassified++;

        if (stale) staleNodes++;
        if (anchorStale) anchorStaleNodes++;

        if (cs > 0) { totalScore += cs; scoredNodes++; }
    };

    // P1 scale fix — page the walk projecting only the health columns (no
    // `content`), folding each bounded page. Peak heap is one page. Coerce raw
    // graph values to match rowToLoreNode's defaults (status '' → 'active',
    // classification '' → 'tactical', numeric confirmation_score). Fakes /
    // cloud graphs without getGraphContext fall back to the unbounded scan.
    const pager = (graph as { bulkListProjected?: NodePager }).bulkListProjected?.bind(graph);
    if (pager) {
        // anchor_stale is now projected alongside `stale` — both are surfaced
        // by rowToLoreNode's coercion (BOOLEAN → true|undefined), so the paged
        // path folds real anchor_stale counts. Previously this projection
        // deliberately excluded anchor_stale (rowToLoreNode didn't read the
        // column back either), which made anchor_stale_nodes permanently 0;
        // see localGraphReads.ts rowToLoreNode for the companion fix.
        await forEachNodePage(
            pager,
            // R4 #7 — `project`, not workspace (see the else-branch note below).
            '*',
            ['status', 'classification', 'stale', 'anchor_stale', 'confirmation_score'],
            (rows) => {
                for (const r of rows) {
                    const status = (r['status'] as string) || 'active';
                    const cls = (r['classification'] as string) || 'tactical';
                    const csRaw = r['confirmation_score'];
                    const cs = typeof csRaw === 'number' ? csRaw : (csRaw != null ? Number(csRaw) : 0);
                    // Match rowToLoreNode's stale/anchor_stale coercion (BOOLEAN → true|undefined).
                    const staleRaw = r['stale'];
                    const stale = staleRaw === true || staleRaw === 1 || staleRaw === 'true' ? true : undefined;
                    const anchorStaleRaw = r['anchor_stale'];
                    const anchorStale = anchorStaleRaw === true || anchorStaleRaw === 1 || anchorStaleRaw === 'true' ? true : undefined;
                    fold(status, cls, stale, anchorStale, Number.isFinite(cs) ? cs : 0);
                }
            },
        );
    } else {
        // R4 #7 — `'*'`, not the workspace name. The 4th argument is `project`, a
        // CALLER-OWNED node field that every engine turns into a strict
        // `n.project = $project`; it is not guaranteed to equal the workspace name
        // (Atlas stores project='v3' inside workspace='default', and any explicit
        // `project` on a write is preserved verbatim). retrieve.ts:314-321 documents
        // this substitution as the mistake that "silently makes keyword fallback
        // empty while the vector path still appears healthy". The physical workspace
        // boundary is already enforced by the graph resolved above — each workspace
        // is its own database — so the name here only ever DROPPED that workspace's
        // own rows.
        const allNodes = await graph.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
        for (const n of allNodes) {
            fold(n.status ?? 'active', n.classification ?? 'tactical', n.stale, n.anchor_stale, n.confirmation_score ?? 0);
        }
    }

    const avgConfirmationScore = scoredNodes > 0
        ? Math.round((totalScore / scoredNodes) * 1000) / 1000
        : 0;

    const outcomeTotals = auxStore.getWorkspaceOutcomeTotals(workspace);
    const corpusCounters = auxStore.getCorpusCounters(workspace);
    const stats = await graph.getStats();

    return {
        workspace,
        total_nodes: totalNodes,
        active_nodes: active,
        archived_nodes: archived,
        protected_nodes: protected_,
        foundational_nodes: foundational,
        tactical_nodes: tactical,
        observational_nodes: observational,
        unclassified_nodes: unclassified,
        stale_nodes: staleNodes,
        anchor_stale_nodes: anchorStaleNodes,
        avg_confirmation_score: avgConfirmationScore,
        scored_nodes: scoredNodes,
        edge_count: stats.edgeCount,
        outcome_totals: outcomeTotals,
        corpus_counters: corpusCounters,
    };
}
