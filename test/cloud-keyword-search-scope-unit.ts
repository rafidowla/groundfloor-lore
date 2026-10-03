#!/usr/bin/env tsx
/**
 * cloud-keyword-search-scope-unit.ts — cloud parity A2 item 1.
 *
 * Keyword (BM25) search is re-enabled AND scoped in the same change. The engine's
 * POST /v1/:collection/search accepts NO filter (design F4), so scope is a client-side
 * predicate over an over-fetched list. Two Lore workspaces share ONE Dataplane
 * workspace (one credential) with identical text; workspace W2 must never see W1's rows
 * on any keyword path, the caller's type/project filters must be honoured, and both
 * engine modes (ranked `_score` / substring) must work.
 */

import assert from 'node:assert/strict';
import { startCloudFixture, type CloudFixture } from './helpers/cloud-stores-fixture.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const W1 = 'lore-ws-one';
const W2 = 'lore-ws-two';
const TEXT = 'quarterly widget rollout plan for the northern region';

async function seed(fx: CloudFixture): Promise<void> {
    // Identical text in both Lore workspaces; W1 also holds a same-id row ('shared').
    await fx.as(W1, async () => {
        await fx.vector.store({ id: 'w1-note', text: TEXT, metadata: { type: 'note', project: 'p-a' } });
        await fx.vector.store({ id: 'shared', text: TEXT, metadata: { type: 'note', project: 'p-a' } });
        await fx.vector.store({ id: 'w1-secret', text: 'widget secret only workspace one knows', metadata: { type: 'decision', project: 'p-b' } });
    });
    await fx.as(W2, async () => {
        await fx.vector.store({ id: 'w2-note', text: TEXT, metadata: { type: 'note', project: 'p-a' } });
        await fx.vector.store({ id: 'shared', text: TEXT, metadata: { type: 'note', project: 'p-a' } });
        await fx.vector.store({ id: 'w2-decision', text: 'widget decision record', metadata: { type: 'decision', project: 'p-b' } });
    });
}

const ids = (env: { hits: Array<{ id: string }> }): string[] => env.hits.map((h) => h.id).sort();

console.log('cloud keyword search scope (ranked mode)');
{
    const fx = await startCloudFixture({ ftsMode: 'ranked' });
    try {
        await seed(fx);

        await test('W2 keyword search returns only W2 rows (W1 rows with identical text never appear)', async () => {
            const env = await fx.as(W2, () => fx.vector.bm25Search('widget', 20));
            assert.deepEqual(ids(env), ['shared', 'w2-decision', 'w2-note']);
            assert.equal(env.ranked, true);
            assert.ok(!ids(env).includes('w1-note') && !ids(env).includes('w1-secret'));
        });

        await test('W1 sees only W1 rows, incl. its own copy of the shared id', async () => {
            const env = await fx.as(W1, () => fx.vector.bm25Search('widget', 20));
            assert.deepEqual(ids(env), ['shared', 'w1-note', 'w1-secret']);
        });

        await test('a term only W1 holds yields nothing for W2', async () => {
            const env = await fx.as(W2, () => fx.vector.bm25Search('secret', 20));
            assert.deepEqual(env.hits, []);
        });

        await test('caller type filter is honoured (server has no filter, client predicate applies)', async () => {
            const env = await fx.as(W2, () => fx.vector.bm25Search('widget', 20, { type: 'decision' }));
            assert.deepEqual(ids(env), ['w2-decision']);
        });

        await test('caller project filter is honoured', async () => {
            const env = await fx.as(W2, () => fx.vector.bm25Search('widget', 20, { project: 'p-b' }));
            assert.deepEqual(ids(env), ['w2-decision']);
        });

        await test('scores are normalised into [0,1] after the post-filter (raw / max(max,1))', async () => {
            const env = await fx.as(W2, () => fx.vector.bm25Search('widget rollout', 20));
            assert.ok(env.hits.length > 0);
            for (const h of env.hits) assert.ok(h.score >= 0 && h.score <= 1, `score ${h.score}`);
            // hits are best-first
            for (let i = 1; i < env.hits.length; i++) assert.ok(env.hits[i - 1]!.score >= env.hits[i]!.score);
        });

        await test('the keyword request carries no filter and the SDK search route was actually used', async () => {
            const searches = fx.mock.requests.filter((r) => r.path === '/v1/lore_verbatim/search');
            assert.ok(searches.length > 0, 'search route was never called');
            for (const r of searches) assert.equal(r.body['filter'], undefined);
        });

        await test('over-fetch: engine asked for more than the caller limit', async () => {
            fx.mock.requests.length = 0;
            await fx.as(W2, () => fx.vector.bm25Search('widget', 3));
            const req = fx.mock.requests.find((r) => r.path === '/v1/lore_verbatim/search');
            assert.ok(req && (req.body['limit'] as number) >= 30, `limit ${String(req?.body['limit'])}`);
        });

        await test('no Lore workspace bound -> fails closed (empty, unranked), never a cross-workspace read', async () => {
            const env = await fx.vector.bm25Search('widget', 20);
            assert.deepEqual(env.hits, []);
            assert.equal(env.ranked, false);
        });

        await test('empty query -> empty ranked envelope, no request', async () => {
            fx.mock.requests.length = 0;
            const env = await fx.as(W2, () => fx.vector.bm25Search('   ', 5));
            assert.deepEqual(env, { hits: [], ranked: true });
            assert.equal(fx.mock.requests.filter((r) => r.path.endsWith('/search')).length, 0);
        });
    } finally { await fx.close(); }
}

console.log('cloud keyword search scope (substring mode: engine returns no _score)');
{
    const fx = await startCloudFixture({ ftsMode: 'substring' });
    try {
        await seed(fx);

        await test('substring hits are returned (not empty) with score 1.0 and ranked:false', async () => {
            const env = await fx.as(W2, () => fx.vector.bm25Search('widget', 20));
            assert.equal(env.ranked, false);
            assert.deepEqual(ids(env), ['shared', 'w2-decision', 'w2-note']);
            for (const h of env.hits) assert.equal(h.score, 1.0);
        });

        await test('substring mode is scoped and honours caller filters too', async () => {
            const env = await fx.as(W2, () => fx.vector.bm25Search('widget', 20, { type: 'decision' }));
            assert.deepEqual(ids(env), ['w2-decision']);
            const other = await fx.as(W2, () => fx.vector.bm25Search('secret', 20));
            assert.deepEqual(other.hits, []);
        });
    } finally { await fx.close(); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
