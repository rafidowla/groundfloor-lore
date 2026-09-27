/**
 * lancePieceIndex.ts — D7 (3.23, piece-level vectors), design section 2.4.
 *
 * `lore_verbatim_pieces` — a derived LanceDB table alongside the canonical
 * `lore_verbatim` table, one row per piece (title row + body windows, see
 * pieceLayout.ts). Opt-in, off by default; maintained by VerbatimStore's
 * write hooks whenever a valid sidecar exists, queried only by the
 * (out-of-scope, later-slice) retrieval layer when intent is explicitly on.
 *
 * No cross-table atomicity with the canonical `lore_verbatim` table exists
 * on Lance — the canonical mergeInsert and this table's writes are two
 * separate operations. This is a deliberate, accepted limitation (design
 * 2.7): a crash between the two leaves pieces briefly behind the canonical
 * row, self-limiting and repaired by the (out-of-scope) migration/rebuild
 * CLI, not by heavier transactional machinery here.
 */

import * as lancedb from '@lancedb/lancedb';
import { Schema, Field, FixedSizeList, Float32, Int32, Bool, List, Utf8 } from 'apache-arrow';

import type { EmbeddingProvider } from '../../providers/types.js';
import {
    assertSafeLanceId, buildLanceFilterConditions, HISTORY_ID_LIKE_PATTERN,
} from '../verbatimHistory.js';
import { VERBATIM_CHUNK_SIZE } from '../verbatimBatch.js';
import { log } from '../../logger.js';
import { applyActorScopeFilter } from '../../security/scopeFilter.js';
import {
    buildPieceRecords, isPieceSidecarValid, readPieceSidecar,
    writePieceSidecar, freshPieceSidecar, markPieceSidecarIncomplete,
    type PieceSourceRow, type BuiltPieceRecord,
} from './pieceLayout.js';
import { PendingPieceQueue, type PendingPieceRow } from './pendingPieceQueue.js';

export type { PieceSourceRow } from './pieceLayout.js';

const PIECE_TABLE_NAME = 'lore_verbatim_pieces';

export interface PieceSearchHit {
    nodeId: string;
    score: number;
}

/** One node's prebuilt pieces, shipped from the search-worker parent back to
 *  the child (3.24.1). `seq` is the PendingPieceQueue sequence the parent
 *  took the row under. */
export interface PrebuiltPieceBatchEntry {
    id: string;
    seq: number;
    records: BuiltPieceRecord[];
}

export interface PieceIndexStatus {
    open: boolean;
    valid: boolean;
    reason?: string;
}

function buildPieceSchema(dimension: number): Schema {
    return new Schema([
        new Field('vector', new FixedSizeList(dimension, new Field('item', new Float32(), true)), false),
        new Field('id', new Utf8(), false), // `${nodeId}#p${pieceIndex}`
        new Field('nodeId', new Utf8(), false),
        new Field('pieceIndex', new Int32(), false),
        new Field('isTitle', new Bool(), false),
        new Field('text', new Utf8(), false),
        new Field('type', new Utf8(), true),
        new Field('project', new Utf8(), true),
        new Field('ecosystem', new Utf8(), true),
        new Field('security_scopes', new List(new Field('item', new Utf8(), true)), true),
    ]);
}

export class LancePieceIndex {
    private db: lancedb.Connection | null = null;
    private table: lancedb.Table | null = null;
    private valid = false;
    private invalidReason: string | undefined;
    private warnedStaleOnce = false;
    /** 3.24.1 — set only in the search-worker child under parent-embeds
     *  (its provider is a stub): write hooks enqueue here instead of
     *  building, and the parent builds + ships pieces back. */
    private readonly deferred: PendingPieceQueue | null;

    constructor(
        private readonly basePath: string,
        private readonly lancedbPath: string,
        private readonly embeddingProvider: EmbeddingProvider,
        opts?: { deferBuild?: boolean },
    ) {
        this.deferred = opts?.deferBuild ? new PendingPieceQueue() : null;
    }

    get isOpen(): boolean {
        return this.valid && this.table !== null;
    }

    /**
     * Opens the piece table when the on-disk sidecar is valid for the
     * live embedding provider. When `intentOn` and `canonicalIsEmpty`
     * (design 2.3 — a fresh/empty store with the feature on), creates a
     * fresh, valid, empty index immediately rather than waiting for the
     * first write to discover there is no usable index yet.
     */
    async initialize(opts: { intentOn: boolean; canonicalIsEmpty: boolean }): Promise<void> {
        const sidecar = readPieceSidecar(this.basePath);
        const check = isPieceSidecarValid(sidecar, this.embeddingProvider);
        if (check.valid) {
            this.db = await lancedb.connect(this.lancedbPath);
            try {
                this.table = await this.db.openTable(PIECE_TABLE_NAME);
                this.valid = true;
                return;
            } catch (err) {
                // Sidecar says valid but the table itself is missing (e.g.
                // removed out of band) — no partial use: treat as stale.
                log.warn(`[LancePieceIndex] sidecar valid but table open failed (treating as stale): ${(err as Error).message}`);
                this.valid = false;
                this.invalidReason = 'sidecar valid but table missing';
            }
        } else {
            this.invalidReason = check.reason;
        }
        if (opts.intentOn && opts.canonicalIsEmpty) {
            await this.createEmpty();
            return;
        }
        if (opts.intentOn) this.warnStaleOnce();
    }

    private warnStaleOnce(): void {
        if (this.warnedStaleOnce) return;
        this.warnedStaleOnce = true;
        log.warn(`[LancePieceIndex] piece vectors requested but the index is stale (${this.invalidReason ?? 'unknown reason'}) — serving without piece search until it is rebuilt.`);
    }

    private async createEmpty(): Promise<void> {
        this.db = this.db ?? await lancedb.connect(this.lancedbPath);
        this.table = await this.db.createEmptyTable(PIECE_TABLE_NAME, buildPieceSchema(this.embeddingProvider.dimension));
        writePieceSidecar(this.basePath, freshPieceSidecar(this.embeddingProvider, 'model'));
        this.valid = true;
        this.invalidReason = undefined;
    }

    /**
     * Rebuild every piece for each row in `rows` (full replace, not merge
     * — the piece count for a node changes between writes as its body
     * grows/shrinks, so a stale piece from a previous, longer version
     * must not survive). `#rev...` history snapshot ids are silently
     * skipped — they are never pieced, matching the canonical store's own
     * history-row exclusions elsewhere. No-op when the index isn't open
     * (stale/absent sidecar): pieces are only maintained alongside a
     * valid index, never partially, never against a stale one.
     *
     * 3.24.1 — never throws from a store write hook: a failure marks the
     * index incomplete (see markIncomplete) so it reports `not_built`
     * instead of quietly serving with holes. `throwOnError` is for the
     * migration CLI only, which owns the sidecar lifecycle itself and
     * must abort rather than write `complete:true` over a failed batch.
     * In deferred (worker-child) mode the rows are queued for the parent
     * instead of built here.
     */
    async upsertForRows(rows: PieceSourceRow[], opts?: { throwOnError?: boolean }): Promise<void> {
        if (!this.valid) return;
        if (this.deferred && !opts?.throwOnError) {
            this.deferred.enqueue(rows);
            return;
        }
        try {
            const { liveIds, records } = await buildPieceRecords(this.embeddingProvider, rows);
            await this.writeRecords(liveIds, records);
        } catch (err) {
            if (opts?.throwOnError) throw err;
            this.markIncomplete(`piece upsert failed for ${rows.length} row(s): ${(err as Error).message}`);
        }
    }

    private async writeRecords(liveIds: string[], records: BuiltPieceRecord[]): Promise<void> {
        if (liveIds.length === 0) return;
        if (!this.table) return; // valid but no table would be an internal contradiction; guard defensively
        await this.deleteRows(liveIds);
        if (records.length > 0) await this.table.add(records as unknown as Record<string, unknown>[]);
    }

    /** 3.24.1 (worker child) — hand up to `limit` queued rows to the parent
     *  to build. Empty when not in deferred mode or nothing is queued. */
    takePending(limit: number): PendingPieceRow[] {
        if (!this.deferred || !this.valid) return [];
        return this.deferred.take(limit);
    }

    /** 3.24.1 (worker child) — persist pieces the parent built. An entry is
     *  written only if its `seq` is still the latest write for that node
     *  (see PendingPieceQueue); stale entries are dropped. Returns how many
     *  nodes were written. */
    async upsertPrebuilt(batch: PrebuiltPieceBatchEntry[]): Promise<number> {
        if (!this.valid || !this.deferred) return 0;
        const accepted = batch.filter((e) => this.deferred!.accept(e.id, e.seq));
        if (accepted.length === 0) return 0;
        try {
            await this.writeRecords(accepted.map((e) => e.id), accepted.flatMap((e) => e.records));
        } catch (err) {
            this.markIncomplete(`prebuilt piece upsert failed for ${accepted.length} row(s): ${(err as Error).message}`);
            return 0;
        }
        return accepted.length;
    }

    /**
     * 3.24.1 — a piece write failed, so the index no longer covers every
     * canonical row. Stop serving it (no partial use), persist
     * `complete:false` so every later open reports `not_built` too, and
     * `log.error` once per valid→incomplete transition (not once per row).
     * Recovery is `lore migrate piece-vectors` with the host stopped.
     */
    markIncomplete(detail: string): void {
        const wasValid = this.valid;
        this.valid = false;
        this.invalidReason = 'incomplete build';
        this.deferred?.clear();
        try {
            markPieceSidecarIncomplete(this.basePath, this.embeddingProvider);
        } catch (err) {
            log.warn(`[LancePieceIndex] could not persist the incomplete marker: ${(err as Error).message}`);
        }
        if (wasValid) {
            log.error(`[LancePieceIndex] piece index marked incomplete — piece search is off until it is rebuilt (stop the host, run \`lore migrate piece-vectors\`, restart): ${detail}`);
        }
    }

    /**
     * 3.24.1 — open-time coverage check for indexes damaged before the
     * incomplete marker existed (3.24.0 under the search worker left the
     * table empty behind a valid, complete sidecar). Count-only, no scan of
     * vectors: every pieced node has exactly one `pieceIndex = 0` row, so
     * that count is the number of covered nodes. Only when it falls short
     * of the canonical table's total row count is the (filtered) live-row
     * count taken — history snapshots, tombstones and empty rows are never
     * pieced. Fewer covered nodes than live rows → markIncomplete.
     */
    async verifyCoverage(canonical: lancedb.Table | null): Promise<void> {
        if (!this.valid || !this.table || !canonical) return;
        const covered = await this.table.countRows('pieceIndex = 0');
        const total = await canonical.countRows();
        if (covered >= total) return;
        const live = await canonical.countRows(
            `id NOT LIKE '${HISTORY_ID_LIKE_PATTERN}' AND text NOT LIKE '[TOMBSTONED%' AND text != ''`,
        );
        if (covered < live) {
            this.markIncomplete(`piece index covers ${covered} of ${live} live node(s)`);
        }
    }

    /** Deletes every piece belonging to each id in `ids` (a node's full
     *  piece set, by `nodeId`, not a single piece row). No-op when the
     *  index isn't open. 3.24.1 — never throws: a failed delete leaves
     *  pieces for a node that is gone or changed, so it marks the index
     *  incomplete like a failed upsert. */
    async deleteForIds(ids: string[]): Promise<void> {
        this.deferred?.forget(ids);
        if (!this.valid || !this.table || ids.length === 0) return;
        try {
            await this.deleteRows(ids);
        } catch (err) {
            this.markIncomplete(`piece delete failed for ${ids.length} id(s): ${(err as Error).message}`);
        }
    }

    private async deleteRows(ids: string[]): Promise<void> {
        if (!this.table) return;
        ids.forEach((id) => assertSafeLanceId(id, 'LancePieceIndex.deleteForIds'));
        for (let i = 0; i < ids.length; i += VERBATIM_CHUNK_SIZE) {
            const chunk = ids.slice(i, i + VERBATIM_CHUNK_SIZE);
            const list = chunk.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
            await this.table.delete(`nodeId IN (${list})`);
        }
    }

    /**
     * D7b — piece-level vector search, topK piece hits highest score first.
     * `queryVector` is pre-embedded by the caller (VerbatimStore.searchPieces
     * embeds once, the same as the canonical `search()` path). `filter` is
     * pushed down via the same allowlisted `buildLanceFilterConditions` the
     * canonical vector/BM25 paths use (D2/E2), and `actorScopes` is enforced
     * the same way `_runVectorSearchUncached` enforces it on the canonical
     * table — piece rows carry `security_scopes` flat, so hits are wrapped in
     * the `{metadata: {security_scopes}}` shape `applyActorScopeFilter`
     * expects rather than reimplementing the scope check here.
     *
     * Score formula fixed to the canonical `1 - _distance/2` convention
     * (design 2.5, and `_runVectorSearchUncached` above) — D7a's original
     * version used `1 - _distance` here, which does not match either the
     * documented convention or the canonical table's own formula.
     */
    async searchPieces(
        queryVector: number[],
        topK: number,
        filter?: Record<string, unknown>,
        actorScopes?: ReadonlyArray<string>,
    ): Promise<PieceSearchHit[]> {
        if (!this.valid || !this.table) return [];
        const conditions = buildLanceFilterConditions(filter);
        let qb = this.table.search(queryVector).limit(topK);
        if (conditions.length > 0) qb = qb.filter(conditions.join(' AND '));
        const hits = await qb.toArray();
        const mapped = hits.map((h: Record<string, unknown>) => ({
            nodeId: h.nodeId as string,
            score: typeof h._distance === 'number' ? 1 - (h._distance as number) / 2 : 0,
            metadata: { security_scopes: (h.security_scopes as string[] | undefined) ?? [] },
        }));
        return applyActorScopeFilter(mapped, actorScopes).map(({ nodeId, score }) => ({ nodeId, score }));
    }

    async count(): Promise<number> {
        if (!this.table) return 0;
        try {
            return await this.table.countRows();
        } catch (err) {
            log.warn(`[LancePieceIndex] countRows failed: ${(err as Error).message}`);
            return 0;
        }
    }

    async drop(): Promise<void> {
        if (!this.db) return;
        try {
            await this.db.dropTable(PIECE_TABLE_NAME);
        } catch (err) {
            log.warn(`[LancePieceIndex] dropTable failed (table may already be absent): ${(err as Error).message}`);
        }
        this.table = null;
        this.valid = false;
    }

    /**
     * D7c (migration only) — (re)create the table fresh and empty, and mark
     * this index valid, WITHOUT touching the sidecar: the caller
     * (pieceIndexBuild.ts's buildPieceIndex) owns the sidecar's crash-safe
     * complete:false/true lifecycle itself and must control write order.
     * Needed because initialize()'s own auto-create only fires for a
     * brand-new EMPTY canonical store with intent already on
     * (`intentOn && canonicalIsEmpty`) — a migration run must be able to
     * (re)create the table unconditionally, over an existing, possibly
     * non-empty, canonical store. Throws on failure rather than leaving
     * `valid` false silently, so callers writing after this must not
     * mistake a no-op upsert loop for a real rebuild (see drop()'s
     * `this.valid = false` — every upsertForRows()/deleteForIds() below is
     * a no-op while invalid, which is exactly the state this method exists
     * to get out of).
     */
    async createEmptyForRebuild(): Promise<void> {
        this.db = this.db ?? await lancedb.connect(this.lancedbPath);
        try {
            await this.db.dropTable(PIECE_TABLE_NAME);
        } catch {
            // fine if it doesn't exist yet
        }
        this.table = await this.db.createEmptyTable(PIECE_TABLE_NAME, buildPieceSchema(this.embeddingProvider.dimension));
        this.valid = true;
        this.invalidReason = undefined;
    }

    status(): PieceIndexStatus {
        return { open: this.isOpen, valid: this.valid, reason: this.invalidReason };
    }

    async close(): Promise<void> {
        this.table = null;
        this.db = null;
    }
}
