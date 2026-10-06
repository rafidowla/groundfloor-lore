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
 * Lance data are never modified (opening the Lance store for the live probes
 * can rebuild its keyword index, which is derived data). Lance files stay after success too — the
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
import { loadWorkspacesIfPresent, setWorkspaceVectorEngine } from '../config/workspaces.js';
import { loreHome } from '../config/loreHome.js';
import { createEmbeddingProvider } from '../mcp/embeddingProviderFactory.js';
import { isEmbeddingDisabled } from '../providers/nullEmbeddingProvider.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { providerDtype, lanceVectorDimension } from './verbatimFingerprintGate.js';
import { isDaemonServingHome, daemonRefuseMessage } from '../cli/commands/migrateWorkspaceToWorkspaceShared.js';
import { backupWorkspace, type BackupResult } from './backup.js';
import { SqliteVerbatimStore } from './sqliteVerbatimStore.js';
import { readFingerprint, writeFingerprint, type EmbeddingFingerprint } from './embeddingFingerprint.js';
import { readTokenizerFingerprint } from './ftsTokenizerProfile.js';
import { promoteRowsThreshold } from './verbatimPromotion.js';
import type { SourceRow } from './verbatimPromotionStage.js';
import type { RawPieceImportRow, RawVerbatimImportRow, VerbatimRawImport } from './sqliteVerbatimImport.js';
import {
    classifyLanceId, classifySqliteRow, digestOfHashes, emptyKindCounts, hashSqlitePiece, hashSqliteRow,
    isPlaceholderVector, mapLancePiece, mapLanceRow, toFloat32, type KindCounts, type SqlitePieceRow,
} from './migrateVectorsRows.js';
import { nonEmbeddingProvider, runLiveProbes, type ProbeSample } from './migrateVectorsProbes.js';
import { CanonicalTracker, IDENTITY_COLUMNS, rowIdentityKey, duplicateRefusal, type DedupedId } from './migrateVectorsDedupe.js';

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
    /** When a canonical id repeats in the Lance table and ALL copies carry the
     *  same content (content hash; text digest when a copy has no hash), keep
     *  one — the newest `updatedAt`, first-seen on a tie — and leave the rest
     *  out of the SQLite import. Lance is never modified. Copies that differ
     *  still refuse. Reported in `dedupedIds` / `dedupedRowsDropped`. */
    dedupeIdentical?: boolean;
    /** The Lance table exists but nothing ever stamped `embedding_model.json`:
     *  derive the fingerprint from the configured embedding provider, ONLY when
     *  its dimension equals the table's vector dimension (else refuse). Written
     *  after the backup, removed again if the migration fails; never written on
     *  `dryRun`. Reported as `stampedFromConfig`. */
    stampFromConfig?: boolean;
    /** The configured embedding provider (identity only — it is never asked to
     *  embed). Default: `createEmbeddingProvider()`, i.e. the env/local default
     *  every Lore host would pick. Used by the empty-source path and
     *  `stampFromConfig`. */
    embeddingProvider?: EmbeddingProvider;
    /** TEST-ONLY failure injection: throw after the first import batch, or
     *  inside verification, to prove the rollback leaves no partial file. */
    simulateFailure?: 'import' | 'verify';
    /** TEST-ONLY: runs after the import + digest verification, right before
     *  the live probes (the target's db file is closed) — lets a test corrupt
     *  the SQLite copy in a way the digest cannot see (e.g. its FTS index). */
    beforeProbes?: (sqlitePath: string) => void | Promise<void>;
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
    /** Non-fatal notices for the operator (e.g. non-English Lance FTS language). */
    warnings: string[];
    /** Lance table folders left in place (safe to delete once satisfied). */
    lanceTablePaths: string[];
    /** `dedupeIdentical`: ids that had identical repeated copies in Lance; `copies` counts the
     *  Lance rows, `kept.updatedAt` is the surviving copy's value. Empty when none (or the
     *  option is off — then a repeat refuses instead). On a dry run: what WOULD be deduped. */
    dedupedIds: DedupedId[];
    /** Lance rows left out of the SQLite import because of `dedupedIds` (sum of copies - 1).
     *  `counts`, `tombstones` and `unembedded` describe the SQLite side, i.e. after this. */
    dedupedRowsDropped: number;
    /** True when the workspace had no Lance verbatim table: an empty SQLite store was created
     *  and stamped from the configured embedding provider, and the registry flipped. */
    emptySource?: boolean;
    /** True when the fingerprint was derived from the configured provider (`stampFromConfig`). */
    stampedFromConfig?: boolean;
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

/** The configured provider's identity with every embed call refused — enough to stamp/open, never to embed. */
function identityOnly(p: EmbeddingProvider, onCall?: () => void): EmbeddingProvider {
    return nonEmbeddingProvider({
        modelId: p.modelId, dimension: p.dimension, writtenAt: '', version: 1, ...(providerDtype(p) ? { dtype: providerDtype(p)! } : {}),
    }, onCall);
}

/** Move a pre-existing target aside (after the backup, so the backup holds it too). */
function moveTargetAside(sqlitePath: string, movedAside: string[]): void {
    if (!fs.existsSync(sqlitePath)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const s of SQLITE_SUFFIXES) {
        if (!fs.existsSync(sqlitePath + s)) continue;
        const dest = `${sqlitePath}.pre-migrate-${stamp}${s}`;
        fs.renameSync(sqlitePath + s, dest);
        movedAside.push(dest);
    }
}

function targetRefusal(sqlitePath: string, targetRows: number): Error {
    return new Error(`migrate-vectors: target ${sqlitePath} already exists and is ${targetRows < 0 ? 'unreadable' : `non-empty (${targetRows} rows)`}. `
        + 'Re-run with --force to move it aside to a timestamped backup (it is never deleted).');
}

export async function migrateVectorsToSqlite(opts: MigrateVectorsToSqliteOptions): Promise<MigrateVectorsToSqliteReport> {
    const startedAt = Date.now();
    const home = opts.home ?? loreHome();
    const ws = opts.workspaceName;
    // Read-only registry lookup: a --data-dir without a workspaces.json must
    // not get one created as a side effect (loadWorkspaces would, even on --dry-run).
    const registry = loadWorkspacesIfPresent(home);
    if (!registry) {
        throw new Error(`migrate-vectors: no workspace registry (workspaces.json) found under ${home} — nothing to migrate. `
            + 'Check --data-dir / LORE_HOME points at the Lore home that holds the workspace.');
    }
    const entry = registry.workspaces.find((w) => w.name === ws);
    if (!entry) {
        throw new Error(`workspace_not_found: "${ws}" (known: ${registry.workspaces.map((w) => w.name).join(', ')})`);
    }
    const workspaceDir = entry.path;
    const lancedbPath = path.join(workspaceDir, '.lore', 'lancedb');
    const sqlitePath = path.join(workspaceDir, '.lore', 'verbatim.sqlite');

    if (entry.vectorEngine === 'sqlite') {
        throw new Error(`migrate-vectors: workspace '${ws}' is already registered as 'sqlite'. Nothing to migrate.`);
    }

    // ── 1. Daemon preflight ─────────────────────────────────────────────
    if (!opts.skipDaemonCheck) {
        const probe = await isDaemonServingHome(home);
        if (probe.servesHome) throw new Error(daemonRefuseMessage('lore migrate-vectors'));
    }

    // ── 2. Preconditions (read-only) ────────────────────────────────────
    if (!fs.existsSync(path.join(lancedbPath, `${VERBATIM_TABLE}.lance`))) {
        return migrateEmptySource({ opts, home, ws, workspaceDir, lancedbPath, sqlitePath, startedAt });
    }
    let fp: EmbeddingFingerprint | null = readFingerprint(workspaceDir);
    if (!fp && !opts.stampFromConfig) {
        throw new Error(`migrate-vectors: no embedding fingerprint at ${path.join(lancedbPath, 'embedding_model.json')} — the Lance store was never stamped with `
            + 'the embedding model its vectors came from, and the migration will not guess. Either open the workspace with a writable store on Lore 3.28 or later '
            + '(it stamps the fingerprint on open) and retry, or re-run with --stamp-from-config to derive it from the configured embedding model '
            + '(only accepted when that model\'s dimension equals the table\'s vector dimension).');
    }
    const conn = await lancedb.connect(lancedbPath);
    let table: lancedb.Table | null = null;
    let pieceTable: lancedb.Table | null = null;
    let stampedFp: EmbeddingFingerprint | null = null; // written by us — removed again if the migration fails
    try {
        const names = await conn.tableNames();
        table = await conn.openTable(VERBATIM_TABLE);
        pieceTable = names.includes(PIECE_TABLE) ? await conn.openTable(PIECE_TABLE) : null;
        const indices = (await table.listIndices?.()) ?? [];
        const lanceHasVectorIndex = indices.some((i) => (i as { columns?: string[] }).columns?.includes('vector'));

        let stampWarning: string | null = null;
        if (!fp) {
            const provider = opts.embeddingProvider ?? await createEmbeddingProvider();
            if (isEmbeddingDisabled(provider)) {
                throw new Error(`migrate-vectors: --stamp-from-config needs an embedding model, but embeddings are disabled for this process `
                    + '(LORE_EMBEDDING_PROVIDER=none). Configure the model the vectors were made with and retry.');
            }
            const tableDim = await lanceVectorDimension(table);
            if (tableDim === null) {
                throw new Error('migrate-vectors: --stamp-from-config could not read the vector dimension of the Lance table; refusing to guess a fingerprint.');
            }
            if (tableDim !== provider.dimension) {
                throw new Error(`migrate-vectors: --stamp-from-config refused: the Lance table holds ${tableDim}-dimensional vectors but the configured embedding model `
                    + `'${provider.modelId}' produces ${provider.dimension}-dimensional ones, so it cannot be what made them. Configure the model that did `
                    + '(LORE_LOCAL_EMBEDDING_MODEL / LORE_LOCAL_EMBEDDING_DIM, or LORE_EMBEDDING_*) and retry.');
            }
            const dtype = providerDtype(provider);
            fp = { modelId: provider.modelId, dimension: provider.dimension, writtenAt: '', version: 1, ...(dtype ? { dtype } : {}) };
            stampWarning = `embedding fingerprint ${opts.dryRun ? 'would be' : 'was'} derived from the configured provider (${fp.modelId}, ${fp.dimension}d) `
                + `because ${path.join(lancedbPath, 'embedding_model.json')} did not exist; the table's vector dimension matches but the model identity is unverified.`;
        }

        // Pass 1 — ids/text/vector/identity columns/updatedAt: counts, tombstones, duplicates.
        const counts = emptyKindCounts();
        let historyTombstones = 0;
        let historyUnembedded = 0;
        const tracker = new CanonicalTracker();
        const wanted = [...IDENTITY_COLUMNS, 'vector', 'updatedAt'];
        let pass1Columns: string[] | undefined;
        try {
            const have = new Set((await table.schema()).fields.map((f) => f.name));
            pass1Columns = wanted.filter((c) => have.has(c));
        } catch { pass1Columns = undefined; } // unreadable schema: read every column
        for await (const r of lanceRows(table, pass1Columns)) {
            const id = String(r.id);
            const kind = classifyLanceId(id);
            counts[kind]++;
            const text = String(r.text ?? '');
            const tomb = text.startsWith('[TOMBSTONED');
            const unemb = isPlaceholderVector(toFloat32(r.vector));
            if (kind === 'history') {
                if (tomb) historyTombstones++;
                if (unemb) historyUnembedded++;
            } else {
                const ua = r.updatedAt === null || r.updatedAt === undefined ? null : String(r.updatedAt);
                tracker.add(id, kind, rowIdentityKey(r), ua, tomb, unemb);
            }
        }
        const dups = tracker.duplicates();
        if (dups.length > 0 && !(opts.dedupeIdentical && dups.every((d) => d.identical))) {
            throw new Error(duplicateRefusal(dups, !!opts.dedupeIdentical));
        }
        // Deduped: SQLite will hold one row per id, so every expectation below is the SQLite side.
        const dedupePlan = tracker.plan();
        const dedupedIds = tracker.report();
        const dropped = tracker.droppedByKind();
        counts.canonical -= dropped.canonical;
        counts.alias -= dropped.alias;
        const kept = tracker.keptTotals();
        const tombstones = historyTombstones + kept.tombstones;
        const unembedded = historyUnembedded + kept.unembedded;
        const dedupedRowsDropped = dups.reduce((n, d) => n + d.copies - 1, 0);

        const pieces = pieceTable ? await pieceTable.countRows() : 0;
        const threshold = promoteRowsThreshold();
        const canonicalTotal = counts.canonical + counts.alias;
        if (threshold > 0 && canonicalTotal >= threshold) {
            throw new Error(`migrate-vectors: '${ws}' has ${canonicalTotal} canonical rows, at or above the SQLite -> Lance promotion threshold `
                + `(${threshold}, LORE_VECTOR_PROMOTE_ROWS). Its first write would promote it straight back to Lance. Not migrating.`);
        }
        const targetRows = existingTargetRows(sqlitePath);
        if (targetRows !== 0 && !opts.force) throw targetRefusal(sqlitePath, targetRows);
        const lanceTablePaths = [path.join(lancedbPath, `${VERBATIM_TABLE}.lance`)];
        if (pieceTable) lanceTablePaths.push(path.join(lancedbPath, `${PIECE_TABLE}.lance`));
        const report: MigrateVectorsToSqliteReport = {
            workspaceName: ws, workspaceDir, dryRun: !!opts.dryRun, counts, tombstones, unembedded, pieces,
            embeddingModel: { modelId: fp.modelId, dimension: fp.dimension }, promoteThreshold: threshold,
            movedAside: [], sqlitePath, vectorsCompared: 0, probeDetails: [], warnings: stampWarning ? [stampWarning] : [], lanceTablePaths,
            dedupedIds, dedupedRowsDropped, ...(stampWarning ? { stampedFromConfig: true } : {}), durationMs: 0,
        };
        if (opts.dryRun) {
            report.durationMs = Date.now() - startedAt;
            return report;
        }

        // ── 3. Backup FIRST ─────────────────────────────────────────────
        report.backup = await backupWorkspace({ workspaceDir, workspaceName: ws, outDir: opts.backupOutDir });

        // The derived fingerprint is written only now (after the backup, never on
        // a dry run) and removed again by `fail` if anything below throws.
        if (stampWarning) stampedFp = writeFingerprint(workspaceDir, { modelId: fp.modelId, dimension: fp.dimension, dtype: fp.dtype });

        moveTargetAside(sqlitePath, report.movedAside);

        const fail = (err: unknown): never => {
            removeSqliteFiles(sqlitePath);
            if (stampedFp) fs.rmSync(path.join(lancedbPath, 'embedding_model.json'), { force: true });
            const msg = err instanceof Error ? err.message : String(err);
            const aside = report.movedAside.length ? ` Previous target kept at ${report.movedAside[0]}.` : '';
            const wrapped = new (err instanceof MigrateVectorsVerificationError ? MigrateVectorsVerificationError : Error)(
                `${msg} — vectorEngine UNCHANGED ('lance'); partial ${sqlitePath} removed; Lance data untouched (its keyword index may have been rebuilt on open); `
                + `backup at ${report.backup!.tarballPath}.${aside}`);
            throw wrapped;
        };

        // ── 4+5. Stream every Lance row into the raw import ─────────────
        let imp: VerbatimRawImport | null = null;
        const samples: ProbeSample[] = [];
        const excluded = new Set<string>(dedupePlan.keys());
        try {
            imp = await SqliteVerbatimStore.openRawImport(workspaceDir);
            const migratedAt = new Date().toISOString();
            const lanceHashes: string[] = [];
            const batchSize = opts.batchSize ?? 1000;
            let batch: RawVerbatimImportRow[] = [];
            const candidates: ProbeSample[] = [];
            const seenOrdinal = new Map<string, number>();
            let lanceScanned = 0;
            let lanceDroppedSeen = 0;
            for await (const raw of lanceRows(table)) {
                lanceScanned++;
                const rawId = String(raw.id);
                const plan = classifyLanceId(rawId) === 'history' ? undefined : dedupePlan.get(rawId);
                if (plan) {
                    const ord = seenOrdinal.get(rawId) ?? 0;
                    seenOrdinal.set(rawId, ord + 1);
                    if (ord !== plan.keptOrdinal) { lanceDroppedSeen++; continue; }
                    // Pass 2 must pick the very row pass 1 chose.
                    const ua = raw.updatedAt === null || raw.updatedAt === undefined ? '' : String(raw.updatedAt);
                    if (rowIdentityKey(raw) !== plan.key || ua !== plan.keptUpdatedAt) {
                        throw new MigrateVectorsVerificationError(`deduplication: the kept copy of '${rawId}' changed between scans (the Lance table was modified during the migration)`);
                    }
                }
                const m = mapLanceRow(raw, migratedAt);
                lanceHashes.push(m.hash);
                if (m.kind !== 'history' && (m.unembedded || m.row.is_tombstone)) excluded.add(m.row.id);
                else if (m.kind === 'canonical' && m.row.vector && !plan) {
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
            if (lanceDroppedSeen !== dedupedRowsDropped) {
                throw new MigrateVectorsVerificationError(`deduplication: expected to drop ${dedupedRowsDropped} Lance row(s), dropped ${lanceDroppedSeen}`);
            }
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
            // `counts` and `lanceHashes` are already net of the deduped rows;
            // the check below ties them back to the raw Lance scan explicitly:
            // scanned = sqlite rows + dropped copies.
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
                throw new MigrateVectorsVerificationError(`row counts differ: lance ${JSON.stringify(counts)} (after ${dedupedRowsDropped} deduped) vs sqlite ${JSON.stringify(got)}`);
            }
            if (lanceScanned !== sqliteHashes.length + lanceDroppedSeen) {
                throw new MigrateVectorsVerificationError(`row accounting differs: lance scanned ${lanceScanned} != sqlite ${sqliteHashes.length} + deduped ${lanceDroppedSeen}`);
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
            await opts.beforeProbes?.(sqlitePath);
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
            // Read AFTER the probes: opening the Lance store reconciles (and may
            // write) its FTS tokenizer sidecar. SQLite never uses a language.
            const ftsLanguage = readTokenizerFingerprint(workspaceDir)?.language;
            if (ftsLanguage && ftsLanguage !== 'English') {
                report.warnings.push(`SQLite keyword search applies English stemming only; ${ftsLanguage} stemming and stop-words will not be used after migration.`);
            }
            if (dedupedRowsDropped > 0) {
                report.warnings.push(`${dedupedRowsDropped} identical duplicate Lance row(s) across ${dedupedIds.length} id(s) were left out of the SQLite import (newest copy kept); Lance is unchanged.`);
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

/**
 * Workspace registered as 'lance' but with no Lance `lore_verbatim` table
 * (nothing was ever stored, or only sidecar files exist): there is nothing to
 * copy, so create an EMPTY SQLite verbatim store through the normal
 * initialize path — which stamps `embedding_model.json` from the configured
 * provider exactly as a brand-new workspace would — and flip the registry.
 * Same order as the main path: backup first, flip last.
 */
async function migrateEmptySource(a: {
    opts: MigrateVectorsToSqliteOptions; home: string; ws: string; workspaceDir: string;
    lancedbPath: string; sqlitePath: string; startedAt: number;
}): Promise<MigrateVectorsToSqliteReport> {
    const { opts, home, ws, workspaceDir, lancedbPath, sqlitePath, startedAt } = a;
    const provider = opts.embeddingProvider ?? await createEmbeddingProvider();
    if (isEmbeddingDisabled(provider)) {
        throw new Error(`migrate-vectors: workspace '${ws}' has no LanceDB verbatim store at ${lancedbPath} — nothing to migrate — and embeddings are disabled `
            + '(LORE_EMBEDDING_PROVIDER=none), so the empty SQLite store could not be stamped with an embedding fingerprint. '
            + 'Configure an embedding model and retry.');
    }
    if (!Number.isInteger(provider.dimension) || provider.dimension <= 0) {
        throw new Error(`migrate-vectors: workspace '${ws}' has no LanceDB verbatim store — nothing to migrate — and the configured embedding model `
            + `'${provider.modelId}' reports no usable dimension, so the empty SQLite store could not be stamped.`);
    }
    const priorFp = readFingerprint(workspaceDir);
    const warnings: string[] = [];
    if (priorFp && (priorFp.modelId !== provider.modelId || priorFp.dimension !== provider.dimension)) {
        warnings.push(`an existing embedding fingerprint (${priorFp.modelId}, ${priorFp.dimension}d) was replaced by the configured model (${provider.modelId}, ${provider.dimension}d); the store is empty.`);
    }
    const targetRows = existingTargetRows(sqlitePath);
    if (targetRows !== 0 && !opts.force) throw targetRefusal(sqlitePath, targetRows);
    const report: MigrateVectorsToSqliteReport = {
        workspaceName: ws, workspaceDir, dryRun: !!opts.dryRun, counts: emptyKindCounts(), tombstones: 0, unembedded: 0, pieces: 0,
        embeddingModel: { modelId: provider.modelId, dimension: provider.dimension }, promoteThreshold: promoteRowsThreshold(),
        movedAside: [], sqlitePath, vectorsCompared: 0, probeDetails: [], warnings, lanceTablePaths: [],
        dedupedIds: [], dedupedRowsDropped: 0, emptySource: true, durationMs: 0,
    };
    if (opts.dryRun) {
        report.warnings.push('dry run: no Lance verbatim store exists; an empty SQLite store would be created and stamped from the configured embedding model.');
        report.durationMs = Date.now() - startedAt;
        return report;
    }

    // Backup FIRST (whatever exists). A workspace with no `.lore/` has nothing to back up.
    if (fs.existsSync(path.join(workspaceDir, '.lore'))) {
        report.backup = await backupWorkspace({ workspaceDir, workspaceName: ws, outDir: opts.backupOutDir });
    }
    moveTargetAside(sqlitePath, report.movedAside);
    const fpFile = path.join(lancedbPath, 'embedding_model.json');
    // initialize() may overwrite an existing fingerprint; keep its exact bytes so a failure puts them back.
    let priorFpBytes: Buffer | null = null;
    try { priorFpBytes = fs.readFileSync(fpFile); } catch { /* none */ }
    try {
        const store = new SqliteVerbatimStore(workspaceDir, identityOnly(provider, opts.onEmbedCall), { pieceVectors: false, workspaceName: ws, home });
        try { await store.initialize(); } finally { await store.close().catch(() => undefined); }
        const stamped = readFingerprint(workspaceDir);
        if (!stamped || stamped.modelId !== provider.modelId || stamped.dimension !== provider.dimension) {
            throw new MigrateVectorsVerificationError('the empty SQLite store was created but the embedding fingerprint was not stamped as expected');
        }
        if (existingTargetRows(sqlitePath) !== 0) {
            throw new MigrateVectorsVerificationError(`the new SQLite store at ${sqlitePath} is not empty or not readable`);
        }
    } catch (err) {
        removeSqliteFiles(sqlitePath);
        if (priorFpBytes) {
            const tmp = `${fpFile}.restore-${process.pid}`;
            fs.writeFileSync(tmp, priorFpBytes, { mode: 0o600 });
            fs.renameSync(tmp, fpFile);
        } else fs.rmSync(fpFile, { force: true });
        const msg = err instanceof Error ? err.message : String(err);
        const aside = report.movedAside.length ? ` Previous target kept at ${report.movedAside[0]}.` : '';
        throw new (err instanceof MigrateVectorsVerificationError ? MigrateVectorsVerificationError : Error)(
            `${msg} — vectorEngine UNCHANGED ('lance'); partial ${sqlitePath} removed${report.backup ? `; backup at ${report.backup.tarballPath}` : ''}.${aside}`);
    }
    setWorkspaceVectorEngine(ws, 'sqlite', home);
    report.durationMs = Date.now() - startedAt;
    return report;
}
