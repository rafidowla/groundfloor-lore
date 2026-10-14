#!/usr/bin/env tsx
/**
 * test/recall-embedded-flag-unit.ts - 3.34.0 slice 3b (N5): the additive per-hit `embedded:false`.
 *
 * Hybrid recall can return a node from the keyword leg before its embedding exists. Such a hit
 * lacks 'semantic' in `matchedBy` and carries no `similarity`; a client using "the hit came back"
 * as a readiness signal would see a false "ready". The shared recall layer marks those hits
 * `embedded:false` on every surface (projection, summary, full, compact). The field is additive:
 * it is ABSENT on every other hit and no existing field changes.
 *
 * Run: npx tsx test/recall-embedded-flag-unit.ts
 */
import assert from 'node:assert/strict';
import { isNotEmbeddedHit, projectResults, projectScored, projectKeywordNodes } from '../packages/lore/src/recall/retrievalProjection.js';
import { buildRecallResult, buildCompactCandidates, type RecallPresentationParams } from '../packages/lore/src/recall/recallPreset.js';
import type { RetrieveOutcome, RetrieveMeta } from '../packages/lore/src/recall/retrieveTypes.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const fnode = (id: string) => ({
    id, type: 'note', label: `Label ${id}`, content: `content body for ${id}`, tags: [], project: 'n5', ecosystem: '*',
    language: null, updatedAt: '2026-06-01T00:00:00.000Z',
});
function baseMeta(): RetrieveMeta {
    return {
        topSimilarity: null, topRelevance: null, relevanceFloor: 2, belowFloor: false, abstained: false,
        calibration: { status: 'not_applicable' as const, version: 'v0', probes: 0, rows: 0, nullMedian: null, nullScale: null, scope: 'none' },
        topScore: null, sourcesConsulted: 1, totalMatched: 2, truncated: false, droppedCount: 0, directMatches: 2,
        verbatimConsulted: false, scanCapHit: false, bm25Ranked: true, vectorLegSkipped: false,
        possibleStarvation: false, candidateWindow: 0, prefixStableUpTo: 0,
    } as RetrieveMeta;
}
const graph = {
    async getNode(id: string) { return fnode(id) as never; },
    async getLanguageBreakdown() { return {}; },
    async listNodes() { return []; },
};
const params = (over: Partial<RecallPresentationParams> = {}): RecallPresentationParams => ({
    topic: 'zzyzxn5', responseMode: 'summary', searchMode: 'hybrid', workspaceScope: 'n5', ecosystemScope: '*', crossProject: false, ...over,
});
// kw: keyword leg only (not embedded yet). sem: semantic leg with a similarity.
const outcome = (): RetrieveOutcome => ({
    results: [
        { node: fnode('kw') as never, score: 0.5, matchedBy: ['bm25'], depth: 0, source: 'seed' },
        { node: fnode('sem') as never, score: 0.9, matchedBy: ['semantic', 'bm25'], depth: 0, source: 'seed', similarity: 0.81 },
    ],
    related: [], meta: baseMeta(),
});

console.log('isNotEmbeddedHit');
await test('keyword-only with no similarity => true; semantic or a similarity => false', () => {
    assert.equal(isNotEmbeddedHit(['bm25'], undefined), true);
    assert.equal(isNotEmbeddedHit(['keyword'], null), true);
    assert.equal(isNotEmbeddedHit([], undefined), true);
    assert.equal(isNotEmbeddedHit(undefined, undefined), true);
    assert.equal(isNotEmbeddedHit(['semantic'], undefined), false);
    assert.equal(isNotEmbeddedHit(['semantic', 'bm25'], 0.8), false);
    assert.equal(isNotEmbeddedHit(['bm25'], 0.4), false, 'a similarity means a vector was scored');
    assert.equal(isNotEmbeddedHit(['bm25'], 0), false, 'similarity 0 is still a similarity');
});

console.log('\nprojection');
await test('projectResults / projectScored / projectKeywordNodes flag only the un-embedded hit; no other field changes', () => {
    const o = outcome();
    const items = projectResults(o.results);
    assert.equal(items[0]!.embedded, false);
    assert.ok(!('embedded' in items[1]!), 'absent (not undefined, not true) on an embedded hit');
    const scored = projectScored([
        { node: fnode('kw') as never, matchedBy: ['bm25'], score: 0.5 },
        { node: fnode('sem') as never, matchedBy: ['semantic'], score: 0.9, similarity: 0.8 },
    ]);
    assert.equal(scored[0]!.embedded, false);
    assert.ok(!('embedded' in scored[1]!));
    assert.equal(projectKeywordNodes([fnode('x') as never])[0]!.embedded, false);
    // Existing fields are untouched.
    assert.deepEqual(Object.keys(items[1]!).sort(), ['content', 'id', 'label', 'language', 'matchedBy', 'project', 'score', 'similarity', 'tags', 'type']);
    assert.equal(items[0]!.similarity, undefined);
});

console.log('\nrecall presentation');
await test('summary: hits[].embedded === false only on the keyword-only hit', async () => {
    const res = await buildRecallResult(params(), outcome(), graph) as any;
    const by = new Map<string, any>(res.hits.map((h: any) => [h.id, h]));
    assert.equal(by.get('kw').embedded, false);
    assert.ok(!('embedded' in by.get('sem')));
    assert.equal(by.get('sem').label, 'Label sem', 'existing fields unchanged');
});
await test('full: knowledge[].embedded === false only on the keyword-only hit', async () => {
    const res = await buildRecallResult(params({ responseMode: 'full' }), outcome(), graph) as any;
    const by = new Map<string, any>(res.knowledge.map((h: any) => [h.id, h]));
    assert.equal(by.get('kw').embedded, false);
    assert.ok(!('embedded' in by.get('sem')));
});
await test('compact: candidates[].embedded === false only on the keyword-only hit', () => {
    const [kw, sem] = buildCompactCandidates(outcome());
    assert.equal(kw!.embedded, false);
    assert.ok(!('embedded' in sem!));
    assert.equal(kw!.score, 0.5);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
