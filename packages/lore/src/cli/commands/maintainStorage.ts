/**
 * maintainStorage.ts — `lore maintain storage`, storage-growth fix 3/3
 * (Fix 5): the offline reclaim CLI wrapper over
 * `outbox/reclaimStorage.ts`'s `reclaimStorage()`.
 *
 * Same `--data-dir <path>` convention as `lore migrate piece-vectors`
 * (migratePieceVectors.ts) — targets an embedded host's own
 * `createLore({ dataDir })` root instead of `loreHome()`. The lock preflight
 * lives entirely inside `reclaimStorage()`: `checkNotHeld`'s SQLite probe
 * uses `locking_mode = EXCLUSIVE` plus a forced read, not a plain
 * `BEGIN IMMEDIATE`, so it catches an IDLE holder (not just a mid-write one)
 * on EVERY layout — a bare `versions.sqlite`/`outbox.sqlite` pair, a
 * Surreal-backed graph, or a SQLite-engine graph alike. Verified
 * cross-process against a real idle host (see PR #159). When the data root
 * also has a Surreal-backed graph, `reclaimStorage()` additionally takes
 * `acquirePieceRebuildLock`, the same lock other offline tools on a
 * graph-backed root use — redundant with the SQLite probe now, kept as a
 * second, independent check. Even so, stopping the host first remains the
 * documented procedure; this preflight is a safety net, not a substitute.
 * See `reclaimStorage.ts`'s own header for the full reasoning and the
 * measurement that verified it.
 */

import type { ReclaimStorageResult, ReclaimFileReport } from '../../outbox/reclaimStorage.js';

/** Value of `--data-dir <path>` / `--data-dir=<path>`; undefined when absent. */
function parseDataDir(args: string[]): string | undefined {
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a.startsWith('--data-dir=')) return a.slice('--data-dir='.length);
        if (a === '--data-dir') {
            const v = args[i + 1];
            if (v === undefined || v.startsWith('--')) {
                console.error('--data-dir requires a path');
                process.exit(1);
            }
            return v;
        }
    }
    return undefined;
}

/** Value of `--skip-types a,b,c`; [] when absent. */
function parseSkipTypes(args: string[]): string[] {
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a.startsWith('--skip-types=')) return splitCsv(a.slice('--skip-types='.length));
        if (a === '--skip-types') {
            const v = args[i + 1];
            if (v === undefined || v.startsWith('--')) {
                console.error('--skip-types requires a comma-separated list');
                process.exit(1);
            }
            return splitCsv(v);
        }
    }
    return [];
}

/** Value of `--prune-older-than <days>`; undefined when absent. */
function parsePruneOlderThan(args: string[]): number | undefined {
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        let raw: string | undefined;
        if (a.startsWith('--prune-older-than=')) raw = a.slice('--prune-older-than='.length);
        else if (a === '--prune-older-than') {
            raw = args[i + 1];
            if (raw === undefined || raw.startsWith('--')) {
                console.error('--prune-older-than requires a number of days');
                process.exit(1);
            }
        }
        if (raw !== undefined) {
            const n = Number(raw);
            if (!(Number.isFinite(n) && n > 0)) {
                console.error(`--prune-older-than requires a positive number of days, got "${raw}"`);
                process.exit(1);
            }
            return n;
        }
    }
    return undefined;
}

function splitCsv(v: string): string[] {
    return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

const HELP = `Usage: lore maintain storage [options]

Offline, one-time reclaim of versions.sqlite and/or outbox.sqlite. A default
run drops exact no-op (duplicate) version rows, prunes replicated outbox
rows past their retention window, then converts both files to
auto_vacuum=INCREMENTAL and runs a full VACUUM. It NEVER deletes version
history by age or by type unless you ask for it with --prune-older-than or
--skip-types below. The host that owns the data dir must be stopped first —
this refuses a held root when it can detect one.

  This refuses an IDLE host, not just one mid-write, on every data-dir
  layout: a bare versions.sqlite/outbox.sqlite pair, a SurrealDB-backed
  graph, or a SQLite-engine graph alike. Still, stop the host yourself
  first — this is a safety net, not a substitute for that.

  A dry run leaves both files' row data unchanged, but on a file written
  before this tool existed it still applies the same one-time schema
  upgrade the host's own next open would apply — so a dry run is not
  guaranteed byte-for-byte identical on disk. Back up first if that matters.

  --data-dir <path>   Target this createLore({ dataDir }) root instead of
                       LORE_HOME.
  --dry-run           Report rows/bytes reclaimable; writes nothing to
                       either SQLite file's row data (see the schema-upgrade
                       note above).
  --prune-older-than <days>
                       OPT-IN age-based deletion: also delete version rows
                       older than <days> days. Without this flag no version
                       row is deleted by age.
  --skip-types <csv>   OPT-IN type-based deletion: also drop ALL existing
                       version rows of these node types (same semantics as
                       createLore({ versionHistory: { skipTypes } })).
                       Without this flag no version row is deleted by type.
  --json              Emit the report as JSON instead of a table.`;

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return `${v.toFixed(2)} ${units[u]}`;
}

function printReport(result: ReclaimStorageResult): void {
    console.log('');
    console.log(`Storage reclaim — ${result.basePath}`);
    console.log(`  Mode: ${result.dryRun ? 'DRY-RUN (writes nothing)' : 'APPLY'}`);
    console.log('');
    for (const f of result.files) {
        if (!f.present) {
            console.log(`  ${f.file}: not present — skipped`);
            continue;
        }
        console.log(`  ${f.file}`);
        console.log(`    size before:  ${formatBytes(f.sizeBeforeBytes)}`);
        console.log(`    size after:   ${formatBytes(f.sizeAfterBytes)}${f.estimated ? ' (unchanged — dry-run)' : ''}`);
        console.log(`    reclaimed:    ${formatBytes(f.bytesReclaimed)}${f.estimated ? ' (estimated)' : ''}`);
        if (f.dedupedRows !== undefined) console.log(`    deduped rows (exact no-op):     ${f.dedupedRows}`);
        if (f.softCompactedRows !== undefined) console.log(`    soft-compacted rows (opt-in):  ${f.softCompactedRows}`);
        if (f.hardDeletedRows !== undefined) console.log(`    hard-deleted rows:               ${f.hardDeletedRows}`);
        if (f.prunedReplicatedRows !== undefined) console.log(`    pruned replicated rows:         ${f.prunedReplicatedRows}`);
        if (f.autoVacuumBefore !== null && f.autoVacuumAfter !== null) {
            console.log(`    auto_vacuum: ${f.autoVacuumBefore} → ${f.autoVacuumAfter}`);
        }
        console.log('');
    }
}

export async function maintainStorageCommand(args: string[]): Promise<void> {
    if (args.includes('--help') || args.includes('-h')) {
        console.log(HELP);
        return;
    }

    const dataDir = parseDataDir(args);
    const dryRun = args.includes('--dry-run');
    const asJson = args.includes('--json');
    const skipTypes = parseSkipTypes(args);
    const pruneOlderThanDays = parsePruneOlderThan(args);

    const { reclaimStorage, ReclaimDataDirInUseError, ReclaimInsufficientDiskSpaceError } =
        await import('../../outbox/reclaimStorage.js');

    let result: ReclaimStorageResult;
    try {
        result = await reclaimStorage({
            dataDir,
            dryRun,
            skipTypes: skipTypes.length > 0 ? skipTypes : undefined,
            pruneOlderThanDays,
        });
    } catch (err) {
        if (err instanceof ReclaimDataDirInUseError) {
            console.error('');
            console.error(err.message);
            console.error('');
            console.error('Stop (or dispose the Lore instance of) the host that owns this data directory, then re-run:');
            console.error('');
            console.error(`  lore maintain storage${dataDir ? ` --data-dir ${dataDir}` : ''}`);
            process.exit(1);
        }
        if (err instanceof ReclaimInsufficientDiskSpaceError) {
            console.error('');
            console.error(err.message);
            process.exit(1);
        }
        throw err;
    }

    if (asJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    printReport(result);
}

export type { ReclaimStorageResult, ReclaimFileReport };
