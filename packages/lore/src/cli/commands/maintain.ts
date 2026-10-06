/**
 * maintain.ts — `lore maintain` CLI (capacity management).
 *
 * Config-driven maintenance over a Lore store: LanceDB compaction +
 * version cleanup, cold-node retention, and ephemeral-workspace expiry.
 * Everything is driven by policy (defaults → LORE_MAINTAIN_* env → CLI
 * flags); nothing is hardcoded.
 *
 * Modes:
 *   --dry-run   report only — counts, reclaimable bytes, affected items.
 *   (default)   perform + print a summary.
 *
 * Exit code:
 *   0  every enabled step completed (or was skipped without error).
 *   1  refused / bad policy, OR an enabled step recorded errors (3.26.0;
 *      before that a failed step printed `FAILED:` and still exited 0).
 *
 * Safety:
 *   Like `lore compact`, this refuses to run while the daemon is up,
 *   because opening a second graph handle (single-writer) risks
 *   corruption. For ONLINE maintenance, use the in-process MCP `maintain`
 *   tool instead — it runs inside the daemon and is online-safe.
 *   `--force` bypasses the preflight (tests only).
 *
 * Scope:
 *   lore maintain [<workspace>]   single workspace (default: active)
 *   lore maintain --all           every registered workspace
 *
 * Flags (all optional; override env + defaults):
 *   --dry-run
 *   --retention-days <n>
 *   --cleanup-versions-older-than <dur>   e.g. 7d, 168h
 *   --compact-threshold <n>
 *   --ephemeral-ttl-days <n>
 *   --ephemeral-patterns <csv>
 *   --protect-tags <csv>
 *   --node-action archive|delete
 *   --no-compaction | --no-version-cleanup | --no-node-retention | --no-ephemeral
 *   --orphan-alias-sweep   (3.27.1, opt-in) purge question-alias rows whose parent node is gone
 *   --json
 *   --force
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseOrExit, type ArgSpec, type ParsedArgs } from '../args.js';
import { runCliOrphanAliasSweep } from './maintainOrphanAliasSweep.js';
import { openWorkspaceGraph } from '../../engines/openWorkspaceGraph.js';
import { getWorkspacePath, listWorkspaceNames, getActiveWorkspaceName } from '../../config/workspaces.js';
import { loreHome } from '../../config/loreHome.js';
import { isDaemonServingHome, daemonRefuseMessage, otherDaemonRefuseMessage } from './migrateWorkspaceToWorkspaceShared.js';
import { probeSurrealLock } from '../../engines/surreal/surrealSettle.js';
import { surrealDataPath } from '../../engines/surreal/surrealConnection.js';
import {
    resolveMaintainPolicy,
    runMaintenance,
    failedOperations,
    formatMaintainReport,
    parseDuration,
    parseList,
    LanceMaintainer,
    GraphNodeStore,
    WorkspaceRegistry,
    AlwaysSafe,
    type MaintainPolicy,
    type MaintainPolicyOverrides,
    type MaintainReport,
    type GraphLike,
} from '../../engines/maintain/index.js';

const MAINTAIN_SPEC: ArgSpec = {
    bool: [
        '--dry-run', '--all', '--force', '--json', '--orphan-alias-sweep',
        '--no-compaction', '--no-version-cleanup', '--no-node-retention', '--no-ephemeral',
    ],
    value: [
        '--retention-days', '--cleanup-versions-older-than', '--compact-threshold',
        '--ephemeral-ttl-days', '--ephemeral-patterns', '--protect-tags', '--node-action',
        '--cold-signal',
    ],
    positionals: { max: 1 },
    aliases: { '-h': '--help' },
    help: true,
};

function buildOverrides(args: ParsedArgs): MaintainPolicyOverrides {
    const o: MaintainPolicyOverrides = {};
    const rd = args.get('--retention-days');
    if (rd !== undefined) o.retentionDays = Number(rd);
    const cv = args.get('--cleanup-versions-older-than');
    if (cv !== undefined) o.cleanupVersionsOlderThanMs = parseDuration(cv);
    const ct = args.get('--compact-threshold');
    if (ct !== undefined) o.compactFragmentThreshold = Number(ct);
    const et = args.get('--ephemeral-ttl-days');
    if (et !== undefined) o.ephemeralWorkspaceTtlDays = Number(et);
    const ep = args.get('--ephemeral-patterns');
    if (ep !== undefined) o.ephemeralWorkspacePatterns = parseList(ep);
    const pt = args.get('--protect-tags');
    if (pt !== undefined) o.protectTags = parseList(pt);
    const na = args.get('--node-action');
    if (na === 'archive' || na === 'delete') o.nodeRetentionAction = na;
    const cs = args.get('--cold-signal');
    if (cs === 'retrieval' || cs === 'access' || cs === 'update') o.coldSignal = cs;
    const enabled: NonNullable<MaintainPolicyOverrides['enabled']> = {};
    if (args.has('--no-compaction')) enabled.compaction = false;
    if (args.has('--no-version-cleanup')) enabled.versionCleanup = false;
    if (args.has('--no-node-retention')) enabled.nodeRetention = false;
    if (args.has('--no-ephemeral')) enabled.ephemeralExpiry = false;
    if (Object.keys(enabled).length > 0) o.enabled = enabled;
    return o;
}

function clonePolicy(policy: MaintainPolicy, enabledPatch: Partial<MaintainPolicy['enabled']>): MaintainPolicy {
    return { ...policy, enabled: { ...policy.enabled, ...enabledPatch } };
}

const HELP = `Usage: lore maintain [<workspace>] [options]
       lore maintain storage [--data-dir <path>] [--dry-run] [--skip-types <csv>] [--json]
       lore maintain cloud-purge (--list | --id <workspace-id> [--apply]) [options]

Config-driven capacity maintenance. Refuses while the daemon is up; for
online maintenance use the in-process MCP \`maintain\` tool.

\`lore maintain storage\` is a separate, offline tool (storage-growth fix
3/3): a one-time reclaim of versions.sqlite/outbox.sqlite via dedup +
retention pruning + a full VACUUM. Run \`lore maintain storage --help\` for
its own flags.

\`lore maintain cloud-purge\` (cloud mode only) deletes the Dataplane rows of a
workspace deleted from this instance; dry run by default. Run
\`lore maintain cloud-purge --help\` for its flags, refusals and exit codes.

  --dry-run                            Report only — no writes.
  --all                                Run across every registered workspace.
  --retention-days <n>                 Cold-node age threshold (default 90).
  --cleanup-versions-older-than <dur>  LanceDB version cutoff (default 7d).
  --compact-threshold <n>              Min fragments to compact (default 200).
  --ephemeral-ttl-days <n>             Ephemeral workspace TTL (default 14).
  --ephemeral-patterns <csv>           Default: e2e-*,*-smoke,*-test
  --protect-tags <csv>                 Never touched (default: pinned,protected).
  --node-action archive|delete         Retention action (default archive).
  --cold-signal retrieval|access|update  Recency clock for "cold" (default retrieval).
  --no-compaction --no-version-cleanup --no-node-retention --no-ephemeral
  --orphan-alias-sweep                 Also purge orphaned question-alias rows (parent node gone).
                                       Honours --dry-run. Opens the graph + verbatim store.
  --json                               Emit the raw report as JSON.
  --force                              Bypass the daemon preflight (tests only).

Exit code: 0 on success; 1 when refused, or when an enabled step reported errors
(the report is still printed, with a FAILED: line).`;

export async function maintainCommand(args: string[]): Promise<void> {
    // Storage-growth fix 3/3 (Fix 5) — `lore maintain storage [--data-dir
    // <path>] [--dry-run] [--skip-types a,b] [--json]`: the offline
    // versions.sqlite/outbox.sqlite reclaim tool. Same sub-dispatch shape as
    // `migrate.ts`'s `piece-vectors` target — inspected before any of this
    // command's own flag parsing, since it is a wholly separate tool with
    // its own preflight (reclaimStorage()'s own held-root probe), not a mode
    // of the LanceDB/graph maintenance below.
    if (args[0] === 'storage') {
        const { maintainStorageCommand } = await import('./maintainStorage.js');
        await maintainStorageCommand(args.slice(1));
        return;
    }

    // Cloud purge: deletes the Dataplane rows of a deleted workspace (dry run by default). Separate tool,
    // own flags and refusals; touches no local store, so it needs no daemon preflight.
    if (args[0] === 'cloud-purge') {
        const { cloudPurgeCommand } = await import('./maintainCloudPurge.js');
        await cloudPurgeCommand(args.slice(1));
        return;
    }

    const parsed = parseOrExit('maintain', args, MAINTAIN_SPEC, { usage: () => console.error(HELP) });
    if (parsed.help) {
        console.log(HELP);
        return;
    }

    const dryRun = parsed.has('--dry-run');
    const asJson = parsed.has('--json');
    const all = parsed.has('--all');
    const force = parsed.has('--force');
    const positional = parsed.positionals[0];

    let policy: MaintainPolicy;
    try {
        policy = resolveMaintainPolicy(buildOverrides(parsed));
    } catch (err) {
        console.error(`[maintain] bad policy: ${(err as Error).message}`);
        process.exit(1);
        return;
    }

    // Preflight: a running daemon is a second writer — refuse (offline tool).
    // RA2-reaudit2 — dry-run ALSO opens a graph write handle (to compute the
    // plan), so it conflicts with a running daemon too; preflight regardless of
    // dryRun. For online maintenance use the in-daemon MCP `maintain` tool.
    if (force) {
        // Round E4, 2026-09-03 (finding, low) — --force silently skipped
        // every check below (this preflight and the per-workspace graph
        // store check further down) with no signal at the moment it did
        // so. Print the bypass itself, once, for the whole run.
        console.error('proceeding with --force; daemon/lock checks skipped');
    } else {
        // Round E2, 2026-09-03 — isDaemonUp() alone refused whenever ANY
        // process answered 200 on the port, never checking it served THIS
        // home; isDaemonServingHome() only reports true when the daemon's
        // own Bearer-authenticated /api/health confirms it.
        const probe = await isDaemonServingHome(loreHome());
        if (probe.servesHome) {
            console.error(daemonRefuseMessage('lore maintain'));
            console.error('For online maintenance, call the MCP `maintain` tool (runs inside the daemon).');
            process.exit(1);
            return;
        }
        // Round E3, 2026-09-03 (finding, high, shared with `lore compact`) —
        // `servesHome: false` was treated as "safe to proceed" even when it
        // was false only because a stale/rejected CLI token kept this
        // preflight from confirming a LIVE same-home daemon.
        // `otherDaemonReachable` means "not proven ours", not "proven
        // safe" — refuse the same as a confirmed same-home daemon unless
        // overridden.
        if (probe.otherDaemonReachable) {
            console.error(otherDaemonRefuseMessage('lore maintain'));
            console.error('For online maintenance, call the MCP `maintain` tool (runs inside the daemon).');
            process.exit(1);
            return;
        }
    }

    const targets = all ? listWorkspaceNames() : [positional ?? getActiveWorkspaceName()];
    const reports: MaintainReport[] = [];

    // Per-workspace: LanceDB + node retention (ephemeral expiry handled once below).
    // Open the graph ONLY when node retention is actually requested — otherwise
    // a LanceDB-only run would race the daemon's single-writer graph handle (the
    // exact case dry-run users hit while the daemon is up).
    const orphanSweep = parsed.has('--orphan-alias-sweep');
    let sweepFailed = false;
    const needGraph = policy.enabled.nodeRetention || orphanSweep;
    for (const name of targets) {
        let wsPath: string;
        try {
            // Explicit `loreHome()` (Defect 3, 3.20.2): the CLI always runs as
            // its own process, so this is the process-wide home either way —
            // spelled out so it doesn't silently drift if `getWorkspacePath`'s
            // default ever changes.
            wsPath = getWorkspacePath(name, loreHome());
        } catch (err) {
            console.error(`[maintain] ${(err as Error).message}`);
            continue;
        }

        // Second layer, regardless of needGraph (finding, high, round E3,
        // 2026-09-03): the preflight above is one LORE_PORT probe for the
        // whole command and can miss a real holder (stale/rejected token,
        // wrong port, a probe timeout). When node retention is on,
        // `openWorkspaceGraph(...).initialize()` below opens the graph
        // store directly and would hit that holder's real on-disk lock as
        // a fallback — but on the needGraph=false path (compaction,
        // version cleanup, ephemeral expiry with node retention off)
        // nothing else opens anything before LanceDB compaction runs. A
        // daemon holds this workspace's SurrealDB graph store open
        // whenever it holds ANY of the workspace's substrates (including
        // LanceDB), so probing the graph store's own lock catches a
        // holder the port probe missed, before compaction/version-cleanup
        // touches a table it might be writing to.
        //
        // Round E4, 2026-09-03 (finding, high, LanceDB-only path only —
        // when needGraph is true, openWorkspaceGraph(...).initialize()
        // below opens/creates the graph store directly right after this,
        // which is the real safety net for that path): probeSurrealLock's
        // absent-directory fast path reports `free: true` BY DESIGN
        // (probing would CREATE the store) — but on the needGraph=false
        // path that made a workspace whose LanceDB tables were populated
        // by something that never touched the graph store (bypassing the
        // daemon's routing entirely) indistinguishable from "nothing here
        // at all". With no graph store to probe and nothing about to open
        // one, this CLI has no way to prove nothing else is writing to
        // lancedb/ — refuse rather than assume safety.
        if (!force) {
            if (!needGraph && !fs.existsSync(surrealDataPath(wsPath))) {
                console.error(`[maintain] no graph store to probe for workspace "${name}" (${wsPath}); cannot verify nothing else is writing to lancedb/ — skipping.`);
                console.error('  Pass --force if you are CERTAIN nothing else is writing to this workspace.');
                continue;
            }
            const lock = await probeSurrealLock(wsPath);
            if (!lock.free) {
                console.error(`[maintain] the graph store for workspace "${name}" (${wsPath}) is locked by another process — skipping.`);
                console.error(`  detail: ${lock.detail}`);
                console.error('  While something else holds it, LanceDB compaction/version-cleanup risks racing a live writer');
                console.error('  and corrupting the store. Stop whatever holds it and retry, or pass --force if you are');
                console.error('  CERTAIN nothing is writing to this workspace.');
                continue;
            }
        }

        const graph = needGraph ? openWorkspaceGraph(wsPath, { workspaceId: name }) : null;
        try {
            if (graph) await graph.initialize();
            const perWsPolicy = clonePolicy(policy, { ephemeralExpiry: false });
            const report = await runMaintenance(perWsPolicy, {
                lance: new LanceMaintainer(path.join(wsPath, '.lore', 'lancedb')),
                ...(graph ? { nodes: new GraphNodeStore(graph as unknown as GraphLike) } : {}),
                safety: new AlwaysSafe(),
            }, { dryRun, scopeLabel: `workspace:${name}`, onProgress: asJson ? undefined : (l) => console.log(`  ${l}`) });
            reports.push(report);
            if (orphanSweep) {
                // 3.27.1 — opt-in sweep of question-alias rows left behind by 3.27.0 deletes.
                const sweep = await runCliOrphanAliasSweep(name, wsPath, graph, dryRun);
                const line = `orphan-alias-sweep ${name}: scanned=${sweep.scanned} orphans=${sweep.orphans} purged=${sweep.purged} skippedPending=${sweep.skippedPending} skippedTombstoned=${sweep.skippedTombstoned} truncated=${sweep.truncated}${dryRun ? ' (dry run)' : ''}`;
                (asJson ? console.error : console.log)(`  ${line}`);
                for (const e of sweep.errors) console.error(`[maintain] ${e}`);
                if (sweep.errors.length > 0) sweepFailed = true;
            }
        } finally {
            if (graph) {
                const maybeClose = (graph as unknown as { close?: () => void }).close;
                if (typeof maybeClose === 'function') { try { maybeClose.call(graph); } catch { /* best effort */ } }
            }
        }
    }

    // Store-level: ephemeral workspace expiry (runs once, not per workspace).
    if (policy.enabled.ephemeralExpiry) {
        const storePolicy = clonePolicy(policy, {
            compaction: false, versionCleanup: false, nodeRetention: false, ephemeralExpiry: true,
        });
        const report = await runMaintenance(storePolicy, {
            // Explicit `loreHome()` (Defect 3, 3.20.2) — same reasoning as above.
            workspaces: new WorkspaceRegistry(undefined, loreHome()),
            safety: new AlwaysSafe(),
        }, { dryRun, scopeLabel: 'store:ephemeral-workspaces', onProgress: asJson ? undefined : (l) => console.log(`  ${l}`) });
        reports.push(report);
    }

    if (asJson) {
        console.log(JSON.stringify(reports, null, 2));
    } else {
        for (const r of reports) {
            console.log('');
            console.log(formatMaintainReport(r, policy));
        }
    }

    // 3.26.0 — a run whose enabled step recorded errors exits non-zero, so a
    // cron job or a wrapper script sees the failure the MCP tool already
    // reports as `ok: false` (3.25.2). The reports are printed first, in full.
    // `--json` keeps stdout a plain reports array; the summary goes to stderr.
    const failed: string[] = [...failedOperations(reports)];
    if (sweepFailed) failed.push('orphanAliasSweep');
    if (failed.length > 0) {
        if (asJson) console.error(`[maintain] FAILED: ${failed.join(', ')}`);
        process.exit(1);
    }
}
