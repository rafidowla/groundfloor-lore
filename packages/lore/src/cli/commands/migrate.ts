import fs from 'fs';
import path from 'path';
import { openWorkspaceGraph, bannerEngineName } from '../../engines/openWorkspaceGraph.js';
import { loreHome, loreHomePath } from '../../config/loreHome.js';
import { migrateV1Sqlite } from '../../engines/v1Migration.js';
import { migrateEmbeddingModelCommand } from './migrateEmbedding.js';
import { migrateWorkspaceToWorkspaceCli } from './migrateWorkspaceToWorkspace.js';

export async function migrateCommand(args: string[]): Promise<void> {
    const target = args[0];
    if (target === 'embedding-model') {
        await migrateEmbeddingModelCommand(args.slice(1));
        return;
    }
    if (target === 'workspace-to-workspace') {
        await migrateWorkspaceToWorkspaceCli(args.slice(1));
        return;
    }
    // Sprint H1 (2026-05-24) — online-schema-migration subcommands.
    // Routes through MigrationCoordinator. Surface:
    //   lore migrate list [--substrate sqlite] [--workspace default] [--status applied]
    //   lore migrate status <id>
    //   lore migrate apply <spec.json>
    //   lore migrate rollback <id>
    if (target === 'list' || target === 'status' || target === 'apply' || target === 'rollback') {
        const { runMigrateSubcommand } = await import('./migrateOnline.js');
        await runMigrateSubcommand(target, args.slice(1));
        return;
    }
    if (target !== 'v1-sqlite') {
        console.error('usage: lore migrate <target> [options]');
        console.error('');
        console.error('Targets:');
        console.error('  v1-sqlite [<path>] [--apply] [--archive]');
        console.error('      Migrate a V1 knowledge.db SQLite file into the Kùzu graph.');
        console.error('      Default path: ~/.groundfloor/knowledge.db');
        console.error('  embedding-model --to <modelId> [--dim <n>] [--apply] [--force]');
        console.error('      Re-embed the corpus into a different model\'s vector space.');
        console.error('      Default is dry-run. Use --apply to drop+rebuild lore_verbatim.');
        console.error('  workspace-to-workspace --from <a> --to <b> [filters] [--apply]');
        console.error('      Move filtered nodes (and optionally edges + vectors) from one');
        console.error('      workspace to another. Default --dry-run. See --help for flags.');
        console.error('  list [--substrate <name>] [--workspace <name>] [--status <s>]');
        console.error('      Sprint H1: list online schema migrations tracked in migrations.sqlite.');
        console.error('  status <id>');
        console.error('      Sprint H1: detail per migration (phase, status, error, applied_at).');
        console.error('  apply <spec.json>');
        console.error('      Sprint H1: execute an online schema migration spec.');
        console.error('  rollback <id>');
        console.error('      Sprint H1: reverse a previously applied additive migration.');
        process.exit(1);
    }

    const rest = args.slice(1);
    const pathArg = rest.find((a) => !a.startsWith('--'));
    const apply = rest.includes('--apply');
    const archive = rest.includes('--archive');

    const sqlitePath = pathArg ?? loreHomePath('knowledge.db');

    if (!fs.existsSync(sqlitePath)) {
        console.error(`No SQLite database at ${sqlitePath}`);
        process.exit(1);
    }

    const basePath = loreHome();
    const loreDir = path.join(basePath, '.lore');
    const graph = openWorkspaceGraph(basePath);

    const { VerbatimStore } = await import('../../engines/verbatimStore.js');
    const verbatim = new VerbatimStore(basePath);
    await graph.initialize();

    console.log('');
    console.log(`Migration: V1 SQLite → V2 ${bannerEngineName(basePath)}`);
    console.log(`  Source:   ${sqlitePath}`);
    console.log(`  Mode:     ${apply ? 'APPLY' : 'DRY-RUN (use --apply to write)'}`);
    if (archive && !apply) {
        console.log(`  Archive:  (--archive is ignored without --apply)`);
    } else if (archive) {
        console.log(`  Archive:  YES — source file will be moved to ~/.groundfloor/archive/`);
    }
    console.log('');

    const report = await migrateV1Sqlite(graph, {
        sqlitePath,
        apply,
        archive,
        verbatimStore: apply ? verbatim : undefined,

    });

    console.log('─── Summary ─────────────────────────────────');
    console.log(`  V1 nodes read:              ${report.v1NodesRead}`);
    console.log(`  V1 edges read:              ${report.v1EdgesRead}`);
    console.log('');
    console.log(`  Nodes imported:             ${report.nodesImported}${apply ? '' : ' (would be)'}`);
    console.log(`  Nodes skipped (id match):   ${report.nodesSkippedIdConflict.length}`);
    console.log(`  Nodes flagged (content dup): ${report.nodesFlaggedContentDup.length}`);
    console.log('');
    console.log(`  Edges imported:             ${report.edgesImported}${apply ? '' : ' (would be)'}`);
    console.log(`  Edges skipped (duplicate):  ${report.edgesSkippedAlreadyExists}`);
    console.log(`  Edges skipped (dangling):   ${report.edgesSkippedMissingEndpoint.length}`);
    console.log('');
    console.log(`  Duration:                   ${report.durationMs}ms`);
    if (report.archivedTo) {
        console.log(`  Archived to:                ${report.archivedTo}`);
    }

    if (report.nodesSkippedIdConflict.length > 0) {
        console.log('');
        console.log('ID conflicts (V1 id matched an existing Kùzu node — V1 skipped):');
        for (const id of report.nodesSkippedIdConflict.slice(0, 10)) console.log(`  - ${id}`);
        if (report.nodesSkippedIdConflict.length > 10) {
            console.log(`  ... and ${report.nodesSkippedIdConflict.length - 10} more`);
        }
    }

    if (report.nodesFlaggedContentDup.length > 0) {
        console.log('');
        console.log('Content-duplicates (V1 id imported alongside an existing node with identical content):');
        console.log('  Review and `lore delete_node <v1-id>` to collapse if desired.');
        for (const pair of report.nodesFlaggedContentDup.slice(0, 10)) {
            console.log(`  - V1: ${pair.v1Id}  ~=  existing: ${pair.existingId}`);
        }
        if (report.nodesFlaggedContentDup.length > 10) {
            console.log(`  ... and ${report.nodesFlaggedContentDup.length - 10} more`);
        }
    }

    if (!apply) {
        console.log('');
        console.log('Dry-run complete. Run again with --apply to actually import.');
    } else {
        console.log('');
        console.log('Migration applied. Run `lore status` to confirm.');
        if (!archive) {
            console.log(`The source SQLite is still at ${sqlitePath} — delete manually or re-run with --archive.`);
        }
    }

    await graph.close();
}
