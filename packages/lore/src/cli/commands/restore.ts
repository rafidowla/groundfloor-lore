/**
 * cli/commands/restore.ts — `lore restore` CLI.
 *
 * Usage:
 *   lore restore <tarball> [--workspace <name>]
 *   lore restore --all <dir>
 *
 * Counterpart to `lore backup`. Extracts the tarball into the target
 * workspace's .lore/ directory. If the workspace already has a
 * .lore/, it's sidelined to .lore.pre-restore-<iso> (rollback path).
 *
 * Does NOT start the daemon. Operator restarts after restore; the
 * consistency sweeper picks up any drift on the next pass.
 *
 * Preflight (both bypassable with `--force`, tests / one-shots only):
 *   - refuses while the local daemon answers `/api/health`, and
 *   - refuses when the destination's SurrealDB store is locked by anyone.
 * Restore renames the destination store aside and drops the archived one at
 * the same path milliseconds later. A second writer holding that path — a
 * daemon, a forgotten CLI handle — keeps flushing into it and unlinks the
 * restored store's WAL, leaving an empty graph that reports success. Same
 * failure the in-process settle now prevents; this is the cross-process half.
 *
 * A third case refuses independent of both preflights above: the archive's
 * OWN manifest can say its source graph was never confirmed readable when it
 * was backed up (locked at backup time, same failure this file's preflight
 * exists to prevent, just one step earlier). Restoring that archive is
 * refused unless `--allow-unverified` — it may hold an empty or torn graph
 * with no recorded count to check the restore against.
 *
 * A fourth case: the archive's manifest can name a DIFFERENT workspace than
 * the one being restored into (a copy-pasted tarball path, a stale
 * `--workspace` flag). Refused unless `--allow-name-mismatch` — see
 * `engines/restore.ts`'s workspace-name guard.
 *
 * `--all <dir>` restores every `lore-backup-*.tar.gz` in `dir`, each into the
 * workspace its OWN manifest names, reusing the exact single-archive path
 * (and every guard above) per archive.
 *
 * Exits 0 on success; prints the sidelined-prior path so the
 * operator knows where the old state went.
 */

import * as fs from 'node:fs';
import { resolveWorkspaceGraphEngine } from '../../engines/graphEngineSelector.js';
import * as path from 'node:path';

import { restoreWorkspace, peekArchiveManifest } from '../../engines/restore.js';
import { probeSurrealLock } from '../../engines/surreal/surrealSettle.js';
import { loadWorkspaces, getActiveWorkspaceName } from '../../config/workspaces.js';
import { loreHome } from '../../config/loreHome.js';
import { isDaemonServingHome, daemonRefuseMessage } from './migrateWorkspaceToWorkspaceShared.js';

interface Flags {
    workspace?: string;
    tarball?: string;
    force?: boolean;
    allowUnverified?: boolean;
    allowNameMismatch?: boolean;
    all?: string;
}

function parseFlags(args: string[]): Flags {
    const out: Flags = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--workspace' && i + 1 < args.length) out.workspace = args[++i];
        else if (a === '--force') out.force = true;
        else if (a === '--allow-unverified') out.allowUnverified = true;
        else if (a === '--allow-name-mismatch') out.allowNameMismatch = true;
        else if (a === '--all' && i + 1 < args.length) out.all = args[++i];
        else if (a === '--help' || a === '-h') {
            console.log(
                `Usage: lore restore <tarball> [--workspace <name>] [--force] [--allow-unverified] [--allow-name-mismatch]\n` +
                `       lore restore --all <dir> [--force] [--allow-unverified] [--allow-name-mismatch]\n` +
                `  Restore a workspace from a backup tarball. Sidelines\n` +
                `  any existing .lore/ to .lore.pre-restore-<iso> as a\n` +
                `  rollback path. Operator restarts the daemon after.\n` +
                `  Refuses while the daemon is running or the destination\n` +
                `  graph store is locked; --force bypasses both (tests only).\n` +
                `  Refuses an archive whose own graph was never confirmed\n` +
                `  readable at backup time; --allow-unverified accepts that risk.\n` +
                `  Refuses an archive whose manifest names a DIFFERENT workspace\n` +
                `  than the one you are restoring into; --allow-name-mismatch\n` +
                `  accepts that risk.\n` +
                `  --all <dir> restores every lore-backup-*.tar.gz found in <dir>,\n` +
                `  each into the workspace named in ITS OWN manifest (archives with\n` +
                `  no recorded workspace name are skipped and reported).\n`,
            );
            process.exit(0);
        } else if (!a.startsWith('--') && !out.tarball) {
            out.tarball = a;
        }
    }
    return out;
}

export async function restoreCommand(args: string[]): Promise<void> {
    const flags = parseFlags(args);
    if (flags.all) {
        await restoreAll(flags.all, flags);
        return;
    }
    if (!flags.tarball) {
        console.error('Usage: lore restore <tarball> [--workspace <name>]');
        process.exit(1);
        return;
    }
    const wsName = flags.workspace ?? getActiveWorkspaceName();
    const ok = await restoreOneWorkspace(path.resolve(flags.tarball), wsName, flags);
    if (!ok) {
        process.exit(1);
    }
}

/**
 * `lore restore --all <dir>` — apply `restoreOneWorkspace` (the single-archive
 * path, with every guard it runs: daemon, lock, unverified-source, name-
 * mismatch) to every `lore-backup-*.tar.gz` in `dir`, each into the workspace
 * ITS OWN manifest names via `peekArchiveManifest`. An archive with no
 * recorded `workspace` field (pre-3.19) cannot be routed anywhere safely, so
 * it is skipped and reported rather than guessed at (e.g. onto the active
 * workspace). One archive failing does not stop the rest — same
 * independent-per-item contract as `lore backup --all` — but the command
 * exits non-zero if anything failed or was skipped.
 */
async function restoreAll(dir: string, flags: Flags): Promise<void> {
    const resolvedDir = path.resolve(dir);
    if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
        console.error(`lore restore --all: not a directory: ${resolvedDir}`);
        process.exit(1);
        return;
    }
    const archives = fs.readdirSync(resolvedDir)
        .filter((f) => /^lore-backup-.*\.tar\.gz$/.test(f))
        .sort();
    if (archives.length === 0) {
        console.log(`No lore-backup-*.tar.gz archives found in ${resolvedDir}`);
        return;
    }

    let anyFailed = false;
    for (const file of archives) {
        const tarballPath = path.join(resolvedDir, file);
        const manifest = await peekArchiveManifest(tarballPath);
        const wsName = manifest?.workspace;
        if (!wsName) {
            console.error(`  skip ${file}: archive has no recorded workspace name in its manifest`);
            anyFailed = true;
            continue;
        }
        console.log(`→ ${file} → workspace '${wsName}'`);
        try {
            const ok = await restoreOneWorkspace(tarballPath, wsName, flags);
            if (!ok) anyFailed = true;
        } catch (err) {
            console.error(`[lore] Fatal error restoring ${file}: ${(err as Error).message}`);
            anyFailed = true;
        }
    }
    if (anyFailed) {
        process.exit(1);
    }
}

/**
 * The single-archive restore path — everything `lore restore <tarball>
 * --workspace <name>` does. Factored out of `restoreCommand` so `restoreAll`
 * above can apply the exact same guards to each archive it restores, one
 * workspace at a time, instead of re-implementing them.
 *
 * Returns `false` (after printing the reason) for a handled preflight
 * failure — the caller decides what that means: `process.exit(1)` for a
 * single-archive invocation, or "log it and keep going" for `--all`.
 * `restoreWorkspace`'s own thrown errors (integrity, unverified-source,
 * engine/name mismatch, …) are left to propagate uncaught, same as before
 * this was factored out — the single-archive caller relies on the top-level
 * `main().catch` in cli/index.ts for that; `restoreAll` wraps this call in
 * its own try/catch instead.
 */
async function restoreOneWorkspace(tarballPath: string, wsName: string, flags: Flags): Promise<boolean> {
    const wsFile = loadWorkspaces();
    const entry = wsFile.workspaces.find(w => w.name === wsName);
    if (!entry) {
        console.error(`No workspace named '${wsName}'. Known: ${wsFile.workspaces.map(w => w.name).join(', ')}`);
        return false;
    }
    if (!fs.existsSync(entry.path)) {
        console.error(`Workspace dir does not exist: ${entry.path}`);
        return false;
    }

    // Preflight: a second writer on the destination store turns a restore
    // into silent data loss (see this file's header). Same gate `lore maintain`
    // and `lore compact` already use, plus a direct lock probe for the case
    // where the holder is not the daemon.
    if (!flags.force) {
        // Round E2, 2026-09-03 — isDaemonUp() alone refused whenever ANY
        // process answered 200 on the port, never checking it served THIS
        // home; isDaemonServingHome() only reports true when the daemon's
        // own Bearer-authenticated /api/health confirms it.
        if ((await isDaemonServingHome(loreHome())).servesHome) {
            console.error(daemonRefuseMessage('lore restore'));
            console.error('A running daemon holds the destination graph store; restoring under it');
            console.error('leaves an empty graph that reports success.');
            return false;
        }
        const lock = await probeSurrealLock(entry.path);
        if (!lock.free) {
            console.error(`lore restore: the destination graph store is locked by another process.`);
            console.error(`  workspace: ${wsName} (${entry.path})`);
            console.error(`  detail: ${lock.detail}`);
            console.error('');
            console.error('Restoring over a store someone else holds loses the restored data: the');
            console.error('other writer keeps flushing into that path and unlinks what was put there.');
            console.error('Stop whatever holds it and retry, or pass --force if you are CERTAIN');
            console.error('nothing is writing to this workspace.');
            return false;
        }
    }

    console.log(`→ Restoring '${path.basename(tarballPath)}' into workspace '${wsName}' (${entry.path})`);

    const result = await restoreWorkspace({
        tarballPath,
        workspaceDir: entry.path,
        // From the registry, so a cross-engine restore is refused rather than
        // leaving workspaces.json and .lore/ disagreeing.
        expectedEngine: resolveWorkspaceGraphEngine(wsName),
        allowUnverifiedSource: flags.allowUnverified ?? false,
        // So a cross-workspace restore (wrong tarball, stale --workspace
        // flag) is refused rather than landing silently — see
        // engines/restore.ts's workspace-name guard.
        targetWorkspaceName: wsName,
        allowNameMismatch: flags.allowNameMismatch ?? false,
    });

    for (const w of result.warnings) {
        console.error(`  ! ${w}`);
    }

    const mb = (result.bytesRestored / 1024 / 1024).toFixed(1);
    const sec = (result.durationMs / 1000).toFixed(1);
    console.log(`✓ Restored ${mb} MB · ${result.files.length} file(s) · ${sec}s`);
    if (result.restoredGraphNodeCount !== null) {
        // Read back through a real engine open, not counted from the archive —
        // this is the line that says the graph is actually readable.
        //
        // A null expectedGraphNodeCount is NOT one thing: a pre-3.18 archive
        // simply predates the field (benign — nothing was ever recorded to
        // compare against), `graphNodeCountReason === 'unreadable'` means
        // the source graph EXISTED and backup could not confirm what it held
        // — this restore only got this far because --allow-unverified was
        // passed, and the count above has nothing behind it to have been
        // checked against — and `graphNodeCountReason === 'no-store'` means
        // the manifest recorded that NO store existed at backup time, which
        // is a claim, not an absence of the field: if a real, readable store
        // just got restored anyway, `restoreWorkspace` already pushed a
        // mismatch warning onto `result.warnings` (printed above) saying so.
        //
        // QA round 4, finding 4 — this used to fall through to the benign
        // "archive predates the recorded count" line for EVERY non-'unreadable'
        // reason, including 'no-store' — printing that right underneath a
        // warning that the manifest's 'no-store' claim was wrong is actively
        // misleading (it reads as "nothing to see here" directly under "this
        // lied"). Branch on the actual reason instead of collapsing
        // everything but 'unreadable' into the pre-field message.
        let expected: string;
        if (result.expectedGraphNodeCount !== null) {
            expected = '';
        } else if (result.expectedGraphNodeCountReason === 'unreadable') {
            expected = ' (UNVERIFIED SOURCE — the backup could not confirm this graph before it was ' +
                'archived; this count was never checked against anything)';
        } else if (result.expectedGraphNodeCountReason === 'no-store') {
            expected = ' (manifest recorded no store existed at backup time — see the warning above; ' +
                'nothing was checked against this count)';
        } else if (result.expectedGraphNodeCountReason === undefined) {
            expected = ' (archive predates the recorded count)';
        } else {
            // A reason string this CLI doesn't recognize (future schema,
            // corrupt manifest) — restoreWorkspace() only lets this through
            // at all via --allow-unverified, so say so rather than guessing.
            expected = ` (graphNodeCountReason ${JSON.stringify(result.expectedGraphNodeCountReason)} is not ` +
                'one of the known values — nothing was checked against this count)';
        }
        console.log(`  Graph verified: ${result.restoredGraphNodeCount} node(s) readable${expected}`);
    }
    if (result.sidelinedPriorTo) {
        console.log(`  Prior .lore/ moved to: ${result.sidelinedPriorTo}`);
        console.log(`  Remove it once you're confident the restore is good.`);
    }
    if (result.sidelinedPriorScatteredSurrealTo) {
        console.log(`  Prior SurrealDB store (outside .lore/) moved to: ${result.sidelinedPriorScatteredSurrealTo}`);
        console.log(`  Remove it once you're confident the restore is good.`);
    }
    console.log(`\nNext: restart the daemon to pick up the restored state.`);
    return true;
}
