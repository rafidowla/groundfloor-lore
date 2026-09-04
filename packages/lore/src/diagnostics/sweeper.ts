/**
 * diagnostics/sweeper.ts — periodic cross-substrate reconciliation
 * (architecture gap #9).
 *
 * ## Consistency model
 *
 * Lore's three local substrates (the graph engine + LanceDB vector +
 * SQLite relational) are **eventually consistent**. There is no
 * cross-substrate transaction; every write path performs each
 * step in sequence and the outbox (gap #1) keeps a durable trail
 * for crash recovery. Between writes, brief inconsistencies are
 * normal (a node may be in the graph but not yet in LanceDB).
 *
 * The reconciliation sweeper closes those gaps periodically:
 *
 *   1. Run `diagnoseConsistency` (gap #10) against the workspace.
 *   2. For every `missingEmbeddings` id:
 *      (a) Skip if `node.embed === false` (Atlas code nodes).
 *      (b) Compute the current verbatim text's contentHash. If it
 *          matches the LanceDB row's stored contentHash, skip — text
 *          is unchanged and re-embedding would produce identical
 *          bytes for nothing. This is the **P2 fix** from PR #69.
 *      (c) Otherwise enqueue an embed via the injected EmbedQueue.
 *   3. For every `orphanEmbeddings` id, cascade-delete from the vector
 *      store ONLY when deletion is opted in (`deleteOrphans` / env
 *      `LORE_SWEEP_DELETE_ORPHANS=1`). This is the **P3 fix** from PR #69,
 *      with a 2026-06-09 safe-default flip: the default is observe-only
 *      (report orphans, never auto-delete), because an orphan can be an
 *      intentional verbatim-only entry or a cross-scope/drift artifact, not
 *      just junk. After a delete pass, the store is compacted to reclaim
 *      disk (LanceDB optimize).
 *   4. For every SQLite orphan, LEAVE ALONE. Caller-defined data;
 *      cleanup is the caller's responsibility.
 *
 * The sweeper is fail-soft: a failed repair logs + moves on to the
 * next. The report carries per-category counts so admins can chart
 * "is our consistency drift getting worse over time?"
 *
 * Run pattern: a background timer kicks the sweeper every N minutes
 * (default 30). Test fixtures + admin UIs can invoke `runConsistencySweep`
 * directly for an on-demand pass.
 *
 * ## PR #69 changes (2026-06-09)
 *
 * Pre-fix: the sweep enqueued every "missing" id without checking
 * whether the text had actually changed; every sweep re-embedded
 * ~6,500 nodes whose vector was identical to the previous one,
 * refilling `lore_verbatim.lance` to 8.5 GB within hours of a
 * manual compact. Root cause was a three-way break: (a) no caller
 * populated `doc.metadata.contentHash` so `lookupByContentHash` was
 * effectively dead code, (b) `consistency.ts` flagged `embed:false`
 * nodes as missing, (c) the sweeper deliberately skipped orphans
 * forever, so they accumulated indefinitely.
 *
 * Fix: verbatimStore auto-computes contentHash when callers omit it;
 * consistency.ts filters `embed:false`; this file now honors the
 * fingerprint AND cascade-deletes orphans. Three layers of defence —
 * any one of them stops the re-embed storm; together they end it.
 */

import {
    diagnoseConsistency,
    type ConsistencyReport,
    type GraphReader,
    type SqliteOrphanCheck,
} from './consistency.js';
import { buildVerbatimText } from '../engines/verbatimSchema.js';
import { computeContentHash } from '../engines/contentHash.js';
import type { ITableStorage } from '../contracts/tables.js';

/** Narrow view of VerbatimStore the sweeper actually needs.
 *  Accepts either VerbatimStore or DataplaneVectorStore (both
 *  expose listIds; verbatimStore additionally exposes getById +
 *  delete which the P2/P3 fixes use). */
interface VectorStoreReader {
    listIds(prefix?: string): Promise<string[]>;
    /** Optional — only verbatimStore exposes this; dataplane store
     *  returns nothing and the sweep falls back to "always enqueue". */
    getById?(id: string): Promise<{ contentHash?: string; text?: string } | null>;
    /** P1 scale fix — batch the per-id contentHash lookup in CHUNKED
     *  `id IN (...)` queries (keyed by the PREFIXED id, `lore:<id>`) instead
     *  of one getById per missing id. Absent ids are simply not in the map,
     *  which the caller treats as "changed" — identical to a getById miss.
     *  Present on verbatimStore; when present it supersedes getById in the
     *  missing-embedding loop. */
    getContentHashesByIds?(ids: string[]): Promise<Map<string, string>>;
    /** PR #69 P3 — preferred path for orphan cascade-delete. Hard
     *  removes the row (no tombstone, no history). Only verbatimStore
     *  exposes this today. */
    physicalDelete?(id: string): Promise<void>;
    /** Bulk hard-delete (chunked) — preferred over physicalDelete when
     *  present, since orphan cleanup can be tens of thousands of ids and
     *  one-delete-per-id is pathologically slow + version-bloated.
     *  Returns the number of ids processed. */
    physicalDeleteMany?(ids: string[]): Promise<number>;
    /** Legacy soft-delete (tombstone). Used as fallback when
     *  physicalDelete isn't available. Note: tombstone leaves the row
     *  visible to listIds, so the orphan re-surfaces every sweep
     *  unless physicalDelete is wired. */
    delete?(id: string): Promise<void>;
    /** B (2026-06-09) — reclaim disk after deletes (LanceDB optimize:
     *  merge fragments + prune old versions). Optional; only verbatimStore
     *  exposes it. The sweep calls it after a delete pass. */
    compact?(): Promise<unknown>;
}

/** Chunk size for the batched graph/vector lookups in the missing-embedding
 *  reconciliation loop. Matches verbatimStore's VERBATIM_CHUNK_SIZE and the
 *  re-embed chunk default so one `id IN (...)` predicate never grows unbounded. */
const SWEEP_BATCH_SIZE = 256;

export interface SweepDeps {
    graph: GraphReader & {
        getNode: (id: string) => Promise<import('../providers/types.js').LoreNode | null>;
        /** P1 scale fix — optional batch hydration (chunked `id IN (...)`).
         *  Present on the real LocalGraph; when present it replaces the serial
         *  per-id getNode round-trips in the missing-embedding loop. Absent on
         *  minimal test fakes, which keep the serial getNode fallback. */
        getNodesByIds?: (ids: string[]) => Promise<Map<string, import('../providers/types.js').LoreNode>>;
    };
    vectorStore: VectorStoreReader | null;
    tableStorage: ITableStorage | null;
    /** When supplied, missingEmbeddings are enqueued for async embed
     *  via this queue. Without it, the sweep is observe-only.
     *  RC-round4: the 3rd `workspace` arg routes the re-embed to the swept
     *  workspace's LanceDB via the executor's resolveStores. Once the
     *  scheduled sweep fans out per-workspace, dropping it would write B's
     *  re-embed into the boot store (corrupts A, leaves B still missing). */
    embedQueue?: { enqueue: (nodeId: string, text: string, workspace?: string) => void };
}

export interface SweepOpts {
    workspace: string;
    sqliteChecks?: SqliteOrphanCheck[];
    /**
     * PR #69 P3 + 2026-06-09 safe-default — cascade-delete vector orphans.
     * OPT-IN: defaults to `process.env.LORE_SWEEP_DELETE_ORPHANS === '1'`
     * (i.e. observe-only unless explicitly enabled). Set `true` to delete
     * orphans on this pass (used by the on-demand cleanup endpoint + tests),
     * `false` to force observe-only regardless of the env var.
     */
    deleteOrphans?: boolean;
}

export interface SweepResult {
    report: ConsistencyReport;
    /** Count of missingEmbeddings ids that the sweeper enqueued for
     *  re-embed. Equals the missingEmbeddings length when embedQueue
     *  is wired AND the contentHash check found a change; lower when
     *  the fingerprint short-circuits. */
    enqueuedForReEmbed: number;
    /** Count of orphan + sqlite-orphan items the sweeper observed but
     *  deliberately did NOT touch. Surfaced for operator visibility.
     *  By default (observe-only) this includes ALL vector orphans plus
     *  SQLite orphans; when deletion is opted in, it drops to just the
     *  SQLite orphans + any vector orphans whose delete failed. */
    observedButSkipped: number;
    /** PR #69 P2: count of missing ids whose text hadn't actually
     *  changed since the prior embed. These are skipped silently —
     *  the vector is already correct, no re-embed needed. */
    skippedUnchanged: number;
    /** PR #69 P2: count of nodes flagged as missing but skipped
     *  because they have `embed: false` (Atlas code nodes). Should
     *  normally be 0 since consistency.ts also filters these — this
     *  is a belt-and-suspenders second check. */
    skippedNonEmbeddable: number;
    /** PR #69 P3: count of orphan vectors successfully cascade-deleted.
     *  Deletion is OPT-IN (deleteOrphans / LORE_SWEEP_DELETE_ORPHANS=1);
     *  by default this is always 0 and the orphans show up in
     *  observedButSkipped instead. */
    deletedOrphans: number;
    /** PR #69 P3: count of orphan delete attempts that failed (logged
     *  individually, fail-soft). */
    failedOrphanDeletes: number;
}

/**
 * Run one reconciliation pass. Read-only on the substrates the
 * sweeper doesn't have an explicit repair for (SQLite orphans).
 * For vector orphans, cascade-deletes via vectorStore.delete unless
 * LORE_SWEEP_KEEP_ORPHANS=1 is set (preserve-for-history escape hatch).
 */
export async function runConsistencySweep(
    deps: SweepDeps,
    opts: SweepOpts,
): Promise<SweepResult> {
    const report = await diagnoseConsistency(
        deps.graph,
        deps.vectorStore,
        deps.tableStorage,
        { workspace: opts.workspace, sqliteChecks: opts.sqliteChecks },
    );

    let enqueuedForReEmbed = 0;
    let skippedUnchanged = 0;
    let skippedNonEmbeddable = 0;

    if (deps.embedQueue && report.missingEmbeddings.length > 0) {
        // P1 scale fix — process missing ids in bounded CHUNKS, batching the
        // per-id graph hydration AND the per-id vector contentHash lookup into
        // one `id IN (...)` round-trip each (was: two serial round-trips per
        // id — pathological at tens of thousands of missing ids). Semantics are
        // byte-identical to the old serial loop: a graph miss skips the id, an
        // embed:false node increments skippedNonEmbeddable, a matching stored
        // contentHash increments skippedUnchanged, everything else enqueues.
        const batchHydrate = deps.graph.getNodesByIds?.bind(deps.graph);
        const batchHashes = deps.vectorStore?.getContentHashesByIds?.bind(deps.vectorStore);
        const missing = report.missingEmbeddings;

        for (let ci = 0; ci < missing.length; ci += SWEEP_BATCH_SIZE) {
            const chunk = missing.slice(ci, ci + SWEEP_BATCH_SIZE);

            // Resolve this chunk's nodes (batched when available, else serial).
            let nodesById: Map<string, import('../providers/types.js').LoreNode>;
            if (batchHydrate) {
                try {
                    nodesById = await batchHydrate(chunk);
                } catch (err) {
                    console.error(`[consistency-sweep] batch getNodesByIds failed: ${(err as Error).message}`);
                    nodesById = new Map();
                }
            } else {
                nodesById = new Map();
                for (const id of chunk) {
                    try {
                        const n = await deps.graph.getNode(id);
                        if (n) nodesById.set(id, n);
                    } catch (err) {
                        console.error(`[consistency-sweep] getNode failed for ${id}: ${(err as Error).message}`);
                    }
                }
            }

            // Compute fresh contentHash per present, embeddable node in the
            // chunk; collect the ones we still need to hash-compare against
            // the stored vector.
            const pending: Array<{ id: string; text: string; freshHash: string }> = [];
            for (const id of chunk) {
                const node = nodesById.get(id);
                if (!node) continue; // graph drifted; nothing to embed

                // PR #69 P2 — belt-and-suspenders: even though consistency.ts
                // already filters embed:false nodes, recheck here in case a
                // custom GraphReader doesn't (e.g. a future cloud diagnostic).
                if ((node as { embed?: boolean }).embed === false) {
                    skippedNonEmbeddable++;
                    continue;
                }
                const text = buildVerbatimText(node.label ?? '', node.content ?? '', node.tags ?? '');
                pending.push({ id, text, freshHash: computeContentHash(text) });
            }
            if (pending.length === 0) continue;

            // PR #69 P2 — skip ids whose live vector's contentHash already
            // matches the current text (re-embedding would produce identical
            // bytes — the 6,500-per-sweep churn). Batch the lookup when the
            // store supports it; else fall back to per-id getById; else (no
            // getById at all, e.g. DataplaneVectorStore) enqueue everything.
            let storedHashes: Map<string, string> | null = null;
            if (batchHashes) {
                try {
                    storedHashes = await batchHashes(pending.map((p) => `lore:${p.id}`));
                } catch (err) {
                    console.error(`[consistency-sweep] batch getContentHashesByIds failed: ${(err as Error).message}`);
                    storedHashes = null;
                }
            }

            for (const p of pending) {
                try {
                    let stored: string | undefined;
                    if (storedHashes) {
                        stored = storedHashes.get(`lore:${p.id}`);
                    } else if (deps.vectorStore?.getById) {
                        try {
                            const existing = await deps.vectorStore.getById(`lore:${p.id}`);
                            stored = existing?.contentHash;
                        } catch (err) {
                            // getById failures must NEVER block enqueue — fall
                            // through to the enqueue path (if uncertain, re-embed).
                            console.error(`[consistency-sweep] getById failed for lore:${p.id}: ${(err as Error).message}`);
                        }
                    }
                    if (stored && stored === p.freshHash) {
                        // Text unchanged — vector is still valid; skip.
                        skippedUnchanged++;
                        continue;
                    }
                    // RC-round4: thread the swept workspace so the executor's
                    // resolveStores(job.workspace) writes the re-embed into the
                    // correct workspace's graph + LanceDB. opts.workspace is the
                    // actually-swept workspace once daemonTimers fans out.
                    deps.embedQueue.enqueue(p.id, p.text, opts.workspace);
                    enqueuedForReEmbed++;
                } catch (err) {
                    console.error(`[consistency-sweep] failed to enqueue re-embed for ${p.id}: ${(err as Error).message}`);
                }
            }
        }
    }

    // PR #69 P3 — cascade-delete vector orphans.
    //
    // Operator escape hatch: LORE_SWEEP_KEEP_ORPHANS=1 falls back to
    // the pre-PR-69 "leave orphans alone" behavior. The brief mentioned
    // a "tombstone for history" use case; this flag preserves that path
    // for workspaces that have a real reason to keep orphans (e.g.
    // forensic archives).
    let deletedOrphans = 0;
    let failedOrphanDeletes = 0;
    // PR #69 P3 + 2026-06-09 safe-default flip — orphan cascade-delete is
    // now OPT-IN. The default is observe-only (the original, safer design):
    // orphans are reported but NEVER auto-deleted. Rationale (surfaced by
    // live dogfooding): an "orphan" — a vector with no graph node in the
    // swept scope — can be an intentional verbatim-only entry, a node that
    // belongs to a different workspace scope, or a drift artifact, NOT just
    // junk. Mass auto-deletion of those is data loss. Deletion is enabled
    // per-call via opts.deleteOrphans, or globally via
    // LORE_SWEEP_DELETE_ORPHANS=1 (operator opt-in).
    const deleteOrphans =
        opts.deleteOrphans !== undefined
            ? opts.deleteOrphans
            : process.env.LORE_SWEEP_DELETE_ORPHANS === '1';

    // PR #69 P3 — prefer physicalDelete (hard remove) over delete
    // (tombstone). Orphan cleanup is conceptually a hard removal: the
    // parent node is gone, so there's no history meaning to preserve.
    // A tombstoned row is still visible to listIds and would re-surface
    // as an orphan next sweep — defeating the cleanup.
    //
    // Bulk path (2026-06-09): when the store exposes physicalDeleteMany,
    // prefer it — orphan cleanup can be tens of thousands of ids, and
    // one-delete-per-id is pathologically slow + version-bloated. The
    // bulk path chunks into `id IN (...)` deletes (seconds, few versions).
    const batchDelete = deps.vectorStore?.physicalDeleteMany?.bind(deps.vectorStore);
    const orphanDeleter =
        deps.vectorStore?.physicalDelete ?? deps.vectorStore?.delete;
    const canDelete = !!batchDelete || !!orphanDeleter;

    // 2026-08-17 (launch blocker): refuse the delete pass when the graph scan
    // failed. A partial/empty graphIds set makes EVERY vector look like an
    // orphan (vectorIds - graphIds), so deleting here would mass-wipe a
    // healthy vector store on a transient graph page error. Fail closed:
    // report the orphans as observed-but-skipped instead of deleting them.
    if (deleteOrphans && !report.graphScanFailed && report.orphanEmbeddings.length > 0 && canDelete) {
        // The diagnostic strips the `lore:` prefix before adding to
        // orphanEmbeddings (consistency.ts:146). Re-add it — the store
        // keyspace uses prefixed ids.
        const prefixedIds = report.orphanEmbeddings.map((id) => `lore:${id}`);
        if (batchDelete) {
            try {
                deletedOrphans = await batchDelete(prefixedIds);
            } catch (err) {
                failedOrphanDeletes = prefixedIds.length;
                console.error(`[consistency-sweep] bulk cascade-delete failed: ${(err as Error).message}`);
            }
        } else if (orphanDeleter) {
            for (const id of prefixedIds) {
                try {
                    await orphanDeleter.call(deps.vectorStore, id);
                    deletedOrphans++;
                } catch (err) {
                    failedOrphanDeletes++;
                    console.error(`[consistency-sweep] cascade-delete failed for ${id}: ${(err as Error).message}`);
                }
            }
        }
        // B (2026-06-09) — reclaim disk after a delete pass. The deletes
        // write new LanceDB versions + fragments; without a compaction the
        // freed rows still occupy disk. compact() merges fragments + prunes
        // old versions so space is actually reclaimed. Best-effort: a
        // compaction failure must never fail the sweep, and we only run it
        // when we actually deleted something.
        if (deletedOrphans > 0 && deps.vectorStore?.compact) {
            try {
                await deps.vectorStore.compact();
            } catch (err) {
                console.error(`[consistency-sweep] post-delete compaction failed (non-fatal): ${(err as Error).message}`);
            }
        }
    }

    // observedButSkipped now means:
    //   - SQLite orphans (always skipped, caller responsibility)
    //   - Vector orphans whenever deletion is NOT opted in (the default)
    //   - Vector orphans when the graph scan FAILED (unreliable, never deleted)
    //   - Vector orphans the sweeper couldn't delete (failed)
    const observedButSkipped =
        (!deleteOrphans || !canDelete || report.graphScanFailed
            ? report.orphanEmbeddings.length
            : failedOrphanDeletes) +
        report.sqliteOrphans.reduce((acc, r) => acc + r.orphans.length, 0);

    return {
        report,
        enqueuedForReEmbed,
        observedButSkipped,
        skippedUnchanged,
        skippedNonEmbeddable,
        deletedOrphans,
        failedOrphanDeletes,
    };
}

export interface SweepScheduler {
    timer: NodeJS.Timeout;
    /**
     * SP-02 — graceful stop. Clears the interval and AWAITS any
     * in-flight `run()` so a sweep mid-LanceDB-write / mid-graph-delete
     * is never killed by `process.exit`. Idempotent.
     */
    stop(): Promise<void>;
}

/**
 * TW-7e (hc-consistency-sweep-interval) — env-overridable consistency-sweep
 * interval. Default 30 min (unchanged); a positive integer in
 * LORE_CONSISTENCY_SWEEP_MS overrides it without a recompile. Invalid/absent
 * falls back to the default. An explicit `intervalMs` argument still wins over
 * the env (tests pass a small interval directly).
 */
const DEFAULT_CONSISTENCY_SWEEP_MS = 30 * 60 * 1000; // 30 minutes
function resolveConsistencySweepMs(): number {
    const raw = Number(process.env['LORE_CONSISTENCY_SWEEP_MS']);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONSISTENCY_SWEEP_MS;
}

/**
 * Schedule a periodic sweep. Returns a handle with the cancellable timer
 * plus an async `stop()` that drains the in-flight run. Wired in
 * server.ts; idempotent.
 */
export function scheduleConsistencySweep(
    run: () => Promise<SweepResult>,
    intervalMs: number = resolveConsistencySweepMs(),
): SweepScheduler {
    // SP-02 — track the in-flight sweep so stop() can await it.
    let inflight: Promise<SweepResult> | null = null;

    const tick = (): void => {
        const p = run();
        inflight = p;
        p.then(result => {
            if (
                result.report.hasIssues ||
                result.enqueuedForReEmbed > 0 ||
                result.deletedOrphans > 0 ||
                result.skippedUnchanged > 0
            ) {
                console.error(
                    `[consistency-sweep] graph=${result.report.graphNodeCount} ` +
                    `vector=${result.report.vectorEmbeddingCount} ` +
                    `re-embedded=${result.enqueuedForReEmbed} ` +
                    `skipped-unchanged=${result.skippedUnchanged} ` +
                    `skipped-non-embeddable=${result.skippedNonEmbeddable} ` +
                    `deleted-orphans=${result.deletedOrphans} ` +
                    `failed-orphan-deletes=${result.failedOrphanDeletes} ` +
                    `observed-skipped=${result.observedButSkipped}`,
                );
            }
        }).catch(err => {
            console.error(`[consistency-sweep] pass failed: ${(err as Error).message}`);
        }).finally(() => {
            // Only clear if no newer tick has started since.
            if (inflight === p) inflight = null;
        });
    };

    const timer = setInterval(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    return {
        timer,
        async stop(): Promise<void> {
            clearInterval(timer);
            if (inflight) await inflight.catch(() => { /* drained, errors already logged */ });
        },
    };
}
