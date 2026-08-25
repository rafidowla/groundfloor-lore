#!/usr/bin/env tsx
/**
 * test/blast-radius-unit.ts — Phase 3 item 1 tests.
 *
 * Verifies computeBlastRadius() returns per-change row counts using
 * the right Cypher patterns for each change kind, plus the integration
 * with SchemaAuthoringStore.propose() that surfaces it on the
 * SandboxEntry.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { computeBlastRadius } from '../packages/lore/src/schemas/blastRadius.js';
import type { SchemaGraphOps } from '../packages/lore/src/schemas/substrate/schemaGraphOps.js';
import type { ProposedChange } from '../packages/lore/src/schemas/authoring.js';
import {
    SchemaAuthoringStore,
    buildProposal,
} from '../packages/lore/src/schemas/authoring.js';
import { DEFAULT_SCHEMA_V2 } from '../packages/lore/src/schemas/types.js';

let passed = 0;
let failed = 0;

const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-blast-'));
    try { return await fn(dir); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

function seedLiveSchema(workspaceDir: string) {
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));
}

/** SchemaGraphOps stub that returns a configurable count for each op. */
function fakeGraph(counts: {
    nodesByType?: Record<string, number>;
    edgesByRelation?: Record<string, number>;
    /** Phase 4 item 11 — inbound edges keyed by target node type. */
    inboundEdgesByType?: Record<string, number>;
}): SchemaGraphOps {
    return {
        engine: 'kuzu',
        async countNodesByType(type) { return counts.nodesByType?.[type] ?? 0; },
        async countEdgesByRelation(relation) { return counts.edgesByRelation?.[relation] ?? 0; },
        async countInboundEdgesToType(type) { return counts.inboundEdgesByType?.[type] ?? 0; },
        async listNodesByType() { return []; },
        async listEdgesByRelation() { return []; },
        async pageNodesByType() { return []; },
        async sampleNodesByType() { return []; },
        async sampleEdgesByRelation() { return []; },
        async deleteNodesByType() { return 0; },
        async deleteEdgesByRelation() { return 0; },
        async getNodeMetadata() { return null; },
        async setNodeMetadata() {},
        async setNodeType() {},
        async restoreNode() {},
        async createEdge() {},
    };
}

console.log('blast radius — Phase 3 item 1');

/* ---------- per-change-kind semantics ---------- */

test('additive node_type.added returns 0 with note', async () => {
    const change: ProposedChange = { kind: 'node_type.added', target: 'know.NewType', migration: 'lazy' };
    const r = await computeBlastRadius([change], fakeGraph({}));
    assert.equal(r.perChange[0].affectedRowCount, 0);
    assert.match(r.perChange[0].note ?? '', /additive/);
    assert.equal(r.total, 0);
});

test('additive field.added returns 0 with note', async () => {
    const change: ProposedChange = { kind: 'field.added', target: 'know.X.newField', migration: 'lazy' };
    const r = await computeBlastRadius([change], fakeGraph({}));
    assert.equal(r.perChange[0].affectedRowCount, 0);
    assert.match(r.perChange[0].note ?? '', /additive/);
});

test('additive edge_type.added returns 0 with note', async () => {
    const change: ProposedChange = { kind: 'edge_type.added', target: 'new_relation', migration: 'lazy' };
    const r = await computeBlastRadius([change], fakeGraph({}));
    assert.equal(r.perChange[0].affectedRowCount, 0);
});

test('node_type.removed counts nodes of that type', async () => {
    const change: ProposedChange = { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' };
    const r = await computeBlastRadius(
        [change],
        fakeGraph({ nodesByType: { 'know.Tenant': 47 } }),
    );
    assert.equal(r.perChange[0].affectedRowCount, 47);
    assert.equal(r.total, 47);
});

test('node_type.renamed counts nodes of the OLD type', async () => {
    const change: ProposedChange = { kind: 'node_type.renamed', target: 'know.OldName', migration: 'dual-shape' };
    const r = await computeBlastRadius(
        [change],
        fakeGraph({ nodesByType: { 'know.OldName': 5 } }),
    );
    assert.equal(r.perChange[0].affectedRowCount, 5);
});

test('field.removed strips the field suffix and counts the parent type', async () => {
    // target is "know.Tenant.email" → query against "know.Tenant"
    const change: ProposedChange = { kind: 'field.removed', target: 'know.Tenant.email', migration: 'dual-shape' };
    const r = await computeBlastRadius(
        [change],
        fakeGraph({ nodesByType: { 'know.Tenant': 100 } }),
    );
    assert.equal(r.perChange[0].affectedRowCount, 100);
});

test('field.type_changed strips the field suffix', async () => {
    const change: ProposedChange = { kind: 'field.type_changed', target: 'know.Tenant.email', migration: 'dual-shape' };
    const r = await computeBlastRadius(
        [change],
        fakeGraph({ nodesByType: { 'know.Tenant': 100 } }),
    );
    assert.equal(r.perChange[0].affectedRowCount, 100);
});

test('edge_type.removed counts edges by relation', async () => {
    const change: ProposedChange = { kind: 'edge_type.removed', target: 'leases', migration: 'dual-shape' };
    const r = await computeBlastRadius(
        [change],
        fakeGraph({ edgesByRelation: { 'leases': 12 } }),
    );
    assert.equal(r.perChange[0].affectedRowCount, 12);
});

test('permission.changed returns null with note (not data-shaped)', async () => {
    const change: ProposedChange = { kind: 'permission.changed', target: 'know.X.read', migration: 'not-applicable' };
    const r = await computeBlastRadius([change], fakeGraph({}));
    assert.equal(r.perChange[0].affectedRowCount, null);
    assert.match(r.perChange[0].note ?? '', /permission/i);
});

test('workspace.system_prompt_changed returns null with note', async () => {
    const change: ProposedChange = { kind: 'workspace.system_prompt_changed', target: 'workspace', migration: 'not-applicable' };
    const r = await computeBlastRadius([change], fakeGraph({}));
    assert.equal(r.perChange[0].affectedRowCount, null);
    assert.match(r.perChange[0].note ?? '', /workspace/i);
});

test('graph read failure surfaces as null + note (does not throw)', async () => {
    const change: ProposedChange = { kind: 'node_type.removed', target: 'know.X', migration: 'dual-shape' };
    const graph: SchemaGraphOps = {
        ...fakeGraph({}),
        async countNodesByType() { throw new Error('graph unreachable'); },
    };
    const r = await computeBlastRadius([change], graph);
    assert.equal(r.perChange[0].affectedRowCount, null);
    assert.match(r.perChange[0].note ?? '', /count failed/i);
});

test('total sums non-null per-change counts only', async () => {
    const changes: ProposedChange[] = [
        { kind: 'node_type.removed', target: 'know.A', migration: 'dual-shape' },
        { kind: 'edge_type.removed', target: 'rel_x', migration: 'dual-shape' },
        { kind: 'permission.changed', target: 'p', migration: 'not-applicable' },
    ];
    const r = await computeBlastRadius(changes, fakeGraph({
        nodesByType: { 'know.A': 10 },
        edgesByRelation: { 'rel_x': 5 },
    }));
    assert.equal(r.total, 15); // 10 + 5; permission.changed contributes null
});

test('computedAt is an ISO timestamp', async () => {
    const change: ProposedChange = { kind: 'node_type.added', target: 'know.X', migration: 'lazy' };
    const r = await computeBlastRadius([change], fakeGraph({}));
    assert.match(r.computedAt, /^\d{4}-\d{2}-\d{2}T/);
});

/* ---------- Phase 4 item 11 — reader-dependency counts ---------- */

test('node_type.removed surfaces readerCount = inbound edge count', async () => {
    const change: ProposedChange = { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' };
    const r = await computeBlastRadius([change], fakeGraph({
        nodesByType: { 'know.Tenant': 12 },
        inboundEdgesByType: { 'know.Tenant': 7 },
    }));
    assert.equal(r.perChange[0].affectedRowCount, 12);
    assert.equal(r.perChange[0].readerCount, 7);
});

test('field.removed surfaces readerCount = node count (upper-bound for populated rows)', async () => {
    const change: ProposedChange = { kind: 'field.removed', target: 'know.Tenant.email', migration: 'dual-shape' };
    const r = await computeBlastRadius([change], fakeGraph({
        nodesByType: { 'know.Tenant': 5 },
    }));
    assert.equal(r.perChange[0].readerCount, 5);
});

test('edge_type.removed surfaces readerCount = edge count', async () => {
    const change: ProposedChange = { kind: 'edge_type.removed', target: 'leases', migration: 'dual-shape' };
    const r = await computeBlastRadius([change], fakeGraph({
        edgesByRelation: { 'leases': 9 },
    }));
    assert.equal(r.perChange[0].readerCount, 9);
});

test('permission/workspace changes have no readerCount (not data-shaped)', async () => {
    const change: ProposedChange = { kind: 'permission.changed', target: 'know.Tenant.read', migration: 'not-applicable' };
    const r = await computeBlastRadius([change], fakeGraph({}));
    assert.equal(r.perChange[0].readerCount, undefined);
});

/* ---------- integration with SchemaAuthoringStore.propose ---------- */

test('propose attaches blastRadius when a graph reader is wired', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const graph = fakeGraph({ nodesByType: { 'know.Tenant': 42 } });
        const store = new SchemaAuthoringStore(dir, undefined, undefined, graph);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [{ kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' }],
            proposedBy: 'human:rafi',
        });
        const entry = await store.propose(proposal);
        assert.ok(entry.blastRadius);
        assert.equal(entry.blastRadius!.total, 42);
        assert.equal(entry.blastRadius!.perChange[0].affectedRowCount, 42);
    });
});

test('propose omits blastRadius when no graph reader is wired', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir); // no graph
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [{ kind: 'node_type.added', target: 'know.X', migration: 'lazy' }],
            proposedBy: 'ai:claude',
            transforms: { addNodeType: { name: 'know.X', description: '', kind: 'factual' } },
        });
        const entry = await store.propose(proposal);
        assert.equal(entry.blastRadius, undefined);
    });
});

test('propose persists blastRadius into the sandbox file', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const graph = fakeGraph({ nodesByType: { 'know.Tenant': 7 } });
        const store = new SchemaAuthoringStore(dir, undefined, undefined, graph);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [{ kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' }],
            proposedBy: 'human:rafi',
        });
        const entry = await store.propose(proposal);
        const onDisk = JSON.parse(fs.readFileSync(
            path.join(dir, '.lore/schema-sandbox', `${entry.sandboxId}.json`),
            'utf-8',
        ));
        assert.ok(onDisk.blastRadius);
        assert.equal(onDisk.blastRadius.total, 7);
    });
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
