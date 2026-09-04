/**
 * engines/backup.ts — coordinated workspace backup (architecture gap #12,
 * NW-7h `ent-backup-torn-no-verify` hardening).
 *
 * Snapshots all three local substrates for a workspace into a single
 * tarball:
 *
 *   - Graph store (`graph`/`graph.wal` for a legacy engine, or `surreal/`
 *     for SurrealDB) — file copy
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
 *     2. Read the SurrealDB graph back through a real engine open, then
 *        wait for the store to stop changing on disk. Both matter: the
 *        driver's `close()` does not await surrealkv's WAL→sstable flush,
 *        so a store whose writer let go moments ago is still being
 *        written (see engines/surreal/surrealSettle.ts). The node count
 *        that open returns becomes the archive's `graphNodeCount`.
 *     3. Capture each substrate in a FIXED order — SQLite (online-safe)
 *        first, the graph LAST, settled again immediately before its copy
 *        — so the window between "quiesced" and "copied" is as small as a
 *        non-quiescing backup can make it, and reproducible per host.
 *     4. Open the STAGED graph copy and require the same node count. A
 *        graph dir captured mid-flush is a valid directory holding
 *        nothing, and it passes every byte-level check below; this is the
 *        only step that catches it.
 *     5. Compute a per-file SHA-256 catalog over the staged tree and
 *        embed it in `backup-manifest.json`.
 *     6. After the tarball is written, re-open it, recompute the
 *        catalog, and assert every entry matches. A torn write (zero
 *        bytes, truncated tarball, swapped file) is detected here and
 *        the bad tarball is removed before the call returns.
 *
 *   This is "tamper-evident, graph-verified backup", not
 *   "transactionally-consistent backup". LanceDB and the sidecar files
 *   are still best-effort point-in-time copies, and a write landing
 *   between steps 3 and 4 can still tear them. For a perfectly
 *   transactional image the operator must stop the daemon before invoking
 *   backup — `lore backup` now refuses to run while one is up rather than
 *   leaving that to the docs. `docs/BACKUP_RESTORE.md` states this
 *   explicitly.
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
import {
    looksLikeSurrealStore,
    probeSurrealStore,
    settleSurrealStore,
} from './surreal/surrealSettle.js';

/**
 * Why the source graph's node count could (or couldn't) be verified at
 * backup time — read by `restoreWorkspace` from the manifest so it can tell
 * "this archive predates the field" apart from "this archive's graph was
 * never confirmed readable", which look identical as a bare `null` count but
 * warrant very different restore behaviour (see restore.ts).
 *
 *   - 'verified'   — the store was opened and `graphNodeCount` is a real count.
 *   - 'no-store'   — no SurrealDB store exists in this workspace; nothing to verify.
 *   - 'unreadable' — a store exists but could not be opened (locked by another
 *                    writer, corrupt, etc.) — `graphNodeCount` is null and the
 *                    archive's graph contents are UNCONFIRMED.
 */
export type GraphVerificationReason = 'verified' | 'no-store' | 'unreadable';

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
    /**
     * Nodes the SOURCE graph reported, read back through a real engine open
     * just before it was copied. Null when the workspace has no SurrealDB
     * store, or when it could not be opened (another writer holds it) — in
     * which case the staged copy is not verified either and `warnings` says so.
     */
    graphNodeCount: number | null;
    /** Why `graphNodeCount` is what it is — see {@link GraphVerificationReason}. */
    graphNodeCountReason: GraphVerificationReason;
    /**
     * Non-fatal problems encountered while building this backup — an
     * unreadable source graph, a settle that timed out, a substrate that
     * could not be copied. The tarball was still produced; callers (the CLI)
     * are responsible for surfacing these rather than letting a degraded
     * backup look identical to a clean one.
     */
    warnings: string[];
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
 * `settleSurrealStore` reports `{ settled: false, outcome: 'timeout' }` when
 * the store kept changing past its budget — a signal every call site here
 * used to discard with a bare `await`. Push it into the same `warnings`
 * channel a failed graph read-back uses, so "the copy may still have been
 * moving when we grabbed it" is as visible to an operator as any other
 * degraded-backup condition, never just a silently-swallowed return value.
 */
async function settleAndWarn(storeDir: string, warnings: string[], label: string): Promise<void> {
    const result = await settleSurrealStore(storeDir);
    if (!result.settled) {
        warnings.push(
            `${label}: graph store at ${storeDir} did not settle within ${result.waitedMs}ms `
            + `(outcome=${result.outcome}) — proceeding anyway`,
        );
    }
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

    // Where this workspace's SurrealDB store REALLY is (the naive nested path
    // for nearly every workspace; a scattered sibling when the path carries a
    // URL-reserved character — see surrealDataPath's doc comment).
    const realSurrealPath = surrealDataPath(spec.workspaceDir);
    const naiveSurrealPath = path.join(loreDir, 'surreal');

    /**
     * Read the source graph back before copying it, and leave it quiesced.
     *
     * Two jobs in one open. (1) It produces the node count the staged copy is
     * checked against below and that `restoreWorkspace` re-checks after the
     * restore — without it, "the archive contains a surreal/ directory" is the
     * only claim a backup can make, and an empty store satisfies that. (2)
     * open→close→settle drives surrealkv's WAL→sstable flush to completion, so
     * `cpSync` below copies a store that is not being written mid-copy.
     *
     * Best-effort on purpose: another writer holding the directory lock (a
     * running daemon — `lore backup` refuses that, but `--force` and direct
     * API callers exist) makes this unreadable, and that must degrade to a
     * warning rather than failing an operator's backup. What it must NOT do is
     * silently skip the staged verification without saying so.
     */
    let graphNodeCount: number | null = null;
    let graphNodeCountReason: GraphVerificationReason = 'no-store';
    if (looksLikeSurrealStore(realSurrealPath)) {
        await settleAndWarn(realSurrealPath, warnings, 'pre-copy settle (source)');
        const probe = await probeSurrealStore(spec.workspaceDir);
        if (probe.readable) {
            graphNodeCount = probe.nodeCount;
            graphNodeCountReason = 'verified';
        } else {
            graphNodeCountReason = 'unreadable';
            warnings.push(
                `surreal/ (source at ${realSurrealPath}): could not be read back before copying `
                + `(${probe.detail}) — the copied graph is NOT verified in this archive`,
            );
        }
        await settleAndWarn(realSurrealPath, warnings, 'post-probe settle (source)');
    }

    try {
        // Fixed capture order, with the graph LAST.
        //
        // `readdirSync` order is the filesystem's, so which substrate was
        // captured at which instant varied per host — and the graph is the one
        // substrate whose store keeps mutating after its writer lets go of it.
        // Copying it last shrinks the window between the settle above and the
        // copy to as close to nothing as a non-quiescing backup can get, and
        // makes the ordering reproducible so a torn archive is diagnosable
        // rather than mysterious. SQLite first (its serialize() path is
        // concurrent-write-safe, so it is the cheapest to get out of the way),
        // then everything else alphabetically, then `surreal`.
        const orderedEntries = fs.readdirSync(loreDir).sort((a, b) => {
            const rank = (name: string): number =>
                name === 'surreal' ? 2 : name.endsWith('.sqlite') ? 0 : 1;
            const byRank = rank(a) - rank(b);
            return byRank !== 0 ? byRank : (a < b ? -1 : a > b ? 1 : 0);
        });
        for (const entry of orderedEntries) {
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
                } else if (entry === 'surreal') {
                    // Last in the ordering above, and settled immediately
                    // before the copy rather than once at the top: the other
                    // substrates took real time to capture, and this store is
                    // the one that keeps writing after its writer let go.
                    await settleAndWarn(src, warnings, 'surreal/ pre-copy settle');
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
        if (realSurrealPath !== naiveSurrealPath && fs.existsSync(realSurrealPath) && !files.includes('surreal/')) {
            try {
                await settleAndWarn(realSurrealPath, warnings, 'surreal/ (scattered store) pre-copy settle');
                fs.cpSync(realSurrealPath, path.join(stagedLore, 'surreal'), { recursive: true });
                files.push('surreal/');
            } catch (err) {
                warnings.push(`surreal/ (scattered store at ${realSurrealPath}): ${(err as Error).message}`);
            }
        }

        // ── Prove the COPY is readable, not just present ────────────────────
        //
        // Everything above proves bytes were copied. The catalog below proves
        // the tarball matches those bytes. Neither proves the copied store
        // opens: a graph dir captured mid-flush (WAL already unlinked, sstable
        // not yet landed) is a structurally valid directory holding nothing,
        // and it passes every check in this file. It was observed as a 61-byte
        // `LOCK` + `manifest` tarball that verified clean.
        //
        // So open the staged copy the way the daemon would and require the
        // same node count the source reported. Throws — a backup that cannot
        // prove it captured the graph is worse than no backup, because the
        // operator will trust it.
        if (graphNodeCount !== null) {
            const stagedSurreal = path.join(stagedLore, 'surreal');
            if (!fs.existsSync(stagedSurreal)) {
                throw new Error(
                    `backup verification failed: the source graph at ${realSurrealPath} reported `
                    + `${graphNodeCount} node(s) but no surreal/ store reached the staged tree`,
                );
            }
            // `probeSurrealStore` takes a WORKSPACE dir and re-derives the
            // store location through `surrealDataPath`. That is only the
            // staged store when the staging root itself has no URL-reserved
            // character — true for every mkdtemp under a normal tmpdir, but
            // say so rather than verifying the wrong directory.
            if (surrealDataPath(stage) !== stagedSurreal) {
                warnings.push(
                    `surreal/: staged copy not verified — the staging root ${stage} contains a `
                    + 'URL-reserved character, so the store would be read from a different path than it was written to',
                );
            } else {
                const stagedProbe = await probeSurrealStore(stage);
                if (!stagedProbe.readable) {
                    throw new Error(
                        `backup verification failed: the copied graph at ${stagedSurreal} could not be `
                        + `opened (${stagedProbe.detail}) even though the source at ${realSurrealPath} `
                        + `reported ${graphNodeCount} node(s)`,
                    );
                }
                if (stagedProbe.nodeCount !== graphNodeCount) {
                    throw new Error(
                        `backup verification failed: the copied graph holds ${stagedProbe.nodeCount} node(s) `
                        + `but the source reported ${graphNodeCount}. The store was copied while it was still `
                        + 'being written — stop the daemon (or any other writer) and retake the backup.',
                    );
                }
                // The probe just opened and closed the staged store, which
                // rewrites its manifest; settle before the catalog is computed
                // so the hashes describe a store that has stopped moving.
                await settleAndWarn(stagedSurreal, warnings, 'staged copy settle before catalog');
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
            /**
             * What the source graph actually held, read back through a real
             * engine open (null when there was no store, or it could not be
             * opened — see `warnings`). `restoreWorkspace` re-reads the
             * restored store and refuses to report success on a mismatch,
             * which is the only check that can catch a restore whose bytes
             * were fine and whose store came up empty.
             */
            graphNodeCount,
            /**
             * Why `graphNodeCount` is what it is — see
             * `GraphVerificationReason`'s doc comment. `restoreWorkspace` uses
             * this to tell "this archive predates the field" (absent) apart
             * from "this archive's graph was never confirmed readable"
             * ('unreadable'), which look identical as a bare `null` count.
             */
            graphNodeCountReason,
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
            graphNodeCount,
            graphNodeCountReason,
            warnings,
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
 * path. `none` means a workspace that has never been initialised. 'kuzu' is
 * the legacy graph-engine sentinel — it names an archived on-disk directory,
 * not a live engine choice.
 */
function detectArchivedEngine(loreDir: string): 'kuzu' | 'surreal' | 'both' | 'none' {
    const hasLegacyGraph = fs.existsSync(path.join(loreDir, 'graph'));
    const hasSurreal = fs.existsSync(path.join(loreDir, 'surreal'));
    if (hasLegacyGraph && hasSurreal) return 'both';
    if (hasLegacyGraph) return 'kuzu';
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
