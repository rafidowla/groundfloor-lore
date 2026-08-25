#!/usr/bin/env tsx
/**
 * test/crud-unit.ts — A2 unit tests
 */

import { strict as assert } from 'node:assert';
import {
    CrudError,
    SchemaDrivenCrud,
    type NodeRecord,
    type NodeStorage,
} from '../packages/lore/src/engines/crud.js';
import {
    DEFAULT_SCHEMA_V2,
    type LoreSchemaV2,
} from '../packages/lore/src/schemas/types.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  ✓ ${name}`); passed++; },
            (err: Error) => { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; },
        );
}

class InMemoryNodeStorage implements NodeStorage {
    private byId = new Map<string, NodeRecord>();
    public createCalls: NodeRecord[] = [];

    async create(input: { id: string; type: string; workspace: string; fields: Record<string, unknown> }) {
        const r: NodeRecord = { id: input.id, type: input.type, workspace: input.workspace, fields: input.fields };
        this.byId.set(input.id, r);
        this.createCalls.push(r);
        return r;
    }
    async read(id: string) {
        return this.byId.get(id) ?? null;
    }
    async update(id: string, fields: Record<string, unknown>) {
        const existing = this.byId.get(id);
        if (!existing) return null;
        const merged: NodeRecord = { ...existing, fields: { ...existing.fields, ...fields } };
        this.byId.set(id, merged);
        return merged;
    }
    async delete(id: string) {
        return this.byId.delete(id);
    }
    async list(input: { type: string; workspace: string; filter?: Record<string, unknown>; limit?: number }) {
        const out: NodeRecord[] = [];
        for (const r of this.byId.values()) {
            if (r.type !== input.type) continue;
            if (r.workspace !== input.workspace) continue;
            out.push(r);
            if (input.limit && out.length >= input.limit) break;
        }
        return out;
    }
}

const PERSONAL_SCHEMA: LoreSchemaV2 = {
    ...DEFAULT_SCHEMA_V2,
    nodeTypes: [
        {
            name: 'know.Note', description: 'A note.', kind: 'factual',
            fields: [
                { name: 'title', type: 'string', required: true },
                { name: 'body', type: 'string' },
                { name: 'tags', type: 'json' },
            ],
        },
        {
            name: 'know.Person', description: 'A person.', kind: 'factual',
            fields: [
                { name: 'name', type: 'string', required: true },
                { name: 'birthYear', type: 'number' },
            ],
        },
        {
            name: 'mem.Conversation', description: 'A conversation.', kind: 'episodic', appendOnly: true,
        },
    ],
};

const CTX = (subject = 'user:alice', workspace = 'personal') => ({ subject, workspace });

async function main() {
    console.log('schema-driven CRUD — A2');

    /* ---------- create ---------- */

    await test('create populates floor fields and returns the new record', async () => {
        const store = new InMemoryNodeStorage();
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, store);
        const note = await crud.create('know.Note', { title: 'hello', body: 'world' }, CTX());
        assert.equal(note.type, 'know.Note');
        assert.equal(note.workspace, 'personal');
        assert.equal(note.fields.title, 'hello');
        assert.equal(note.fields.kind, 'factual');
        assert.equal(note.fields.createdBy, 'user:alice');
        assert.ok(note.fields.id);
        assert.ok(note.fields.ingestedAt);
        assert.ok(note.fields.provenance);
    });

    await test('create rejects unknown types', async () => {
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, new InMemoryNodeStorage());
        await assert.rejects(
            () => crud.create('know.Unicorn', {}, CTX()),
            (e: Error) => e instanceof CrudError && (e as CrudError).code === 'unknown-type',
        );
    });

    await test('create validates required fields', async () => {
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, new InMemoryNodeStorage());
        await assert.rejects(
            () => crud.create('know.Note', { body: 'no title here' }, CTX()),
            (e: Error) => (e as CrudError).code === 'validation',
        );
    });

    await test('create validates field types', async () => {
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, new InMemoryNodeStorage());
        await assert.rejects(
            () => crud.create('know.Person', { name: 'Alice', birthYear: 'not-a-number' }, CTX()),
            (e: Error) => (e as CrudError).code === 'validation',
        );
    });

    await test('create floor fields supplied by caller are stripped (immutable invariants)', async () => {
        const store = new InMemoryNodeStorage();
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, store);
        const note = await crud.create('know.Note', {
            title: 'x',
            // Caller tries to inject these — should be ignored / overwritten:
            kind: 'episodic',
            workspace: 'OTHER',
            createdBy: 'attacker',
        }, CTX());
        assert.equal(note.fields.kind, 'factual');
        assert.equal(note.fields.workspace, 'personal');
        assert.equal(note.fields.createdBy, 'user:alice');
    });

    /* ---------- permission check ---------- */

    await test('create denied when permissionCheck returns allowed:false', async () => {
        const store = new InMemoryNodeStorage();
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, store);
        await assert.rejects(
            () => crud.create('know.Note', { title: 'x' }, {
                ...CTX(),
                permissionCheck: async () => ({ allowed: false }),
            }),
            (e: Error) => (e as CrudError).code === 'denied',
        );
        assert.equal(store.createCalls.length, 0, 'denial blocked the storage call');
    });

    await test('create allowed when permissionCheck returns allowed:true', async () => {
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, new InMemoryNodeStorage());
        const note = await crud.create('know.Note', { title: 'x' }, {
            ...CTX(),
            permissionCheck: async () => ({ allowed: true }),
        });
        assert.equal(note.fields.title, 'x');
    });

    /* ---------- update ---------- */

    await test('update mutates declared fields, returns merged record', async () => {
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, new InMemoryNodeStorage());
        const created = await crud.create('know.Note', { title: 'orig' }, CTX());
        const updated = await crud.update(created.id, { title: 'new' }, CTX());
        assert.equal(updated.fields.title, 'new');
    });

    await test('update rejects floor field mutations', async () => {
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, new InMemoryNodeStorage());
        const created = await crud.create('know.Note', { title: 'x' }, CTX());
        await assert.rejects(
            () => crud.update(created.id, { id: 'CHANGED' }, CTX()),
            (e: Error) => (e as CrudError).code === 'immutable-field',
        );
        await assert.rejects(
            () => crud.update(created.id, { kind: 'episodic' }, CTX()),
            (e: Error) => (e as CrudError).code === 'immutable-field',
        );
    });

    await test('update on episodic / appendOnly types is forbidden', async () => {
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, new InMemoryNodeStorage());
        const created = await crud.create('mem.Conversation', {}, CTX());
        await assert.rejects(
            () => crud.update(created.id, { something: 'else' }, CTX()),
            (e: Error) => (e as CrudError).code === 'immutable-field',
        );
    });

    await test('update on missing node throws not-found', async () => {
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, new InMemoryNodeStorage());
        await assert.rejects(
            () => crud.update('nope', { title: 'x' }, CTX()),
            (e: Error) => (e as CrudError).code === 'not-found',
        );
    });

    /* ---------- delete ---------- */

    await test('delete returns true when present, false when absent', async () => {
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, new InMemoryNodeStorage());
        const created = await crud.create('know.Note', { title: 'x' }, CTX());
        assert.equal(await crud.delete(created.id, CTX()), true);
        assert.equal(await crud.delete(created.id, CTX()), false);
    });

    await test('delete denied by permissionCheck', async () => {
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, new InMemoryNodeStorage());
        const created = await crud.create('know.Note', { title: 'x' }, CTX());
        await assert.rejects(
            () => crud.delete(created.id, { ...CTX(), permissionCheck: async () => ({ allowed: false }) }),
            (e: Error) => (e as CrudError).code === 'denied',
        );
    });

    /* ---------- list ---------- */

    await test('list filters by type + workspace', async () => {
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, new InMemoryNodeStorage());
        await crud.create('know.Note', { title: 'a' }, CTX());
        await crud.create('know.Note', { title: 'b' }, CTX());
        await crud.create('know.Person', { name: 'c' }, CTX());
        const notes = await crud.list('know.Note', CTX());
        assert.equal(notes.length, 2);
    });

    await test('list applies limit', async () => {
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, new InMemoryNodeStorage());
        for (let i = 0; i < 5; i++) await crud.create('know.Note', { title: `n${i}` }, CTX());
        const out = await crud.list('know.Note', CTX(), { limit: 3 });
        assert.equal(out.length, 3);
    });

    /* ---------- schema swap ---------- */

    await test('setSchema rebuilds the type index', async () => {
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, new InMemoryNodeStorage());
        const evolved: LoreSchemaV2 = {
            ...PERSONAL_SCHEMA,
            nodeTypes: [
                ...PERSONAL_SCHEMA.nodeTypes,
                { name: 'know.Project', description: '', kind: 'factual', fields: [{ name: 'name', type: 'string', required: true }] },
            ],
        };
        await assert.rejects(
            () => crud.create('know.Project', { name: 'p' }, CTX()),
            (e: Error) => (e as CrudError).code === 'unknown-type',
        );
        crud.setSchema(evolved);
        const r = await crud.create('know.Project', { name: 'p' }, CTX());
        assert.equal(r.fields.name, 'p');
    });

    /* ---------- listTypes ---------- */

    await test('listTypes exposes all declared node types', () => {
        const crud = new SchemaDrivenCrud(PERSONAL_SCHEMA, new InMemoryNodeStorage());
        const types = crud.listTypes().map(t => t.name).sort();
        assert.ok(types.includes('know.Note'));
        assert.ok(types.includes('know.Person'));
        assert.ok(types.includes('mem.Conversation'));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('test runner crashed:', err);
    process.exit(1);
});
