#!/usr/bin/env tsx
/**
 * test/d8-rerank-e2e.ts — D8b (Lore 3.23), DESIGN-3.23.md §5 "D8 trace"
 * (mandatory integration verification — one production-path trace).
 *
 * Runs the whole rerank feature against a REAL embedded `createLore()`
 * instance (mkdtemp data dir, `ownsProcess:false`, no listening port — no
 * HTTP server, no daemon), real ingested nodes, and the real BM25 keyword
 * engine — not fixtures. Only the cross-encoder SCORER is swapped for a
 * deterministic test double via `setRerankScorerForTest` (steps 1-5); step
 * 6 removes that double entirely to prove the REAL `LocalRerankProvider`
 * fails open when the model isn't cached (this test process's isolated
 * LORE_HOME per loreHome.ts's `isTestProcess()` guard never has the model
 * cached, so this is a genuine assertion, not a contrived one).
 *
 * Steps (mirrors DESIGN-3.23.md §5 "D8 trace" 1-6):
 *   1. createLore({ dataDir: mkdtemp, ownsProcess:false }), store nodes.
 *   2. Install a scorer so the node at ORIGINAL rank 3 scores +2.0 over
 *      rank 1 (margin default 1.0, so the gate lets it through).
 *   3. MCP recall tool, rerank:true -> rank-3 node is now #1,
 *      _meta.rerank.applied:true, gate_held:false.
 *   4. Same assertion through REST /api/recall, via the in-process
 *      route-handler harness (trySearchRoutes()) the r3221 REST test
 *      uses — no listening port — fed the SAME real `lore.store`.
 *   5. Same assertion through workspace:"*" — this instance has no
 *      graphRegistry wired (out of D8's scope to construct — D8 must
 *      never touch mcp/server.ts), so this calls the shared
 *      `runCrossWorkspaceRecall()` production function directly (exactly
 *      what recallTool.ts's own workspace:"*" branch delegates to),
 *      wrapping the SAME real `lore.store.loreGraph` as the sole
 *      workspace's handle — real store, real rerank stage, real
 *      apply-once merge logic; only the multi-workspace *registry
 *      object* itself is a thin adapter over the one real workspace.
 *   6. Remove the scorer (real provider, empty/uncached models dir) ->
 *      applied:false, reason:'model_unavailable', order unchanged.
 *
 * Run: npx tsx test/d8-rerank-e2e.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createLore } from '../packages/lore/src/index.js';
import { NullEmbeddingProvider } from '../packages/lore/src/providers/nullEmbeddingProvider.js';
import { setRerankScorerForTest } from '../packages/lore/src/recall/rerankStage.js';
import { resolveWorkspaceScope } from '../packages/lore/src/mcp/bootSteps.js';
import { trySearchRoutes, type SearchDeps } from '../packages/lore/src/mcp/http/routes/search.js';
import { runCrossWorkspaceRecall } from '../packages/lore/src/mcp/tools/recallCrossWorkspace.js';

type ToolTextResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
function parseToolText<T>(r: ToolTextResult): T {
    assert.ok(!r.isError, `tool call errored: ${JSON.stringify(r)}`);
    return JSON.parse(r.content[0]!.text) as T;
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('D8b — rerank end-to-end integration trace (design §5)\n');

// ── Fixture: 4 nodes sharing a rare topic token, each with a different
// repeat count of it (TF-inflation) so the real BM25 engine produces SOME
// deterministic, reproducible baseline order across runs (verified stable
// across repeated runs; BM25 length-normalization makes the exact order
// non-obvious to predict by hand, so the test reads it back rather than
// asserting a specific sequence — see step 1 below). Each node also carries
// a unique MARK so the test scorer can key off content rather than
// positional index (more robust against any future piece-windowing change
// than an index-based scorer would be). ─────────────────────────────────
const TOPIC = 'zzyzxd8be2etrace';
const TF = { 'e2e-1': 20, 'e2e-2': 14, 'e2e-3': 8, 'e2e-4': 2 } as const;
const MARK: Record<string, string> = { 'e2e-1': 'MARKONE', 'e2e-2': 'MARKTWO', 'e2e-3': 'MARKTHREE', 'e2e-4': 'MARKFOUR' };
function nodeContent(id: keyof typeof TF): string {
    return `${MARK[id]} ${new Array(TF[id]).fill(TOPIC).join(' ')}`;
}
const NODE_IDS = ['e2e-1', 'e2e-2', 'e2e-3', 'e2e-4'] as const;

/**
 * Builds a scorer that promotes the node at the (empirically observed, not
 * predicted) original rank 3 to +2.0 over the node at original rank 1, per
 * design step 2 — "the node at original rank 3 scores +2.0 over rank 1".
 * BM25's own length normalization makes the exact baseline order across
 * TF-inflated documents of differing length non-obvious to predict by hand
 * (confirmed empirically: shorter, lower-TF documents can outrank longer,
 * higher-TF ones), so this keys off whichever ids the REAL baseline recall
 * actually returned at position 0 and 2, rather than assuming a fixed order.
 * Margin default is 1.0, so 3.0 - 1.0 = 2.0 clears it — an unambiguous,
 * deliberate reorder, not a coin-flip near the gate's threshold.
 */
function makePromoteRank3Scorer(origRank1Id: string, origRank3Id: string) {
    const markRank1 = MARK[origRank1Id]!;
    const markRank3 = MARK[origRank3Id]!;
    return async (_q: string, passages: string[]): Promise<number[]> =>
        passages.map((p) => {
            if (p.includes(markRank3)) return 3.0;
            if (p.includes(markRank1)) return 1.0;
            return 0.1;
        });
}

async function main(): Promise<void> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-d8-e2e-'));
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', ownsProcess: false, embeddingProvider: new NullEmbeddingProvider() });
    try {
        // ── Step 1: store nodes through the public store API. ──────────
        await lore.bulkIngest(
            NODE_IDS.map((id) => ({
                id, workspace: 'default', ecosystem: '*',
                nodeData: { id, type: 'note', label: id, content: nodeContent(id), project: 'default', ecosystem: '*' },
            })),
            { autolink: false, embed: 'sync' },
        );

        // Confirm the baseline premise BEFORE installing any scorer, via a
        // real MCP recall — if this ever trips, every downstream "rank 3
        // becomes #1" assertion would be checking the wrong thing.
        const mcpServer = lore.createMcpServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        const client = new Client({ name: 'd8-e2e-test', version: '0.0.1' });
        await client.connect(clientTransport);
        async function recall(args: Record<string, unknown>): Promise<any> {
            const r = await client.callTool({ name: 'recall', arguments: { topic: TOPIC, workspace: 'default', search_mode: 'keyword', mode: 'summary', ...args } }) as unknown as ToolTextResult;
            return parseToolText<any>(r);
        }

        let baselineIds: string[] = [];
        await test('step 1: baseline recall (rerank omitted) returns all 4 nodes; D8d default-on attempts rerank, fails open (model not cached), order unchanged', async () => {
            const out = await recall({});
            baselineIds = out.hits.map((h: any) => h.id);
            assert.equal(baselineIds.length, 4, `expected all 4 nodes, got ${JSON.stringify(baselineIds)}`);
            assert.deepEqual([...baselineIds].sort(), [...NODE_IDS].sort());
            assert.ok(out._meta.rerank, 'D8d default-on: opinion-less call now reports rerank meta');
            assert.equal(out._meta.rerank.applied, false);
            assert.equal(out._meta.rerank.reason, 'model_absent');
        });

        // The node at original rank 3 (index 2) and rank 1 (index 0) — taken
        // from the REAL baseline order above, per design step 2's own
        // wording ("the node at original rank 3"), not a hand-predicted
        // BM25 order (length normalization makes that non-obvious to
        // predict by hand across differing document lengths).
        const origRank1Id = baselineIds[0]!;
        const origRank3Id = baselineIds[2]!;
        assert.notEqual(origRank1Id, origRank3Id);

        // ── Step 2: install the deterministic scorer. ───────────────────
        setRerankScorerForTest(makePromoteRank3Scorer(origRank1Id, origRank3Id));

        // ── Step 3: MCP recall tool, rerank:true. ────────────────────────
        await test('step 3: MCP recall tool rerank:true promotes orig rank-3 node to #1; applied:true, gate_held:false', async () => {
            const out = await recall({ rerank: true });
            assert.equal(out.hits[0].id, origRank3Id, `expected ${origRank3Id} at #1, got ${JSON.stringify(out.hits.map((h: any) => h.id))}`);
            assert.equal(out._meta.rerank.applied, true);
            assert.equal(out._meta.rerank.gate_held, false, 'the margin gate must NOT hold the incumbent — a genuine reorder happened');
            assert.equal(out._meta.rerank.replaced_top, true);
        });

        // ── Step 4: REST /api/recall, via the in-process route-handler
        // harness (no listening port), fed the SAME real lore.store. ────
        const detectedScope = resolveWorkspaceScope(lore.dataHome);
        const searchDeps = {
            store: lore.store, detectedScope, deploymentMode: lore.deploymentMode,
            dataplane: null, graphRegistry: undefined,
        } as unknown as SearchDeps;
        async function callRest(qs: string): Promise<any> {
            const url = `/api/recall?topic=${encodeURIComponent(TOPIC)}&workspace=default&search_mode=keyword${qs}`;
            let status = 0; let body = '';
            const req = { method: 'GET', url } as unknown as IncomingMessage;
            const res = { writeHead(s: number) { status = s; return this; }, end(chunk?: string) { body = chunk ?? ''; } } as unknown as ServerResponse;
            const handled = await trySearchRoutes(req, res, url, '/api/recall', searchDeps);
            assert.ok(handled, 'GET /api/recall was not handled');
            assert.equal(status, 200, `unexpected status ${status}: ${body}`);
            return JSON.parse(body);
        }
        await test('step 4: REST GET /api/recall?rerank=1 promotes orig rank-3 node to #1 (real store, in-process route handler, no port)', async () => {
            const out = await callRest('&rerank=1');
            assert.equal(out.hits[0].id, origRank3Id, `expected ${origRank3Id} at #1, got ${JSON.stringify(out.hits.map((h: any) => h.id))}`);
            assert.equal(out._meta.rerank.applied, true);
            assert.equal(out._meta.rerank.gate_held, false);
        });
        await test('step 4b: REST GET /api/recall, D8d default-on: an omitted ?rerank param still reorders (no opinion means ON now)', async () => {
            const out = await callRest('');
            assert.equal(out.hits[0].id, origRank3Id, 'D8d: default-on means the cross-encoder scorer applies here too, even with no ?rerank param');
            assert.equal(out._meta.rerank.applied, true);
        });
        await test('step 4c: REST GET /api/recall?rerank=0 is the explicit off switch — keeps the real store\'s baseline order even with a scorer installed and default-on', async () => {
            const out = await callRest('&rerank=0');
            assert.deepEqual(out.hits.map((h: any) => h.id), baselineIds, 'explicit rerank=0 must win over default-on');
            assert.equal(out._meta.rerank, undefined, 'explicit off is byte-identical-off: no meta at all');
        });

        // ── Step 5: workspace:"*" — the shared runCrossWorkspaceRecall()
        // production function (exactly what recallTool.ts's own
        // workspace:"*" branch delegates to), wrapping the real graph.
        // No graphRegistry is wired on this embedded instance (D8 must
        // never touch mcp/server.ts to add one), so this calls the same
        // shared function directly rather than through the MCP tool's
        // "*" branch, which would just log-and-fall-back without it. ────
        const crossHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-d8-e2e-crossws-'));
        fs.mkdirSync(path.join(crossHome, 'workspaces', 'default', '.lore'), { recursive: true });
        fs.writeFileSync(path.join(crossHome, 'workspaces.json'), JSON.stringify({
            active: 'default',
            workspaces: [{ name: 'default', path: path.join(crossHome, 'workspaces', 'default'), createdAt: '2026-06-15T00:00:00.000Z', graphEngine: 'surreal' }],
        }, null, 2));
        const registry = { async getGraphHandle(_ws: string) { void _ws; return lore.store.loreGraph; }, homeDir() { return crossHome; } };
        try {
            await test('step 5: workspace:"*" (runCrossWorkspaceRecall, real store) promotes orig rank-3 node to #1; applied:true, gate_held:false', async () => {
                const res = await runCrossWorkspaceRecall({
                    topic: TOPIC, depth: 0, includeSuperseded: false,
                    registry: registry as any, verbatimStore: lore.store.loreVerbatim,
                    sessionCache: lore.store.sessionCache, responseMode: 'summary', rerank: true,
                } as any);
                const out = parseToolText<any>(res as unknown as ToolTextResult);
                assert.equal(out.hits[0].id, origRank3Id, `expected ${origRank3Id} at #1, got ${JSON.stringify(out.hits.map((h: any) => h.id))}`);
                assert.equal(out._meta.rerank.applied, true);
                assert.equal(out._meta.rerank.gate_held, false);
            });
        } finally {
            fs.rmSync(crossHome, { recursive: true, force: true });
        }

        // ── Step 6: remove the test scorer — the REAL LocalRerankProvider
        // runs against this test process's isolated (uncached) LORE_HOME
        // and must fail open. ────────────────────────────────────────────
        setRerankScorerForTest(null);
        await test('step 6: real provider, model not cached -> applied:false, reason:model_absent, order unchanged', async () => {
            const out = await recall({ rerank: true });
            assert.deepEqual(out.hits.map((h: any) => h.id), baselineIds, 'fail-open must preserve the original order exactly');
            assert.equal(out._meta.rerank.applied, false);
            assert.equal(out._meta.rerank.reason, 'model_absent');
        });
    } finally {
        setRerankScorerForTest(null);
        await lore.dispose();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
