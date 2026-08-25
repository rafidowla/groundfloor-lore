#!/usr/bin/env tsx
/**
 * test/schema-describe-unit.ts — T1d
 *
 * Verifies that describeSchema and summarizeSchema produce stable,
 * complete, JSON-serializable output for representative schemas.
 */

import { strict as assert } from 'node:assert';
import {
    describeSchema,
    summarizeSchema,
} from '../packages/lore/src/schemas/describe.js';
import {
    DEFAULT_SCHEMA_V2,
    REBAC_RELATION_EDGES,
    type LoreSchemaV2,
} from '../packages/lore/src/schemas/types.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${(err as Error).message}`);
        failed++;
    }
}

console.log('schema describe — T1d');

test('describeSchema: counts on default schema are correct', () => {
    const d = describeSchema(DEFAULT_SCHEMA_V2);
    // SP-09: the default schema is now all-factual (domain-specific episodic
    // types like agent-run/agent-run-summary were removed — they belong in
    // client application schemas, not Core). Derive the split from the schema
    // itself so this test stays correct as the default evolves.
    const expectedFactual = DEFAULT_SCHEMA_V2.nodeTypes.filter(n => n.kind === 'factual').length;
    const expectedEpisodic = DEFAULT_SCHEMA_V2.nodeTypes.filter(n => n.kind === 'episodic').length;
    assert.equal(d.counts.nodeTypes, DEFAULT_SCHEMA_V2.nodeTypes.length);
    assert.equal(d.counts.factualNodeTypes, expectedFactual);
    assert.equal(d.counts.episodicNodeTypes, expectedEpisodic);
    // factual + episodic must account for every node type in the schema.
    assert.equal(expectedFactual + expectedEpisodic, DEFAULT_SCHEMA_V2.nodeTypes.length);
    assert.equal(d.counts.rebacRelationEdges, REBAC_RELATION_EDGES.length);
    assert.equal(d.counts.permissionActions, 0);
});

test('describeSchema: ReBAC edges are flagged', () => {
    const d = describeSchema(DEFAULT_SCHEMA_V2);
    const owner = d.edgeTypes.find(e => e.name === 'owner');
    assert.ok(owner);
    assert.equal(owner!.isRebacRelation, true);
    const decided = d.edgeTypes.find(e => e.name === 'decided_for');
    assert.ok(decided);
    assert.equal(decided!.isRebacRelation, false);
});

test('describeSchema: floor fields are surfaced on every type', () => {
    const d = describeSchema(DEFAULT_SCHEMA_V2);
    for (const nt of d.nodeTypes) {
        assert.ok(nt.floorFields.includes('id'));
        assert.ok(nt.floorFields.includes('kind'));
    }
    for (const et of d.edgeTypes) {
        assert.ok(et.floorFields.includes('from'));
        assert.ok(et.floorFields.includes('to'));
    }
});

test('describeSchema: permissions are flattened with parsed terms', () => {
    const schema: LoreSchemaV2 = {
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [
            { name: 'property', description: '', kind: 'factual' },
        ],
        permissions: {
            property: {
                view: 'viewer | editor | owner',
                approve_ticket: 'editor | owner',
                transfer_owner: 'owner',
            },
        },
    };
    const d = describeSchema(schema);
    assert.equal(d.counts.permissionResourceTypes, 1);
    assert.equal(d.counts.permissionActions, 3);
    const view = d.permissions.find(p => p.action === 'view');
    assert.ok(view);
    assert.deepEqual(view!.terms.sort(), ['editor', 'owner', 'viewer']);
});

test('describeSchema: episodic node type counted correctly + appendOnly auto-true', () => {
    const schema: LoreSchemaV2 = {
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [
            { name: 'Conversation', description: '', kind: 'episodic' },
            { name: 'Tenant', description: '', kind: 'factual' },
        ],
    };
    const d = describeSchema(schema);
    assert.equal(d.counts.episodicNodeTypes, 1);
    assert.equal(d.counts.factualNodeTypes, 1);
    const convo = d.nodeTypes.find(n => n.name === 'Conversation');
    assert.equal(convo!.appendOnly, true, 'episodic defaults appendOnly true');
});

test('describeSchema: declared fields preserve required/indexed/sensitive flags', () => {
    const schema: LoreSchemaV2 = {
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [
            {
                name: 'Tenant', description: '', kind: 'factual',
                fields: [
                    { name: 'ssn', type: 'string', sensitive: true, required: true },
                    { name: 'name', type: 'string', indexed: true },
                ],
            },
        ],
    };
    const d = describeSchema(schema);
    const tenant = d.nodeTypes.find(n => n.name === 'Tenant');
    const ssn = tenant!.declaredFields.find(f => f.name === 'ssn');
    const name = tenant!.declaredFields.find(f => f.name === 'name');
    assert.equal(ssn!.sensitive, true);
    assert.equal(ssn!.required, true);
    assert.equal(name!.indexed, true);
});

test('describeSchema: output is JSON-serializable (deep)', () => {
    const d = describeSchema(DEFAULT_SCHEMA_V2);
    const round = JSON.parse(JSON.stringify(d));
    assert.deepEqual(round, JSON.parse(JSON.stringify(d)));
});

test('summarizeSchema: default schema produces a sane one-line summary', () => {
    const s = summarizeSchema(DEFAULT_SCHEMA_V2);
    // SP-09: domain changed from 'Software Engineering' to 'General' (schema-agnostic default).
    assert.match(s, /General workspace/);
    assert.match(s, /factual/);
    assert.match(s, /ReBAC/);
    assert.match(s, /No permission schema declared yet\./);
});

test('summarizeSchema: with permissions reports counts', () => {
    const schema: LoreSchemaV2 = {
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [
            { name: 'property', description: '', kind: 'factual' },
            { name: 'lease', description: '', kind: 'factual' },
            { name: 'Conversation', description: '', kind: 'episodic' },
        ],
        permissions: {
            property: { view: 'viewer | editor | owner', edit: 'editor | owner' },
            lease: { view: 'viewer | editor | owner' },
        },
    };
    const s = summarizeSchema(schema);
    assert.match(s, /3 node types/);
    assert.match(s, /2 factual.*1 episodic|1 episodic.*2 factual/);
    assert.match(s, /3 actions across 2 resource types/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
