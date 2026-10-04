/**
 * migrateVectorsRows.ts — row mapping + per-row hashing for
 * `lore migrate-vectors <ws> --to sqlite` (3.27.1).
 *
 * The reverse of verbatimPromotionStage.ts's `toLanceRow`/`lanceRowId`:
 *
 *   Lance row                         SQLite row
 *   ─────────────────────────────     ──────────────────────────────────────
 *   id `<canon>#rev<ISO ms>`      ->  id `<canon>`, is_canonical 0,
 *                                     superseded_at = created_at = updated_at
 *                                     = the `#rev` timestamp (the supersede
 *                                     instant Lance encoded in the id)
 *   any other id (incl. `#q<i>`)  ->  same id, is_canonical 1, superseded_at
 *                                     NULL, created_at = updated_at = the
 *                                     row's `updatedAt` when it parses as a
 *                                     date, else the migration start (Lance
 *                                     has no internal timestamp columns)
 *   text `[TOMBSTONED ...`        ->  is_tombstone 1 (same test Lance's own
 *                                     getHistory/FTS reconcile apply)
 *   all-zero / absent vector      ->  NULL vector (what the SQLite engine
 *                                     writes for an unembedded row)
 *   security_scopes [] / null     ->  NULL; otherwise JSON text
 *   string columns                ->  copied exactly ('' stays '', null
 *                                     stays null — no normalization)
 *
 * Verification hashes BOTH sides into the same engine-neutral shape (the
 * Lance view: Lance id, Lance-null semantics, vector as hex of its float32
 * bytes or null). For a SQLite row the Lance id is rebuilt with
 * verbatimPromotionStage's `lanceRowId`, so one per-row digest proves the
 * id/history mapping, every column, and bit-equal vectors at once.
 */

import { createHash } from 'node:crypto';
import { isRevisionHistoryId } from './verbatimHistory.js';
import { lanceRowId, type SourceRow } from './verbatimPromotionStage.js';
import { decodeVector } from './sqliteVerbatimVector.js';
import type { RawPieceImportRow, RawVerbatimImportRow } from './sqliteVerbatimImport.js';

/** Same suffix verbatimHistory.ts's HISTORY_SUFFIX_RE matches (kept local —
 *  that constant is private); `isRevisionHistoryId` gates every use. */
const REV_SUFFIX_RE = /#rev(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;
const ALIAS_SUFFIX_RE = /#q\d+$/;
const TOMBSTONE_PREFIX = '[TOMBSTONED';

export type RowKind = 'canonical' | 'history' | 'alias';

export interface KindCounts { canonical: number; history: number; alias: number }

export function emptyKindCounts(): KindCounts {
    return { canonical: 0, history: 0, alias: 0 };
}

/** Kind of a LANCE id (history = `#rev` suffix wins over a `#q` base). */
export function classifyLanceId(id: string): RowKind {
    if (isRevisionHistoryId(id)) return 'history';
    if (ALIAS_SUFFIX_RE.test(id)) return 'alias';
    return 'canonical';
}

/** Kind of a SQLite row (history = is_canonical 0). */
export function classifySqliteRow(id: string, isCanonical: number): RowKind {
    if (!isCanonical) return 'history';
    return ALIAS_SUFFIX_RE.test(id) ? 'alias' : 'canonical';
}

function str(v: unknown): string | null {
    return v === null || v === undefined ? null : String(v);
}

/** Arrow FixedSizeList element / plain array / typed array -> Float32Array
 *  (a float32 -> float32 copy, so bit-exact). Null when absent. */
export function toFloat32(v: unknown): Float32Array | null {
    if (v === null || v === undefined) return null;
    if (v instanceof Float32Array) return Float32Array.from(v);
    const arrowLike = v as { toArray?: () => unknown };
    const inner = typeof arrowLike.toArray === 'function' ? arrowLike.toArray() : v;
    if (inner instanceof Float32Array) return Float32Array.from(inner);
    if (ArrayBuffer.isView(inner) || Array.isArray(inner)) {
        return Float32Array.from(inner as ArrayLike<number>, (x) => Number(x));
    }
    return null;
}

/** Placeholder = Lance's all-zero "not embedded yet" vector (or none). */
export function isPlaceholderVector(v: Float32Array | null): boolean {
    if (!v || v.length === 0) return true;
    for (let i = 0; i < v.length; i++) if (v[i] !== 0) return false;
    return true;
}

function toScopes(v: unknown): string[] {
    if (v === null || v === undefined) return [];
    const arrowLike = v as { toArray?: () => unknown };
    const inner = typeof arrowLike.toArray === 'function' ? arrowLike.toArray() : v;
    return Array.isArray(inner) ? inner.map((x) => String(x)) : [];
}

function vectorHex(v: Float32Array | null): string | null {
    if (isPlaceholderVector(v)) return null;
    return Buffer.from(v!.buffer, v!.byteOffset, v!.byteLength).toString('hex');
}

function sha(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isoOrNull(v: string | null): string | null {
    if (!v) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export interface MappedRow { row: RawVerbatimImportRow; kind: RowKind; unembedded: boolean; hash: string }

/** One raw Lance `lore_verbatim` row -> SQLite import row + its digest. */
export function mapLanceRow(raw: Record<string, unknown>, migratedAtIso: string): MappedRow {
    const lanceId = String(raw.id);
    const kind = classifyLanceId(lanceId);
    const vec = toFloat32(raw.vector);
    const unembedded = isPlaceholderVector(vec);
    const scopes = toScopes(raw.security_scopes);
    const text = String(raw.text ?? '');
    const updatedAt = str(raw.updatedAt);
    let id = lanceId;
    let supersededAt: string | null = null;
    let createdAt: string;
    if (kind === 'history') {
        const m = REV_SUFFIX_RE.exec(lanceId)!;
        id = lanceId.slice(0, m.index);
        supersededAt = m[1]!;
        createdAt = supersededAt;
    } else {
        createdAt = isoOrNull(updatedAt) ?? migratedAtIso;
    }
    const row: RawVerbatimImportRow = {
        id,
        text,
        vector: unembedded ? null : vec,
        content_hash: str(raw.contentHash),
        type: str(raw.type),
        label: str(raw.label),
        tags: str(raw.tags),
        project: str(raw.project),
        ecosystem: str(raw.ecosystem),
        updatedAt,
        security_scopes: scopes.length > 0 ? JSON.stringify(scopes) : null,
        is_canonical: kind === 'history' ? 0 : 1,
        is_tombstone: text.startsWith(TOMBSTONE_PREFIX) ? 1 : 0,
        superseded_at: supersededAt,
        created_at: createdAt,
        updated_at: createdAt,
    };
    return { row, kind, unembedded, hash: hashLanceView(lanceId, raw, vec, scopes) };
}

function hashLanceView(lanceId: string, raw: Record<string, unknown>, vec: Float32Array | null, scopes: string[]): string {
    return sha([lanceId, String(raw.text ?? ''), str(raw.type), str(raw.label), str(raw.tags), str(raw.project),
        str(raw.ecosystem), str(raw.updatedAt), str(raw.contentHash), scopes, vectorHex(vec)]);
}

/** Hash of a row read back from SQLite, in the same Lance view. */
export function hashSqliteRow(r: SourceRow): string {
    let scopes: string[] = [];
    if (r.security_scopes) {
        try { scopes = (JSON.parse(r.security_scopes) as unknown[]).map((x) => String(x)); } catch { scopes = ['<unparseable>']; }
    }
    return sha([lanceRowId(r), r.text, r.type, r.label, r.tags, r.project, r.ecosystem, r.updatedAt,
        r.content_hash, scopes, vectorHex(decodeVector(r.vector))]);
}

/** One raw Lance `lore_verbatim_pieces` row -> SQLite piece row + digest. */
export function mapLancePiece(raw: Record<string, unknown>): { row: RawPieceImportRow; hash: string } {
    const vec = toFloat32(raw.vector);
    const scopes = toScopes(raw.security_scopes);
    const row: RawPieceImportRow = {
        id: String(raw.id),
        nodeId: String(raw.nodeId),
        pieceIndex: Number(raw.pieceIndex),
        isTitle: raw.isTitle ? 1 : 0,
        text: String(raw.text ?? ''),
        vector: vec && vec.length > 0 ? vec : null,
        type: str(raw.type),
        project: str(raw.project),
        ecosystem: str(raw.ecosystem),
        // SqlitePieceIndex.upsertForRows always writes JSON (even '[]').
        security_scopes: JSON.stringify(scopes),
    };
    return { row, hash: hashPiece(row.id, row.nodeId, row.pieceIndex, row.isTitle, row.text, row.vector, row.type, row.project, row.ecosystem, scopes) };
}

export interface SqlitePieceRow {
    id: string; nodeId: string; pieceIndex: number; isTitle: number; text: string; vector: Buffer | null;
    type: string | null; project: string | null; ecosystem: string | null; security_scopes: string | null;
}

export function hashSqlitePiece(r: SqlitePieceRow): string {
    let scopes: string[] = [];
    try { scopes = r.security_scopes ? (JSON.parse(r.security_scopes) as unknown[]).map(String) : []; } catch { scopes = ['<unparseable>']; }
    return hashPiece(r.id, r.nodeId, r.pieceIndex, r.isTitle ? 1 : 0, r.text, decodeVector(r.vector), r.type, r.project, r.ecosystem, scopes);
}

function hashPiece(id: string, nodeId: string, pieceIndex: number, isTitle: number, text: string, vec: Float32Array | null,
    type: string | null, project: string | null, ecosystem: string | null, scopes: string[]): string {
    const hex = vec ? Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('hex') : null;
    return sha([id, nodeId, pieceIndex, isTitle, text, hex, type, project, ecosystem, scopes]);
}

/** Order-independent digest of a set of per-row hashes. */
export function digestOfHashes(hashes: string[]): string {
    return createHash('sha256').update([...hashes].sort().join('\n')).digest('hex');
}
