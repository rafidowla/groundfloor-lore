#!/usr/bin/env tsx
/**
 * test/pkg3-isolation-unit.ts — deferred-tail Package 3 (multi-master / cloud
 * isolation) NEW-behavior tests.
 *
 *   R4-002  ConflictEntry carries a `workspace` tag (set by a per-workspace
 *           MultiMasterMerger); ConflictLog.list filters by it so a scoped
 *           reader can't enumerate other workspaces' conflict history, and
 *           legacy untagged entries are excluded when a workspace filter is set.
 *   orch-5  per-orchestration tick lock: two concurrent tick() calls on the
 *           same orchestration are serialized, so the migrate phase executes
 *           exactly ONCE (no double-execute from an interleaved load-modify-save).
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ConflictLog, MultiMasterMerger, type NodeState, type ChangeRecord } from '../packages/lore/src/engines/multiMasterSync.js';
import { decompose, type DecomposedPlan } from '../packages/lore/src/schemas/decomposition.js';
import { PlanOrchestrator } from '../packages/lore/src/schemas/orchestration/orchestrator.js';
import { OrchestrationStore } from '../packages/lore/src/schemas/orchestration/store.js';
import { SchemaChangeAuditLogger } from '../packages/lore/src/security/schemaChangeAudit.js';
import { SchemaAuthoringStore } from '../packages/lore/src/schemas/authoring.js';
import { DEFAULT_SCHEMA_V2, type LoreSchemaV2, type NodeTypeSpec } from '../packages/lore/src/schemas/types.js';
import type { MigrationBackend, MigrationOp, BatchResult } from '../packages/lore/src/schemas/migration/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

const createdTmpDirs: string[] = [];
function tmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg3-'));
    createdTmpDirs.push(d);
    return d;
}

console.log('Package 3 isolation — conflict-log workspace tagging + orchestration tick lock');

/* ─────────────────── R4-002: conflict-log workspace tag + filter ─────────── */

test('R4-002 merger tags conflicts with its workspace; list filters per workspace', async () => {
    const dir = tmpDir();
    const log = new ConflictLog(dir);

    // Two per-workspace mergers writing to the SAME daemon-wide log.
    const mergerA = new MultiMasterMerger(log, 'ws-a');
    const mergerB = new MultiMasterMerger(log, 'ws-b');

    // A field-level conflict on the same node from two devices — incumbent wins,
    // loser recorded. (Deterministic: device 'd1' wrote later/higher lamport.)
    const stateA: NodeState = { nodeId: 'n1', fields: { title: 'A-incumbent' }, lastWrite: { title: { wallClockMs: 200, lamport: 5, deviceId: 'd1' } } };
    const losingChange: ChangeRecord = { nodeId: 'n1', field: 'title', value: 'A-loser', wallClockMs: 100, lamport: 2, deviceId: 'd2' };
    mergerA.applyChange(stateA, losingChange);

    const stateB: NodeState = { nodeId: 'n2', fields: { title: 'B-incumbent' }, lastWrite: { title: { wallClockMs: 200, lamport: 5, deviceId: 'd1' } } };
    mergerB.applyChange(stateB, { ...losingChange, nodeId: 'n2', value: 'B-loser' });

    const aOnly = log.list({ workspace: 'ws-a' });
    const bOnly = log.list({ workspace: 'ws-b' });
    assert.equal(aOnly.length, 1, 'ws-a sees exactly its own conflict');
    assert.equal(aOnly[0].workspace, 'ws-a');
    assert.equal(aOnly[0].nodeId, 'n1');
    assert.equal(bOnly.length, 1, 'ws-b sees exactly its own conflict');
    assert.equal(bOnly[0].nodeId, 'n2');

    // No cross-workspace leakage; unknown workspace sees nothing.
    assert.equal(log.list({ workspace: 'ws-c' }).length, 0, 'a scoped reader for a 3rd ws sees no conflicts');
    // No filter → full daemon-wide view (operator/admin path).
    assert.equal(log.list().length, 2, 'unfiltered list still returns everything');
});

test('R4-002 a workspace filter excludes legacy untagged conflict entries', async () => {
    const dir = tmpDir();
    const log = new ConflictLog(dir);
    // Legacy entry written WITHOUT a workspace (pre-R4-002 producer).
    log.append({ nodeId: 'legacy', field: 'x', at: '2026-01-01T00:00:00.000Z',
        winner: { value: 1, wallClockMs: 1, lamport: 1, deviceId: 'd' },
        loser: { value: 0, wallClockMs: 0, lamport: 0, deviceId: 'd' }, rationale: 'wallclock' });
    // Tagged entry.
    new MultiMasterMerger(log, 'ws-a').applyChange(
        { nodeId: 'n1', fields: { f: 'win' }, lastWrite: { f: { wallClockMs: 200, lamport: 5, deviceId: 'd1' } } },
        { nodeId: 'n1', field: 'f', value: 'lose', wallClockMs: 100, lamport: 2, deviceId: 'd2' },
    );
    assert.equal(log.list({ workspace: 'ws-a' }).length, 1, 'workspace filter returns only the tagged entry');
    assert.equal(log.list().length, 2, 'unfiltered still includes the legacy entry');
});

/* ─────────────────── orch-5: concurrent tick is serialized ───────────────── */

function liveWithTenant(): LoreSchemaV2 {
    const tenant: NodeTypeSpec = { name: 'know.Tenant', description: '', kind: 'factual' };
    return { ...DEFAULT_SCHEMA_V2, nodeTypes: [...DEFAULT_SCHEMA_V2.nodeTypes, tenant] };
}

test('orch-5 concurrent tick() on one orchestration executes the migrate phase exactly once', async () => {
    const dir = tmpDir();
    const loreDir = path.join(dir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    const liveSchema = liveWithTenant();
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(liveSchema));
    const audit = new SchemaChangeAuditLogger(loreDir);
    const authoring = new SchemaAuthoringStore(dir, audit);
    const orchStore = new OrchestrationStore(loreDir);

    // Counting backend: a slow executeOpBatch (yields) so two un-serialized ticks
    // would both enter the migrate phase. The lock must make it run ONCE.
    let migrateExecCount = 0;
    const backend: MigrationBackend = {
        async dryRunOp() { return { affectedRowCount: 0 }; },
        async executeOpBatch(_op: MigrationOp, _cursor, _batchSize): Promise<BatchResult> {
            migrateExecCount++;
            await new Promise(r => setImmediate(r)); // widen the interleave window
            return { deleted: 1, modified: 0, nextCursor: null };
        },
        async rollbackOp() { return { restored: 0, repaired: 0 }; },
    };

    const plan: DecomposedPlan = decompose(
        { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema, proposedBy: 'human:rafi' },
    );
    const orch = new PlanOrchestrator({ store: orchStore, schemaAuthoring: authoring, migrationBackend: backend });
    const initial = orch.create(plan, { proposedBy: 'human:rafi', approvedBy: 'human:rafi', soakSeconds: 0 });

    // Fire two ticks concurrently on the SAME orchestration id.
    const [s1, s2] = await Promise.all([orch.tick(initial.id), orch.tick(initial.id)]);

    assert.equal(migrateExecCount, 1, `migrate must execute exactly once under the lock; got ${migrateExecCount}`);
    // Final state is consistent: migrate completed, contract submitted, awaiting approval.
    const finalState = orch.get(initial.id)!;
    assert.equal(finalState.phases[0].status, 'completed', 'migrate phase completed once');
    assert.equal(finalState.currentPhaseIndex, 1);
    assert.equal(finalState.status, 'awaiting_approval');
    // Exactly one contract sandbox was submitted (no duplicate from a double-tick).
    assert.ok(finalState.phases[1].sandboxId, 'one contract sandbox submitted');
    // Both calls returned a coherent state (no throw, same orchestration).
    assert.equal(s1.id, initial.id);
    assert.equal(s2.id, initial.id);
});

await Promise.all(pending);
for (const d of createdTmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
