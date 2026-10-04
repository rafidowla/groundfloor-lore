/**
 * sqliteVerbatimImport.ts — raw, verbatim row import into a FRESH
 * `.lore/verbatim.sqlite` (3.27.1, `lore migrate-vectors <ws> --to sqlite`).
 *
 * Internal, like `SqliteGraph.importRaw`: not part of `VerbatimStoreApi`.
 * Reached only through `SqliteVerbatimStore.openRawImport()` by the offline
 * Lance -> SQLite migration (engines/migrateVectorsToSqlite.ts).
 *
 * Why a separate path instead of `bulkAddPrebuiltRows`/`upsertCanonical`:
 *   - Those write paths stamp `created_at`/`updated_at` with "now", snapshot
 *     history themselves and treat a repeated id as a supersede. A migration
 *     must carry history rows (`is_canonical = 0`, `superseded_at`) and the
 *     timestamps exactly as the source has them — no restamp, no
 *     re-redaction, no second history snapshot.
 *   - It deliberately does NOT go through `SqliteVerbatimStore.initialize()`.
 *     initialize() runs `applyFingerprintOnOpen` and, on table birth,
 *     `stampFingerprint` — which REWRITES `.lore/lancedb/embedding_model.json`
 *     (the fingerprint file is shared metadata that lives in the Lance folder
 *     and is read by both engines). The migration carries the existing
 *     fingerprint over untouched instead; the schema open below creates the
 *     table + FTS triggers only.
 *
 * FTS: `verbatim_fts` is populated by the AFTER INSERT trigger
 * `openSqliteVerbatimDb` installs, so every imported row is searchable
 * without a separate rebuild.
 *
 * Pieces: rows are copied byte-for-byte into `verbatim_pieces` (same DDL as
 * SqlitePieceIndex via `ensurePieceSchema`). The piece sidecar
 * (`piece_layout.json`) is engine-neutral, so a copied index stays valid
 * without re-embedding — `buildPieceIndex` would call the embedder, which
 * the migration must never do.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { openSqliteVerbatimDb } from './sqliteVerbatimSchema.js';
import { encodeVector } from './sqliteVerbatimVector.js';
import { ensurePieceSchema } from './pieces/sqlitePieceIndex.js';

/** One `verbatim` row in the SQLite engine's own column shape. `vector`
 *  null = unembedded (the shape the engine itself writes for a row it has no
 *  embedding for). */
export interface RawVerbatimImportRow {
    id: string;
    text: string;
    vector: Float32Array | null;
    content_hash: string | null;
    type: string | null;
    label: string | null;
    tags: string | null;
    project: string | null;
    ecosystem: string | null;
    updatedAt: string | null;
    /** JSON text, or null for "no scopes" (the engine never stores '[]'). */
    security_scopes: string | null;
    is_canonical: 0 | 1;
    is_tombstone: 0 | 1;
    superseded_at: string | null;
    created_at: string;
    updated_at: string;
}

/** One `verbatim_pieces` row in SqlitePieceIndex's column shape. */
export interface RawPieceImportRow {
    id: string;
    nodeId: string;
    pieceIndex: number;
    isTitle: 0 | 1;
    text: string;
    vector: Float32Array | null;
    type: string | null;
    project: string | null;
    ecosystem: string | null;
    security_scopes: string | null;
}

export interface VerbatimRawImport {
    readonly dbPath: string;
    /** True when `verbatim.sqlite` already existed when opened (callers
     *  move a non-empty target aside first, so this is normally false). */
    readonly tableExisted: boolean;
    importRows(rows: readonly RawVerbatimImportRow[]): void;
    importPieces(rows: readonly RawPieceImportRow[]): void;
    /** Read handle for post-import verification (same connection). */
    readonly db: DatabaseType;
    close(): void;
}

const INSERT_ROW = `INSERT INTO verbatim (id, text, vector, content_hash, type, label, tags, project, ecosystem,
        updatedAt, security_scopes, is_canonical, is_tombstone, superseded_at, created_at, updated_at)
    VALUES (@id, @text, @vector, @content_hash, @type, @label, @tags, @project, @ecosystem,
        @updatedAt, @security_scopes, @is_canonical, @is_tombstone, @superseded_at, @created_at, @updated_at)`;

const INSERT_PIECE = `INSERT INTO verbatim_pieces (id, nodeId, pieceIndex, isTitle, text, vector, type, project, ecosystem, security_scopes)
    VALUES (@id, @nodeId, @pieceIndex, @isTitle, @text, @vector, @type, @project, @ecosystem, @security_scopes)`;

/** Open (creating) the SQLite verbatim schema at `basePath` for a raw import.
 *  Each `importRows`/`importPieces` call is one transaction — callers batch. */
export async function openVerbatimRawImport(basePath: string): Promise<VerbatimRawImport> {
    const { db, dbPath, tableExisted } = await openSqliteVerbatimDb(basePath);
    ensurePieceSchema(db);
    const insRow = db.prepare(INSERT_ROW);
    const insPiece = db.prepare(INSERT_PIECE);
    const rowTx = db.transaction((rows: readonly RawVerbatimImportRow[]) => {
        for (const r of rows) insRow.run({ ...r, vector: r.vector ? encodeVector(r.vector) : null });
    });
    const pieceTx = db.transaction((rows: readonly RawPieceImportRow[]) => {
        for (const r of rows) insPiece.run({ ...r, vector: r.vector ? encodeVector(r.vector) : null });
    });
    return {
        dbPath,
        tableExisted,
        db,
        importRows: (rows) => { if (rows.length > 0) rowTx(rows); },
        importPieces: (rows) => { if (rows.length > 0) pieceTx(rows); },
        close: () => { if (db.open) db.close(); },
    };
}
