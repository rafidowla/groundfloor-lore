/**
 * diagnostics/consistency.ts — Tri-substrate consistency diagnostic.
 *
 * Walks the three local substrates (Kùzu graph, LanceDB vector store,
 * optional SQLite tables) and reports inconsistencies that would
 * otherwise be invisible. Read-only — never writes, never deletes,
 * never repairs. Repair is a separate decision the operator makes
 * after looking at the report.
 *
 * What's checked:
 *
 *   1. **missingEmbeddings** — graph nodes that have no matching
 *      embedding in the vector store. Cause: write that succeeded in
 *      Kùzu but failed in LanceDB (no transaction across substrates).
 *      Symptom: nodes invisible to semantic search.
 *
 *   2. **orphanEmbeddings** — embeddings with no matching graph node.
 *      Cause: graph node was deleted but its embedding wasn't cleaned
 *      up; or an embedding was written speculatively before its node.
 *      Symptom: semantic search returns ids that 404 when hydrated.
 *
 *   3. **sqliteOrphans** — optional. SQLite rows with a `node_id`
 *      column whose value is not present in the graph. Operator
 *      supplies the (table, column) pairs to check; we don't infer
 *      them since the column name is caller convention.
 *      Cause: graph node was deleted but associated SQLite rows weren't.
 *      Symptom: dangling foreign references in caller queries.
 *
 * The vector-store id convention: every LoreNode's embedding row is
 * keyed as `lore:<node-id>` (see syncEngine.upsertVectorMirror). The
 * diagnostic strips this prefix before comparing against graph ids.
 *
 * NOT included in v1:
 *   - Backfill / repair (deliberate — diagnose-first, decide separately).
 *   - Multi-workspace aggregation (caller iterates workspaces).
 *   - Embedding-freshness check (re-embed if text changed) — that's a
 *     different concern; this diagnostic is about presence, not staleness.
 */

import type { LoreNode } from '../providers/types.js';
/** Narrow view of the vector store the diagnostic needs. Anything
 *  with `listIds(prefix?, opts?)` satisfies it — VerbatimStore (local) or
 *  DataplaneVectorStore (cloud) both qualify. The optional `opts.project`
 *  is the workspace-scope filter used for L5b-aliased stores; readers that
 *  ignore it return the unfiltered set (correct fallback behavior). */
interface VectorIdsReader {
    listIds(prefix?: string, opts?: { project?: string }): Promise<string[]>;
}
import type { ITableStorage } from '../contracts/tables.js';
import { forEachNodePage, type NodePager, type QueryRows } from '../engines/nodePager.js';
import { isRevisionHistoryId } from '../engines/verbatimHistory.js';

/** Embedding id prefix used by syncEngine.upsertVectorMirror. */
const VECTOR_ID_PREFIX = 'lore:';

export interface GraphReader {
    listNodes(
        type?: string,
        tag?: string,
        project?: string,
        ecosystem?: string,
        limit?: number,
        opts?: { unbounded?: boolean },
    ): Promise<LoreNode[]>;
    /**
     * P1 scale fix — optional keyset-pagination surface. When present (the
     * real LocalGraph exposes it), the graph-side walk pages through the node
     * table one bounded PAGE at a time, projecting only id + metadata instead
     * of materializing every node's full content into heap. Absent on test
     * fakes and DataplaneGraph, which fall back to the unbounded listNodes
     * scan (fine — those paths are small / not the ~1M-node local sweep).
     *
     * 2026-08-06: this used to be `getGraphContext?()`, i.e. a raw Kùzu Cypher
     * runner, which made the bounded walk Kùzu-only — a Surreal-backed
     * workspace silently took the unbounded fallback. `bulkListProjected` is
     * the same walk as an engine-agnostic operation; both engines implement it.
     */
    bulkListProjected?: NodePager;
}

/**
 * Per-table check spec for the SQLite orphan walk. Each entry says
 * "in table X, the column Y holds a soft-FK to a graph node id —
 * report rows whose value isn't in the graph."
 */
export interface SqliteOrphanCheck {
    table: string;
    /** Column name on the table. Convention: `node_id`. */
    column: string;
}

export interface SqliteOrphanReport {
    table: string;
    column: string;
    /** Distinct orphan values found (capped). */
    orphans: unknown[];
    /** True iff the diagnostic stopped collecting at the cap; total may be larger. */
    truncated: boolean;
}

export interface ConsistencyReport {
    /** Workspace scope this report was computed for. */
    workspace: string;
    /** ISO timestamp when the report was generated. */
    computedAt: string;
    /** Total graph nodes counted. */
    graphNodeCount: number;
    /** Total embeddings counted. */
    vectorEmbeddingCount: number;
    /** Graph node ids that have no matching embedding. */
    missingEmbeddings: string[];
    /** Embedding ids (the bare node id, prefix stripped) with no matching graph node. */
    orphanEmbeddings: string[];
    /** Optional per-table SQLite orphan reports. Empty if no checks supplied. */
    sqliteOrphans: SqliteOrphanReport[];
    /** True iff any of the three categories has at least one entry. */
    hasIssues: boolean;
    /** True when the graph node scan failed/aborted mid-walk. When set,
     *  `orphanEmbeddings` is UNRELIABLE (computed against a partial/empty
     *  graph id set) and MUST NOT drive a destructive delete pass — the
     *  whole corpus would look like orphans and be wiped. */
    graphScanFailed: boolean;
}

export interface DiagnoseOpts {
    /** Workspace label stamped on the report and used to scope vector
     *  store listings. Required so multi-workspace daemons can run the
     *  diagnostic per workspace. */
    workspace: string;
    /** Optional SQLite orphan checks. When omitted, the SQLite walk is
     *  skipped — graph and vector are still checked. */
    sqliteChecks?: SqliteOrphanCheck[];
    /** Cap on orphans collected per SQLite check. Default 100. */
    sqliteOrphanCap?: number;
}

/**
 * Compute a consistency report. Never throws — substrate failures
 * surface as zero/empty entries so the report still renders.
 */
export async function diagnoseConsistency(
    graph: GraphReader,
    vectorStore: VectorIdsReader | null,
    tableStorage: ITableStorage | null,
    opts: DiagnoseOpts,
): Promise<ConsistencyReport> {
    const computedAt = new Date().toISOString();

    // 1. Graph side — every node id in the workspace.
    // PR #69 P2 fix: Atlas (and other clients) write code nodes with
    // `embed: false` — they exist in the graph for traversal but
    // intentionally have no vector. Pre-fix, the strict set-difference
    // below flagged every such node as `missingEmbeddings`, the sweep
    // enqueued them all for re-embed, and they refilled the vector
    // store every 30 minutes forever. We filter them out so they never
    // enter the missing set.
    const graphIds = new Set<string>();
    const graphIdsNonEmbeddable = new Set<string>();
    // P1 scale fix — partition every graph id into embeddable vs
    // embed:false. Both the paged and the fallback path run the SAME
    // classification so the missing/orphan set-difference below is
    // byte-identical to the pre-fix unbounded scan.
    const classify = (id: string, embed: unknown): void => {
        if (embed === false) graphIdsNonEmbeddable.add(id);
        else graphIds.add(id);
    };
    // Set when the graph walk throws or aborts mid-walk — the graphIds
    // set is then partial/empty and the orphan set-difference is NOT to be
    // trusted (a destructive delete pass would wipe the whole corpus).
    let graphScanFailed = false;
    try {
        // Engine-agnostic: bulkListProjected is on both engines, so this no
        // longer needs a Kùzu connection to walk the node table.
        const pager = graph.bulkListProjected?.bind(graph);
        if (pager) {
            // Bounded keyset walk: peak heap is one page of ids, not the whole
            // node table with full content. `embed` is NOT a stored Kùzu column
            // (it's a write-time skip signal that rowToLoreNode never reads
            // back), so the pre-fix listNodes path always saw `undefined` here
            // and never populated graphIdsNonEmbeddable. We project only id and
            // pass `undefined` for embed — byte-identical classification. (The
            // belt-and-suspenders embed:false recheck still lives in the
            // sweeper's per-node getNode/getNodesByIds path.)
            await forEachNodePage(pager, opts.workspace, [], (rows) => {
                for (const r of rows) classify(String(r['id'] ?? ''), undefined);
            });
        } else {
            const nodes = await graph.listNodes(undefined, undefined, opts.workspace, '*', undefined, { unbounded: true });
            for (const n of nodes) classify(n.id, (n as { embed?: boolean }).embed);
        }
    } catch (err) {
        console.error(`[diagnoseConsistency] graph node scan failed: ${(err as Error).message}`);
        graphScanFailed = true;
    }

    // 2. Vector side — every embedding id (stripped of "lore:" prefix).
    // We list by prefix so the diagnostic is workspace-aware on the id
    // namespace, AND we pass `project: opts.workspace` so that when two
    // workspaces alias the same physical lance table (Sprint L5b: the
    // L5b migration registers `atlas` and other names pointing at the
    // default path; per-workspace separation is via the `project`
    // column, not via separate stores), only the rows belonging to THIS
    // workspace are returned. Without the project filter, the other
    // aliased workspace's vectors would be reported as orphans here.
    // Snapshot revs (`lore:<id>#rev<ts>`) are filtered out — they're
    // history rows, not the canonical current row.
    const vectorIds = new Set<string>();
    if (vectorStore) {
        try {
            const raw = await vectorStore.listIds(VECTOR_ID_PREFIX, { project: opts.workspace });
            for (const id of raw) {
                if (!id.startsWith(VECTOR_ID_PREFIX)) continue;
                // Anchored suffix match (audit 5.6) — an id merely
                // CONTAINING '#rev' (URL fragment etc.) is canonical.
                if (isRevisionHistoryId(id)) continue;
                vectorIds.add(id.slice(VECTOR_ID_PREFIX.length));
            }
        } catch (err) {
            console.error(`[diagnoseConsistency] vectorStore.listIds failed: ${(err as Error).message}`);
        }
    }

    // Set-difference both ways.
    // PR #69 P2 fix: missing = embeddable-graph - vector. embed:false
    // nodes are never expected to have a vector, so they're not "missing".
    // Orphans = vector - (embeddable ∪ non-embeddable graph). A vector
    // whose node has `embed:false` is still an orphan-by-policy: the
    // node was once embeddable but isn't anymore, and the vector is
    // stale. Cascade-delete (P3) handles it.
    const missingEmbeddings: string[] = [];
    for (const id of graphIds) if (!vectorIds.has(id)) missingEmbeddings.push(id);
    const orphanEmbeddings: string[] = [];
    for (const id of vectorIds) {
        if (graphIds.has(id)) continue;
        if (graphIdsNonEmbeddable.has(id)) {
            // Treat as orphan — the node exists but is no longer
            // embeddable. The sweeper's cascade-delete will reap it.
        }
        orphanEmbeddings.push(id);
    }

    // 3. SQLite orphan walks — optional.
    const sqliteOrphans: SqliteOrphanReport[] = [];
    const cap = opts.sqliteOrphanCap ?? 100;
    if (tableStorage && opts.sqliteChecks && opts.sqliteChecks.length > 0) {
        for (const check of opts.sqliteChecks) {
            try {
                // We rely on ITableStorage.query (no SELECT DISTINCT in
                // the contract). Pull all rows + project the column in
                // app code. This is fine for diagnostic scale.
                const rows = await tableStorage.query(check.table);
                const seen = new Set<unknown>();
                let truncated = false;
                for (const row of rows) {
                    const v = row[check.column];
                    if (v === null || v === undefined) continue;
                    if (graphIds.has(String(v))) continue;
                    if (seen.has(v)) continue;
                    if (seen.size >= cap) { truncated = true; break; }
                    seen.add(v);
                }
                sqliteOrphans.push({
                    table: check.table,
                    column: check.column,
                    orphans: Array.from(seen),
                    truncated,
                });
            } catch (err) {
                console.error(
                    `[diagnoseConsistency] SQLite check ${check.table}.${check.column} failed: ${(err as Error).message}`,
                );
                sqliteOrphans.push({
                    table: check.table,
                    column: check.column,
                    orphans: [],
                    truncated: false,
                });
            }
        }
    }

    return {
        workspace: opts.workspace,
        computedAt,
        graphNodeCount: graphIds.size,
        vectorEmbeddingCount: vectorIds.size,
        missingEmbeddings,
        orphanEmbeddings,
        sqliteOrphans,
        hasIssues:
            missingEmbeddings.length > 0 ||
            orphanEmbeddings.length > 0 ||
            sqliteOrphans.some(r => r.orphans.length > 0),
        graphScanFailed,
    };
}

/**
 * One-line text summary suitable for logs or admin-UI banners.
 */
export function summarizeReport(report: ConsistencyReport): string {
    const parts: string[] = [];
    parts.push(`workspace=${report.workspace}`);
    parts.push(`graph=${report.graphNodeCount}`);
    parts.push(`vector=${report.vectorEmbeddingCount}`);
    if (report.missingEmbeddings.length > 0) {
        parts.push(`missing_embeddings=${report.missingEmbeddings.length}`);
    }
    if (report.orphanEmbeddings.length > 0) {
        parts.push(`orphan_embeddings=${report.orphanEmbeddings.length}`);
    }
    for (const r of report.sqliteOrphans) {
        if (r.orphans.length > 0) {
            parts.push(`sqlite_orphans:${r.table}.${r.column}=${r.orphans.length}${r.truncated ? '+' : ''}`);
        }
    }
    if (!report.hasIssues) parts.push('OK');
    return parts.join(' ');
}
