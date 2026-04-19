/**
 * retentionSweep.ts — Periodic retention-policy enforcement (Phase 6).
 *
 * Fires the declarative rules collected via C12 + PluginRegistry.
 * Reads rules → queries the graph for expired nodes → applies action:
 *
 *   keep-forever    noop (but recorded in the audit log)
 *   archive         call C11 archive.put() with the node content,
 *                   then set sourceRef on the node and clear content.
 *                   Keeps the graph node (structure), drops the bytes.
 *   evict-content   same as archive but DELETES the archived copy too
 *                   (effectively "just drop the content"). Primarily
 *                   for low-value, high-volume nodes.
 *   delete          unlink the node entirely. Destructive, audited.
 *
 * Schedule:
 *   sweep() can be called on demand (CLI) or on a timer (daemon). The
 *   daemon schedules once every 24h after boot. First sweep fires
 *   15 seconds after boot so a healthy daemon doesn't appear to "stall"
 *   while the first pass runs.
 *
 * Safety:
 *   - `dryRun: true` returns what WOULD be actioned without touching
 *     anything. CLI defaults to dry-run; `lore retention sweep --apply`
 *     applies.
 *   - `legalHold: true` on a node SKIPS any retention action against
 *     it (the C-ent0 inert hook now earns its keep).
 *   - Every sweep appends one `retention.sweep` audit entry with a
 *     summary; every per-node action (archive/delete/evict) appends
 *     its own audit entry with node id + action.
 *   - Throwing action handlers don't abort the sweep; each node is a
 *     try/catch so one bad row doesn't break the cadence.
 *
 * Scope for this commit:
 *   - `keep-forever`: counted, nothing else.
 *   - `archive`:      fully wired against LocalFileSink (sets sourceRef).
 *   - `evict-content` and `delete`: supported in dry-run reports but
 *     NOT yet applied (--apply will refuse with "not yet supported").
 *     These two are the destructive tier — waiting for the consent UI
 *     so users aren't surprised the first time a sweep fires.
 */

import type { LocalGraph } from './localGraph.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { AuditLog } from '../security/audit.js';
import type { IArchiveSink } from './archive.js';
import { encodeSourceRef } from './archive.js';

export interface RetentionSweepOptions {
    dryRun?: boolean;
    /** Subset the sweep to specific plugin names. */
    plugins?: string[];
    /** Archive sink (C11). Required for `archive` action to actually run. */
    sink?: IArchiveSink;
}

export interface RetentionSweepResult {
    dryRun: boolean;
    rulesEvaluated: number;
    nodesInspected: number;
    // Per-action counts
    kept: number;
    archived: number;
    archiveCandidatesSkipped: number;  // dry-run or missing sink
    evicted: number;
    evictionSkippedDestructive: number;
    deleted: number;
    deleteSkippedDestructive: number;
    legalHeld: number;
    errors: number;
    durationMs: number;
    /** Sampled per-action events for logging. */
    events: Array<{
        plugin: string;
        nodeType: string;
        action: string;
        nodeId: string;
        outcome: 'applied' | 'dry-run' | 'skipped-destructive' | 'legal-hold' | 'error';
        detail?: string;
    }>;
}

export class RetentionSweeper {
    constructor(
        private readonly graph: LocalGraph,
        private readonly pluginRegistry: PluginRegistry,
        private readonly auditLog: AuditLog,
    ) {}

    async sweep(opts: RetentionSweepOptions = {}): Promise<RetentionSweepResult> {
        const startMs = Date.now();
        const dryRun = opts.dryRun ?? true;
        const sink = opts.sink;
        const rules = this.pluginRegistry.collectRetentionPolicies();
        const filtered = opts.plugins
            ? rules.filter((r) => opts.plugins!.includes(r.plugin))
            : rules;

        const result: RetentionSweepResult = {
            dryRun,
            rulesEvaluated: filtered.length,
            nodesInspected: 0,
            kept: 0,
            archived: 0,
            archiveCandidatesSkipped: 0,
            evicted: 0,
            evictionSkippedDestructive: 0,
            deleted: 0,
            deleteSkippedDestructive: 0,
            legalHeld: 0,
            errors: 0,
            durationMs: 0,
            events: [],
        };

        const ctx = this.graph.createPluginGraphContext();

        for (const { plugin, rule } of filtered) {
            if (rule.action === 'keep-forever') {
                // Still "evaluate" so we can report counts of nodes
                // under the rule — useful for the sweep report.
                try {
                    const rows = await ctx.queryRows(
                        `MATCH (n:LoreNode) WHERE n.type = $t RETURN count(n) AS cnt`,
                        { t: rule.nodeType },
                    ).catch(() => [] as Array<Record<string, unknown>>);
                    const count = Number(rows[0]?.cnt ?? 0);
                    result.nodesInspected += count;
                    result.kept += count;
                } catch {
                    // Plugin node type may not be in LoreNode (it's in the
                    // plugin's own table). Count as kept without inspection.
                    result.kept += 0;
                }
                continue;
            }

            // Age-based filter is the only supported condition right now.
            if (rule.condition !== 'age' || typeof rule.ageThresholdDays !== 'number') {
                continue;
            }
            const cutoffMs = Date.now() - rule.ageThresholdDays * 24 * 60 * 60 * 1000;
            const cutoffIso = new Date(cutoffMs).toISOString();

            // Only LoreNode has the legalHold column (core schema).
            // Plugin-owned node tables may not. For now, scope the
            // sweep to LoreNode only — plugin-owned tables get their
            // sweep when each plugin ships a custom sweeper in
            // Phase 7+.
            let rows: Array<Record<string, unknown>>;
            try {
                rows = await ctx.queryRows(
                    `MATCH (n:LoreNode)
                     WHERE n.type = $t
                       AND n.updatedAt IS NOT NULL
                       AND n.updatedAt <> ''
                       AND n.updatedAt < $cutoff
                     RETURN n.id AS id, n.label AS label, n.content AS content,
                            n.legalHold AS legalHold, n.updatedAt AS updatedAt
                     LIMIT 500`,
                    { t: rule.nodeType, cutoff: cutoffIso },
                );
            } catch {
                rows = [];
            }

            for (const row of rows) {
                result.nodesInspected++;
                const nodeId = String(row.id ?? '');
                const onLegalHold = row.legalHold === true;

                if (onLegalHold) {
                    result.legalHeld++;
                    result.events.push({
                        plugin, nodeType: rule.nodeType, action: rule.action,
                        nodeId, outcome: 'legal-hold',
                    });
                    continue;
                }

                try {
                    if (rule.action === 'archive') {
                        if (dryRun) {
                            result.archiveCandidatesSkipped++;
                            result.events.push({ plugin, nodeType: rule.nodeType, action: rule.action, nodeId, outcome: 'dry-run' });
                            continue;
                        }
                        if (!sink) {
                            result.archiveCandidatesSkipped++;
                            result.events.push({
                                plugin, nodeType: rule.nodeType, action: rule.action, nodeId,
                                outcome: 'error', detail: 'no archive sink configured',
                            });
                            continue;
                        }
                        const content = String(row.content ?? '');
                        if (!content) {
                            // Nothing to archive.
                            result.events.push({ plugin, nodeType: rule.nodeType, action: rule.action, nodeId, outcome: 'dry-run', detail: 'node had no content' });
                            continue;
                        }
                        const ref = await sink.put(nodeId, Buffer.from(content, 'utf-8'));
                        const refStr = encodeSourceRef(ref);
                        // Update the node: clear content, set sourceRef in metadata.
                        await ctx.executeQuery(
                            `MATCH (n:LoreNode {id: $id}) SET n.content = $placeholder, n.metadata = $meta`,
                            {
                                id: nodeId,
                                placeholder: `(evicted ${ref.bytes} bytes — sourceRef: ${refStr})`,
                                meta: JSON.stringify({ sourceRef: refStr, archivedAt: new Date().toISOString() }),
                            },
                        );
                        result.archived++;
                        this.auditLog.log({
                            toolName: 'retention.archive',
                            args: { plugin, nodeType: rule.nodeType, nodeId, bytes: ref.bytes },
                            result: 'success',
                            durationMs: 0,
                        });
                        result.events.push({ plugin, nodeType: rule.nodeType, action: rule.action, nodeId, outcome: 'applied' });
                    } else if (rule.action === 'evict-content') {
                        if (dryRun) {
                            result.evictionSkippedDestructive++;
                            result.events.push({ plugin, nodeType: rule.nodeType, action: rule.action, nodeId, outcome: 'dry-run' });
                        } else {
                            result.evictionSkippedDestructive++;
                            result.events.push({
                                plugin, nodeType: rule.nodeType, action: rule.action, nodeId,
                                outcome: 'skipped-destructive',
                                detail: 'evict-content apply pending consent-UI work',
                            });
                        }
                    } else if (rule.action === 'delete') {
                        if (dryRun) {
                            result.deleteSkippedDestructive++;
                            result.events.push({ plugin, nodeType: rule.nodeType, action: rule.action, nodeId, outcome: 'dry-run' });
                        } else {
                            result.deleteSkippedDestructive++;
                            result.events.push({
                                plugin, nodeType: rule.nodeType, action: rule.action, nodeId,
                                outcome: 'skipped-destructive',
                                detail: 'delete apply pending consent-UI work',
                            });
                        }
                    }
                } catch (err) {
                    result.errors++;
                    this.auditLog.log({
                        toolName: 'retention.' + rule.action,
                        args: { plugin, nodeType: rule.nodeType, nodeId },
                        result: 'error',
                        resultDetail: (err as Error).message,
                        durationMs: 0,
                    });
                    result.events.push({
                        plugin, nodeType: rule.nodeType, action: rule.action, nodeId,
                        outcome: 'error', detail: (err as Error).message,
                    });
                }
            }
        }

        result.durationMs = Date.now() - startMs;

        // Summary audit entry.
        this.auditLog.log({
            toolName: 'retention.sweep',
            args: {
                dryRun,
                rulesEvaluated: result.rulesEvaluated,
                plugins: opts.plugins,
            },
            result: 'success',
            resultDetail: `kept=${result.kept} archived=${result.archived} inspected=${result.nodesInspected} errors=${result.errors}`,
            durationMs: result.durationMs,
        });

        return result;
    }
}
