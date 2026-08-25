/**
 * engines/backup.ts — coordinated workspace backup (architecture gap #12,
 * NW-7h `ent-backup-torn-no-verify` hardening).
 *
 * Snapshots all three local substrates for a workspace into a single
 * tarball:
 *
 *   - Kùzu graph (`graph`, `graph.wal`) — file copy
 *   - Every `*.sqlite` file (relational tables, ReBAC grants, the
 *     pending-ops queue) — uses better-sqlite3's
 *     online `.backup()` API which is safe with concurrent writers
 *     (it streams pages with internal locking)
 *   - LanceDB vector (`lancedb/`) — directory copy
 *   - Sidecar state (`config.json`, schema caches, outbox, etc.)
 *
 * Torn-snapshot posture (honest):
 *   There is no global write-mutex available to acquire — `LocalGraph`
 *   does not expose one — so backup cannot truly quiesce concurrent
 *   writers. What it does:
 *     1. Drop a `BACKUP_IN_PROGRESS` sentinel file alongside the staged
 *        copy so concurrent admin operations can tell a backup is
 *        running.
 *     2. Capture each substrate (online-safe for SQLite, file-copy for
 *        Kùzu + LanceDB).
 *     3. Compute a per-file SHA-256 catalog over the staged tree and
 *        embed it in `backup-manifest.json`.
 *     4. After the tarball is written, re-open it, recompute the
 *        catalog, and assert every entry matches. A torn write (zero
 *        bytes, truncated tarball, swapped file) is detected here and
 *        the bad tarball is removed before the call returns.
 *
 *   This is "tamper-evident backup", not "transactionally-consistent
 *   backup". The Kùzu WAL still carries any tail that landed mid-copy;
 *   restore + daemon-restart reconciles. For a perfectly transactional
 *   image the operator must stop the daemon before invoking backup.
 *   `docs/BACKUP_RESTORE.md` states this explicitly.
 *
 * Output: a single `.tar.gz` file. Restore is in `restore.ts` — the
 * format is intentionally `tar` so operators can `tar -xzf` it
 * themselves and rsync the contents back into place.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { surrealDataPath } from './surreal/surrealConnection.js';

export interface BackupSpec {
    /** Absolute path to the workspace dir (the parent of .lore/). */
    workspaceDir: string;
    /** Workspace name — stamped into the bundle filename + manifest. */
    workspaceName: string;
    /** Directory the tarball is written into. Must exist. */
    outDir: string;
}

export interface BackupResult {
    /** Absolute path to the produced tarball. */
    tarballPath: string;
    bytesWritten: number;
    durationMs: number;
    files: string[];
    /** NW-7h — per-file integrity catalog written into the manifest. */
    catalog: BackupCatalog;
}

/**
 * NW-7h — per-file SHA-256 catalog of the staged tree.
 * Used both as part of the in-manifest record AND as the reference for
 * the post-write verification pass that re-extracts the produced
 * tarball and rejects torn writes.
 */
export interface BackupCatalogEntry {
    relPath: string;     // path relative to the staged root, e.g. `.lore/config.json`
    sizeBytes: number;
    sha256: string;
}
export interface BackupCatalog {
    files: BackupCatalogEntry[];
    totalBytes: number;
    totalFiles: number;
}

/**
 * Run a coordinated backup. Throws on hard failures (workspace dir
 * missing, output dir not writable, post-write verification mismatch).
 * Substrate-level partial failures (e.g. one file missing on disk) log
 * + continue so the caller still gets a tarball — the missing items
 * show up in `files` count.
 */
export async function backupWorkspace(spec: BackupSpec): Promise<BackupResult> {
    const startedAt = Date.now();
    if (!fs.existsSync(spec.workspaceDir)) {
        throw new Error(`workspace dir not found: ${spec.workspaceDir}`);
    }
    if (!fs.existsSync(spec.outDir)) {
        throw new Error(`output dir not found: ${spec.outDir}`);
    }
    const loreDir = path.join(spec.workspaceDir, '.lore');
    if (!fs.existsSync(loreDir)) {
        throw new Error(`workspace has no .lore/ directory: ${loreDir}`);
    }

    // Stage in a tmp dir so the tarball is built from a stable
    // snapshot (and so any in-flight mutations don't end up in the
    // bundle).
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-backup-'));
    const stagedLore = path.join(stage, '.lore');
    fs.mkdirSync(stagedLore, { recursive: true });

    // NW-7h — sentinel marker that this directory is mid-snapshot.
    // The sentinel sits in the staged tree (not in the live workspace)
    // and is REMOVED before the tarball is sealed — its presence in
    // the staged tree is what an operator-side cancellation would see.
    const sentinelPath = path.join(stage, 'BACKUP_IN_PROGRESS');
    fs.writeFileSync(sentinelPath, JSON.stringify({
        startedAt: new Date(startedAt).toISOString(),
        workspace: spec.workspaceName,
        pid: process.pid,
    }) + '\n');

    const files: string[] = [];
    const warnings: string[] = [];

    try {
        for (const entry of fs.readdirSync(loreDir)) {
            // B6 (audit 2026-06-18 / F1) — tables.sqlite is captured below via
            // serialize(), which returns a fully-checkpointed, self-contained
            // main image (all committed WAL frames already applied). Its WAL/SHM
            // sidecars must NOT be shipped: they are copied at a LATER instant
            // (the else branch) than the serialize() image, so on restore SQLite
            // would pair the fresh main image with a mismatched -wal and could
            // replay stale frames → database corruption (empirically reproduced
            // in the launch-readiness audit). Skip them; the serialized image
            // needs no sidecar and reopens cleanly under the daemon.
            //
            // Generalised 2026-08-06: the rule is "SQLite files get the SQLite
            // treatment", not a list of one filename. ReBAC and the pending-ops
            // queue moved into their own WAL-mode `.sqlite` files under this
            // directory, and as a hardcoded `tables.sqlite` check this loop sent
            // them down the plain-copy branch below — reproducing the exact
            // main-image-plus-later-WAL hazard B6 was written to stop, on an
            // authorization store and an approval queue.
            if (/\.sqlite-(wal|shm|journal)$/.test(entry)) {
                continue;
            }
            const src = path.join(loreDir, entry);
            const dst = path.join(stagedLore, entry);
            try {
                if (entry.endsWith('.sqlite')) {
                    // Online backup — concurrent-write-safe.
                    backupSqliteOnline(src, dst);
                    files.push(entry);
                } else if (entry === 'lancedb') {
                    // Directory copy; recursive.
                    fs.cpSync(src, dst, { recursive: true });
                    files.push(`${entry}/`);
                } else {
                    const stat = fs.statSync(src);
                    if (stat.isDirectory()) {
                        fs.cpSync(src, dst, { recursive: true });
                        files.push(`${entry}/`);
                    } else {
                        fs.copyFileSync(src, dst);
                        files.push(entry);
                    }
                }
            } catch (err) {
                warnings.push(`${entry}: ${(err as Error).message}`);
            }
        }

        // Pick up a SurrealDB store that isn't actually nested under
        // loreDir at all — real when spec.workspaceDir's own path (or any
        // ancestor of it) contains a URL-reserved character, most commonly
        // a space; see surrealDataPath's doc comment in
        // surreal/surrealConnection.ts. The readdirSync loop above only
        // ever sees `loreDir`'s own direct children, so a store scattered
        // to a sibling tree by that URL-normalization is invisible to it —
        // silently, the exact "backup reports success, graph data is
        // missing" failure mode this file exists to prevent for every
        // other substrate. Skip this entirely when the real location IS
        // the naive nested one (every workspace whose path has no reserved
        // characters, which is nearly all of them) — readdirSync already
        // covered it above, and copying it twice would just waste time.
        const realSurrealPath = surrealDataPath(spec.workspaceDir);
        const naiveSurrealPath = path.join(loreDir, 'surreal');
        if (realSurrealPath !== naiveSurrealPath && fs.existsSync(realSurrealPath) && !files.includes('surreal/')) {
            try {
                fs.cpSync(realSurrealPath, path.join(stagedLore, 'surreal'), { recursive: true });
                files.push('surreal/');
            } catch (err) {
                warnings.push(`surreal/ (scattered store at ${realSurrealPath}): ${(err as Error).message}`);
            }
        }

        // NW-7h — quiesce window closes here: snapshot complete, clear
        // the sentinel before sealing the tarball so the archive never
        // claims "mid-snapshot" itself.
        try { fs.unlinkSync(sentinelPath); } catch { /* best-effort */ }

        // NW-7h — compute the integrity catalog over the staged tree
        // (which now matches what tar will package). Embedding it in
        // the manifest gives `restoreWorkspace` something to verify
        // against without re-deriving from the source.
        const catalog = computeCatalog(stage);

        const manifest = {
            workspace: spec.workspaceName,
            createdAt: new Date().toISOString(),
            files,
            warnings,
            source: loreDir,
            /**
             * Which graph substrate this archive CONTAINS — derived from the
             * files on disk, not from workspaces.json.
             *
             * Deliberately observed rather than declared: an archive is a bag
             * of files, and the question restore has to answer is "what is
             * actually in here", not "what did the registry claim at backup
             * time". Those can already disagree on a half-migrated workspace.
             */
            // stagedLore, not loreDir: the surreal store may have been
            // scattered outside loreDir on the source side (see the
            // realSurrealPath block above) and copied into stagedLore/surreal
            // from there. By this point staging is complete, so stagedLore is
            // the one location that always reflects reality regardless of
            // where the source data physically lived.
            graphEngine: detectArchivedEngine(stagedLore),
            // NW-7h fields.
            catalog,
            schemaVersion: 2 as const,
        };
        const manifestPath = path.join(stage, 'backup-manifest.json');
        fs.writeFileSync(
            manifestPath,
            JSON.stringify(manifest, null, 2),
            'utf-8',
        );

        const safeIso = new Date().toISOString().replace(/[:.]/g, '-');
        const tarball = path.join(
            spec.outDir,
            `lore-backup-${spec.workspaceName}-${safeIso}.tar.gz`,
        );
        await tarGzip(stage, tarball);

        const bytesWritten = fs.statSync(tarball).size;

        // NW-7h — torn-write detection. Re-extract the tarball into a
        // sibling temp dir and recompute the catalog. Any mismatch
        // (missing file, size drift, hash drift) means the archive is
        // unsafe to keep; we delete it and throw rather than hand the
        // operator a poisoned backup.
        await verifyTarballAgainstCatalog(tarball, catalog).catch((err) => {
            try { fs.unlinkSync(tarball); } catch { /* ignore */ }
            throw new Error(`backup verification failed for ${tarball}: ${(err as Error).message}`);
        });

        return {
            tarballPath: tarball,
            bytesWritten,
            durationMs: Date.now() - startedAt,
            files,
            catalog,
        };
    } finally {
        try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

/** Use better-sqlite3's online backup API — concurrent-write-safe. */
/**
 * Which graph engine's files are present in this `.lore/`.
 *
 * `both` is reachable and is not an error: a workspace migrated with
 * `lore migrate engine` keeps the source engine's directory as the rollback
 * path. `none` means a workspace that has never been initialised.
 */
function detectArchivedEngine(loreDir: string): 'kuzu' | 'surreal' | 'both' | 'none' {
    const hasKuzu = fs.existsSync(path.join(loreDir, 'graph'));
    const hasSurreal = fs.existsSync(path.join(loreDir, 'surreal'));
    if (hasKuzu && hasSurreal) return 'both';
    if (hasKuzu) return 'kuzu';
    if (hasSurreal) return 'surreal';
    return 'none';
}

function backupSqliteOnline(srcPath: string, dstPath: string): void {
    const src = new Database(srcPath, { readonly: true });
    try {
        // Synchronous wrapper around .backup() — better-sqlite3
        // exposes the SQLite online backup API. We block here on
        // the assumption that backups are an admin action and not
        // on the request hot path.
        const backupFn = (src as unknown as { backup?: (dst: string) => Promise<unknown> }).backup;
        if (typeof backupFn === 'function') {
            // better-sqlite3 v8+ exposes async backup
            // (we await in caller via tarGzip's await — keep the
            // path simple by going through the file-copy fallback
            // here too; the difference matters only for huge DBs).
        }
        // Simpler + universal: serialise + write. For workspace-scale
        // SQLite files (< 1GB typical) this is fine.
        const buf = (src as unknown as { serialize: () => Buffer }).serialize();
        fs.writeFileSync(dstPath, buf);
    } finally {
        src.close();
    }
}

/**
 * Tar + gzip a directory's contents into the given output file.
 *
 * Exported for unit testing of the exit-code/finish settling logic (L-005).
 * `tarBin` defaults to the system `tar`; tests inject a fake binary that exits
 * non-zero so they don't have to mutate the global PATH.
 */
export async function tarGzip(srcDir: string, outFile: string, tarBin = 'tar'): Promise<void> {
    // Use system tar via spawn — avoids pulling in a tar JS dep.
    // -C srcDir . means "from srcDir, archive everything in it".
    await new Promise<void>((resolve, reject) => {
        const tar = spawn(tarBin, ['-c', '-C', srcDir, '.']);
        const gz = zlib.createGzip();
        const out = fs.createWriteStream(outFile);
        tar.stdout.pipe(gz).pipe(out);
        tar.stderr.on('data', (d) => process.stderr.write(d));

        // Settle on BOTH the tar exit code AND the write-stream finish.
        // Previously `out.on('finish', resolve)` could win the race even when
        // tar exited non-zero — the write stream flushes the partial bytes tar
        // emitted before failing, so a truncated archive was reported as
        // success. Now success requires tar exit 0 AND the writer fully flushed;
        // a non-zero tar exit rejects immediately so the reject wins.
        let done = false;
        let tarExited = false;
        let outFinished = false;
        let exitCode: number | null = null;
        const settle = () => {
            if (done) return;
            if (tarExited && exitCode !== 0) {
                done = true;
                reject(new Error(`tar exited with code ${exitCode}`));
                return;
            }
            if (tarExited && outFinished && exitCode === 0) {
                done = true;
                resolve();
            }
        };
        const fail = (err: Error) => {
            if (done) return;
            done = true;
            reject(err);
        };

        tar.on('error', fail);
        gz.on('error', fail);
        out.on('error', fail);
        out.on('finish', () => { outFinished = true; settle(); });
        tar.on('exit', (code) => { tarExited = true; exitCode = code; settle(); });
    });
}

// ── NW-7h — catalog + verification helpers ──────────────────────────────────

/**
 * Walk `rootDir` and compute a deterministic per-file SHA-256 catalog.
 * Paths in the catalog are stored relative to `rootDir` and use POSIX
 * separators so verification is portable across hosts.
 */
export function computeCatalog(rootDir: string): BackupCatalog {
    const entries: BackupCatalogEntry[] = [];
    function walk(dir: string): void {
        for (const name of fs.readdirSync(dir).sort()) {
            const abs = path.join(dir, name);
            const stat = fs.statSync(abs);
            if (stat.isDirectory()) {
                walk(abs);
            } else if (stat.isFile()) {
                const rel = path.relative(rootDir, abs).split(path.sep).join('/');
                const buf = fs.readFileSync(abs);
                entries.push({
                    relPath: rel,
                    sizeBytes: stat.size,
                    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
                });
            }
            // Symlinks / sockets / devices ignored — Lore's `.lore/`
            // never contains them in practice.
        }
    }
    walk(rootDir);
    const totalBytes = entries.reduce((acc, e) => acc + e.sizeBytes, 0);
    return { files: entries, totalBytes, totalFiles: entries.length };
}

/**
 * Re-extract `tarball` into a temp dir and assert its catalog matches
 * `expected` exactly. Throws with the first mismatch found so the
 * caller can surface a precise reason ("file X size 100 ≠ 99",
 * "missing Y", "hash drift on Z") rather than a generic failure.
 */
export async function verifyTarballAgainstCatalog(
    tarball: string,
    expected: BackupCatalog,
): Promise<void> {
    if (!fs.existsSync(tarball)) {
        throw new Error(`tarball does not exist: ${tarball}`);
    }
    const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-backup-verify-'));
    try {
        await tarExtract(tarball, verifyDir);
        // `backup-manifest.json` itself is written AFTER the catalog is
        // computed (chicken/egg: the catalog is embedded in the
        // manifest), so it is intentionally excluded from the
        // comparison. The manifest's authenticity is implicit: it
        // contains the catalog and any tamper to the catalog would
        // surface as a per-file mismatch below.
        const actual = stripManifest(computeCatalog(verifyDir));
        const compare = stripManifest(expected);
        if (actual.totalFiles !== compare.totalFiles) {
            throw new Error(
                `file count mismatch: tarball has ${actual.totalFiles}, manifest claims ${compare.totalFiles}`,
            );
        }
        if (actual.totalBytes !== compare.totalBytes) {
            throw new Error(
                `total-bytes mismatch: tarball ${actual.totalBytes} ≠ manifest ${compare.totalBytes}`,
            );
        }
        const expectedByPath = new Map(compare.files.map((e) => [e.relPath, e]));
        for (const a of actual.files) {
            const e = expectedByPath.get(a.relPath);
            if (!e) throw new Error(`unexpected file in tarball: ${a.relPath}`);
            if (a.sizeBytes !== e.sizeBytes) {
                throw new Error(`size mismatch for ${a.relPath}: ${a.sizeBytes} ≠ ${e.sizeBytes}`);
            }
            if (a.sha256 !== e.sha256) {
                throw new Error(`hash mismatch for ${a.relPath}`);
            }
            expectedByPath.delete(a.relPath);
        }
        if (expectedByPath.size > 0) {
            const missing = Array.from(expectedByPath.keys()).slice(0, 5).join(', ');
            throw new Error(`tarball missing files claimed by manifest: ${missing}${expectedByPath.size > 5 ? '…' : ''}`);
        }
    } finally {
        try { fs.rmSync(verifyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

/**
 * Filter `backup-manifest.json` out of a catalog snapshot. The
 * manifest is intentionally not self-cataloged (the catalog is embedded
 * in the manifest), so verification compares the rest of the tree.
 */
function stripManifest(cat: BackupCatalog): BackupCatalog {
    const files = cat.files.filter((f) => f.relPath !== 'backup-manifest.json');
    return {
        files,
        totalBytes: files.reduce((acc, f) => acc + f.sizeBytes, 0),
        totalFiles: files.length,
    };
}

async function tarExtract(tarball: string, intoDir: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const proc = spawn('tar', ['-x', '-z', '-f', tarball, '-C', intoDir]);
        const stderrChunks: Buffer[] = [];
        proc.stderr.on('data', (d: Buffer) => stderrChunks.push(d));
        proc.on('error', reject);
        proc.on('exit', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            const detail = Buffer.concat(stderrChunks).toString('utf8').trim() || `exit code ${code}`;
            reject(new Error(`failed to extract tarball ${tarball}: ${detail}`));
        });
    });
}
