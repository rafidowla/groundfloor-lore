/**
 * cli/commands/migrateVectors.ts — `lore migrate-vectors <workspace> --to
 * sqlite [--force] [--dry-run] [--data-dir <path>]` (3.27.1). Thin CLI
 * wrapper over `engines/migrateVectorsToSqlite.ts` — see that file for the
 * migration steps and their ordering guarantees. Same shape as
 * `lore migrate-graph` (output block, exit 1 on any refusal/failure).
 *
 * Differences from migrate-graph, deliberately:
 *   - `--force` here moves a non-empty target `verbatim.sqlite` aside (the
 *     brief's meaning); it does NOT bypass the daemon preflight. The
 *     test-only bypass is the engine option `skipDaemonCheck`.
 *   - `--data-dir <path>` (the `lore migrate piece-vectors` / `lore maintain
 *     storage` convention) targets an embedded host's own
 *     `createLore({ dataDir })` root — Atlas keeps one per project and
 *     never uses LORE_HOME. The host must be STOPPED: the daemon preflight
 *     only sees a daemon serving that home, not an in-process host.
 *   - No `--to lance`: see the engine header (not a thin wrapper over
 *     promote; `lore vectors promote` covers that direction).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loreHome, resolveLoreHome } from '../../config/loreHome.js';
import { migrateVectorsToSqlite } from '../../engines/migrateVectorsToSqlite.js';

function usage(): void {
    console.error('usage: lore migrate-vectors <workspace> --to sqlite [--dry-run] [--force] [--data-dir <path>]');
    console.error('');
    console.error('  --to sqlite        Move the workspace\'s verbatim (vector) store from LanceDB to');
    console.error('                     SQLite. Offline: stop the daemon / embedding host first.');
    console.error('                     Backs up first; the Lance tables are left in place.');
    console.error('  --dry-run          Check preconditions and print counts; write nothing.');
    console.error('  --force            Move an existing non-empty verbatim.sqlite aside to a');
    console.error('                     timestamped name (never deleted) instead of refusing.');
    console.error('  --data-dir <path>  Target an embedded host\'s createLore({ dataDir }) root');
    console.error('                     instead of LORE_HOME (e.g. one Atlas project root).');
}

function parseDataDir(args: string[]): string | undefined {
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a.startsWith('--data-dir=')) return a.slice('--data-dir='.length);
        if (a === '--data-dir') return args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : '';
    }
    return undefined;
}

export async function migrateVectorsCommand(args: string[]): Promise<void> {
    const dataDir = parseDataDir(args);
    const skip = new Set<number>();
    const ddIdx = args.indexOf('--data-dir');
    if (ddIdx >= 0) skip.add(ddIdx + 1);
    const toIdx = args.indexOf('--to');
    if (toIdx >= 0) skip.add(toIdx + 1);
    const workspaceName = args.find((a, i) => !a.startsWith('--') && !skip.has(i));
    const to = toIdx >= 0 ? args[toIdx + 1] : undefined;
    const force = args.includes('--force');
    const dryRun = args.includes('--dry-run');

    if (!workspaceName || to !== 'sqlite' || dataDir === '') {
        if (dataDir === '') console.error('--data-dir requires a path');
        usage();
        process.exit(1);
    }
    if (dataDir !== undefined && (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory())) {
        console.error(`migrate-vectors failed: --data-dir ${dataDir} does not exist or is not a directory`);
        process.exit(1);
    }

    const home = dataDir !== undefined ? resolveLoreHome({ dataDir }) : loreHome();
    const backupOutDir = path.join(home, 'migrate-vectors-backups');
    if (!dryRun) fs.mkdirSync(backupOutDir, { recursive: true });

    console.log('');
    console.log(`Migration: '${workspaceName}' verbatim store LanceDB → SQLite${dryRun ? ' (dry run)' : ''}`);
    console.log(`  Data root:  ${home}`);
    if (!dryRun) console.log(`  Backup dir: ${backupOutDir}`);
    console.log('');

    try {
        const r = await migrateVectorsToSqlite({ workspaceName, home, backupOutDir, force, dryRun });
        console.log('─── Summary ─────────────────────────────────');
        if (r.backup) console.log(`  Backup:            ${path.basename(r.backup.tarballPath)}`);
        console.log(`  Canonical rows:    ${r.counts.canonical}`);
        console.log(`  History rows:      ${r.counts.history}`);
        console.log(`  Alias (#q) rows:   ${r.counts.alias}`);
        console.log(`  Tombstoned rows:   ${r.tombstones}`);
        console.log(`  Unembedded rows:   ${r.unembedded} (zero placeholder → NULL vector)`);
        console.log(`  Piece rows:        ${r.pieces}`);
        console.log(`  Embedding model:   ${r.embeddingModel.modelId} (${r.embeddingModel.dimension}d)`);
        console.log(`  Promote threshold: ${r.promoteThreshold === 0 ? 'disabled' : r.promoteThreshold}`);
        for (const m of r.movedAside) console.log(`  Moved aside:       ${m}`);
        if (!r.dryRun) {
            console.log(`  Digest match:      yes (${r.vectorsCompared} vectors bit-equal)`);
            console.log(`  Live probes:       yes (${r.probeDetails.join('; ') || 'no probes ran — no embedded canonical rows'})`);
        }
        console.log(`  Duration:          ${r.durationMs}ms`);
        for (const w of r.warnings) console.log(`  Warning:           ${w}`);
        console.log('');
        if (r.dryRun) {
            console.log('✓ dry run: preconditions pass; nothing was written.');
            return;
        }
        console.log(`✓ workspace '${workspaceName}' is now registered with vectorEngine 'sqlite' (${r.sqlitePath}).`);
        console.log('  Lance data untouched (its keyword index may have been rebuilt on open).');
        console.log('  Once satisfied, delete ONLY:');
        for (const p of r.lanceTablePaths) console.log(`    rm -rf "${p}"`);
        console.log('  Keep the rest of .lore/lancedb/ — embedding_model.json and piece_layout.json');
        console.log('  are shared metadata the SQLite engine still reads.');
    } catch (error) {
        console.error(`migrate-vectors failed: ${(error as Error).message}`);
        process.exit(1);
    }
}
