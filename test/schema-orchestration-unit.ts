#!/usr/bin/env tsx
/**
 * test/schema-orchestration-unit.ts — Phase 4 item 4.
 *
 * Verifies PlanOrchestrator walks a DecomposedPlan through expand →
 * migrate → soak → contract using:
 *   - real SchemaAuthoringStore (file-backed in a tmpdir)
 *   - real OrchestrationStore (file-backed in same tmpdir)
 *   - fake MigrationBackend (avoids Kùzu segfault pattern)
 *   - injected clock so soak-timer transitions are deterministic
 *
 * Coverage:
 *   - 2-phase (migrate + contract) end-to-end with zero soak
 *   - Soak gating between phases
 *   - Migrate failure marks orchestration failed
 *   - abort() halts further progression
 *   - Persistence survives a fresh orchestrator instance (resume scenario)
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    SchemaAuthoringStore,
} from '../packages/lore/src/schemas/authoring.js';
import { decompose, type DecomposedPlan } from '../packages/lore/src/schemas/decomposition.js';
import { PlanOrchestrator } from '../packages/lore/src/schemas/orchestration/orchestrator.js';
import { OrchestrationStore } from '../packages/lore/src/schemas/orchestration/store.js';
import { SchemaChangeAuditLogger } from '../packages/lore/src/security/schemaChangeAudit.js';
import {
    DEFAULT_SCHEMA_V2, type LoreSchemaV2, type NodeTypeSpec,
} from '../packages/lore/src/schemas/types.js';
import type {
    MigrationBackend, MigrationOp, BatchResult,
} from '../packages/lore/src/schemas/migration/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

function liveWithTenant(): LoreSchemaV2 {
    const tenant: NodeTypeSpec = { name: 'know.Tenant', description: '', kind: 'factual' };
    return { ...DEFAULT_SCHEMA_V2, nodeTypes: [...DEFAULT_SCHEMA_V2.nodeTypes, tenant] };
}

function makeFakeBackend(opts: { fail?: boolean } = {}): MigrationBackend {
    return {
        async dryRunOp() { return { affectedRowCount: 0 }; },
        async executeOpBatch(_op: MigrationOp, _cursor, _batchSize): Promise<BatchResult> {
            if (opts.fail) throw new Error('synthetic migrate failure');
            return { deleted: 1, modified: 0, nextCursor: null };
        },
        async rollbackOp() { return { restored: 0, repaired: 0 }; },
    };
}

function makeHarness() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-orch-'));
    const loreDir = path.join(dir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    const liveSchema = liveWithTenant();
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(liveSchema));
    const audit = new SchemaChangeAuditLogger(loreDir);
    const authoring = new SchemaAuthoringStore(dir, audit);
    const orchStore = new OrchestrationStore(loreDir);
    return { dir, loreDir, liveSchema, audit, authoring, orchStore };
}

console.log('schema orchestration — Phase 4 item 4');

test('2-phase plan (node_type.removed) walks migrate → contract end-to-end with zero soak', async () => {
    const h = makeHarness();
    const plan: DecomposedPlan = decompose(
        { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema: h.liveSchema, proposedBy: 'human:rafi' },
    );
    const orch = new PlanOrchestrator({
        store: h.orchStore,
        schemaAuthoring: h.authoring,
        migrationBackend: makeFakeBackend(),
    });
    const initial = orch.create(plan, { proposedBy: 'human:rafi', approvedBy: 'human:rafi', soakSeconds: 0 });
    assert.equal(initial.currentPhaseIndex, 0);
    assert.equal(initial.phases.length, 2);

    // First tick — runs migrate (sync) → submits contract → status awaiting_approval.
    let state = await orch.tick(initial.id);
    assert.equal(state.phases[0].status, 'completed', `migrate done; got ${state.phases[0].status}`);
    assert.ok(state.phases[0].executeReport?.succeeded);
    assert.equal(state.currentPhaseIndex, 1);
    assert.equal(state.phases[1].status, 'submitted');
    assert.equal(state.status, 'awaiting_approval');
    assert.ok(state.phases[1].sandboxId);

    // Operator approves the contract sandbox.
    await h.authoring.approve(state.phases[1].sandboxId!, 'human:rafi');

    // Second tick — observes the sandbox is gone → marks completed.
    state = await orch.tick(initial.id);
    assert.equal(state.status, 'completed');
    assert.equal(state.phases[1].status, 'completed');
    assert.equal(state.currentPhaseIndex, 2);
});

test('soak gating: when soakSeconds > 0, the next phase waits awaiting_soak until the clock advances', async () => {
    const h = makeHarness();
    const plan: DecomposedPlan = decompose(
        { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema: h.liveSchema, proposedBy: 'human:rafi' },
    );
    let fakeNow = new Date('2026-05-16T00:00:00Z');
    const orch = new PlanOrchestrator({
        store: h.orchStore,
        schemaAuthoring: h.authoring,
        migrationBackend: makeFakeBackend(),
        now: () => fakeNow,
    });
    const initial = orch.create(plan, { proposedBy: 'human:rafi', approvedBy: 'human:rafi', soakSeconds: 60 });
    let state = await orch.tick(initial.id);
    // Migrate completes; soak set on next phase; status awaiting_soak.
    assert.equal(state.phases[0].status, 'completed');
    assert.equal(state.status, 'awaiting_soak');
    assert.ok(state.phases[1].soakUntilIso);
    assert.equal(state.phases[1].status, 'pending');

    // Tick before soak elapses — no progression.
    fakeNow = new Date('2026-05-16T00:00:30Z'); // +30s of 60s soak
    state = await orch.tick(initial.id);
    assert.equal(state.status, 'awaiting_soak');
    assert.equal(state.phases[1].status, 'pending');

    // Tick after soak elapses — contract gets submitted.
    fakeNow = new Date('2026-05-16T00:01:30Z'); // +90s, past 60s soak
    state = await orch.tick(initial.id);
    assert.equal(state.status, 'awaiting_approval');
    assert.equal(state.phases[1].status, 'submitted');
});

test('migrate failure marks the orchestration failed and freezes progress', async () => {
    const h = makeHarness();
    const plan: DecomposedPlan = decompose(
        { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema: h.liveSchema, proposedBy: 'human:rafi' },
    );
    const orch = new PlanOrchestrator({
        store: h.orchStore,
        schemaAuthoring: h.authoring,
        migrationBackend: makeFakeBackend({ fail: true }),
    });
    const initial = orch.create(plan, { proposedBy: 'human:rafi', approvedBy: 'human:rafi', soakSeconds: 0 });
    const state = await orch.tick(initial.id);
    assert.equal(state.status, 'failed');
    assert.equal(state.phases[0].status, 'failed');
    assert.match(state.phases[0].error ?? '', /synthetic migrate failure|migrate threw|migrate failed/i);
    assert.equal(state.failedAt?.phaseIndex, 0);
});

test('abort() halts a running orchestration and is idempotent', async () => {
    const h = makeHarness();
    const plan: DecomposedPlan = decompose(
        { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema: h.liveSchema, proposedBy: 'human:rafi' },
    );
    const orch = new PlanOrchestrator({
        store: h.orchStore,
        schemaAuthoring: h.authoring,
        migrationBackend: makeFakeBackend(),
    });
    const initial = orch.create(plan, { proposedBy: 'human:rafi', approvedBy: 'human:rafi', soakSeconds: 0 });
    await orch.tick(initial.id); // run migrate + submit contract
    const aborted = orch.abort(initial.id, 'operator changed mind');
    assert.equal(aborted.status, 'aborted');
    assert.match(aborted.note ?? '', /aborted: operator changed mind/);
    // Idempotent — a second abort doesn't crash and stays aborted.
    const again = orch.abort(initial.id);
    assert.equal(again.status, 'aborted');
    // Further ticks are no-ops.
    const post = await orch.tick(initial.id);
    assert.equal(post.status, 'aborted');
});

test('persistence: a fresh orchestrator picks up where the prior one left off', async () => {
    const h = makeHarness();
    const plan: DecomposedPlan = decompose(
        { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema: h.liveSchema, proposedBy: 'human:rafi' },
    );
    const orch1 = new PlanOrchestrator({
        store: h.orchStore,
        schemaAuthoring: h.authoring,
        migrationBackend: makeFakeBackend(),
    });
    const initial = orch1.create(plan, { proposedBy: 'human:rafi', approvedBy: 'human:rafi', soakSeconds: 0 });
    const advanced = await orch1.tick(initial.id);
    assert.equal(advanced.status, 'awaiting_approval');

    // Spin up a fresh orchestrator pointing at the same OrchestrationStore.
    const orch2 = new PlanOrchestrator({
        store: new OrchestrationStore(h.loreDir),
        schemaAuthoring: h.authoring,
        migrationBackend: makeFakeBackend(),
    });
    const reloaded = orch2.get(initial.id);
    assert.ok(reloaded);
    assert.equal(reloaded!.status, 'awaiting_approval');
    assert.equal(reloaded!.currentPhaseIndex, 1);

    // Approve the contract sandbox; the fresh orchestrator should
    // advance it to completion.
    await h.authoring.approve(advanced.phases[1].sandboxId!, 'human:rafi');
    const final = await orch2.tick(initial.id);
    assert.equal(final.status, 'completed');
});

test('create() refuses a decomposed plan with zero phases (additive)', async () => {
    const h = makeHarness();
    const additive = decompose(
        { kind: 'node_type.added', target: 'know.NewX', migration: 'lazy' },
        { liveSchema: h.liveSchema, proposedBy: 'ai:claude' },
    );
    const orch = new PlanOrchestrator({
        store: h.orchStore,
        schemaAuthoring: h.authoring,
        migrationBackend: makeFakeBackend(),
    });
    assert.throws(
        () => orch.create(additive, { proposedBy: 'human:rafi', approvedBy: 'human:rafi', soakSeconds: 0 }),
        /zero phases/i,
    );
});

/* ── R-001 — migrate phase re-asserts execute-parity gates ───────── */

test('R-001 migrate phase fails when the effective approvedBy is not human:*', async () => {
    const h = makeHarness();
    // Valid decomposition (human proposer so the contract proposal is sound),
    // but force the MIGRATE phase's effective approver to a non-human actor —
    // i.e. nobody re-stamps approvedBy, and the plan's per-phase value is the
    // override an attacker would use. Mirrors migrations.ts execute's human
    // gate: the destructive runner.execute must be refused before it runs.
    const plan: DecomposedPlan = decompose(
        { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema: h.liveSchema, proposedBy: 'human:rafi' },
    );
    // phases[0] is the migrate phase for node_type.removed (deletion op).
    assert.equal(plan.phases[0].kind, 'migrate');
    if (plan.phases[0].kind === 'migrate') plan.phases[0].plan.approvedBy = 'ai:claude';
    const orch = new PlanOrchestrator({
        store: h.orchStore,
        schemaAuthoring: h.authoring,
        migrationBackend: makeFakeBackend(),
    });
    // create-time approvedBy also non-human so the fallback can't rescue it.
    const initial = orch.create(plan, { proposedBy: 'human:rafi', approvedBy: 'ai:claude', soakSeconds: 0 });
    const state = await orch.tick(initial.id);
    assert.equal(state.status, 'failed');
    assert.equal(state.phases[0].status, 'failed');
    assert.match(state.phases[0].error ?? '', /human:\*? approver|require.*human/i);
});

test('R-001 migrate phase refused when a deletion op is NOT in an existing approved-ops record for its sandboxId', async () => {
    const h = makeHarness();
    // Approve a BENIGN proposal (an additive node type). approve() writes an
    // approved-ops record keyed by THIS sandboxId — it contains only the
    // benign op, NOT a node_type.removed of know.Tenant.
    const benign = await h.authoring.propose({
        nextSchema: { ...h.liveSchema, nodeTypes: [...h.liveSchema.nodeTypes, { name: 'know.Benign', description: '', kind: 'factual' }] },
        changes: [{ kind: 'node_type.added', target: 'know.Benign', migration: 'lazy' }],
        proposedBy: 'human:rafi',
    });
    await h.authoring.approve(benign.sandboxId, 'human:rafi');
    // Confirm the approved-ops record exists (so the correlation is exercised,
    // not skipped on a missing record — that's the decompose-flow fall-through
    // path the OTHER tests cover).
    assert.ok(h.authoring.getApprovedOps(benign.sandboxId), 'benign approval must persist an approved-ops record');

    // Now drive an orchestration whose migrate phase is a node_type.removed
    // (a deletion op) but points its sandboxId at the benign approval — the
    // approve-benign-then-run-arbitrary attack via orchestration.
    const plan: DecomposedPlan = decompose(
        { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema: h.liveSchema, proposedBy: 'human:rafi' },
    );
    assert.equal(plan.phases[0].kind, 'migrate');
    if (plan.phases[0].kind === 'migrate') plan.phases[0].plan.sandboxId = benign.sandboxId;
    const orch = new PlanOrchestrator({
        store: h.orchStore,
        schemaAuthoring: h.authoring,
        migrationBackend: makeFakeBackend(),
    });
    const initial = orch.create(plan, { proposedBy: 'human:rafi', approvedBy: 'human:rafi', soakSeconds: 0 });
    const state = await orch.tick(initial.id);
    assert.equal(state.status, 'failed');
    assert.equal(state.phases[0].status, 'failed');
    assert.match(state.phases[0].error ?? '', /not in the approved|may only delete what was approved/i);
});

test('R-001 standard decompose flow (no approved-ops record for the sandbox) is NOT blocked by the correlation', async () => {
    const h = makeHarness();
    // The legitimate staged flow: the removal proposal is approved by a LATER
    // contract phase, so at migrate time there is NO approved-ops record for
    // the plan's sandboxId. The correlation must fall through (human gate +
    // create-time write scope still apply) so the migrate phase runs.
    const plan: DecomposedPlan = decompose(
        { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema: h.liveSchema, proposedBy: 'human:rafi', sandboxId: 'never-approved-sandbox' },
    );
    assert.equal(plan.phases[0].kind, 'migrate');
    // No approved-ops record exists for 'never-approved-sandbox'.
    assert.equal(h.authoring.getApprovedOps('never-approved-sandbox'), null);
    const orch = new PlanOrchestrator({
        store: h.orchStore,
        schemaAuthoring: h.authoring,
        migrationBackend: makeFakeBackend(),
    });
    const initial = orch.create(plan, { proposedBy: 'human:rafi', approvedBy: 'human:rafi', soakSeconds: 0 });
    const state = await orch.tick(initial.id);
    // Migrate ran (completed) and the contract phase was submitted — the
    // correlation did not false-reject the staged flow.
    assert.equal(state.phases[0].status, 'completed', `migrate must run; got ${state.phases[0].error ?? state.phases[0].status}`);
    assert.equal(state.status, 'awaiting_approval');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
