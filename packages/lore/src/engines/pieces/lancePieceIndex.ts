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
import { assertSafeLanceId, isRevisionHistoryId, buildLanceFilterConditions } from '../verbatimHistory.js';
import { VERBATIM_CHUNK_SIZE } from '../verbatimBatch.js';
import { log } from '../../logger.js';
import { applyActorScopeFilter } from '../../security/scopeFilter.js';
import {
    buildPieces, stripLeadingLabel, isPieceSidecarValid, readPieceSidecar,
    writePieceSidecar, freshPieceSidecar,
} from './pieceLayout.js';

const PIECE_TABLE_NAME = 'lore_verbatim_pieces';

export interface PieceSourceRow {
    /** Owning node id — canonical `lore_verbatim.id`. */
    id: string;
    label?: string;
    /** Full canonical row text (buildVerbatimText's [label, content,
     *  tags] join) — this class strips the label prefix itself via
     *  stripLeadingLabel before windowing. */
    text: string;
    type?: string;
    project?: string;
    ecosystem?: string;
    security_scopes?: string[];
}

export interface PieceSearchHit {
    nodeId: string;
    score: number;
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

    constructor(
        private readonly basePath: string,
        private readonly lancedbPath: string,
        private readonly embeddingProvider: EmbeddingProvider,
    ) {}

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

    private async embedPieceTexts(texts: string[]): Promise<number[][]> {
        if (typeof this.embeddingProvider.embedDocumentBatch === 'function') {
            return this.embeddingProvider.embedDocumentBatch(texts);
        }
        const out: number[][] = [];
        for (const t of texts) out.push(await this.embeddingProvider.embedDocument(t));
        return out;
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
     */
    async upsertForRows(rows: PieceSourceRow[]): Promise<void> {
        if (!this.valid) return;
        const liveIds = rows.map((r) => r.id).filter((id) => !isRevisionHistoryId(id));
        if (liveIds.length === 0) return;
        const toWrite: Record<string, unknown>[] = [];
        for (const row of rows) {
            if (isRevisionHistoryId(row.id)) continue;
            const body = stripLeadingLabel(row.text, row.label);
            const { pieces } = await buildPieces(this.embeddingProvider, row.label, body);
            if (pieces.length === 0) continue;
            const vectors = await this.embedPieceTexts(pieces.map((p) => p.text));
            for (let i = 0; i < pieces.length; i++) {
                toWrite.push({
                    id: `${row.id}#p${pieces[i].pieceIndex}`,
                    nodeId: row.id,
                    pieceIndex: pieces[i].pieceIndex,
                    isTitle: pieces[i].isTitle,
                    text: pieces[i].text,
                    vector: vectors[i],
                    type: row.type ?? null,
                    project: row.project ?? null,
                    ecosystem: row.ecosystem ?? null,
                    security_scopes: row.security_scopes ?? [],
                });
            }
        }
        if (!this.table) return; // valid but no table would be an internal contradiction; guard defensively
        await this.deleteForIds(liveIds);
        if (toWrite.length > 0) await this.table.add(toWrite);
    }

    /** Deletes every piece belonging to each id in `ids` (a node's full
     *  piece set, by `nodeId`, not a single piece row). No-op when the
     *  index isn't open. */
    async deleteForIds(ids: string[]): Promise<void> {
        if (!this.valid || !this.table || ids.length === 0) return;
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
