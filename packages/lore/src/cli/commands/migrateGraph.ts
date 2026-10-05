/**
 * cli/commands/migrateGraph.ts — `lore migrate-graph <workspace> --to sqlite
 * [--rollback]` (3.21 step 1e). Thin CLI wrapper over
 * `engines/migrateGraphToSqlite.ts` — see that file for the actual
 * migration steps and their ordering guarantees.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { loreHome, loreHomePath } from '../../config/loreHome.js';
import { migrateGraphToSqlite, rollbackGraphMigration } from '../../engines/migrateGraphToSqlite.js';

/**
 * Newest pre-migration backup tarball for a workspace in `backupDir`
 * (`lore-backup-<workspace>-<iso>.tar.gz`, written by backupWorkspace; the
 * ISO stamp sorts lexicographically). Null when none is on disk.
 */
export function latestGraphBackup(backupDir: string, workspaceName: string): string | null {
    if (!fs.existsSync(backupDir)) return null;
    const prefix = `lore-backup-${workspaceName}-`;
    const names = fs.readdirSync(backupDir)
        .filter((n) => n.startsWith(prefix) && n.endsWith('.tar.gz') && /^\d{4}-/.test(n.slice(prefix.length)))
        .sort();
    const newest = names[names.length - 1];
    return newest ? path.join(backupDir, newest) : null;
}

function usage(): void {
    console.error('usage: lore migrate-graph <workspace> --to sqlite [--force]');
    console.error('       lore migrate-graph <workspace> --rollback [--force]');
    console.error('');
    console.error('  --to sqlite   Migrate the named workspace from SurrealDB to the SQLite');
    console.error('                graph engine. Backs up first; the Surreal store is left in');
    console.error('                place afterwards as the rollback path.');
    console.error('  --rollback    Flip a sqlite-registered workspace back to surreal (registry');
    console.error('                entry only). Nothing is deleted, but writes made after the');
    console.error('                migration live only in graph.sqlite and are NOT carried');
    console.error('                back; the pre-migration backup tarball is the real undo.');
    console.error('  --force       Bypass the daemon preflight (tests / CI only).');
}

export async function migrateGraphCommand(args: string[]): Promise<void> {
    const workspaceName = args.find((a) => !a.startsWith('--'));
    const force = args.includes('--force');
    const rollback = args.includes('--rollback');
    const toIdx = args.indexOf('--to');
    const to = toIdx >= 0 ? args[toIdx + 1] : undefined;

    if (!workspaceName || (!rollback && to !== 'sqlite')) {
        usage();
        process.exit(1);
    }

    const home = loreHome();

    if (rollback) {
        console.log(`→ Rolling back workspace '${workspaceName}' to SurrealDB…`);
        try {
            const result = await rollbackGraphMigration({ workspaceName, home, force });
            console.log(`✓ workspace '${result.workspaceName}' is now registered as '${result.revertedTo}'.`);
            console.log('  Only the registry entry was reverted. graph.sqlite was left on disk, not deleted.');
            console.log('  WARNING: writes made after the migration were stored in graph.sqlite only and are');
            console.log('  NOT carried back — the SurrealDB store is exactly as it was at migration time.');
            const backup = latestGraphBackup(loreHomePath('migrate-graph-backups'), workspaceName);
            console.log(backup
                ? `  Pre-migration backup tarball (the real undo): ${backup}`
                : `  No pre-migration backup tarball found in ${loreHomePath('migrate-graph-backups')}.`);
        } catch (error) {
            console.error(`migrate-graph --rollback failed: ${(error as Error).message}`);
            process.exit(1);
        }
        return;
    }

    const backupOutDir = loreHomePath('migrate-graph-backups');
    fs.mkdirSync(backupOutDir, { recursive: true });

    console.log('');
    console.log(`Migration: '${workspaceName}' SurrealDB → SQLite`);
    console.log(`  Backup dir: ${backupOutDir}`);
    console.log('');

    try {
        const report = await migrateGraphToSqlite({ workspaceName, home, backupOutDir, force });
        console.log('─── Summary ─────────────────────────────────');
        console.log(`  Backup:            ${path.basename(report.backup.tarballPath)}`);
        console.log(`  Nodes migrated:    ${report.nodeCount}`);
        console.log(`  Edges migrated:    ${report.edgeCount}`);
        console.log(`  Digest match:      ${report.digestMatched ? 'yes' : 'NO'}`);
        console.log(`  Read probes:       ${report.readProbesMatched ? 'yes' : 'NO'} (${report.readProbeDetails.join('; ') || 'no probes ran — empty workspace'})`);
        console.log(`  Duration:          ${report.durationMs}ms`);
        console.log('');
        console.log(`✓ workspace '${workspaceName}' is now registered as 'sqlite'.`);
        console.log('  The SurrealDB store is left in place as the rollback path —');
        console.log(`  \`lore migrate-graph ${workspaceName} --rollback\` reverts the registry entry only:`);
        console.log('  writes made after this migration are NOT carried back to SurrealDB.');
        console.log(`  The real undo is the backup tarball: ${report.backup.tarballPath}`);
    } catch (error) {
        console.error(`migrate-graph failed: ${(error as Error).message}`);
        process.exit(1);
    }
}
