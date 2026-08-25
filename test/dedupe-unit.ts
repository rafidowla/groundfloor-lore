#!/usr/bin/env tsx
/**
 * test/dedupe-unit.ts — T5 unit tests
 *
 * In-memory storage stub so we test logic without a real graph.
 */

import { strict as assert } from 'node:assert';
import {
    DedupeEngine,
    Fingerprinters,
    type DedupeResult,
    type IngestRecord,
    type LookupFn,
    type UpsertFn,
} from '../packages/lore/src/engines/dedupe.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  ✓ ${name}`); passed++; },
            (err: Error) => {
                console.error(`  ✗ ${name}\n    ${err.message}`);
                failed++;
            },
        );
}

interface StoredNode {
    id: string;
    workspace: string;
    type: string;
    fingerprint: string | null;
    fields: Record<string, unknown>;
}

class InMemoryStore {
    /** Indexed by `${workspace}::${type}::${fingerprint}` */
    private byFingerprint = new Map<string, string>();
    private byId = new Map<string, StoredNode>();
    public upsertCalls: Array<Parameters<UpsertFn>[0]> = [];

    lookup: LookupFn = async (workspace, type, fingerprint) => {
        const key = `${workspace}::${type}::${fingerprint}`;
        const id = this.byFingerprint.get(key);
        if (!id) return null;
        const node = this.byId.get(id)!;
        return { id, fields: { ...node.fields } };
    };

    upsert: UpsertFn = async (input) => {
        this.upsertCalls.push(input);
        const node: StoredNode = {
            id: input.id,
            workspace: input.workspace,
            type: input.type,
            fingerprint: input.fingerprint,
            fields: { ...input.fields },
        };
        this.byId.set(node.id, node);
        if (input.fingerprint) {
            this.byFingerprint.set(
                `${input.workspace}::${input.type}::${input.fingerprint}`,
                input.id,
            );
        }
    };
}

async function main() {
    console.log('dedupe — T5');

    /* ---------- contentHash ---------- */

    await test('contentHash: same bytes → same fingerprint regardless of path', async () => {
        const store = new InMemoryStore();
        const engine = new DedupeEngine(store.lookup, store.upsert);
        engine.register('know.File', Fingerprinters.contentHash);

        const buf = Buffer.from('hello world');
        const r1: IngestRecord = {
            type: 'know.File', workspace: 'wsA',
            fields: { content: buf, path: '/tmp/a.txt' },
        };
        const r2: IngestRecord = {
            type: 'know.File', workspace: 'wsA',
            fields: { content: Buffer.from('hello world'), path: '/tmp/b.txt' },
        };

        const a = await engine.ingest(r1);
        const b = await engine.ingest(r2);
        assert.equal(a.action, 'created');
        assert.equal(b.action, 'merged');
        assert.equal(b.id, a.id, 'same id reused');
        assert.deepEqual(b.mergedFields, ['path']);
    });

    await test('contentHash: different bytes → different ids', async () => {
        const store = new InMemoryStore();
        const engine = new DedupeEngine(store.lookup, store.upsert);
        engine.register('know.File', Fingerprinters.contentHash);

        const a = await engine.ingest({ type: 'know.File', workspace: 'w', fields: { content: Buffer.from('foo') } });
        const b = await engine.ingest({ type: 'know.File', workspace: 'w', fields: { content: Buffer.from('bar') } });
        assert.notEqual(a.id, b.id);
    });

    /* ---------- fromKeys ---------- */

    await test('fromKeys: same business keys → merged', async () => {
        const store = new InMemoryStore();
        const engine = new DedupeEngine(store.lookup, store.upsert);
        engine.register('know.Tenant', Fingerprinters.fromKeys('taxId'));

        const r1: IngestRecord = { type: 'know.Tenant', workspace: 'w', fields: { taxId: 'T-1', name: 'Alice' } };
        const r2: IngestRecord = { type: 'know.Tenant', workspace: 'w', fields: { taxId: 'T-1', email: 'alice@x' } };

        const a = await engine.ingest(r1);
        const b = await engine.ingest(r2);
        assert.equal(a.action, 'created');
        assert.equal(b.action, 'merged');
        assert.equal(b.id, a.id);
        assert.deepEqual(b.mergedFields, ['email']);
    });

    await test('fromKeys: missing required key → no dedupe (always created)', async () => {
        const store = new InMemoryStore();
        const engine = new DedupeEngine(store.lookup, store.upsert);
        engine.register('know.Tenant', Fingerprinters.fromKeys('taxId'));

        const r: IngestRecord = { type: 'know.Tenant', workspace: 'w', fields: { name: 'Alice' } };
        const a = await engine.ingest(r);
        const b = await engine.ingest(r);
        assert.equal(a.action, 'created');
        assert.equal(b.action, 'created');
        assert.notEqual(a.id, b.id);
    });

    /* ---------- bySourceId ---------- */

    await test('bySourceId: connector replays don\'t duplicate', async () => {
        const store = new InMemoryStore();
        const engine = new DedupeEngine(store.lookup, store.upsert);
        engine.register('know.Lease', Fingerprinters.bySourceId);

        const r: IngestRecord = {
            type: 'know.Lease', workspace: 'w',
            fields: { rentMonthly: 5000 },
            source: { connector: 'yardi', sourceId: 'lease/123' },
        };
        const a = await engine.ingest(r);
        const b = await engine.ingest(r);
        const c = await engine.ingest({ ...r, fields: { rentMonthly: 5500 } });
        assert.equal(a.action, 'created');
        assert.equal(b.action, 'unchanged');
        assert.equal(c.action, 'merged');
        assert.deepEqual(c.mergedFields, ['rentMonthly']);
    });

    /* ---------- merge policies ---------- */

    await test('newest-wins (default): incoming overwrites', async () => {
        const store = new InMemoryStore();
        const engine = new DedupeEngine(store.lookup, store.upsert);
        engine.register('know.X', Fingerprinters.fromKeys('k'));

        await engine.ingest({ type: 'know.X', workspace: 'w', fields: { k: '1', name: 'Alice' } });
        const r = await engine.ingest({ type: 'know.X', workspace: 'w', fields: { k: '1', name: 'Alicia' } });
        assert.equal(r.action, 'merged');
        const stored = store.upsertCalls[store.upsertCalls.length - 1].fields;
        assert.equal(stored.name, 'Alicia');
    });

    await test('oldest-wins: existing values are preserved', async () => {
        const store = new InMemoryStore();
        const engine = new DedupeEngine(store.lookup, store.upsert);
        engine.register('know.X', Fingerprinters.fromKeys('k'), 'oldest-wins');

        await engine.ingest({ type: 'know.X', workspace: 'w', fields: { k: '1', name: 'Alice' } });
        const r = await engine.ingest({ type: 'know.X', workspace: 'w', fields: { k: '1', name: 'Alicia' } });
        assert.equal(r.action, 'unchanged', 'no field changed under oldest-wins');
    });

    await test('first-non-null: empty existing field gets filled in', async () => {
        const store = new InMemoryStore();
        const engine = new DedupeEngine(store.lookup, store.upsert);
        engine.register('know.X', Fingerprinters.fromKeys('k'), 'first-non-null');

        await engine.ingest({ type: 'know.X', workspace: 'w', fields: { k: '1', name: 'Alice', email: '' } });
        const r = await engine.ingest({ type: 'know.X', workspace: 'w', fields: { k: '1', name: 'Other', email: 'a@x.com' } });
        assert.equal(r.action, 'merged');
        assert.deepEqual(r.mergedFields, ['email']);
    });

    await test('append policy: arrays accumulate without duplicates', async () => {
        const store = new InMemoryStore();
        const engine = new DedupeEngine(store.lookup, store.upsert);
        engine.register('know.X', Fingerprinters.fromKeys('k'), 'append');

        await engine.ingest({ type: 'know.X', workspace: 'w', fields: { k: '1', tags: ['a', 'b'] } });
        const r = await engine.ingest({ type: 'know.X', workspace: 'w', fields: { k: '1', tags: ['b', 'c'] } });
        assert.equal(r.action, 'merged');
        const stored = store.upsertCalls[store.upsertCalls.length - 1].fields;
        assert.deepEqual(stored.tags, ['a', 'b', 'c']);
    });

    /* ---------- protected floor fields ---------- */

    await test('protected fields (id, type, workspace) are never overwritten on merge', async () => {
        const store = new InMemoryStore();
        const engine = new DedupeEngine(store.lookup, store.upsert);
        engine.register('know.X', Fingerprinters.fromKeys('k'));

        const a = await engine.ingest({ type: 'know.X', workspace: 'w', fields: { k: '1', id: 'fixed-1', name: 'A' } });
        const b = await engine.ingest({ type: 'know.X', workspace: 'w', fields: { k: '1', id: 'CHANGED', name: 'B' } });
        assert.equal(a.id, 'fixed-1');
        assert.equal(b.id, 'fixed-1', 'merge keeps original id');
        const stored = store.upsertCalls[store.upsertCalls.length - 1].fields;
        assert.equal(stored.name, 'B');
        // The merged record's id field should not have been written by merge.
        assert.notEqual(stored.id, 'CHANGED');
    });

    /* ---------- unregistered type ---------- */

    await test('unregistered type always creates (no dedupe path)', async () => {
        const store = new InMemoryStore();
        const engine = new DedupeEngine(store.lookup, store.upsert);
        // No register call for know.Y.
        const r1 = await engine.ingest({ type: 'know.Y', workspace: 'w', fields: { name: 'A' } });
        const r2 = await engine.ingest({ type: 'know.Y', workspace: 'w', fields: { name: 'A' } });
        assert.equal(r1.action, 'created');
        assert.equal(r2.action, 'created');
        assert.notEqual(r1.id, r2.id);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('test runner crashed:', err);
    process.exit(1);
});
