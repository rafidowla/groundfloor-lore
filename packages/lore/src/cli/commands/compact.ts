/**
 * compact.ts — `lore compact <workspace>` CLI (Phase 6 P4).
 *
 * Reclaims disk space from tombstoned LanceDB rows by calling
 * `table.optimize({cleanupOlderThan})` on every table in the
 * workspace's `.lore/lancedb` directory.
 *
 * Refuses to run while the daemon is up — the daemon holds the
 * workspace's stores open, and a CLI compaction racing it risks corrupting
 * files mid-compact. Probes `http://127.0.0.1:<LORE_PORT||3847>/api/health`;
 * if it responds 200, we print the launchctl bootout command and exit.
 *
 * Flags:
 *   --lancedb        Run LanceDB compaction (the only step; default).
 *   --force          Bypass the daemon preflight (tests only).
 *
 * History: this command once had a `--kuzu` best-effort half (a no-op —
 * kuzu-lite had no public VACUUM). It was removed with the Kùzu engine
 * (2026-08-21); LanceDB compaction is the only step. The legacy `--kuzu`
 * and `--all` selectors are accepted and ignored.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWorkspacePath } from '../../config/workspaces.js';
import { isDaemonUp, daemonRefuseMessage } from './migrateWorkspaceToWorkspaceShared.js';

interface CompactReport {
    workspace: string;
    lancedb: {
        ran: boolean;
        tables: Array<{ name: string; beforeBytes: number; afterBytes: number }>;
        totalReclaimedBytes: number;
    };
}

function dirSizeBytes(p: string): number {
    if (!fs.existsSync(p)) return 0;
    let total = 0;
    const stack: string[] = [p];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const child = path.join(cur, entry.name);
            try {
                if (entry.isDirectory()) {
                    stack.push(child);
                } else if (entry.isFile() || entry.isSymbolicLink()) {
                    const st = fs.statSync(child);
                    total += st.size;
                }
            } catch { /* file vanished mid-walk; ignore */ }
        }
    }
    return total;
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export async function compactCommand(args: string[]): Promise<void> {
    if (!args[0] || args[0] === '--help' || args[0] === '-h') {
        console.log('Usage: lore compact <workspace> [--lancedb] [--force]');
        console.log('');
        console.log('Reclaims disk space from tombstoned LanceDB rows in the workspace.');
        console.log('Daemon must be down. --force bypasses the preflight (tests only).');
        return;
    }
    const workspace = args[0];
    const rest = args.slice(1);
    const force = rest.includes('--force');

    // Preflight — refuse if the daemon is up; it holds the workspace's
    // stores open and a mid-compact race could corrupt them.
    if (!force) {
        const daemonUp = await isDaemonUp();
        if (daemonUp) {
            console.error(daemonRefuseMessage('lore compact'));
            process.exit(1);
        }
    }

    let wsPath: string;
    try {
        wsPath = getWorkspacePath(workspace);
    } catch (err) {
        console.error(`Unknown workspace "${workspace}": ${(err as Error).message}`);
        process.exit(1);
        return;
    }
    const report: CompactReport = {
        workspace,
        lancedb: { ran: false, tables: [], totalReclaimedBytes: 0 },
    };

    const lancedbDir = path.join(wsPath, '.lore', 'lancedb');
    if (!fs.existsSync(lancedbDir)) {
        console.log(`No lancedb dir at ${lancedbDir} — skipping.`);
    } else {
        report.lancedb.ran = true;
        const lancedb = await import('@lancedb/lancedb');
        const db = await lancedb.connect(lancedbDir);
        const tableNames = await db.tableNames();
        for (const name of tableNames) {
            // Per-table footprint inferred from on-disk directory.
            // LanceDB stores each table under `<lancedbDir>/<name>.lance/`.
            const tableDir = path.join(lancedbDir, `${name}.lance`);
            const beforeBytes = dirSizeBytes(tableDir);
            const table = await db.openTable(name);
            try {
                // cleanupOlderThan: pass a Date pointing at "now" so
                // every tombstoned file becomes eligible. Defaults to
                // 7 days, which is too conservative when an operator
                // explicitly asks to reclaim space.
                await table.optimize({ cleanupOlderThan: new Date() });
            } catch (err) {
                console.error(`  ${name}: optimize failed — ${(err as Error).message}`);
                continue;
            }
            const afterBytes = dirSizeBytes(tableDir);
            report.lancedb.tables.push({ name, beforeBytes, afterBytes });
            report.lancedb.totalReclaimedBytes += Math.max(0, beforeBytes - afterBytes);
            console.log(`  lancedb/${name}: ${fmtBytes(beforeBytes)} → ${fmtBytes(afterBytes)} (reclaimed ${fmtBytes(Math.max(0, beforeBytes - afterBytes))})`);
        }
        console.log(`  lancedb total reclaimed: ${fmtBytes(report.lancedb.totalReclaimedBytes)}`);
    }

    console.log('');
    console.log('Compaction complete.');
}
