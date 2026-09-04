/**
 * outbox/wiring.ts — daemon-side wiring for the outbox + recovery.
 *
 * Extracted from server.ts to keep that file's size budget in check.
 *
 * What this gives the daemon:
 *   - `FileOutboxStore` at <workspace>/.lore/outbox.json
 *   - Handler registry pre-loaded with the integrated step kinds
 *     (right now: `sync.vector.mirror` from syncEngine.pullRemote)
 *   - A single `runBootRecovery()` that walks unfinished entries and
 *     logs the result. Caller invokes once during main() boot.
 *
 * Sprint O1 (2026-05-24) — also wires the replicator service. The
 * replicator is constructed here but NOT started; the daemon's
 * main() calls `replicator.start()` after boot recovery completes.
 * Tests construct `wireOutbox()` and never call start() — the
 * replicator stays dormant so test-mode invariants hold.
 */

import type { LoreNode, LoreEdge } from '../providers/types.js';
import type { SyncEngine } from '../engines/syncEngine.js';
import type { WorkspaceGraph } from '../engines/openWorkspaceGraph.js';
import type { VerbatimStore } from '../engines/verbatimStore.js';
import type { EmbeddingProvider } from '../providers/types.js';
import type { BatchedEmbedder } from '../embed/batchedEmbedder.js';
import { batchedEmbedderFor } from '../embed/batchedEmbedder.js';
import { computeContentHash } from '../engines/contentHash.js';
import { normaliseEcosystem } from '../core/bulkNodeScope.js';
import { withNodeLock, withNodeLocks, withEdgeLock } from '../core/nodeWriteLock.js';
import { FileOutboxStore } from './store.js';
import { SqliteOutboxStore } from './sqliteStore.js';
import type { OutboxStore as IOutboxStore } from './types.js';
import {
    InMemoryOutboxHandlerRegistry,
    recoverOutbox,
} from './recovery.js';
import type { DispatcherSubstrates } from './dispatcher.js';
import { OutboxReplicator, wireReplicator, readEnvSelfHealConfig, readEnvPollConfig } from './replicator.js';
import { OutboxLagCache, readEnvLagCacheConfig } from './lagCache.js';
import { loadWorkspaces } from '../config/workspaces.js';

export interface OutboxWiring {
    /** Active store — SqliteOutboxStore by default (O3c+) or
     *  FileOutboxStore when LORE_OUTBOX_BACKEND=json (emergency
     *  rollback). Both implement the same OutboxStore interface. */
    store: IOutboxStore;
    handlers: InMemoryOutboxHandlerRegistry;
    runBootRecovery: () => Promise<void>;
    /** Sprint O1 — replicator service. Constructed in stopped state;
     *  the daemon calls `.start()` after boot recovery. Tests can use
     *  `.tickOnce()` for deterministic single-step exercise without
     *  starting the loop. */
    replicator: OutboxReplicator;
    /** Sprint O4 — per-workspace lag cache the replicator refreshes
     *  and the hot/bulk routes read on the request path. Exposed so the
     *  HTTP dispatcher can thread it into route deps. */
    lagCache: OutboxLagCache;
}

export function wireOutbox(input: {
    loreDir: string;
    /** SyncEngine getter (closure since the daemon's syncEngine is
     *  mutable — keychain upgrade rebinds it). */
    getSyncEngine: () => SyncEngine;
    /** Sprint O2 — graph + verbatim substrate getters used by the
     * replicator to fan out hot-lane outbox rows. Optional so test
     * wirings that only exercise sync.vector.mirror can omit them.
     * Local mode passes the boot-bound WorkspaceGraph + VerbatimStore;
     * cloud mode leaves them undefined (cloud writes don't route
     * through this outbox today). */
    getGraph?: () => WorkspaceGraph;
    getVerbatim?: () => VerbatimStore;
    /** SP-F2 (2026-06-10) — embedding-provider getter used to wire the
     *  dispatcher's `embed.batch` substrates (batchedEmbedder +
     *  storeEmbedBatch). Before this, NO production wiring supplied
     *  them, so every embed.batch row produced by POST /api/nodes/bulk
     *  (default embed mode 'queued') and by re-embed jobs dead-lettered
     *  instantly with UnwiredOperationKindError. Optional: cloud mode
     *  and legacy test wirings omit it (embed.batch then dead-letters
     *  as before, which only ever happens for wirings with no local
     *  substrates anyway). Getter (not value) to match the
     *  getGraph/getVerbatim closure convention. */
    getEmbedder?: () => EmbeddingProvider;
    /** SP-F3 (2026-06-10) — per-workspace graph resolver. When supplied
     * (local mode, post-boot), the replicator routes each row's substrate
     * write to `getGraphForWorkspace(entry.workspace)` instead of the
     * boot-bound graph, closing the cross-workspace replay-contamination
     * bug. Returns a getter for a resolver (not the resolver directly)
     * because the LocalGraphRegistry is constructed inside main() AFTER
     * wireOutbox runs at module-eval — same lazy-closure convention as
     * getGraph. Falls back to the boot graph when the resolver is absent,
     * the workspace is undefined (legacy rows), or resolution throws. */
    getGraphForWorkspace?: () => ((workspace: string) => Promise<WorkspaceGraph>) | undefined;
    /** SP-F3 — per-workspace verbatim resolver (mirrors the graph one).
     *  Closes the gap localGraphRegistry.ts:20-21 documents (verbatim was
     *  left global). Falls back to the boot verbatim store when absent /
     *  workspace undefined / resolution throws. */
    getVerbatimForWorkspace?: () => ((workspace: string) => Promise<VerbatimStore>) | undefined;
}): OutboxWiring {
    // SP-F3 — resolve the TARGET workspace's graph for a replayed row.
    // Falls back to the boot-bound graph when: no resolver wired (cloud /
    // legacy test wirings), no workspace on the row (pre-Sprint-L rows),
    // or resolution throws (transiently-missing workspace entry — the
    // boot graph is the safest fallback and keeps prior behavior). The
    // resolver getter is read fresh each call so a registry that becomes
    // available after boot is picked up without re-wiring.
    const resolveGraph = async (workspace?: string): Promise<WorkspaceGraph> => {
        const boot = input.getGraph!();
        if (!workspace) return boot;
        const resolver = input.getGraphForWorkspace?.();
        if (!resolver) return boot;
        // R2 #2 — a workspace-scoped row MUST route to ITS workspace. The boot
        // graph is the right fallback ONLY when the row carries no workspace
        // (legacy) or no per-workspace router is wired (handled above). If the
        // resolver THROWS (workspace transiently missing / removed-from-
        // workspaces.json / graph-open failure), do NOT fall back to boot:
        // that applies a FOREIGN tenant's node/edge/vector write to the boot
        // workspace's graph engine+LanceDB — a silent cross-workspace isolation breach
        // — and because the misrouted write SUCCEEDS the replicator marks the
        // row replicated and drains it, so it is never retried against the
        // correct workspace (permanent misplacement). Propagate instead: the
        // row stays pending and replays once the workspace resolves, or
        // eventually dead-letters (operator-visible) — never misrouted.
        // Isolation is the load-bearing local-mode contract (CLAUDE.md).
        try {
            return await resolver(workspace);
        } catch (err) {
            console.error(`[outbox] graph resolve for workspace "${workspace}" failed; leaving row PENDING for retry (NOT routing to boot, to preserve workspace isolation): ${(err as Error).message}`);
            throw err;
        }
    };
    const resolveVerbatim = async (workspace?: string): Promise<VerbatimStore> => {
        const boot = input.getVerbatim!();
        if (!workspace) return boot;
        const resolver = input.getVerbatimForWorkspace?.();
        if (!resolver) return boot;
        // R2 #2 — same isolation contract as resolveGraph: never fall back to
        // the boot store for a workspace-scoped row whose resolver throws, or a
        // foreign tenant's verbatim (vector) bodies land in the boot LanceDB.
        try {
            return await resolver(workspace);
        } catch (err) {
            console.error(`[outbox] verbatim resolve for workspace "${workspace}" failed; leaving row PENDING for retry (NOT routing to boot store, to preserve workspace isolation): ${(err as Error).message}`);
            throw err;
        }
    };
    // Sprint O3c — backend selection. SQLite is the default; 'json'
    // forces the legacy FileOutboxStore (kept for one release as
    // emergency rollback per the O3c spec).
    const backend = (process.env.LORE_OUTBOX_BACKEND ?? 'sqlite').toLowerCase();
    let store: IOutboxStore;
    if (backend === 'json') {
        store = new FileOutboxStore(input.loreDir);
    } else {
        const sqliteStore = new SqliteOutboxStore(input.loreDir);
        // Auto-migrate outbox.json → SQLite on first boot. Idempotent.
        try {
            const report = sqliteStore.migrateFromJson();
            if (report.migratedEntries > 0 || report.error) {
                console.error(
                    `[outbox-sqlite] migrate: entries=${report.migratedEntries}, ` +
                    `repl=${report.migratedRepl}, ms=${report.durationMs}` +
                    (report.renamedTo ? `, renamed=${report.renamedTo}` : '') +
                    (report.error ? `, error=${report.error}` : '') +
                    (report.rolledBack ? `, rolledBack=true` : ''),
                );
            }
        } catch (err) {
            console.error(`[outbox-sqlite] migrate threw (non-fatal): ${(err as Error).message}`);
        }
        store = sqliteStore;
    }
    const handlers = new InMemoryOutboxHandlerRegistry();

    handlers.register('sync.vector.mirror', async (payload) => {
        const ids = Array.isArray((payload as { nodeIds?: unknown[] } | undefined)?.nodeIds)
            ? (payload as { nodeIds: unknown[] }).nodeIds.filter((x): x is string => typeof x === 'string')
            : [];
        if (ids.length === 0) return;
        const r = await input.getSyncEngine().recoverVectorMirror(ids);
        console.error(
            `[outbox] sync.vector.mirror recovery: ${r.recovered} re-mirrored, ${r.skipped} skipped`,
        );
    });

    async function runBootRecovery(): Promise<void> {
        try {
            const report = await recoverOutbox(store, handlers);
            if (report.discovered > 0) {
                console.error(
                    `[outbox] boot recovery: ${report.completed}/${report.discovered} entries finished; ` +
                    `${report.stillUnfinished.length} still pending`,
                );
                for (const f of report.stepFailures) {
                    console.error(`[outbox] step failure ${f.entryId}/${f.kind}: ${f.error}`);
                }
            }
        } catch (recErr) {
            console.error(`[outbox] boot recovery threw (non-fatal): ${(recErr as Error).message}`);
        }
    }

    // Sprint O1 — replicator substrates. O1 wires only the existing
    // sync.vector.mirror path (which the legacy handler also covers
    // — they overlap by design: boot recovery handles crashed-mid-step
    // entries, the replicator handles steady-state delivery once O2
    // starts producing new-shape rows). Other kinds throw
    // UnwiredOperationKindError until O2/O3 wires the producer side.
    const substrates: DispatcherSubstrates = {
        syncVectorMirror: async (payload) => {
            if (payload.nodeIds.length === 0) return;
            const r = await input.getSyncEngine().recoverVectorMirror(payload.nodeIds);
            console.error(
                `[outbox replicator] sync.vector.mirror: ${r.recovered} mirrored, ${r.skipped} skipped`,
            );
        },
        // Sprint O2 — graph fan-out for hot-lane node + edge writes.
        // Wired only when caller supplies getGraph (local mode).
        ...(input.getGraph ? {
            // The replay takes the SAME per-(workspace,id) lock the live write
            // paths hold (core/nodeWriteLock.ts). Without it a replayed
            // node.upsert / node.delete could interleave with a live same-id
            // write and re-assert a state the caller had already superseded —
            // the replicator's whole premise (idempotent re-assertion) only
            // holds if no live write is mid-sequence for that id. The
            // replicator runs on its own background loop and `recordHotWrite`
            // never dispatches inline, so this can never be entered from
            // inside a lock (nodeWriteLock.ts rule 1). A legacy row with no
            // workspace keys on '' — those rows predate per-workspace routing
            // and go to the boot graph, so there is no better key available.
            upsertNode: async (payload: Record<string, unknown>, workspace?: string) => {
                const g = await resolveGraph(workspace);
                const id = String((payload as { id?: unknown }).id ?? '');
                await withNodeLock(workspace ?? '', id, () => g.upsertNode(payload as unknown as LoreNode));
            },
            // Round-E X-edges — edges now DO take a lock: a per-triple one
            // (core/nodeWriteLock.ts `withEdgeLock`), keyed on
            // (sourceId, targetId, relation) rather than a node id. The
            // earlier note here ("edges are deliberately NOT locked")
            // predates that lock's existence and was reasoning about the
            // NODE lock specifically (correct: an edge write touches no
            // verbatim mirror, so it never needed the node lock) — it did
            // not mean edges needed no serialization of their own. Without
            // this, a replayed edge.upsert could interleave with a live
            // same-triple store_edge/delete_edge/REST write and re-assert a
            // state the live write had already superseded. Same
            // never-entered-from-inside-a-lock guarantee as the node
            // substrates above: `recordHotWrite` never dispatches inline.
            addEdge: async (payload: Record<string, unknown>, workspace?: string) => {
                const g = await resolveGraph(workspace);
                const p = payload as unknown as LoreEdge;
                await withEdgeLock(workspace ?? '', p.sourceId, p.targetId, p.relation, () => g.addEdge(p));
            },
            deleteNode: async (id: string, workspace?: string) => {
                const g = await resolveGraph(workspace);
                await withNodeLock(workspace ?? '', id, () => g.deleteNode(id));
            },
            // 2026-09-03 (X-markstale audit fix) — replay of a
            // `node.mark_stale` chunk row. Takes the SAME per-(workspace,id)
            // locks the live mark_stale entry points hold for this chunk
            // (mcp/tools/memory/markStale.ts, POST /api/mark-stale) so a
            // replay can't interleave with a live write on any id in the
            // chunk — same rationale as upsertNode/deleteNode above.
            markStale: async (ids: string[], workspace?: string) => {
                const g = await resolveGraph(workspace);
                await withNodeLocks(workspace ?? '', ids, () => g.markStaleByIds(ids));
            },
            deleteEdge: async (payload, workspace?: string) => {
                const g = await resolveGraph(workspace);
                if (typeof (g as unknown as { deleteEdge?: unknown }).deleteEdge === 'function') {
                    const delGraph = g as unknown as {
                        deleteEdge: (s: string, t: string, r: string) => Promise<number>;
                    };
                    await withEdgeLock(
                        workspace ?? '', payload.sourceId, payload.targetId, payload.relation,
                        () => delGraph.deleteEdge(payload.sourceId, payload.targetId, payload.relation),
                    );
                }
            },
        } : {}),
        // Sprint O2 — verbatim fan-out for hot-lane verbatim writes.
        // Replaces the in-line `loreVerbatim.store(...)` calls that
        // used to run on the HTTP request path (gate O-D3).
        ...(input.getVerbatim ? {
            upsertVerbatim: async (payload: Record<string, unknown>, workspace?: string) => {
                const id = String(payload['id'] ?? '');
                const text = String(payload['text'] ?? '');
                const metadata = (payload['metadata'] as Record<string, unknown>) ?? {};
                if (!id) return;
                const v = await resolveVerbatim(workspace);
                await v.store({ id, text, metadata });
            },
            // 2026-09-03 (A2 finding 2 fix) — verbatim tombstone fan-out for
            // every node-delete path's `verbatim.tombstone` outbox row (see
            // outbox/types.ts). `tombstone()` is itself idempotent (a
            // no-op on an already-tombstoned or already-absent row — see
            // VerbatimStore.tombstone), so replaying it is safe.
            tombstoneVerbatim: async (id: string, reason: string, workspace?: string) => {
                const v = await resolveVerbatim(workspace);
                await v.tombstone(id, reason);
            },
            // SP-13 — consolidated verbatim upsert. The replicator merges a
            // run of adjacent verbatim.upsert rows into one of these so
            // storeBatch writes a single LanceDB fragment for the whole run
            // instead of one per row (per-row write-amplification fix). Each
            // item carries the same { id, text, metadata } shape as the
            // single-row payload above.
            upsertVerbatimBatch: async (payload: { items: Array<Record<string, unknown>> }, workspace?: string) => {
                const docs = payload.items
                    .map((it) => ({
                        id: String(it['id'] ?? ''),
                        text: String(it['text'] ?? ''),
                        metadata: (it['metadata'] as Record<string, unknown>) ?? {},
                    }))
                    .filter((d) => d.id);
                if (docs.length === 0) return;
                const v = await resolveVerbatim(workspace);
                await v.storeBatch(docs);
            },
            // 2026-06-09 half-completion reaper. When the outbox marks a
            // node.upsert entry dead, the hot-lane verbatim row that was
            // written before the graph upsert failed becomes a permanent
            // orphan (vector with no node anywhere). Wiring physicalDelete
            // here lets the replicator reap it after exhausting retries.
            physicalDeleteVerbatim: async (id: string, workspace?: string) => {
                const v = await resolveVerbatim(workspace);
                await v.physicalDelete(id);
            },
        } : {}),
        // SP-F2 (2026-06-10) — embed.batch fan-out. Wires the
        // BatchedEmbedder (vectors) + a storeEmbedBatch hook that
        // persists complete verbatim rows. Without these, the
        // dispatcher's embed.batch branch threw
        // UnwiredOperationKindError and the replicator dead-lettered
        // every queued-mode bulk write's embed row on first dispatch.
        //
        // storeEmbedBatch semantics:
        //   - The row's text is the exact text that was embedded
        //     (threaded through dispatch — see dispatcher.ts), so the
        //     stored vector always matches the stored text.
        //   - Metadata is enriched from the current graph node (same
        //     fields the async embed-queue executor writes). A node
        //     deleted between enqueue and dispatch is skipped — never
        //     write an orphan vector (the dead-letter reaper exists
        //     precisely to remove those). embed:false nodes are skipped
        //     as defence in depth, mirroring embed/wiring.ts.
        //   - Persisted via bulkUpsertPrebuiltRows — an ATOMIC
        //     mergeInsert('id') (SW-03/B4). Was physicalDeleteMany +
        //     bulkAddPrebuiltRows (replace-then-add): a crash between the
        //     delete and the add lost the canonical vectors with no
        //     re-add, so the nodes vanished from /api/recall until a full
        //     re-embed. The atomic upsert leaves the old OR new row, never
        //     neither. Still bypasses rev-history snapshots, which is
        //     correct for first-write (queued bulk rows have no prior
        //     verbatim row) and acceptable for re-embed (same id,
        //     refreshed vector).
        ...(input.getEmbedder && input.getVerbatim ? {
            // Lazy delegating wrapper so a rebound provider (closure
            // convention) is picked up without re-wiring. Construction
            // of ProviderBatchedEmbedder is stateless/cheap.
            batchedEmbedder: {
                embedBatch: (texts: string[]) => batchedEmbedderFor(input.getEmbedder!()).embedBatch(texts),
                maxBatchSize: () => batchedEmbedderFor(input.getEmbedder!()).maxBatchSize(),
                get dimension(): number { return input.getEmbedder!().dimension; },
                get modelId(): string { return input.getEmbedder!().modelId; },
            } as BatchedEmbedder,
            storeEmbedBatch: async (p: { targetNodeIds: string[]; vectors: number[][]; texts?: string[] }, workspace?: string) => {
                const verbatim = await resolveVerbatim(workspace);
                const graph = input.getGraph ? await resolveGraph(workspace) : undefined;
                const rows: Array<Record<string, unknown>> = [];
                for (let i = 0; i < p.targetNodeIds.length; i++) {
                    const vid = p.targetNodeIds[i];
                    const vector = p.vectors[i];
                    const text = p.texts?.[i];
                    if (typeof vid !== 'string' || !vid || !Array.isArray(vector) || typeof text !== 'string') continue;
                    const nodeId = vid.startsWith('lore:') ? vid.slice('lore:'.length) : vid;
                    let node: LoreNode | null = null;
                    if (graph) {
                        try { node = await graph.getNode(nodeId); } catch (err) {
                            // M11 (2026-08-17, cluster-1) — a TRANSIENT graph
                            // read error is NOT "node deleted". Swallowing it
                            // into `null` silently dropped the embed (the
                            // `continue` below) while the outbox row was still
                            // marked replicated, so it was never retried.
                            // Rethrow so the dispatcher fails the row and the
                            // replicator retries it.
                            throw new Error(
                                `storeEmbedBatch: graph.getNode(${nodeId}) failed — ` +
                                `refusing to drop the embed as if the node were deleted: ${(err as Error).message}`,
                            );
                        }
                        if (!node) continue; // deleted since enqueue — no orphan vectors
                        if ((node as { embed?: boolean }).embed === false) continue;
                    }
                    rows.push({
                        vector,
                        id: vid,
                        text,
                        type: node?.type ?? '',
                        label: node?.label ?? '',
                        tags: node?.tags ?? '',
                        // ─── The no-graph fallback path, stated accurately ───
                        //
                        // `node` is only fetched `if (graph)`, i.e. when
                        // `input.getGraph` is wired. All THREE production
                        // `wireOutbox` call sites wire it (mcp/server.ts,
                        // cli/commands/embed.ts, cli/commands/outbox.ts), so on
                        // the shipped paths `node` is always present and none of
                        // these fallbacks is reachable. They exist because
                        // `getGraph` is OPTIONAL on the input type — a library
                        // consumer or a test can construct the wiring without
                        // it — and a partially-wired instance must still write a
                        // row this codebase's other readers can interpret.
                        //
                        // Given that, the fallbacks must spell "unset" the way
                        // core/bulkNodeScope.ts defines it, not invent a third
                        // spelling each:
                        //   - `project` is the workspace BY INVARIANT
                        //     (core/nodeService.ts enforces it) because
                        //     GET /api/stats?workspace=<ws> counts rows with
                        //     project === <ws>. `''` breaks that invariant
                        //     outright — strictly worse than the ecosystem
                        //     drift, and the documented cause of stats
                        //     under-counting. `workspace` is the value the
                        //     dispatcher already routed this batch by, so it is
                        //     the correct fallback; `'*'` only when even that is
                        //     absent.
                        //   - `ecosystem` normalises to `'*'`. Note what this
                        //     does and does not buy: `'*'` is NOT more matchable
                        //     than `''` by an `ecosystem = 'acme'` pushdown —
                        //     VerbatimStore builds a strict-equality predicate,
                        //     so both miss. What it buys is CONSISTENCY with
                        //     every other verbatim writer, which is what lets
                        //     reconnect.ts and retrieve.ts treat `'*'` as the
                        //     one recognisable "unset/wildcard" marker instead
                        //     of having to special-case a per-writer spelling.
                        project: node?.project ?? workspace ?? '*',
                        ecosystem: normaliseEcosystem(node?.ecosystem),
                        updatedAt: node?.updatedAt ?? '',
                        security_scopes: node?.security_scopes ?? [],
                        contentHash: computeContentHash(text),
                    });
                }
                if (rows.length === 0) return;
                // SW-03 (B4) — atomic replace: no window where the old
                // vectors are deleted but the new ones not yet re-added.
                await verbatim.bulkUpsertPrebuiltRows(rows);
            },
        } : {}),
        // Sprint O6 (2026-05-24) — verifier hooks for self-heal +
        // operator drain-failed. Each is an indexed substrate probe:
        //   hasNode       → LoreGraphHandle.getNode (PK lookup)
        //   hasEdge       → LoreGraphHandle.queryEdges on (src, tgt, relation) triple
        //   hasVerbatim   → VerbatimStore.getById (lance id query)
        //   hasEmbeddings → all targetNodeIds have a verbatim row
        //
        // Only wired when the caller supplies the substrate getter.
        // Tests can construct an OutboxReplicator directly with stub
        // hooks and exercise self-heal without touching the daemon
        // wiring path.
        ...(input.getGraph ? {
            hasNode: async (id: string, workspace?: string): Promise<boolean> => {
                // 2026-08-17 (launch blocker): DO NOT swallow substrate errors
                // into `false`. The self-heal verifier treats `false` as
                // "confirmed absent" for node.delete/edge.delete, so a transient
                // graph error here would mark a delete 'replicated' that never
                // actually happened. Propagate the error — verifyApplied's
                // outer catch turns it into `verified:false`, leaving the
                // delete failed (fail-closed).
                const g = await resolveGraph(workspace);
                const node = await g.getNode(id);
                return node !== null && node !== undefined;
            },
            // 2026-08-10 — was a `getGraphContext()` escape hatch tied to a
            // single local engine, undefined on every other engine (SurrealGraph,
            // DataplaneGraph), so `ctx` was always undefined there and hasEdge ALWAYS returned
            // false — self-heal could never confirm a real edge on a
            // Surreal-backed workspace, so it endlessly believed the edge was
            // missing. `queryEdges` is on `LoreGraphHandle` (non-optional) and
            // every engine implements it with byte-for-byte identical filter
            // semantics to the old hand-written Cypher (a.id=$source,
            // b.id=$target, e.relation=$relation) — see graphEdges.ts,
            // surrealGraphAggregates.ts, dataplaneGraph.ts. limit:1 is enough
            // to answer an existence check.
            hasEdge: async (p: { sourceId: string; targetId: string; relation: string }, workspace?: string): Promise<boolean> => {
                // 2026-08-17: same fail-closed contract as hasNode above — a
                // swallowed error here would self-heal-confirm an edge.delete
                // that never applied.
                const g = await resolveGraph(workspace);
                const rows = await g.queryEdges({
                    source: p.sourceId, target: p.targetId, relation: p.relation,
                    limit: 1, offset: 0,
                });
                return rows.length > 0;
            },
            // 2.4 (2026-08-17) — content witness for node.upsert self-heal:
            // hand verifyApplied the stored node record so it can compare the
            // payload's content-bearing fields. Existence alone (hasNode)
            // silently discarded failed UPDATES — the entity exists whether
            // or not the edit landed. Errors propagate (fail-closed), same
            // contract as hasNode.
            getNode: async (id: string, workspace?: string): Promise<Record<string, unknown> | null> => {
                const g = await resolveGraph(workspace);
                return (await g.getNode(id)) as unknown as Record<string, unknown> | null;
            },
        } : {}),
        ...(input.getVerbatim ? {
            // 2.4 (2026-08-17) — content witness for
            // verbatim.upsert / verbatim.upsert.batch / embed.batch self-heal.
            // getById returns the stored { contentHash, text }; verifyApplied
            // compares it against the hash the payload would persist. Errors
            // propagate (fail-closed) — verifyApplied's outer catch degrades
            // them to verified:false.
            getVerbatim: async (id: string, workspace?: string): Promise<{ contentHash?: string; text?: string } | null> => {
                const v = (await resolveVerbatim(workspace)) as unknown as {
                    getById?: (id: string) => Promise<{ contentHash?: string; text?: string } | null>;
                };
                if (typeof v.getById !== 'function') return null;
                return v.getById(id);
            },
            hasVerbatim: async (id: string, workspace?: string): Promise<boolean> => {
                try {
                    const v = (await resolveVerbatim(workspace)) as unknown as { getById?: (id: string) => Promise<unknown> };
                    if (typeof v.getById !== 'function') return false;
                    const r = await v.getById(id);
                    return r !== null && r !== undefined;
                } catch {
                    return false;
                }
            },
            hasEmbeddings: async (ids: string[], workspace?: string): Promise<boolean> => {
                if (ids.length === 0) return false;
                try {
                    const v = (await resolveVerbatim(workspace)) as unknown as { getById?: (id: string) => Promise<unknown> };
                    if (typeof v.getById !== 'function') return false;
                    for (const id of ids) {
                        const r = await v.getById(id);
                        if (r === null || r === undefined) return false;
                    }
                    return true;
                } catch {
                    return false;
                }
            },
        } : {}),
    };
    // Sprint O4 — lag cache + per-workspace threshold resolver. The
    // resolver reads workspaces.json fresh on each call so an operator
    // edit to `outboxLagThresholdSeconds` is picked up without a daemon
    // restart (matches the rest of workspaces.json's no-cache contract).
    // Failure to read the file (corrupt / missing) falls back to the
    // global default — the cache must never throw on the request path.
    const envCfg = readEnvLagCacheConfig();
    const lagCache = new OutboxLagCache({
        defaultLagThresholdSeconds: envCfg.defaultLagThresholdSeconds,
        depthThreshold: envCfg.depthThreshold,
        thresholdResolver: (workspace: string): number => {
            try {
                const file = loadWorkspaces();
                const entry = file.workspaces.find((w) => w.name === workspace);
                const override = entry?.outboxLagThresholdSeconds;
                if (typeof override === 'number' && override > 0) return override;
            } catch {
                // Fall through to default.
            }
            return envCfg.defaultLagThresholdSeconds;
        },
        log: (m: string) => console.error(m),
    });
    // Sprint O6 — pick up self-heal cadence overrides from env so an
    // operator can tighten the loop in an emergency without a code
    // change. Defaults preserve pre-O6 behavior (no self-heal at all
    // before this release; 60-second cadence after).
    const selfHealCfg = readEnvSelfHealConfig();
    const pollCfg = readEnvPollConfig();
    const replicator = wireReplicator({
        store, substrates, lagCache,
        config: { ...selfHealCfg, ...pollCfg },
    });

    return { store, handlers, runBootRecovery, replicator, lagCache };
}
