/**
 * sqlitePieceIndex.ts — D7 (3.23, piece-level vectors), design section 2.4,
 * SQLite engine.
 *
 * `verbatim_pieces` — a table in the SAME `verbatim.sqlite` database
 * SqliteVerbatimStore already has open (not a separate file), one row per
 * piece (title row + body windows, see pieceLayout.ts). Opt-in, off by
 * default; maintained by SqliteVerbatimStore's write hooks, called AFTER
 * the existing canonical write completes (see sqliteVerbatimStore.ts's
 * writeDeps()/write-method wrappers) — a separate sequential step, not
 * inside the same better-sqlite3 transaction as the canonical write.
 * sqliteVerbatimWrite.ts's own functions are fully synchronous and piece
 * embedding is inherently async, so forcing both into one transaction
 * would require invasive signature changes there; this mirrors the Lance
 * engine's own already-accepted lack of cross-table atomicity between
 * `lore_verbatim` and `lore_verbatim_pieces` (design 2.7) — "sequential,
 * not atomic together" is the deliberate stance on BOTH engines, not a
 * SQLite-only gap.
 *
 * Deliberately does NOT reuse sqliteVerbatimVector.ts's nativeVectorSearch/
 * BruteForceVectorCache — both are hardcoded to the `verbatim` table name
 * and its column set. Only `encodeVector`/`decodeVector`/`RowFilter` are
 * reused; this file implements its own minimal (JS brute-force only, no
 * sqlite-vec fast path) query logic against `verbatim_pieces`. Piece
 * search is not on D7a's critical path (retrieval routing is a later,
 * out-of-scope slice) — correctness over the same encode/decode contract
 * the canonical path uses matters here, raw query speed does not yet.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import type { EmbeddingProvider } from '../../providers/types.js';
import { log } from '../../logger.js';
import { encodeVector, decodeVector, type RowFilter } from '../sqliteVerbatimVector.js';
import { isRevisionHistoryId } from '../verbatimHistory.js';
import { VERBATIM_CHUNK_SIZE } from '../verbatimBatch.js';
import {
    buildPieces, stripLeadingLabel, isPieceSidecarValid, readPieceSidecar,
    writePieceSidecar, freshPieceSidecar,
} from './pieceLayout.js';

export interface PieceSourceRow {
    id: string;
    label?: string;
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

function ensureSchema(db: DatabaseType): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS verbatim_pieces (
            rowid INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            nodeId TEXT NOT NULL,
            pieceIndex INTEGER NOT NULL,
            isTitle INTEGER NOT NULL DEFAULT 0,
            text TEXT NOT NULL,
            vector BLOB,
            type TEXT,
            project TEXT,
            ecosystem TEXT,
            security_scopes TEXT
        );
        CREATE INDEX IF NOT EXISTS verbatim_pieces_nodeId_idx ON verbatim_pieces(nodeId);
    `);
}

function dropSchema(db: DatabaseType): void {
    db.exec(`DROP TABLE IF EXISTS verbatim_pieces;`);
}

interface PieceRowRaw {
    id: string;
    nodeId: string;
    text: string;
    vector: Buffer | null;
    type: string | null;
    project: string | null;
    ecosystem: string | null;
    security_scopes: string | null;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, na = 0, nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const av = a[i]!, bv = b[i]!;
        dot += av * bv; na += av * av; nb += bv * bv;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function matchesFilter(row: PieceRowRaw, filter: RowFilter): boolean {
    for (const [key, value] of filter) {
        const rowValue = (row as unknown as Record<string, unknown>)[key];
        if (Array.isArray(value)) {
            if (!value.includes(rowValue as string)) return false;
        } else if (rowValue !== value) {
            return false;
        }
    }
    return true;
}

/** Same public-within-workspace / intersection semantics as
 *  security/scopeFilter.ts's applyActorScopeFilter, reimplemented locally
 *  because that helper is typed against a `{metadata:{security_scopes}}`
 *  shape and PieceSearchHit carries no metadata — the piece row's own
 *  scopes are checked here, before the row is reduced to {nodeId, score}. */
function actorCanSeeRow(row: PieceRowRaw, actorScopes: ReadonlyArray<string> | undefined): boolean {
    if (actorScopes === undefined) return true;
    const allowed = new Set(actorScopes);
    let rowScopes: string[] = [];
    if (row.security_scopes) {
        try {
            const parsed = JSON.parse(row.security_scopes);
            if (Array.isArray(parsed)) rowScopes = parsed as string[];
        } catch (err) {
            log.warn(`[SqlitePieceIndex] unparseable security_scopes on piece row ${row.id} (treating as public): ${(err as Error).message}`);
        }
    }
    if (rowScopes.length === 0) return true;
    return rowScopes.some((s) => allowed.has(s));
}

export class SqlitePieceIndex {
    private valid = false;
    private invalidReason: string | undefined;
    private warnedStaleOnce = false;

    constructor(
        private readonly basePath: string,
        private readonly db: DatabaseType,
        private readonly embeddingProvider: EmbeddingProvider,
    ) {}

    get isOpen(): boolean {
        return this.valid;
    }

    /** Mirrors LancePieceIndex.initialize() exactly (same sidecar-validity
     *  gate, same empty-store auto-create rule) — the two engines must
     *  agree on when a piece index is considered usable. */
    async initialize(opts: { intentOn: boolean; canonicalIsEmpty: boolean }): Promise<void> {
        const sidecar = readPieceSidecar(this.basePath);
        const check = isPieceSidecarValid(sidecar, this.embeddingProvider);
        if (check.valid) {
            ensureSchema(this.db);
            this.valid = true;
            return;
        }
        this.invalidReason = check.reason;
        if (opts.intentOn && opts.canonicalIsEmpty) {
            this.createEmpty();
            return;
        }
        if (opts.intentOn) this.warnStaleOnce();
    }

    private warnStaleOnce(): void {
        if (this.warnedStaleOnce) return;
        this.warnedStaleOnce = true;
        log.warn(`[SqlitePieceIndex] piece vectors requested but the index is stale (${this.invalidReason ?? 'unknown reason'}) — serving without piece search until it is rebuilt.`);
    }

    private createEmpty(): void {
        ensureSchema(this.db);
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

    /** Full replace per node (delete-then-insert), same rationale as the
     *  Lance engine: piece count changes between writes as a node's body
     *  grows/shrinks, so a stale piece from a previous version must not
     *  survive a mergeInsert-style partial update. `#rev...` ids are
     *  skipped. No-op when the index isn't open. */
    async upsertForRows(rows: PieceSourceRow[]): Promise<void> {
        if (!this.valid) return;
        const liveIds = rows.map((r) => r.id).filter((id) => !isRevisionHistoryId(id));
        if (liveIds.length === 0) return;
        const toWrite: Array<{
            id: string; nodeId: string; pieceIndex: number; isTitle: number; text: string;
            vector: Buffer; type: string | null; project: string | null; ecosystem: string | null;
            security_scopes: string | null;
        }> = [];
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
                    isTitle: pieces[i].isTitle ? 1 : 0,
                    text: pieces[i].text,
                    vector: encodeVector(vectors[i]!),
                    type: row.type ?? null,
                    project: row.project ?? null,
                    ecosystem: row.ecosystem ?? null,
                    security_scopes: row.security_scopes ? JSON.stringify(row.security_scopes) : null,
                });
            }
        }
        this.deleteForIdsSync(liveIds);
        if (toWrite.length === 0) return;
        const insert = this.db.prepare(
            `INSERT INTO verbatim_pieces (id, nodeId, pieceIndex, isTitle, text, vector, type, project, ecosystem, security_scopes)
             VALUES (@id, @nodeId, @pieceIndex, @isTitle, @text, @vector, @type, @project, @ecosystem, @security_scopes)`,
        );
        const insertMany = this.db.transaction((batch: typeof toWrite) => {
            for (const row of batch) insert.run(row);
        });
        insertMany(toWrite);
    }

    private deleteForIdsSync(ids: string[]): void {
        if (ids.length === 0) return;
        const stmt = this.db.prepare(`DELETE FROM verbatim_pieces WHERE nodeId = ?`);
        const deleteMany = this.db.transaction((batch: string[]) => {
            for (const id of batch) stmt.run(id);
        });
        for (let i = 0; i < ids.length; i += VERBATIM_CHUNK_SIZE) {
            deleteMany(ids.slice(i, i + VERBATIM_CHUNK_SIZE));
        }
    }

    /** Deletes every piece belonging to each id in `ids`. No-op when the
     *  index isn't open. */
    async deleteForIds(ids: string[]): Promise<void> {
        if (!this.valid || ids.length === 0) return;
        this.deleteForIdsSync(ids);
    }

    /** Out-of-scope retrieval routing will call this with a resolved query
     *  (text, embedded here) or a pre-embedded vector; D7a itself only
     *  needs this to exist and be correct in isolation for T1's write-path
     *  proofs. JS brute-force cosine, matching sqliteVerbatimVector.ts's
     *  fallback-path scoring convention exactly (1 = identical direction). */
    async searchPieces(
        queryOrVector: string | number[],
        topK: number,
        filter?: RowFilter,
        actorScopes?: ReadonlyArray<string>,
    ): Promise<PieceSearchHit[]> {
        if (!this.valid) return [];
        const queryVec = typeof queryOrVector === 'string'
            ? Float32Array.from(await this.embeddingProvider.embedQuery(queryOrVector))
            : Float32Array.from(queryOrVector);
        const rows = this.db.prepare(
            `SELECT id, nodeId, text, vector, type, project, ecosystem, security_scopes FROM verbatim_pieces`,
        ).all() as PieceRowRaw[];
        const hits: PieceSearchHit[] = [];
        for (const row of rows) {
            if (filter && filter.length > 0 && !matchesFilter(row, filter)) continue;
            if (!actorCanSeeRow(row, actorScopes)) continue;
            const v = decodeVector(row.vector);
            if (!v) continue;
            hits.push({ nodeId: row.nodeId, score: cosineSimilarity(queryVec, v) });
        }
        hits.sort((a, b) => (b.score - a.score) || a.nodeId.localeCompare(b.nodeId));
        return hits.slice(0, topK);
    }

    async count(): Promise<number> {
        try {
            const row = this.db.prepare(`SELECT count(*) as c FROM verbatim_pieces`).get() as { c: number };
            return row.c;
        } catch (err) {
            log.warn(`[SqlitePieceIndex] count failed (table likely absent): ${(err as Error).message}`);
            return 0;
        }
    }

    async drop(): Promise<void> {
        try {
            dropSchema(this.db);
        } catch (err) {
            log.warn(`[SqlitePieceIndex] drop failed: ${(err as Error).message}`);
        }
        this.valid = false;
    }

    /** D7c (migration only) — mirrors LancePieceIndex.createEmptyForRebuild()
     *  exactly: drop + recreate the table and mark this index valid, WITHOUT
     *  touching the sidecar (the caller owns that lifecycle). See the Lance
     *  method's docblock for why this exists — without it, drop() leaves
     *  `valid=false` and every upsertForRows()/deleteForIds() call below
     *  becomes a silent no-op, which would make a migration rebuild write
     *  zero pieces. */
    async createEmptyForRebuild(): Promise<void> {
        dropSchema(this.db);
        ensureSchema(this.db);
        this.valid = true;
        this.invalidReason = undefined;
    }

    status(): PieceIndexStatus {
        return { open: this.valid, valid: this.valid, reason: this.invalidReason };
    }

    async close(): Promise<void> {
        // No separate handle — the shared `db` connection outlives this
        // index and is closed by SqliteVerbatimStore.close() itself.
        this.valid = false;
    }
}
