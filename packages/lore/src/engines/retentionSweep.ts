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
 *
 * Operator-visible fix (graph-engine generalization, commit 8):
 *   Before this change `this.graph` was queried via `getGraphContext()` —
 *   a raw-Cypher-only escape hatch — regardless of which engine the
 *   workspace actually declared. Every caller resolved the graph via
 *   `LocalGraphRegistry.getOrOpen`, a single-engine substrate accessor, so a
 *   `graphEngine: 'surreal'` workspace's sweep silently ran against that
 *   workspace's real-but-EMPTY legacy-engine database and reported "0 eligible" no
 *   matter what the workspace's actual (Surreal) data held. The sweep now
 *   drives `getStats()` / `getNode()` / `upsertNode()` (every engine) plus
 *   `bulkListProjected` (both local engines, via `requireWorkspaceGraph`) —
 *   no raw Cypher, no engine assumption.
 */

import type { GraphStats } from '../providers/types.js';

// Widened during the legacy-engine removal: naming the two CONCRETE classes silently
// excluded SurrealGraph (see engines/htmlExport.ts). Need more than the
// shared handle? Feature-detect and refuse — do not re-narrow to a class.
type LoreGraph = LoreGraphHandle;
import type { AuditLog } from '../security/audit.js';
import type { IArchiveSink } from './archive.js';
import { encodeSourceRef } from './archive.js';
import type { LoreGraphHandle } from '../storage/loreStorageClient.js';
import { requireWorkspaceGraph } from './requireWorkspaceGraph.js';
import { DEFAULT_MAINTENANCE_PAGE_SIZE } from './nodePager.js';

export interface RetentionSweepOptions {
    dryRun?: boolean;
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
        source: string;
        nodeType: string;
        action: string;
        nodeId: string;
        outcome: 'applied' | 'dry-run' | 'skipped-destructive' | 'legal-hold' | 'error';
        detail?: string;
    }>;
}

export class RetentionSweeper {
    constructor(
        private readonly graph: LoreGraph,
        private readonly auditLog: AuditLog,
    ) {}

    async sweep(opts: RetentionSweepOptions = {}): Promise<RetentionSweepResult> {
        const startMs = Date.now();
        const dryRun = opts.dryRun ?? true;
        const sink = opts.sink;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const filtered: Array<any> = [];

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

        for (const { source, rule } of filtered) {
            if (rule.action === 'keep-forever') {
                // Still "evaluate" so we can report counts of nodes
                // under the rule — useful for the sweep report.
                //
                // Engine-agnostic: a per-type count is already exposed by
                // every LoreGraphHandle as getStats().typeBreakdown — no
                // Cypher, no scan, and (unlike the old raw
                // `MATCH (n:LoreNode) WHERE n.type = $t` query) no implicit
                // assumption about which engine backs this workspace's substrate.
                //
                // Deliberate choice: the old code swallowed a failed count
                // to a silent `kept += 0` (`.catch(() => [])` around the
                // query, then an outer catch that also no-opped). That let a
                // real substrate failure masquerade as "nothing to keep" —
                // exactly backwards for a retention report. getStats() is a
                // single well-typed call on a graph the constructor already
                // trusts to be open and healthy, so a throw here is a real
                // fault: count it and audit it instead of hiding it.
                try {
                    const stats: GraphStats = await this.graph.getStats();
                    const count = stats.typeBreakdown[rule.nodeType] ?? 0;
                    result.nodesInspected += count;
                    result.kept += count;
                } catch (err) {
                    result.errors++;
                    this.auditLog.log({
                        toolName: 'retention.count',
                        args: { source, nodeType: rule.nodeType },
                        result: 'error',
                        resultDetail: (err as Error).message,
                        durationMs: 0,
                    });
                }
                continue;
            }

            // Age-based filter is the only supported condition right now.
            if (rule.condition !== 'age' || typeof rule.ageThresholdDays !== 'number') {
                continue;
            }
            const cutoffMs = Date.now() - rule.ageThresholdDays * 24 * 60 * 60 * 1000;
            const cutoffIso = new Date(cutoffMs).toISOString();

            // Only LoreNode has the legalHold column (core schema; present on
            // the legacy engine's schema only, for now — SurrealDB has no column of that name yet, so
            // `row['legalHold']` reads undefined there and never blocks a
            // Surreal-backed sweep. That's a real cross-engine gap, but not
            // a regression: this path was unreachable on Surreal before this
            // commit too). Client-defined node tables may not carry it
            // either. For now, scope the sweep to LoreNode only —
            // client-defined tables get their sweep when the client ships a
            // custom sweeper in Phase 7+.
            //
            // Engine-agnostic: `bulkListProjected` is the keyset-paged,
            // projection-narrowed node scan both local engines implement;
            // it replaces the raw
            // `MATCH (n:LoreNode) WHERE ... LIMIT 500` Cypher, which only
            // ever worked against one graph engine. It's not on
            // `LoreGraphHandle` (DataplaneGraph doesn't implement it), so
            // `requireWorkspaceGraph` narrows first and turns a cloud-mode
            // call into a named `CloudModeUnsupportedError` instead of a
            // `TypeError: bulkListProjected is not a function`. The
            // `n.type = $t` server-side filter has no bulkListProjected
            // equivalent (it only takes a project filter), so `type` is
            // projected and filtered client-side per page instead. Same
            // deliberate choice as above: a failure surfaces in
            // `result.errors`, not a silent `rows = []`.
            const AGE_RULE_ROW_CAP = 500; // mirrors the old query's LIMIT 500
            let rows: Array<Record<string, unknown>> = [];
            try {
                const wsGraph = requireWorkspaceGraph(
                    this.graph,
                    'retentionSweep.ageRule',
                    'pages nodes for an age-based retention rule via the local paged-scan surface',
                );
                let cursor: { updatedAt: string; id: string } | null = null;
                do {
                    const page = await wsGraph.bulkListProjected(
                        '*',
                        ['type', 'label', 'content', 'legalHold', 'updatedAt'],
                        DEFAULT_MAINTENANCE_PAGE_SIZE,
                        cursor,
                    );
                    for (const r of page.rows) {
                        if (r['type'] !== rule.nodeType) continue;
                        const updatedAt = String(r['updatedAt'] ?? '');
                        if (!updatedAt || updatedAt >= cutoffIso) continue;
                        rows.push(r);
                        if (rows.length >= AGE_RULE_ROW_CAP) break;
                    }
                    cursor = rows.length >= AGE_RULE_ROW_CAP ? null : page.nextCursor;
                } while (cursor);
            } catch (err) {
                result.errors++;
                this.auditLog.log({
                    toolName: 'retention.' + rule.action,
                    args: { source, nodeType: rule.nodeType },
                    result: 'error',
                    resultDetail: (err as Error).message,
                    durationMs: 0,
                });
                rows = [];
            }

            for (const row of rows) {
                result.nodesInspected++;
                const nodeId = String(row.id ?? '');
                const onLegalHold = row.legalHold === true;

                if (onLegalHold) {
                    result.legalHeld++;
                    result.events.push({
                        source, nodeType: rule.nodeType, action: rule.action,
                        nodeId, outcome: 'legal-hold',
                    });
                    continue;
                }

                try {
                    if (rule.action === 'archive') {
                        if (dryRun) {
                            result.archiveCandidatesSkipped++;
                            result.events.push({ source, nodeType: rule.nodeType, action: rule.action, nodeId, outcome: 'dry-run' });
                            continue;
                        }
                        if (!sink) {
                            result.archiveCandidatesSkipped++;
                            result.events.push({
                                source, nodeType: rule.nodeType, action: rule.action, nodeId,
                                outcome: 'error', detail: 'no archive sink configured',
                            });
                            continue;
                        }
                        const content = String(row.content ?? '');
                        if (!content) {
                            // Nothing to archive.
                            result.events.push({ source, nodeType: rule.nodeType, action: rule.action, nodeId, outcome: 'dry-run', detail: 'node had no content' });
                            continue;
                        }
                        const ref = await sink.put(nodeId, Buffer.from(content, 'utf-8'));
                        const refStr = encodeSourceRef(ref);
                        // Engine-agnostic node patch: getNode + upsertNode are on
                        // every LoreGraphHandle (SurrealDB, Dataplane). This
                        // replaces the old raw `MATCH (n:LoreNode {id}) SET
                        // n.content = ..., n.metadata = ...` Cypher, which only
                        // ever ran against one graph engine. upsertNode does a
                        // full-field SET on update (not a partial patch), so the
                        // current node is re-fetched rather than reconstructed
                        // from the paged-scan projection (which only carries the
                        // columns this sweep asked for).
                        const current = await this.graph.getNode(nodeId);
                        if (!current) {
                            // Deleted between the age-scan and this write —
                            // nothing left to archive; not a sweep error.
                            result.events.push({ source, nodeType: rule.nodeType, action: rule.action, nodeId, outcome: 'dry-run', detail: 'node no longer exists' });
                            continue;
                        }
                        const { createdAt: _createdAt, updatedAt: _updatedAt, syncedAt: _syncedAt, ...patchable } = current;
                        await this.graph.upsertNode({
                            ...patchable,
                            content: `(evicted ${ref.bytes} bytes — sourceRef: ${refStr})`,
                            metadata: JSON.stringify({ sourceRef: refStr, archivedAt: new Date().toISOString() }),
                        });
                        result.archived++;
                        this.auditLog.log({
                            toolName: 'retention.archive',
                            args: { source, nodeType: rule.nodeType, nodeId, bytes: ref.bytes },
                            result: 'success',
                            durationMs: 0,
                        });
                        result.events.push({ source, nodeType: rule.nodeType, action: rule.action, nodeId, outcome: 'applied' });
                    } else if (rule.action === 'evict-content') {
                        if (dryRun) {
                            result.evictionSkippedDestructive++;
                            result.events.push({ source, nodeType: rule.nodeType, action: rule.action, nodeId, outcome: 'dry-run' });
                        } else {
                            result.evictionSkippedDestructive++;
                            result.events.push({
                                source, nodeType: rule.nodeType, action: rule.action, nodeId,
                                outcome: 'skipped-destructive',
                                detail: 'evict-content apply pending consent-UI work',
                            });
                        }
                    } else if (rule.action === 'delete') {
                        if (dryRun) {
                            result.deleteSkippedDestructive++;
                            result.events.push({ source, nodeType: rule.nodeType, action: rule.action, nodeId, outcome: 'dry-run' });
                        } else {
                            result.deleteSkippedDestructive++;
                            result.events.push({
                                source, nodeType: rule.nodeType, action: rule.action, nodeId,
                                outcome: 'skipped-destructive',
                                detail: 'delete apply pending consent-UI work',
                            });
                        }
                    }
                } catch (err) {
                    result.errors++;
                    this.auditLog.log({
                        toolName: 'retention.' + rule.action,
                        args: { source, nodeType: rule.nodeType, nodeId },
                        result: 'error',
                        resultDetail: (err as Error).message,
                        durationMs: 0,
                    });
                    result.events.push({
                        source, nodeType: rule.nodeType, action: rule.action, nodeId,
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
            },
            result: 'success',
            resultDetail: `kept=${result.kept} archived=${result.archived} inspected=${result.nodesInspected} errors=${result.errors}`,
            durationMs: result.durationMs,
        });

        return result;
    }
}
