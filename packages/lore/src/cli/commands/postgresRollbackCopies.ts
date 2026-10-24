/**
 * `lore postgres rollback-copies` — list, verify and drop the rollback copies the two in-place
 * Postgres migrations leave behind (`verbatim_pre_partition`, `edges_pre_pk`).
 *
 * The SQL and the safety rules (fixed allowlist, verification, lock-then-recheck) live in
 * engines/postgres/postgresRollbackCopies.ts; this file owns flags, the refusal policy, exit codes
 * and the report. `edges_dangling` (quarantined edges) is reported but can never be dropped here.
 *
 * Exit codes (stable, for scripts):
 *   0  ok: listed, dropped, or nothing to do (including a SQLite-only config)
 *   1  usage error, cannot connect, or an unexpected failure
 *   2  drop NOT performed: --yes missing (dry run of what would be dropped)
 *   3  drop NOT performed: verification failed and --force was not given
 *
 * No `pg` import here (D-017): the engine module is loaded lazily, and only when LORE_PG_URL is set.
 */
import { parseOrExit } from '../args.js';
import type { RollbackCopyName, RollbackCopyReport, RollbackInspection } from '../../engines/postgres/postgresRollbackCopies.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_NEEDS_YES = 2;
export const EXIT_UNVERIFIED = 3;

export function rollbackCopiesUsage(): void {
    console.error('usage: lore postgres rollback-copies [--drop <verbatim_pre_partition|edges_pre_pk|all> [--yes] [--force]] [--json]');
    console.error('');
    console.error('  Postgres only (reads LORE_PG_URL). Lists the rollback copies the two in-place migrations leave');
    console.error('  behind, with row count, size and a check against the live table:');
    console.error('    verbatim_pre_partition   the verbatim table before partitioning by workspace');
    console.error('    edges_pre_pk             the text-keyed edges table before edge layout 2');
    console.error('  Nothing reads these tables once the migration has committed; they only cost disk, and they are');
    console.error('  your way back if the migration turns out wrong. Back up (lore backup) before dropping.');
    console.error('  edges_dangling (edges the migration quarantined) is shown but is NEVER dropped by this command.');
    console.error('');
    console.error('  (no flags)         Read-only report. Safe next to a running host.');
    console.error('  --drop <name|all>  Drop that copy (or both). Verifies first; with no --yes it only prints what');
    console.error('                     would be dropped. Drops nothing if any selected copy fails verification.');
    console.error('  --yes              Required to actually drop.');
    console.error('  --force            Drop even though verification failed (prints a loud warning).');
    console.error('  --json             Machine-readable report on stdout (human text goes to stderr).');
    console.error('');
    console.error('  Exit codes: 0 ok / nothing to do, 1 error, 2 drop needs --yes, 3 verification failed (no --force).');
    console.error('');
    console.error('  Verification: every row (verbatim) or resolvable edge (edges) in the copy must still exist in the live');
    console.error('  table. A row deleted on purpose since the migration also counts as missing, so a failure is a signal to');
    console.error('  look at (the report lists a sample), not proof of loss.');
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const u = ['KiB', 'MiB', 'GiB', 'TiB'];
    let v = n / 1024; let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}

function printCopy(say: (m: string) => void, r: RollbackCopyReport): void {
    say('');
    if (!r.exists) { say(`${r.name}: not present (nothing to drop)`); return; }
    say(`${r.name}  (left by ${r.from})`);
    say(`  ${r.rows} rows, ${fmtBytes(r.bytes)} on disk; live ${r.liveTable} has ${r.liveRows} rows`);
    for (const c of r.checks) say(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.detail}`);
    if (r.sampleMissing.length > 0) say(`  missing from live (sample): ${r.sampleMissing.join(', ')}`);
    say(`  verification: ${r.verified ? 'PASSED' : 'FAILED'}`);
}

function printInspection(say: (m: string) => void, i: RollbackInspection): void {
    for (const r of i.copies) printCopy(say, r);
    if (i.quarantine.exists) {
        say('');
        say(`edges_dangling: ${i.quarantine.rows} quarantined edge(s). Not a rollback copy; this command never drops it.`);
    }
    if (!i.copies.some((r) => r.exists)) say('\nNo rollback copies present.');
}

export async function postgresRollbackCopiesCommand(args: string[]): Promise<void> {
    const parsed = parseOrExit('postgres rollback-copies', args, {
        bool: ['--yes', '--force', '--json'],
        value: ['--drop'],
        aliases: { '-h': '--help' },
        help: true,
    }, { usage: rollbackCopiesUsage });
    if (parsed.help) { rollbackCopiesUsage(); return; }

    const json = parsed.has('--json');
    const yes = parsed.has('--yes');
    const force = parsed.has('--force');
    const dropArg = parsed.get('--drop');
    const say = json ? (m: string) => console.error(m) : (m: string) => console.log(m);
    const finish = (code: number, body: Record<string, unknown>): void => {
        if (json) console.log(JSON.stringify({ exitCode: code, ...body }, null, 2));
        process.exitCode = code;
    };

    const eng = await import('../../engines/postgres/postgresRollbackCopies.js');
    if ((yes || force) && dropArg === undefined) {
        console.error('lore postgres rollback-copies: --yes / --force only apply together with --drop');
        return finish(EXIT_ERROR, { status: 'usage_error' });
    }
    let names: RollbackCopyName[] = [];
    if (dropArg !== undefined) {
        if (dropArg === 'all') names = [...eng.ROLLBACK_COPY_NAMES];
        else if ((eng.ROLLBACK_COPY_NAMES as readonly string[]).includes(dropArg)) names = [dropArg as RollbackCopyName];
        else {
            console.error(`lore postgres rollback-copies: --drop accepts ${eng.ROLLBACK_COPY_NAMES.join(', ')} or all; "${dropArg}" is not a rollback copy and will never be dropped by this command`);
            return finish(EXIT_ERROR, { status: 'usage_error' });
        }
    }

    const url = process.env['LORE_PG_URL'];
    if (!url || url.trim() === '') {
        say('Nothing to do: LORE_PG_URL is not set, so this is not a Postgres setup. Rollback copies only exist in Postgres,');
        say('left by the verbatim partitioning and edge layout 2 migrations. SQLite and LanceDB workspaces have none.');
        return finish(EXIT_OK, { status: 'not_postgres', copies: [] });
    }

    const { createPostgresPool, closePostgresPool, redactPgUrl } = await import('../../engines/postgres/postgresClient.js');
    const { connectForStartup, explainPostgresStartupError } = await import('../../engines/postgres/postgresStartup.js');
    const pool = createPostgresPool({ max: 1 });
    try {
        const client = await connectForStartup(pool);
        try {
            say(`Database: ${redactPgUrl(url)}`);
            const inspection = await eng.inspectRollbackCopies(client);
            if (dropArg === undefined) {
                printInspection(say, inspection);
                return finish(EXIT_OK, { status: 'listed', ...inspection });
            }

            const selected = inspection.copies.filter((c) => names.includes(c.name));
            for (const r of selected) printCopy(say, r);
            const present = selected.filter((r) => r.exists);
            if (present.length === 0) {
                say('\nNothing to drop: the selected rollback copies are not present.');
                return finish(EXIT_OK, { status: 'nothing_to_drop', copies: selected });
            }
            const unverified = present.filter((r) => !r.verified);
            if (unverified.length > 0 && !force) {
                say(`\nREFUSED: verification failed for ${unverified.map((r) => r.name).join(', ')}. Nothing was dropped.`);
                say('Look at the report above. If the missing rows were deleted on purpose, re-run with --force (and --yes) to drop anyway.');
                return finish(EXIT_UNVERIFIED, { status: 'verification_failed', copies: selected });
            }
            if (!yes) {
                say(`\nWould drop: ${present.map((r) => `${r.name} (${fmtBytes(r.bytes)})`).join(', ')}.`);
                if (unverified.length > 0) say('WARNING: verification FAILED for ' + unverified.map((r) => r.name).join(', ') + '; --force is set.');
                say('Nothing was dropped. Take a backup, then re-run with --yes to drop.');
                return finish(EXIT_NEEDS_YES, { status: 'needs_yes', copies: selected });
            }
            if (unverified.length > 0) {
                console.error(`WARNING: --force: dropping ${unverified.map((r) => r.name).join(', ')} although verification FAILED. This cannot be undone.`);
            }
            const outcomes = await eng.dropRollbackCopies(client, names, { force });
            for (const o of outcomes) {
                if (o.dropped) say(`dropped ${o.name}${o.forced ? ' (forced, verification had failed)' : ''}`);
                else say(`${o.name}: ${o.skipped === 'absent' ? 'not present' : 'NOT dropped (verification failed on re-check inside the drop transaction)'}`);
            }
            const refused = outcomes.some((o) => o.skipped === 'unverified');
            return finish(refused ? EXIT_UNVERIFIED : EXIT_OK, { status: refused ? 'verification_failed' : 'dropped', outcomes });
        } finally {
            client.release();
        }
    } catch (err) {
        const e = explainPostgresStartupError(err);
        console.error(`lore postgres rollback-copies: ${e.message}`);
        return finish(EXIT_ERROR, { status: 'error', error: e.message });
    } finally {
        await closePostgresPool(pool).catch(() => undefined);
    }
}
