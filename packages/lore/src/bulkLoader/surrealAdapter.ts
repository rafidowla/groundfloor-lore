/**
 * bulkLoader/surrealAdapter.ts — SurrealDB-substrate graph loader
 * (Kuzu-removal Phase 3c).
 *
 * The graph-row half of the bulk loader used to exist only as
 * `KuzuBulkLoaderAdapter`: `loaderDispatcher` routed every
 * `graph.node`/`graph.edge` row to it, and the daemon's wiring cast the
 * local graph handle to `LocalGraph` regardless of the workspace's declared
 * engine — so bulk-loading graph rows on a Surreal-backed workspace handed a
 * `SurrealGraph` to a Kùzu adapter that immediately called
 * `.withBulkConnection`, a method the handle does not have. This adapter is
 * the fix's write path; the engine selection that routes to it lives in the
 * daemon wiring (mcp/server.ts `buildDispatcherDeps`), by capability check on
 * the live handle — the same pattern `mcp/bootSteps.ts`'s `buildGraphReaders`
 * established for the schema-safety port.
 *
 * Design rule (same rationale surrealSchemaGraphOps.ts gives for reads):
 * reimplementing a write the engine already implements is how a bulk loader
 * acquires a corruption bug of its own. So this adapter hand-rolls NO
 * SurrealQL — nodes go through `SurrealGraph.bulkUpsertNodes` (batched,
 * per-node error isolation, conflict-retried) and edges through
 * `SurrealGraph.addEdge` (endpoint-checked, deduped per triple,
 * conflict-retried). Those verbs are the engine's tested write path; a bulk
 * load must not bypass them.
 *
 * Row shape: this adapter consumes the SAME `KuzuRow` discriminated union as
 * the Kùzu adapter. The names are Kùzu-flavored but the shapes are the
 * engine-agnostic rows `loadJobsRunner.routeJsonlObject` produces for any
 * graph substrate (id/type/label/content/... and from/to/relationship).
 * `KuzuRow`/`KuzuNodeRow`/`KuzuEdgeRow` + the shared `validateRow` live in
 * `./types.js` (relocated there from kuzuAdapter.ts during the Kuzu removal)
 * so every graph substrate shares one definition.
 *
 * Per-row failure isolation (Sprint Z principle clause 5) mirrors
 * kuzuAdapter exactly: shape validation happens BEFORE any engine call and
 * is reported per row, never thrown; engine-level failures are reported per
 * row in `errors[]` and the batch continues. One deliberate difference,
 * documented here so nobody reads it as drift: a dangling edge (endpoint
 * node missing) is a per-row FAILURE here — SurrealGraph.addEdge refuses
 * missing endpoints loudly (NW-BULK) because SurrealDB's RELATE would create
 * the relation dangling. Kùzu's MERGE silently no-ops the same row and
 * counts it written. The Surreal behavior is stricter, not looser: the row
 * is reported in `errors[]` instead of vanishing while inflating `written`.
 */

import { tagsToArray } from '../engines/normalizeTags.js';
import type { LoreEdge, LoreNode } from '../providers/types.js';
import {
    validateRow,
    type KuzuRow,
    type BulkLoaderAdapter,
    type BulkLoaderOpts,
    type BatchResult,
    type BulkLoaderCheckpoint,
} from './types.js';

/**
 * The narrow SurrealGraph write surface this adapter drives, declared
 * structurally (not as the SurrealGraph class) so tests can fake it and the
 * daemon can pass any handle that grew these verbs — the same testability
 * rationale `KuzuAdapterDeps` has for taking a `withConnection` callback
 * instead of a LocalGraph.
 */
export interface SurrealBulkGraphSurface {
    bulkUpsertNodes(
        batch: Array<Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>>,
    ): Promise<Array<{ id: string; ok: boolean; error?: string }>>;
    addEdge(edge: LoreEdge): Promise<void>;
}

export interface SurrealAdapterDeps {
    graph: SurrealBulkGraphSurface;
}

export class SurrealBulkLoaderAdapter implements BulkLoaderAdapter<KuzuRow> {
    public readonly substrate = 'surreal' as const;
    /** Surfaced for the load.done outbox payload's graphPath field, the
     *  same role KuzuBulkLoaderAdapter.activePath ('copy'|'merge') plays.
     *  There is exactly one write path here, so it is a constant. */
    public readonly activePath = 'bulk_upsert' as const;

    private readonly graph: SurrealBulkGraphSurface;
    private opts: BulkLoaderOpts | null = null;

    constructor(deps: SurrealAdapterDeps) {
        this.graph = deps.graph;
    }

    async begin(opts: BulkLoaderOpts): Promise<void> {
        // No capability probe needed (unlike Kuzu's COPY probe): the
        // engine verbs used here are the same on every SurrealDB build
        // Lore supports.
        this.opts = opts;
    }

    async writeBatch(rows: KuzuRow[]): Promise<BatchResult> {
        if (!this.opts) {
            throw new Error('SurrealBulkLoaderAdapter.writeBatch called before begin()');
        }
        const o = this.opts;
        if (rows.length === 0) {
            return { written: 0, failed: 0, errors: [] };
        }
        const errors: BatchResult['errors'] = [];
        let written = 0;

        // Pass 1 — validate shape before any engine call, per row, exactly
        // the checks + messages the Kùzu adapter applies: this is the SAME
        // validateRow, imported from ./types.js.
        const nodes: Array<{ idx: number; node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> }> = [];
        const edges: Array<{ idx: number; edge: LoreEdge }> = [];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const idx = o.baseRowIndex + i;
            const ve = validateRow(row, o.workspace);
            if (ve) {
                errors.push({ rowIndex: idx, errorMessage: ve });
                continue;
            }
            if (row!.kind === 'node') {
                const n = row!.row;
                nodes.push({
                    idx,
                    // Field coalescing matches the Kùzu MERGE's parameter
                    // binding (row.x ?? ''); tags are normalized with the
                    // same tagsToArray the engine itself uses.
                    node: {
                        id: n.id,
                        type: n.type ?? '',
                        label: n.label ?? '',
                        content: n.content ?? '',
                        tags: tagsToArray(n.tags as string | string[] | null | undefined),
                        project: n.project ?? '',
                        ecosystem: n.ecosystem ?? '',
                        metadata: n.metadata ?? '',
                    },
                });
            } else {
                edges.push({
                    idx,
                    edge: { sourceId: row!.row.from, targetId: row!.row.to, relation: row!.row.relationship },
                });
            }
        }

        // Pass 2 — nodes first, THEN edges, both durable per call. Order
        // matters: SurrealGraph.addEdge refuses a missing endpoint, so an
        // edge whose endpoints are node rows later in this same batch
        // would fail if edges went first. (A JSONL whose edge precedes its
        // endpoints ACROSS batches still fails per-row — same class of
        // hazard the Kùzu path has at its flush boundary, but loud here
        // instead of silently dropped.)
        if (nodes.length > 0) {
            // bulkUpsertNodes returns one result slot per input node, in
            // order (per-node isolation lives in the engine).
            const results = await this.graph.bulkUpsertNodes(nodes.map((n) => n.node));
            for (let i = 0; i < nodes.length; i++) {
                const r = results[i];
                if (r && r.ok) {
                    written++;
                } else {
                    errors.push({
                        rowIndex: nodes[i]!.idx,
                        errorMessage: r?.error?.slice(0, 500) ?? 'surreal_bulk_upsert_failed',
                    });
                }
            }
        }
        // No bulk edge verb exists on SurrealGraph (addEdge's endpoint
        // check + per-triple dedup are per-edge by construction), so edges
        // loop — each failure isolated to its own row.
        for (const e of edges) {
            try {
                await this.graph.addEdge(e.edge);
                written++;
            } catch (err) {
                errors.push({
                    rowIndex: e.idx,
                    errorMessage: (err as Error).message?.slice(0, 500) ?? 'surreal_add_edge_failed',
                });
            }
        }

        // Advance the base offset the way the Kùzu adapter does so
        // checkpoint() reports progress across writeBatch calls.
        this.opts = { ...o, baseRowIndex: o.baseRowIndex + rows.length };
        return { written, failed: errors.length, errors };
    }

    async checkpoint(): Promise<BulkLoaderCheckpoint> {
        const cp = this.opts?.baseRowIndex ?? 0;
        return {
            checkpointRowId: cp,
            offset: cp,
            at: new Date().toISOString(),
        };
    }

    async commit(): Promise<void> {
        // Every engine verb above is durable the moment it resolves
        // (SurrealGraph serializes writes through its per-key chains);
        // there is no open transaction to close.
    }

    async rollback(): Promise<void> {
        // Same contract as the Kùzu adapter: already-written rows are
        // durable, and the runner only calls rollback after a begin()
        // failure. Crash-resume correctness comes from idempotency
        // (node UPSERT, addEdge's per-triple dedup), not rollback.
    }
}

// (validateRow now lives in ./types.js, shared with the Kùzu adapter.)
