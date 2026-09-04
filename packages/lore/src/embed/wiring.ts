/**
 * embed/wiring.ts — daemon-side factory for the async embed queue.
 *
 * Extracted from server.ts to keep that file's size budget in check.
 *
 * Wires:
 *   - `EmbedQueue` (architecture gap #2)
 *   - Executor that fetches a node from the graph, builds the
 *     VerbatimDocument metadata, and writes through the vector store
 *     (which embeds + persists internally)
 *   - Permanent-failure log line per job that exhausts its retries
 *
 * Bulk import paths (and eventually store_node opt-in) enqueue here
 * instead of blocking on embed compute.
 */

import { EmbedQueue } from './queue.js';
import { tagsToString } from '../engines/normalizeTags.js';
import type { VerbatimStore } from '../engines/verbatimStore.js';
import type { DataplaneVectorStore } from '../engines/dataplaneVectorStore.js';
import { computeContentHash } from '../engines/contentHash.js';
import type { LoreGraphHandle } from '../storage/loreStorageClient.js';

// Widened when the local graph engine changed: naming the two CONCRETE
// classes silently excluded SurrealGraph (see engines/htmlExport.ts). Need
// more than the shared handle? Feature-detect and refuse — do not re-narrow
// to a class.
type LoreGraph = LoreGraphHandle;
type LoreVectorStore = VerbatimStore | DataplaneVectorStore;

export function wireEmbedQueue(input: {
    graph: LoreGraph;
    vectorStore: LoreVectorStore;
    concurrency?: number;
    /** RA2-reaudit2 — resolve a job's workspace to ITS graph + vector store.
     *  Without this, every job read from / wrote to the BOOT workspace, so an
     *  import (or any enqueue) targeting workspace B looked the node up in the
     *  boot graph (not found → embed silently skipped) and would have written
     *  B's embedding into the boot LanceDB. Returns null to fall back to the
     *  boot stores (jobs with no workspace, or no registry/resolver wired). */
    resolveStores?: (workspace: string) => Promise<{ graph: LoreGraph; vectorStore: LoreVectorStore } | null>;
    /**
     * 1.M2 (2026-08-17 audit) — forwarded to EmbedQueue. Previously NEVER
     * wired by any caller: a queue-overflow drop (enqueue() → false,
     * return value ignored at every call site) silently discarded the
     * embed. The daemon wires this to re-enqueue the shed embed as a
     * durable outbox embed.batch row, so overflow degrades to async
     * (replicator-drained) instead of silent loss — including embedded
     * mode, where the consistency-sweep recovery never runs.
     */
    onOverflow?: (dropped: { nodeId: string; text: string; workspace?: string }) => void;
}): EmbedQueue {
    const queue = new EmbedQueue({
        concurrency: input.concurrency ?? 4,
        onOverflow: input.onOverflow,
        onPermanentFailure: (job) => {
            console.error(`[embed-queue] permanent failure for ${job.nodeId}: ${job.lastError}`);
        },
    });
    queue.start(async ({ nodeId, text, workspace }) => {
        // RA2-reaudit2 — route the job to its own workspace's stores.
        let graph = input.graph;
        let vectorStore = input.vectorStore;
        if (workspace && input.resolveStores) {
            const resolved = await input.resolveStores(workspace);
            if (resolved) { graph = resolved.graph; vectorStore = resolved.vectorStore; }
        }
        const node = await graph.getNode(nodeId);
        if (!node) return; // node was deleted; nothing to embed
        // PR #69 P2: defence-in-depth — skip embed:false nodes that
        // somehow reached the queue (sweep should've filtered already,
        // but a future caller might enqueue directly). The verbatim
        // store would still embed them silently if we don't guard.
        if ((node as { embed?: boolean }).embed === false) return;
        await vectorStore.store({
            id: `lore:${nodeId}`,
            text,
            metadata: {
                type: node.type,
                label: node.label,
                tags: tagsToString(node.tags),
                project: node.project ?? '',
                ecosystem: node.ecosystem ?? '',
                // 2.2 (2026-08-17) — mirror the graph row's scopes so a re-embed
                // doesn't wipe a scoped row to [] (empty = public-within-workspace).
                security_scopes: node.security_scopes ?? [],
                updatedAt: node.updatedAt,
                // PR #69 P2: thread the contentHash through so the
                // verbatim store can short-circuit on cache hit instead
                // of computing it again. store() will fall back to
                // computing the hash from doc.text if we omit it; this
                // is purely a fast-path optimization.
                contentHash: computeContentHash(text),
            },
        });
    });
    return queue;
}
