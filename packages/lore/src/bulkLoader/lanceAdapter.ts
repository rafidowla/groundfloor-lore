/**
 * bulkLoader/lanceAdapter.ts — Sprint Z2 LanceDB-substrate loader.
 *
 * Per Sprint Z principle clauses 3 + 8 + Z0 audit Section 6.3: LanceDB
 * supports batched table.add(Arrow|rows, {mode:'append'}); the
 * memory-pressure caveat is "don't pass gigabyte arrays at once" —
 * Z2 chunks at 5000 rows/batch by default (configurable via opts
 * or env LORE_LANCE_BATCH_ROWS).
 *
 * Embed-mode contract (Z principle clause 8 + Z-D10 gate):
 *   - 'skip'   — vector column populated with the placeholder
 *                ZERO_VECTOR; the Sprint E re-embed job can backfill.
 *                This is the bulk-scale default; per Z0 measurement,
 *                embedding 100k rows inline takes ~5min by itself.
 *   - 'queued' — vector column populated with ZERO_VECTOR AND the
 *                runner emits an embed.batch outbox entry per chunk
 *                so the Sprint E BatchedEmbedder picks them up async.
 *                The adapter does NOT emit the outbox entry — that's
 *                the runner's job (single source for outbox commits).
 *   - 'inline' — vector embedded synchronously via the supplied
 *                `embedFn`. Per Z principle clause 8 + Z0 measurement
 *                this is NOT viable at bulk scale; we honor it for
 *                small loads + tests but the runner clamps the
 *                default to 'skip'.
 *
 * Per-row failure isolation (Sprint Z principle clause 5):
 *   LanceDB add() is all-or-nothing per call; if a row throws during
 *   row-build (e.g. malformed metadata) we exclude it from the chunk
 *   and report the row index. A whole-chunk add failure (rare —
 *   schema mismatch is the common cause) marks every row in the
 *   chunk failed.
 */

import type {
    BulkLoaderAdapter,
    BulkLoaderOpts,
    BatchResult,
    BulkLoaderCheckpoint,
} from './types.js';

/** Default rows per LanceDB add() call. Bounded to avoid the
 *  gigabyte-array memory-pressure scope guard from Z0. */
export const LANCE_BATCH_ROWS_DEFAULT = 5_000;

function readEnvBatchRows(): number {
    const raw = process.env['LORE_LANCE_BATCH_ROWS'];
    if (!raw) return LANCE_BATCH_ROWS_DEFAULT;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return LANCE_BATCH_ROWS_DEFAULT;
    return n;
}

export interface LanceRow {
    id: string;
    text: string;
    workspace: string;
    metadata?: Record<string, unknown>;
}

/**
 * Adapter delegates to a thin add-callback. The callback is supplied
 * by the runner from VerbatimStore (production) or an in-memory
 * fixture (tests). Keeping the dependency abstract avoids importing
 * lancedb-vectordb here — the verbatim store already owns that
 * dependency and we don't want a second initialization path.
 */
export type LanceAddRowsFn = (rows: LanceLoadRow[]) => Promise<void>;

/** Row shape handed to the LanceDB table.add() call. Matches
 *  VerbatimStore's verbatim schema columns. The runner uses
 *  buildLanceRow() to construct one. */
export interface LanceLoadRow {
    vector: number[];
    id: string;
    text: string;
    type: string;
    label: string;
    tags: string;
    project: string;
    ecosystem: string;
    updatedAt: string;
    security_scopes: string[];
    contentHash: string;
}

/** Optional embed function — only invoked when opts.embed === 'inline'.
 *  Returns one vector per input text. */
export type LanceEmbedFn = (texts: string[]) => Promise<number[][]>;

export interface LanceAdapterDeps {
    /** Vector dimension — used for the zero-vector placeholder when
     *  embed='skip' or 'queued'. Must match the VerbatimStore's
     *  embedding provider dimension. */
    vectorDim: number;
    /** Append the row set to LanceDB. Must be idempotent w.r.t. id
     *  (the runner manages dedup BEFORE this is called). */
    addRows: LanceAddRowsFn;
    /** Sprint Z3 — optional delete-by-id callback enabling idempotent
     *  resume (delete-then-add pattern). LanceDB add() itself is NOT
     *  id-idempotent — a duplicate add() produces duplicate rows.
     *  When supplied, the adapter calls this with the chunk's ids
     *  before add() so a resume after crash that re-writes any
     *  pre-checkpoint rows leaves a single copy of each id. If not
     *  supplied, the adapter falls back to plain add() (the Z2
     *  behavior — fine for tests / fixtures that don't crash). */
    deleteIds?: (ids: string[]) => Promise<void>;
    /** Optional inline embedder; only used when embed='inline'. */
    embedFn?: LanceEmbedFn;
    /** Override the per-chunk row cap (tests). */
    batchRows?: number;
}

export class LanceBulkLoaderAdapter implements BulkLoaderAdapter<LanceRow> {
    public readonly substrate = 'lance' as const;
    private readonly addRows: LanceAddRowsFn;
    private readonly deleteIds?: (ids: string[]) => Promise<void>;
    private readonly embedFn?: LanceEmbedFn;
    private readonly vectorDim: number;
    private readonly batchRows: number;
    private readonly zeroVector: number[];
    private opts: BulkLoaderOpts | null = null;

    constructor(deps: LanceAdapterDeps) {
        this.addRows = deps.addRows;
        this.deleteIds = deps.deleteIds;
        this.embedFn = deps.embedFn;
        this.vectorDim = deps.vectorDim;
        this.batchRows = Math.max(1, deps.batchRows ?? readEnvBatchRows());
        this.zeroVector = new Array(this.vectorDim).fill(0);
    }

    async begin(opts: BulkLoaderOpts): Promise<void> {
        this.opts = opts;
        if (opts.embed === 'inline' && !this.embedFn) {
            throw new Error('LanceBulkLoaderAdapter: embed=inline requested but no embedFn supplied');
        }
    }

    async writeBatch(rows: LanceRow[]): Promise<BatchResult> {
        if (!this.opts) {
            throw new Error('LanceBulkLoaderAdapter.writeBatch called before begin()');
        }
        if (rows.length === 0) {
            return { written: 0, failed: 0, errors: [] };
        }
        const o = this.opts;
        const errors: BatchResult['errors'] = [];
        let written = 0;
        let absOffset = o.baseRowIndex;

        // Chunk inside the adapter for the memory-pressure scope guard.
        // The runner may pass a much larger array; we further split it.
        for (let start = 0; start < rows.length; start += this.batchRows) {
            const chunkSrc = rows.slice(start, start + this.batchRows);
            const chunkBase = absOffset;
            const chunkValid: LanceLoadRow[] = [];
            const chunkTexts: string[] = [];

            for (let i = 0; i < chunkSrc.length; i++) {
                const row = chunkSrc[i];
                const idx = chunkBase + i;
                if (!row || typeof row.id !== 'string' || row.id.length === 0) {
                    errors.push({ rowIndex: idx, errorMessage: 'missing_or_invalid_id' });
                    continue;
                }
                if (row.workspace !== o.workspace) {
                    errors.push({
                        rowIndex: idx,
                        errorMessage: `workspace_mismatch (expected ${o.workspace}, got ${row.workspace})`,
                    });
                    continue;
                }
                try {
                    const built = this.buildRow(row);
                    chunkValid.push(built);
                    chunkTexts.push(row.text ?? '');
                } catch (err) {
                    errors.push({
                        rowIndex: idx,
                        errorMessage: (err as Error).message?.slice(0, 500) ?? 'build_row_failed',
                    });
                }
            }

            if (chunkValid.length === 0) {
                absOffset += chunkSrc.length;
                continue;
            }

            // Inline embed path — only runs when explicitly requested;
            // bulk default is 'skip' / 'queued' (Z principle clause 8).
            if (o.embed === 'inline' && this.embedFn) {
                try {
                    const vecs = await this.embedFn(chunkTexts);
                    for (let i = 0; i < chunkValid.length; i++) {
                        if (vecs[i] && vecs[i]!.length === this.vectorDim) {
                            chunkValid[i]!.vector = vecs[i]!;
                        }
                    }
                } catch (err) {
                    // Embedding failed — fall back to zero-vector so
                    // the rows still land (Sprint E re-embed can
                    // backfill). Report as a soft per-chunk error.
                    errors.push({
                        rowIndex: chunkBase,
                        errorMessage: `inline_embed_failed_falling_back_to_zero: ${(err as Error).message?.slice(0, 200)}`,
                    });
                }
            }

            try {
                // Sprint Z3 idempotent path — delete-then-add if the
                // wiring supplied a deleteIds callback. Per-chunk so
                // a partial resume crash doesn't leave duplicate rows
                // for ids that were written before the previous
                // checkpoint. The runner only re-feeds rows >= the
                // checkpoint, so this is bounded to the worst-case
                // single checkpoint window (default 10k rows).
                if (this.deleteIds) {
                    const ids = chunkValid.map((r) => r.id);
                    try { await this.deleteIds(ids); }
                    catch (delErr) {
                        // Non-fatal — fall through to plain add(). If
                        // there are residual duplicates, the verbatim
                        // store's downstream consumers can dedupe by
                        // id; the failure mode is wasted disk, not
                        // wrong results.
                        const msg = (delErr as Error).message?.slice(0, 200);
                        errors.push({ rowIndex: chunkBase, errorMessage: `lance_predelete_failed: ${msg}` });
                    }
                }
                await this.addRows(chunkValid);
                written += chunkValid.length;
            } catch (err) {
                // Whole-chunk add failed (schema mismatch / disk full).
                // Per Sprint Z principle clause 5 we report every row
                // we'd intended to add as failed.
                const errMsg = (err as Error).message?.slice(0, 500) ?? 'lance_add_failed';
                for (let i = 0; i < chunkValid.length; i++) {
                    errors.push({
                        rowIndex: chunkBase + i,
                        errorMessage: errMsg,
                    });
                }
            }
            absOffset += chunkSrc.length;
        }
        this.opts = { ...o, baseRowIndex: absOffset };
        return { written, failed: errors.length, errors };
    }

    /** Build a row matching VerbatimStore's schema. Zero-vector
     *  for skip/queued (Sprint E re-embed backfills). */
    private buildRow(row: LanceRow): LanceLoadRow {
        const md = row.metadata ?? {};
        return {
            vector: this.zeroVector.slice(), // copy so per-row inline embeds can mutate
            id: row.id,
            text: row.text ?? '',
            type: (md.type as string) ?? '',
            label: (md.label as string) ?? '',
            tags: (md.tags as string) ?? '',
            project: (md.project as string) ?? row.workspace,
            ecosystem: (md.ecosystem as string) ?? '',
            updatedAt: (md.updatedAt as string) ?? new Date().toISOString(),
            security_scopes: (md.security_scopes as string[]) ?? [],
            contentHash: (md.contentHash as string) ?? '',
        };
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
        // LanceDB add() auto-commits per call.
    }

    async rollback(): Promise<void> {
        // LanceDB has no transactional rollback for an append; the
        // Z3 contract will rely on idempotent ids + dedupe to recover.
    }
}
