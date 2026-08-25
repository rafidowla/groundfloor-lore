/**
 * engines/restore.ts — counterpart to backup.ts.
 *
 * Restores a workspace from a tarball produced by `backupWorkspace`:
 *
 *   1. Verify the tarball exists + contains `.lore/` + `backup-manifest.json`.
 *   2. Stage-extract into a tmp dir so a corrupt tarball can't
 *      partially overwrite the live workspace.
 *   3. Move the destination's existing `.lore/` aside (if any) into
 *      a timestamped sibling so the operator can roll back manually.
 *   4. Move the staged `.lore/` into place.
 *   5. Report bytes restored + file count + the sidelined-prior-state path.
 *
 * Restore is intentionally low-magic: it does not start the daemon,
 * does not validate substrate consistency, does not run migrations.
 * Operator restarts the daemon after restore; the consistency sweeper
 * picks up any drift on the next pass.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { surrealDataPath } from './surreal/surrealConnection.js';

export interface RestoreSpec {
    /** Absolute path to the tarball. */
    tarballPath: string;
    /** Destination workspace dir (the parent of .lore/). Must exist. */
    workspaceDir: string;
    /**
     * The graph engine the DESTINATION workspace is registered as, when the
     * caller knows it. Supplied by the CLI from workspaces.json.
     *
     * Optional because `restoreWorkspace` is also called with a bare directory
     * (tests, ad-hoc recovery) where there is no registry to consult; absent
     * simply skips the mismatch check rather than inventing an answer.
     */
    expectedEngine?: 'kuzu' | 'surreal';
}

export interface RestoreResult {
    /** Path the prior `.lore/` was sidelined to. Null when no prior
     *  state existed. */
    sidelinedPriorTo: string | null;
    /**
     * Path a prior SurrealDB store living OUTSIDE `.lore/` was sidelined to
     * (see the scattered-store handling below `destLore/surreal` in
     * `restoreWorkspace`). Null when there was nothing there to sideline —
     * true for every workspace whose path has no URL-reserved characters,
     * which is nearly all of them.
     */
    sidelinedPriorScatteredSurrealTo: string | null;
    bytesRestored: number;
    files: string[];
    durationMs: number;
}

export async function restoreWorkspace(spec: RestoreSpec): Promise<RestoreResult> {
    const startedAt = Date.now();
    if (!fs.existsSync(spec.tarballPath)) {
        throw new Error(`tarball not found: ${spec.tarballPath}`);
    }
    if (!fs.existsSync(spec.workspaceDir)) {
        throw new Error(`workspace dir not found: ${spec.workspaceDir}`);
    }

    // Stage-extract into a tmp dir.
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-restore-'));
    try {
        await tarExtract(spec.tarballPath, stage);

        const stagedLore = path.join(stage, '.lore');
        const manifestPath = path.join(stage, 'backup-manifest.json');
        if (!fs.existsSync(stagedLore)) {
            throw new Error(`tarball missing .lore/ — not a Lore backup`);
        }
        if (!fs.existsSync(manifestPath)) {
            throw new Error(`tarball missing backup-manifest.json — refusing to restore`);
        }
        type ManifestV2 = {
            files?: string[];
            graphEngine?: 'kuzu' | 'surreal' | 'both' | 'none';
            schemaVersion?: number;
            catalog?: { files: { relPath: string; sizeBytes: number; sha256: string }[]; totalBytes: number; totalFiles: number };
        };
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ManifestV2;

        // Engine-mismatch guard. The archive records which graph substrate its
        // files actually ARE; the destination's workspaces.json records which
        // one the daemon will open. Restoring a Kùzu archive into a workspace
        // registered as 'surreal' produced a workspace whose registry and
        // `.lore/` disagreed — the daemon then opens an engine whose store is
        // absent, reads an empty graph, and reports success. Nothing detected
        // it, which is the whole problem: the failure mode is a workspace that
        // looks fine and has no data.
        //
        // Refused rather than auto-corrected. Rewriting the destination's
        // graphEngine would silently change which substrate a workspace runs
        // on as a side effect of a restore, and that is a decision an operator
        // must make deliberately.
        if (spec.expectedEngine && manifest.graphEngine
            && manifest.graphEngine !== 'none' && manifest.graphEngine !== 'both'
            && manifest.graphEngine !== spec.expectedEngine) {
            throw new Error(
                `engine mismatch: this archive contains a '${manifest.graphEngine}' graph, but workspace `
                + `"${path.basename(spec.workspaceDir)}" is registered as '${spec.expectedEngine}'. `
                + 'Restoring would leave workspaces.json and .lore/ disagreeing, and the daemon would '
                + 'open an engine whose store is not there — an empty graph, reported as success. '
                + `Either restore into a '${manifest.graphEngine}' workspace, or change this workspace's `
                + 'graphEngine deliberately before restoring.',
            );
        }

        // NW-7h — torn-restore detection. If the manifest carries a
        // catalog (schemaVersion >= 2), re-derive a catalog over the
        // staged tree and compare. A mismatch means the tarball was
        // tampered with or truncated between backup and restore. We
        // throw BEFORE sidelining the live `.lore/` so a corrupted
        // backup never destroys an intact workspace.
        if (manifest.catalog && manifest.schemaVersion && manifest.schemaVersion >= 2) {
            const { computeCatalog } = await import('./backup.js');
            const actualAll = computeCatalog(stage);
            // backup-manifest.json is not self-cataloged — exclude it on
            // both sides so the count/bytes assertions stay symmetric.
            const actual = actualAll.files.filter((f) => f.relPath !== 'backup-manifest.json');
            const expected = manifest.catalog.files.filter((f) => f.relPath !== 'backup-manifest.json');
            const actualBytes = actual.reduce((acc, f) => acc + f.sizeBytes, 0);
            const expectedBytes = expected.reduce((acc, f) => acc + f.sizeBytes, 0);
            if (actual.length !== expected.length || actualBytes !== expectedBytes) {
                throw new Error(
                    `tarball integrity check failed: actual ${actual.length}f/${actualBytes}b ≠ manifest ${expected.length}f/${expectedBytes}b`,
                );
            }
            const expectedByPath = new Map(expected.map((e) => [e.relPath, e]));
            for (const a of actual) {
                const e = expectedByPath.get(a.relPath);
                if (!e || a.sha256 !== e.sha256 || a.sizeBytes !== e.sizeBytes) {
                    throw new Error(`tarball integrity check failed at ${a.relPath}`);
                }
            }
        }

        // Sideline the existing .lore/ if any.
        const destLore = path.join(spec.workspaceDir, '.lore');
        let sidelinedPriorTo: string | null = null;
        if (fs.existsSync(destLore)) {
            const safeIso = new Date().toISOString().replace(/[:.]/g, '-');
            sidelinedPriorTo = path.join(spec.workspaceDir, `.lore.pre-restore-${safeIso}`);
            fs.renameSync(destLore, sidelinedPriorTo);
        }

        // Move staged → destination. fs.renameSync may fail across
        // filesystems (tmp on different volume); fall back to cpSync.
        try {
            fs.renameSync(stagedLore, destLore);
        } catch {
            fs.cpSync(stagedLore, destLore, { recursive: true });
        }

        // The archive always stages a surreal store (if any) at the naive
        // nested path `.lore/surreal` — backupWorkspace does this
        // regardless of where the store physically lived on the source
        // side (see the realSurrealPath block in backup.ts). But the
        // DESTINATION may itself have a URL-reserved character (a space)
        // somewhere in spec.workspaceDir's own tree, in which case
        // openSurreal() will look for this workspace's store at
        // surrealDataPath(spec.workspaceDir) — NOT at destLore/surreal.
        // Left alone, this reproduces the original bug in reverse: data
        // sits inert at destLore/surreal while the running engine reads an
        // empty store from the scattered location. Relocate it now, while
        // we still know exactly where it landed.
        let sidelinedPriorScatteredSurrealTo: string | null = null;
        let relocatedSurrealTo: string | null = null;
        const naiveSurrealDest = path.join(destLore, 'surreal');
        if (fs.existsSync(naiveSurrealDest)) {
            const realSurrealPath = surrealDataPath(spec.workspaceDir);
            if (realSurrealPath !== naiveSurrealDest) {
                if (fs.existsSync(realSurrealPath)) {
                    // Something already lives at the real location — sideline
                    // it exactly like destLore above rather than clobbering
                    // it, so a restore can never silently destroy live data.
                    const safeIso = new Date().toISOString().replace(/[:.]/g, '-');
                    sidelinedPriorScatteredSurrealTo = `${realSurrealPath}.pre-restore-${safeIso}`;
                    fs.renameSync(realSurrealPath, sidelinedPriorScatteredSurrealTo);
                } else {
                    fs.mkdirSync(path.dirname(realSurrealPath), { recursive: true });
                }
                try {
                    fs.renameSync(naiveSurrealDest, realSurrealPath);
                } catch {
                    fs.cpSync(naiveSurrealDest, realSurrealPath, { recursive: true });
                    fs.rmSync(naiveSurrealDest, { recursive: true, force: true });
                }
                relocatedSurrealTo = realSurrealPath;
            }
        }

        // directorySize(destLore) alone under-counts once the surreal store
        // has been relocated OUT of destLore above — add it back from its
        // real location so bytesRestored still reflects everything the
        // archive actually put on disk.
        const bytesRestored = directorySize(destLore)
            + (relocatedSurrealTo !== null ? directorySize(relocatedSurrealTo) : 0);
        return {
            sidelinedPriorTo,
            sidelinedPriorScatteredSurrealTo,
            bytesRestored,
            files: manifest.files ?? [],
            durationMs: Date.now() - startedAt,
        };
    } finally {
        try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

function directorySize(dir: string): number {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) total += directorySize(p);
        else total += fs.statSync(p).size;
    }
    return total;
}

/**
 * R3-1 (tar-slip) — list the tarball's members and reject any that would escape
 * the staging dir before we extract. A backup tarball is a portable, shareable
 * artifact, so restoring an untrusted one is realistic; an absolute-path or `..`
 * member could otherwise overwrite auth.token / workspaces.json / a launchd plist
 * as the daemon user. Portable across GNU tar and macOS bsdtar (both honour
 * `-tzf`). Runs BEFORE `tar -x`, so no escaping member is ever written.
 */
async function assertSafeTarMembers(tarball: string): Promise<void> {
    const listing = await new Promise<string>((resolve, reject) => {
        const proc = spawn('tar', ['-t', '-z', '-f', tarball]);
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        proc.stdout.on('data', (d: Buffer) => out.push(d));
        proc.stderr.on('data', (d: Buffer) => err.push(d));
        proc.on('error', reject);
        proc.on('exit', (code) => {
            if (code === 0) { resolve(Buffer.concat(out).toString('utf8')); return; }
            const detail = Buffer.concat(err).toString('utf8').trim() || `exit code ${code}`;
            reject(new Error(`failed to list backup tarball ${tarball}: ${detail}`));
        });
    });
    for (const raw of listing.split('\n')) {
        const member = raw.trim();
        if (!member) continue;
        const segments = member.split('/');
        const unsafe =
            member.startsWith('/') ||          // absolute path
            member.startsWith('~') ||          // home expansion
            /^[A-Za-z]:/.test(member) ||       // drive-letter absolute
            segments.includes('..');           // parent-dir traversal
        if (unsafe) {
            throw new Error(`refusing to extract backup tarball ${tarball}: unsafe member path "${member}" (would escape the staging directory)`);
        }
    }
}

async function tarExtract(tarball: string, intoDir: string): Promise<void> {
    // R3-1 — validate every member path before extraction (tar-slip guard).
    await assertSafeTarMembers(tarball);
    await new Promise<void>((resolve, reject) => {
        const proc = spawn('tar', ['-x', '-z', '-f', tarball, '-C', intoDir]);
        // Capture stderr so the rejection message includes tar's own
        // diagnostic — "Unrecognized archive format" beats "exited
        // with code 1" for an operator debugging a bad backup file.
        // Audit rc4-workspace caught this: the prior "tar -xzf exited
        // with code N" gave the operator no actionable signal.
        const stderrChunks: Buffer[] = [];
        proc.stderr.on('data', (d: Buffer) => {
            stderrChunks.push(d);
            process.stderr.write(d);
        });
        proc.on('error', reject);
        proc.on('exit', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            const detail = Buffer.concat(stderrChunks).toString('utf8').trim() || `exit code ${code}`;
            reject(new Error(`failed to extract backup tarball ${tarball}: ${detail}`));
        });
    });
}
