/**
 * cli/commands/outboxRequeue.ts — `lore outbox requeue-dead`.
 *
 * Returns `status='dead'` outbox rows to the retry queue. Its own module (not
 * appended to outbox.ts) per the file-size budget in CLAUDE.md: one concern per
 * file, and outbox.ts is already near the 500-line target.
 *
 * WHY THIS EXISTS. `drain-failed` cannot re-dispatch anything — it probes the
 * substrate and then either confirms a row replicated or re-marks it dead. That
 * is the right tool when the ROW is the problem. It is the wrong tool when the
 * BUILD was the problem: the payloads are intact and correct, and once the
 * defect is fixed they apply cleanly. Written for the 3.17.0 parent-embeds
 * regression (`Found field not in schema: metadata.type`), which dead-lettered
 * ~3,000 individually-valid rows across 11 workspaces over seven days.
 *
 * ORDER OF OPERATIONS. Requeueing before the defect is fixed accomplishes
 * nothing: the rows fail again, burn their attempts and dead-letter a second
 * time. Deploy the fixed build FIRST, then requeue.
 *
 * SAFETY. Rows return as `'failed'`, not `'pending'` — see the
 * OutboxStore.requeueDead contract for why that is load-bearing (the RA-6
 * supersession guard, which stops a stale row overwriting a newer same-entity
 * write, only runs on 'failed'). The filters are not a convenience: a
 * dead-letter queue also holds rows that are dead for GOOD reasons — RA-6
 * supersessions, genuinely malformed payloads — so narrow to the incident you
 * are recovering with --error-contains / --kind rather than requeueing
 * wholesale. `--dry-run` is the default posture for a first look.
 *
 * SQLite-only: no graph store is opened, so this is safe to run alongside a
 * live daemon (the same property `drain-failed --no-check-substrate` relies on;
 * the mutation is a single UPDATE in WAL mode).
 *
 * Usage:
 *   lore outbox requeue-dead --dry-run
 *   lore outbox requeue-dead --error-contains "metadata.type"
 *   lore outbox requeue-dead --workspace groundfloor-atlas --kind verbatim.upsert
 */

import fs from 'node:fs';
import path from 'node:path';

import { loreHome } from '../../config/loreHome.js';
import { getActiveWorkspacePath } from '../../config/workspaces.js';
import type { OutboxEntry, OutboxStore } from '../../outbox/types.js';

export interface RequeueFlags {
    /** Absolute path to a `.lore/` directory, for embedded hosts (see --lore-dir). */
    loreDir?: string;
    workspace?: string;
    operationKind?: string;
    errorContains?: string;
    limit: number;
    dryRun: boolean;
    help: boolean;
}

const DEFAULT_LIMIT = 5000;

/** Exported for the unit test — flag parsing is the part worth pinning down
 *  without spinning up a store. */
export function parseRequeueFlags(args: string[]): RequeueFlags {
    const flags: RequeueFlags = { limit: DEFAULT_LIMIT, dryRun: false, help: false };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--help' || a === '-h') flags.help = true;
        else if (a === '--dry-run') flags.dryRun = true;
        else if (a === '--lore-dir') flags.loreDir = args[++i];
        else if (a === '--workspace') flags.workspace = args[++i];
        else if (a === '--kind') flags.operationKind = args[++i];
        else if (a === '--error-contains') flags.errorContains = args[++i];
        else if (a === '--limit') {
            const n = Number.parseInt(args[++i] ?? '', 10);
            if (Number.isFinite(n) && n > 0) flags.limit = n;
        }
    }
    return flags;
}

export const REQUEUE_HELP = `
lore outbox requeue-dead — return dead-lettered outbox rows to the retry queue.

Usage:
  lore outbox requeue-dead [--workspace <ws>] [--kind <operationKind>]
                           [--error-contains <text>] [--limit <n>] [--dry-run]

Flags:
  --lore-dir <path>       Absolute path to the '.lore/' directory holding the
                          outbox. REQUIRED for embedded hosts (see below).
  --workspace <ws>        Only rows for this workspace (default: all).
  --kind <kind>           Only this operationKind, e.g. verbatim.upsert.
  --error-contains <text> Only rows whose lastError contains this text.
                          The match is literal — % and _ are not wildcards.
  --limit <n>             Cap rows requeued (default ${DEFAULT_LIMIT}).
  --dry-run               Report what WOULD be requeued; change nothing.

When to use this:
  A dead-letter means the replicator exhausted its retries. That is the right
  outcome when the ROW is bad. It is the wrong outcome when the BUILD was bad —
  a defect that rejected every write of a given shape leaves a queue full of
  payloads that are perfectly valid and will apply cleanly once fixed.

  Deploy the fixed build FIRST. Requeueing beforehand just burns the retries
  again and re-dead-letters the same rows.

  Narrow with --error-contains / --kind. The dead-letter queue also holds rows
  that are dead for good reasons (superseded writes, malformed payloads);
  requeueing it wholesale would replay those too.

Rows return as 'failed' rather than 'pending' so the replicator's supersession
guard still runs — a week-old row must never overwrite a newer write to the
same node. Attempts reset to 0 and the backoff clears, so the next replicator
tick picks them up.

Embedded hosts (--lore-dir):
  Without --lore-dir this resolves the outbox the way the DAEMON lays it out:
  <LORE_HOME>/workspaces/<active>/.lore/. An embedded host does not use that
  layout — it opens one Lore per workspace at its own dataDir, so there is no
  "active workspace" and no workspaces.json to consult. Atlas, for example,
  keeps every workspace under <ATLAS_HOME>/lore-data/<workspace>/.lore/.

  Point --lore-dir at one such directory. Each is an independent outbox, so an
  incident spanning several workspaces means one invocation per directory:

    for ws in a b c; do
      lore outbox requeue-dead --lore-dir "$ATLAS_HOME/lore-data/$ws/.lore" \
        --error-contains "metadata.type"
    done

SQLite-only — opens no graph store, safe to run with the daemon up.

Examples:
  lore outbox requeue-dead --dry-run
  lore outbox requeue-dead --error-contains "metadata.type"
  lore outbox requeue-dead --lore-dir ~/.groundfloor/atlas/lore-data/myws/.lore --dry-run
`.trim();

/** Group dead rows for the operator summary — which workspaces and which error
 *  classes are in scope, so a wholesale requeue is visibly a wholesale one. */
export function summarizeDead(rows: OutboxEntry[]): {
    byWorkspace: Record<string, number>;
    byError: Record<string, number>;
    byKind: Record<string, number>;
} {
    const byWorkspace: Record<string, number> = {};
    const byError: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    for (const r of rows) {
        const ws = r.workspace || '(none)'; // workspace is optional on legacy rows
        byWorkspace[ws] = (byWorkspace[ws] ?? 0) + 1;
        const kind = r.operationKind || '(none)';
        byKind[kind] = (byKind[kind] ?? 0) + 1;
        const err = (r.lastError ?? '(no error recorded)').slice(0, 80);
        byError[err] = (byError[err] ?? 0) + 1;
    }
    return { byWorkspace, byError, byKind };
}

function printTable(title: string, counts: Record<string, number>): void {
    console.log(`  ${title}`);
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    for (const [k, n] of entries) console.log(`    ${String(n).padStart(6)}  ${k}`);
    if (entries.length === 0) console.log('    (none)');
}

export async function requeueDeadSubcommand(args: string[]): Promise<void> {
    const flags = parseRequeueFlags(args);
    if (flags.help) {
        console.log(REQUEUE_HELP);
        return;
    }

    // Lazy import — keeps `--help` fast (the drain-failed pattern).
    const { wireOutbox } = await import('../../outbox/wiring.js');

    // --lore-dir addresses an outbox directly. Embedded hosts NEED it: they open
    // one Lore per workspace at its own dataDir, so there is no active workspace
    // and no workspaces.json, and the daemon-shaped resolution below would point
    // at a home that holds none of their data (or, post-teardown, at nothing at
    // all). Verified against Atlas, which keeps every workspace under
    // <ATLAS_HOME>/lore-data/<workspace>/.lore/ — 11 independent outboxes.
    //
    // Without it, L-004 applies: the outbox SQLite lives in the ACTIVE
    // workspace's .lore/, the daemon-wide store. That must NOT follow
    // --workspace, or we would open a different (or spurious) outbox.sqlite;
    // --workspace filters ROWS, not which database is opened.
    const loreDir = flags.loreDir
        ? path.resolve(flags.loreDir)
        : path.join(getActiveWorkspacePath(loreHome()), '.lore');

    if (!fs.existsSync(path.join(loreDir, 'outbox.sqlite'))) {
        console.error(`  No outbox.sqlite under ${loreDir}`);
        console.error(flags.loreDir
            ? '  Check the --lore-dir path points at a .lore/ directory.'
            : '  An embedded host (e.g. Atlas) needs --lore-dir — it has no active workspace.');
        process.exitCode = 1;
        return;
    }

    // SQLite-only, deliberately: no getGraph, so nothing here can contend with a
    // daemon holding a graph store (see this file's header).
    const { store } = wireOutbox({
        loreDir,
        getSyncEngine: () => {
            throw new Error('outbox requeue-dead: syncEngine is not used on this path');
        },
    }) as { store: OutboxStore };

    console.log('');
    console.log(`  lore outbox requeue-dead — outbox=${loreDir}`);
    console.log(`    workspace=${flags.workspace ?? '*'}`
        + `  kind=${flags.operationKind ?? '*'}`
        + `  errorContains=${flags.errorContains ?? '*'}`
        + `  limit=${flags.limit}  dryRun=${flags.dryRun}`);
    console.log('');

    if (typeof store.listDead !== 'function' || typeof store.requeueDead !== 'function') {
        console.error('  This outbox store does not support dead-letter requeue.');
        process.exitCode = 1;
        return;
    }

    // Report on the SELECTED rows, not the whole dead queue — the operator needs
    // to see what their filters actually matched before anything moves.
    const all = await store.listDead({ workspace: flags.workspace ?? null, limit: flags.limit });
    const selected = all.filter((r) => (
        (!flags.operationKind || r.operationKind === flags.operationKind)
        && (!flags.errorContains || (r.lastError ?? '').includes(flags.errorContains))
    ));

    if (selected.length === 0) {
        console.log('  No dead rows match those filters — nothing to requeue.');
        return;
    }

    const { byWorkspace, byError, byKind } = summarizeDead(selected);
    console.log(`  ${selected.length} dead row(s) selected` + (all.length !== selected.length
        ? ` (of ${all.length} dead row(s) read)` : ''));
    console.log('');
    printTable('by workspace:', byWorkspace);
    console.log('');
    printTable('by operation kind:', byKind);
    console.log('');
    printTable('by last error:', byError);
    console.log('');

    if (flags.dryRun) {
        console.log('  --dry-run: nothing was changed.');
        console.log('  Re-run without --dry-run to requeue these rows.');
        return;
    }

    const n = await store.requeueDead({
        workspace: flags.workspace ?? null,
        operationKind: flags.operationKind,
        errorContains: flags.errorContains,
        limit: flags.limit,
    });
    console.log(`  Requeued ${n} row(s) as 'failed' with attempts reset.`);
    console.log('  The replicator picks them up on its next tick; watch the log for');
    console.log('  fresh dead-letters, which would mean the underlying defect is still live.');
}
