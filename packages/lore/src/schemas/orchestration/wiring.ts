/**
 * orchestration/wiring.ts — Phase 4 item 4.
 *
 * Factory that builds the orchestrator singletons + the background
 * tick timer. Extracted from server.ts to keep that file under the
 * 800-line cap.
 */

import { SchemaGraphOpsMigrationBackend } from '../migration/schemaGraphOpsBackend.js';
import type { SchemaGraphOps } from '../substrate/schemaGraphOps.js';
import { CheckpointStore as MigrationCheckpointStore } from '../migration/checkpointStore.js';
import { MigrationRunner } from '../migration/runner.js';
import type { MigrationOp, MigrationOpKind, MigrationPlan } from '../migration/types.js';
import type { ProposedChange } from '../authoring.js';
import type { SchemaAuthoringStore } from '../authoring.js';
import type { SchemaChangeAuditLogger } from '../../security/schemaChangeAudit.js';
import type { InMemoryReplayHandlerRegistry } from '../../security/approvalReplay.js';
import { OrchestrationStore } from './store.js';
import { PlanOrchestrator } from './orchestrator.js';

/** The 9 destructive SchemaChangeKinds that have a 1:1 MigrationOpKind
 *  counterpart. Additive kinds (node_type.added, field.added, etc.) and
 *  meta kinds (workspace.*, migration.applied) don't need data migration
 *  and are filtered out. */
const DESTRUCTIVE_TO_MIGRATION: ReadonlyMap<string, MigrationOpKind> = new Map([
    ['node_type.removed',          'node_type.removed'],
    ['node_type.renamed',          'node_type.renamed'],
    ['node_type.kind_changed',     'node_type.kind_changed'],
    ['field.removed',              'field.removed'],
    ['field.type_changed',         'field.type_changed'],
    ['field.sensitivity_flipped',  'field.sensitivity_flipped'],
    ['edge_type.removed',          'edge_type.removed'],
    ['permission.changed',         'permission.changed'],
    ['permission.removed',         'permission.removed'],
]);

function changesToMigrationOps(changes: ProposedChange[]): MigrationOp[] {
    const ops: MigrationOp[] = [];
    for (const c of changes) {
        const kind = DESTRUCTIVE_TO_MIGRATION.get(c.kind);
        if (!kind) continue;
        const op: MigrationOp = { kind, target: c.target };
        // Carry rename/retype params if the proposal supplied them via
        // `after` (the post-state snapshot). Best-effort — backends
        // surface clearer errors for missing required params.
        if (kind === 'node_type.renamed' && c.after && typeof c.after === 'object') {
            const newName = (c.after as { name?: string }).name;
            if (newName) op.params = { newName };
        } else if (kind === 'field.type_changed' && c.after && typeof c.after === 'object') {
            const newType = (c.after as { type?: string }).type;
            if (newType) op.params = { newType };
        }
        ops.push(op);
    }
    return ops;
}

export interface OrchestrationWiring {
    migrationBackend: SchemaGraphOpsMigrationBackend;
    migrationCheckpointStore: MigrationCheckpointStore;
    planOrchestrator: PlanOrchestrator;
    /** Cancellable timer. server.ts wires this into onShutdown. */
    tickTimer: NodeJS.Timeout;
}

const ORCHESTRATION_TICK_MS = 30_000;

export function wireOrchestration(input: {
    schemaGraphOps: SchemaGraphOps;
    loreDir: string;
    schemaAuthoring: SchemaAuthoringStore;
    schemaChangeAudit: SchemaChangeAuditLogger;
    workspace: string;
    /** Phase 4 item 10 — when supplied, registers the replay handler
     *  for 'schema_approve' so destructive approvals enqueued through
     *  the second-party HITL queue can be replayed on decision. */
    replayRegistry?: InMemoryReplayHandlerRegistry;
    /** 4.5 (2026-08-17) — the plan-tick interval advances schema orchestrations
     *  and runs migrate phases; it must NOT run in a process Lore doesn't own
     *  (an embedded host would keep a 30s timer firing after dispose()). */
    startsDaemonTimers?: boolean;
}): OrchestrationWiring {
    const migrationBackend = new SchemaGraphOpsMigrationBackend(input.schemaGraphOps);
    const migrationCheckpointStore = new MigrationCheckpointStore(input.loreDir);
    if (input.replayRegistry) {
        input.replayRegistry.register('schema_approve', async (args, ctx) => {
            const { sandboxId, note } =
                args as { sandboxId: string; approver: string; note?: string };
            if (!sandboxId) {
                throw new Error(
                    'schema_approve replay: args envelope missing required sandboxId',
                );
            }
            // Credit the HITL second-party decider (ctx.decidedBy), NOT
            // the original args.approver — which was self-asserted by
            // the initiator and is therefore conflicted. See the bug
            // surfaced in the 2026-05-17 adversarial DBA test.
            const approver = ctx.decidedBy;
            if (!approver || !approver.startsWith('human:')) {
                throw new Error(
                    `schema_approve replay: decidedBy must be a human:* identity (got ${approver})`,
                );
            }
            // Capture proposal BEFORE approve consumes it so we can derive
            // a migration plan for the live graph after the schema flip.
            const entry = input.schemaAuthoring.getProposal(sandboxId);
            if (!entry) {
                throw new Error(`schema_approve replay: proposal '${sandboxId}' not found`);
            }
            await input.schemaAuthoring.approve(sandboxId, approver, note);
            // ── DATA-MIGRATION HOOK (2026-05-17 fix) ──────────────────
            // The approve() call above flips schema.json, captures the
            // snapshot, and writes the audit entry — but it does NOT
            // touch the live graph. Without the runner step the
            // "approved" schema and the actual data diverge silently
            // (data outlives its declared type). Run the migration
            // synchronously here so the approver's expectation (the
            // change took effect) matches reality.
            const migrationOps = changesToMigrationOps(entry.proposal.changes);
            if (migrationOps.length > 0) {
                const plan: MigrationPlan = {
                    ops: migrationOps,
                    proposedBy: entry.proposal.proposedBy,
                    approvedBy: approver,
                    sandboxId,
                    note: `Auto-executed from schema_approve replay (sandbox ${sandboxId})`,
                };
                const runner = new MigrationRunner(
                    migrationBackend,
                    migrationCheckpointStore,
                    { auditLog: input.schemaChangeAudit, workspace: input.workspace },
                );
                const report = await runner.execute(plan);
                if (!report.succeeded) {
                    // Surface the failure on the approval row by throwing.
                    // schemaAuthoring.approve has already flipped schema.json
                    // — rollback would be the operator's job here.
                    throw new Error(
                        `schema_approve replay: migration runner partial failure on plan ${report.planId}. ` +
                        `Schema was flipped but data is in an inconsistent state. ` +
                        `Operator should restore from snapshot in <workspace>/.lore/schema-history/.`,
                    );
                }
            }
        });
    }
    const orchestrationStore = new OrchestrationStore(input.loreDir);
    const planOrchestrator = new PlanOrchestrator({
        store: orchestrationStore,
        schemaAuthoring: input.schemaAuthoring,
        migrationBackend,
        migrationCheckpointStore,
        auditLog: input.schemaChangeAudit,
        workspace: input.workspace,
    });
    // 4.5 (2026-08-17) — only arm the plan-tick interval when the daemon owns
    // the process. A non-owner (embedded host) gets an inert handle so the
    // wiring shape stays the same but no 30s timer fires after dispose().
    let tickTimer: NodeJS.Timeout;
    if (input.startsDaemonTimers) {
        tickTimer = setInterval(() => {
            for (const o of planOrchestrator.listAll()) {
                if (o.status === 'completed' || o.status === 'aborted' || o.status === 'failed') continue;
                planOrchestrator.tick(o.id).catch(() => { /* swallow */ });
            }
        }, ORCHESTRATION_TICK_MS);
        tickTimer.unref();
    } else {
        tickTimer = setTimeout(() => {}, ORCHESTRATION_TICK_MS);
        tickTimer.unref();
        clearTimeout(tickTimer);
    }
    return { migrationBackend, migrationCheckpointStore, planOrchestrator, tickTimer };
}
