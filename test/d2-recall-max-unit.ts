#!/usr/bin/env tsx
/**
 * test/d2-recall-max-unit.ts — Lore 3.22.1 defect D2, MCP `recall` tool.
 *
 * Pins that `recall` accepts an explicit `max` (up to 100) that raises the
 * result count past the historic hardcoded 10-hit cap — in ranked `hits`
 * (summary mode) AND `knowledge` (full mode) — while an omitted `max` still
 * caps at 10 (unchanged default behaviour). Also pins the documented
 * interplay: `max_tokens` still truncates top-ranked-first on top of a
 * larger `max`, and `compact` mode honours `max` too.
 *
 * Fixture: 30 matching nodes behind a keyword-only `graph.search()` mock (no
 * verbatim/BM25 store — `storageClient.verbatimCount` returns 0), returned in
 * a fixed rank order so `.slice(0, N)` truncation is deterministic to assert
 * on (id-01 is always the top hit).
 *
 * Run: npx tsx test/d2-recall-max-unit.ts
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerRecallTool } from '../packages/lore/src/mcp/tools/search/recallTool.js';
import type { SearchToolsDeps } from '../packages/lore/src/mcp/tools/search/types.js';
import { trySearchRoutes, type SearchDeps } from '../packages/lore/src/mcp/http/routes/search.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WS = 'd2-recall-max-ws';
const N = 30;

type FNode = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; language: string | null; updatedAt: string;
};

// Fixed rank order: id-01 first, id-30 last. graph.search() below returns
// this order untouched regardless of the requested `limit`, so retrieve()'s
// OWN `.slice(0, limit)` is what does the truncation under test — id-01..N
// must always be the top N ids returned.
const NODES: FNode[] = Array.from({ length: N }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return {
        id: `id-${n}`, type: 'note', label: `Label ${n}`,
        content: `matching content body for node ${n} `.repeat(30), // long enough for max_tokens to bite
        tags: [], project: WS, ecosystem: '*', language: null,
        updatedAt: '2026-06-01T00:00:00.000Z',
    };
});

function buildFixture(): { toolDeps: SearchToolsDeps } {
    const graph = {
        // Keyword-leg text search (retrieve.ts runKeywordSeeds). Ignores the
        // requested `limit` deliberately — returns ALL matching nodes in
        // fixed rank order, so the test exercises retrieve()'s own
        // `.slice(0, limit)` (fed by the tool's `max`), not this mock.
        async search(_query: string, _limit: number) { void _query; void _limit; return NODES.map((n) => ({ ...n })); },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, FNode>();
            for (const id of ids) { const x = NODES.find((n) => n.id === id); if (x) m.set(id, { ...x }); }
            return m;
        },
        async traverse() { return []; },
        async getNode(id: string) { const x = NODES.find((n) => n.id === id); return x ? { ...x } : null; },
        async listNodes() { return []; },
        async getLanguageBreakdown() { return {}; },
    };
    const store = {
        loreGraph: graph,
        loreVerbatim: {},
        sessionCache: { pushNode() { /* noop */ } },
        storageClient: {
            // verbatimConsulted = false — forces the pure keyword-leg path
            // (no vector/BM25 seed fetch), so the fixture only needs to
            // implement graph.search() above.
            async verbatimCount() { return 0; },
            async verbatimSearch() { throw new Error('semantic path not used by this keyword-mode fixture'); },
            async verbatimBm25Search() { throw new Error('bm25 path not used — verbatimCount()===0 short-circuits it'); },
        },
    };
    const graphRegistry = {
        async getOrOpen() { return graph; },
        async getGraphHandle() { return graph; },
    };
    const detectedScope = { workspace: WS, ecosystem: '*' };
    const toolDeps = { store, detectedScope, graphRegistry } as unknown as SearchToolsDeps;
    return { toolDeps };
}

let capturedSchema: Record<string, z.ZodTypeAny> | undefined;
function captureMcpTools(toolDeps: SearchToolsDeps): Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>> {
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    const fake = {
        tool(name: string, _desc: string, schema: Record<string, z.ZodTypeAny>, handler: (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) {
            handlers.set(name, handler);
            if (name === 'recall') capturedSchema = schema;
        },
    };
    registerRecallTool(fake as unknown as McpServer, toolDeps);
    return handlers;
}

async function callMcp(handlers: ReturnType<typeof captureMcpTools>, args: unknown): Promise<any> {
    const res = await handlers.get('recall')!(args);
    return { body: JSON.parse(res.content[0]!.text), isError: !!res.isError };
}

console.log('D2 (3.22.1) — MCP `recall` `max` param, full/summary/compact/max_tokens interplay\n');

await test('no `max`: summary mode still caps at 10 (unchanged default)', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const { body, isError } = await callMcp(mcp, { topic: 'matching', workspace: WS, search_mode: 'keyword', depth: 0 });
    assert.ok(!isError, JSON.stringify(body));
    assert.equal(body.mode, 'summary');
    assert.equal(body.hits.length, 10, `expected 10 hits by default, got ${body.hits.length}`);
    assert.equal(body.hits[0].id, 'id-01');
});

await test('no `max`: full mode ALSO caps at 10 (retrieve()\'s own default seed limit, unchanged)', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const { body, isError } = await callMcp(mcp, { topic: 'matching', workspace: WS, search_mode: 'keyword', depth: 0, mode: 'full' });
    assert.ok(!isError, JSON.stringify(body));
    assert.equal(body.mode, 'full');
    assert.equal(body.knowledge.length, 10, `expected 10 by default, got ${body.knowledge.length}`);
});

await test('max:25 — summary mode returns up to 25 ranked hits', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const { body, isError } = await callMcp(mcp, { topic: 'matching', workspace: WS, search_mode: 'keyword', depth: 0, max: 25 });
    assert.ok(!isError, JSON.stringify(body));
    assert.equal(body.mode, 'summary');
    assert.equal(body.hits.length, 25, `expected 25 hits with max:25, got ${body.hits.length}`);
    assert.equal(body.hits[0].id, 'id-01');
    assert.equal(body.hits[24].id, 'id-25');
});

await test('max:25 — full mode returns up to 25 knowledge entries', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const { body, isError } = await callMcp(mcp, { topic: 'matching', workspace: WS, search_mode: 'keyword', depth: 0, max: 25, mode: 'full' });
    assert.ok(!isError, JSON.stringify(body));
    assert.equal(body.mode, 'full');
    assert.equal(body.knowledge.length, 25, `expected 25 with max:25 full mode, got ${body.knowledge.length}`);
});

await test('max:25 — compact mode candidates also respect max (up to 25)', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const { body, isError } = await callMcp(mcp, { topic: 'matching', workspace: WS, search_mode: 'keyword', depth: 0, max: 25, compact: true });
    assert.ok(!isError, JSON.stringify(body));
    assert.equal(body.candidates.length, 25, `expected 25 compact candidates with max:25, got ${body.candidates.length}`);
});

await test('max:25 + small max_tokens: still truncated top-ranked-first, fewer than 25 results, truncated:true', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const { body, isError } = await callMcp(mcp, { topic: 'matching', workspace: WS, search_mode: 'keyword', depth: 0, max: 25, max_tokens: 300 });
    assert.ok(!isError, JSON.stringify(body));
    assert.ok(body.hits.length < 25, `expected max_tokens to cut below 25, got ${body.hits.length}`);
    assert.ok(body.hits.length > 0, 'expected at least one hit to survive the budget');
    assert.equal(body.hits[0].id, 'id-01', 'truncation must keep the top-ranked hit first');
    assert.equal(body._meta.truncated, true);
});

await test('max:100 accepted (upper bound); max:101 rejected by the schema', async () => {
    const { toolDeps } = buildFixture();
    const mcp = captureMcpTools(toolDeps);
    const ok = await callMcp(mcp, { topic: 'matching', workspace: WS, search_mode: 'keyword', depth: 0, max: 100 });
    assert.ok(!ok.isError, JSON.stringify(ok.body));
    assert.equal(ok.body.hits.length, N, `expected all ${N} fixture nodes with max:100, got ${ok.body.hits.length}`);

    captureMcpTools(toolDeps);
    assert.ok(capturedSchema, 'expected registerRecallTool to have captured its zod schema shape');
    assert.throws(() => z.object(capturedSchema!).parse({ topic: 'matching', workspace: WS, max: 101 }), /100|Invalid/i);
});

// ── Fix (7a): REST GET /api/recall ?max= summary-cap parity ────────────────
//
// D2's `maxHits` threading was fixed identically on the REST route
// (search.ts ~line 322, `maxHits: max`) as on the MCP recall tool above —
// this pins the REST surface so it can't silently regress back to the
// hardcoded 10-hit buildRecallResult cap the MCP-side test above guards.

async function callRest(searchDeps: SearchDeps, url: string): Promise<{ status: number; body: any }> {
    let status = 0; let body = '';
    const req = { method: 'GET', url } as unknown as IncomingMessage;
    const res = {
        writeHead(s: number) { status = s; return this; },
        end(chunk?: string) { body = chunk ?? ''; },
    } as unknown as ServerResponse;
    const handled = await trySearchRoutes(req, res, url, '/api/recall', searchDeps);
    assert.ok(handled, '/api/recall was not handled');
    return { status, body: body ? JSON.parse(body) : null };
}

function buildRestFixture(): { searchDeps: SearchDeps } {
    const { toolDeps } = buildFixture();
    const searchDeps = { ...toolDeps, deploymentMode: 'local', dataplane: null } as unknown as SearchDeps;
    return { searchDeps };
}

await test('REST GET /api/recall: no `max` keeps its own unchanged default (RECALL_MAX_DEFAULT=8, distinct from the MCP tool\'s 10)', async () => {
    const { searchDeps } = buildRestFixture();
    const rest = await callRest(searchDeps, `/api/recall?topic=matching&workspace=${WS}&search_mode=keyword`);
    assert.equal(rest.status, 200, `expected 200, got ${rest.status}: ${JSON.stringify(rest.body)}`);
    // REST's own `max` parsing (search.ts) defaults to RECALL_MAX_DEFAULT=8,
    // independent of the MCP recall tool's 10-hit default above — this pins
    // that pre-existing, intentional REST/MCP default divergence so a future
    // "parity" cleanup doesn't silently change REST's default without notice.
    assert.equal(rest.body.hits.length, 8, `expected REST's own default of 8 hits, got ${rest.body.hits.length}: ${JSON.stringify(rest.body)}`);
    assert.equal(rest.body.hits[0].id, 'id-01');
});

await test('REST GET /api/recall: ?max=25 raises summary hits past the old hardcoded 10-hit buildRecallResult cap', async () => {
    const { searchDeps } = buildRestFixture();
    const rest = await callRest(searchDeps, `/api/recall?topic=matching&workspace=${WS}&search_mode=keyword&max=25`);
    assert.equal(rest.status, 200, `expected 200, got ${rest.status}: ${JSON.stringify(rest.body)}`);
    assert.equal(rest.body.hits.length, 25, `?max=25 must return 25 hits (buildRecallResult's maxHits must reach 25, not stay hardcoded at 10), got ${rest.body.hits.length}: ${JSON.stringify(rest.body)}`);
    assert.equal(rest.body.hits[0].id, 'id-01');
    assert.equal(rest.body.hits[24].id, 'id-25');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
