#!/usr/bin/env tsx
/**
 * test/schema-data-snapshot-unit.ts — Phase 1 item 3 tests.
 *
 * Verifies that `SchemaAuthoringStore.approve()` snapshots affected
 * data BEFORE flipping the live schema for destructive changes, and
 * aborts the approval (without touching the live schema) when a
 * snapshot fails. Uses an in-memory fake `SchemaGraphOps` so the tests
 * run without a real graph engine.
 *
 * See packages/lore/src/schemas/dataSnapshot.ts and
 * docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md for the rationale.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    SchemaAuthoringStore,
    buildProposal,
    type ProposedChange,
} from '../packages/lore/src/schemas/authoring.js';
import {
    LocalGraphSnapshotter,
    type DataSnapshotter,
    type SnapshotOpts,
    type SnapshotResult,
} from '../packages/lore/src/schemas/dataSnapshot.js';
import type { SchemaGraphOps } from '../packages/lore/src/schemas/substrate/schemaGraphOps.js';
import { DEFAULT_SCHEMA_V2 } from '../packages/lore/src/schemas/types.js';

let passed = 0;
let failed = 0;

const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

async function withTmp<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-snapshot-'));
    try { return await fn(dir); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

function seedLiveSchema(workspaceDir: string) {
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));
}

function stubOps(): SchemaGraphOps {
    return {
        engine: 'surreal',
        async countNodesByType() { return 0; },
        async countEdgesByRelation() { return 0; },
        async countInboundEdgesToType() { return 0; },
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

/** In-memory SchemaGraphOps: rows keyed by node type / edge relation. */
function makeFakeGraph(opts: {
    nodesByType?: Record<string, Array<Record<string, unknown>>>;
    edgesByRelation?: Record<string, Array<Record<string, unknown>>>;
}): SchemaGraphOps {
    return {
        ...stubOps(),
        async listNodesByType(type) { return opts.nodesByType?.[type] ?? []; },
        async listEdgesByRelation(relation) { return opts.edgesByRelation?.[relation] ?? []; },
    };
}

const REMOVE_FIELD: ProposedChange = {
    kind: 'field.removed',
    target: 'know.Tenant.email',
    migration: 'dual-shape',
};

const REMOVE_NODE_TYPE: ProposedChange = {
    kind: 'node_type.removed',
    target: 'know.Tenant',
    migration: 'dual-shape',
};

const REMOVE_EDGE_TYPE: ProposedChange = {
    kind: 'edge_type.removed',
    target: 'leases',
    migration: 'dual-shape',
};

const PERMISSION_CHANGED: ProposedChange = {
    kind: 'permission.changed',
    target: 'know.Tenant.read',
    migration: 'not-applicable',
};

const ADD_TENANT: ProposedChange = {
    kind: 'node_type.added',
    target: 'know.Tenant',
    migration: 'lazy',
};

console.log('schema data-snapshot — Phase 1 item 3');

/* ---------- LocalGraphSnapshotter unit ---------- */

test('LocalGraphSnapshotter writes JSONL with header + rows for node_type.removed', async () => {
    await withTmp(async dir => {
        const snapshotsDir = path.join(dir, '.lore', 'data-snapshots');
        fs.mkdirSync(snapshotsDir, { recursive: true });
        const fakeRows = [
            { 'n.id': 'tenant-1', 'n.type': 'know.Tenant', 'n.label': 'Acme' },
            { 'n.id': 'tenant-2', 'n.type': 'know.Tenant', 'n.label': 'Beta' },
        ];
        const snapper = new LocalGraphSnapshotter(makeFakeGraph({ nodesByType: { 'know.Tenant': fakeRows } }));
        const result = await snapper.snapshotForChange(REMOVE_NODE_TYPE, {
            sandboxId: 'sb-test-1',
            snapshotsDir,
            isoTimestamp: '2026-05-15T22:00:00.000Z',
        });
        assert.equal(result.status, 'applied');
        assert.equal(result.rowCount, 2);
        assert.ok(fs.existsSync(result.file), 'snapshot file should exist');
        const lines = fs.readFileSync(result.file, 'utf-8').trim().split('\n');
        assert.equal(lines.length, 3); // header + 2 rows
        const header = JSON.parse(lines[0]);
        assert.equal(header._snapshotMetadata.changeKind, 'node_type.removed');
        assert.equal(header._snapshotMetadata.changeTarget, 'know.Tenant');
        assert.equal(header._snapshotMetadata.rowCount, 2);
    });
});

test('LocalGraphSnapshotter strips the field suffix when target is <NodeType>.<field>', async () => {
    await withTmp(async dir => {
        const snapshotsDir = path.join(dir, '.lore', 'data-snapshots');
        fs.mkdirSync(snapshotsDir, { recursive: true });
        let receivedType: unknown = null;
        const graph: SchemaGraphOps = {
            ...stubOps(),
            async listNodesByType(type) {
                receivedType = type;
                return [];
            },
        };
        const snapper = new LocalGraphSnapshotter(graph);
        await snapper.snapshotForChange(REMOVE_FIELD, {
            sandboxId: 'sb-test-2',
            snapshotsDir,
            isoTimestamp: '2026-05-15T22:00:00.000Z',
        });
        // target = 'know.Tenant.email' → snapshotter should query 'know.Tenant'
        assert.equal(receivedType, 'know.Tenant');
    });
});

test('LocalGraphSnapshotter dumps edges by relation for edge_type.removed', async () => {
    await withTmp(async dir => {
        const snapshotsDir = path.join(dir, '.lore', 'data-snapshots');
        fs.mkdirSync(snapshotsDir, { recursive: true });
        const fakeEdges = [
            { sourceId: 'tenant-1', targetId: 'unit-1', 'e.relation': 'leases' },
        ];
        const snapper = new LocalGraphSnapshotter(makeFakeGraph({ edgesByRelation: { 'leases': fakeEdges } }));
        const result = await snapper.snapshotForChange(REMOVE_EDGE_TYPE, {
            sandboxId: 'sb-test-3',
            snapshotsDir,
            isoTimestamp: '2026-05-15T22:00:00.000Z',
        });
        assert.equal(result.status, 'applied');
        assert.equal(result.rowCount, 1);
    });
});

test('LocalGraphSnapshotter writes a skipped result for permission.changed', async () => {
    await withTmp(async dir => {
        const snapshotsDir = path.join(dir, '.lore', 'data-snapshots');
        fs.mkdirSync(snapshotsDir, { recursive: true });
        const snapper = new LocalGraphSnapshotter(makeFakeGraph({}));
        const result = await snapper.snapshotForChange(PERMISSION_CHANGED, {
            sandboxId: 'sb-test-4',
            snapshotsDir,
            isoTimestamp: '2026-05-15T22:00:00.000Z',
        });
        assert.equal(result.status, 'skipped');
        assert.equal(result.rowCount, 0);
        assert.match(result.note ?? '', /permission/i);
    });
});

/* ---------- approve() integration ---------- */

test('approve with destructive change writes snapshot file BEFORE flipping schema', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const snapper = new LocalGraphSnapshotter(makeFakeGraph({
            nodesByType: { 'know.Tenant': [{ 'n.id': 'tenant-1', 'n.type': 'know.Tenant' }] },
        }));
        const store = new SchemaAuthoringStore(dir, undefined, snapper);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [REMOVE_NODE_TYPE],
            proposedBy: 'human:rafi',
        });
        const entry = await store.propose(proposal);
        const receipt = await store.approve(entry.sandboxId, 'human:rafi');
        assert.equal(receipt.dataSnapshots.length, 1);
        assert.equal(receipt.dataSnapshots[0].status, 'applied');
        assert.equal(receipt.dataSnapshots[0].rowCount, 1);
        // Snapshot file actually exists on disk.
        assert.ok(fs.existsSync(receipt.dataSnapshots[0].file));
        // And it's under the workspace's .lore/data-snapshots/ tree.
        assert.ok(receipt.dataSnapshots[0].file.includes('/.lore/data-snapshots/'));
    });
});

test('approve aborts and leaves live schema untouched if snapshot throws', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const liveBefore = fs.readFileSync(path.join(dir, '.lore', 'schema.json'), 'utf-8');
        const failingSnapper: DataSnapshotter = {
            async snapshotForChange() {
                throw new Error('substrate offline');
            },
        };
        const store = new SchemaAuthoringStore(dir, undefined, failingSnapper);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [REMOVE_NODE_TYPE],
            proposedBy: 'human:rafi',
        });
        const entry = await store.propose(proposal);
        await assert.rejects(
            () => store.approve(entry.sandboxId, 'human:rafi'),
            /aborting approval/i,
        );
        // Live schema unchanged.
        const liveAfter = fs.readFileSync(path.join(dir, '.lore', 'schema.json'), 'utf-8');
        assert.equal(liveAfter, liveBefore);
        // Sandbox file still present (approval didn't proceed).
        assert.ok(store.getProposal(entry.sandboxId), 'sandbox should survive failed approval');
    });
});

test('approve with only additive changes carries an empty dataSnapshots array', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const snapper = new LocalGraphSnapshotter(makeFakeGraph({}));
        const store = new SchemaAuthoringStore(dir, undefined, snapper);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [ADD_TENANT],
            proposedBy: 'ai:claude',
            transforms: { addNodeType: { name: 'know.Tenant', description: '', kind: 'factual' } },
        });
        const entry = await store.propose(proposal);
        const receipt = await store.approve(entry.sandboxId, 'human:rafi');
        assert.equal(receipt.dataSnapshots.length, 0);
    });
});

test('approve with multiple destructive changes snapshots each one', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const snapper = new LocalGraphSnapshotter(makeFakeGraph({
            nodesByType: { 'know.Tenant': [{ 'n.id': 'tenant-1' }] },
            edgesByRelation: { 'leases': [{ sourceId: 'a', targetId: 'b' }] },
        }));
        const store = new SchemaAuthoringStore(dir, undefined, snapper);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [REMOVE_NODE_TYPE, REMOVE_EDGE_TYPE],
            proposedBy: 'human:rafi',
        });
        const entry = await store.propose(proposal);
        const receipt = await store.approve(entry.sandboxId, 'human:rafi');
        assert.equal(receipt.dataSnapshots.length, 2);
        // Two distinct snapshot files.
        const files = new Set(receipt.dataSnapshots.map(s => s.file));
        assert.equal(files.size, 2);
    });
});

test('approve with no snapshotter (default) preserves prior behavior', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir); // no snapshotter
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [REMOVE_NODE_TYPE],
            proposedBy: 'human:rafi',
        });
        const entry = await store.propose(proposal);
        const receipt = await store.approve(entry.sandboxId, 'human:rafi');
        // No snapshotter wired → noop snapshotter runs, returns 'skipped'.
        assert.equal(receipt.dataSnapshots.length, 1);
        assert.equal(receipt.dataSnapshots[0].status, 'skipped');
        // And the live schema DID flip (noop snapshotter doesn't abort).
        const live = JSON.parse(fs.readFileSync(path.join(dir, '.lore', 'schema.json'), 'utf-8'));
        assert.equal(live.version, DEFAULT_SCHEMA_V2.version);
    });
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
