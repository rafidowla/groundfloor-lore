#!/usr/bin/env tsx
/**
 * test/schema-decomposition-unit.ts — Phase 4 item 9.
 *
 * Verifies decompose() for each destructive kind: 3-phase rename,
 * 2-phase removal/edge-removal/field-removal, 1-phase schema-only
 * changes, additive passthrough. Also covers required-param errors
 * and "missing on live schema" errors.
 *
 * Pure unit tests against in-memory schemas — no Kùzu, no
 * filesystem, no daemon.
 */

import { strict as assert } from 'node:assert';

import { decompose, type DecomposedPlan } from '../packages/lore/src/schemas/decomposition.js';
import type { ProposedChange } from '../packages/lore/src/schemas/authoring.js';
import {
    DEFAULT_SCHEMA_V2,
    type LoreSchemaV2,
    type NodeTypeSpec,
} from '../packages/lore/src/schemas/types.js';

let passed = 0;
let failed = 0;

const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

/** Live schema with a single Tenant type for rename/remove tests. */
function liveWithTenant(): LoreSchemaV2 {
    const tenant: NodeTypeSpec = {
        name: 'know.Tenant',
        description: 'A tenant',
        kind: 'factual',
    };
    return {
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [...DEFAULT_SCHEMA_V2.nodeTypes, tenant],
    };
}

console.log('schema decomposition — Phase 4 item 9');

/* ---------- 3-phase: node_type.renamed ---------- */

test('node_type.renamed: 3-phase plan (expand + migrate + contract)', () => {
    const change: ProposedChange = {
        kind: 'node_type.renamed',
        target: 'know.Tenant',
        migration: 'dual-shape',
    };
    const plan: DecomposedPlan = decompose(change, {
        liveSchema: liveWithTenant(),
        proposedBy: 'human:rafi',
        params: { newName: 'know.Customer' },
    });

    assert.equal(plan.phases.length, 3);
    assert.equal(plan.phases[0].kind, 'expand');
    assert.equal(plan.phases[1].kind, 'migrate');
    assert.equal(plan.phases[2].kind, 'contract');
    assert.equal(plan.originalChange, change);
    assert.ok(plan.planId);
    assert.match(plan.note, /Rename.*decomposed into three phases/i);
});

test('node_type.renamed expand phase adds new type to schema', () => {
    const plan = decompose(
        { kind: 'node_type.renamed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema: liveWithTenant(), proposedBy: 'human:rafi', params: { newName: 'know.Customer' } },
    );
    assert.equal(plan.phases[0].kind, 'expand');
    if (plan.phases[0].kind !== 'expand') return;
    const expanded = plan.phases[0].proposal.nextSchema;
    assert.ok(expanded.nodeTypes.find(n => n.name === 'know.Customer'), 'new type present');
    assert.ok(expanded.nodeTypes.find(n => n.name === 'know.Tenant'), 'old type STILL present after expand');
});

test('node_type.renamed migrate phase carries the right MigrationOp', () => {
    const plan = decompose(
        { kind: 'node_type.renamed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema: liveWithTenant(), proposedBy: 'human:rafi', params: { newName: 'know.Customer' } },
    );
    if (plan.phases[1].kind !== 'migrate') throw new Error('expected migrate phase');
    const mp = plan.phases[1].plan;
    assert.equal(mp.ops.length, 1);
    assert.equal(mp.ops[0].kind, 'node_type.renamed');
    assert.equal(mp.ops[0].target, 'know.Tenant');
    assert.equal(mp.ops[0].params?.['newName'], 'know.Customer');
    assert.equal(mp.proposedBy, 'human:rafi');
    assert.equal(mp.planId, plan.planId, 'migrate plan inherits the decomposed planId');
});

test('node_type.renamed contract phase drops the OLD type (built against expanded schema)', () => {
    const plan = decompose(
        { kind: 'node_type.renamed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema: liveWithTenant(), proposedBy: 'human:rafi', params: { newName: 'know.Customer' } },
    );
    if (plan.phases[2].kind !== 'contract') throw new Error('expected contract phase');
    const contracted = plan.phases[2].proposal.nextSchema;
    assert.equal(contracted.nodeTypes.find(n => n.name === 'know.Tenant'), undefined);
    assert.ok(contracted.nodeTypes.find(n => n.name === 'know.Customer'), 'new type survives contract');
});

test('node_type.renamed throws on missing params.newName', () => {
    assert.throws(
        () => decompose(
            { kind: 'node_type.renamed', target: 'know.Tenant', migration: 'dual-shape' },
            { liveSchema: liveWithTenant(), proposedBy: 'human:rafi' },
        ),
        /required.*newName/i,
    );
});

test('node_type.renamed throws when live schema has no such type', () => {
    assert.throws(
        () => decompose(
            { kind: 'node_type.renamed', target: 'know.NonExistent', migration: 'dual-shape' },
            { liveSchema: DEFAULT_SCHEMA_V2, proposedBy: 'human:rafi', params: { newName: 'know.X' } },
        ),
        /no type 'know\.NonExistent'/,
    );
});

/* ---------- 2-phase: node_type.removed ---------- */

test('node_type.removed: 2-phase plan (migrate + contract)', () => {
    const plan = decompose(
        { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema: liveWithTenant(), proposedBy: 'human:rafi' },
    );
    assert.equal(plan.phases.length, 2);
    assert.equal(plan.phases[0].kind, 'migrate');
    assert.equal(plan.phases[1].kind, 'contract');
    if (plan.phases[0].kind !== 'migrate') return;
    assert.equal(plan.phases[0].plan.ops[0].kind, 'node_type.removed');
});

test('node_type.removed throws when live schema has no such type', () => {
    assert.throws(
        () => decompose(
            { kind: 'node_type.removed', target: 'know.NonExistent', migration: 'dual-shape' },
            { liveSchema: DEFAULT_SCHEMA_V2, proposedBy: 'human:rafi' },
        ),
        /no type 'know\.NonExistent'/,
    );
});

/* ---------- 2-phase: field.removed + edge_type.removed ---------- */

test('field.removed: 2-phase plan with field-stripping migrate', () => {
    const plan = decompose(
        { kind: 'field.removed', target: 'know.Tenant.email', migration: 'dual-shape' },
        { liveSchema: liveWithTenant(), proposedBy: 'human:rafi' },
    );
    assert.equal(plan.phases.length, 2);
    if (plan.phases[0].kind !== 'migrate') throw new Error('expected migrate first');
    assert.equal(plan.phases[0].plan.ops[0].kind, 'field.removed');
    assert.equal(plan.phases[0].plan.ops[0].target, 'know.Tenant.email');
});

test('edge_type.removed: 2-phase plan with edge-deleting migrate', () => {
    const plan = decompose(
        { kind: 'edge_type.removed', target: 'leases', migration: 'dual-shape' },
        { liveSchema: DEFAULT_SCHEMA_V2, proposedBy: 'human:rafi' },
    );
    assert.equal(plan.phases.length, 2);
    if (plan.phases[0].kind !== 'migrate') throw new Error('expected migrate first');
    assert.equal(plan.phases[0].plan.ops[0].kind, 'edge_type.removed');
    assert.equal(plan.phases[0].plan.ops[0].target, 'leases');
});

/* ---------- 1-phase: schema-only changes ---------- */

test('node_type.kind_changed: 1-phase contract only', () => {
    const plan = decompose(
        { kind: 'node_type.kind_changed', target: 'know.Tenant', migration: 'not-applicable' },
        { liveSchema: liveWithTenant(), proposedBy: 'human:rafi' },
    );
    assert.equal(plan.phases.length, 1);
    assert.equal(plan.phases[0].kind, 'contract');
    assert.match(plan.note, /schema-only/i);
});

test('field.sensitivity_flipped: 1-phase contract only', () => {
    const plan = decompose(
        { kind: 'field.sensitivity_flipped', target: 'know.Tenant.ssn', migration: 'not-applicable' },
        { liveSchema: liveWithTenant(), proposedBy: 'human:rafi' },
    );
    assert.equal(plan.phases.length, 1);
    assert.equal(plan.phases[0].kind, 'contract');
});

test('permission.removed: 1-phase contract only', () => {
    const plan = decompose(
        { kind: 'permission.removed', target: 'know.Tenant.read', migration: 'not-applicable' },
        { liveSchema: liveWithTenant(), proposedBy: 'human:rafi' },
    );
    assert.equal(plan.phases.length, 1);
});

test('permission.changed applies params.nextPermissions via setPermissions transform (Phase 4 item 6)', () => {
    const live = liveWithTenant();
    live.permissions = { 'know.Tenant': { read: 'admin' } };
    const nextPermissions = { 'know.Tenant': { read: 'viewer' } };
    const plan = decompose(
        { kind: 'permission.changed', target: 'know.Tenant.read', migration: 'not-applicable' },
        { liveSchema: live, proposedBy: 'human:rafi', params: { nextPermissions } },
    );
    assert.equal(plan.phases.length, 1);
    if (plan.phases[0].kind !== 'contract') throw new Error('expected contract phase');
    assert.deepEqual(
        plan.phases[0].proposal.nextSchema.permissions,
        nextPermissions,
        'contract proposal carries the new permissions',
    );
});

test('permission.changed without params.nextPermissions stays informational (back-compat)', () => {
    const live = liveWithTenant();
    live.permissions = { 'know.Tenant': { read: 'admin' } };
    const plan = decompose(
        { kind: 'permission.changed', target: 'know.Tenant.read', migration: 'not-applicable' },
        { liveSchema: live, proposedBy: 'human:rafi' },
    );
    if (plan.phases[0].kind !== 'contract') throw new Error('expected contract phase');
    assert.deepEqual(
        plan.phases[0].proposal.nextSchema.permissions,
        live.permissions,
        'permissions unchanged when caller omits the new state',
    );
});

test('field.type_changed: 3-phase plan (expand + migrate + contract) with typeMigrating marker (Phase 4 item 5)', () => {
    // Live schema needs the target field present so the decomposer
    // can locate it and read its current type.
    const live = liveWithTenant();
    const tenant = live.nodeTypes.find(n => n.name === 'know.Tenant')!;
    tenant.fields = [{ name: 'age', type: 'string' }];

    const plan = decompose(
        { kind: 'field.type_changed', target: 'know.Tenant.age', migration: 'dual-shape' },
        { liveSchema: live, proposedBy: 'human:rafi', params: { newType: 'number' } },
    );
    assert.equal(plan.phases.length, 3);
    assert.equal(plan.phases[0].kind, 'expand');
    assert.equal(plan.phases[1].kind, 'migrate');
    assert.equal(plan.phases[2].kind, 'contract');

    if (plan.phases[0].kind !== 'expand') return;
    const expandedField = plan.phases[0].proposal.nextSchema.nodeTypes
        .find(n => n.name === 'know.Tenant')!.fields!
        .find(f => f.name === 'age')!;
    assert.equal(expandedField.type, 'string', 'expand keeps type at from');
    assert.deepEqual(expandedField.typeMigrating, { from: 'string', to: 'number' });

    if (plan.phases[2].kind !== 'contract') return;
    const contractedField = plan.phases[2].proposal.nextSchema.nodeTypes
        .find(n => n.name === 'know.Tenant')!.fields!
        .find(f => f.name === 'age')!;
    assert.equal(contractedField.type, 'number', 'contract flips type to newType');
    assert.equal(contractedField.typeMigrating, undefined, 'contract clears the marker');
});

test('field.type_changed throws on missing params.newType', () => {
    const live = liveWithTenant();
    const tenant = live.nodeTypes.find(n => n.name === 'know.Tenant')!;
    tenant.fields = [{ name: 'age', type: 'string' }];
    assert.throws(
        () => decompose(
            { kind: 'field.type_changed', target: 'know.Tenant.age', migration: 'dual-shape' },
            { liveSchema: live, proposedBy: 'human:rafi' },
        ),
        /required.*newType/i,
    );
});

test('field.type_changed throws when field is absent from live schema', () => {
    assert.throws(
        () => decompose(
            { kind: 'field.type_changed', target: 'know.Tenant.nonexistent', migration: 'dual-shape' },
            { liveSchema: liveWithTenant(), proposedBy: 'human:rafi', params: { newType: 'number' } },
        ),
        /no field 'nonexistent'/,
    );
});

test('field.type_changed throws when from === to (no-op)', () => {
    const live = liveWithTenant();
    const tenant = live.nodeTypes.find(n => n.name === 'know.Tenant')!;
    tenant.fields = [{ name: 'age', type: 'string' }];
    assert.throws(
        () => decompose(
            { kind: 'field.type_changed', target: 'know.Tenant.age', migration: 'dual-shape' },
            { liveSchema: live, proposedBy: 'human:rafi', params: { newType: 'string' } },
        ),
        /already type 'string'/,
    );
});

/* ---------- additive: no decomposition ---------- */

test('node_type.added: no decomposition (additive)', () => {
    const plan = decompose(
        { kind: 'node_type.added', target: 'know.New', migration: 'lazy' },
        { liveSchema: DEFAULT_SCHEMA_V2, proposedBy: 'ai:claude' },
    );
    assert.equal(plan.phases.length, 0);
    assert.match(plan.note, /additive/i);
});

test('field.added: no decomposition (additive)', () => {
    const plan = decompose(
        { kind: 'field.added', target: 'know.Tenant.newField', migration: 'lazy' },
        { liveSchema: liveWithTenant(), proposedBy: 'ai:claude' },
    );
    assert.equal(plan.phases.length, 0);
});

/* ---------- planId + provenance ---------- */

test('every decomposition gets a unique planId', () => {
    const a = decompose(
        { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema: liveWithTenant(), proposedBy: 'human:rafi' },
    );
    const b = decompose(
        { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema: liveWithTenant(), proposedBy: 'human:rafi' },
    );
    assert.notEqual(a.planId, b.planId);
});

test('proposedBy is propagated to every phase\'s proposal/plan', () => {
    const plan = decompose(
        { kind: 'node_type.renamed', target: 'know.Tenant', migration: 'dual-shape' },
        { liveSchema: liveWithTenant(), proposedBy: 'ai:claude', params: { newName: 'know.Customer' } },
    );
    if (plan.phases[0].kind === 'expand')   assert.equal(plan.phases[0].proposal.proposedBy, 'ai:claude');
    if (plan.phases[1].kind === 'migrate')  assert.equal(plan.phases[1].plan.proposedBy, 'ai:claude');
    if (plan.phases[2].kind === 'contract') assert.equal(plan.phases[2].proposal.proposedBy, 'ai:claude');
});

test('sandboxId is propagated to the migrate phase when supplied', () => {
    const plan = decompose(
        { kind: 'field.removed', target: 'know.Tenant.email', migration: 'dual-shape' },
        { liveSchema: liveWithTenant(), proposedBy: 'human:rafi', sandboxId: 'sb-decomp-1' },
    );
    if (plan.phases[0].kind !== 'migrate') throw new Error('expected migrate first');
    assert.equal(plan.phases[0].plan.sandboxId, 'sb-decomp-1');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
