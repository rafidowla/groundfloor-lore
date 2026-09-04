/**
 * bulkIngest.ts — Batch-optimised ingest facade for LoreInstance.
 *
 * Trickle-ingest (nodeUpsert / nodeUpsertBatch) is tuned for UX:
 * autolink fires per-node so the graph stays connected as knowledge
 * accumulates, and embed is async so the UI returns quickly. Both
 * behaviours are actively wrong for bulk callers (repo indexing,
 * memory imports, migration tools) — autolink fires N extra ONNX
 * searches, and async embed races with process.exit / dispose().
 *
 * bulkIngest() fixes both:
 *   1. Autolink OFF by default — caller already knows the structure.
 *   2. embed:'sync' by default — when the promise resolves, every
 *      vector is persisted to LanceDB. No drain race, no 0B stores.
 *   3. One embedDocumentBatch() call for the whole batch (3-5× vs N
 *      serial single-embeds on the local ONNX session).
 *   4. Per-node error isolation — a failed node is reported in results[];
 *      it does not throw or abort the batch.
 *
 * nodeUpsert / nodeUpsertBatch are unchanged.
 */

import { nodeUpsert as nodeServiceUpsert } from '../core/nodeService.js';
import { VerbatimStore } from '../engines/verbatimStore.js';
import { buildVerbatimText } from '../engines/verbatimSchema.js';
import { tagsToArray, tagsToString } from '../engines/normalizeTags.js';
import { computeContentHash } from '../engines/contentHash.js';
import type { EmbeddingProvider } from '../providers/types.js';
import type { LoreGraph, LoreVectorStore } from './services.js';
import type { LocalGraphRegistry } from '../engines/localGraphRegistry.js';
import { WorkspaceNotFoundError } from '../engines/localGraphRegistry.js';
import type { VersionStore } from '../outbox/versionStore.js';
import type { LoreStorageClient } from '../storage/loreStorageClient.js';
import type { EmbedQueue } from '../embed/queue.js';
import type { ReconnectableGraph } from '../engines/reconnect.js';
import type { PendingAutolinkTracker } from '../engines/pendingAutolink.js';
import { withTransactionConflictRetry } from '../engines/transactionConflictRetry.js';
import {
    ABORT_EMBED_CHUNK_SIZE,
    markCancelled,
    rollbackCancelledNode,
} from './bulkIngestCancel.js';

export interface BulkIngestOpts {
    /**
     * Run ingest-time autolink (similarity search → semantic_neighbor edges)
     * per node. Default false — bulk callers know the structure already.
     */
    autolink?: boolean;
    /**
     * Embed mode.
     * - `'sync'` (default): embeddings are persisted to LanceDB before the
     *   promise resolves. No drain race with dispose().
     * - `'async'`: fire-and-forget via the embed queue (same behaviour as
     *   nodeUpsertBatch — drain races with dispose).
     * - `'precomputed'`: callers supply vectors on each node via the
     *   `embedding` field. Lore skips the embedding model entirely and
     *   writes the provided vectors directly. Dimensions must match the
     *   configured model (`EmbeddingProvider.dimension`); mismatches are
     *   rejected per-node with a clear error, not silently truncated.
     */
    embed?: 'sync' | 'async' | 'precomputed';
    /**
     * Embed batch size passed to embedDocumentBatch. Default: the full
     * batch in one call (provider chunks internally). Override for tighter
     * memory budgets. Not used when `embed: 'precomputed'`.
     */
    embedBatchSize?: number;
    /**
     * Cooperative cancel. Polled between graph-write workers, embed chunks,
     * and Lance writes. Never kills an in-flight native write or ONNX forward.
     */
    shouldAbort?: () => boolean;
}

export interface BulkIngestResult {
    ok: boolean;
    count: number;
    succeeded: number;
    results: Array<{ ok: true; id: string } | { ok: false; id: string; error: string }>;
}

export type BulkIngestNodeArgs = {
    id: string;
    workspace: string;
    ecosystem: string;
    nodeData: Record<string, unknown>;
    skipEmbed?: boolean;
    /**
     * Pre-computed embedding vector for this node. Only used when
     * `BulkIngestOpts.embed` is `'precomputed'`. Dimension must match
     * the configured model (`EmbeddingProvider.dimension`); a mismatch
     * fails this node in `results[]` without aborting the batch.
     */
    embedding?: number[];
};

export interface BulkIngestDeps {
    graph: LoreGraph;
    graphRegistry: LocalGraphRegistry | null | undefined;
    activeWorkspaceName: () => string;
    outboxStore: import('../outbox/types.js').OutboxStore | undefined;
    embedQueue: EmbedQueue;
    verbatimStore: LoreVectorStore;
    storageClient: LoreStorageClient;
    /**
     * Boot/active workspace's verbatim store. Used ONLY as the fallback when
     * no `workspaceVerbatimResolver` is wired (cloud / no registry / tests);
     * every workspace-aware path resolves per node via the resolver.
     */
    loreVerbatim: LoreVectorStore;
    embeddingProvider: EmbeddingProvider;
    getWal: () => import('../engines/writeAheadLog.js').WriteAheadLog;
    versionStore: VersionStore | undefined;
    /**
     * R4 #4 — per-workspace verbatim (LanceDB) resolver. Step 3 below routes
     * each node's vector to ITS workspace's store via getOrOpen(node.workspace)
     * instead of writing every vector to the boot/active `verbatimStore`.
     * Without it a bulk ingest targeting a non-active workspace wrote that
     * workspace's vectors into the active LanceDB — broken read-your-writes for
     * semantic recall + a cross-workspace vector leak. Absent (cloud / no
     * registry / tests) → falls back to `verbatimStore`, behavior unchanged.
     */
    workspaceVerbatimResolver?: { getOrOpen(ws: string): Promise<LoreVectorStore> };
    /**
     * The owning Lore instance's autolink registry (StorageBundle.autolinkTracker).
     * Only consulted when `opts.autolink` is on.
     *
     * REQUIRED, exactly like `AutolinkHandles.tracker` on the single-write path
     * it forwards to — and for the same reason. While it was optional with a
     * `?? defaultAutolinkTracker` fallback, a new caller could omit it, compile
     * clean, and silently register a whole bulk ingest's autolinks on the
     * PROCESS-GLOBAL tracker: instance A's dispose() would then wait on B's
     * hooks, and A's own drain would walk past its real in-flight work straight
     * into `graph.close()` — the use-after-close race pendingAutolink.ts exists
     * to close, reintroduced with no error anywhere. An optional field with a
     * plausible default is not a safety net; it is the absence of one. Callers
     * with no instance handle (direct library use, tests) pass
     * `defaultAutolinkTracker` explicitly, which makes that choice visible at
     * the call site instead of hiding it in a `??`.
     */
    autolinkTracker: PendingAutolinkTracker;
}

/**
 * R4 #4 — write pre-built vector rows to EACH node's own workspace LanceDB.
 * Groups rows by node.workspace, resolves the per-workspace verbatim store
 * (or the boot store when no resolver is wired), and upserts each group. A
 * resolver that throws for a workspace marks THAT group's items failed rather
 * than misrouting them to the boot store (cf. outbox R2 #2). Stores that are
 * not a local VerbatimStore (cloud) fall back to per-row store().
 */
async function writePrebuiltRowsPerWorkspace(
    deps: BulkIngestDeps,
    items: Array<{ node: BulkIngestNodeArgs; idx: number; row: Record<string, unknown> }>,
    resultSlots: BulkIngestResult['results'],
): Promise<void> {
    const groups = new Map<string, Array<{ node: BulkIngestNodeArgs; idx: number; row: Record<string, unknown> }>>();
    for (const it of items) {
        const g = groups.get(it.node.workspace) ?? [];
        g.push(it);
        groups.set(it.node.workspace, g);
    }
    for (const [ws, group] of groups) {
        let store: LoreVectorStore = deps.verbatimStore;
        if (deps.workspaceVerbatimResolver) {
            try {
                store = await deps.workspaceVerbatimResolver.getOrOpen(ws);
            } catch (resolveErr) {
                const msg = (resolveErr as Error).message?.slice(0, 300) ?? 'workspace_verbatim_resolve_failed';
                for (const g of group) resultSlots[g.idx] = { ok: false, id: g.node.id, error: msg };
                continue;
            }
        }
        try {
            if (store instanceof VerbatimStore) {
                await store.bulkUpsertPrebuiltRows(group.map((g) => g.row));
            } else {
                // Cloud / non-local store: per-row store() with reconstructed metadata.
                await Promise.all(group.map((g) => store.store({
                    id: String(g.row.id),
                    text: String(g.row.text ?? ''),
                    metadata: {
                        type: String(g.row.type ?? ''),
                        label: String(g.row.label ?? ''),
                        tags: String(g.row.tags ?? ''),
                        project: String(g.row.project ?? ''),
                        ecosystem: String(g.row.ecosystem ?? ''),
                        updatedAt: String(g.row.updatedAt ?? ''),
                    },
                })));
            }
        } catch (writeErr) {
            const msg = (writeErr as Error).message?.slice(0, 300) ?? 'lance_bulk_add_failed';
            for (const g of group) resultSlots[g.idx] = { ok: false, id: g.node.id, error: msg };
        }
    }
}

/**
 * NW-BULK — max concurrent in-flight graph ops during a bulk ingest. On the
 * former local graph engine, each upsert borrowed a native pool connection
 * for its read-decide-write `getNode`; fanning out thousands at once with
 * `Promise.all` overflowed the pool's waiter cap
 * (a native connection-pool "waiter queue full (200/200)" error), failing the writes —
 * which then left edges with missing endpoints. Writes were already
 * serialized by that engine's globalWriteQueue, so bounding the JS fan-out
 * cost no write throughput; it only kept concurrent pool borrows under the
 * cap. Default 16; override via LORE_BULK_INGEST_CONCURRENCY.
 */
const BULK_INGEST_CONCURRENCY: number = (() => {
    const raw = process.env['LORE_BULK_INGEST_CONCURRENCY'];
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 16;
})();

/** Run `fn` over `items` with at most `limit` in flight; preserves index. */
export async function mapLimit<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]!, i);
        }
    });
    await Promise.all(workers);
    return results;
}

export async function runBulkIngest(
    nodes: BulkIngestNodeArgs[],
    opts: BulkIngestOpts = {},
    deps: BulkIngestDeps,
): Promise<BulkIngestResult> {
    const embed = opts.embed ?? 'sync';
    const enableAutolink = opts.autolink ?? false;
    const resultSlots: BulkIngestResult['results'] = new Array(nodes.length);

    // ── Step 0: collapse duplicate ids, keep the LAST occurrence ─────────
    // C3 3.4 (2026-08-17, functional-correctness HIGH). Two entries for the
    // same id in ONE call (a rapid re-save, an agent self-correcting, a
    // re-import with overlap) previously raced end to end:
    //   - Step 1b fanned nodeServiceUpsert out over the RAW array, so the two
    //     graph writes for one id executed their read-decide-write
    //     concurrently and the later array entry did NOT reliably win the
    //     graph row (0-4 of 8 ids kept the OLD content across repeated runs).
    //   - Step 3 grouped rows by workspace ONLY and handed the whole group to
    //     bulkUpsertPrebuiltRows, whose mergeInsert('id') reconciles
    //     source-vs-target, NOT duplicates WITHIN the source batch — both
    //     rows landed as separate canonical vector rows and getById returned
    //     the STALE one, permanently.
    // The caller's intent is unambiguous: within one call, the LATER entry
    // supersedes the earlier. The pipeline below runs over one winner per id
    // (the last occurrence); each superseded duplicate's result slot mirrors
    // its winner's outcome in finish().
    const origNodes = nodes;
    const lastIdxById = new Map<string, number>();
    for (let i = 0; i < origNodes.length; i++) lastIdxById.set(origNodes[i]!.id, i);
    let winnerIdx: number[] | null = null;
    if (lastIdxById.size !== origNodes.length) {
        winnerIdx = [...lastIdxById.values()].sort((a, b) => a - b);
        nodes = winnerIdx.map((i) => origNodes[i]!);
    }
    /** Pipeline index → resultSlots index (identity when no duplicates). */
    const slotOf = (i: number): number => (winnerIdx ? winnerIdx[i]! : i);
    /** Backfill superseded duplicates' slots from their winner, then build. */
    const finish = (): BulkIngestResult => {
        if (winnerIdx) {
            for (let i = 0; i < origNodes.length; i++) {
                const w = lastIdxById.get(origNodes[i]!.id)!;
                if (w === i) continue;
                const ws = resultSlots[w];
                resultSlots[i] = ws?.ok
                    ? { ok: true, id: origNodes[i]!.id }
                    : { ok: false, id: origNodes[i]!.id, error: ws?.error ?? 'superseded_by_later_entry' };
            }
        }
        return buildResult(origNodes.length, resultSlots);
    };

    // ── Step 1a: Pre-fetch previousStates (pure reads, no write transactions) ──
    // MUST complete before any writes start. The former local graph engine
    // allowed exactly one active write transaction at a time. The prior
    // implementation mixed getNode reads and nodeServiceUpsert writes in the
    // same Promise.all — when write #1 held that engine's write lock,
    // concurrent reads on other connections threw, causing ~10% of nodes to
    // fail on cold start with "Failed to get node". Separating the read
    // phase eliminates the read-write contention entirely.
    // R5 #3 — resolve each node's target graph PER NODE and isolate a resolve
    // failure into results[], honoring the documented per-node-isolation
    // contract. A bare Promise.all over getOrOpen rejected the WHOLE batch when
    // ONE node named an unregistered/unopenable workspace (LocalGraphRegistry
    // .getOrOpen throws), so runBulkIngest threw BEFORE any write — every valid
    // sibling write silently lost, and the caller got an exception with no
    // BulkIngestResult. Now a bad workspace fails only its own node; siblings
    // still write and the caller always gets a complete results[].
    const resolvedGraphs: Array<LoreGraph | null> = await mapLimit(nodes, BULK_INGEST_CONCURRENCY, async (node, i) => {
        if (!deps.graphRegistry) return deps.graph;
        try {
            return await deps.graphRegistry.getGraphHandle(node.workspace);
        } catch (err) {
            const code = err instanceof WorkspaceNotFoundError ? 'workspace_not_found' : 'workspace_open_failed';
            resultSlots[slotOf(i)] = { ok: false, id: node.id, error: `${code}: ${((err as Error).message ?? '').slice(0, 200)}` };
            return null;
        }
    });
    // NW-BULK — bounded: getNode borrows a pool connection; an unbounded
    // Promise.all here overflowed the pool waiter cap under high-volume reindex.
    // Skip nodes whose graph resolve failed above (resolvedGraphs[i] === null).
    const aborted = (): boolean => Boolean(opts.shouldAbort?.());

    const previousStates = await mapLimit(nodes, BULK_INGEST_CONCURRENCY, (_node, i) =>
        resolvedGraphs[i]
            ? resolvedGraphs[i]!.getNode(nodes[i]!.id).catch(() => null)
            : Promise.resolve(null),
    );

    const rollbackPipelineIds = async (pipelineIndices: number[]): Promise<void> => {
        await Promise.all(pipelineIndices.map(async (i) => {
            const node = nodes[i]!;
            markCancelled(resultSlots, slotOf(i), node.id);
            await rollbackCancelledNode({
                node,
                previousState: previousStates[i],
                graph: resolvedGraphs[i] ?? null,
                deps,
            });
        }));
    };

    if (aborted()) {
        for (let i = 0; i < nodes.length; i++) {
            if (!resultSlots[slotOf(i)]) markCancelled(resultSlots, slotOf(i), nodes[i]!.id);
        }
        return finish();
    }

    // ── Step 1b: Graph writes (bounded, skipEmbed=true) ──────────────────────
    // On the former local graph engine, writes were serialized via
    // LocalGraph's globalWriteQueue; but each upsert's read-decide-write
    // getNode borrows a pool connection, so the JS fan-out is bounded
    // (NW-BULK) to keep concurrent borrows under the
    // pool cap. skipEmbed=true: nodeService writes the graph row + WAL + version
    // but skips the outbox verbatim entry (vector writes handled in step 3).
    await mapLimit(nodes, BULK_INGEST_CONCURRENCY, async (node, i) => {
        if (aborted()) {
            markCancelled(resultSlots, slotOf(i), node.id);
            return;
        }
        // R5 #3 — skip nodes whose workspace resolve failed in Step 1a (their
        // failure is already recorded in resultSlots[i]).
        const targetGraph = resolvedGraphs[i];
        if (!targetGraph) return;
        try {
            const isActive = node.workspace === deps.activeWorkspaceName();
            const previousState = previousStates[i] ?? null;
            // Workspace-routes the autolink hook (1.4 regression, 2026-08-18).
            // The pre-fix code passed ONE boot-resolved pair
            // (`deps.loreGraph` / `deps.loreVerbatim`) for every node in the
            // batch, so a batch targeting a non-boot workspace wrote its
            // semantic_neighbor edges into the BOOT graph (the node's own
            // graph got zero — 1.4's original symptom) and, because
            // skipEmbed:true makes nodeService pass `skipStore:false`,
            // reconnectOneNode stored the node's full text into the BOOT
            // verbatim store — a cross-workspace content leak into the boot
            // workspace's search. Route BOTH per node: the graph is the
            // already-resolved per-workspace handle from Step 1a (cast like
            // the old boot handle — every engine implements bulkList, it's
            // just not on the narrow shared LoreGraph interface), and the
            // verbatim store comes from the same per-workspace resolver
            // writePrebuiltRowsPerWorkspace uses. A resolver failure fails
            // THIS node (mirroring that helper's fail-don't-misroute rule),
            // not the batch.
            let autolinkVerbatim = deps.loreVerbatim;
            if (enableAutolink && deps.workspaceVerbatimResolver) {
                try {
                    autolinkVerbatim = await deps.workspaceVerbatimResolver.getOrOpen(node.workspace);
                } catch (resolveErr) {
                    resultSlots[slotOf(i)] = {
                        ok: false, id: node.id,
                        error: `workspace_verbatim_resolve_failed: ${((resolveErr as Error).message ?? '').slice(0, 200)}`,
                    };
                    return;
                }
            }
            const autolinkGraph: ReconnectableGraph | null = enableAutolink ? (targetGraph as ReconnectableGraph) : null;
            const res = await withTransactionConflictRetry(() => nodeServiceUpsert(
                {
                    ...node,
                    skipEmbed: true,
                    targetGraph,
                    initiator: 'lib:bulkIngest',
                    isActiveWorkspace: isActive,
                },
                {
                    outboxStore: deps.outboxStore,
                    embedQueue: undefined,
                    verbatim: deps.storageClient,
                    getWal: deps.getWal,
                    versionStore: deps.versionStore,
                    previousState,
                    versionPrincipal: 'lib',
                    autolink: autolinkGraph
                        ? { graph: autolinkGraph, verbatim: autolinkVerbatim, tracker: deps.autolinkTracker }
                        : undefined,
                },
            ));
            if (res.ok) {
                resultSlots[slotOf(i)] = { ok: true, id: node.id };
            } else {
                resultSlots[slotOf(i)] = {
                    ok: false, id: node.id,
                    error: res.error?.message ?? res.code,
                };
            }
        } catch (err) {
            resultSlots[slotOf(i)] = {
                ok: false, id: node.id,
                error: (err as Error).message?.slice(0, 300) ?? 'graph_write_failed',
            };
        }
    });

    if (aborted()) {
        const written: number[] = [];
        for (let i = 0; i < nodes.length; i++) {
            if (resultSlots[slotOf(i)]?.ok) written.push(i);
            else if (!resultSlots[slotOf(i)]) markCancelled(resultSlots, slotOf(i), nodes[i]!.id);
        }
        await rollbackPipelineIds(written);
        return finish();
    }

    // ── Step 2: Collect nodes that need vector writes ─────────────────────
    // idx is the ORIGINAL result slot (slotOf) so downstream per-slot writes
    // land on the right input entry even after Step 0 dedupe.
    const toEmbed: Array<{ node: BulkIngestNodeArgs; idx: number }> = [];
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        const result = resultSlots[slotOf(i)];
        if (result?.ok && !node.skipEmbed) {
            toEmbed.push({ node, idx: slotOf(i) });
        }
    }

    if (toEmbed.length === 0) {
        return finish();
    }

    // ── Step 3: Vector writes ─────────────────────────────────────────────
    if (embed === 'async') {
        // Fire-and-forget: enqueue via the embed queue (same as nodeUpsertBatch).
        // RC-round4: pass node.workspace as the 3rd arg so the EmbedQueue
        // executor's resolveStores routes each embed to that node's own
        // workspace's LanceDB (mirrors import.ts:538). bulkIngest owns its
        // own enqueue — the inner nodeUpsert is wired embedQueue:undefined —
        // so this is an INDEPENDENT dropper, not covered by the nodeService
        // fix. Without it a bulk-ingest of workspace B in async mode lands
        // B's graph rows but its embeds fall back to the boot store.
        for (const { node } of toEmbed) {
            const label = String(node.nodeData.label ?? '');
            const content = String(node.nodeData.content ?? '');
            const tags = tagsToArray(node.nodeData.tags as string | string[] | undefined);
            deps.embedQueue.enqueue(node.id, buildVerbatimText(label, content, tags), node.workspace);
        }
        return finish();
    }

    if (embed === 'precomputed') {
        return writePrecomputedVectors(toEmbed, resultSlots, deps, finish);
    }

    // sync mode: one embedDocumentBatch call → bulkAddPrebuiltRows.
    // When shouldAbort is set, force chunks so cancel can land between them.
    const texts = toEmbed.map(({ node }) => buildVerbatimText(
        String(node.nodeData.label ?? ''),
        String(node.nodeData.content ?? ''),
        tagsToArray(node.nodeData.tags as string | string[] | undefined),
    ));

    const abortedPipelineFromToEmbed = (from: number): number[] => {
        const ids = new Set(toEmbed.slice(from).map(({ node }) => node.id));
        const out: number[] = [];
        for (let i = 0; i < nodes.length; i++) {
            if (ids.has(nodes[i]!.id)) out.push(i);
        }
        return out;
    };

    let vectors: number[][];
    try {
        const chunkSize = opts.shouldAbort
            ? Math.min(
                opts.embedBatchSize && opts.embedBatchSize > 0 ? opts.embedBatchSize : ABORT_EMBED_CHUNK_SIZE,
                ABORT_EMBED_CHUNK_SIZE,
            )
            : opts.embedBatchSize;
        const chunked = Boolean(opts.shouldAbort)
            || (typeof chunkSize === 'number' && chunkSize > 0 && chunkSize < texts.length);
        if (chunked) {
            const size = (chunkSize && chunkSize > 0) ? chunkSize : ABORT_EMBED_CHUNK_SIZE;
            const chunks: number[][][] = [];
            for (let s = 0; s < texts.length; s += size) {
                if (aborted()) {
                    if (chunks.length > 0) {
                        const done = chunks.flat();
                        const doneItems = toEmbed.slice(0, s);
                        await writePrebuiltRowsPerWorkspace(deps, doneItems.map(({ node, idx }, i) => ({
                            node, idx,
                            row: {
                                vector: done[i]!,
                                id: `lore:${node.id}`,
                                text: texts[i]!,
                                type: String(node.nodeData.type ?? ''),
                                label: String(node.nodeData.label ?? ''),
                                tags: tagsToString(node.nodeData.tags as string | string[] | undefined),
                                project: String(node.nodeData.project ?? node.ecosystem),
                                ecosystem: node.ecosystem,
                                updatedAt: new Date().toISOString(),
                                security_scopes: (node.nodeData['security_scopes'] as string[] | undefined) ?? [],
                                contentHash: computeContentHash(texts[i]!),
                            },
                        })), resultSlots);
                    }
                    await rollbackPipelineIds(abortedPipelineFromToEmbed(s));
                    return finish();
                }
                chunks.push(await deps.embeddingProvider.embedDocumentBatch!(texts.slice(s, s + size)));
            }
            vectors = chunks.flat();
        } else {
            if (aborted()) {
                await rollbackPipelineIds(abortedPipelineFromToEmbed(0));
                return finish();
            }
            vectors = await deps.embeddingProvider.embedDocumentBatch!(texts);
        }
    } catch (embedErr) {
        // Embedding failed for the whole batch — mark all embedable nodes failed.
        const msg = (embedErr as Error).message?.slice(0, 300) ?? 'embed_batch_failed';
        for (const { node, idx } of toEmbed) {
            resultSlots[idx] = { ok: false, id: node.id, error: msg };
        }
        return finish();
    }

    // Write pre-built rows directly to LanceDB — no re-embedding.
    // R4 #4 — route each node's vector to ITS workspace's LanceDB (not the
    // boot/active store). writePrebuiltRowsPerWorkspace groups by node.workspace
    // and resolves each workspace's verbatim store. Same-id duplicates WITHIN
    // one call were collapsed keep-last in Step 0 (C3 3.4); as defence in
    // depth the sink (bulkUpsertPrebuiltRows) also dedupes its source batch
    // keep-last, since mergeInsert alone does not collapse duplicate source
    // keys. Cloud stores fall back to per-row store() (an upsert itself).
    if (aborted()) {
        await rollbackPipelineIds(abortedPipelineFromToEmbed(0));
        return finish();
    }

    await writePrebuiltRowsPerWorkspace(deps, toEmbed.map(({ node, idx }, i) => ({
        node, idx,
        row: {
            vector: vectors[i]!,
            id: `lore:${node.id}`,
            text: texts[i]!,
            type: String(node.nodeData.type ?? ''),
            label: String(node.nodeData.label ?? ''),
            tags: tagsToString(node.nodeData.tags as string | string[] | undefined),
            project: String(node.nodeData.project ?? node.ecosystem),
            ecosystem: node.ecosystem,
            updatedAt: new Date().toISOString(),
            security_scopes: (node.nodeData['security_scopes'] as string[] | undefined) ?? [],
            contentHash: computeContentHash(texts[i]!),
        },
    })), resultSlots);

    return finish();
}

async function writePrecomputedVectors(
    toEmbed: Array<{ node: BulkIngestNodeArgs; idx: number }>,
    resultSlots: BulkIngestResult['results'],
    deps: BulkIngestDeps,
    finish: () => BulkIngestResult,
): Promise<BulkIngestResult> {
    const expectedDim = deps.embeddingProvider.dimension;

    // Validate per-node: embedding present + correct dimension.
    const valid: Array<{ node: BulkIngestNodeArgs; idx: number; vector: number[] }> = [];
    for (const { node, idx } of toEmbed) {
        if (!node.embedding || node.embedding.length === 0) {
            resultSlots[idx] = {
                ok: false, id: node.id,
                error: `embed:'precomputed' requires node.embedding — missing on node '${node.id}'`,
            };
            continue;
        }
        if (node.embedding.length !== expectedDim) {
            resultSlots[idx] = {
                ok: false, id: node.id,
                error: `embedding dimension mismatch: got ${node.embedding.length}, model expects ${expectedDim}`,
            };
            continue;
        }
        valid.push({ node, idx, vector: node.embedding });
    }

    if (valid.length === 0) return finish();

    const texts = valid.map(({ node }) => buildVerbatimText(
        String(node.nodeData.label ?? ''),
        String(node.nodeData.content ?? ''),
        tagsToArray(node.nodeData.tags as string | string[] | undefined),
    ));

    // R4 #4 — route each precomputed vector to ITS workspace's LanceDB (not
    // the boot/active store), grouped per workspace; same-id duplicates were
    // collapsed keep-last in Step 0 (C3 3.4). (Cloud has no resolver;
    // bulkUpsertPrebuiltRows requires a local VerbatimStore — the helper's
    // per-row store() fallback ignores the precomputed vector, matching the
    // prior cloud behavior where the Dataplane re-embeds server-side.)
    await writePrebuiltRowsPerWorkspace(deps, valid.map(({ node, vector, idx }, i) => ({
        node, idx,
        row: {
            vector,
            id: `lore:${node.id}`,
            text: texts[i]!,
            type: String(node.nodeData.type ?? ''),
            label: String(node.nodeData.label ?? ''),
            tags: tagsToString(node.nodeData.tags as string | string[] | undefined),
            project: String(node.nodeData.project ?? node.ecosystem),
            ecosystem: node.ecosystem,
            updatedAt: new Date().toISOString(),
            security_scopes: (node.nodeData['security_scopes'] as string[] | undefined) ?? [],
            contentHash: computeContentHash(texts[i]!),
        },
    })), resultSlots);

    return finish();
}

function buildResult(
    count: number,
    slots: BulkIngestResult['results'],
): BulkIngestResult {
    const succeeded = slots.filter((r) => r?.ok).length;
    return { ok: succeeded === count, count, succeeded, results: slots };
}
