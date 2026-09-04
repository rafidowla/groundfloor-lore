#!/usr/bin/env tsx
/**
 * sync-embedding-unit.ts — asserts that SyncEngine.pullRemote() mirrors
 * every node written to the local graph into the vector store, so cloud-
 * synced knowledge is queryable via semantic search locally.
 *
 * Audit 2026-05-13: prior to the fix, pullRemote() wrote pulled nodes to
 * the legacy graph engine only — the matching vector upsert was missing. This regression
 * test pins both the conflict-resolved (remote-newer) path and the
 * net-new-insert path.
 *
 * The test uses in-memory fakes for graph, vector store, and adapter so
 * it runs without any graph-engine binary or LanceDB on disk.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncEngine, type SyncAdapter } from '../packages/lore/src/engines/syncEngine.js';
import type { LoreGraphHandle } from '../packages/lore/src/storage/loreStorageClient.js';
import type { LoreNode, LoreEdge } from '../packages/lore/src/providers/types.js';

type RemoteSnapshot = { nodes: LoreNode[]; edges: LoreEdge[] };
import type { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sync-embed-'));
}
function cleanup(d: string): void {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ }
}

// ── Fakes ──────────────────────────────────────────────────────────────

class FakeGraph {
    private nodes = new Map<string, LoreNode>();
    seed(n: LoreNode): void { this.nodes.set(n.id, n); }
    async getNode(id: string): Promise<LoreNode | null> { return this.nodes.get(id) ?? null; }
    async upsertNode(n: LoreNode): Promise<LoreNode> {
        this.nodes.set(n.id, n);
        return n;
    }
    async addEdge(): Promise<void> { /* no-op */ }
    async markSynced(): Promise<void> { /* no-op */ }
}

interface StoreCall {
    id: string;
    text: string;
    metadata: Record<string, unknown>;
}

class FakeVectorStore {
    public calls: StoreCall[] = [];
    async store(doc: { id: string; text: string; metadata?: Record<string, unknown> }): Promise<void> {
        this.calls.push({ id: doc.id, text: doc.text, metadata: doc.metadata ?? {} });
    }
}

class FakeAdapter implements SyncAdapter {
    constructor(private snapshot: RemoteSnapshot) {}
    async isConnected(): Promise<boolean> { return true; }
    async connect(): Promise<void> { /* no-op */ }
    async push(): Promise<void> { /* no-op */ }
    async pull(): Promise<RemoteSnapshot> { return this.snapshot; }
}

function makeNode(id: string, updatedAt: string, label = id, content = `body of ${id}`): LoreNode {
    return {
        id, type: 'note', label, content, tags: 'sync,test',
        project: 'test-project', ecosystem: 'test',
        createdAt: updatedAt, updatedAt,
        metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
    } as unknown as LoreNode;
}

// ── Tests ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async (): Promise<void> => {
    console.log('SyncEngine.pullRemote() vector mirror');

    await test('net-new pulled node is mirrored into the vector store', async () => {
        const tmp = mkTmp();
        try {
            const graph = new FakeGraph();
            const vectorStore = new FakeVectorStore();
            const remote: RemoteSnapshot = {
                nodes: [makeNode('node-new-1', '2026-05-13T00:00:00Z', 'New Decision', 'Content of new decision')],
                edges: [],
            };
            const engine = new SyncEngine(
                graph as unknown as LoreGraphHandle,
                tmp,
                new FakeAdapter(remote),
                vectorStore as unknown as VerbatimStore,
            );
            const result = await engine.pullRemote();
            assert.equal(result.nodesPulled, 1, 'expected 1 node pulled');
            assert.equal(result.conflicts, 0, 'no conflicts expected');
            assert.equal(vectorStore.calls.length, 1, 'vector store should have 1 call');
            assert.equal(vectorStore.calls[0]!.id, 'lore:node-new-1');
            assert.match(vectorStore.calls[0]!.text, /New Decision|Content of new decision/);
        } finally { cleanup(tmp); }
    });

    await test('conflict-resolved (remote newer) node is mirrored into the vector store', async () => {
        const tmp = mkTmp();
        try {
            const graph = new FakeGraph();
            graph.seed(makeNode('node-conflict-1', '2026-05-10T00:00:00Z', 'Old version'));
            const vectorStore = new FakeVectorStore();
            const remote: RemoteSnapshot = {
                nodes: [makeNode('node-conflict-1', '2026-05-13T00:00:00Z', 'New version', 'fresher content')],
                edges: [],
            };
            const engine = new SyncEngine(
                graph as unknown as LoreGraphHandle,
                tmp,
                new FakeAdapter(remote),
                vectorStore as unknown as VerbatimStore,
            );
            const result = await engine.pullRemote();
            assert.equal(result.nodesPulled, 1);
            assert.equal(result.conflicts, 1, 'should count as a conflict (both existed)');
            assert.equal(vectorStore.calls.length, 1);
            assert.match(vectorStore.calls[0]!.text, /New version|fresher content/);
        } finally { cleanup(tmp); }
    });

    await test('locally-newer node is NOT pushed to vector store (local wins)', async () => {
        const tmp = mkTmp();
        try {
            const graph = new FakeGraph();
            graph.seed(makeNode('node-local-newer', '2026-05-13T12:00:00Z', 'Local fresh'));
            const vectorStore = new FakeVectorStore();
            const remote: RemoteSnapshot = {
                nodes: [makeNode('node-local-newer', '2026-05-13T00:00:00Z', 'Stale remote')],
                edges: [],
            };
            const engine = new SyncEngine(
                graph as unknown as LoreGraphHandle,
                tmp,
                new FakeAdapter(remote),
                vectorStore as unknown as VerbatimStore,
            );
            const result = await engine.pullRemote();
            assert.equal(result.nodesPulled, 0, 'local should win — nothing pulled');
            assert.equal(vectorStore.calls.length, 0, 'no vector write when local is newer');
        } finally { cleanup(tmp); }
    });

    await test('vector store failure does NOT fail the pull (graph remains source of truth)', async () => {
        const tmp = mkTmp();
        try {
            const graph = new FakeGraph();
            const failingStore = {
                async store(): Promise<void> { throw new Error('simulated LanceDB OOM'); },
            };
            const remote: RemoteSnapshot = {
                nodes: [makeNode('node-fail-1', '2026-05-13T00:00:00Z')],
                edges: [],
            };
            const engine = new SyncEngine(
                graph as unknown as LoreGraphHandle,
                tmp,
                new FakeAdapter(remote),
                failingStore as unknown as VerbatimStore,
            );
            const result = await engine.pullRemote();
            assert.equal(result.nodesPulled, 1, 'pull should still count the node as pulled');
            const localCopy = await graph.getNode('node-fail-1');
            assert.ok(localCopy, 'graph should still have the node');
        } finally { cleanup(tmp); }
    });

    await test('batched pull (architecture #3): 250 nodes processed correctly across multiple chunks', async () => {
        const tmp = mkTmp();
        try {
            const graph = new FakeGraph();
            const vectorStore = new FakeVectorStore();
            const nodes = Array.from({ length: 250 }, (_, i) =>
                makeNode(`bulk-${i}`, '2026-05-13T00:00:00Z', `Node ${i}`, `Content ${i}`));
            const engine = new SyncEngine(
                graph as unknown as LoreGraphHandle,
                tmp,
                new FakeAdapter({ nodes, edges: [] }),
                vectorStore as unknown as VerbatimStore,
            );
            const result = await engine.pullRemote();
            assert.equal(result.nodesPulled, 250, 'all 250 nodes pulled');
            assert.equal(vectorStore.calls.length, 250, 'every node mirrored to vector store');
            // Sanity: ids span the full range (proves no chunk was dropped).
            const seen = new Set(vectorStore.calls.map(c => c.id));
            assert.ok(seen.has('lore:bulk-0'), 'first node mirrored');
            assert.ok(seen.has('lore:bulk-249'), 'last node mirrored');
            assert.equal(seen.size, 250, 'all distinct');
        } finally { cleanup(tmp); }
    });

    await test('outbox-integrated pull (gap #1): per-chunk entry recorded + removed on success', async () => {
        const tmp = mkTmp();
        try {
            const { FileOutboxStore } = await import('../packages/lore/src/outbox/store.js');
            const graph = new FakeGraph();
            const vectorStore = new FakeVectorStore();
            const outbox = new FileOutboxStore(tmp);
            const nodes = Array.from({ length: 3 }, (_, i) =>
                makeNode(`ob-${i}`, '2026-05-13T00:00:00Z', `N${i}`, `C${i}`));
            const engine = new SyncEngine(
                graph as unknown as LoreGraphHandle,
                tmp,
                new FakeAdapter({ nodes, edges: [] }),
                vectorStore as unknown as VerbatimStore,
                outbox,
            );
            await engine.pullRemote();
            assert.equal(vectorStore.calls.length, 3, 'all nodes mirrored');
            // On success the entry is removed (default removeOnComplete=true).
            const stillPending = await outbox.listUnfinished();
            assert.equal(stillPending.length, 0, 'outbox is clean after a successful pull');
        } finally { cleanup(tmp); }
    });

    await test('recoverVectorMirror re-mirrors orphan node ids', async () => {
        const tmp = mkTmp();
        try {
            const graph = new FakeGraph();
            graph.seed(makeNode('orphan-1', '2026-05-14T00:00:00Z'));
            graph.seed(makeNode('orphan-2', '2026-05-14T00:00:00Z'));
            const vectorStore = new FakeVectorStore();
            const engine = new SyncEngine(
                graph as unknown as LoreGraphHandle,
                tmp,
                null, // no adapter — recovery path doesn't need one
                vectorStore as unknown as VerbatimStore,
            );
            const result = await engine.recoverVectorMirror(['orphan-1', 'orphan-2', 'ghost']);
            assert.equal(result.recovered, 2);
            assert.equal(result.skipped, 1, 'ghost is absent from graph; skipped');
            assert.equal(vectorStore.calls.length, 2);
        } finally { cleanup(tmp); }
    });

    await test('engine with no vector store at all does not crash on pullRemote', async () => {
        const tmp = mkTmp();
        try {
            const graph = new FakeGraph();
            const remote: RemoteSnapshot = {
                nodes: [makeNode('node-no-vector-1', '2026-05-13T00:00:00Z')],
                edges: [],
            };
            const engine = new SyncEngine(
                graph as unknown as LoreGraphHandle,
                tmp,
                new FakeAdapter(remote),
                // No vectorStore — engine should fall back to graph-only writes
            );
            const result = await engine.pullRemote();
            assert.equal(result.nodesPulled, 1);
        } finally { cleanup(tmp); }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
