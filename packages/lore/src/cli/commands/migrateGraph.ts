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

function usage(): void {
    console.error('usage: lore migrate-graph <workspace> --to sqlite [--force]');
    console.error('       lore migrate-graph <workspace> --rollback [--force]');
    console.error('');
    console.error('  --to sqlite   Migrate the named workspace from SurrealDB to the SQLite');
    console.error('                graph engine. Backs up first; the Surreal store is left in');
    console.error('                place afterwards as the rollback path.');
    console.error('  --rollback    Flip a sqlite-registered workspace back to surreal. Data is');
    console.error('                untouched on both sides.');
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
            console.log('  graph.sqlite (if present) was left on disk, not deleted.');
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
        console.log(`  \`lore migrate-graph ${workspaceName} --rollback\` reverts the registry entry only.`);
    } catch (error) {
        console.error(`migrate-graph failed: ${(error as Error).message}`);
        process.exit(1);
    }
}
