/**
 * orchestration/types.ts — Phase 4 item 4.
 *
 * State shapes for the PlanOrchestrator that walks a DecomposedPlan
 * through expand → migrate → soak → contract automatically, using
 * the existing SchemaAuthoringStore + MigrationRunner underneath.
 *
 * The orchestrator is opt-in: callers that prefer to step through
 * phases manually (the original Phase 4 item 9 flow) can keep doing
 * that. When orchestration is started, the operator hands off control
 * and the orchestrator submits/approves/executes each phase. Soak
 * timers are enforced between migrate completion and the next phase
 * so destructive contract proposals can't slip in immediately after
 * a row-mutating migrate.
 */

import type { DecomposedPlan } from '../decomposition.js';
import type { ExecuteReport } from '../migration/types.js';

export type OrchestrationStatus =
    | 'running'
    /** A phase has been submitted as a proposal and is waiting for the
     *  approval flow (self-confirm or second-party HITL) to clear it.
     *  The orchestrator's tick() polls until the sandbox is gone. */
    | 'awaiting_approval'
    /** Migrate completed; soak timer running before the next phase. */
    | 'awaiting_soak'
    | 'completed'
    | 'failed'
    | 'aborted';

export type OrchestrationPhaseStatus =
    | 'pending'
    | 'submitted'
    | 'in_progress'
    | 'completed'
    | 'failed';

export interface OrchestrationPhaseState {
    /** Which kind of DecomposedPhase this row tracks. Copied from the
     *  source plan so the state file is self-describing. */
    kind: 'expand' | 'migrate' | 'contract';
    status: OrchestrationPhaseStatus;
    /** Set when an expand/contract phase has been submitted via
     *  SchemaAuthoringStore.propose(). Cleared when applied. */
    sandboxId?: string;
    /** Set after a migrate phase finishes. */
    executeReport?: ExecuteReport;
    /** Set when migrate finishes and a soak window starts. The next
     *  tick() that observes `now >= soakUntilIso` advances the
     *  orchestration. */
    soakUntilIso?: string;
    /** Set on phase failure. */
    error?: string;
    startedAt?: string;
    finishedAt?: string;
}

export interface OrchestrationState {
    id: string;
    /** The original DecomposedPlan that motivated the orchestration.
     *  Persisted so a daemon restart can resume mid-plan. */
    decomposedPlan: DecomposedPlan;
    status: OrchestrationStatus;
    /** Index into `phases`. Equals `phases.length` once every phase is
     *  completed (then status flips to 'completed'). */
    currentPhaseIndex: number;
    phases: OrchestrationPhaseState[];
    /** Seconds of soak enforced between every migrate phase and the
     *  phase that follows it. Default 0 in tests, set per-orchestration
     *  via the create() opts. */
    soakSeconds: number;
    /** kind:id convention. Carried into every submitted proposal and
     *  every migration plan. */
    proposedBy: string;
    /** Approver to use when the orchestrator auto-approves a phase.
     *  In Phase 4 item 10 + item 4, the contract phase still requires
     *  second-party HITL — `auto-approve` only fires for additive
     *  expand phases; destructive contract is enqueued and waits. */
    approvedBy: string;
    createdAt: string;
    updatedAt: string;
    /** Optional human-readable note. */
    note?: string;
    /** When status === 'failed', the phase index + message. */
    failedAt?: { phaseIndex: number; message: string };
}
