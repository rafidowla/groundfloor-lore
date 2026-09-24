#!/usr/bin/env tsx
/**
 * test/rc321h2-bulkingest-questions-unit.ts — Lore 3.21 step 3(h) round 2
 * (Opus review): `runBulkIngest()` (the library-level bulk path the
 * accuracy benchmark uses to load 415 memories) accepts the same top-level
 * `questions[]`/`summary`/`entities`/`topics` fields `nodeUpsert()` does on
 * the single-write path, with IDENTICAL alias semantics and durability —
 * `runBulkIngest()` calls `nodeServiceUpsert()` once per node (Step 0), so
 * declaring the fields on `BulkIngestNodeArgs` is enough; no separate bulk
 * alias pipeline exists here (contrast with POST /api/nodes/bulk, covered
 * by rc321h2-bulk-questions-unit.ts, which DOES need one — see
 * core/bulkQuestionAliases.ts's doc comment for why).
 *
 * Real stack (SurrealGraph + VerbatimStore + FileOutboxStore + dispatch),
 * mirroring rc321e-question-aliases-unit.ts's A3 case.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { runBulkIngest, type BulkIngestDeps } from '../packages/lore/src/mcp/bulkIngest.js';
import { dispatch, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import { defaultAutolinkTracker } from '../packages/lore/src/engines/pendingAutolink.js';
import { aliasRowId } from '../packages/lore/src/core/questionAliases.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WORKSPACE = 'w';

function mkTmp(prefix: string): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'rc321h2-const'; }
    get dimension() { return 8; }
    async initialize() { /* no-op */ }
    private vec() { return new Array(8).fill(0.1); }
    async embed() { return this.vec(); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}

function realDispatchSubstrates(graph: SurrealGraph, store: VerbatimStore): DispatcherSubstrates {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-rc321h2-wiring-'));
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

function makeDeps(graph: SurrealGraph, verbatim: VerbatimStore, outboxStore: FileOutboxStore): BulkIngestDeps {
    const noop = () => undefined;
    const stub = new Proxy({}, { get: () => noop }) as never;
    return {
        graph: graph as never,
        graphRegistry: null,
        activeWorkspaceName: () => '__not_active__',
        outboxStore: outboxStore as never,
        embedQueue: { enqueue: noop } as never,
        verbatimStore: verbatim as never,
        storageClient: stub,
        loreVerbatim: verbatim as never,
        embeddingProvider: new ConstEmbedProvider(),
        getWal: () => stub,
        versionStore: undefined,
        autolinkTracker: defaultAutolinkTracker,
    };
}

function nodeArgs(id: string, content: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        workspace: WORKSPACE,
        ecosystem: '*',
        skipEmbed: true, // isolate the graph-write alias fan-out from the embed pipeline
        nodeData: {
            id, type: 'note', label: id, content, tags: [], project: WORKSPACE, ecosystem: '*', metadata: '{}',
        },
        ...extra,
    };
}

console.log('\n3.21 step 3(h) round 2 — runBulkIngest() questions[] alias support\n');

await test('runBulkIngest: a node with questions[] produces durable alias outbox rows, alias rows exist after replay', async () => {
    const g = mkTmp('lore-rc321h2-bi-g-');
    const v = mkTmp('lore-rc321h2-bi-v-');
    const o = mkTmp('lore-rc321h2-bi-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    try {
        const deps = makeDeps(graph, store, outboxStore);
        const id = 'bi-n1';
        const q1 = 'how does authentication work here';
        const res = await runBulkIngest(
            [nodeArgs(id, 'unrelated content words entirely', { questions: [q1] })],
            { autolink: false },
            deps,
        );
        assert.equal(res.succeeded, 1, JSON.stringify(res.results));

        const rows = await outboxStore.listPendingForWorkspace(WORKSPACE, 1000);
        assert.ok(rows.some((r) => r.operationKind === 'verbatim.upsert' && (r.payload as { id?: string })?.id === aliasRowId(id, 0)));

        await replayAll(outboxStore, graph, store);
        const alias0 = await store.getById(aliasRowId(id, 0));
        assert.equal(alias0?.text, q1, 'alias row text is the question, verbatim, via the SAME write path as the single-write surfaces');
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

await test('runBulkIngest: a node WITHOUT questions[] produces no alias rows (parity with today)', async () => {
    const g = mkTmp('lore-rc321h2-bi-g-');
    const v = mkTmp('lore-rc321h2-bi-v-');
    const o = mkTmp('lore-rc321h2-bi-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    try {
        const deps = makeDeps(graph, store, outboxStore);
        const res = await runBulkIngest([nodeArgs('bi-n2', 'plain content')], { autolink: false }, deps);
        assert.equal(res.succeeded, 1);
        const rows = await outboxStore.listPendingForWorkspace(WORKSPACE, 1000);
        assert.ok(!rows.some((r) => r.operationKind === 'verbatim.upsert' && String((r.payload as { id?: string })?.id ?? '').includes('#q')));
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

await test('runBulkIngest: over-cap questions[] fails that item with invalid_questions_meta, does not abort the batch', async () => {
    const g = mkTmp('lore-rc321h2-bi-g-');
    const v = mkTmp('lore-rc321h2-bi-v-');
    const o = mkTmp('lore-rc321h2-bi-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    try {
        const deps = makeDeps(graph, store, outboxStore);
        const res = await runBulkIngest(
            [
                nodeArgs('bi-bad', 'c', { questions: Array(6).fill('q') }),
                nodeArgs('bi-good', 'c', { questions: ['fine'] }),
            ],
            { autolink: false },
            deps,
        );
        assert.equal(res.succeeded, 1, JSON.stringify(res.results));
        const bad = res.results.find((r) => r.id === 'bi-bad')!;
        assert.equal(bad.ok, false);
        // nodeService.ts's failure surfaces as {code:'invalid_questions_meta',
        // error: new Error(metaCheck.error)} — bulkIngest.ts's error mapping
        // (`res.error?.message ?? res.code`) prefers the human-readable
        // message over the bare code, so assert on ITS content instead.
        assert.ok(!bad.ok && bad.error.includes('exceeds the limit'), !bad.ok ? bad.error : '');
        const good = res.results.find((r) => r.id === 'bi-good')!;
        assert.equal(good.ok, true);
        assert.equal(await graph.getNode('bi-bad'), null, 'the rejected item must not have been written');
        assert.ok(await graph.getNode('bi-good'));
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
