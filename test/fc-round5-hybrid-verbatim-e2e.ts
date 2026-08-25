#!/usr/bin/env tsx
/**
 * fc-round5-hybrid-verbatim-e2e.ts — 2026-08-18 gap 5 (cluster-5 medium).
 *
 * search_verbatim / GET /api/verbatim/search / VerbatimStoreAdapter.search
 * were documented as "Hybrid (BM25 + vector)" but only ever ran the vector
 * search. All three now fuse both scorers (RRF, fail-closed on unranked
 * BM25 fallbacks) via engines/verbatimHybridSearch.ts.
 *
 *   T1  LIVE, real boot: the real search_verbatim MCP tool handler over the
 *       real embedded instance (SurrealGraph default engine, real
 *       LanceDB + FTS verbatim store, real embedder) consults BM25 and
 *       fuses — an exact-keyword hit reports matchedBy.bm25=true.
 *   T2  LIVE, contract surface: VerbatimStoreAdapter.search (the
 *       IVerbatimStore impl over the same real store) returns the
 *       keyword doc ranked by RRF fusion.
 *   T3  UNIT: vector-empty + bm25-ranked → hybrid still returns the hit
 *       (pre-fix: the surface returned []).
 *   T4  UNIT: fail-closed — an UNRANKED bm25 envelope contributes nothing;
 *       read degrades to semantic-only.
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/fc-round5-hybrid-verbatim-e2e.ts
 */

import assert from 'node:assert/strict';
import { createLore } from '../packages/lore/src/index.js';
import { registerVerbatimTools } from '../packages/lore/src/mcp/tools/verbatim.js';
import { VerbatimStoreAdapter } from '../packages/lore/src/engines/verbatimStoreAdapter.js';
import { hybridVerbatimSearch } from '../packages/lore/src/engines/verbatimHybridSearch.js';
import { makeBm25Envelope } from '../packages/lore/src/engines/verbatimBm25Result.js';

let passed = 0, failed = 0;
const test = (name: string, fn: () => Promise<void>) =>
    (async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
    })();

class FakeMcpServer {
    public tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> = [];
    tool(name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) {
        this.tools.push({ name, handler });
    }
}

async function main() {
    const dataDir = process.env.LORE_HOME!;
    const lore = await createLore({ deploymentMode: 'embedded', dataDir });
    const client = lore.store.storageClient;

    console.log('gap 5 — verbatim search surfaces actually do hybrid BM25+vector');

    // Real docs in the boot workspace's real store. 'zxqwibble' is a rare
    // token: an exact BM25 hit with a weak-to-absent semantic signal.
    const docs = [
        { id: 'hv-kw', text: 'The zxqwibble setting controls retry timing.', metadata: { type: 'doc', label: 'settings' } },
        { id: 'hv-other', text: 'Unrelated notes about gardening and soil.', metadata: { type: 'doc', label: 'notes' } },
        { id: 'hv-sem', text: 'Retry configuration and timeout behaviour.', metadata: { type: 'doc', label: 'retries' } },
    ];
    for (const d of docs) await client.verbatimStore(d as never);

    const server = new FakeMcpServer();
    registerVerbatimTools(server as never, { store: lore.store });

    await test('T1 LIVE search_verbatim consults BM25 and fuses (matchedBy.bm25)', async () => {
        const tool = server.tools.find((t) => t.name === 'search_verbatim')!;
        const r = await tool.handler({ query: 'zxqwibble', workspace: 'default' });
        assert.equal(r.isError, undefined, `tool errored: ${r.content[0]?.text}`);
        const parsed = JSON.parse(r.content[0]!.text) as { rows: Array<{ id: string; matchedBy?: { bm25: boolean; semantic: boolean } }> };
        const kw = parsed.rows.find((row) => row.id === 'hv-kw');
        assert.ok(kw, `keyword doc not returned by search_verbatim: ${JSON.stringify(parsed.rows.map((r2) => r2.id))}`);
        assert.equal(kw!.matchedBy?.bm25, true, 'BM25 half did not participate in the fusion');
    });

    await test('T2 LIVE VerbatimStoreAdapter.search fuses (contract surface)', async () => {
        const adapter = new VerbatimStoreAdapter(lore.store.loreVerbatim as never);
        const results = await adapter.search('zxqwibble', { limit: 5 });
        assert.ok(results.some((r) => r.id === 'hv-kw'),
            `adapter.search did not return the keyword doc: ${JSON.stringify(results.map((r) => r.id))}`);
    });

    await test('T3 UNIT vector-empty + bm25-ranked → hybrid still returns the hit', async () => {
        type Hit = { id: string; text: string };
        const store = {
            search: async (): Promise<Hit[]> => [],
            bm25Search: async (): Promise<unknown> => makeBm25Envelope<Hit>([{ id: 'kw-only', text: 'exact keyword' }], true),
        };
        const fused = await hybridVerbatimSearch<Hit>(store as never, 'exact keyword', 10);
        assert.equal(fused.length, 1);
        assert.equal(fused[0]!.hit.id, 'kw-only');
        assert.equal(fused[0]!.matchedBy.bm25, true);
        assert.ok(fused[0]!.score > 0, 'fused score must be > 0');
    });

    await test('T4 UNIT fail-closed — unranked BM25 envelope contributes nothing', async () => {
        type Hit = { id: string; text: string };
        const store = {
            search: async (): Promise<Hit[]> => [{ id: 'sem-1', text: 'semantic hit' }],
            // LIKE-scan fallback shape: every hit force-scored 1.0, ranked:false.
            bm25Search: async (): Promise<unknown> => makeBm25Envelope<Hit>([{ id: 'like-junk', text: 'substring fallback' }], false),
        };
        const fused = await hybridVerbatimSearch<Hit>(store as never, 'q', 10);
        assert.deepEqual(fused.map((f) => f.hit.id), ['sem-1'], 'unranked bm25 hits must be excluded from fusion');
        assert.equal(fused[0]!.matchedBy.semantic, true);
        assert.equal(fused[0]!.matchedBy.bm25, false);
    });

    await lore.dispose();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
