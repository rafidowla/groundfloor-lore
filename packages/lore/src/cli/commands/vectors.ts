/**
 * cli/commands/vectors.ts — `lore vectors <subcommand>`.
 *
 * 3.21 step 2 part 3. Today's only subcommand: `promote <ws> [--dry-run]`,
 * the manual operator escape hatch for SQLite -> LanceDB promotion (design
 * section 3: "Demotion is not built. There is a manual CLI `lore vectors
 * promote <ws> [--dry-run]` for operators, using the same procedure").
 *
 * Does NOT touch `workspaces.json`'s `vectorEngine` field — selection
 * wiring (which engine a workspace declares/uses) is a separate,
 * out-of-scope change; this command promotes whatever `verbatim.sqlite`
 * it finds at the resolved workspace path, independent of what the
 * workspace's config currently says it's using.
 */

import { getWorkspacePath } from '../../config/workspaces.js';
import { openGraphForCli } from './shared.js';

export async function vectorsCommand(args: string[]): Promise<void> {
    const target = args[0];
    if (target !== 'promote') {
        console.error('usage: lore vectors <subcommand>');
        console.error('');
        console.error('Subcommands:');
        console.error('  promote <workspace> [--dry-run]');
        console.error('      Promote a workspace\'s SQLite verbatim store to LanceDB.');
        console.error('      Default runs the full promotion. --dry-run only reports the');
        console.error('      current row count and whether it is over the promotion');
        console.error('      threshold (LORE_VECTOR_PROMOTE_ROWS, default 250000) — it does');
        console.error('      not stage, verify, or commit anything.');
        process.exit(1);
    }
    await promoteSubcommand(args.slice(1));
}

async function promoteSubcommand(args: string[]): Promise<void> {
    const ws = args.find((a) => !a.startsWith('--'));
    const dryRun = args.includes('--dry-run');
    if (!ws) {
        console.error('usage: lore vectors promote <workspace> [--dry-run]');
        process.exit(1);
    }

    const basePath = getWorkspacePath(ws);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const sqlitePath = path.join(basePath, '.lore', 'verbatim.sqlite');
    if (!fs.existsSync(sqlitePath)) {
        console.error(`No verbatim.sqlite at ${sqlitePath} — this workspace has no SQLite verbatim store to promote (already on LanceDB, or never written to).`);
        process.exit(1);
    }

    // Refuse fast if a daemon holds the workspace's graph store — mirrors
    // every other maintenance CLI command's lock-conflict handling
    // (reconnect.ts, migrate.ts) rather than a raw driver timeout. The
    // graph store, not verbatim.sqlite, is the daemon's own liveness
    // signal for this workspace today (verbatim.sqlite has no lock probe
    // of its own yet); this is a best-effort courtesy check, not a hard
    // guarantee — a genuinely concurrent write during promotion is still
    // handled correctly by the write-gate in verbatimPromotion.ts either way.
    try {
        const graph = await openGraphForCli(basePath);
        await graph.close?.();
    } catch (err) {
        console.error(`Refusing: ${(err as Error).message}`);
        process.exit(1);
    }

    const { promoteWorkspace } = await import('../../engines/verbatimPromotion.js');
    // Dimension comes from the workspace's OWN embedding fingerprint (the
    // JSON sidecar every VerbatimStore/SqliteVerbatimStore stamps at
    // table birth), NOT from constructing "the current default local
    // embedder" — those can disagree (a workspace embedded with an
    // injected/remote provider, or a different local model than whatever
    // is configured as default right now on the machine running this
    // CLI). Promotion copies vectors verbatim and never re-embeds, so the
    // ONLY thing needed here is the dimension the vectors were actually
    // written with — reading the fingerprint avoids ever loading an
    // embedding model at all for a promotion run.
    const { readFingerprintOrLegacy } = await import('../../engines/embeddingFingerprint.js');
    const fingerprint = readFingerprintOrLegacy(basePath);

    console.log('');
    console.log(`  Vector promotion — workspace "${ws}" (${basePath})`);
    console.log(`  mode: ${dryRun ? 'DRY RUN (no changes)' : 'APPLY'}`);
    console.log(`  embedding model: ${fingerprint.modelId} (dim=${fingerprint.dimension})`);

    const result = await promoteWorkspace(basePath, fingerprint.dimension, { dryRun });

    if (dryRun) {
        console.log(`  Source rows: ${result.verify.sourceRowCount}`);
        console.log('  (dry run — no staging, verification, or commit performed)');
        return;
    }

    if (!result.committed) {
        console.error(`  ✗ Promotion FAILED verification — SQLite remains authoritative, nothing was changed.`);
        for (const reason of result.verify.reasons) console.error(`      ${reason}`);
        process.exit(1);
    }

    console.log(`  ✓ Promoted ${result.rowsStaged} row(s) (+${result.tailRowsApplied} written during staging).`);
    console.log(`  ✓ Verified: ${result.verify.sourceRowCount} rows, content-hash multiset match, ${result.verify.sampledRows - result.verify.sampleFailures}/${result.verify.sampledRows} sample-recall checks passed.`);
    console.log(`  ✓ New LanceDB store: ${result.newLanceDbPath}`);
    console.log(`  ✓ SQLite kept as rollback: ${result.sqliteBackupPath}`);
    console.log('');
    console.log('  NOTE: this workspace\'s workspaces.json vectorEngine field was NOT updated —');
    console.log('  that wiring is a separate, pending change. The daemon must be restarted (or');
    console.log('  its resolver cache for this workspace refreshed) to pick up the promoted store.');
}
