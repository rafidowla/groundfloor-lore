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
 * that engine's native binding had no public VACUUM). It was removed along
 * with that engine (2026-08-21); LanceDB compaction is the only step. The
 * legacy `--kuzu` and `--all` selectors are accepted and ignored.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWorkspacePath } from '../../config/workspaces.js';
import { loreHome } from '../../config/loreHome.js';
import { isDaemonServingHome, daemonRefuseMessage, otherDaemonRefuseMessage } from './migrateWorkspaceToWorkspaceShared.js';
import { probeSurrealLock } from '../../engines/surreal/surrealSettle.js';
import { surrealDataPath } from '../../engines/surreal/surrealConnection.js';
import { retryOptimizeOnConflict } from '../../engines/maintain/adapters.js';

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

    let wsPath: string;
    try {
        wsPath = getWorkspacePath(workspace);
    } catch (err) {
        console.error(`Unknown workspace "${workspace}": ${(err as Error).message}`);
        process.exit(1);
        return;
    }

    // Preflight — refuse if the daemon is up; it holds the workspace's
    // stores open and a mid-compact race could corrupt them.
    if (force) {
        // Round E4, 2026-09-03 (finding, low) — --force silently skipped
        // every check below with no signal at the moment it actually did
        // so; the only warning text lived in the refusal messages below,
        // which an operator who already passed --force up front never
        // sees. Print the bypass itself.
        console.error('proceeding with --force; daemon/lock checks skipped');
    } else {
        // Round E2, 2026-09-03 — isDaemonUp() alone refused whenever ANY
        // process answered 200 on the port, never checking it served THIS
        // home; isDaemonServingHome() only reports true when the daemon's
        // own Bearer-authenticated /api/health confirms it.
        const probe = await isDaemonServingHome(loreHome());
        if (probe.servesHome) {
            console.error(daemonRefuseMessage('lore compact'));
            process.exit(1);
        }
        // Round E3, 2026-09-03 (finding, high) — `servesHome: false` used to
        // be treated as "safe to proceed" outright, including when it was
        // false only because a stale/rejected CLI token made the preflight
        // unable to confirm a LIVE same-home daemon. Reproduced with real
        // LanceDB corruption: a stale token → servesHome:false →
        // table.optimize() ran straight into a table the daemon was
        // concurrently writing to. `otherDaemonReachable` is "not proven
        // ours", not "proven safe" — refuse unless the operator overrides.
        if (probe.otherDaemonReachable) {
            console.error(otherDaemonRefuseMessage('lore compact'));
            process.exit(1);
        }

        // Second layer, regardless of the port probe's outcome above: this
        // command never opens the graph store itself, so unlike
        // openGraphForCli's 18 callers it never falls through to a real
        // on-disk lock attempt as a fallback safety net. A daemon holds a
        // workspace's SurrealDB graph store open whenever it holds ANY of
        // that workspace's substrates open (including LanceDB), so probing
        // the graph store's own lock catches a holder the HTTP probe missed
        // entirely (wrong port, timed-out probe, no `auth.token` to send).
        //
        // Round E4, 2026-09-03 (finding, high) — probeSurrealLock's own doc
        // comment says an ABSENT store directory reports `free: true` BY
        // DESIGN (probing would CREATE the store, wrong for a restore
        // destination) — but that same fast path made a workspace whose
        // LanceDB tables were populated by something that never touched the
        // graph store (bypassing the daemon's routing, which resolves the
        // graph handle before every LanceDB write) indistinguishable from
        // "nothing here at all". With no graph store to probe, this CLI has
        // no way to prove nothing else is writing to lancedb/ — and there is
        // no LanceDB-native lock to fall back on — so refuse rather than
        // assume safety.
        if (!fs.existsSync(surrealDataPath(wsPath))) {
            console.error(`lore compact: no graph store to probe for workspace "${workspace}" (${wsPath}); cannot verify nothing else is writing to lancedb/.`);
            console.error('Pass --force if you are CERTAIN nothing else is writing to this workspace.');
            process.exit(1);
        }
        const lock = await probeSurrealLock(wsPath);
        if (!lock.free) {
            console.error(`lore compact: the graph store for workspace "${workspace}" (${wsPath}) is locked by another process.`);
            console.error(`  detail: ${lock.detail}`);
            console.error('');
            console.error('While something else holds it, compacting LanceDB risks racing a live writer on the same');
            console.error('workspace and corrupting it. Stop whatever holds it and retry, or pass --force if you are');
            console.error('CERTAIN nothing is writing to this workspace.');
            process.exit(1);
        }
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
                //
                // retryOptimizeOnConflict (round E3, 2026-09-03): the same
                // LanceDB-native retry `lore maintain`'s LanceMaintainer
                // already uses — a benign "retryable commit conflict" /
                // "transaction was preempted" from a genuine concurrent
                // writer gets a bounded checkoutLatest()+retry instead of
                // failing outright on the first overlap. It does NOT paper
                // over the corruption case the lock probe above exists to
                // prevent (e.g. a "Not Found: …_deletions/….arrow" from a
                // file removed mid-optimize is not in its retryable set —
                // see isRetryableLanceConflict).
                await retryOptimizeOnConflict(table, { cleanupOlderThan: new Date() });
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
