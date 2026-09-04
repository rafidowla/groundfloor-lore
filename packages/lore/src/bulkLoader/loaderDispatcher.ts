/**
 * bulkLoader/loaderDispatcher.ts — Sprint Z2 row-type → substrate router.
 *
 * The runner parses temp_file_path into typed rows and hands them to
 * this dispatcher; the dispatcher fans each row out to the appropriate
 * substrate adapter(s):
 *
 *   row.target === 'graph.node'     → the workspace's graph engine
 *                                     adapter — SurrealBulkLoaderAdapter;
 *                                     with none wired, graph rows fail
 *                                     per-row (closed)
 *   row.target === 'graph.edge'     → same graph adapter (edge rows)
 *   row.target === 'verbatim'       → sqlite (text metadata) +
 *                                     lance  (vector mirror)
 *   row.target === 'vector'         → lance only (vector-only load,
 *                                     e.g. backfilling pre-embedded
 *                                     vectors)
 *
 * Routing is per-row (NOT per-format) — a single JSONL file can mix
 * graph nodes, edges, and verbatim documents (each row carries its
 * own target). This matches the Sprint Z principle clause 3 contract
 * that the loader is row-shape-agnostic, not format-bound.
 *
 * The dispatcher accumulates per-substrate buffers and flushes when:
 *   - a buffer reaches FLUSH_THRESHOLD (default 1000)
 *   - the runner calls flushAll() at end-of-file / checkpoint
 *
 * Per-batch results are merged into a single dispatcher-level
 * BatchResult that the runner persists into load_jobs.
 */

import type {
    BatchResult,
    BulkLoaderOpts,
    GraphRow,
    GraphNodeRow,
    GraphEdgeRow,
} from './types.js';
import type { SurrealBulkLoaderAdapter } from './surrealAdapter.js';
import type { SqliteBulkLoaderAdapter, SqliteVerbatimRow } from './sqliteAdapter.js';
import type { LanceBulkLoaderAdapter, LanceRow } from './lanceAdapter.js';
import type { MigrationCoordinator } from '../migration/coordinator.js';

/** Default per-substrate flush threshold. Keeps each per-substrate
 *  writeBatch call bounded so a million-row load doesn't materialize
 *  in JS heap before the first substrate write fires. */
export const FLUSH_THRESHOLD = 1_000;

/** Parsed-row shape — what the runner produces per source line. */
export type ParsedRow =
    | { target: 'graph.node'; row: GraphNodeRow }
    | { target: 'graph.edge'; row: GraphEdgeRow }
    | {
          target: 'verbatim';
          row: {
              id: string;
              text: string;
              workspace: string;
              metadata?: Record<string, unknown>;
          };
      }
    | {
          target: 'vector';
          row: {
              id: string;
              text: string;
              workspace: string;
              metadata?: Record<string, unknown>;
          };
      };

export interface LoaderDispatcherDeps {
    sqlite?: SqliteBulkLoaderAdapter;
    /** The graph-row adapter. The local/embedded graph is Surreal-backed,
     *  selected by the daemon from the live graph handle's capabilities.
     *  With none wired (cloud mode), graph.node/graph.edge rows fail
     *  per-row instead of silently vanishing. */
    surreal?: SurrealBulkLoaderAdapter;
    lance?: LanceBulkLoaderAdapter;
    flushThreshold?: number;
    /** Sprint H2 — optional MigrationCoordinator reference. When present,
     *  each dispatched row consults `coordinator.dualWriteActiveFor(table,
     *  column)` for the row's substrate target. If a Phase-2 (migrate)
     *  window is active for a metadata key, the dispatcher mirrors the
     *  value to the new key so writes during the backfill are not lost.
     *  Unset = no mirroring (behavior identical to pre-H2). */
    migrationCoordinator?: MigrationCoordinator;
}

export class LoaderDispatcher {
    private readonly sqlite?: SqliteBulkLoaderAdapter;
    /** The workspace's graph engine adapter; graph.node and graph.edge
     *  rows both route here (SurrealBulkLoaderAdapter). */
    private readonly graph?: SurrealBulkLoaderAdapter;
    private readonly lance?: LanceBulkLoaderAdapter;
    private readonly flushThreshold: number;

    private graphBuf: GraphRow[] = [];
    private sqliteBuf: SqliteVerbatimRow[] = [];
    private lanceBuf: LanceRow[] = [];
    /** Parallel to lanceBuf: true when this row COUNTS toward the
     *  source-row `written` total. Audit cluster 5 (2026-08-17): a
     *  verbatim row is mirrored to BOTH sqlite and lance, and both
     *  adapters' `written` used to merge — double-counting every
     *  verbatim row in rows_processed. Canonical attribution:
     *  graph rows count via the graph adapter, verbatim via sqlite (or
     *  when no sqlite adapter is wired), vector rows via lance. */
    private lanceCountable: boolean[] = [];

    private opts: BulkLoaderOpts | null = null;
    /** Cumulative result across all batches dispatched this session. */
    private cumulative: BatchResult = { written: 0, failed: 0, errors: [] };

    private readonly migrationCoordinator?: MigrationCoordinator;

    constructor(deps: LoaderDispatcherDeps) {
        this.sqlite = deps.sqlite;
        this.graph = deps.surreal;
        this.lance = deps.lance;
        this.flushThreshold = Math.max(1, deps.flushThreshold ?? FLUSH_THRESHOLD);
        this.migrationCoordinator = deps.migrationCoordinator;
    }

    /**
     * Sprint H2 — augment a row's metadata bag with mirrored values for
     * any active Phase-2 (migrate) dual-write window matching the row's
     * substrate + (synthetic) table.
     *
     * Mapping decisions:
     *   - graph.node/graph.edge rows → never mirrored: dual-write windows
     *     are keyed by SubstrateName (migration/types.ts), a local-substrate
     *     vocabulary that has no 'surreal' entry.
     *   - verbatim → substrate=sqlite + lance (mirror both); "table" =
     *     'verbatim'. Metadata bag carries optional fields.
     *   - vector → substrate=lance; "table" = 'vector'.
     *
     * For each metadata key in the bag, if dualWriteActiveFor(table, key)
     * returns a state, set bag[state.toColumn] = bag[key] when toColumn is
     * absent. Idempotent: a row that already carries both keys is
     * untouched. No-op when migrationCoordinator is undefined.
     */
    private mirrorForDualWrite(
        substrate: 'sqlite' | 'lance' | undefined,
        table: string,
        bag: Record<string, unknown> | undefined,
    ): Record<string, unknown> | undefined {
        if (!this.migrationCoordinator || !bag || substrate === undefined) return bag;
        let mutated = bag;
        for (const key of Object.keys(bag)) {
            const dw = this.migrationCoordinator.dualWriteActiveFor(table, key, substrate);
            if (dw && mutated[dw.toColumn] === undefined) {
                if (mutated === bag) mutated = { ...bag };
                mutated[dw.toColumn] = bag[key];
            }
        }
        return mutated;
    }

    async begin(opts: BulkLoaderOpts): Promise<void> {
        this.opts = opts;
        // Per-substrate baseRowIndex needs to be tracked
        // INDIVIDUALLY because each adapter advances its own offset
        // when writeBatch runs. We track them via the buffer-flush
        // bookkeeping below.
        if (this.sqlite) await this.sqlite.begin(opts);
        if (this.graph) await this.graph.begin(opts);
        if (this.lance) await this.lance.begin(opts);
    }

    /** Push a single parsed row through routing. The row's absolute
     *  rowIndex within the job is `opts.baseRowIndex + nDispatched`
     *  — the dispatcher tracks this internally and surfaces it via
     *  per-row errors. */
    async dispatch(parsed: ParsedRow, rowIndex: number): Promise<void> {
        if (!this.opts) {
            throw new Error('LoaderDispatcher.dispatch called before begin()');
        }
        switch (parsed.target) {
            case 'graph.node': {
                if (!this.graph) {
                    this.failGraphRowClosed(rowIndex);
                    return;
                }
                this.graphBuf.push({ kind: 'node', row: parsed.row });
                break;
            }
            case 'graph.edge': {
                if (!this.graph) {
                    this.failGraphRowClosed(rowIndex);
                    return;
                }
                this.graphBuf.push({ kind: 'edge', row: parsed.row });
                break;
            }
            case 'verbatim': {
                // Verbatim → SQLite (metadata) + LanceDB (vector).
                const sqMeta = this.mirrorForDualWrite('sqlite', 'verbatim', parsed.row.metadata);
                const laMeta = this.mirrorForDualWrite('lance', 'verbatim', parsed.row.metadata);
                this.sqliteBuf.push({
                    id: parsed.row.id,
                    text: parsed.row.text,
                    metadata: sqMeta,
                    workspace: parsed.row.workspace,
                });
                this.lanceBuf.push({
                    id: parsed.row.id,
                    text: parsed.row.text,
                    workspace: parsed.row.workspace,
                    metadata: laMeta,
                });
                // Count the SOURCE row once: via sqlite when wired, else lance.
                this.lanceCountable.push(!this.sqlite);
                break;
            }
            case 'vector': {
                const laMeta = this.mirrorForDualWrite('lance', 'vector', parsed.row.metadata);
                this.lanceBuf.push({
                    id: parsed.row.id,
                    text: parsed.row.text,
                    workspace: parsed.row.workspace,
                    metadata: laMeta,
                });
                this.lanceCountable.push(true);
                break;
            }
            default:
                // Unknown target — record + skip.
                this.cumulative.errors.push({
                    rowIndex,
                    errorMessage: `unknown_target ${(parsed as { target?: string }).target}`,
                });
                this.cumulative.failed++;
                return;
        }
        // Opportunistic flush — keep each substrate buffer bounded.
        if (this.graphBuf.length >= this.flushThreshold) await this.flushGraph();
        if (this.sqliteBuf.length >= this.flushThreshold) await this.flushSqlite();
        if (this.lanceBuf.length >= this.flushThreshold) await this.flushLance();
    }

    async flushAll(): Promise<BatchResult> {
        await this.flushGraph();
        await this.flushSqlite();
        await this.flushLance();
        return { ...this.cumulative, errors: this.cumulative.errors.slice() };
    }

    /** Snapshot the running cumulative without flushing. Used by tests
     *  + the runner for progress reporting between checkpoints. */
    snapshot(): BatchResult {
        return { ...this.cumulative, errors: this.cumulative.errors.slice() };
    }

    /** Phase 3c fail-closed: a graph row arrives with NO graph adapter
     *  wired (cloud mode's DataplaneGraph exposes neither bulk surface, or
     *  local wiring declined to build one). The pre-3c dispatcher silently
     *  dropped these in the flush guard — a load job could report success
     *  while its graph rows vanished. They are per-row failures now,
     *  surfaced in BatchResult.errors like every other bad row. */
    private failGraphRowClosed(rowIndex: number): void {
        this.cumulative.errors.push({
            rowIndex,
            errorMessage: 'graph_target_unsupported (no graph adapter wired — graph.node/graph.edge rows need a SurrealDB graph handle)',
        });
        this.cumulative.failed++;
    }

    private async flushGraph(): Promise<void> {
        if (!this.graph || this.graphBuf.length === 0) {
            this.graphBuf = [];
            return;
        }
        const batch = this.graphBuf;
        this.graphBuf = [];
        const r = await this.graph.writeBatch(batch);
        this.mergeResult(r);
    }

    private async flushSqlite(): Promise<void> {
        if (!this.sqlite || this.sqliteBuf.length === 0) {
            this.sqliteBuf = [];
            return;
        }
        const batch = this.sqliteBuf;
        this.sqliteBuf = [];
        const r = await this.sqlite.writeBatch(batch);
        this.mergeResult(r);
    }

    private async flushLance(): Promise<void> {
        if (!this.lance || this.lanceBuf.length === 0) {
            this.lanceBuf = [];
            this.lanceCountable = [];
            return;
        }
        const batch = this.lanceBuf;
        const tags = this.lanceCountable;
        this.lanceBuf = [];
        this.lanceCountable = [];
        // Partition by attribution so only countable rows add to `written`
        // (verbatim mirrors are counted via sqlite — audit cluster 5).
        const countable: LanceRow[] = [];
        const mirror: LanceRow[] = [];
        for (let i = 0; i < batch.length; i++) {
            (tags[i] ? countable : mirror).push(batch[i]!);
        }
        if (mirror.length > 0) this.mergeResult(await this.lance.writeBatch(mirror), false);
        if (countable.length > 0) this.mergeResult(await this.lance.writeBatch(countable), true);
    }

    private mergeResult(r: BatchResult, countWritten: boolean = true): void {
        if (countWritten) this.cumulative.written += r.written;
        this.cumulative.failed += r.failed;
        for (const e of r.errors) this.cumulative.errors.push(e);
    }

    async commit(): Promise<void> {
        if (this.sqlite) await this.sqlite.commit();
        if (this.graph) await this.graph.commit();
        if (this.lance) await this.lance.commit();
    }

    async rollback(): Promise<void> {
        this.graphBuf = [];
        this.sqliteBuf = [];
        this.lanceBuf = [];
        this.lanceCountable = [];
        if (this.sqlite) await this.sqlite.rollback();
        if (this.graph) await this.graph.rollback();
        if (this.lance) await this.lance.rollback();
    }
}
