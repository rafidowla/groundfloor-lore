#!/usr/bin/env tsx
/**
 * test/rc321e-question-aliases-unit.ts — Lore 3.21 step 3(e): questions[] /
 * summary / entities / topics.
 *
 * Two halves:
 *   A. WRITE side, real stack (SurrealGraph + VerbatimStore + FileOutboxStore
 *      + the real nodeUpsert()/dispatch()/wireOutbox() — same shape as
 *      test/rc321d-embed-failure-keeps-node-unit.ts): a write with
 *      `questions` records durable alias outbox rows; after replay the alias
 *      rows physically exist in the verbatim store; a REWRITE replaces them
 *      (old slots tombstoned); a DELETE tombstones them too; limits are
 *      enforced before any write.
 *   B. READ side, mock retrieve() context (fast, deterministic — mirrors
 *      test/rc321a-keyword-bm25-unit.ts's pattern): an alias hit maps back
 *      to its parent id, is never itself a result, and a parent hit via
 *      multiple aliases in one list collapses to its best rank before fusion.
 *
 * Run: npx tsx test/rc321e-question-aliases-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { dispatch, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { aliasRowId, MAX_QUESTIONS, validateQuestionsMeta, mapAliasHitsToParent } from '../packages/lore/src/core/questionAliases.js';
import { retrieve, type RetrieveContext } from '../packages/lore/src/recall/retrieve.js';

class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'rc321e-const'; }
    get dimension() { return 8; }
    async initialize() { /* no-op */ }
    private vec() { return new Array(8).fill(0.1); }
    async embed() { return this.vec(); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}

function mkTmp(prefix: string): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

const WORKSPACE = 'w';

function realDispatchSubstrates(graph: SurrealGraph, store: VerbatimStore): DispatcherSubstrates {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-rc321e-wiring-'));
    const wiring = wireOutbox({
        loreDir: tmp,
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => graph as never,
        getVerbatim: () => store,
    });
    return (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
}

async function replayAll(outboxStore: FileOutboxStore, graph: SurrealGraph, store: VerbatimStore): Promise<void> {
    const substrates = realDispatchSubstrates(graph, store);
    const rows = await outboxStore.listPendingForWorkspace(WORKSPACE, 1000);
    for (const entry of rows) await dispatch(entry, substrates);
}

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

console.log('\n3.21 step 3(e) — questions[] / summary / entities / topics\n');

/* ─── A. write side (real stack) ──────────────────────────────────────── */

test('A1: validateQuestionsMeta enforces every cap BEFORE any write', async () => {
    assert.equal(validateQuestionsMeta({ questions: Array(MAX_QUESTIONS + 1).fill('q') }).ok, false);
    assert.equal(validateQuestionsMeta({ questions: ['x'.repeat(301)] }).ok, false);
    assert.equal(validateQuestionsMeta({ summary: 'x'.repeat(501) }).ok, false);
    assert.equal(validateQuestionsMeta({ entities: Array(21).fill('e') }).ok, false);
    assert.equal(validateQuestionsMeta({ topics: ['x'.repeat(101)] }).ok, false);
    assert.equal(validateQuestionsMeta({}).ok, true, 'no fields → ok (today\'s behaviour)');
    assert.equal(validateQuestionsMeta({ questions: ['a valid question?'] }).ok, true);
});

test('A2: nodeUpsert rejects an over-cap questions[] with invalid_questions_meta, BEFORE any write', async () => {
    const g = mkTmp('lore-rc321e-a2-g-');
    const graph = new SurrealGraph(g.dir);
    await graph.initialize();
    try {
        const result = await nodeUpsert({
            id: 'rc321e-a2', workspace: WORKSPACE, ecosystem: '*', initiator: 'test',
            nodeData: { id: 'rc321e-a2', type: 'note', label: 'l', content: 'c' },
            targetGraph: graph,
            questions: Array(MAX_QUESTIONS + 1).fill('too many'),
        });
        assert.equal(result.ok, false);
        assert.equal(result.ok === false ? result.code : undefined, 'invalid_questions_meta');
        const node = await graph.getNode('rc321e-a2');
        assert.equal(node, null, 'the graph node must NOT have been created');
    } finally {
        await graph.close().catch(() => undefined);
        g.cleanup();
    }
});

test('A3: write with questions[] → durable alias outbox rows → after replay, alias rows exist and are never returned as results themselves; a rewrite REPLACES them; delete tombstones them', async () => {
    const g = mkTmp('lore-rc321e-a3-g-');
    const v = mkTmp('lore-rc321e-a3-v-');
    const o = mkTmp('lore-rc321e-a3-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    try {
        const id = 'rc321e-a3';
        const q1 = 'what does this do exactly';
        const q2 = 'how is this configured';
        const w1 = await nodeUpsert({
            id, workspace: WORKSPACE, ecosystem: '*', initiator: 'test',
            nodeData: { id, type: 'note', label: 'l', content: 'zzyzxa3 unrelated content words', security_scopes: [] as string[] },
            targetGraph: graph,
            questions: [q1, q2],
        }, { outboxStore });
        assert.equal(w1.ok, true);

        // Outbox durably holds a tombstone (slot sweep) + upsert per question.
        const rows1 = await outboxStore.listPendingForWorkspace(WORKSPACE, 1000);
        assert.ok(rows1.some((r) => r.operationKind === 'verbatim.upsert' && (r.payload as { id?: string })?.id === aliasRowId(id, 0)));
        assert.ok(rows1.some((r) => r.operationKind === 'verbatim.upsert' && (r.payload as { id?: string })?.id === aliasRowId(id, 1)));

        await replayAll(outboxStore, graph, store);

        const alias0 = await store.getById(aliasRowId(id, 0));
        const alias1 = await store.getById(aliasRowId(id, 1));
        assert.equal(alias0?.text, q1, 'alias 0 text is the question, verbatim');
        assert.equal(alias1?.text, q2);
        const alias2Absent = await store.getById(aliasRowId(id, 2));
        assert.equal(alias2Absent, null, 'no alias beyond the supplied questions');

        // bm25Search on the alias TEXT finds the row (structural proof the
        // alias is indexed — both vector- and keyword-searchable).
        const bm25 = await store.bm25Search('configured', 10);
        assert.ok(bm25.hits.some((h) => h.id === aliasRowId(id, 1)), 'alias row is BM25-searchable on its own question text');

        // Rewrite with FEWER questions (one instead of two) replaces the set.
        const q3 = 'a brand new single phrasing';
        const w2 = await nodeUpsert({
            id, workspace: WORKSPACE, ecosystem: '*', initiator: 'test',
            nodeData: { id, type: 'note', label: 'l', content: 'zzyzxa3 unrelated content words', security_scopes: [] as string[] },
            targetGraph: graph,
            questions: [q3],
        }, { outboxStore });
        assert.equal(w2.ok, true);
        await replayAll(outboxStore, graph, store);

        const alias0After = await store.getById(aliasRowId(id, 0));
        const alias1After = await store.getById(aliasRowId(id, 1));
        assert.equal(alias0After?.text, q3, 'slot 0 now carries the new (only) question');
        assert.ok(!alias1After || (alias1After.text ?? '').startsWith('[TOMBSTONED'), 'the SECOND question from the old set must be gone (tombstoned)');

        // Delete tombstones the remaining alias.
        await graph.deleteNode(id);
        const { tombstoneQuestionAliases } = await import('../packages/lore/src/core/nodeServiceVerbatim.js');
        await tombstoneQuestionAliases({ id, workspace: WORKSPACE, initiator: 'test', logPrefix: '[test]', outboxStore });
        await replayAll(outboxStore, graph, store);
        const alias0Deleted = await store.getById(aliasRowId(id, 0));
        assert.ok(!alias0Deleted || (alias0Deleted.text ?? '').startsWith('[TOMBSTONED'), 'delete must tombstone the remaining alias');
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

test('A4: restart before replay → aliases still replay (fresh FileOutboxStore instance, same on-disk file)', async () => {
    const g = mkTmp('lore-rc321e-a4-g-');
    const v = mkTmp('lore-rc321e-a4-v-');
    const o = mkTmp('lore-rc321e-a4-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    await graph.initialize();
    await store.initialize();
    try {
        const id = 'rc321e-a4';
        const liveOutbox = new FileOutboxStore(o.dir);
        const w = await nodeUpsert({
            id, workspace: WORKSPACE, ecosystem: '*', initiator: 'test',
            nodeData: { id, type: 'note', label: 'l', content: 'content', security_scopes: [] as string[] },
            targetGraph: graph,
            questions: ['a restart-surviving question'],
        }, { outboxStore: liveOutbox });
        assert.equal(w.ok, true);

        const restartedOutbox = new FileOutboxStore(o.dir);
        await replayAll(restartedOutbox, graph, store);
        const alias0 = await store.getById(aliasRowId(id, 0));
        assert.equal(alias0?.text, 'a restart-surviving question');
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

test('A5: with a null embedder, alias rows follow the same rule as the main row (no vector write attempted, never errors)', async () => {
    const g = mkTmp('lore-rc321e-a5-g-');
    const v = mkTmp('lore-rc321e-a5-v-');
    const o = mkTmp('lore-rc321e-a5-o-');
    const { NullEmbeddingProvider } = await import('../packages/lore/src/providers/nullEmbeddingProvider.js');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new NullEmbeddingProvider() as unknown as EmbeddingProvider);
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    try {
        const id = 'rc321e-a5';
        const w = await nodeUpsert({
            id, workspace: WORKSPACE, ecosystem: '*', initiator: 'test',
            nodeData: { id, type: 'note', label: 'l', content: 'content', security_scopes: [] as string[] },
            targetGraph: graph,
            questions: ['a question under a null embedder'],
        }, { outboxStore });
        assert.equal(w.ok, true);
        await replayAll(outboxStore, graph, store); // must not throw
        const alias0 = await store.getById(aliasRowId(id, 0));
        assert.equal(alias0, null, 'no vector write attempted — the alias row itself is never written under a null embedder');
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

/* ─── B. read side (mock retrieve() context) ─────────────────────────── */

type Node = { id: string; type: string; label: string; content: string; tags: string[]; project: string; ecosystem: string; updatedAt: string };
const node = (id: string): Node => ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'w', ecosystem: '*', updatedAt: '2026-06-01T00:00:00.000Z' });

test('B1: mapAliasHitsToParent — alias hits map to parent, never appear as their own id, best rank per list survives', async () => {
    const hits = [
        { id: 'lore:parent-a#q0', score: 0.9 },
        { id: 'lore:solo', score: 0.85 },
        { id: 'lore:parent-a#q1', score: 0.5 }, // same parent, worse rank — collapses away
    ];
    const mapped = mapAliasHitsToParent(hits);
    assert.deepEqual(mapped.map((h) => h.id), ['lore:parent-a', 'lore:solo']);
    assert.equal(mapped[0]!.score, 0.9, 'kept the BEST-ranked occurrence for parent-a');
    assert.ok(!mapped.some((h) => h.id.includes('#q')), 'no alias id ever survives mapping');
});

test('B2: retrieve() end-to-end — a query matching only the ALIAS text (not the content) finds the parent node, never the alias', async () => {
    const NODES: Record<string, Node> = { 'target-node': node('target-node') };
    const graph = {
        async search() { return []; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, Node>();
            for (const id of ids) { const n = NODES[id]; if (n) m.set(id, n); }
            return m as never;
        },
        async traverse() { return []; },
    };
    const ctx = {
        store: {
            loreGraph: graph,
            sessionCache: { pushNode() {} },
            storageClient: {
                async verbatimCount() { return 1; },
                async verbatimSearch() { return []; },
                async verbatimBm25Search() {
                    // The alias row is the ONLY hit — its text shares no
                    // words with the node's content, but the alias itself
                    // (a question) is what matched lexically.
                    return { hits: [{ id: 'lore:target-node#q0', score: 5 }], ranked: true };
                },
            },
        },
    } as unknown as RetrieveContext;
    const out = await retrieve(ctx, 'phrased like the alias question', { workspace: 'w', mode: 'keyword', depth: 0 });
    assert.deepEqual(out.results.map((r) => r.node.id), ['target-node'], 'the PARENT is returned, never the alias id');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
