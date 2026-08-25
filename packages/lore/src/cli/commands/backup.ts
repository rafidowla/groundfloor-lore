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
 * snapshot of all three substrates for the workspace (Kùzu graph,
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
 * Exits 0 on success; prints the tarball path(s) + sizes on stdout.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { backupWorkspace } from '../../engines/backup.js';
import { loadWorkspaces, getActiveWorkspaceName } from '../../config/workspaces.js';
import { loreHome } from '../../config/loreHome.js';

interface Flags {
    workspace?: string;
    all?: boolean;
    outDir?: string;
    keep?: number;
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
        } else if (a === '--help' || a === '-h') {
            console.log(
                `Usage: lore backup [--workspace <name>|--all] [--out <dir>] [--keep <n>]\n` +
                `  Coordinated snapshot of one or all workspaces' three substrates\n` +
                `  (Kùzu + SQLite + LanceDB) plus sidecar state, packaged as .tar.gz\n` +
                `  under --out. Retention: keeps N most recent per workspace (default\n` +
                `  LORE_BACKUP_KEEP=7).\n` +
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

async function backupOne(wsName: string, outDir: string, keep: number): Promise<void> {
    const wsFile = loadWorkspaces();
    const entry = wsFile.workspaces.find(w => w.name === wsName);
    if (!entry) {
        console.error(`No workspace named '${wsName}'. Known: ${wsFile.workspaces.map(w => w.name).join(', ')}`);
        process.exit(1);
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

    // C2 rotation: prune older tarballs for this workspace beyond `keep`.
    const pruned = pruneOldBackups(outDir, wsName, keep);
    if (pruned.length > 0) {
        console.log(`  rotated: pruned ${pruned.length} older tarball(s) beyond keep=${keep}`);
    }
}

export async function backupCommand(args: string[]): Promise<void> {
    const flags = parseFlags(args);
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
                await backupOne(w.name, outDir, keep);
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
    await backupOne(wsName, outDir, keep);
}
