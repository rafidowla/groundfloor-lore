/**
 * migrateVectorsToSqlite.ts — `lore migrate-vectors <workspace> --to sqlite`
 * (3.27.1): move one workspace's verbatim (vector) store LanceDB -> SQLite.
 *
 * Why: Atlas roots are small (hundreds to a few thousand vectors); its
 * parity eval found identical recall results/order on SQLite vs Lance and
 * SQLite ~3x faster at that size, but there was no way to move an EXISTING
 * workspace. The 3.21 design deliberately shipped no demotion (see
 * cli/commands/vectors.ts); this adds it as a MANUAL, offline operator
 * command. Automatic SQLite -> Lance promotion (verbatimPromotion.ts) is
 * unchanged — this is its mirror, and it reuses that module's row shape
 * (verbatimPromotionStage's `lanceRowId`) for verification.
 *
 * Same safety model and order as migrateGraphToSqlite.ts, each step a
 * precondition for the next:
 *
 *   1. Daemon preflight (`isDaemonServingHome`).
 *   2. Preconditions: registry says 'lance' AND a Lance `lore_verbatim`
 *      table exists AND the embedding fingerprint exists; no duplicate
 *      canonical ids (SQLite's unique index would reject them); canonical
 *      row count < the promotion threshold (else the first write would
 *      promote it straight back); the target `verbatim.sqlite` is absent or
 *      empty, or `--force` (moved aside to a timestamped name, never
 *      deleted). `--dry-run` stops here with counts, having written nothing.
 *   3. `backupWorkspace` BEFORE touching anything.
 *   4. Stream EVERY Lance row (canonical, `#rev` history, `#q` aliases,
 *      tombstones; every column + the STORED vector) — never the embedder.
 *   5. Write through `SqliteVerbatimStore.openRawImport` (ids, timestamps,
 *      history verbatim; FTS by trigger; the fingerprint file is shared
 *      metadata and stays exactly as it is). Lance piece rows are copied
 *      into `verbatim_pieces` (sidecar is engine-neutral, stays valid).
 *   6. Verify: counts by kind, per-row + whole-set digest (ids, text,
 *      metadata, hashes, timestamps-in-id, float32 vector bytes), pieces
 *      digest, live probes on both engines (migrateVectorsProbes.ts).
 *   7. ONLY THEN one atomic `setWorkspaceVectorEngine(ws, 'sqlite')`.
 *
 * Any failure before 7 removes the partial `verbatim.sqlite` (+ -wal/-shm)
 * and leaves the registry at 'lance'; a `--force` move-aside copy and the
 * Lance tables are never touched. Lance files stay after success too — the
 * report names the two table folders to delete once satisfied. NOT the whole
 * `.lore/lancedb/` folder: it also holds `embedding_model.json` and
 * `piece_layout.json`, which the SQLite engine still reads.
 *
 * No `--to lance`: `promoteWorkspace` stages + swaps but does not flip the
 * registry (the auto-trigger does), so it is not a thin wrapper; the
 * existing `lore vectors promote` already covers that direction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import Database from 'better-sqlite3';
import { getWorkspacePath, setWorkspaceVectorEngine } from '../config/workspaces.js';
import { loreHome } from '../config/loreHome.js';
import { resolveWorkspaceVectorEngine } from './vectorEngineSelector.js';
import { isDaemonServingHome, daemonRefuseMessage } from '../cli/commands/migrateWorkspaceToWorkspaceShared.js';
import { backupWorkspace, type BackupResult } from './backup.js';
import { SqliteVerbatimStore } from './sqliteVerbatimStore.js';
import { readFingerprint } from './embeddingFingerprint.js';
import { promoteRowsThreshold } from './verbatimPromotion.js';
import type { SourceRow } from './verbatimPromotionStage.js';
import type { RawPieceImportRow, RawVerbatimImportRow, VerbatimRawImport } from './sqliteVerbatimImport.js';
import {
    classifyLanceId, classifySqliteRow, digestOfHashes, emptyKindCounts, hashSqlitePiece, hashSqliteRow,
    isPlaceholderVector, mapLancePiece, mapLanceRow, toFloat32, type KindCounts, type SqlitePieceRow,
} from './migrateVectorsRows.js';
import { nonEmbeddingProvider, runLiveProbes, type ProbeSample } from './migrateVectorsProbes.js';

export interface MigrateVectorsToSqliteOptions {
    workspaceName: string;
    home?: string;
    /** Directory the pre-migration backup tarball is written into. Must exist. */
    backupOutDir: string;
    /** Move a non-empty target `verbatim.sqlite` aside instead of refusing. */
    force?: boolean;
    /** Steps 1-2 plus counts only; writes nothing (no backup either). */
    dryRun?: boolean;
    /** Bypass the daemon preflight (tests only — migrate-graph's `force`). */
    skipDaemonCheck?: boolean;
    /** Rows per import transaction (default 1000). */
    batchSize?: number;
    /** TEST-ONLY failure injection: throw after the first import batch, or
     *  inside verification, to prove the rollback leaves no partial file. */
    simulateFailure?: 'import' | 'verify';
    /** TEST-ONLY: counts every embedder call the migration makes (must stay 0). */
    onEmbedCall?: () => void;
}

export interface MigrateVectorsToSqliteReport {
    workspaceName: string;
    workspaceDir: string;
    dryRun: boolean;
    counts: KindCounts;
    tombstones: number;
    /** Rows whose Lance vector was an all-zero placeholder -> NULL in SQLite. */
    unembedded: number;
    pieces: number;
    embeddingModel: { modelId: string; dimension: number };
    promoteThreshold: number;
    backup?: BackupResult;
    /** Where a pre-existing target was moved (`--force`). */
    movedAside: string[];
    sqlitePath: string;
    digest?: string;
    vectorsCompared: number;
    probeDetails: string[];
    /** Lance table folders left in place (safe to delete once satisfied). */
    lanceTablePaths: string[];
    durationMs: number;
}

export class MigrateVectorsVerificationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MigrateVectorsVerificationError';
    }
}

const VERBATIM_TABLE = 'lore_verbatim';
const PIECE_TABLE = 'lore_verbatim_pieces';
const SELECT_SQLITE = `rowid, id, text, vector, content_hash, type, label, tags, project, ecosystem, updatedAt,
    security_scopes, is_canonical, is_tombstone, superseded_at, created_at`;
const SQLITE_SUFFIXES = ['', '-wal', '-shm'];

/** Rows in an existing target, or -1 when it cannot be read (treated as non-empty). */
function existingTargetRows(sqlitePath: string): number {
    if (!fs.existsSync(sqlitePath)) return 0;
    try {
        const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
        try {
            const t = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='verbatim'`).get();
            return t ? (db.prepare('SELECT count(*) AS c FROM verbatim').get() as { c: number }).c : 0;
        } finally { db.close(); }
    } catch {
        return -1;
    }
}

function removeSqliteFiles(sqlitePath: string): void {
    for (const s of SQLITE_SUFFIXES) fs.rmSync(sqlitePath + s, { force: true });
}

async function* lanceRows(table: lancedb.Table, columns?: string[]): AsyncGenerator<Record<string, unknown>> {
    const q = columns ? table.query().select(columns) : table.query();
    for await (const batch of q) {
        for (const r of batch.toArray()) yield r as Record<string, unknown>;
    }
}

export async function migrateVectorsToSqlite(opts: MigrateVectorsToSqliteOptions): Promise<MigrateVectorsToSqliteReport> {
    const startedAt = Date.now();
    const home = opts.home ?? loreHome();
    const ws = opts.workspaceName;
    const workspaceDir = getWorkspacePath(ws, home);
    const lancedbPath = path.join(workspaceDir, '.lore', 'lancedb');
    const sqlitePath = path.join(workspaceDir, '.lore', 'verbatim.sqlite');

    if (resolveWorkspaceVectorEngine(ws, home) === 'sqlite') {
        throw new Error(`migrate-vectors: workspace '${ws}' is already registered as 'sqlite'. Nothing to migrate.`);
    }

    // ── 1. Daemon preflight ─────────────────────────────────────────────
    if (!opts.skipDaemonCheck) {
        const probe = await isDaemonServingHome(home);
        if (probe.servesHome) throw new Error(daemonRefuseMessage('lore migrate-vectors'));
    }

    // ── 2. Preconditions (read-only) ────────────────────────────────────
    if (!fs.existsSync(path.join(lancedbPath, `${VERBATIM_TABLE}.lance`))) {
        throw new Error(`migrate-vectors: workspace '${ws}' has no LanceDB verbatim store at ${lancedbPath} — nothing to migrate.`);
    }
    const fp = readFingerprint(workspaceDir);
    if (!fp) {
        throw new Error(`migrate-vectors: no embedding fingerprint at ${path.join(lancedbPath, 'embedding_model.json')}. `
            + 'Open the workspace once (any lore command) so it is stamped, then retry.');
    }
    const conn = await lancedb.connect(lancedbPath);
    let table: lancedb.Table | null = null;
    let pieceTable: lancedb.Table | null = null;
    try {
        const names = await conn.tableNames();
        table = await conn.openTable(VERBATIM_TABLE);
        pieceTable = names.includes(PIECE_TABLE) ? await conn.openTable(PIECE_TABLE) : null;
        const indices = (await table.listIndices?.()) ?? [];
        const lanceHasVectorIndex = indices.some((i) => (i as { columns?: string[] }).columns?.includes('vector'));

        // Pass 1 — ids/text/vector only: counts, tombstones, duplicates.
        const counts = emptyKindCounts();
        let tombstones = 0;
        let unembedded = 0;
        const canonicalIds = new Set<string>();
        for await (const r of lanceRows(table, ['id', 'text', 'vector'])) {
            const id = String(r.id);
            const kind = classifyLanceId(id);
            counts[kind]++;
            if (String(r.text ?? '').startsWith('[TOMBSTONED')) tombstones++;
            if (isPlaceholderVector(toFloat32(r.vector))) unembedded++;
            if (kind !== 'history') {
                if (canonicalIds.has(id)) {
                    throw new Error(`migrate-vectors: duplicate canonical id '${id}' in the Lance table — SQLite's unique index would reject it. Nothing written.`);
                }
                canonicalIds.add(id);
            }
        }
        const pieces = pieceTable ? await pieceTable.countRows() : 0;
        const threshold = promoteRowsThreshold();
        const canonicalTotal = counts.canonical + counts.alias;
        if (threshold > 0 && canonicalTotal >= threshold) {
            throw new Error(`migrate-vectors: '${ws}' has ${canonicalTotal} canonical rows, at or above the SQLite -> Lance promotion threshold `
                + `(${threshold}, LORE_VECTOR_PROMOTE_ROWS). Its first write would promote it straight back to Lance. Not migrating.`);
        }
        const targetRows = existingTargetRows(sqlitePath);
        if (targetRows !== 0 && !opts.force) {
            throw new Error(`migrate-vectors: target ${sqlitePath} already exists and is ${targetRows < 0 ? 'unreadable' : `non-empty (${targetRows} rows)`}. `
                + 'Re-run with --force to move it aside to a timestamped backup (it is never deleted).');
        }
        const lanceTablePaths = [path.join(lancedbPath, `${VERBATIM_TABLE}.lance`)];
        if (pieceTable) lanceTablePaths.push(path.join(lancedbPath, `${PIECE_TABLE}.lance`));
        const report: MigrateVectorsToSqliteReport = {
            workspaceName: ws, workspaceDir, dryRun: !!opts.dryRun, counts, tombstones, unembedded, pieces,
            embeddingModel: { modelId: fp.modelId, dimension: fp.dimension }, promoteThreshold: threshold,
            movedAside: [], sqlitePath, vectorsCompared: 0, probeDetails: [], lanceTablePaths, durationMs: 0,
        };
        if (opts.dryRun) {
            report.durationMs = Date.now() - startedAt;
            return report;
        }

        // ── 3. Backup FIRST ─────────────────────────────────────────────
        report.backup = await backupWorkspace({ workspaceDir, workspaceName: ws, outDir: opts.backupOutDir });

        // Move any existing target aside (after the backup, so the backup
        // also holds it). Empty-but-present files move too: the import needs
        // a fresh file, and moving is never lossy.
        if (fs.existsSync(sqlitePath)) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            for (const s of SQLITE_SUFFIXES) {
                if (!fs.existsSync(sqlitePath + s)) continue;
                const dest = `${sqlitePath}.pre-migrate-${stamp}${s}`;
                fs.renameSync(sqlitePath + s, dest);
                report.movedAside.push(dest);
            }
        }

        const fail = (err: unknown): never => {
            removeSqliteFiles(sqlitePath);
            const msg = err instanceof Error ? err.message : String(err);
            const aside = report.movedAside.length ? ` Previous target kept at ${report.movedAside[0]}.` : '';
            const wrapped = new (err instanceof MigrateVectorsVerificationError ? MigrateVectorsVerificationError : Error)(
                `${msg} — vectorEngine UNCHANGED ('lance'); partial ${sqlitePath} removed; Lance store untouched; `
                + `backup at ${report.backup!.tarballPath}.${aside}`);
            throw wrapped;
        };

        // ── 4+5. Stream every Lance row into the raw import ─────────────
        let imp: VerbatimRawImport | null = null;
        const samples: ProbeSample[] = [];
        const excluded = new Set<string>();
        try {
            imp = await SqliteVerbatimStore.openRawImport(workspaceDir);
            const migratedAt = new Date().toISOString();
            const lanceHashes: string[] = [];
            const batchSize = opts.batchSize ?? 1000;
            let batch: RawVerbatimImportRow[] = [];
            const candidates: ProbeSample[] = [];
            for await (const raw of lanceRows(table)) {
                const m = mapLanceRow(raw, migratedAt);
                lanceHashes.push(m.hash);
                if (m.kind !== 'history' && (m.unembedded || m.row.is_tombstone)) excluded.add(m.row.id);
                else if (m.kind === 'canonical' && m.row.vector) {
                    candidates.push({ id: m.row.id, text: m.row.text, vector: Array.from(m.row.vector) });
                }
                batch.push(m.row);
                if (batch.length >= batchSize) {
                    imp.importRows(batch);
                    batch = [];
                    if (opts.simulateFailure === 'import') throw new Error('simulated import failure (test)');
                }
            }
            imp.importRows(batch);
            if (opts.simulateFailure === 'import') throw new Error('simulated import failure (test)');
            for (const i of [0, Math.floor(candidates.length / 2), candidates.length - 1]) {
                const c = candidates[i];
                if (c && !samples.some((s) => s.id === c.id)) samples.push(c);
            }
            const pieceHashes: string[] = [];
            if (pieceTable) {
                let pb: RawPieceImportRow[] = [];
                for await (const raw of lanceRows(pieceTable)) {
                    const p = mapLancePiece(raw);
                    pieceHashes.push(p.hash);
                    pb.push(p.row);
                    if (pb.length >= batchSize) { imp.importPieces(pb); pb = []; }
                }
                imp.importPieces(pb);
            }

            // ── 6. Verify ───────────────────────────────────────────────
            const got = emptyKindCounts();
            const lanceHashSet = new Set(lanceHashes);
            const sqliteHashes: string[] = [];
            for (const r of imp.db.prepare(`SELECT ${SELECT_SQLITE} FROM verbatim ORDER BY rowid`).iterate() as Iterable<SourceRow>) {
                got[classifySqliteRow(r.id, r.is_canonical)]++;
                const h = hashSqliteRow(r);
                sqliteHashes.push(h);
                if (r.vector) report.vectorsCompared++;
                if (opts.simulateFailure === 'verify') throw new MigrateVectorsVerificationError('simulated verify failure (test)');
                if (!lanceHashSet.has(h)) {
                    throw new MigrateVectorsVerificationError(`row ${r.id} (is_canonical=${r.is_canonical}) does not match any Lance row`);
                }
            }
            if (JSON.stringify(got) !== JSON.stringify(counts)) {
                throw new MigrateVectorsVerificationError(`row counts differ: lance ${JSON.stringify(counts)} vs sqlite ${JSON.stringify(got)}`);
            }
            const lanceDigest = digestOfHashes(lanceHashes);
            const sqliteDigest = digestOfHashes(sqliteHashes);
            if (lanceDigest !== sqliteDigest) {
                throw new MigrateVectorsVerificationError(`row digest differs: lance ${lanceDigest} vs sqlite ${sqliteDigest}`);
            }
            report.digest = sqliteDigest;
            if (pieceTable) {
                const sp = (imp.db.prepare('SELECT id, nodeId, pieceIndex, isTitle, text, vector, type, project, ecosystem, security_scopes FROM verbatim_pieces')
                    .all() as SqlitePieceRow[]).map(hashSqlitePiece);
                if (digestOfHashes(sp) !== digestOfHashes(pieceHashes)) {
                    throw new MigrateVectorsVerificationError(`piece rows differ: lance ${pieceHashes.length} vs sqlite ${sp.length}`);
                }
            }
            imp.close();
            imp = null;
            const probes = await runLiveProbes({
                workspaceDir,
                provider: nonEmbeddingProvider(fp, opts.onEmbedCall),
                samples,
                excluded,
                lanceHasVectorIndex,
            });
            report.probeDetails = probes.details;
            if (!probes.matched) {
                throw new MigrateVectorsVerificationError(`live probes differ: ${probes.details.filter((d) => d.startsWith('MISMATCH')).join('; ')}`);
            }
        } catch (err) {
            imp?.close();
            fail(err);
        }

        // ── 7. Atomic flip ──────────────────────────────────────────────
        setWorkspaceVectorEngine(ws, 'sqlite', home);
        report.durationMs = Date.now() - startedAt;
        return report;
    } finally {
        try { pieceTable?.close(); } catch { /* best-effort */ }
        try { table?.close(); } catch { /* best-effort */ }
        try { conn.close(); } catch { /* best-effort */ }
    }
}
