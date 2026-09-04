/**
 * cli/commands/backup.ts — `lore backup` CLI (Sprint C2 + arch gap #12).
 *
 * Usage:
 *   lore backup                                  # active workspace, ./backups/
 *   lore backup --workspace developer            # explicit workspace
 *   lore backup --all                            # every known workspace
 *   lore backup --out /tmp/backups               # explicit output dir
 *   lore backup --keep 14                        # rotation (default 7)
 *
 * Produces .tar.gz files under --out containing a coordinated
 * snapshot of all three substrates for the workspace (graph,
 * SQLite tables, LanceDB vectors) plus sidecar state. With --all the
 * workspaces.json registry file is also copied into the output dir
 * so a full restore can rebuild the registry alongside the workspace
 * tarballs.
 *
 * Retention:
 *   After a successful backup, prunes oldest tarballs for the same
 *   workspace beyond --keep (defaults to env LORE_BACKUP_KEEP=7).
 *   Pruning is per-workspace (we don't accidentally delete another
 *   workspace's tarballs sharing the same out-dir).
 *
 * Daemon preflight:
 *   Refuses while the local daemon answers `/api/health`, unless `--force`.
 *   Backup reads the graph store back through a real engine open to prove the
 *   copy is not empty, and that open needs the directory lock the daemon
 *   holds. Without the gate the verification silently degrades to a warning
 *   on exactly the machines where an operator most wants it. Same gate
 *   `lore maintain` and `lore compact` already use.
 *
 *   `isDaemonUp()` alone misses a daemon on a non-default port with
 *   `LORE_PORT` unset (it only probes one port). So each workspace ALSO gets
 *   a direct `probeSurrealLock()` — the same on-disk lock probe `lore
 *   restore` already uses — right before its graph is opened for
 *   verification. Port-independent: it opens the store itself rather than
 *   asking an HTTP health endpoint.
 *
 * Verification, and what happens when it can't run:
 *   A backup whose graph could not be read back (`graphNodeCountReason ===
 *   'unreadable'`) still writes its tarball — the other substrates may be
 *   fine — but is NOT a silent success: its warnings print to stderr and the
 *   command exits non-zero, unless `--allow-unverified` is passed.
 *
 * Exits 0 on success; prints the tarball path(s) + sizes on stdout.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { backupWorkspace } from '../../engines/backup.js';
import { probeSurrealLock } from '../../engines/surreal/surrealSettle.js';
import { loadWorkspaces, getActiveWorkspaceName } from '../../config/workspaces.js';
import { loreHome } from '../../config/loreHome.js';
import { isDaemonServingHome, daemonRefuseMessage } from './migrateWorkspaceToWorkspaceShared.js';

interface Flags {
    workspace?: string;
    all?: boolean;
    outDir?: string;
    keep?: number;
    force?: boolean;
    allowUnverified?: boolean;
}

function parseFlags(args: string[]): Flags {
    const out: Flags = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--workspace' && i + 1 < args.length) out.workspace = args[++i];
        else if (a === '--all') out.all = true;
        else if (a === '--out' && i + 1 < args.length) out.outDir = args[++i];
        else if (a === '--keep' && i + 1 < args.length) {
            const n = Number(args[++i]);
            if (!Number.isFinite(n) || n < 1) {
                console.error(`--keep must be a positive integer; got "${args[i]}"`);
                process.exit(1);
            }
            out.keep = Math.floor(n);
        } else if (a === '--force') out.force = true;
        else if (a === '--allow-unverified') out.allowUnverified = true;
        else if (a === '--help' || a === '-h') {
            console.log(
                `Usage: lore backup [--workspace <name>|--all] [--out <dir>] [--keep <n>] [--force]\n` +
                `                   [--allow-unverified]\n` +
                `  Coordinated snapshot of one or all workspaces' three substrates\n` +
                `  (graph engine + SQLite + LanceDB) plus sidecar state, packaged as .tar.gz\n` +
                `  under --out. Retention: keeps N most recent per workspace (default\n` +
                `  LORE_BACKUP_KEEP=7).\n` +
                `  Refuses while the daemon is running, or while the workspace's graph\n` +
                `  store is otherwise locked (checked directly, not just via the daemon's\n` +
                `  health port); --force bypasses both.\n` +
                `  A backup whose graph could not be verified exits non-zero unless\n` +
                `  --allow-unverified accepts that risk explicitly.\n` +
                `  Defaults: --workspace=active, --out=./backups, --keep=$LORE_BACKUP_KEEP||7\n`,
            );
            process.exit(0);
        }
    }
    return out;
}

function defaultKeep(): number {
    const raw = process.env.LORE_BACKUP_KEEP?.trim();
    if (!raw) return 7;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 7;
}

/**
 * Prune older tarballs for a single workspace down to `keep` count.
 * Matches the naming convention `lore-backup-<workspace>-<iso>.tar.gz`.
 * Returns the list of pruned absolute paths.
 */
export function pruneOldBackups(outDir: string, workspaceName: string, keep: number): string[] {
    if (!fs.existsSync(outDir)) return [];
    const prefix = `lore-backup-${workspaceName}-`;
    const entries = fs.readdirSync(outDir)
        .filter(name => name.startsWith(prefix) && name.endsWith('.tar.gz'))
        .map(name => ({
            name,
            mtime: fs.statSync(path.join(outDir, name)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime); // newest first
    const stale = entries.slice(keep);
    const pruned: string[] = [];
    for (const e of stale) {
        const p = path.join(outDir, e.name);
        try {
            fs.unlinkSync(p);
            pruned.push(p);
        } catch {
            // Best-effort; skip on permission/locked errors.
        }
    }
    return pruned;
}

function snapshotWorkspacesJson(outDir: string): string | null {
    const src = path.join(loreHome(), 'workspaces.json');
    if (!fs.existsSync(src)) return null;
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = path.join(outDir, `workspaces-${iso}.json`);
    fs.copyFileSync(src, dst);
    return dst;
}

async function backupOne(
    wsName: string, outDir: string, keep: number, force: boolean, allowUnverified: boolean,
): Promise<void> {
    const wsFile = loadWorkspaces();
    const entry = wsFile.workspaces.find(w => w.name === wsName);
    if (!entry) {
        console.error(`No workspace named '${wsName}'. Known: ${wsFile.workspaces.map(w => w.name).join(', ')}`);
        process.exit(1);
    }

    // Direct, port-independent fallback to the daemon-health preflight above:
    // see this file's header. Probes the workspace's OWN graph store lock
    // rather than an HTTP endpoint, so a daemon on a non-default port with
    // LORE_PORT unset — invisible to isDaemonUp() — is still caught here.
    if (!force) {
        const lock = await probeSurrealLock(entry.path);
        if (!lock.free) {
            console.error(`lore backup: the graph store for workspace '${wsName}' (${entry.path}) is locked by another process.`);
            console.error(`  detail: ${lock.detail}`);
            console.error('');
            console.error('While something else holds it, backup cannot read the copy back to prove it');
            console.error('captured the graph — it would only prove bytes were copied. Stop whatever holds');
            console.error('it and retry, or pass --force if you are CERTAIN nothing is writing to this workspace.');
            process.exit(1);
            return;
        }
    }

    console.log(`→ Backing up workspace '${wsName}' from ${entry.path}`);
    const result = await backupWorkspace({
        workspaceDir: entry.path,
        workspaceName: wsName,
        outDir,
    });
    const mb = (result.bytesWritten / 1024 / 1024).toFixed(1);
    const sec = (result.durationMs / 1000).toFixed(1);
    console.log(`✓ ${result.tarballPath}`);
    console.log(`  ${mb} MB · ${result.files.length} file(s) · ${sec}s`);
    if (result.graphNodeCount !== null) {
        console.log(`  Graph verified: ${result.graphNodeCount} node(s) readable from the copy`);
    }
    for (const w of result.warnings) {
        console.error(`  ! ${w}`);
    }

    // C2 rotation: prune older tarballs for this workspace beyond `keep`.
    const pruned = pruneOldBackups(outDir, wsName, keep);
    if (pruned.length > 0) {
        console.log(`  rotated: pruned ${pruned.length} older tarball(s) beyond keep=${keep}`);
    }

    // The tarball is on disk either way — the substrates that DID verify are
    // real — but an unverified graph must never look like a clean success:
    // an operator (or a cron job checking the exit code) needs to know this
    // backup's graph contents are unconfirmed.
    if (result.graphNodeCountReason === 'unreadable' && !allowUnverified) {
        throw new Error(
            `workspace '${wsName}': graph could not be verified — ${result.tarballPath} was written, but `
            + 'its graph contents are UNCONFIRMED (see the warning(s) above). Pass --allow-unverified to '
            + 'accept an unverified backup, or fix the lock holder and retake it.',
        );
    }
}

export async function backupCommand(args: string[]): Promise<void> {
    const flags = parseFlags(args);

    // Preflight: see this file's header. A running daemon holds the graph
    // store's directory lock, so the read-back that proves the copy is not
    // empty cannot run — and a backup that cannot make that claim is the kind
    // an operator discovers is empty during a restore.
    // Round E2, 2026-09-03 — isDaemonUp() alone refused whenever ANY
    // process answered 200 on the port, never checking it served THIS
    // home; isDaemonServingHome() only reports true when the daemon's own
    // Bearer-authenticated /api/health confirms it.
    if (!flags.force && (await isDaemonServingHome(loreHome())).servesHome) {
        console.error(daemonRefuseMessage('lore backup'));
        console.error('While the daemon holds the graph store, backup cannot read the copy back');
        console.error('to prove it captured the graph — it would only prove bytes were copied.');
        process.exit(1);
        return;
    }

    const outDir = path.resolve(flags.outDir ?? path.join(process.cwd(), 'backups'));
    fs.mkdirSync(outDir, { recursive: true });
    const keep = flags.keep ?? defaultKeep();
    console.log(`  Output dir: ${outDir} · keep=${keep}`);

    if (flags.all) {
        // Snapshot workspaces.json first so a restore can rebuild the
        // registry. Per-workspace tarballs are independent — partial
        // failure on one workspace doesn't abort the rest.
        const wsFile = loadWorkspaces();
        const snap = snapshotWorkspacesJson(outDir);
        if (snap) console.log(`  workspaces.json snapshot: ${snap}`);
        let failed = 0;
        for (const w of wsFile.workspaces) {
            try {
                await backupOne(w.name, outDir, keep, flags.force ?? false, flags.allowUnverified ?? false);
            } catch (err) {
                failed++;
                console.error(`  ✗ workspace '${w.name}': ${(err as Error).message}`);
            }
        }
        if (failed > 0) {
            console.error(`Done with ${failed} failure(s).`);
            process.exit(2);
        }
        return;
    }

    const wsName = flags.workspace ?? getActiveWorkspaceName();
    await backupOne(wsName, outDir, keep, flags.force ?? false, flags.allowUnverified ?? false);
}
