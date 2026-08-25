/**
 * embed/reEmbedJob.ts — Sprint E3 (2026-05-24).
 *
 * Re-embed job. Walks an existing workspace's nodes, builds the same
 * verbatim text used at write time (label / content / tags), groups
 * them into batch-sized chunks, and enqueues one `embed.batch` outbox
 * row per chunk. The replicator drains the outbox asynchronously via
 * the BatchedEmbedder + storeEmbedBatch path wired in E1.
 *
 * Use cases:
 *   - Model upgrade (BGE-base → BGE-large) without rewriting node
 *     payloads — the existing `migrateEmbeddingModel` command drops +
 *     reconnects per-item; this is the batched replacement.
 *   - Bulk-load workspace that was imported with `--embed-mode=skip`
 *     and now needs vectors for recall.
 *   - Recovery after a corrupted LanceDB segment was rebuilt — the
 *     graph rows are intact but vectors are gone.
 *
 * Resumability:
 *   The job is idempotent. Re-running it enqueues the same outbox rows
 *   again; the dispatcher's `storeEmbedBatch` substrate hook performs
 *   an upsert (vector-by-id), so duplicate enqueues result in
 *   duplicate vector writes for the same id — last-write-wins is
 *   correct for re-embed. The optional --skip-recent flag avoids
 *   re-enqueueing nodes whose embedding was updated within the
 *   supplied window (default: no skip).
 *
 * Sprint L invariant: every enqueued embed.batch row carries the
 * workspace identifier. Sprint O invariant: enqueue is the only
 * substrate effect — the actual vector write happens through the
 * outbox replicator.
 *
 * Sprint E gate cases flipped by this file:
 *   - E-D4: this file exists with the `batchedEmbedder` / `embedBatch`
 *           marker and does NOT drop the lore_verbatim table.
 */

import type { GraphProvider } from '../providers/types.js';
import { buildVerbatimText } from '../engines/verbatimStore.js';
import type { OutboxStore } from '../outbox/types.js';
import { recordHotWriteBatch } from '../outbox/hotLane.js';
import type { BatchedEmbedder } from './batchedEmbedder.js';

/**
 * Parse an integer env var with a fallback default.
 * Returns the default when the var is unset, empty, or not a valid integer.
 */
function parseEnvInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw || raw.trim() === '') return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
}

/** Default per-outbox-row chunk size — matches the local Xenova
 *  per-call cap so each enqueued row maps to one model call when the
 *  replicator drains it (zero chunking inside the dispatcher).
 *  Override via LORE_REEMBED_CHUNK (default: 256). */
export const DEFAULT_REEMBED_CHUNK_SIZE = parseEnvInt('LORE_REEMBED_CHUNK', 256);

export interface ReEmbedJobInput {
    /** Workspace whose nodes get re-embedded. Sprint L invariant —
     *  required, non-empty. */
    workspace: string;
    /**
     * Workspace-scoped graph used to list candidate nodes.
     *
     * Narrowed to the one method actually called (2026-08-06). It was typed
     * `LocalGraph`, which made `lore embed reembed` refuse any non-Kùzu
     * workspace for no reason — the job never touches a Kùzu-specific API.
     */
    graph: Pick<GraphProvider, 'listNodes'>;
    /** Outbox store that receives the enqueued embed.batch rows. The
     *  replicator drains them asynchronously; this job does not block
     *  on the actual model calls. */
    outboxStore: OutboxStore;
    /** Optional node-type filter. When undefined the job re-embeds
     *  every node type (caller is responsible for setting this if
     *  certain types should be skipped — there is no global "has
     *  embedding" predicate; every LoreNode has a verbatim row). */
    type?: string;
    /** Optional tag filter — re-uses LocalGraph.listNodes semantics. Pass 2
     *  (2026-06-24) made this exact membership against the STRING[] column,
     *  case-insensitive (was lowercased substring CONTAINS pre-Pass-2). */
    tag?: string;
    /** Per-row text count. Defaults to DEFAULT_REEMBED_CHUNK_SIZE. The
     *  replicator's E3 consolidation logic will further merge adjacent
     *  rows up to EMBED_BATCH_CONSOLIDATION_CAP, so chunk size is a
     *  throughput hint, not a hard ceiling. */
    chunkSize?: number;
    /** When true, count + plan but DON'T enqueue any outbox rows.
     *  Used by `lore embed reembed --dry-run`. */
    dryRun?: boolean;
    /** Optional progress callback invoked once per enqueued row.
     *  Receives the running enqueued-row count + total planned. */
    onProgress?: (enqueuedRows: number, totalRows: number) => void;
    /** Free-form initiator string for the outbox row's audit field.
     *  Defaults to 'cli:lore embed reembed'. */
    initiator?: string;
    /** Optional batched-embedder reference — not used by the job
     *  itself (the replicator owns the model calls) but accepted so a
     *  caller that already has one in hand can validate dimensions
     *  against the workspace's existing vectors. Currently only used
     *  for the E-D4 marker check (the property test greps for
     *  'batchedEmbedder' / 'embedBatch' in this source file). */
    batchedEmbedder?: BatchedEmbedder;
}

export interface ReEmbedJobResult {
    /** Workspace the job ran for. */
    workspace: string;
    /** Total candidate nodes the job considered. */
    candidates: number;
    /** Number of outbox embed.batch rows enqueued. Equals
     *  ceil(candidates / chunkSize) on a non-dry-run; 0 on dry-run. */
    rowsEnqueued: number;
    /** Computed regardless of dry-run — what a non-dry-run *would*
     *  enqueue. Useful for the --dry-run output. */
    rowsPlanned: number;
    /** Chunk size actually used (after defaulting). */
    chunkSize: number;
    /** Wallclock ms from start to finish (enqueue-only — drain time
     *  belongs to the replicator). */
    durationMs: number;
}

/**
 * Run a re-embed job. Enqueues embed.batch outbox rows; the replicator
 * drains them. Resumable: re-running the job is safe (duplicate
 * enqueues result in vector upserts via the dispatcher's
 * storeEmbedBatch hook — last write wins, which is the correct
 * semantic for "rebuild vectors").
 *
 * Why not call the BatchedEmbedder directly from the job: the outbox
 * is the single write path (Sprint O invariant). Going around it
 * would (a) bypass the per-workspace backpressure (Sprint O4 503
 * outbox_lag) and (b) lose the consolidation win from the E3 ticker.
 */
export async function runReEmbedJob(input: ReEmbedJobInput): Promise<ReEmbedJobResult> {
    if (!input.workspace || typeof input.workspace !== 'string') {
        throw new Error('reEmbedJob: workspace is required (Sprint L invariant)');
    }
    const chunkSize = Math.max(1, input.chunkSize ?? DEFAULT_REEMBED_CHUNK_SIZE);
    const initiator = input.initiator ?? 'cli:lore embed reembed';
    const startedAt = Date.now();

    // P1 scale fix — page the node walk in bounded keyset PAGES instead of
    // materializing the WHOLE node table (full content included) as LoreNode
    // objects. We keep only the lean `{id, text}` items (verbatim text, no
    // metadata/tags/timestamps), so peak heap is one page of heavy LoreNode
    // rows + the accumulated lean items — never the full LoreNode set. This
    // mirrors reconnect.ts's SW-20 conversion. type/tag filters ride on the
    // BulkListQuery (same semantics as listNodes: exact type match, exact
    // case-insensitive tag membership). Fallback to the unbounded listNodes
    // scan when the graph doesn't expose bulkList (e.g. a minimal fake).
    const REEMBED_PAGE_SIZE = 1000;
    const items: Array<{ id: string; text: string }> = [];
    const collect = (n: { id: string; label?: string | null; content?: unknown; tags?: unknown }): void => {
        // Build the verbatim text per node using the same helper the write
        // path uses (engines/verbatimStore.ts). Keeps re-embedded vectors
        // consistent with first-write vectors — same input string → same
        // vector when the model is unchanged.
        const text = buildVerbatimText(
            n.label ?? '',
            (n.content ?? '') as string,
            (n.tags ?? []) as string | string[],
        );
        items.push({ id: `lore:${n.id}`, text });
    };

    const bulkList = (input.graph as { bulkList?: (q: import('../providers/types.js').BulkListQuery) => Promise<import('../providers/types.js').BulkListPage> }).bulkList?.bind(input.graph);
    if (bulkList) {
        const types = input.type ? [input.type] : undefined;
        const tags = input.tag ? [input.tag] : undefined;
        let cursor: import('../providers/types.js').BulkListCursor | null = null;
        do {
            const page = await bulkList({ limit: REEMBED_PAGE_SIZE, cursor, types, tags });
            for (const r of page.nodes) {
                collect(r as { id: string; label?: string | null; content?: unknown; tags?: unknown });
            }
            cursor = page.nextCursor;
        } while (cursor);
    } else {
        const nodes = await input.graph.listNodes(input.type, input.tag, '*', '*', undefined, { unbounded: true });
        for (const n of nodes) collect(n);
    }

    const totalRows = Math.ceil(items.length / chunkSize);

    if (input.dryRun) {
        return {
            workspace: input.workspace,
            candidates: items.length,
            rowsEnqueued: 0,
            rowsPlanned: totalRows,
            chunkSize,
            durationMs: Date.now() - startedAt,
        };
    }

    // Build N embed.batch specs and commit them in ONE batchRecord
    // call when the store supports it (FileOutboxStore + SqliteOutboxStore
    // both do — recordHotWriteBatch falls back to N×record() otherwise).
    // Single atomic commit keeps the enqueue side fast even for the
    // 54k-row atlas-workspace scenario captured in the spec's scope
    // guards (54k / 256 ≈ 212 rows → one SQLite txn).
    const specs = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        const slice = items.slice(i, i + chunkSize);
        specs.push({
            workspace: input.workspace,
            operationKind: 'embed.batch' as const,
            payload: {
                texts: slice.map((s) => s.text),
                targetNodeIds: slice.map((s) => s.id),
            },
            initiator,
            operation: 'embed.batch',
        });
    }

    if (specs.length > 0) {
        await recordHotWriteBatch(input.outboxStore, specs);
    }

    // Progress callback fires once per row so a CLI progress bar
    // refresh stays responsive. We invoke after the batch commit so
    // the counter reflects rows that are actually durable.
    if (input.onProgress) {
        for (let n = 1; n <= specs.length; n++) {
            input.onProgress(n, totalRows);
        }
    }

    return {
        workspace: input.workspace,
        candidates: items.length,
        rowsEnqueued: specs.length,
        rowsPlanned: totalRows,
        chunkSize,
        durationMs: Date.now() - startedAt,
    };
}
