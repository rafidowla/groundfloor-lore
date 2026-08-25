/**
 * orchestration/orchestrator.ts — Phase 4 item 4.
 *
 * Walks a DecomposedPlan through expand → migrate → soak → contract
 * automatically. Each tick() inspects the current phase and:
 *
 *   - 'expand'   — submits the proposal (additive, AI-allowed), waits
 *                  for the operator/HITL to approve. Approval makes
 *                  the sandbox vanish, which the next tick observes.
 *   - 'migrate'  — runs MigrationRunner.execute synchronously. On
 *                  success, starts the soak timer. On failure, marks
 *                  the orchestration failed.
 *   - 'contract' — submits the destructive proposal. Phase 4 item 10
 *                  ensures this gets routed through the second-party
 *                  HITL queue (the schema_approve route does the
 *                  enforceApproval call). Approval applies it; the
 *                  sandbox vanishes; next tick advances.
 *
 * The orchestrator never bypasses the destructive guard or the HITL
 * queue — it just removes the manual "now submit the next thing"
 * step. The human still has to approve every gated phase.
 *
 * Soak is enforced between EVERY phase boundary (not only migrate→
 * contract) when `soakSeconds > 0`. Operators that want zero soak
 * can pass 0; the safety memo's default is on the caller.
 */

import { randomUUID } from 'node:crypto';

import { KeyedMutex } from '../../engines/writeQueue.js';
import type { DecomposedPlan } from '../decomposition.js';
import type { SchemaAuthoringStore, SchemaProposal } from '../authoring.js';
import { MigrationRunner } from '../migration/runner.js';
import type { MigrationBackend } from '../migration/types.js';
import type { CheckpointStore } from '../migration/checkpointStore.js';
// D2-orch-2 — correlate ALL destructive kinds (not just the 3 row-deleting
// ones) with the SAME canonicalization the direct /migrations/execute route
// uses. Imported from the shared module so the two sites cannot drift.
import {
    canonicalSig,
    isUnapprovedDestructiveOp,
} from '../migration/opCorrelation.js';
import type { SchemaChangeAuditLogger } from '../../security/schemaChangeAudit.js';
import { OrchestrationStore } from './store.js';
import type {
    OrchestrationPhaseState,
    OrchestrationState,
} from './types.js';

export interface OrchestratorDeps {
    store: OrchestrationStore;
    schemaAuthoring: SchemaAuthoringStore;
    migrationBackend?: MigrationBackend;
    migrationCheckpointStore?: CheckpointStore;
    /** Phase 4 audit linkage — passed to MigrationRunner so migrate
     *  phases emit `migration.applied` entries. */
    auditLog?: SchemaChangeAuditLogger;
    /** Workspace identifier for audit entries. */
    workspace?: string;
    /** Override clock — tests inject a deterministic Date.now. */
    now?: () => Date;
}

export interface CreateOpts {
    /** Caller identity. Carried into every phase. Must follow the
     *  `kind:id` convention. Phase 1 destructive guard still applies
     *  on contract phases — must be `human:`. */
    proposedBy: string;
    /** Approver to record in the contract phase's approval call. The
     *  HITL queue still requires a DIFFERENT human via /api/approvals
     *  for destructive contract phases — this is the row's
     *  `decidedBy` for the eventual replay. */
    approvedBy: string;
    /** Seconds of soak enforced between every phase. 0 disables. */
    soakSeconds: number;
    note?: string;
}

export class PlanOrchestrator {
    constructor(private readonly deps: OrchestratorDeps) {}

    // orch-5 — per-orchestration tick lock. tick() is a load-modify-save over
    // the OrchestrationStore and is driven from TWO sources: the background
    // auto-tick timer and the manual POST /tick route. Without a lock the two
    // can interleave on the same orchestration id (both load the same state,
    // both advance, the second save clobbers the first's transition / re-runs a
    // phase side effect). Serialize per id; different ids still tick in parallel.
    private readonly tickLocks = new KeyedMutex();

    /** Create + persist a new orchestration. Does NOT submit the first
     *  phase — the next tick() will. Keeps create() side-effect-light
     *  so tests can inspect the initial state. */
    create(plan: DecomposedPlan, opts: CreateOpts): OrchestrationState {
        if (plan.phases.length === 0) {
            throw new Error(
                'cannot orchestrate a decomposed plan with zero phases (the kind is additive — submit directly via /api/schema/proposals)',
            );
        }
        const now = this.iso();
        const state: OrchestrationState = {
            id: randomUUID(),
            decomposedPlan: plan,
            status: 'running',
            currentPhaseIndex: 0,
            phases: plan.phases.map(p => ({
                kind: p.kind, status: 'pending',
            })),
            soakSeconds: opts.soakSeconds,
            proposedBy: opts.proposedBy,
            approvedBy: opts.approvedBy,
            createdAt: now,
            updatedAt: now,
            note: opts.note,
        };
        this.deps.store.save(state);
        return state;
    }

    get(id: string): OrchestrationState | null {
        return this.deps.store.load(id);
    }

    listAll(): OrchestrationState[] {
        return this.deps.store.loadAll();
    }

    /** Mark an orchestration aborted. Already-submitted sandboxes
     *  are NOT auto-rejected — operator decides whether to reject
     *  them via the regular reject endpoint. */
    abort(id: string, reason?: string): OrchestrationState {
        const state = this.deps.store.load(id);
        if (!state) throw new Error(`no orchestration with id '${id}'`);
        if (state.status === 'completed' || state.status === 'aborted' || state.status === 'failed') {
            return state;
        }
        state.status = 'aborted';
        state.updatedAt = this.iso();
        if (reason) state.note = `${state.note ? state.note + ' | ' : ''}aborted: ${reason}`;
        this.deps.store.save(state);
        return state;
    }

    /**
     * Advance one orchestration as far as the current state allows.
     * Idempotent — calling tick() repeatedly while a phase is awaiting
     * approval is a no-op. Returns the (possibly-advanced) state.
     */
    async tick(id: string): Promise<OrchestrationState> {
        // orch-5 — serialize concurrent ticks (auto-tick timer vs manual /tick)
        // for the same orchestration so the load-modify-save can't interleave.
        return this.tickLocks.run(id, () => this.tickLocked(id));
    }

    private async tickLocked(id: string): Promise<OrchestrationState> {
        let state = this.deps.store.load(id);
        if (!state) throw new Error(`no orchestration with id '${id}'`);
        if (state.status === 'completed' || state.status === 'aborted' || state.status === 'failed') {
            return state;
        }

        // Loop so a single tick() can advance through multiple
        // "synchronous-by-nature" transitions (e.g. completing a
        // phase + starting the next one when no soak is needed).
        for (let guard = 0; guard < 8; guard++) {
            const before = state.status;
            const beforeIdx = state.currentPhaseIndex;
            state = await this.advanceOnce(state);
            const noProgress = state.status === before && state.currentPhaseIndex === beforeIdx;
            if (noProgress) break;
            if (state.status === 'completed' || state.status === 'aborted' || state.status === 'failed') break;
            if (state.status === 'awaiting_approval' || state.status === 'awaiting_soak') break;
        }
        return state;
    }

    /* ─── internals ─────────────────────────────────────────────── */

    private async advanceOnce(state: OrchestrationState): Promise<OrchestrationState> {
        const idx = state.currentPhaseIndex;
        if (idx >= state.phases.length) {
            state.status = 'completed';
            state.updatedAt = this.iso();
            this.deps.store.save(state);
            return state;
        }
        const phaseState = state.phases[idx];
        const phaseSpec = state.decomposedPlan.phases[idx];

        // Soak gate — applies between every phase boundary when set.
        if (phaseState.status === 'pending' && phaseState.soakUntilIso) {
            const now = this.now().getTime();
            const soakUntil = Date.parse(phaseState.soakUntilIso);
            if (now < soakUntil) {
                state.status = 'awaiting_soak';
                this.deps.store.save(state);
                return state;
            }
            // Soak elapsed — clear the marker and let the phase start.
            phaseState.soakUntilIso = undefined;
        }

        switch (phaseSpec.kind) {
            case 'expand':
            case 'contract':
                return this.advanceProposalPhase(state, phaseState, phaseSpec);
            case 'migrate':
                return this.advanceMigratePhase(state, phaseState, phaseSpec);
        }
    }

    private async advanceProposalPhase(
        state: OrchestrationState,
        phaseState: OrchestrationPhaseState,
        phaseSpec: { kind: 'expand' | 'contract'; proposal: SchemaProposal },
    ): Promise<OrchestrationState> {
        const isContract = phaseSpec.kind === 'contract';

        if (phaseState.status === 'pending') {
            // Submit the proposal. Use the orchestrator's proposedBy
            // so the destructive guard sees the right actor on the
            // contract phase (the decomposer may have stamped the
            // expand phase as 'ai:claude' — fine, it's additive).
            try {
                const proposal: SchemaProposal = {
                    ...phaseSpec.proposal,
                    proposedBy: isContract ? state.proposedBy : (phaseSpec.proposal.proposedBy ?? state.proposedBy),
                };
                const sandbox = await this.deps.schemaAuthoring.propose(proposal);
                phaseState.sandboxId = sandbox.sandboxId;
                phaseState.status = 'submitted';
                phaseState.startedAt = this.iso();
                state.status = 'awaiting_approval';
                state.updatedAt = this.iso();
                this.deps.store.save(state);
                return state;
            } catch (err) {
                return this.failPhase(state, phaseState, `submit failed: ${(err as Error).message}`);
            }
        }

        if (phaseState.status === 'submitted') {
            // Poll: has the sandbox been approved? Approval removes it
            // from the pending list — either via the legacy direct
            // approve OR via the HITL replay path (Phase 4 item 10).
            const stillPending = phaseState.sandboxId
                ? this.deps.schemaAuthoring.getProposal(phaseState.sandboxId)
                : null;
            if (stillPending) {
                state.status = 'awaiting_approval';
                this.deps.store.save(state);
                return state;
            }
            // Sandbox is gone — proposal applied. Advance.
            phaseState.status = 'completed';
            phaseState.finishedAt = this.iso();
            state.currentPhaseIndex += 1;
            // Reset status to 'running' so the tick() loop keeps
            // walking — maybeStartSoak / next-phase-start may flip
            // it back to 'awaiting_*' or 'completed'.
            state.status = 'running';
            this.maybeStartSoak(state);
            state.updatedAt = this.iso();
            this.deps.store.save(state);
            return state;
        }

        return state;
    }

    private async advanceMigratePhase(
        state: OrchestrationState,
        phaseState: OrchestrationPhaseState,
        phaseSpec: { kind: 'migrate'; plan: import('../migration/types.js').MigrationPlan },
    ): Promise<OrchestrationState> {
        if (phaseState.status !== 'pending') return state;

        if (!this.deps.migrationBackend) {
            return this.failPhase(state, phaseState,
                'migrate phase needs a migrationBackend, none wired');
        }

        // R-001 (2026-06-18) — the direct POST /api/schema/migrations/execute
        // route enforces a human:* approver + an approved-ops correlation
        // before running a destructive plan. advanceMigratePhase ran
        // runner.execute on a CLIENT-SUPPLIED plan without either gate: a
        // per-phase plan.approvedBy could override the orchestration's
        // create-time approvedBy, and an attacker who got a benign proposal
        // approved could run unapproved destructive ops under its sandbox via
        // orchestration. Re-assert BOTH execute-parity checks here.
        const effectiveApprovedBy = phaseSpec.plan.approvedBy ?? state.approvedBy;
        //   (1) human gate — mirrors migrations.ts's execute human:* check.
        if (!effectiveApprovedBy || !effectiveApprovedBy.startsWith('human:')) {
            return this.failPhase(state, phaseState,
                `migrate refused: destructive migrations require a human:* approver ` +
                `(effective approvedBy "${effectiveApprovedBy ?? '<none>'}"). ` +
                `AI / system actors cannot drive a destructive migrate phase.`);
        }
        //   (2) OPPORTUNISTIC approved-ops correlation. When the migrate plan
        //   carries a sandboxId AND an approved-ops record exists for it,
        //   every DESTRUCTIVE op must be a member of the approved set.
        //   When NO record exists — the standard decompose flow, where the
        //   removal proposal is approved by a LATER contract phase — do NOT
        //   block: fall through (the human gate above + create-time write
        //   scope still apply). This closes approve-benign-then-run-arbitrary
        //   without breaking the staged decompose→orchestrate flow.
        //
        //   D2-orch-2 — previously this only correlated 3 row-deleting kinds
        //   (a local DELETION_OP_KINDS set) with a VERBATIM-target signature,
        //   so the other 6 destructive kinds the direct /migrations/execute
        //   route covers via F-M02 could be smuggled through an
        //   orchestration, and cosmetically-different targets could mis-
        //   correlate. Now uses the shared isUnapprovedDestructiveOp +
        //   canonicalSig (F-M02 destructive-kind universe + F-M05/M06 +
        //   D2-authz-1 case-preserving canonicalization), identical to the
        //   direct route. node_type.renamed keeps its same-kind exemption so
        //   the legitimate decompose rename flow is not false-rejected.
        if (phaseSpec.plan.sandboxId) {
            const approved = this.deps.schemaAuthoring.getApprovedOps(phaseSpec.plan.sandboxId);
            if (approved) {
                const sig = canonicalSig;
                const approvedSigs = new Set(approved.ops.map(sig));
                const approvedKinds = new Set(approved.ops.map(o => o.kind));
                const unauthorizedOps = phaseSpec.plan.ops.filter(
                    o => isUnapprovedDestructiveOp(o, approvedSigs, approvedKinds, sig),
                );
                if (unauthorizedOps.length > 0) {
                    return this.failPhase(state, phaseState,
                        `migrate refused: plan contains destructive ops not in the approved ` +
                        `proposal for sandbox '${phaseSpec.plan.sandboxId}': ` +
                        `${unauthorizedOps.map(o => `${o.kind}(${o.target})`).join(', ')}. ` +
                        `A migrate phase may only delete what was approved.`);
                }
            }
        }

        const runner = new MigrationRunner(
            this.deps.migrationBackend,
            this.deps.migrationCheckpointStore,
            this.deps.auditLog && this.deps.workspace ? {
                auditLog: this.deps.auditLog,
                workspace: this.deps.workspace,
            } : undefined,
        );
        phaseState.status = 'in_progress';
        phaseState.startedAt = this.iso();
        state.status = 'running';
        this.deps.store.save(state);

        try {
            const report = await runner.execute({
                ...phaseSpec.plan,
                proposedBy: phaseSpec.plan.proposedBy ?? state.proposedBy,
                approvedBy: phaseSpec.plan.approvedBy ?? state.approvedBy,
            });
            phaseState.executeReport = report;
            phaseState.finishedAt = this.iso();
            if (!report.succeeded) {
                return this.failPhase(state, phaseState,
                    `migrate failed: ${report.ops.find(o => o.error)?.error ?? 'unknown error'}`);
            }
            phaseState.status = 'completed';
            state.currentPhaseIndex += 1;
            this.maybeStartSoak(state);
            state.updatedAt = this.iso();
            this.deps.store.save(state);
            return state;
        } catch (err) {
            return this.failPhase(state, phaseState, `migrate threw: ${(err as Error).message}`);
        }
    }

    /** Start a soak timer on the NEXT phase if soakSeconds > 0 and
     *  there is a next phase. Called right after a phase completes. */
    private maybeStartSoak(state: OrchestrationState): void {
        if (state.soakSeconds <= 0) return;
        if (state.currentPhaseIndex >= state.phases.length) return;
        const next = state.phases[state.currentPhaseIndex];
        if (next.status !== 'pending') return;
        const until = new Date(this.now().getTime() + state.soakSeconds * 1000);
        next.soakUntilIso = until.toISOString();
        state.status = 'awaiting_soak';
    }

    private failPhase(
        state: OrchestrationState,
        phaseState: OrchestrationPhaseState,
        message: string,
    ): OrchestrationState {
        phaseState.status = 'failed';
        phaseState.error = message;
        phaseState.finishedAt = this.iso();
        state.status = 'failed';
        state.failedAt = { phaseIndex: state.currentPhaseIndex, message };
        state.updatedAt = this.iso();
        this.deps.store.save(state);
        return state;
    }

    private now(): Date {
        return this.deps.now ? this.deps.now() : new Date();
    }
    private iso(): string {
        return this.now().toISOString();
    }
}
