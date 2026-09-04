/**
 * maintain.ts — The `maintain` orchestrator (programmatic API).
 *
 * Runs config-driven capacity maintenance against a Lore store. Pure
 * orchestration: it reads a resolved MaintainPolicy, plans via the
 * side-effect-free selection helpers, then applies through narrow ports.
 *
 * Modes:
 *   dryRun: true  → report only. NO port mutation method is ever called.
 *   dryRun: false → perform + report before/after.
 *
 * Safety / isolation:
 *   - Destructive ops are skipped (status 'skipped-locked') when a write
 *     session is active and `allowOnline` is false.
 *   - Every table and every workspace is wrapped in try/catch so one
 *     failure never aborts the rest; failures are collected per op.
 *   - Idempotent: safe to run repeatedly (nightly cron).
 */

import type { MaintainPolicy, MaintainOperation } from './policy.js';
import type { MaintainPorts, LanceTableResult, PendingSidelineInfo } from './ports.js';
import { selectRetentionCandidates, selectEphemeralWorkspaces } from './selection.js';
import type { NodeForSelection } from './selection.js';

export interface RunMaintenanceOptions {
    dryRun: boolean;
    /** Allow destructive ops even when a write session is active. */
    allowOnline?: boolean;
    /** Injectable clock (ms) for deterministic tests. Defaults to Date.now(). */
    now?: number;
    /** Restrict to a single workspace label for reporting (informational). */
    scopeLabel?: string;
    /** Sink for progress lines; defaults to no-op. */
    onProgress?: (line: string) => void;
}

export interface OpStatus {
    operation: MaintainOperation;
    enabled: boolean;
    ran: boolean;
    skippedReason?: 'disabled' | 'locked' | 'no-port' | 'nothing-to-do';
    errors: string[];
}

export interface MaintainReport {
    dryRun: boolean;
    scopeLabel?: string;
    startedAtMs: number;
    durationMs: number;
    writeActive: boolean;
    operations: OpStatus[];
    lancedb: {
        tables: LanceTableResult[];
        totalBytesReclaimed: number;
        totalVersionsRemoved: number;
        /** Dry-run only: eligible old versions + on-disk bytes (reclaimable upper bound). */
        eligibleOldVersions: number;
        reclaimableBytesEstimate: number;
    };
    nodes: {
        inspected: number;
        protectedSkipped: number;
        recentSkipped: number;
        archived: number;
        deleted: number;
        candidates: number;
    };
    workspaces: {
        inspected: number;
        tooYoung: number;
        expired: string[];
        bytesFreed: number;
        /**
         * QA round 4, finding 3 — leftover `.pending-delete-*` sidelines from
         * a prior `delete()` whose final `rmSync` failed. Reported so an
         * operator can see accumulating leftover bytes; nothing here cleans
         * them up beyond the existing retry-on-next-delete-of-that-name path
         * in `WorkspaceRegistry.delete()`. Empty when the wired port doesn't
         * implement `pendingSidelines()`.
         */
        pendingSidelines: PendingSidelineInfo[];
    };
}

function emptyReport(opts: RunMaintenanceOptions, now: number): MaintainReport {
    return {
        dryRun: opts.dryRun,
        ...(opts.scopeLabel ? { scopeLabel: opts.scopeLabel } : {}),
        startedAtMs: now,
        durationMs: 0,
        writeActive: false,
        operations: [],
        lancedb: { tables: [], totalBytesReclaimed: 0, totalVersionsRemoved: 0, eligibleOldVersions: 0, reclaimableBytesEstimate: 0 },
        nodes: { inspected: 0, protectedSkipped: 0, recentSkipped: 0, archived: 0, deleted: 0, candidates: 0 },
        workspaces: { inspected: 0, tooYoung: 0, expired: [], bytesFreed: 0, pendingSidelines: [] },
    };
}

export async function runMaintenance(
    policy: MaintainPolicy,
    ports: MaintainPorts,
    options: RunMaintenanceOptions,
): Promise<MaintainReport> {
    const wallStart = Date.now();
    const now = options.now ?? wallStart;
    const log = options.onProgress ?? (() => {});
    const report = emptyReport(options, now);

    const writeActive = await ports.safety.writeActive();
    report.writeActive = writeActive;
    // Destructive ops are blocked while a write session is active unless
    // the caller explicitly opted into online mode. Dry-run is always safe.
    const destructiveBlocked = writeActive && !options.allowOnline && !options.dryRun;

    const opStatus = (operation: MaintainOperation): OpStatus => {
        const st: OpStatus = { operation, enabled: policy.enabled[operation], ran: false, errors: [] };
        report.operations.push(st);
        return st;
    };

    // ── 1. LanceDB compaction + 2. version cleanup ─────────────────────
    // Both ops share one optimize pass per table; toggled independently.
    {
        const compaction = opStatus('compaction');
        const versionCleanup = opStatus('versionCleanup');
        const wantCompact = compaction.enabled;
        const wantCleanup = versionCleanup.enabled;
        if (!ports.lance) {
            if (wantCompact) compaction.skippedReason = 'no-port';
            if (wantCleanup) versionCleanup.skippedReason = 'no-port';
        } else if (!wantCompact && !wantCleanup) {
            compaction.skippedReason = 'disabled';
            versionCleanup.skippedReason = 'disabled';
        } else {
            try {
                const probes = await ports.lance.probe(policy.cleanupVersionsOlderThanMs, now);
                for (const p of probes) {
                    report.lancedb.eligibleOldVersions += p.eligibleOldVersions;
                    report.lancedb.reclaimableBytesEstimate += p.bytes;
                }
                if (options.dryRun) {
                    log(`[dry-run] lancedb: ${probes.length} tables, ${report.lancedb.eligibleOldVersions} old versions eligible`);
                    if (wantCompact) compaction.ran = true;
                    if (wantCleanup) versionCleanup.ran = true;
                } else if (destructiveBlocked) {
                    compaction.skippedReason = 'locked';
                    versionCleanup.skippedReason = 'locked';
                } else {
                    for (const p of probes) {
                        const shouldCompact = wantCompact && p.fragments >= policy.compactFragmentThreshold;
                        // Run optimize when cleanup is wanted (any table) or
                        // when compaction is wanted AND threshold reached.
                        if (!wantCleanup && !shouldCompact) continue;
                        try {
                            const res = await ports.lance.optimizeTable(p.name, {
                                compact: shouldCompact,
                                ...(wantCleanup ? { cleanupOlderThanMs: policy.cleanupVersionsOlderThanMs } : {}),
                                now,
                            });
                            report.lancedb.tables.push(res);
                            report.lancedb.totalBytesReclaimed += res.bytesReclaimed;
                            report.lancedb.totalVersionsRemoved += res.versionsRemoved;
                            if (res.error) {
                                (wantCleanup ? versionCleanup : compaction).errors.push(`${p.name}: ${res.error}`);
                            }
                            log(`lancedb/${p.name}: reclaimed ${res.bytesReclaimed}B, ${res.versionsRemoved} versions removed`);
                        } catch (err) {
                            const msg = `${p.name}: ${(err as Error).message}`;
                            (wantCleanup ? versionCleanup : compaction).errors.push(msg);
                            log(`lancedb/${p.name}: FAILED — ${(err as Error).message}`);
                        }
                    }
                    if (wantCompact) compaction.ran = true;
                    if (wantCleanup) versionCleanup.ran = true;
                }
            } catch (err) {
                const msg = (err as Error).message;
                if (wantCompact) compaction.errors.push(msg);
                if (wantCleanup) versionCleanup.errors.push(msg);
            }
        }
    }

    // ── 3. Node retention ──────────────────────────────────────────────
    {
        const st = opStatus('nodeRetention');
        if (!st.enabled) {
            st.skippedReason = 'disabled';
        } else if (!ports.nodes) {
            st.skippedReason = 'no-port';
        } else {
            try {
                const all = await ports.nodes.listAll();
                const sel = selectRetentionCandidates(all, policy, now);
                report.nodes.inspected = sel.inspected;
                report.nodes.protectedSkipped = sel.protectedCount;
                report.nodes.recentSkipped = sel.recentCount;
                report.nodes.candidates = sel.candidates.length;
                if (options.dryRun) {
                    st.ran = true;
                    log(`[dry-run] nodes: ${sel.candidates.length} candidates, ${sel.protectedCount} protected, ${sel.recentCount} recent`);
                } else if (destructiveBlocked) {
                    st.skippedReason = 'locked';
                } else {
                    // F-T08/S09 — TOCTOU guard. `sel.candidates` was computed from
                    // the `all` snapshot taken before this write phase; a concurrent
                    // write (upsert/touch) could land on a candidate after the
                    // snapshot, making it no-longer-cold. The per-id nodeWriteChain
                    // inside archiveNode/deleteNode (adapters.ts) already serializes
                    // the eviction write against concurrent same-id writes, but it
                    // cannot un-make a STALE selection decision. Re-read a fresh
                    // snapshot and re-run the (pure) cold-selection so a node touched
                    // since the snapshot is skipped instead of evicted. The eviction
                    // itself then runs under the per-id chain, closing the race.
                    let freshById: Map<string, NodeForSelection> | undefined;
                    try {
                        const fresh = await ports.nodes.listAll();
                        const reselected = selectRetentionCandidates(fresh, policy, now);
                        freshById = new Map(reselected.candidates.map((n) => [n.id, n]));
                    } catch {
                        // If the re-read fails, fall back to the original snapshot
                        // rather than aborting retention entirely. (freshById stays
                        // undefined → no candidate is filtered.)
                        freshById = undefined;
                    }
                    for (const node of sel.candidates) {
                        // Skip any candidate that is no longer cold/unprotected in the
                        // fresh re-selection (i.e. it received a write since the snapshot).
                        if (freshById && !freshById.has(node.id)) {
                            report.nodes.recentSkipped++;
                            continue;
                        }
                        try {
                            if (policy.nodeRetentionAction === 'delete') {
                                await ports.nodes.delete(node.id);
                                report.nodes.deleted++;
                            } else {
                                await ports.nodes.archive(node.id);
                                report.nodes.archived++;
                            }
                        } catch (err) {
                            st.errors.push(`${node.id}: ${(err as Error).message}`);
                        }
                    }
                    st.ran = true;
                }
            } catch (err) {
                st.errors.push((err as Error).message);
            }
        }
    }

    // ── 4. Ephemeral workspace expiry ──────────────────────────────────
    {
        const st = opStatus('ephemeralExpiry');
        if (!st.enabled) {
            st.skippedReason = 'disabled';
        } else if (!ports.workspaces) {
            st.skippedReason = 'no-port';
        } else {
            try {
                const reg = ports.workspaces;
                const sel = selectEphemeralWorkspaces(reg.list(), policy, now, {
                    activeName: reg.activeName(),
                    bootstrapPath: reg.bootstrapPath(),
                });
                report.workspaces.inspected = sel.inspected;
                report.workspaces.tooYoung = sel.tooYoungCount;
                if (options.dryRun) {
                    st.ran = true;
                    report.workspaces.expired = sel.candidates.map((w) => w.name);
                    log(`[dry-run] workspaces: ${sel.candidates.length} ephemeral would expire`);
                } else if (destructiveBlocked) {
                    st.skippedReason = 'locked';
                } else {
                    for (const ws of sel.candidates) {
                        try {
                            const { bytesFreed } = await reg.delete(ws.name);
                            report.workspaces.expired.push(ws.name);
                            report.workspaces.bytesFreed += bytesFreed;
                            log(`workspace ${ws.name}: expired (${bytesFreed}B freed)`);
                        } catch (err) {
                            st.errors.push(`${ws.name}: ${(err as Error).message}`);
                        }
                    }
                    st.ran = true;
                }
            } catch (err) {
                st.errors.push((err as Error).message);
            }
        }

        // QA round 4, finding 3 — leftover `.pending-delete-*` sidelines
        // from a prior delete() whose final rmSync failed were never
        // surfaced anywhere; an operator had no way to notice accumulating
        // leftover bytes short of reading the workspaces directory by hand.
        // Read-only reporting only — no cleanup beyond the existing
        // retry-on-next-delete-of-that-name path in
        // `WorkspaceRegistry.delete()`. Runs whenever the port is wired and
        // implements it, independent of whether the destructive expiry op
        // itself is enabled/blocked above, since listing leftovers is never
        // destructive.
        if (ports.workspaces?.pendingSidelines) {
            try {
                report.workspaces.pendingSidelines = ports.workspaces.pendingSidelines();
            } catch (err) {
                st.errors.push(`pendingSidelines scan: ${(err as Error).message}`);
            }
        }
    }

    report.durationMs = Date.now() - wallStart;
    return report;
}
