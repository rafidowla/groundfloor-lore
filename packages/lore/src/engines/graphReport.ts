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
 */

import type { LocalGraph } from './localGraph.js';

export interface ReportOptions {
    project?: string;
    /** Hard cap on top-N listings. */
    topN?: number;
}

/**
 * writeGraphReport — produce the markdown. Reads from the graph, returns
 * the full text. Callers write to disk or stdout.
 */
export async function writeGraphReport(
    graph: LocalGraph,
    opts: ReportOptions = {},
): Promise<string> {
    const topN = opts.topN ?? 20;
    const ctx = graph.createPluginGraphContext();

    // ─── Summary ────────────────────────────────────────────────
    const stats = await graph.getStats();

    // Edge confidence breakdown
    const confRows = await ctx.queryRows(
        `MATCH ()-[e:LoreEdge]->() RETURN e.confidence AS c, count(*) AS n`,
    );
    const confidenceByTier: Record<string, number> = {
        extracted: 0, inferred: 0, ambiguous: 0,
    };
    for (const row of confRows) {
        const c = String(row.c ?? 'extracted');
        confidenceByTier[c] = Number(row.n ?? 0);
    }

    // Top hubs by degree
    const topHubsRows = await ctx.queryRows(
        `MATCH (n:LoreNode)
         WITH n, COUNT { MATCH (n)-[:LoreEdge]-() } AS deg
         WHERE deg > 0
         RETURN n.id AS id, n.label AS label, n.type AS type, deg
         ORDER BY deg DESC LIMIT $n`,
        { n: topN },
    );

    // Recently updated
    const recentRows = await ctx.queryRows(
        `MATCH (n:LoreNode)
         WHERE n.updatedAt IS NOT NULL AND n.updatedAt <> ''
         RETURN n.id AS id, n.label AS label, n.type AS type, n.updatedAt AS updatedAt
         ORDER BY n.updatedAt DESC LIMIT 10`,
    );

    // Orphans
    const orphanRows = await ctx.queryRows(
        `MATCH (n:LoreNode)
         WHERE NOT EXISTS { MATCH (n)-[:LoreEdge]-() }
         RETURN n.id AS id, n.label AS label, n.type AS type LIMIT 20`,
    );

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
    lines.push(`- **Nodes**: ${stats.nodeCount}`);
    lines.push(`- **Edges**: ${stats.edgeCount}`);
    lines.push(`- **Code symbols** (developer plugin): ${stats.codeSymbolCount}`);
    lines.push(`- **Code relations**: ${stats.codeRelationCount}`);
    lines.push('');
    lines.push('### Nodes by type');
    lines.push('');
    const types = Object.entries(stats.typeBreakdown).sort(
        (a, b) => b[1] - a[1],
    );
    if (types.length === 0) {
        lines.push('_(no nodes yet)_');
    } else {
        lines.push('| Type | Count |');
        lines.push('|---|---:|');
        for (const [t, n] of types) lines.push(`| ${t} | ${n} |`);
    }
    lines.push('');

    lines.push('### Edges by confidence');
    lines.push('');
    lines.push('| Tier | Count |');
    lines.push('|---|---:|');
    for (const tier of ['extracted', 'inferred', 'ambiguous']) {
        lines.push(`| ${tier} | ${confidenceByTier[tier] ?? 0} |`);
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
            lines.push(`| ${r.deg} | ${r.type} | ${escapePipe(String(r.label ?? ''))} | \`${r.id}\` |`);
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
            const when = String(r.updatedAt ?? '').slice(0, 19).replace('T', ' ');
            lines.push(`| ${when} | ${r.type} | ${escapePipe(String(r.label ?? ''))} | \`${r.id}\` |`);
        }
    }
    lines.push('');

    lines.push('## Orphans (no edges yet)');
    lines.push('');
    if (orphanRows.length === 0) {
        lines.push('_None — every node has at least one edge._');
    } else {
        lines.push(`${orphanRows.length} node(s) without edges — candidates for \`lore reconnect\`:`);
        lines.push('');
        lines.push('| Type | Label | ID |');
        lines.push('|---|---|---|');
        for (const r of orphanRows) {
            lines.push(`| ${r.type} | ${escapePipe(String(r.label ?? ''))} | \`${r.id}\` |`);
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
