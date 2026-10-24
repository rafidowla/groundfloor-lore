#!/usr/bin/env tsx
/**
 * test/link-linker-unit.ts - link-on-arrival: StoredVectorLinker over a REAL SqliteGraph and a REAL
 * SqliteVerbatimStore with hand-placed vectors (unit vectors at chosen angles, so cosine = cos(delta)).
 * The embedder throws if anything calls it: the Linker must work from stored vectors alone.
 *
 *   selection       threshold, top-k, only canonical node rows (history / question-alias rows never become edges)
 *   confinement     ecosystem-scoped nodes link only inside their ecosystem; row-level scopes need EQUAL scope sets
 *   caller edges    an existing non-inferred edge on the same triple is untouched; a replay changes nothing
 *   batching        N arrivals -> ONE batched kNN call and ONE batched edge write
 *   failure modes   vanished node = done, no vector yet = retry, endpoint deleted = skipped and counted,
 *                   unresolvable workspace = retry
 *   duplicates      near-duplicates are linked AND reported for the supersession-candidate list
 *   fallback        a graph without addInferredEdgesBatch is written edge by edge
 *
 * Run: npx tsx test/link-linker-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { StoredVectorLinker, type LinkHandles } from '../packages/lore/src/link/storedVectorLinker.js';
import type { LinkPolicy } from '../packages/lore/src/link/linkConfig.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

const DIM = 4;
class NoEmbed implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'link-linker-none'; readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embed(): Promise<number[]> { throw new Error('the Linker must never embed'); }
    async embedQuery(): Promise<number[]> { throw new Error('the Linker must never embed'); }
    async embedDocument(): Promise<number[]> { throw new Error('the Linker must never embed'); }
}
const at = (deg: number): number[] => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180), 0, 0];
const POLICY: LinkPolicy = { minSim: 0.9, k: 5, dupSim: 0.999, policyVersion: 'test' };
const REL = 'semantic_neighbor';

interface Spec { id: string; deg: number; eco?: string; scopes?: string[]; noVector?: boolean; noNode?: boolean }
interface World { graph: SqliteGraph; verbatim: SqliteVerbatimStore; knnCalls: number; handles: LinkHandles; linker: StoredVectorLinker }

async function world(specs: Spec[], policy: LinkPolicy = POLICY, extra?: Spec[]): Promise<World> {
    const graph = new SqliteGraph(mkTmp('ll-g-'), { workspaceId: 'll' });
    await graph.initialize();
    const verbatim = new SqliteVerbatimStore(mkTmp('ll-v-'), new NoEmbed());
    await verbatim.initialize();
    const all = [...specs, ...(extra ?? [])];
    for (const s of all) {
        if (s.noNode) continue;
        await graph.upsertNode({ id: s.id, type: 'note', label: s.id, content: `content ${s.id}`, tags: [], project: 'p', ecosystem: s.eco ?? '*', metadata: '{}' } as never);
    }
    await verbatim.bulkAddPrebuiltRows(all.map((s) => ({
        id: `lore:${s.id}`, label: s.id, text: `text ${s.id}`, type: 'note', project: 'p', ecosystem: s.eco ?? '*',
        security_scopes: s.scopes ?? [], ...(s.noVector ? {} : { vector: at(s.deg) }), contentHash: `h-${s.id}`, updatedAt: '2026-10-23T00:00:00.000Z',
    })) as never);
    const w = { graph, verbatim, knnCalls: 0 } as World;
    const origKnn = verbatim.searchByVectors.bind(verbatim);
    (verbatim as { searchByVectors: typeof origKnn }).searchByVectors = async (q, o) => { w.knnCalls++; return origKnn(q, o); };
    w.handles = { graph: graph as never, verbatim: verbatim as never };
    w.linker = new StoredVectorLinker(async (ws) => (ws === 'gone' ? null : w.handles), policy);
    return w;
}
const edgesOf = async (g: SqliteGraph): Promise<string[]> =>
    (await g.queryEdges({ limit: 1000, offset: 0, relation: REL })).map((e) => `${e.sourceId}-${e.targetId}`).sort();

console.log('\nselection');

await test('links an arriving node to neighbours above the threshold, from the stored vector (no embed call)', async () => {
    const w = await world([{ id: 'a', deg: 0 }, { id: 'b', deg: 10 }, { id: 'c', deg: 40 }, { id: 'd', deg: 90 }]);
    const r = await w.linker.linkBatch('ws', [{ id: 'a' }]);
    assert.deepEqual(r.done, ['a']);
    assert.deepEqual(r.retry, []);
    assert.deepEqual(await edgesOf(w.graph), ['a-b'], 'cos(10deg)=.985 passes .9; cos(40deg)=.766 does not');
    const e = await w.graph.getEdge('a', 'b', REL);
    assert.equal(e?.confidence, 'inferred');
    assert.ok(Math.abs((e?.confidenceScore ?? 0) - Math.cos(10 * Math.PI / 180)) < 1e-3);
});

await test('top-k caps edges per arriving node, best first', async () => {
    const w = await world([{ id: 'a', deg: 0 }, { id: 'b', deg: 5 }, { id: 'c', deg: 10 }, { id: 'd', deg: 15 }], { ...POLICY, k: 2 });
    await w.linker.linkBatch('ws', [{ id: 'a' }]);
    assert.deepEqual(await edgesOf(w.graph), ['a-b', 'a-c']);
});

await test('history rows and question-alias rows never become edges (only canonical node rows do)', async () => {
    const w = await world([{ id: 'a', deg: 0 }, { id: 'b', deg: 10 }], POLICY, [
        { id: 'b#q0', deg: 1, noNode: true }, { id: 'b#rev2020-01-01T00:00:00.000Z', deg: 2, noNode: true },
    ]);
    await w.linker.linkBatch('ws', [{ id: 'a' }]);
    assert.deepEqual(await edgesOf(w.graph), ['a-b']);
});

console.log('\nconfinement');

await test('an ecosystem-scoped node links only inside its ecosystem, even when another ecosystem is closer', async () => {
    const w = await world([{ id: 'x1', deg: 0, eco: 'eco-x' }, { id: 'y1', deg: 2, eco: 'eco-y' }, { id: 'x2', deg: 12, eco: 'eco-x' }]);
    await w.linker.linkBatch('ws', [{ id: 'x1', ecosystem: 'eco-x' }]);
    assert.deepEqual(await edgesOf(w.graph), ['x1-x2']);
});

await test('row-level scopes need EQUAL scope sets: scoped never links to public, public never to scoped', async () => {
    const w = await world([
        { id: 'pub1', deg: 0 }, { id: 'pub2', deg: 8 },
        { id: 'sec1', deg: 2, scopes: ['team-a'] }, { id: 'sec2', deg: 4, scopes: ['team-a'] }, { id: 'oth', deg: 3, scopes: ['team-b'] },
    ]);
    await w.linker.linkBatch('ws', [{ id: 'pub1' }, { id: 'sec1' }]);
    assert.deepEqual(await edgesOf(w.graph), ['pub1-pub2', 'sec1-sec2']);
});

console.log('\ncaller edges and replay');

await test('a caller-supplied edge on the same triple is untouched; the batch still writes the others', async () => {
    const w = await world([{ id: 'a', deg: 0 }, { id: 'b', deg: 5 }, { id: 'c', deg: 8 }]);
    await w.graph.addEdge({ sourceId: 'a', targetId: 'b', relation: REL, confidence: 'extracted', confidenceScore: 1 } as never);
    const r = await w.linker.linkBatch('ws', [{ id: 'a' }]);
    assert.equal(r.keptExisting, 1);
    const kept = await w.graph.getEdge('a', 'b', REL);
    assert.equal(kept?.confidence, 'extracted');
    assert.equal(kept?.confidenceScore, 1);
    assert.equal((await w.graph.getEdge('a', 'c', REL))?.confidence, 'inferred');
});

await test('linking the same node twice (queue replay) writes the same edges', async () => {
    const w = await world([{ id: 'a', deg: 0 }, { id: 'b', deg: 5 }, { id: 'c', deg: 8 }]);
    await w.linker.linkBatch('ws', [{ id: 'a' }]);
    const first = await edgesOf(w.graph);
    await w.linker.linkBatch('ws', [{ id: 'a' }]);
    assert.deepEqual(await edgesOf(w.graph), first);
});

console.log('\nbatching and failure modes');

await test('a batch of arrivals is ONE kNN call and every pair is linked', async () => {
    const w = await world([{ id: 'a', deg: 0 }, { id: 'b', deg: 4 }, { id: 'c', deg: 8 }, { id: 'd', deg: 85 }, { id: 'e', deg: 88 }]);
    const r = await w.linker.linkBatch('ws', ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })));
    assert.equal(w.knnCalls, 1, 'unscoped arrivals share one batched query');
    assert.deepEqual(r.done.sort(), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(await edgesOf(w.graph), ['a-b', 'a-c', 'b-c', 'd-e']);
});

await test('a node that vanished is done (nothing to link); one with no vector yet is retried, not dropped', async () => {
    const w = await world([{ id: 'a', deg: 0 }, { id: 'b', deg: 5 }, { id: 'nov', deg: 0, noVector: true }]);
    const r = await w.linker.linkBatch('ws', [{ id: 'a' }, { id: 'ghost' }, { id: 'nov' }]);
    assert.ok(r.done.includes('ghost') && r.done.includes('a'));
    assert.deepEqual(r.retry, [{ id: 'nov', reason: 'no_vector' }]);
});

await test('a neighbour deleted from the graph (vector still present) is skipped and counted, not an error', async () => {
    const w = await world([{ id: 'a', deg: 0 }, { id: 'b', deg: 5 }, { id: 'c', deg: 8, noNode: true }]);
    const r = await w.linker.linkBatch('ws', [{ id: 'a' }]);
    assert.equal(r.skippedMissingEndpoint, 1);
    assert.deepEqual(await edgesOf(w.graph), ['a-b']);
    assert.deepEqual(r.done, ['a']);
});

await test('an unresolvable workspace retries every item instead of dropping them', async () => {
    const w = await world([{ id: 'a', deg: 0 }]);
    const r = await w.linker.linkBatch('gone', [{ id: 'a' }, { id: 'b' }]);
    assert.deepEqual(r.done, []);
    assert.deepEqual(r.retry.map((x) => x.reason), ['no_handles', 'no_handles']);
});

console.log('\nduplicates and fallback');

await test('a near-duplicate is linked AND reported as a supersession candidate', async () => {
    const w = await world([{ id: 'a', deg: 0 }, { id: 'b', deg: 1 }, { id: 'c', deg: 40 }], { ...POLICY, dupSim: 0.99 });
    const r = await w.linker.linkBatch('ws', [{ id: 'a' }]);
    assert.deepEqual(r.duplicates.map((d) => [d.a, d.b]), [['a', 'b']]);
    assert.deepEqual(await edgesOf(w.graph), ['a-b']);
});

await test('a graph without addInferredEdgesBatch is written edge by edge (documented: cannot protect caller edges)', async () => {
    const w = await world([{ id: 'a', deg: 0 }, { id: 'b', deg: 5 }]);
    const legacy = { addEdge: (e: never) => w.graph.addEdge(e), getNode: (id: string) => w.graph.getNode(id) };
    const linker = new StoredVectorLinker(async () => ({ graph: legacy as never, verbatim: w.handles.verbatim }), POLICY);
    const r = await linker.linkBatch('ws', [{ id: 'a' }]);
    assert.equal(r.edgesWritten, 1);
    assert.deepEqual(await edgesOf(w.graph), ['a-b']);
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
