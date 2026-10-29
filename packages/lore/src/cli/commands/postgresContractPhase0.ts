/**
 * `lore postgres contract-phase0` - drop the legacy structures the Phase 0 (shard-ready) changes replaced:
 * the single-column primary keys on lore_ingest_jobs / pending / deliveries (replaced by workspace-led PRIMARY KEYs), the three legacy keyword indexes on `nodes`,
 * and an existing empty `verbatim_changes_log`. The SQL and the refusal rules live in
 * engines/postgres/postgresPhase0Contract.ts; this file owns flags, exit codes and the report.
 *
 * Exit codes: 0 done / nothing to do (including a non-Postgres config), 1 error, 2 not performed: --yes missing,
 * 3 performed partly: a step refused because its replacement is not in place.
 *
 * No `pg` import here (D-017): the engine module is loaded lazily, and only when LORE_PG_URL is set.
 */
import { parseOrExit } from '../args.js';

export function contractPhase0Usage(): void {
    console.error('usage: lore postgres contract-phase0 [--yes] [--json]');
    console.error('');
    console.error('  Postgres only (reads LORE_PG_URL). Run it once EVERY host runs a build that uses the workspace-led keys and');
    console.error('  indexes; until then the old structures are your way back to the previous build. It drops:');
    console.error('    lore_ingest_jobs / lore_ingest_pending / lore_ingest_deliveries   the single-column primary keys, replaced by workspace-led ones');
    console.error('    idx_nodes_label_trgm, idx_nodes_content_trgm, idx_nodes_tags_gin   the legacy keyword indexes');
    console.error('    verbatim_changes_log                                              (only if empty)');
    console.error('  Each step is refused (nothing dropped) when its replacement is missing or invalid.');
    console.error('  (no --yes)  Prints this and does nothing.   --yes  Perform the drops.   --json  Report on stdout.');
}

export async function postgresContractPhase0Command(args: string[]): Promise<void> {
    const parsed = parseOrExit('postgres contract-phase0', args, {
        bool: ['--yes', '--json'], value: [], aliases: { '-h': '--help' }, help: true,
    }, { usage: contractPhase0Usage });
    if (parsed.help) { contractPhase0Usage(); return; }
    const json = parsed.has('--json');
    const say = json ? (m: string) => console.error(m) : (m: string) => console.log(m);
    const finish = (code: number, body: Record<string, unknown>): void => {
        if (json) console.log(JSON.stringify({ exitCode: code, ...body }, null, 2));
        process.exitCode = code;
    };
    const url = process.env['LORE_PG_URL'];
    if (!url || url.trim() === '') {
        say('Nothing to do: LORE_PG_URL is not set, so this is not a Postgres setup.');
        return finish(0, { status: 'not_postgres' });
    }
    if (!parsed.has('--yes')) {
        contractPhase0Usage();
        say('\nNothing was dropped. Re-run with --yes to drop.');
        return finish(2, { status: 'needs_yes' });
    }
    const { createPostgresPool, closePostgresPool, redactPgUrl } = await import('../../engines/postgres/postgresClient.js');
    const { connectForStartup, explainPostgresStartupError } = await import('../../engines/postgres/postgresStartup.js');
    const { contractPhase0 } = await import('../../engines/postgres/postgresPhase0Contract.js');
    const pool = createPostgresPool({ max: 1 });
    try {
        const client = await connectForStartup(pool);
        try {
            say(`Database: ${redactPgUrl(url)}`);
            const r = await contractPhase0(client);
            for (const d of r.ingestionKeys.dropped) say(`dropped ${d}`);
            for (const d of r.ingestionKeys.promoted) say(`promoted ${d}`);
            for (const d of r.keywordIndexes.dropped) say(`dropped index ${d}`);
            if (r.changesLog.dropped) say('dropped verbatim_changes_log');
            const refused = [...r.ingestionKeys.refused, ...r.keywordIndexes.refused, ...(r.changesLog.refused ? [r.changesLog.refused] : [])];
            for (const m of refused) say(`REFUSED: ${m}`);
            return finish(refused.length > 0 ? 3 : 0, { status: refused.length > 0 ? 'partial' : 'done', ...r });
        } finally {
            client.release();
        }
    } catch (err) {
        const e = explainPostgresStartupError(err);
        console.error(`lore postgres contract-phase0: ${e.message}`);
        return finish(1, { status: 'error', error: e.message });
    } finally {
        await closePostgresPool(pool).catch(() => undefined);
    }
}
