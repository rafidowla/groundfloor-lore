#!/usr/bin/env tsx
/**
 * test/d6-skipembed-autolink-leak-unit.ts — D6 (Lore asks from Atlas,
 * 2026-09-22 defect list).
 *
 * Claim under test: `store_node`/`nodeUpsert` with `embed: false` /
 * `skipEmbed: true` is documented as graph-only ("graph row only, no
 * lancedb write, no semantic recall surface" — storeNode.ts's `embed`
 * field description; nodeService.ts's nodeUpsert doc comment: "skipEmbed
 * → nothing (graph-only node)"). In practice a skipEmbed node still gets a
 * vector row and becomes findable by semantic search within about a
 * second.
 *
 * ROOT CAUSE (found by reading, confirmed by this test — FIXED on this
 * branch): nodeUpsert's step 6 "ingest-time autolink" hook fires
 * `reconnectOneNode()` whenever `hooks.autolink` is wired — which it always
 * is for both the `store_node` MCP tool (storeNode.ts) and the embedded
 * `createLore().nodeUpsert()` (mcp/server.ts) — regardless of `skipEmbed`
 * (deliberately so, since 2026-08-17: bulkIngest.ts passes `autolink: true`
 * + `skipEmbed: true` together, wanting similarity EDGES drawn without a
 * canonical row write). The call site used to compute:
 *
 *     skipStore: !skipEmbed
 *
 * i.e. when `skipEmbed` is TRUE, `skipStore` was FALSE, so
 * `reconnectOneNode`'s own `verbatim.store()` call was NOT skipped — it
 * wrote the canonical `lore:<id>` row into the vector store anyway. The old
 * comment rationalized it as intentional ("step 3 wrote NOTHING, so
 * reconnectOneNode's own store() is the only writer and must run") — but
 * that treated skipEmbed as "embed later", when it actually means "never"
 * (confirmed: bulkIngest.ts's own Step 2 `toEmbed` collection permanently
 * excludes every skipEmbed node from its later batch-embed step — there is
 * no deferred write for reconnectOneNode to stand in for). The call is
 * fire-and-forget (tracked on `PendingAutolinkTracker`, not awaited by
 * `nodeUpsert`), which is the "within about a second" timing in the
 * original report.
 *
 * FIX (packages/lore/src/core/nodeService.ts, ~line 792): `skipStore` is now
 * unconditionally `true` at this call site — reconnectOneNode still draws
 * edges (bulkIngest's use case, unaffected) but never writes the canonical
 * row itself; storage decisions stay entirely with step 3's fan-out.
 *
 * This test reproduces it end-to-end through the public embeddable API
 * (`createLore`), with a deterministic injected embedding provider (no
 * ONNX model download), on both engine pairs:
 *   - default (3.21 default for a fresh workspace: sqlite graph + sqlite vector)
 *   - `LORE_DEFAULT_GRAPH_ENGINE=surreal LORE_DEFAULT_VECTOR_ENGINE=lance npx tsx …`
 *     (pre-3.21 default, still the live default for any EXISTING workspace)
 *
 * Run:
 *   npx tsx test/d6-skipembed-autolink-leak-unit.ts
 *   LORE_DEFAULT_GRAPH_ENGINE=surreal LORE_DEFAULT_VECTOR_ENGINE=lance npx tsx test/d6-skipembed-autolink-leak-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

/** Deterministic, content-dependent fake embedding provider — no ONNX
 *  model load. Same shape as test/sqlite-verbatim-engine-parity-unit.ts's
 *  DetEmbedProvider (a proven pattern for this repo's test suite). */
class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 16;
    readonly modelId = 'd6-skipembed-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(text: string): Promise<number[]> { return this.vec(text); }
    async embedQuery(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocument(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocumentBatch(texts: string[]): Promise<number[][]> { return texts.map((t) => this.vec(t)); }
}

function tmpDataDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-d6-skipembed-'));
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const engineLabel = `graph=${process.env.LORE_DEFAULT_GRAPH_ENGINE ?? 'sqlite(default)'} vector=${process.env.LORE_DEFAULT_VECTOR_ENGINE ?? 'sqlite(default)'}`;
console.log(`\nD6 — skipEmbed autolink leak (${engineLabel})\n`);

const MARKER = 'zzyzx-d6-skipembed-marker-3f8a1c';

await test('a node stored with skipEmbed:true has NO vector row and is unreachable by semantic search', async () => {
    const dataDir = tmpDataDir();
    const { createLore } = await import('../packages/lore/src/index.js');
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider() });
    try {
        const id = 'd6-node-1';
        const r = await lore.nodeUpsert({
            id,
            workspace: 'default',
            ecosystem: '*',
            nodeData: { id, type: 'note', label: 'd6 note', content: `${MARKER} skipEmbed test content`, project: 'default', ecosystem: '*' },
            skipEmbed: true,
        } as any);
        assert.equal(r.ok, true, 'nodeUpsert with skipEmbed:true should still succeed (graph write)');
        assert.equal((r as any).embedPending, undefined, 'skipEmbed write should not report embedPending — it never attempted an embed at all');

        // Give any fire-and-forget autolink hook / embed queue a chance to
        // run — the ORIGINAL report measured the leak landing "within about
        // a second". Drain the autolink tracker deterministically (it
        // resolves immediately once nothing is in flight) AND back it with
        // a flat sleep in case the hook hadn't registered yet at all.
        await new Promise((res) => setTimeout(res, 300));
        const tracker = (lore as any).store?.autolinkTracker;
        if (tracker && typeof tracker.drain === 'function') {
            await tracker.drain(5000);
        }
        await lore.awaitEmbeds?.();
        await new Promise((res) => setTimeout(res, 1500));

        // T1 — no vector row under the canonical lore:<id> key. Read the
        // boot workspace's own VerbatimStore/SqliteVerbatimStore directly
        // (store.loreVerbatim) — the same handle reconnectOneNode's
        // `verbatim.store()` call writes into — rather than the
        // LoreStorageClient facade, which has no getById passthrough.
        const loreVerbatim = (lore as any).store?.loreVerbatim;
        assert.ok(loreVerbatim && typeof loreVerbatim.getById === 'function', 'expected lore.store.loreVerbatim.getById to be available');
        const row = await loreVerbatim.getById(`lore:${id}`);
        assert.equal(row, null, `expected NO verbatim/vector row for a skipEmbed node, got: ${JSON.stringify(row)}`);

        // T2 — not reachable via SEMANTIC recall on its own marker text.
        // NOTE: `lore.search()` is a graph/keyword search (LoreStorageClient's
        // search() delegates straight to `graph.search()`, no vector store
        // involved) — the node's content legitimately lives in the graph
        // regardless of skipEmbed, so a keyword hit there is correct and NOT
        // part of this claim. The doc comment under test is specifically
        // about the "semantic recall surface", i.e. `lore.recall()` with
        // `searchMode: 'semantic'` (vector-only, no BM25 fallback) — that is
        // the path that must not see a skipEmbed node.
        const recallResult = await lore.recall(MARKER, { workspace: 'default', searchMode: 'semantic', mode: 'full' } as any);
        const hits = (recallResult as any)?.hits ?? (recallResult as any)?.nodes ?? [];
        const found = Array.isArray(hits) && hits.some((h: any) => h.id === id || h.id === `lore:${id}`);
        assert.equal(found, false, 'skipEmbed node must not be reachable via semantic recall on its own content');
    } finally {
        await lore.dispose();
    }
});

await test('an unrelated skipEmbed re-upsert (update) of the same node does not silently embed it either', async () => {
    const dataDir = tmpDataDir();
    const { createLore } = await import('../packages/lore/src/index.js');
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider() });
    try {
        const id = 'd6-node-2';
        const first = await lore.nodeUpsert({
            id, workspace: 'default', ecosystem: '*',
            nodeData: { id, type: 'note', label: 'd6 note v1', content: `${MARKER}-v1`, project: 'default', ecosystem: '*' },
            skipEmbed: true,
        } as any);
        assert.equal(first.ok, true);

        // An "unrelated" update — same skipEmbed contract still requested,
        // only the label changes. Must not silently start embedding just
        // because this is an update rather than a create.
        const second = await lore.nodeUpsert({
            id, workspace: 'default', ecosystem: '*',
            nodeData: { id, type: 'note', label: 'd6 note v2 (unrelated field)', content: `${MARKER}-v1`, project: 'default', ecosystem: '*' },
            skipEmbed: true,
        } as any);
        assert.equal(second.ok, true);

        await new Promise((res) => setTimeout(res, 300));
        const tracker = (lore as any).store?.autolinkTracker;
        if (tracker && typeof tracker.drain === 'function') await tracker.drain(5000);
        await lore.awaitEmbeds?.();
        await new Promise((res) => setTimeout(res, 1500));

        const loreVerbatim = (lore as any).store?.loreVerbatim;
        const row = await loreVerbatim.getById(`lore:${id}`);
        assert.equal(row, null, `expected NO verbatim/vector row after an update that also requested skipEmbed, got: ${JSON.stringify(row)}`);
    } finally {
        await lore.dispose();
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
