#!/usr/bin/env tsx
/**
 * cloud-score-normalisation-unit.ts — cloud parity Slice B item 4 (DESIGN D4, engine fact F9):
 * vector scores are normalised from whichever key the connector returns, so cloud results
 * rank and threshold like local (`1 - cosineDistance/2` == `(1 + cosineSimilarity)/2`).
 */
import assert from 'node:assert/strict';
import { normalizeVectorScore } from '../packages/lore/src/engines/dataplaneScore.js';
import { startCloudFixture, bagOfWordsEmbedder } from './helpers/cloud-stores-fixture.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

console.log('cloud parity B item 4: normalizeVectorScore (pure)');
await test('_score (already 0..1 per ask #8) wins and is clamped', () => {
    assert.equal(normalizeVectorScore({ _score: 0.8, score: -1, _distance: 0 }), 0.8);
    assert.equal(normalizeVectorScore({ _score: 1.7 }), 1);
    assert.equal(normalizeVectorScore({ _score: -0.2 }), 0);
});
await test('_distance is cosine distance in [0,2] -> 1 - d/2', () => {
    near(normalizeVectorScore({ _distance: 0 }), 1);
    near(normalizeVectorScore({ _distance: 1 }), 0.5);
    near(normalizeVectorScore({ _distance: 2 }), 0);
    near(normalizeVectorScore({ _distance: 0.4, score: 0.9 }), 0.8);
});
await test('score (Qdrant cosine similarity, [-1,1]) -> (1 + s)/2', () => {
    near(normalizeVectorScore({ score: 1 }), 1);
    near(normalizeVectorScore({ score: 0 }), 0.5);
    near(normalizeVectorScore({ score: -1 }), 0);
    near(normalizeVectorScore({ score: 0.6, distance: 0.1 }), 0.8);
});
await test('distance (Zilliz COSINE: similarity under a distance-named key) -> (1 + s)/2', () => {
    near(normalizeVectorScore({ distance: 0.5 }), 0.75);
});
await test('no score key (Arango) -> 0; non-finite / non-numeric -> 0; always within [0,1]', () => {
    assert.equal(normalizeVectorScore({}), 0);
    assert.equal(normalizeVectorScore({ score: Number.NaN }), 0);
    assert.equal(normalizeVectorScore({ score: Number.POSITIVE_INFINITY }), 0);
    assert.equal(normalizeVectorScore({ score: '0.9' }), 0);
    assert.equal(normalizeVectorScore({ score: 7 }), 1);
    assert.equal(normalizeVectorScore({ score: -7 }), 0);
});

console.log('cloud parity B item 4: DataplaneVectorStore.search ranks + scores like local');
const W = 'score-ws';
const emb = bagOfWordsEmbedder();
const cos = (a: number[], b: number[]) => {
    let d = 0, x = 0, y = 0;
    for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! * a[i]!; y += b[i]! * b[i]!; }
    return d / Math.sqrt(x * y);
};
const docs = [
    { id: 'near', text: 'alpha beta gamma delta' },
    { id: 'mid', text: 'alpha beta zeta eta theta' },
    { id: 'far', text: 'kappa lambda mu nu xi omicron' },
];
const QUERY = 'alpha beta gamma';

for (const scoreKey of ['score', 'distance', '_distance', '_score'] as const) {
    const fx = await startCloudFixture({ scoreKey });
    try {
        await test(`scoreKey=${scoreKey}: scores equal local's (1 + cos)/2 and order is best-first`, async () => {
            await fx.as(W, async () => { for (const d of docs) await fx.vector.store({ id: d.id, text: d.text, metadata: {} } as never); });
            const res = await fx.as(W, () => fx.vector.search(QUERY, 10));
            assert.equal(res.length, 3);
            const q = await emb.embedQuery(QUERY);
            for (const r of res) {
                const d = docs.find((x) => x.id === r.id)!;
                near(r.score, (1 + cos(q, await emb.embedDocument(d.text))) / 2, 1e-9);
                assert.ok(r.score >= 0 && r.score <= 1);
            }
            assert.deepEqual(res.map((r) => r.id), ['near', 'mid', 'far']);
            for (let i = 1; i < res.length; i++) assert.ok(res[i - 1]!.score >= res[i]!.score);
        });
    } finally { await fx.close(); }
}

{
    const fx = await startCloudFixture({ scoreKey: 'none' });
    try {
        await test('scoreKey=none (Arango): score 0 for every hit, server order kept, no throw', async () => {
            await fx.as(W, async () => { for (const d of docs) await fx.vector.store({ id: d.id, text: d.text, metadata: {} } as never); });
            const res = await fx.as(W, () => fx.vector.search(QUERY, 10));
            assert.equal(res.length, 3);
            assert.ok(res.every((r) => r.score === 0));
            assert.deepEqual(res.map((r) => r.id), ['near', 'mid', 'far']);
        });
    } finally { await fx.close(); }
}

{
    const fx = await startCloudFixture({ scoreKey: 'score' });
    try {
        await test('a min-score threshold keeps the same rows it keeps locally (0.75 cut)', async () => {
            await fx.as(W, async () => { for (const d of docs) await fx.vector.store({ id: d.id, text: d.text, metadata: {} } as never); });
            const res = await fx.as(W, () => fx.vector.search(QUERY, 10));
            const q = await emb.embedQuery(QUERY);
            const expectKept = [];
            for (const d of docs) if ((1 + cos(q, await emb.embedDocument(d.text))) / 2 >= 0.75) expectKept.push(d.id);
            assert.deepEqual(res.filter((r) => r.score >= 0.75).map((r) => r.id).sort(), expectKept.sort());
        });
    } finally { await fx.close(); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
