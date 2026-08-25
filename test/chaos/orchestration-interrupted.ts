#!/usr/bin/env tsx
/**
 * test/chaos/orchestration-interrupted.ts — proves an in-progress
 * DecomposedPlan orchestration survives daemon restart.
 *
 * Scenario: orchestrator is mid-plan (migrate done, awaiting contract
 * approval). Daemon is killed and restarts. A FRESH PlanOrchestrator
 * pointed at the same OrchestrationStore on disk picks up exactly
 * where the prior one left off — same phase index, same status —
 * and walks the plan to completion when approval lands.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { decompose, type DecomposedPlan } from '../../packages/lore/src/schemas/decomposition.js';
import { PlanOrchestrator } from '../../packages/lore/src/schemas/orchestration/orchestrator.js';
import { OrchestrationStore } from '../../packages/lore/src/schemas/orchestration/store.js';
import { SchemaAuthoringStore } from '../../packages/lore/src/schemas/authoring.js';
import { SchemaChangeAuditLogger } from '../../packages/lore/src/security/schemaChangeAudit.js';
import {
    DEFAULT_SCHEMA_V2, type LoreSchemaV2, type NodeTypeSpec,
} from '../../packages/lore/src/schemas/types.js';
import type {
    MigrationBackend, MigrationOp, BatchResult,
} from '../../packages/lore/src/schemas/migration/types.js';

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

function fakeBackend(): MigrationBackend {
    return {
        async dryRunOp() { return { affectedRowCount: 0 }; },
        async executeOpBatch(_op: MigrationOp, _cursor, _batchSize): Promise<BatchResult> {
            return { deleted: 1, modified: 0, nextCursor: null };
        },
        async rollbackOp() { return { restored: 0, repaired: 0 }; },
    };
}

function makeHarness() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-chaos-orch-'));
    const loreDir = path.join(dir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    const live = liveWithTenant();
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(live));
    const audit = new SchemaChangeAuditLogger(loreDir);
    const authoring = new SchemaAuthoringStore(dir, audit);
    return { dir, loreDir, liveSchema: live, audit, authoring };
}

console.log('chaos: orchestration interrupted between phases');

test('orchestrator dies mid-plan; fresh instance on same disk picks up where it left off', async () => {
    const h = makeHarness();
    try {
        const plan: DecomposedPlan = decompose(
            { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' },
            { liveSchema: h.liveSchema, proposedBy: 'human:rafi' },
        );

        // === Process 1: orchestrator starts, runs migrate, submits
        // contract proposal, then DIES. ===
        const store1 = new OrchestrationStore(h.loreDir);
        const orch1 = new PlanOrchestrator({
            store: store1,
            schemaAuthoring: h.authoring,
            migrationBackend: fakeBackend(),
        });
        const initial = orch1.create(plan, {
            proposedBy: 'human:rafi', approvedBy: 'human:rafi', soakSeconds: 0,
        });
        const advanced1 = await orch1.tick(initial.id);
        assert.equal(advanced1.status, 'awaiting_approval');
        assert.equal(advanced1.currentPhaseIndex, 1);
        const sandboxId = advanced1.phases[1].sandboxId!;
        assert.ok(sandboxId);

        // === Simulated daemon restart: drop orch1 + store1 references. ===
        // (In real life: process exits, launchd restarts it.)

        // === Process 2: fresh orchestrator + fresh store, same disk. ===
        const store2 = new OrchestrationStore(h.loreDir);
        const orch2 = new PlanOrchestrator({
            store: store2,
            schemaAuthoring: h.authoring,
            migrationBackend: fakeBackend(),
        });
        const reloaded = orch2.get(initial.id);
        assert.ok(reloaded, 'orchestration survived restart');
        assert.equal(reloaded!.status, 'awaiting_approval');
        assert.equal(reloaded!.currentPhaseIndex, 1);
        assert.equal(reloaded!.phases[0].status, 'completed', 'migrate phase preserved');
        assert.equal(reloaded!.phases[1].sandboxId, sandboxId);

        // === Operator approves the contract sandbox (could be HITL queue
        // OR direct depending on policy). ===
        await h.authoring.approve(sandboxId, 'human:rafi');

        // === Tick on the fresh orchestrator → completes the plan. ===
        const final = await orch2.tick(initial.id);
        assert.equal(final.status, 'completed');
        assert.equal(final.currentPhaseIndex, 2);
    } finally {
        try { fs.rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
    }
});

test('orchestrator dies mid-soak; fresh instance honors the remaining soak window', async () => {
    const h = makeHarness();
    try {
        const plan: DecomposedPlan = decompose(
            { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' },
            { liveSchema: h.liveSchema, proposedBy: 'human:rafi' },
        );
        // Inject a clock so we control when soak elapses.
        let now = new Date('2026-05-17T00:00:00Z');
        const store1 = new OrchestrationStore(h.loreDir);
        const orch1 = new PlanOrchestrator({
            store: store1,
            schemaAuthoring: h.authoring,
            migrationBackend: fakeBackend(),
            now: () => now,
        });
        const initial = orch1.create(plan, {
            proposedBy: 'human:rafi', approvedBy: 'human:rafi', soakSeconds: 60,
        });
        const afterMigrate = await orch1.tick(initial.id);
        assert.equal(afterMigrate.status, 'awaiting_soak');
        assert.ok(afterMigrate.phases[1].soakUntilIso);
        const soakUntil = afterMigrate.phases[1].soakUntilIso!;

        // === Daemon dies during soak. Fresh orchestrator picks up. ===
        // Clock advances only +30s (still within the 60s soak).
        now = new Date('2026-05-17T00:00:30Z');
        const orch2 = new PlanOrchestrator({
            store: new OrchestrationStore(h.loreDir),
            schemaAuthoring: h.authoring,
            migrationBackend: fakeBackend(),
            now: () => now,
        });
        const reloaded = await orch2.tick(initial.id);
        assert.equal(reloaded.status, 'awaiting_soak', 'soak honored across restart');
        assert.equal(reloaded.phases[1].soakUntilIso, soakUntil, 'same soak deadline');

        // === Clock crosses the soak boundary. Tick advances. ===
        now = new Date('2026-05-17T00:01:30Z');
        const past = await orch2.tick(initial.id);
        assert.equal(past.status, 'awaiting_approval', 'past soak, contract submitted');
    } finally {
        try { fs.rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
    }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
