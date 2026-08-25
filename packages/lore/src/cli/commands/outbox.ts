/**
 * cli/commands/outbox.ts — Sprint O6 (2026-05-24).
 *
 * `lore outbox <subcommand>` — operator-facing outbox recovery surface.
 *
 * Today's only subcommand is `drain-failed`, which sweeps `status='failed'`
 * (and optionally `status='dead'`) outbox rows, probes substrate via the
 * dispatcher's `verifyApplied` hook, and either flips already-replicated
 * rows to 'replicated' (recovered) or marks them dead. Replaces the
 * manual SQL UPDATE workaround documented in
 * BACKLOG-outbox-replicator-duplicate-retry-artifact.md.
 *
 * Usage:
 *   lore outbox drain-failed [--workspace <ws>] [--check-substrate]
 *                            [--mark-dead] [--dry-run]
 *
 * The job opens the same SQLite outbox + LocalGraph/VerbatimStore the
 * daemon uses; it does NOT require the daemon to be running. If the
 * daemon IS running, this CLI is safe to invoke concurrently — the
 * underlying markEntryStatus mutation is a single UPDATE in WAL mode,
 * and the self-heal tick is idempotent against the same row being
 * recovered twice (the second call simply sees status='replicated' and
 * makes no change).
 */

import path from 'node:path';
import type { WorkspaceGraph } from '../../engines/openWorkspaceGraph.js';

import { loreHome } from '../../config/loreHome.js';
import { getActiveWorkspacePath, getActiveWorkspaceName } from '../../config/workspaces.js';

/**
 * Sprint O6 — DrainFlags shape. Exported for testability (the unit
 * test in test/O6-drain-cli-unit.ts asserts the defaults + parse
 * results directly so we don't have to spin a LocalGraph in CI).
 */
export interface DrainFlags {
    workspace?: string;
    checkSubstrate: boolean;
    markDead: boolean;
    dryRun: boolean;
    limit?: number;
    help: boolean;
}

export function parseDrainFlags(args: string[]): DrainFlags {
    // Defaults per spec: check-substrate=true (the safe / recovering
    // mode), mark-dead=false (operator must opt-in to destructive
    // marker), dry-run=false (default is to actually mutate).
    const out: DrainFlags = {
        checkSubstrate: true,
        markDead: false,
        dryRun: false,
        help: false,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--help' || a === '-h') { out.help = true; continue; }
        if (a === '--dry-run') { out.dryRun = true; continue; }
        if (a === '--check-substrate') { out.checkSubstrate = true; continue; }
        if (a === '--no-check-substrate') { out.checkSubstrate = false; continue; }
        if (a === '--mark-dead') { out.markDead = true; continue; }
        if (a === '--workspace' && i + 1 < args.length) { out.workspace = args[++i]; continue; }
        if (a === '--limit' && i + 1 < args.length) {
            const n = parseInt(args[++i], 10);
            if (Number.isFinite(n) && n > 0) out.limit = n;
            continue;
        }
    }
    return out;
}

/**
 * L-004 — minimal engine-aware registry surface the drain-failed wiring needs.
 * Lets the unit test inject a recording fake without spinning a real graph.
 * `getGraphHandle` is the graph-substrate accessor: it returns the engine the
 * workspace declares, unlike `getOrOpen`, which is the Kùzu-only substrate.
 */
export interface DrainGraphRegistry<G = WorkspaceGraph> {
    getGraphHandle(workspace: string): Promise<G>;
}
/**
 * Build the `wireOutbox` input object for drain-failed. Exported + pure so the
 * unit test can assert that a non-default `--workspace` causes a
 * `getGraphForWorkspace` resolver to be threaded (the L-004 fix) WITHOUT opening
 * real substrates. `getGraph` returns the pre-opened boot graph (sync, per the
 * wireOutbox boot-fallback contract); `getGraphForWorkspace` routes each row's
 * probe to its OWN workspace's graph via the registry.
 */
export function buildDrainWiringInput<G>(opts: {
    loreDir: string;
    bootGraph: G;
    registry: DrainGraphRegistry<G>;
}): {
    loreDir: string;
    getSyncEngine: () => never;
    getGraph: () => G;
    getGraphForWorkspace: () => (ws: string) => Promise<G>;
} {
    return {
        loreDir: opts.loreDir,
        getSyncEngine: () => {
            throw new Error('outbox drain-failed: syncEngine not needed for self-heal path');
        },
        getGraph: () => opts.bootGraph,
        // SP-F3 resolver convention: route each row's substrate probe to its OWN
        // workspace's graph instead of the boot-bound one.
        getGraphForWorkspace: () => (ws: string) => opts.registry.getGraphHandle(ws),
    };
}

const DRAIN_HELP = `
lore outbox drain-failed — recover or evict stuck failed outbox rows.

Usage:
  lore outbox drain-failed [options]

Options:
  --workspace <ws>      Restrict to one workspace (default: all)
  --check-substrate     Probe substrate per row before deciding (default true)
  --no-check-substrate  Skip substrate probe; pair with --mark-dead to evict
  --mark-dead           Mark every leftover failed row 'dead' after sweep
                        (only acts on rows the substrate probe could NOT
                        recover; the probe-recovered rows are flipped
                        to 'replicated' as usual)
  --dry-run             Report what WOULD change without writing
  --limit <N>           Cap sweep at N rows (default: replicator's
                        selfHealBatchSize = 256)
  -h, --help            Show this help

Behavior:
  drain-failed runs the same self-heal probe the daemon's replicator
  runs every selfHealIntervalMs seconds (default 60s). The CLI ignores
  the cadence gate AND the grace-period gate so it sweeps every
  'failed' row immediately (including 'dead' rows — handy for
  rescuing rows the replicator already gave up on before O6 shipped).

  For each row:
    - substrate confirms data is present → mark 'replicated' (recovered)
    - substrate confirms data is absent  → leave 'failed' (or mark
      'dead' when --mark-dead is set)
    - verifier hook unwired for kind     → leave 'failed' (the kind
      is not self-healable — operator may need manual intervention)

Examples:
  lore outbox drain-failed --dry-run
  lore outbox drain-failed --workspace default
  lore outbox drain-failed --workspace alpha --mark-dead
`.trim();

export async function outboxCommand(args: string[]): Promise<void> {
    const sub = args[0];
    const rest = args.slice(1);

    if (!sub || sub === '--help' || sub === '-h') {
        console.log(`
lore outbox — outbox operator commands.

Subcommands:
  drain-failed   Recover (or evict) stuck 'failed' outbox rows.

Run 'lore outbox drain-failed --help' for details.
`.trim());
        return;
    }

    switch (sub) {
        case 'drain-failed':
            await drainFailedSubcommand(rest);
            break;
        default:
            console.error(`Unknown 'lore outbox' subcommand: '${sub}'`);
            console.error(`Run 'lore outbox --help' for the list.`);
            process.exit(1);
    }
}

async function drainFailedSubcommand(args: string[]): Promise<void> {
    const flags = parseDrainFlags(args);
    if (flags.help) {
        console.log(DRAIN_HELP);
        return;
    }

    // Lazy imports — keeps `--help` fast and matches the embed.ts
    // pattern. Construct the graph + outbox wiring in the same shape
    // the daemon uses so the verifier hooks the replicator runs are
    // bit-identical to the ones drain-failed exercises.
    const { LocalGraphRegistry } = await import('../../engines/localGraphRegistry.js');
    const { wireOutbox } = await import('../../outbox/wiring.js');

    const home = loreHome();
    // L-004 — the outbox SQLite lives in the ACTIVE workspace's .lore/
    // (daemon-wide store) — same loreDir the daemon's wireOutbox gets. This
    // must NOT change to the requested workspace, or we'd open a different /
    // spurious outbox.sqlite.
    const activeBasePath = getActiveWorkspacePath(home);
    const loreDir = path.join(activeBasePath, '.lore');

    // Build a registry so per-row workspace resolution probes the CORRECT
    // declared graph engine, not the boot-bound Kùzu substrate. Previously
    // drain-failed called getOrOpen for both the boot graph and row resolver;
    // on a Surreal-backed workspace that opened the real but EMPTY Kùzu graph,
    // producing false negatives and potentially marking valid rows dead.
    // The CLI is offline (no daemon), so autoEvict=false — we close() manually.
    const registry = new LocalGraphRegistry({ home, autoEvict: false });

    // Pre-open the boot/active graph the verifier uses for legacy rows that have
    // no workspace tag. getGraph must return a synchronous WorkspaceGraph (the
    // wireOutbox boot-fallback contract), so we open it here and hand back the
    // resolved instance. For an explicit --workspace, the boot fallback short-
    // circuits to that workspace's own declared graph.
    const bootWsName = flags.workspace ?? getActiveWorkspaceName(home);
    const bootGraph = await registry.getGraphHandle(bootWsName);

    // wireOutbox returns the store + replicator wired with the self-heal
    // verifier hooks. We do NOT call replicator.start() — the CLI invokes
    // runSelfHealSweep directly with `force: true` so the cadence gate is
    // ignored AND the grace window is set to 0 (operators expect immediate
    // action). The wiring input is built by the exported helper so the L-004
    // routing is unit-testable.
    const wiring = wireOutbox(buildDrainWiringInput({ loreDir, bootGraph, registry }));

    console.log('');
    console.log(`  lore outbox drain-failed — workspace=${flags.workspace ?? '*'}`
        + `  checkSubstrate=${flags.checkSubstrate}`
        + `  markDead=${flags.markDead}`
        + `  dryRun=${flags.dryRun}`);

    let report;
    if (flags.checkSubstrate) {
        report = await wiring.replicator.runSelfHealSweep({
            force: true,
            graceMsOverride: 0,
            dryRun: flags.dryRun,
            workspace: flags.workspace ?? null,
            limit: flags.limit,
            // Operator drain — dead-letter rows ARE in scope here (audit
            // cluster 5: the routine self-heal tick must not get them).
            includeDead: true,
        });
    } else {
        // --no-check-substrate: skip the probe entirely. Used with
        // --mark-dead to forcibly evict every failed row from a
        // workspace whose substrate is known to be missing the data
        // (e.g. an aborted import). Without --mark-dead this is a
        // no-op; the CLI surfaces that explicitly.
        const listFn = (wiring.store as {
            listFailedOlderThan?: (ms: number, opts?: { workspace?: string | null; limit?: number; includeDead?: boolean }) => Promise<unknown[]>;
        }).listFailedOlderThan;
        const rows = typeof listFn === 'function'
            ? await listFn.call(wiring.store, 0, { workspace: flags.workspace ?? null, limit: flags.limit ?? 1024, includeDead: true })
            : [];
        report = {
            examined: rows.length, recovered: 0, leftFailed: rows.length,
            byWorkspace: {}, byOperationKind: {}, dryRun: flags.dryRun,
            details: rows.map((r) => {
                const e = r as { id: string; workspace?: string; operationKind?: string };
                return { id: e.id, workspace: e.workspace ?? 'unknown', operationKind: e.operationKind ?? 'unknown', verified: false, reason: 'check-substrate-skipped' };
            }),
        };
    }

    let deadMarked = 0;
    if (flags.markDead && !flags.dryRun) {
        // Mark every leftover-failed row dead so the daemon's
        // backpressure clears immediately. Recovered rows are already
        // 'replicated' by the self-heal sweep above.
        for (const d of report.details) {
            if (!d.verified) {
                try {
                    await wiring.store.markEntryStatus!(d.id, 'dead', { error: `drain-failed --mark-dead (reason=${d.reason})` });
                    deadMarked++;
                } catch (err) {
                    console.error(`  ! failed to mark ${d.id} dead: ${(err as Error).message}`);
                }
            }
        }
    }

    console.log('');
    console.log(`  examined:     ${report.examined}`);
    console.log(`  recovered:    ${report.recovered}${flags.dryRun ? '  (dry-run; nothing written)' : ''}`);
    console.log(`  left failed:  ${report.leftFailed}`);
    if (flags.markDead) {
        console.log(`  marked dead:  ${deadMarked}${flags.dryRun ? '  (dry-run; nothing written)' : ''}`);
    }

    if (Object.keys(report.byWorkspace).length > 0) {
        console.log('');
        console.log('  by workspace:');
        for (const [ws, counts] of Object.entries(report.byWorkspace)) {
            console.log(`    ${ws.padEnd(20)} recovered=${counts.recovered}  leftFailed=${counts.leftFailed}`);
        }
    }
    if (Object.keys(report.byOperationKind).length > 0) {
        console.log('');
        console.log('  by operation kind:');
        for (const [kind, counts] of Object.entries(report.byOperationKind)) {
            console.log(`    ${kind.padEnd(20)} recovered=${counts.recovered}  leftFailed=${counts.leftFailed}`);
        }
    }

    if (flags.dryRun && report.examined > 0) {
        console.log('');
        console.log('  (dry run — nothing was written. Re-run without --dry-run to commit.)');
    }

    // The registry owns every graph it opened (boot + any per-workspace graphs
    // the verifier resolved). The CLI is single-threaded and has awaited the
    // sweep above, so no verifier promise is still in flight here. disposeAll
    // physically closes every (unpinned) handle — in the offline CLI nothing is
    // pinned, so this releases the boot graph too (there is no daemon drain to
    // close it for us, unlike in the long-lived daemon).
    await registry.disposeAll();
}
