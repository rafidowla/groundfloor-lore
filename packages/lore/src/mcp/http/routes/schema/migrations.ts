/**
 * migrations.ts — Phase 4 schema-migration routes.
 *
 *   POST   /api/schema/migrations/dry-run    — validate a plan, no writes
 *   POST   /api/schema/migrations/execute    — run a plan (human-approved, sandbox-tied)
 *   GET    /api/schema/migrations/in-flight   — current checkpoint state
 *   POST   /api/schema/migrations/resume      — continue an in-flight plan
 *   DELETE /api/schema/migrations/in-flight   — clear the checkpoint
 *   POST   /api/schema/migrations/decompose   — expand→migrate→contract plan
 *   POST   /api/schema/migrations/rollback    — reverse an executed plan via snapshots
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import { MigrationRunner, FOREIGN_IN_FLIGHT_ERROR } from '../../../../schemas/migration/runner.js';
import type { MigrationPlan, ExecuteReport } from '../../../../schemas/migration/types.js';
import { decompose } from '../../../../schemas/decomposition.js';
import type { ProposedChange } from '../../../../schemas/authoring.js';
import { readJsonBody, writeJson, writeError, isInvalidJsonBody, writeInvalidJson } from '../../helpers.js';
import { getCurrentPrincipal } from '../../../../auth/principal.js';
import { PREFIX, type SchemaRoutesDeps } from './shared.js';
// F-M02 / F-M05 / F-M06 / D2-authz-1 — destructive-op approval correlation
// now lives in the shared module so the orchestrator's migrate phase
// (D2-orch-2) uses the IDENTICAL destructive-kind universe + canonicalization.
// DESTRUCTIVE_OP_KINDS / SKIP_CORRELATION_IF_NO_SAMEKIND / canonicalizeTarget /
// canonicalSig / isUnapprovedDestructiveOp were factored out verbatim (minus
// the unsafe .toLowerCase() — see D2-authz-1 in opCorrelation.ts).
//
// Decompose-flow compatibility + the R-002 rename/retype residual (the lone
// node_type.renamed same-kind exemption, and why params.newName/newType is not
// bound to an approved-side value) are documented in opCorrelation.ts and in
// the execute handler below.
import {
    canonicalSig,
    isUnapprovedDestructiveOp,
} from '../../../../schemas/migration/opCorrelation.js';
import { redactError } from '../../../../security/logRedact.js';

/**
 * Audit C1 (L-001, 2026-06-17) — the token write-scope gate for the MUTATING
 * migration routes now lives in the family dispatcher (trySchemaRoutes →
 * bindRouteTarget, intent='write' for these POST/DELETE routes). A read-only
 * Bearer is 403'd, and a token bound to a non-boot workspace is 409'd
 * (schema_workspace_not_active), BEFORE any migration verb runs — the boot-wired
 * MigrationBackend/CheckpointStore can only act on the boot workspace. The
 * former requireMigrationWriteScope helper (a literal-undefined-target scope
 * gate) is therefore redundant and used the anti-pattern banned by arch rule
 * D-021 — removed in Wave 4.2. The HUMAN-OPERATOR gate below (denyNonHumanOperator)
 * is a STRONGER, distinct check and is preserved verbatim.
 */

/**
 * F-A1/F-A2 — a destructive migration (execute / resume / rollback) requires the
 * HUMAN OPERATOR, bound to the AUTHENTICATED principal. The existing
 * `plan.approvedBy.startsWith('human:')` check is necessary but NOT sufficient:
 * `approvedBy` comes from the client JSON body, so any write-scoped token (incl.
 * the cross-workspace shared-secret) could type `"human:x"` and clear it. This
 * binds the gate to the principal kind instead:
 *   - null principal              → local/legacy bypass (preserved; tests + no-auth local).
 *   - kind==='bootstrap'          → the local operator (the human in local mode). Allowed.
 *   - kind==='app'/'shared-secret' → a service/automation principal cannot
 *                                    self-attest humanity on a destructive route. Rejected.
 * Returns true once a 403 has been written.
 */
function denyNonHumanOperator(res: ServerResponse): boolean {
    const p = getCurrentPrincipal();
    if (!p || p.kind === 'bootstrap') return false;
    writeError(res, 403, 'destructive_migration_requires_human',
        `principal kind '${p.kind}' cannot approve a destructive migration — it requires the ` +
        `operator (bootstrap) identity. A shared-secret / app token cannot self-attest humanity ` +
        `by supplying approvedBy:"human:…" in the request body.`);
    return true;
}

/** Returns true once a response has been written. */
export async function tryMigrationRoutes(req: IncomingMessage, res: ServerResponse, deps: SchemaRoutesDeps, pathname: string): Promise<boolean> {
    if (pathname === `${PREFIX}/migrations/dry-run` && req.method === 'POST') {
        // F-M01 — dry-run reveals destructive impact (affected-row counts +
        // sample ids of a deletion plan); its write-scope + workspace-confinement
        // check runs in trySchemaRoutes (bindRouteTarget, intent='write'). It
        // performs no writes, so the denyNonHumanOperator (human-only) gate
        // deliberately does NOT apply.
        if (!deps.migrationBackend) {
            writeError(res, 503, 'migration_backend_unavailable',
                'migration backend not wired in this daemon (cloud mode is not yet implemented)');
            return true;
        }
        try {
            const plan = await readJsonBody(req) as MigrationPlan;
            if (!plan || !Array.isArray(plan.ops) || plan.ops.length === 0) {
                writeError(res, 400, 'invalid_migration_plan',
                    'body must be a MigrationPlan with a non-empty ops[] array');
                return true;
            }
            const runner = new MigrationRunner(deps.migrationBackend);
            const report = await runner.dryRun(plan);
            writeJson(res, 200, report);
        } catch (e) {
            // X-json400 (2026-09-03 audit) — malformed JSON used to fall
            // through to 500 here; readJsonBody's tagged error is caught
            // first now.
            if (isInvalidJsonBody(e)) { writeInvalidJson(res, e); return true; }
            writeError(res, 500, 'migration_dry_run_failed', redactError(e));
        }
        return true;
    }

    if (pathname === `${PREFIX}/migrations/execute` && req.method === 'POST') {
        // Write-scope + workspace-confinement gated in trySchemaRoutes (bindRouteTarget).
        if (denyNonHumanOperator(res)) return true;   // F-A1/F-A2
        if (!deps.migrationBackend) {
            writeError(res, 503, 'migration_backend_unavailable',
                'migration backend not wired in this daemon (cloud mode is not yet implemented)');
            return true;
        }
        try {
            const plan = await readJsonBody(req) as MigrationPlan;
            if (!plan || !Array.isArray(plan.ops) || plan.ops.length === 0) {
                writeError(res, 400, 'invalid_migration_plan',
                    'body must be a MigrationPlan with a non-empty ops[] array');
                return true;
            }
            if (!plan.approvedBy) {
                writeError(res, 400, 'invalid_migration_plan',
                    'plan.approvedBy is required (the operator running the migration)');
                return true;
            }
            // ── DESTRUCTIVE-EXECUTE SAFETY (2026-05-17 fix) ──────────────
            // Adversarial test 2026-05-17 surfaced this endpoint as an
            // unguarded backdoor: any bearer-token holder could delete
            // arbitrary node types in a single call, bypassing HITL,
            // snapshots, and audit linkage. Two-part close:
            //   1. approvedBy MUST be a human:* identity. AI/system
            //      actors cannot execute destructive migrations even if
            //      they were the original proposer.
            //   2. sandboxId is REQUIRED. It ties the execute to an
            //      already-approved schema proposal, which means a
            //      snapshot exists and rollback is possible. Direct
            //      executes without a sandboxId have no recovery path.
            if (!plan.approvedBy.startsWith('human:')) {
                writeError(res, 403, 'destructive_migration_requires_human',
                    `plan.approvedBy must be a human:* identity (got "${plan.approvedBy}"). ` +
                    `Destructive migrations require human approval — AI / system actors ` +
                    `cannot bypass HITL by hitting this endpoint directly.`);
                return true;
            }
            if (!plan.sandboxId) {
                writeError(res, 400, 'invalid_migration_plan',
                    'plan.sandboxId is required. Execute must be tied to an approved schema ' +
                    'proposal so a pre-execution snapshot exists for rollback. To migrate ' +
                    'data, first propose the change via POST /api/schema/proposals.');
                return true;
            }
            // ── APPROVED-OPS CORRELATION (audit C2 / L-002, 2026-06-17) ──
            // The sandboxId must reference a real approved proposal AND the
            // plan may only run operations that were part of THAT proposal.
            // The previous check only verified an approved proposal existed
            // (a `_<sandboxId>.json` history file) — it never compared the
            // ops, so an attacker could get a benign proposal approved (any
            // valid sandboxId, readable via GET /api/schema/history) and then
            // execute arbitrary destructive ops under it
            // (approve-benign-then-execute-arbitrary). approve() now persists
            // the canonical approved (kind,target) op set keyed by sandboxId;
            // require every plan.op to be a member (subset — so staged
            // expand/migrate/contract phases can each run a slice).
            const approved = deps.phaseA?.schemaAuthoring.getApprovedOps(plan.sandboxId);
            if (!approved) {
                writeError(res, 404, 'unknown_sandbox',
                    `sandboxId '${plan.sandboxId}' does not correspond to any approved proposal. ` +
                    `Either the proposal was never approved, predates approved-ops recording, ` +
                    `or it was rolled back. Propose + approve the change via ` +
                    `POST /api/schema/proposals first.`);
                return true;
            }
            // F-M02 — correlate EVERY destructive op against the approved set
            // via isUnapprovedDestructiveOp (see DESTRUCTIVE_OP_KINDS docs),
            // not just the row-DELETING subset the prior gate used. The earlier
            // gate only checked node_type.removed / field.removed /
            // edge_type.removed, so the other destructive kinds
            // (node_type.renamed, node_type.kind_changed, field.type_changed,
            // field.sensitivity_flipped, permission.changed, permission.removed)
            // could be smuggled into a benignly-approved sandbox. node_type.
            // renamed gets the same-kind exemption so the legitimate decompose
            // rename flow (which has no same-kind approved entry) is not
            // false-rejected; every other destructive kind has a same-kind
            // approved entry in its decompose, so strict correlation is safe.
            //
            // R-002 (LOW-MEDIUM, investigated 2026-06-18) — binding the
            // rename/retype TARGET (params.newName / params.newType) is NOT
            // closeable without a schema-authoring MODEL change, so it is
            // deliberately left out here rather than forced. Why a model
            // change is required:
            //   1. The authoritative newName/newType lives ONLY on the
            //      MigrationOp (plan.ops[].params), which is the CLIENT-
            //      supplied input we are trying to validate — it is not a
            //      trustworthy approved-side value.
            //   2. The approved-ops record (authoring.ts approve()) persists
            //      only {kind,target}. The sole approved-side carrier for a
            //      new name/type is ProposedChange.after, which is typed
            //      `unknown`, is optional + author-supplied, and is populated
            //      reliably only for node_type.added (phaseATools.ts). Trusting
            //      it for correlation would let an attacker who controls the
            //      proposal pick the value being checked against.
            //   3. The decompose flow does NOT emit a node_type.renamed /
            //      field.type_changed ProposedChange at all — a rename
            //      decomposes to node_type.added(newName) + node_type.removed
            //      (oldName) proposals plus a node_type.renamed migrate OP. So
            //      there is no same-kind approved entry to match, and deriving
            //      the rename from the add+remove pair would be a heuristic an
            //      attacker could spoof by getting unrelated add/remove
            //      proposals approved under one sandbox.
            // MINIMAL SAFE CLOSURE (deferred, not done here): add a typed,
            // approve()-persisted target to the approved-ops record for these
            // kinds — e.g. extend ProposedChange with an explicit
            // `renameTo?: string` / `retypeTo?: FieldType` (NOT the untyped
            // `after`), have approve() copy it into the {kind,target,renameTo}
            // op record, and correlate rename/retype ops here ONLY when the
            // approved record contains the SAME kind (so the decompose flow,
            // which has no such approved entry, is never false-rejected). That
            // touches authoring.ts, the ProposedChange type, wiring.ts
            // (changesToMigrationOps reads `after` today), and the HITL replay
            // path — a multi-file change with real regression risk to the
            // hardened migrate flow, so it is out of scope for this residual.
            // Residual impact is bounded: a rename/retype still requires a
            // valid HUMAN-approved sandbox (404 + human gate), so the exposure
            // is relabel/coerce-under-an-approved-sandbox (data integrity), NOT
            // the mass-delete vector the (kind,target) correlation closes.
            // F-M05/M06 — canonicalize target on BOTH sides via canonicalSig.
            const sig = canonicalSig;
            const approvedSigs = new Set(approved.ops.map(sig));
            const approvedKinds = new Set(approved.ops.map(o => o.kind));
            // F-M02 — correlate ALL destructive kinds (not just row-deleting).
            const unauthorizedOps = plan.ops.filter(
                o => isUnapprovedDestructiveOp(o, approvedSigs, approvedKinds, sig),
            );
            if (unauthorizedOps.length > 0) {
                writeError(res, 403, 'unapproved_migration_ops',
                    `plan.ops contains destructive operations not present in the approved proposal for ` +
                    `sandbox '${plan.sandboxId}': ` +
                    `${unauthorizedOps.map(o => `${o.kind}(${o.target})`).join(', ')}. ` +
                    `Execute may only delete what was approved.`);
                return true;
            }
            const runner = new MigrationRunner(
                deps.migrationBackend,
                deps.migrationCheckpointStore,
                deps.phaseA && deps.schemaWorkspace ? {
                    auditLog: deps.phaseA.schemaChangeAudit,
                    workspace: deps.schemaWorkspace,
                } : undefined,
            );
            const report = await runner.execute(plan);
            // Partial failures are still 200 — the report.succeeded
            // flag carries the truth. Use the body, not the status,
            // for "did everything work".
            writeJson(res, 200, report);
        } catch (e) {
            const msg = (e as Error).message;
            // Foreign in-flight plan is a 409 (conflict) — caller
            // can switch on this to surface "another migration is
            // running" in the admin UI instead of a generic 500.
            if (isInvalidJsonBody(e)) {
                // X-json400 (2026-09-03 audit) — malformed JSON used to fall
                // through to 500 here; readJsonBody's tagged error is
                // checked before the domain-specific classifiers below.
                writeInvalidJson(res, e);
            } else if (msg.startsWith(FOREIGN_IN_FLIGHT_ERROR)) {
                writeError(res, 409, FOREIGN_IN_FLIGHT_ERROR, redactError(e));
            } else {
                writeError(res, 500, 'migration_execute_failed', redactError(e));
            }
        }
        return true;
    }

    /* GET the currently-in-flight plan (if any) — operator visibility. */
    if (pathname === `${PREFIX}/migrations/in-flight` && req.method === 'GET') {
        if (!deps.migrationCheckpointStore) {
            writeError(res, 503, 'migration_checkpoint_unavailable',
                'migration checkpoint store not wired');
            return true;
        }
        const state = deps.migrationCheckpointStore.load();
        writeJson(res, 200, { inFlight: state });
        return true;
    }

    /* POST /resume — continue an in-flight plan from its saved cursor. */
    if (pathname === `${PREFIX}/migrations/resume` && req.method === 'POST') {
        // Write-scope + workspace-confinement gated in trySchemaRoutes (bindRouteTarget).
        if (denyNonHumanOperator(res)) return true;   // F-A1/F-A2
        if (!deps.migrationBackend || !deps.migrationCheckpointStore) {
            writeError(res, 503, 'migration_resume_unavailable',
                'migration backend or checkpoint store not wired');
            return true;
        }
        try {
            const body = await readJsonBody(req) as { planId?: string };
            if (!body?.planId) {
                writeError(res, 400, 'invalid_resume_body', 'body must be {planId: string}');
                return true;
            }
            // ── RESUME SAFETY (audit L-021, 2026-06-17) ──────────────────
            // L-001 gated resume on write scope, but resume still bypassed
            // the two human-approval safeguards execute enforces. A caller
            // with mere write scope (no human identity, no fresh approval)
            // could resume any checkpoint left on disk and complete its
            // destructive deletions. Re-assert both execute-parity checks
            // against the PERSISTED checkpoint (not a request body):
            //   1. the in-flight plan must carry a human:* approver.
            //   2. its deletion ops must correlate to the approved-ops set
            //      recorded under its sandboxId (the L-002 correlation).
            const inFlight = deps.migrationCheckpointStore.load();
            if (!inFlight || inFlight.planId !== body.planId) {
                writeError(res, 404, 'no_in_flight_plan',
                    `no in-flight plan with id '${body.planId}'`);
                return true;
            }
            if (!inFlight.approvedBy || !inFlight.approvedBy.startsWith('human:')) {
                writeError(res, 403, 'destructive_migration_requires_human',
                    'resume of a destructive migration requires the in-flight plan to carry a human:* approver');
                return true;
            }
            const approved = deps.phaseA?.schemaAuthoring.getApprovedOps(inFlight.sandboxId ?? '');
            if (!approved) {
                writeError(res, 404, 'unknown_sandbox',
                    `the in-flight plan's sandboxId '${inFlight.sandboxId ?? ''}' does not correspond to ` +
                    `any approved proposal. Resume requires a human-approved, op-correlated checkpoint.`);
                return true;
            }
            // F-M05/M06 — canonicalize target on BOTH sides via canonicalSig.
            const sig = canonicalSig;
            const approvedSigs = new Set(approved.ops.map(sig));
            const approvedKinds = new Set(approved.ops.map(o => o.kind));
            // F-M02 — correlate all destructive kinds, not just row-deleting.
            const unauthorizedOps = inFlight.ops
                .map(co => co.op)
                .filter(o => isUnapprovedDestructiveOp(o, approvedSigs, approvedKinds, sig));
            if (unauthorizedOps.length > 0) {
                writeError(res, 403, 'unapproved_migration_ops',
                    `the in-flight plan contains destructive operations not present in the approved proposal for ` +
                    `sandbox '${inFlight.sandboxId ?? ''}': ` +
                    `${unauthorizedOps.map(o => `${o.kind}(${o.target})`).join(', ')}. ` +
                    `Resume may only complete what was approved.`);
                return true;
            }
            const runner = new MigrationRunner(
                deps.migrationBackend,
                deps.migrationCheckpointStore,
                deps.phaseA && deps.schemaWorkspace ? {
                    auditLog: deps.phaseA.schemaChangeAudit,
                    workspace: deps.schemaWorkspace,
                } : undefined,
            );
            const report = await runner.resume(body.planId);
            writeJson(res, 200, report);
        } catch (e) {
            const msg = (e as Error).message;
            if (isInvalidJsonBody(e)) {
                // X-json400 (2026-09-03 audit) — see the execute handler above.
                writeInvalidJson(res, e);
            } else if (/no in-flight plan/i.test(msg)) {
                writeError(res, 404, 'no_in_flight_plan', redactError(e));
            } else {
                writeError(res, 500, 'migration_resume_failed', redactError(e));
            }
        }
        return true;
    }

    /* DELETE /in-flight — clear the checkpoint (operator escape hatch). */
    if (pathname === `${PREFIX}/migrations/in-flight` && req.method === 'DELETE') {
        // D2-authz-4 — clearing the in-flight checkpoint is a destructive
        // cross-workspace control. The write-scope + workspace-confinement check
        // runs in trySchemaRoutes (bindRouteTarget, intent='write' for DELETE),
        // and Wave 4.2 additionally 409s any non-boot target — so a token bound to
        // ws-A can no longer reach the boot-wired checkpoint at all. The operator
        // (bootstrap) identity gate below is retained (mirrors execute/resume/rollback).
        if (denyNonHumanOperator(res)) return true;   // F-A1/F-A2
        if (!deps.migrationCheckpointStore) {
            writeError(res, 503, 'migration_checkpoint_unavailable',
                'migration checkpoint store not wired');
            return true;
        }
        deps.migrationCheckpointStore.clear();
        writeJson(res, 200, { cleared: true });
        return true;
    }

    /* POST /decompose — Phase 4 item 9. Take a destructive schema
     * change and return an expand → migrate → contract plan an
     * operator can step through using the existing endpoints. The
     * route does not execute anything; the body is informational.
     * Body = { change: ProposedChange, proposedBy: string,
     *          params?: Record<string,unknown>, sandboxId?: string }. */
    if (pathname === `${PREFIX}/migrations/decompose` && req.method === 'POST') {
        // Write-scope + workspace-confinement gated in trySchemaRoutes (bindRouteTarget).
        try {
            const body = await readJsonBody(req) as {
                change?: ProposedChange;
                proposedBy?: string;
                params?: Record<string, unknown>;
                sandboxId?: string;
            };
            if (!body?.change || !body.change.kind || !body.change.target) {
                writeError(res, 400, 'invalid_decompose_body',
                    'body must be {change: ProposedChange, proposedBy: string, params?, sandboxId?}');
                return true;
            }
            if (!body.proposedBy) {
                writeError(res, 400, 'invalid_decompose_body',
                    'proposedBy is required (kind:id convention, e.g. "human:rafi")');
                return true;
            }
            const liveSchema = deps.schemaLoader.getV2();
            const plan = decompose(body.change, {
                liveSchema,
                proposedBy: body.proposedBy,
                params: body.params,
                sandboxId: body.sandboxId,
            });
            writeJson(res, 200, plan);
        } catch (e) {
            // X-json400 (2026-09-03 audit) — malformed JSON never matched
            // the /required|no type|missing/i classifier below (readJsonBody's
            // message is "invalid JSON body: ..."), so it fell to 500. Check
            // the tag first for a clean 400 instead.
            if (isInvalidJsonBody(e)) { writeInvalidJson(res, e); return true; }
            const msg = (e as Error).message;
            // Missing-params + missing-type-on-live-schema errors are
            // 400, not 500 — they reflect a caller mistake.
            const status = /required|no type|missing/i.test(msg) ? 400 : 500;
            writeError(res, status, 'decompose_failed', redactError(e));
        }
        return true;
    }

    /* POST /rollback — reverse a previously-executed plan using the
     * Phase 1 data snapshots. Body = { plan: MigrationPlan (with
     * sandboxId), executeReport: ExecuteReport }. */
    if (pathname === `${PREFIX}/migrations/rollback` && req.method === 'POST') {
        // Write-scope + workspace-confinement gated in trySchemaRoutes (bindRouteTarget).
        if (denyNonHumanOperator(res)) return true;   // F-A1/F-A2
        if (!deps.migrationBackend) {
            writeError(res, 503, 'migration_backend_unavailable',
                'migration backend not wired');
            return true;
        }
        if (!deps.loreDir) {
            writeError(res, 503, 'migration_loredir_unavailable',
                'loreDir not wired — cannot locate data snapshots');
            return true;
        }
        try {
            const body = await readJsonBody(req) as { plan?: MigrationPlan & { sandboxId?: string }; executeReport?: ExecuteReport };
            if (!body?.plan || !body?.executeReport) {
                writeError(res, 400, 'invalid_rollback_body',
                    'body must be {plan: MigrationPlan (with sandboxId), executeReport: ExecuteReport}');
                return true;
            }
            if (!body.plan.sandboxId) {
                writeError(res, 400, 'invalid_rollback_body',
                    'plan.sandboxId is required to locate the data snapshots');
                return true;
            }
            // ── ROLLBACK SAFETY (audit B3 / F12, 2026-06-18) ─────────────
            // rollback restores snapshot rows back into the LIVE graph — a
            // destructive schema-data write. execute and resume both enforce
            // a human:* approver AND the L-002 approved-ops correlation;
            // rollback gated only write-scope (requireMigrationWriteScope
            // above), so a bare write token could drive a crafted rollback
            // (attacker-supplied plan + executeReport) with no human or
            // approved-proposal binding. Re-assert execute-parity on the
            // supplied plan. getApprovedOps also validates plan.sandboxId
            // (its own regex → null), so this closes traversal via sandboxId.
            if (!body.plan.approvedBy || !body.plan.approvedBy.startsWith('human:')) {
                writeError(res, 403, 'destructive_migration_requires_human',
                    `plan.approvedBy must be a human:* identity (got "${body.plan.approvedBy ?? ''}"). ` +
                    `Rolling back a destructive migration requires human approval.`);
                return true;
            }
            const rbApproved = deps.phaseA?.schemaAuthoring.getApprovedOps(body.plan.sandboxId);
            if (!rbApproved) {
                writeError(res, 404, 'unknown_sandbox',
                    `plan.sandboxId '${body.plan.sandboxId}' does not correspond to any approved ` +
                    `proposal; rollback requires a human-approved, op-correlated sandbox.`);
                return true;
            }
            // F-M05/M06 — canonicalize target on BOTH sides via canonicalSig.
            const rbSig = canonicalSig;
            const rbApprovedSigs = new Set(rbApproved.ops.map(rbSig));
            const rbApprovedKinds = new Set(rbApproved.ops.map(o => o.kind));
            // Correlate the ACTUAL executed ops that runner.rollback consumes
            // (executeReport.ops[].op — runner.ts:201-203 iterates executeReport,
            // NOT plan), unioned with plan.ops. The first pass of this fix only
            // checked plan.ops, but rollback drives its snapshot-restore writes
            // off executeReport.ops — so a benign plan.ops could satisfy the gate
            // while executeReport.ops carried arbitrary deletion ops (adversarial
            // review B3 finding). Correlate BOTH fields so neither can smuggle an
            // unapproved deletion.
            const rbCandidateOps = [
                ...(Array.isArray(body.plan.ops) ? body.plan.ops : []),
                ...(Array.isArray(body.executeReport.ops) ? body.executeReport.ops.map(e => e.op).filter(Boolean) : []),
            ];
            // F-M02 — correlate all destructive kinds, not just row-deleting.
            const rbUnauthorized = rbCandidateOps.filter(
                o => isUnapprovedDestructiveOp(o, rbApprovedSigs, rbApprovedKinds, rbSig),
            );
            if (rbUnauthorized.length > 0) {
                writeError(res, 403, 'unapproved_migration_ops',
                    `rollback plan/executeReport contains destructive operations not present in the approved ` +
                    `proposal for sandbox '${body.plan.sandboxId}': ${rbUnauthorized.map(o => `${o.kind}(${o.target})`).join(', ')}. ` +
                    `Rollback may only reverse what was approved.`);
                return true;
            }
            const runner = new MigrationRunner(
                deps.migrationBackend,
                deps.migrationCheckpointStore,
                deps.phaseA && deps.schemaWorkspace ? {
                    auditLog: deps.phaseA.schemaChangeAudit,
                    workspace: deps.schemaWorkspace,
                } : undefined,
            );
            const snapshotsDir = path.join(deps.loreDir, 'data-snapshots');
            const report = await runner.rollback(
                body.plan as MigrationPlan & { sandboxId: string },
                body.executeReport,
                snapshotsDir,
            );
            writeJson(res, 200, report);
        } catch (e) {
            // X-json400 (2026-09-03 audit) — see the dry-run handler above.
            if (isInvalidJsonBody(e)) { writeInvalidJson(res, e); return true; }
            writeError(res, 500, 'migration_rollback_failed', redactError(e));
        }
        return true;
    }

    return false;
}
