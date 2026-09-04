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
 *   5. Read the restored graph back through a real engine open and refuse
 *      to report success if it is unreadable or short of the node count the
 *      archive recorded.
 *   6. Report bytes restored + file count + the sidelined-prior-state path.
 *
 * Steps 3 and 5 both exist because "the bytes arrived" and "the daemon can
 * read them" are different claims. A SurrealDB store closed moments before a
 * restore keeps flushing into its old path for ~10-25 ms after `close()`
 * resolves, so a restore can drop a perfectly good store at that path and
 * have the previous store's flush unlink its WAL — a valid, empty directory
 * that a catalog check cannot distinguish from a good one. See
 * engines/surreal/surrealSettle.ts.
 *
 * Otherwise restore stays low-magic: it does not start the daemon, does not
 * validate substrate consistency, does not run migrations. Operator restarts
 * the daemon after restore; the consistency sweeper picks up any drift on the
 * next pass.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { surrealDataPath } from './surreal/surrealConnection.js';
import {
    looksLikeSurrealStore,
    probeSurrealStore,
    settleSurrealStore,
} from './surreal/surrealSettle.js';
import type { GraphVerificationReason } from './backup.js';

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
    /**
     * Restore an archive whose manifest says its source graph was NEVER
     * confirmed readable at backup time (`graphNodeCountReason: 'unreadable'`
     * — the store was locked by another writer, or otherwise unopenable, when
     * `backupWorkspace` tried to verify it). Off by default: such an archive
     * may hold an empty or torn graph and there is no recorded count to check
     * the restore against, so restoring it silently is exactly the "backup
     * reported success, graph data is missing" failure this whole file exists
     * to prevent — just moved one step earlier, into the backup itself. CLI
     * flag: `--allow-unverified`.
     */
    allowUnverifiedSource?: boolean;
    /**
     * The workspace name the caller is restoring INTO — normally the CLI's
     * `--workspace <name>` (or its default), looked up from workspaces.json.
     * Optional for the same reason `expectedEngine` is: `restoreWorkspace` is
     * also called with a bare directory (tests, ad-hoc recovery) that has no
     * registry entry to name, and there is nothing to compare against then.
     */
    targetWorkspaceName?: string;
    /**
     * Restore an archive whose manifest records a DIFFERENT workspace name
     * than `targetWorkspaceName` (`backup-manifest.json`'s `workspace` field
     * — written by `backupWorkspace` from `spec.workspaceName`, see
     * engines/backup.ts). Off by default: `lore restore <archive-of-default>
     * --workspace other` used to restore cleanly into 'other' with a clean
     * success message and no warning at all — a copy-pasted tarball path or a
     * stale `--workspace` flag lands silently in the wrong workspace. An
     * archive with no recorded `workspace` field (pre-3.19, predates this
     * field) proceeds either way, with a one-line notice instead of a
     * comparison it cannot make. CLI flag: `--allow-name-mismatch`.
     */
    allowNameMismatch?: boolean;
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
    /**
     * Nodes readable from the restored graph store, read back through a real
     * engine open AFTER the restore completed — not counted from the archive.
     * Null when the archive carried no SurrealDB store to verify.
     */
    restoredGraphNodeCount: number | null;
    /**
     * What the archive's manifest said the source graph held. Null for
     * pre-3.17 tarballs, which predate the field; the read-back above still
     * runs, it just has nothing to compare against.
     */
    expectedGraphNodeCount: number | null;
    /**
     * Why `expectedGraphNodeCount` is null, when it is. Undefined for a
     * pre-3.18 archive (predates this field entirely, same vintage as a null
     * `graphNodeCount` with no explanation) — that is the genuinely benign
     * "nothing recorded" case. `'unreadable'` is the ALARMING one: the source
     * graph existed but backup could not confirm what it held, so this
     * archive's graph contents are unconfirmed. `'no-store'` means the
     * workspace simply had no graph to verify. `'verified'` cannot coexist
     * with a null count.
     */
    expectedGraphNodeCountReason: GraphVerificationReason | undefined;
    /**
     * Non-fatal problems surfaced while restoring — currently just a settle
     * that ran out its budget while the pre-restore destination store was
     * still changing on disk (see `settleSurrealStore`). The restore still
     * proceeded; callers (the CLI) are responsible for surfacing these.
     */
    warnings: string[];
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
            /**
             * The workspace `backupWorkspace` was told it was backing up
             * (`spec.workspaceName`, engines/backup.ts ~:400) — the archive's
             * own claim about where it came from, not derived from anything
             * on disk. Absent on archives written before this field existed.
             */
            workspace?: string;
            graphEngine?: 'kuzu' | 'surreal' | 'both' | 'none';
            /**
             * Nodes the SOURCE graph reported when the archive was staged
             * (backup.ts reads it back through a real engine open). Optional:
             * tarballs written before 3.17 do not carry it, and a workspace
             * whose store could not be opened at backup time records null.
             */
            graphNodeCount?: number | null;
            /**
             * Why `graphNodeCount` is what it is (see `GraphVerificationReason`).
             * Absent on archives written before this field existed — those
             * carry only the older, unexplained-null shape.
             */
            graphNodeCountReason?: GraphVerificationReason;
            schemaVersion?: number;
            catalog?: { files: { relPath: string; sizeBytes: number; sha256: string }[]; totalBytes: number; totalFiles: number };
        };
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ManifestV2;
        const warnings: string[] = [];

        // Workspace-name guard. `manifest.workspace` is the archive's own
        // claim about which workspace it was backed up from; nothing before
        // this compared it against the workspace the caller is restoring
        // INTO, so `lore restore <archive-of-default> --workspace other`
        // restored the 'default' archive's data into 'other' with a clean
        // success message and no warning — the exact "wrong tarball / stale
        // --workspace flag" mistake this check exists to catch. Same shape as
        // `allowUnverifiedSource` above: refuse unless the caller opts in,
        // and even then say so loudly rather than silently proceeding.
        if (spec.targetWorkspaceName !== undefined) {
            if (manifest.workspace === undefined) {
                warnings.push(
                    `this archive's manifest has no recorded workspace name (predates that field) — `
                    + `cannot verify it was backed up from '${spec.targetWorkspaceName}'.`,
                );
            } else if (manifest.workspace !== spec.targetWorkspaceName) {
                if (!spec.allowNameMismatch) {
                    throw new Error(
                        `refusing to restore: this archive's manifest says it was backed up from workspace `
                        + `'${manifest.workspace}', but you are restoring into '${spec.targetWorkspaceName}'. `
                        + 'This is very often the wrong tarball or a stale --workspace flag; if a cross-'
                        + 'workspace restore is genuinely what you intend, pass allowNameMismatch (CLI: '
                        + '--allow-name-mismatch) to proceed anyway.',
                    );
                }
                warnings.push(
                    `WORKSPACE NAME MISMATCH: restoring an archive backed up from workspace `
                    + `'${manifest.workspace}' into '${spec.targetWorkspaceName}' — proceeding because `
                    + 'allowNameMismatch was set.',
                );
            }
        }

        // The archive's own graph was never confirmed readable at backup
        // time — refuse to restore it silently. See `allowUnverifiedSource`'s
        // doc comment: an archive in this state may hold an empty or torn
        // graph and carries no count to check the restore against, so "the
        // bytes arrived" is the only claim this restore could make for it.
        //
        // QA round 2 (2026-09-03): this used to check only
        // `=== 'unreadable'`, so any OTHER value — a corrupt manifest, a
        // future schema's new reason string, a simple typo — sailed through
        // unrefused, identical to a clean 'verified' archive, even though
        // `graphNodeCount` is null and nothing was actually verified. Fixed
        // to an ALLOWLIST: `undefined` (pre-3.18 archives, which predate this
        // field) and the known-safe members of `GraphVerificationReason`
        // ('verified', 'no-store') are the only values that proceed without
        // the flag. Anything else — 'unreadable' included — is treated as
        // unverified.
        const KNOWN_VERIFIED_REASONS: ReadonlySet<GraphVerificationReason> = new Set(['verified', 'no-store']);
        const reason = manifest.graphNodeCountReason;
        const count = manifest.graphNodeCount;
        // QA round 3 (2026-09-03) — the allowlist above trusts the `reason`
        // field on its own, but a manifest can claim an allowlisted reason
        // while its own `graphNodeCount` contradicts it: `backup.ts`'s doc
        // comment on this exact field says "'verified' cannot coexist with a
        // null count", and by the same logic 'no-store'/'unreadable' (no
        // store, or a store that could not be counted) can never legitimately
        // carry a real count. Either combination means the manifest is
        // internally inconsistent — torn, hand-edited, or from a future
        // schema this code doesn't understand — and trusting the reason
        // field alone in that state reopens the exact "archive holds an
        // empty/torn graph, restore reports success" failure mode this file
        // exists to prevent (the null `expectedGraphNodeCount` that a
        // 'verified'+null manifest produces skips the post-restore
        // node-count cross-check below entirely). Treat it the same as an
        // unrecognized reason: unverified, refused unless the caller opts in.
        const reasonCountInconsistent =
            (reason === 'verified' && (count === null || count === undefined))
            || ((reason === 'no-store' || reason === 'unreadable') && typeof count === 'number');
        const sourceUnverified = (reason !== undefined && !KNOWN_VERIFIED_REASONS.has(reason)) || reasonCountInconsistent;
        if (sourceUnverified && !spec.allowUnverifiedSource) {
            const reasonDetail = reasonCountInconsistent
                ? `its manifest is internally inconsistent — graphNodeCountReason is ${JSON.stringify(reason)} but `
                  + `graphNodeCount is ${JSON.stringify(count ?? null)}, and those two fields cannot both be true`
                : reason === 'unreadable'
                ? 'the source store could not be opened at backup time (see that backup\'s own warnings)'
                : `its manifest records an unrecognized graphNodeCountReason (${JSON.stringify(reason)}) — `
                  + 'not one of the known verified states, so it is treated the same as an unreadable source';
            throw new Error(
                `refusing to restore: this archive's graph was NEVER CONFIRMED READABLE when it was `
                + `backed up — ${reasonDetail}, so this archive may hold an empty or torn graph with `
                + `nothing recorded to check the restore against. Pass allowUnverifiedSource (CLI: `
                + '--allow-unverified) if you accept that risk.',
            );
        }

        // Engine-mismatch guard. The archive records which graph substrate its
        // files actually ARE; the destination's workspaces.json records which
        // one the daemon will open. Restoring an archive tagged with one graph
        // engine into a workspace registered for a different one produced a
        // workspace whose registry and `.lore/` disagreed — the daemon then opens an engine whose store is
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

        const destLore = path.join(spec.workspaceDir, '.lore');

        // A SurrealDB store that was closed MOMENTS ago is still being
        // written: `db.close()` frees the engine handle without awaiting
        // surrealkv's WAL→sstable flush, which lands ~10-25 ms later and
        // writes by the on-disk path it captured at open. Rename that path
        // aside now and the flush hits whatever we put there instead —
        // unlinking the restored store's `wal/…0.wal` (same filename in every
        // fresh store) and leaving a manifest that references no sstables.
        // The restore then reports success over an EMPTY graph. Measured 8/8
        // on this machine, with and without a space in the path.
        //
        // So: wait for both candidate destinations to stop changing before
        // touching either. Bounded and best-effort — a store that will not
        // settle makes this slower, never fatal. `SurrealGraph.close()` does
        // the same on its own side; this covers the case where the writer was
        // a DIFFERENT process whose close we never awaited.
        for (const storeDir of new Set([
            path.join(destLore, 'surreal'),
            surrealDataPath(spec.workspaceDir),
        ])) {
            if (fs.existsSync(storeDir)) {
                const settle = await settleSurrealStore(storeDir);
                if (!settle.settled) {
                    warnings.push(
                        `pre-restore settle: destination graph store at ${storeDir} did not settle within `
                        + `${settle.waitedMs}ms (outcome=${settle.outcome}) — proceeding anyway`,
                    );
                }
            }
        }

        // Sideline the existing .lore/ if any.
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

        // ── Read the restored graph back through a real engine open ────────
        //
        // Everything above this line proves BYTES arrived. None of it proves
        // the daemon will be able to READ them: the failure this whole file
        // now guards against (a deferred flush from a store closed moments
        // earlier unlinking the restored WAL) leaves a structurally valid
        // directory that opens cleanly and holds nothing. A catalog check
        // cannot see that, because the catalog matched — at extract time.
        //
        // So open the store where the daemon will actually look
        // (`surrealDataPath(workspaceDir)`, which is the relocated path on a
        // workspace whose path has a reserved character) and count. Fail LOUD
        // on an unreadable store or a count that disagrees with the archive:
        // a restore that silently hands back an empty workspace is the exact
        // outcome this is here to make impossible.
        const expectedGraphNodeCount = typeof manifest.graphNodeCount === 'number'
            ? manifest.graphNodeCount
            : null;
        const expectedGraphNodeCountReason = manifest.graphNodeCountReason;
        let restoredGraphNodeCount: number | null = null;
        const restoredStoreDir = surrealDataPath(spec.workspaceDir);
        if (looksLikeSurrealStore(restoredStoreDir)) {
            const rollbackHint = sidelinedPriorTo
                ? ` The prior state is intact at ${sidelinedPriorTo}.`
                : '';
            const probe = await probeSurrealStore(spec.workspaceDir);
            if (!probe.readable) {
                throw new Error(
                    `restore verification failed: the restored SurrealDB store at ${restoredStoreDir} `
                    + `could not be read back (${probe.detail}). The archive extracted and matched its `
                    + `catalog, so the bytes arrived — the store itself is unusable.${rollbackHint}`,
                );
            }
            restoredGraphNodeCount = probe.nodeCount;
            if (expectedGraphNodeCount !== null && probe.nodeCount !== expectedGraphNodeCount) {
                throw new Error(
                    `restore verification failed: the restored graph holds ${probe.nodeCount} node(s) but `
                    + `the archive recorded ${expectedGraphNodeCount}. The store at ${restoredStoreDir} lost `
                    + `data between extract and open — the usual cause is another writer (a running daemon, `
                    + `or a store closed moments before this restore) still flushing into that path.`
                    + rollbackHint,
                );
            }
            // QA round 3 (2026-09-03) — `graphNodeCountReason: 'no-store'` is
            // internally consistent with `graphNodeCount: null` (nothing
            // above catches it), but a manifest saying "no store existed"
            // while a real, readable SurrealDB store actually landed on disk
            // means the manifest's own record of this archive's contents
            // does not match what it actually contains. Not fatal — no data
            // was lost, and refusing here would throw away a real restore
            // over a stale/wrong label — but an operator relying on that
            // field (e.g. to decide whether a workspace needs re-seeding)
            // deserves to know it lied.
            if (expectedGraphNodeCountReason === 'no-store') {
                warnings.push(
                    `manifest claimed graphNodeCountReason: 'no-store' (no SurrealDB store existed at backup `
                    + `time), but the restored workspace has a real, readable store with ${probe.nodeCount} `
                    + `node(s) — the manifest's reason field does not match this archive's actual contents.`,
                );
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
            restoredGraphNodeCount,
            expectedGraphNodeCount,
            expectedGraphNodeCountReason,
            warnings,
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

/**
 * Read just `backup-manifest.json` out of a tarball, without staging the
 * rest of the archive to disk — `lore restore --all` uses this to learn
 * which workspace each archive belongs to before doing anything else. Only
 * ever asks tar to print one fixed, non-attacker-controlled member name to
 * stdout, so this needs none of `assertSafeTarMembers`'s tar-slip guard
 * (nothing is extracted to disk here).
 *
 * Returns null if the tarball has no `backup-manifest.json` member, can't be
 * listed, or isn't valid JSON — callers treat that identically to "this
 * archive has no recorded workspace name".
 */
export async function peekArchiveManifest(tarballPath: string): Promise<{ workspace?: string } | null> {
    try {
        const content = await new Promise<string>((resolve, reject) => {
            const proc = spawn('tar', ['-x', '-z', '-O', '-f', tarballPath, 'backup-manifest.json']);
            const out: Buffer[] = [];
            proc.stdout.on('data', (d: Buffer) => out.push(d));
            proc.on('error', reject);
            proc.on('exit', (code) => {
                if (code === 0) { resolve(Buffer.concat(out).toString('utf8')); return; }
                reject(new Error(`tar exited with code ${code}`));
            });
        });
        return JSON.parse(content) as { workspace?: string };
    } catch {
        return null;
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
