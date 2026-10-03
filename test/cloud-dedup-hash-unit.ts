#!/usr/bin/env tsx
/**
 * cloud-dedup-hash-unit.ts — cloud parity Slice B item 3: content_hash is persisted on
 * cloud verbatim rows, getById reads it back, getContentHashesByIds is implemented
 * (scoped by org + Lore workspace, chunked) and an identical re-store is a no-op.
 */
import assert from 'node:assert/strict';
import { startCloudFixture, DP_WORKSPACE } from './helpers/cloud-stores-fixture.js';
import { computeContentHash } from '../packages/lore/src/engines/contentHash.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const W1 = 'dedup-ws-one';
const W2 = 'dedup-ws-two';
const doc = (id: string, text: string, extra: Record<string, unknown> = {}) =>
    ({ id, text, metadata: { type: 'note', label: id, tags: '', project: 'p', ecosystem: 'e', updatedAt: '2026-09-01T00:00:00.000Z', security_scopes: [], ...extra } });

const fx = await startCloudFixture();
try {
    console.log('cloud parity B item 3: content_hash + getContentHashesByIds');

    await test('store persists content_hash (auto-computed when the caller omits it)', async () => {
        await fx.as(W1, () => fx.vector.store(doc('a', 'alpha text') as never));
        const rows = fx.mock.rows(DP_WORKSPACE, 'lore_verbatim').filter((r) => r['lore_id'] === 'a');
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!['content_hash'], computeContentHash('alpha text'));
    });
    await test('a caller-supplied contentHash wins over the computed one', async () => {
        await fx.as(W1, () => fx.vector.store(doc('b', 'beta text', { contentHash: 'supplied-hash' }) as never));
        const row = fx.mock.rows(DP_WORKSPACE, 'lore_verbatim').find((r) => r['lore_id'] === 'b')!;
        assert.equal(row['content_hash'], 'supplied-hash');
    });
    await test('getById returns the stored hash and the full stored shape', async () => {
        const got = await fx.as(W1, () => fx.vector.getById('a')) as Record<string, unknown>;
        assert.equal(got['contentHash'], computeContentHash('alpha text'));
        assert.equal(got['text'], 'alpha text');
        assert.equal(got['project'], 'p');
        assert.equal(got['type'], 'note');
    });
    await test('getContentHashesByIds returns id -> hash and omits unknown ids', async () => {
        const m = await fx.as(W1, () => fx.vector.getContentHashesByIds(['a', 'b', 'missing']));
        assert.equal(m.get('a'), computeContentHash('alpha text'));
        assert.equal(m.get('b'), 'supplied-hash');
        assert.equal(m.has('missing'), false);
        assert.equal(m.size, 2);
    });
    await test('getContentHashesByIds is scoped: another Lore workspace sees none of it', async () => {
        const m = await fx.as(W2, () => fx.vector.getContentHashesByIds(['a', 'b']));
        assert.equal(m.size, 0);
        // same id in W2 with different text -> W2 sees only its own hash
        await fx.as(W2, () => fx.vector.store(doc('a', 'other text') as never));
        const m2 = await fx.as(W2, () => fx.vector.getContentHashesByIds(['a']));
        assert.equal(m2.get('a'), computeContentHash('other text'));
        const m1 = await fx.as(W1, () => fx.vector.getContentHashesByIds(['a']));
        assert.equal(m1.get('a'), computeContentHash('alpha text'));
    });
    await test('getContentHashesByIds drops a foreign row even if the engine returns one (client guard)', async () => {
        // SQLite-connector emulation: the engine ignores every filter but id_eq.
        fx.mock.options.queryFilterMode = 'sqlite';
        try {
            const m = await fx.as(W2, () => fx.vector.getContentHashesByIds(['a', 'b']));
            assert.equal(m.get('a'), computeContentHash('other text'));
            assert.equal(m.has('b'), false, 'W1-only id b must not leak into W2');
        } finally { fx.mock.options.queryFilterMode = 'full'; }
    });
    await test('getContentHashesByIds chunks large id lists (<=200 ids per query)', async () => {
        const ids = Array.from({ length: 450 }, (_, i) => `chunk-${i}`);
        const before = fx.mock.requests.length;
        const m = await fx.as(W1, () => fx.vector.getContentHashesByIds(ids));
        assert.equal(m.size, 0);
        const queries = fx.mock.requests.slice(before).filter((r) => r.path.endsWith('/lore_verbatim/query'));
        assert.equal(queries.length, 3);
    });
    await test('an identical re-store is a no-op (no write requests)', async () => {
        const before = fx.mock.requests.length;
        await fx.as(W1, () => fx.vector.store(doc('a', 'alpha text') as never));
        const writes = fx.mock.requests.slice(before).filter((r) => r.method !== 'GET' && (r.method !== 'POST' || !/\/(query|count)$/.test(r.path))); // reads: GET-by-key, query, count
        assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), []);
    });
    await test('same text but changed metadata is written (not skipped)', async () => {
        await fx.as(W1, () => fx.vector.store(doc('a', 'alpha text', { project: 'p2' }) as never));
        const got = await fx.as(W1, () => fx.vector.getById('a')) as Record<string, unknown>;
        assert.equal(got['project'], 'p2');
    });
    await test('changed text updates the hash', async () => {
        await fx.as(W1, () => fx.vector.store(doc('a', 'alpha text changed', { project: 'p2' }) as never));
        const m = await fx.as(W1, () => fx.vector.getContentHashesByIds(['a']));
        assert.equal(m.get('a'), computeContentHash('alpha text changed'));
    });
    await test('a tombstoned row is never skipped as identical', async () => {
        await fx.as(W1, () => fx.vector.store(doc('t', '[TOMBSTONED] gone', { contentHash: 'h-t' }) as never));
        await fx.as(W1, () => fx.vector.store(doc('t', 'revived', { contentHash: 'h-t' }) as never));
        const got = await fx.as(W1, () => fx.vector.getById('t')) as Record<string, unknown>;
        assert.equal(got['text'], 'revived');
    });
} finally {
    await fx.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
