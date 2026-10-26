/**
 * `lore tables copy --workspace <name> [--yes] [--replace] [--json]` - copy every table of a workspace from its
 * old `tables.sqlite` into its Postgres table storage.
 *
 * Why: switching a workspace's graph engine to `postgres` leaves `<workspace>/.lore/tables.sqlite` on disk, never
 * read, and the workspace starts with NO tables in Postgres. The copy logic lives in engines/tableCopy.ts (both
 * sides through ITableStorage); this file owns flags, the refusal policy, exit codes and the report.
 *
 * Exit codes (stable, for scripts):
 *   0  ok: copied and verified, or nothing to copy (no tables.sqlite / no tables / already identical)
 *   1  usage error, cannot connect to Postgres, or an unexpected failure
 *   2  dry run: work is pending and nothing was written (re-run with --yes)
 *   3  refused: workspace unknown, not on the Postgres engine, or LORE_PG_URL unset
 *   4  refused: the plan has blocking problems (target table holds differing rows and no --replace; a table
 *      with a different shape; a source value Postgres cannot store). Nothing was written.
 *   5  copied but verification FAILED (row count or checksum differs for a table); investigate before relying on it
 *
 * No `pg` import here (D-017): the engine modules are loaded lazily and only after the preconditions pass.
 */
import { parseOrExit } from '../args.js';
import type { TableCopyPlan, TableCopyPlanEntry, TableCopyResult } from '../../engines/tableCopy.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_NEEDS_YES = 2;
export const EXIT_REFUSED_PRECONDITION = 3;
export const EXIT_REFUSED_PLAN = 4;
export const EXIT_UNVERIFIED = 5;

export function tablesCopyUsage(): void {
    console.error('usage: lore tables copy --workspace <name> [--yes] [--replace] [--json]');
    console.error('');
    console.error('  Copies every table of <name> from its old <workspace>/.lore/tables.sqlite into its Postgres table');
    console.error('  storage (needs LORE_PG_URL and the workspace on the postgres graph engine). Schema (columns, primary,');
    console.error('  required, UNIQUE, indexed) and every row, including the reserved _memory_node_id / _source_id /');
    console.error('  _valid_from / _valid_to columns, are copied.');
    console.error('');
    console.error('  (no flags)   Dry run: prints each table with its row counts and what would happen. Writes nothing.');
    console.error('  --yes        Execute. Rows are written in transactions of at most 100; a crash can be fixed by simply');
    console.error('               running the command again (it copies only what is missing).');
    console.error('  --replace    For a table whose Postgres side already holds rows that differ from the SQLite file (or');
    console.error('               are not in it): delete ALL rows of that Postgres table (schema kept), then copy the SQLite');
    console.error('               rows in. Tables that exist only in Postgres are never touched. A table with a different');
    console.error('               shape is never altered, even with --replace.');
    console.error('  --json       Machine-readable report on stdout (human text goes to stderr).');
    console.error('');
    console.error('  Safe re-runs: a Postgres table already holding a clean subset of the SQLite rows is resumed; one that is');
    console.error('  already identical is skipped. After copying, every table is verified (row count and a checksum over the');
    console.error('  values). tables.sqlite is read from a private copy: it is never opened for writing, changed or deleted.');
    console.error('');
    console.error('  Exit codes: 0 ok / nothing to copy, 1 error, 2 dry run (work pending), 3 refused (workspace not on');
    console.error('  postgres / LORE_PG_URL unset / unknown), 4 refused (conflicts, shape mismatch, unconvertible value),');
    console.error('  5 copied but verification failed.');
}

const describe = (e: TableCopyPlanEntry): string => {
    switch (e.status) {
        case 'copy': return `will create in Postgres and copy ${e.sourceRows} row(s)`;
        case 'resume': return `resume: Postgres has ${e.identical} of ${e.sourceRows}; will copy ${e.missing} missing`;
        case 'done': return 'already identical in Postgres; nothing to do';
        case 'conflict': return `CONFLICT: ${e.detail}`;
        case 'schema_mismatch': return `REFUSED: ${e.detail}`;
        case 'error': return `REFUSED: ${e.detail}`;
    }
};

function printPlan(say: (m: string) => void, plan: TableCopyPlan, replace: boolean): void {
    say('');
    for (const e of plan.tables) {
        say(`${e.name}: ${e.sourceRows} row(s) in SQLite, ${e.targetRows === null ? 'not in Postgres' : `${e.targetRows} in Postgres`}`);
        say(`  ${describe(e)}${e.status === 'conflict' && replace ? ' -> --replace: Postgres rows of this table will be deleted first' : ''}`);
    }
}

function printResult(say: (m: string) => void, r: TableCopyResult): void {
    say('');
    for (const v of r.verification) {
        say(`${v.ok ? 'OK  ' : 'FAIL'} ${v.name}: SQLite ${v.sourceRows} row(s), Postgres ${v.targetRows} row(s)${v.ok ? '' : ` (checksum ${v.sourceDigest.slice(0, 12)} vs ${v.targetDigest.slice(0, 12)})`}`);
    }
}

export async function tablesCopyCommand(args: string[]): Promise<void> {
    const parsed = parseOrExit('tables copy', args, {
        bool: ['--yes', '--replace', '--json'],
        value: ['--workspace'],
        aliases: { '-h': '--help' },
        help: true,
    }, { usage: tablesCopyUsage });
    if (parsed.help) { tablesCopyUsage(); return; }

    const json = parsed.has('--json');
    const yes = parsed.has('--yes');
    const replace = parsed.has('--replace');
    const workspace = parsed.get('--workspace');
    const say = json ? (m: string) => console.error(m) : (m: string) => console.log(m);
    const finish = (code: number, body: Record<string, unknown>): void => {
        if (json) console.log(JSON.stringify({ exitCode: code, workspace, ...body }, null, 2));
        process.exitCode = code;
    };
    if (!workspace) {
        console.error('lore tables copy: --workspace <name> is required');
        tablesCopyUsage();
        return finish(EXIT_ERROR, { status: 'usage_error' });
    }

    const { loadWorkspacesIfPresent } = await import('../../config/workspaces.js');
    const entry = loadWorkspacesIfPresent()?.workspaces.find((w) => w.name === workspace);
    if (!entry) {
        say(`REFUSED: workspace '${workspace}' is not registered in this LORE_HOME (see 'lore workspaces').`);
        return finish(EXIT_REFUSED_PRECONDITION, { status: 'refused', reason: 'unknown_workspace' });
    }
    const { resolveWorkspaceGraphEngine } = await import('../../engines/graphEngineSelector.js');
    const engine = resolveWorkspaceGraphEngine(workspace);
    if (engine !== 'postgres') {
        say(`REFUSED: workspace '${workspace}' is on the '${engine}' graph engine, so its tables already live in tables.sqlite. This command only copies INTO Postgres.`);
        return finish(EXIT_REFUSED_PRECONDITION, { status: 'refused', reason: 'not_postgres', engine });
    }
    const url = process.env['LORE_PG_URL'];
    if (!url || url.trim() === '') {
        say('REFUSED: LORE_PG_URL is not set; set it to the Postgres database this workspace uses.');
        return finish(EXIT_REFUSED_PRECONDITION, { status: 'refused', reason: 'pg_url_unset' });
    }

    const { openLegacyTablesSnapshot } = await import('../../engines/tablesLeftBehind.js');
    const snap = openLegacyTablesSnapshot(entry.path);
    if (!snap) {
        say(`Nothing to copy: ${entry.path}/.lore/tables.sqlite does not exist.`);
        return finish(EXIT_OK, { status: 'nothing_to_copy', reason: 'no_file' });
    }
    const { closeSharedPostgresPool } = await import('../../engines/postgres/postgresPoolOwner.js');
    let target: Awaited<ReturnType<typeof import('../../engines/tableStorageFactory.js').createPostgresTableStorage>> | undefined;
    try {
        const copy = await import('../../engines/tableCopy.js');
        const { createPostgresTableStorage } = await import('../../engines/tableStorageFactory.js');
        const { validateSchema } = await import('../../engines/postgres/postgresTableCatalog.js');
        const { redactPgUrl } = await import('../../engines/postgres/postgresClient.js');
        say(`Database: ${redactPgUrl(url)}`);
        if (snap.undeclared.length > 0) {
            say(`NOTE: tables.sqlite also contains table(s) with no declared schema (${snap.undeclared.join(', ')}); they cannot be copied.`);
        }
        target = await createPostgresTableStorage(workspace);
        const opts = { replace, validateTargetSchema: validateSchema, onProgress: say };
        const plan = await copy.planTableCopy(snap.storage, target, opts);
        printPlan(say, plan, replace);
        const planBody = { tables: plan.tables, undeclaredTables: snap.undeclared };

        const refusals = copy.planRefusals(plan, opts);
        if (refusals.length > 0) {
            say('');
            say('REFUSED: nothing was written.');
            for (const r of refusals) say(`  - ${r}`);
            return finish(EXIT_REFUSED_PLAN, { status: 'refused', reason: 'plan_blocked', refusals, ...planBody });
        }
        if (plan.blocking.length === 0) {
            say(plan.tables.length === 0 ? '\nNothing to copy: tables.sqlite declares no tables.' : '\nNothing to copy: every table is already identical in Postgres.');
            return finish(EXIT_OK, { status: 'nothing_to_copy', ...planBody });
        }
        if (!yes) {
            say('\nDry run: nothing was written. Re-run with --yes to copy.');
            return finish(EXIT_NEEDS_YES, { status: 'needs_yes', ...planBody });
        }
        const result = await copy.executeTableCopy(snap.storage, target, plan, opts);
        printResult(say, result);
        if (!result.verified) {
            say('\nVERIFICATION FAILED for at least one table. The SQLite file is untouched; investigate before relying on the Postgres copy.');
            return finish(EXIT_UNVERIFIED, { status: 'verification_failed', ...planBody, result });
        }
        say('\nCopied and verified. tables.sqlite was not modified.');
        return finish(EXIT_OK, { status: 'copied', ...planBody, result });
    } catch (err) {
        console.error(`lore tables copy: ${(err as Error).message}`);
        return finish(EXIT_ERROR, { status: 'error', error: (err as Error).message });
    } finally {
        try { await target?.close(); } catch { /* ignore */ }
        snap.close();
        await closeSharedPostgresPool().catch(() => undefined);
    }
}
