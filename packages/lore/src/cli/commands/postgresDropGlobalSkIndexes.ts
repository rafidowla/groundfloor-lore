/**
 * `lore postgres drop-global-sk-indexes` - the CONTRACT step of the per-workspace `nodes.sk` change.
 *
 * Drops the database-wide structures that only the old "sk is unique across the database" assumption needed:
 * `idx_nodes_sk`, `idx_edges_dst_sk`, lore_entity's single-column foreign key and index, and the old-named per-field
 * indexes (`lore_ev_<fieldId>_u|_i`). The SQL and its guards live in engines/postgres/postgresWorkspaceSk.ts
 * (`dropGlobalSkIndexes`); this file owns flags and exit codes. Startup NEVER does this.
 *
 * Exit codes: 0 ok / nothing to do, 1 usage error or failure, 2 dry run (needs --yes), 3 refused by a guard.
 *
 * No `pg` import here (D-017): the engine module is loaded lazily, and only when LORE_PG_URL is set.
 */
import { parseOrExit } from '../args.js';

export function dropGlobalSkIndexesUsage(): void {
    console.error('usage: lore postgres drop-global-sk-indexes [--yes] [--json]');
    console.error('');
    console.error('  Postgres only (reads LORE_PG_URL). Removes the database-wide node-key structures that Lore keeps');
    console.error('  for older builds: idx_nodes_sk, idx_edges_dst_sk, lore_entity_memory_node_sk_fkey,');
    console.error('  lore_entity_node_sk_idx and the old-named lore_ev_<fieldId>_u|_i field indexes.');
    console.error('  It refuses (and drops nothing) unless the workspace-led replacements exist and are valid.');
    console.error('  Run it only after EVERY process sharing the database runs a build that has them: an older build would');
    console.error('  recreate idx_nodes_sk and lose its index on the next open. Startup never drops them.');
    console.error('');
    console.error('  (no flags)   Dry run: print what would be dropped.');
    console.error('  --yes        Drop (DROP INDEX CONCURRENTLY: no long write lock).');
    console.error('  --json       Machine-readable report on stdout (human text goes to stderr).');
    console.error('');
    console.error('  Exit codes: 0 ok / nothing to do, 1 error, 2 dry run (needs --yes), 3 refused by a guard.');
}

export async function postgresDropGlobalSkIndexesCommand(args: string[]): Promise<void> {
    const parsed = parseOrExit('postgres drop-global-sk-indexes', args, {
        bool: ['--yes', '--json'], value: [], aliases: { '-h': '--help' }, help: true,
    }, { usage: dropGlobalSkIndexesUsage });
    if (parsed.help) { dropGlobalSkIndexesUsage(); return; }
    const json = parsed.has('--json');
    const yes = parsed.has('--yes');
    const say = json ? (m: string) => console.error(m) : (m: string) => console.log(m);
    const finish = (code: number, body: Record<string, unknown>): void => {
        if (json) console.log(JSON.stringify({ exitCode: code, ...body }, null, 2));
        process.exitCode = code;
    };

    const url = process.env['LORE_PG_URL'];
    if (!url || url.trim() === '') {
        say('Nothing to do: LORE_PG_URL is not set, so this is not a Postgres setup.');
        return finish(0, { status: 'not_postgres', dropped: [] });
    }
    const { createPostgresPool, closePostgresPool, redactPgUrl } = await import('../../engines/postgres/postgresClient.js');
    const { connectForStartup, explainPostgresStartupError } = await import('../../engines/postgres/postgresStartup.js');
    const { dropGlobalSkIndexes } = await import('../../engines/postgres/postgresWorkspaceSk.js');
    const pool = createPostgresPool({ max: 1 });
    try {
        const client = await connectForStartup(pool);
        try {
            say(`Database: ${redactPgUrl(url)}`);
            const report = await dropGlobalSkIndexes(client, { dryRun: !yes });
            if (report.refused) {
                say(`REFUSED: ${report.refused}. Nothing was dropped.`);
                return finish(3, { status: 'refused', refused: report.refused });
            }
            if (report.dropped.length === 0) {
                say('Nothing to drop: the database-wide node-key structures are already gone.');
                return finish(0, { status: 'nothing_to_drop', dropped: [] });
            }
            if (!yes) {
                say(`Would drop: ${report.dropped.join(', ')}.`);
                say('Nothing was dropped. Re-run with --yes once every process on this database runs the current build.');
                return finish(2, { status: 'needs_yes', wouldDrop: report.dropped });
            }
            say(`Dropped: ${report.dropped.join(', ')}.`);
            return finish(0, { status: 'dropped', dropped: report.dropped });
        } finally {
            client.release();
        }
    } catch (err) {
        const e = explainPostgresStartupError(err);
        console.error(`lore postgres drop-global-sk-indexes: ${e.message}`);
        return finish(1, { status: 'error', error: e.message });
    } finally {
        await closePostgresPool(pool).catch(() => undefined);
    }
}
