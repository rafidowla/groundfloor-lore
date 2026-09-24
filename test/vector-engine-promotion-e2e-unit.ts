#!/usr/bin/env tsx
/**
 * vector-engine-promotion-e2e-unit.ts — 3.21 step 2 part 2: the promotion
 * hook wired through the real resolver, and the embedded SQLite-only
 * profile end to end.
 *
 * Covers the design doc's remaining "Selection and default" acceptance
 * points that vector-engine-selection-unit.ts does not:
 *
 *   A. Promotion end-to-end through the REAL `WorkspaceVerbatimResolver`,
 *      threshold set low: writes continue, the resolver serves a
 *      `VerbatimStore` (LanceDB) afterwards with nothing lost, and
 *      `workspaces.json`'s `vectorEngine` is flipped to 'lance'.
 *   B. An end-to-end embedded `createLore()` on a fresh home (which now
 *      defaults to graphEngine:'sqlite' + vectorEngine:'sqlite'): a write
 *      with `questions[]` (3.21 step 3(e)), then keyword recall, semantic
 *      recall, and a hybrid multi-query (`queries[]`, 3.21 step 3(f))
 *      retrieval all succeed against the real SQLite-only stack.
 *   C. The search worker is never spawned for that SQLite-only embedded
 *      instance even with LORE_SEARCH_WORKER=1.
 *   D. A null embedder on a fresh (SQLite-only) workspace: the write still
 *      succeeds, a NULL-vector text-only row is persisted, and it is found
 *      by keyword recall (the unified disabled-embedder contract's
 *      SqliteVerbatimStore half — see providers/nullEmbeddingProvider.ts).
 *
 * Run: npx tsx test/vector-engine-promotion-e2e-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createWorkspace, loadWorkspaces, getActiveWorkspacePath } from '../packages/lore/src/config/workspaces.js';
import { resolveWorkspaceVectorEngine } from '../packages/lore/src/engines/vectorEngineSelector.js';
import { WorkspaceVerbatimResolver } from '../packages/lore/src/outbox/workspaceVerbatimResolver.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

function freshHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vec-e2e-home-'));
}

async function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await cond()) return;
        await sleep(50);
    }
    if (!(await cond())) throw new Error(`waitFor timed out: ${label}`);
}

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'vec-e2e-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(text: string): Promise<number[]> { return this.vec(text); }
    async embedQuery(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocument(text: string): Promise<number[]> { return this.vec(text); }
}

console.log('VECTOR-ENGINE PROMOTION + EMBEDDED E2E — 3.21 step 2 part 2\n');

// ═══════════════════════════════════════════════════════════════════════
// A. Promotion end-to-end through the real resolver, small threshold.
// ═══════════════════════════════════════════════════════════════════════
await test('promotion: real resolver, low threshold — writes continue, resolver swaps to Lance, workspaces.json flips, nothing lost', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('promote-e2e-ws', {}, home);
    assert.equal(entry.vectorEngine, 'sqlite');

    const priorThreshold = process.env['LORE_VECTOR_PROMOTE_ROWS'];
    process.env['LORE_VECTOR_PROMOTE_ROWS'] = '5';
    try {
        const provider = new DetEmbedProvider();
        const resolver = new WorkspaceVerbatimResolver(provider, false, undefined, { home });
        try {
            const store = await resolver.getOrOpen(entry.name);
            assert.ok(store instanceof SqliteVerbatimStore, 'resolver opens SqliteVerbatimStore for a sqlite-vector workspace');

            const docs = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, text: `promotion payload number ${i} about lighthouses` }));
            for (const d of docs) {
                await store.store({ id: d.id, text: d.text, metadata: { type: 'note', label: d.id } });
            }

            // The 6th write (index 5, 0-based) crosses the threshold of 5 and
            // fires the background promotion — poll for the commit rather
            // than assume timing.
            await waitFor(() => resolveWorkspaceVectorEngine(entry.name, home) === 'lance', 20_000, 'workspaces.json vectorEngine flips to lance');

            // The resolver's cached store must have been swapped in place —
            // poll briefly since the swap callback races the vectorEngine
            // flip by a few sync ticks.
            let after: unknown;
            await waitFor(async () => {
                after = await resolver.getOrOpen(entry.name);
                return after instanceof VerbatimStore;
            }, 5_000, 'resolver.getOrOpen() now returns a VerbatimStore (Lance)');
            assert.ok(after instanceof VerbatimStore, 'resolver serves LanceDB after promotion');

            // Nothing lost: every doc written before AND during promotion is
            // still findable by its own text through the NEW store.
            const finalStore = after as VerbatimStore;
            for (const d of docs) {
                const hits = await finalStore.search(d.text, 5);
                assert.ok(hits.some((h) => h.id === d.id), `doc ${d.id} survived promotion (hits: ${hits.map((h) => h.id).join(',')})`);
            }

            // The old verbatim.sqlite is kept aside as the rollback, not deleted.
            const loreDir = path.join(entry.path, '.lore');
            const remaining = fs.readdirSync(loreDir);
            assert.ok(remaining.some((f) => f.startsWith('verbatim.sqlite.promoted-')), `old verbatim.sqlite kept as rollback (found: ${remaining.join(', ')})`);
            assert.ok(!remaining.includes('verbatim.sqlite'), 'the live verbatim.sqlite path is gone (renamed aside)');

            // A write AFTER promotion goes to the new Lance store transparently.
            await finalStore.store({ id: 'after-promotion', text: 'written after the swap', metadata: {} });
            const postHits = await finalStore.search('written after the swap', 5);
            assert.ok(postHits.some((h) => h.id === 'after-promotion'));
        } finally {
            await resolver.closeAll();
        }
    } finally {
        if (priorThreshold === undefined) delete process.env['LORE_VECTOR_PROMOTE_ROWS'];
        else process.env['LORE_VECTOR_PROMOTE_ROWS'] = priorThreshold;
    }
});

// ═══════════════════════════════════════════════════════════════════════
// B + C. Embedded createLore() on a fresh home — SQLite-only profile.
// ═══════════════════════════════════════════════════════════════════════
const { createLore } = await import('../packages/lore/src/index.js');
const { retrieve } = await import('../packages/lore/src/recall/retrieve.js');

await test('embedded createLore() on a fresh home defaults to the SQLite-only profile (graphEngine + vectorEngine both sqlite)', async () => {
    const dataDir = freshHome();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider() });
    try {
        assert.ok(getActiveWorkspacePath(dataDir), 'active workspace path resolves');
        const file = loadWorkspaces(dataDir);
        const active = file.workspaces.find((w) => w.name === file.active);
        assert.equal(active?.graphEngine, 'sqlite', 'fresh embedded home defaults to sqlite graph');
        assert.equal(active?.vectorEngine, 'sqlite', 'fresh embedded home defaults to sqlite vectors');
    } finally {
        await lore.dispose();
    }
});

await test('embedded e2e (SQLite-only profile): write with questions[] -> keyword recall, semantic recall, and hybrid multi-query (queries[]) all work; search worker never spawned even with LORE_SEARCH_WORKER=1', async () => {
    const priorWorker = process.env['LORE_SEARCH_WORKER'];
    process.env['LORE_SEARCH_WORKER'] = '1'; // (C) — must be ignored for a sqlite-vector workspace
    const dataDir = freshHome();
    let lore: Awaited<ReturnType<typeof createLore>> | undefined;
    try {
        lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider() });

        const NODE_ID = 'vec-e2e-questions-node';
        const NODE_CONTENT = 'a lighthouse keeper records the tide tables every morning';
        const Q1 = 'when does the tide table get written';
        const Q2 = 'who keeps the lighthouse log';

        const result = await lore.nodeUpsert({
            id: NODE_ID, workspace: 'default', ecosystem: '*',
            nodeData: { type: 'note', label: 'lighthouse log', content: NODE_CONTENT },
            // questions[] (3.21 step 3(e)) is not on the typed embedded
            // wrapper's arg shape yet, but nodeUpsert() spreads args straight
            // into the core nodeServiceUpsert() call (mcp/server.ts), which
            // DOES declare it (core/nodeService.ts) — this exercises the
            // real alias-write path, not a re-implementation of it.
            questions: [Q1, Q2],
        } as Parameters<NonNullable<typeof lore>['nodeUpsert']>[0] & { questions: string[] });
        assert.ok(result.ok, `nodeUpsert with questions[] ok (got ${JSON.stringify(result)})`);

        // The alias rows are written via durable outbox rows, replayed by
        // the embedded instance's own started replicator (same mechanism
        // embeddable-capstone-e2e.ts's §2 depends on) — poll depth to 0
        // instead of assuming timing.
        const outboxStore = lore._daemon.outboxWiring.store;
        await waitFor(async () => (await outboxStore.aggregateStats!()).depth === 0, 15_000, 'outbox drains (question aliases replicated)');

        // Keyword recall finds the node via its own content.
        const kwResult = await lore.recall('tide tables', { workspace: 'default', mode: 'full', searchMode: 'keyword' });
        assert.ok(kwResult.totalRecalled >= 1, 'keyword recall finds the node');

        // Semantic recall finds it via the vector written against the SAME
        // text (DetEmbedProvider is deterministic, so a close paraphrase of
        // the content still cosine-matches).
        const semResult = await lore.recall(NODE_CONTENT, { workspace: 'default', mode: 'full', searchMode: 'semantic' });
        assert.ok(semResult.totalRecalled >= 1, `semantic recall finds the node (meta=${JSON.stringify(semResult._meta)})`);

        // Hybrid multi-query (queries[], 3.21 step 3(f)) via the shared
        // retrieve() core against the REAL wired stack (lore.store +
        // the real graph registry + the real workspaceVerbatimResolver —
        // no mocks), exactly as inProcessRecall() itself builds its ctx.
        const daemon = lore._daemon as unknown as {
            getGraphRegistry(): unknown;
            getVerbatimResolver(): unknown;
        };
        const ctx = {
            store: lore.store,
            graphRegistry: daemon.getGraphRegistry(),
            workspaceVerbatimResolver: daemon.getVerbatimResolver(),
        } as Parameters<typeof retrieve>[0];
        const hybrid = await retrieve(ctx, Q1, {
            workspace: 'default', mode: 'hybrid', depth: 0, limit: 10,
            queries: [Q2, 'an unrelated third phrasing about lighthouses'],
        });
        assert.ok(
            hybrid.results.some((r) => r.node.id === NODE_ID),
            `hybrid multi-query retrieve() finds the node (results: ${hybrid.results.map((r) => r.node.id).join(',')})`,
        );

        // (C) — the search worker must never have been spawned for this
        // sqlite-vector workspace, despite LORE_SEARCH_WORKER=1. The proxy
        // class extends VerbatimStore, so `instanceof SqliteVerbatimStore`
        // being what actually served every call above is the falsifiable
        // proof (a spawned worker would mean this store is a
        // VerbatimSearchWorkerProxy pointed at a child process instead).
        const resolver = daemon.getVerbatimResolver() as { getOrOpen(ws: string): Promise<unknown> } | undefined;
        assert.ok(resolver, 'embedded instance wires a workspaceVerbatimResolver');
        const activeStore = await resolver!.getOrOpen('default');
        assert.ok(activeStore instanceof SqliteVerbatimStore, `active workspace store is a real in-process SqliteVerbatimStore, not a search-worker proxy (got ${(activeStore as object).constructor.name})`);
    } finally {
        if (priorWorker === undefined) delete process.env['LORE_SEARCH_WORKER'];
        else process.env['LORE_SEARCH_WORKER'] = priorWorker;
        await lore?.dispose();
    }
});

// ═══════════════════════════════════════════════════════════════════════
// D. Null embedder on a SQLite-only workspace.
// ═══════════════════════════════════════════════════════════════════════
await test('null embedder on a fresh (SQLite-only) workspace: write succeeds, NULL-vector text-only row persisted, found by keyword recall', async () => {
    const { NullEmbeddingProvider } = await import('../packages/lore/src/providers/nullEmbeddingProvider.js');
    const dataDir = freshHome();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        const file = loadWorkspaces(dataDir);
        const active = file.workspaces.find((w) => w.name === file.active);
        assert.equal(active?.vectorEngine, 'sqlite', 'still the sqlite-only profile');

        const NODE_ID = 'null-embed-sqlite-node';
        const result = await lore.nodeUpsert({
            id: NODE_ID, workspace: 'default', ecosystem: '*',
            nodeData: { type: 'note', label: 'null embed sqlite', content: 'zzyzxnullsqlite marker phrase' },
        });
        assert.ok(result.ok, `write succeeds with embeddings disabled (got ${JSON.stringify(result)})`);

        // Graph keyword search finds it (item 3.21-a's leg — unaffected by
        // embeddings being off either way).
        const hits = await lore.search('zzyzxnullsqlite', 10, 'default');
        assert.ok(hits.some((h) => h.id === NODE_ID), 'graph keyword search finds the node');

        // The verbatim row itself lands via the outbox replicator (same as
        // the questions[] test above) — wait for it to drain before
        // checking the verbatim store directly.
        const outboxStore = lore._daemon.outboxWiring.store;
        await waitFor(async () => (await outboxStore.aggregateStats!()).depth === 0, 15_000, 'outbox drains (verbatim row replicated)');

        // The unified contract's OTHER half: SqliteVerbatimStore stores a
        // NULL-vector, FTS-searchable text row (unlike VerbatimStore/Lance,
        // which skips the row's vector write and never calls the disabled
        // provider) — verified directly against the real verbatim.sqlite
        // this embedded instance wrote to, through the SAME live resolver
        // (a second independent connection would race the still-open
        // instance's WAL). `lore:`-prefixed because the replicator's
        // verbatim.upsert payload id is the graph node id namespaced —
        // matching every other verbatim-row-id assertion in this suite.
        const resolver = lore._daemon.getVerbatimResolver() as { getOrOpen(ws: string): Promise<{ bm25Search(q: string, limit: number): Promise<{ hits: Array<{ id: string }> }> }> };
        const verbatim = await resolver.getOrOpen('default');
        const bm25 = await verbatim.bm25Search('zzyzxnullsqlite', 5);
        assert.ok(bm25.hits.some((h) => h.id === NODE_ID || h.id === `lore:${NODE_ID}`), `bm25 (FTS) finds the null-vector text row (hits: ${bm25.hits.map((h) => h.id).join(',')})`);
    } finally {
        await lore.dispose();
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
