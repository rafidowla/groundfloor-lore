#!/usr/bin/env tsx
/**
 * p2-query-route-verbatim-isolation-unit.ts — P2 (isolation).
 *
 * POST /api/query routes the GRAPH to the requested workspace (via the
 * graphRegistry), but its semantic-seed phase used to seed the VECTOR store
 * from the boot-bound storageClient — i.e. the ACTIVE workspace's LanceDB — no
 * matter which workspace the request named. In multi-app local mode (active=A,
 * request=B) that meant:
 *   (a) the count-gate measured A → the semantic phase was skipped when A was
 *       empty even though B had docs;
 *   (b) the seed ids were A's node ids, hydrated against B's graph → dropped →
 *       recall silently returned nothing for B;
 *   (c) on an id collision, B's node was ranked by A's vector similarity →
 *       ranking contaminated by another workspace's vectors.
 *
 * This is the same per-workspace verbatim routing /api/recall + /api/search
 * already use via workspaceVerbatimResolver (retrieve()'s resolveSeedStore).
 * This test drives the real trySearchRoutes handler for POST /api/query against
 * a NON-active workspace and asserts:
 *   1. B's OWN verbatim store is counted + searched (not the boot store), and
 *   2. B's hits surface even though the boot/active store is EMPTY, and
 *   3. no boot-only (A) content bleeds into B's result set, and
 *   4. WITHOUT a resolver the route degrades safely (still confines to B —
 *      here it falls back to the boot store, which is empty, so B's own
 *      keyword search fills the results; no A ids leak).
 *
 * Run: npx tsx test/p2-query-route-verbatim-isolation-unit.ts
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { trySearchRoutes } from '../packages/lore/src/mcp/http/routes/search.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

type FNode = { id: string; type: string; label: string; content: string; tags: string[]; project: string; supersededAt?: string | null; createdAt?: string; updatedAt?: string };
const mk = (id: string, project: string): FNode => ({ id, type: 'note', label: id, content: `body ${id}`, tags: ['t'], project });

/** A graph whose getNodesByIds only knows its OWN nodes — so a foreign seed id
 *  hydrated here returns nothing (the exact drop the bug caused). */
function makeGraph(nodes: Record<string, FNode>, onKeyword?: () => void) {
    return {
        async search(_q: string, _n: number, _ws?: string, _eco?: string, _hidden?: boolean, signals?: { scanCapHit: boolean }) {
            onKeyword?.();
            if (signals) signals.scanCapHit = false;
            return Object.values(nodes).map((x) => ({ ...x }));
        },
        async getNodesByIds(ids: string[]) { const m = new Map<string, FNode>(); for (const id of ids) { const x = nodes[id]; if (x) m.set(id, { ...x }); } return m; },
    };
}

function fakeReq(method: string, body: string): IncomingMessage {
    let consumed = false;
    return {
        method, url: '/api/query',
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

// active = A (boot). request = B (non-active). B's graph + B's verbatim store
// know B's nodes; A's boot store knows only 'a-only'.
const B_NODES: Record<string, FNode> = { 'b1': mk('b1', 'wsB'), 'b2': mk('b2', 'wsB') };

console.log('P2 — POST /api/query seeds the REQUESTED workspace verbatim store\n');

await test('POST /api/query (active=A, workspace=B) seeds B\'s verbatim store, not the boot store', async () => {
    const bootGraph = makeGraph({}); // A: empty graph
    const wsBGraph = makeGraph(B_NODES);

    // Boot (A) verbatim store: NON-empty on count, and would return an A-only
    // seed id. Under the bug this gates the phase on A and leaks 'a-only'.
    let bootCount = 0, bootSearch = 0;
    const bootStorageClient = {
        async verbatimCount() { bootCount++; return 5; },
        async verbatimSearch() { bootSearch++; return [{ id: 'lore:a-only', score: 0.99 }]; },
    };

    // B's own verbatim store: ranks B's nodes.
    let wsBCount = 0, wsBSearch = 0;
    const wsBVerbatim = {
        async count() { wsBCount++; return 2; },
        async search(_q: string, _n: number) { wsBSearch++; return [{ id: 'lore:b1', score: 0.8 }, { id: 'lore:b2', score: 0.6 }]; },
        async bm25Search(_q: string, _n: number) { return [] as Array<{ id: string; score?: number }>; },
    };

    const registry = {
        getOrOpen: async (ws: string) => (ws === 'wsB' ? wsBGraph : bootGraph),
        getGraphHandle: async (ws: string) => (ws === 'wsB' ? wsBGraph : bootGraph),
        activeName: () => 'active-ws',
    };
    const deps = {
        deploymentMode: 'local' as const,
        dataplane: null,
        detectedScope: { workspace: 'active-ws', ecosystem: '*' },
        store: { loreGraph: bootGraph, storageClient: bootStorageClient } as never,
        graphRegistry: registry as never,
        workspaceVerbatimResolver: { getOrOpen: async (_ws: string) => wsBVerbatim as never },
    };

    const res = fakeRes();
    const handled = await trySearchRoutes(
        fakeReq('POST', JSON.stringify({ query: 'topic', workspace: 'wsB' })),
        res, '/api/query', '/api/query',
        deps as Parameters<typeof trySearchRoutes>[4],
    );

    assert.equal(handled, true, 'route must handle POST /api/query');
    assert.equal(res._status, 200, `expected 200, got ${res._status}: ${res._body}`);
    const out = JSON.parse(res._body) as { count: number; results: Array<{ id: string }> };
    const ids = out.results.map((r) => r.id);

    assert.ok(wsBCount > 0 && wsBSearch > 0, 'B\'s OWN verbatim store must be counted + searched');
    assert.equal(bootCount, 0, 'the BOOT (A) verbatim store must NEVER be counted for a wsB query');
    assert.equal(bootSearch, 0, 'the BOOT (A) verbatim store must NEVER be searched for a wsB query');
    assert.ok(ids.includes('b1') && ids.includes('b2'), `B's semantic seeds must surface; got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes('a-only'), 'an A-only seed must never leak into a wsB query');
});

await test('POST /api/query for B does NOT skip B\'s docs when the active (A) store is EMPTY', async () => {
    // The regression: bug (a) — the count-gate measured A. With A empty, the
    // semantic phase was skipped and B's matching doc was never surfaced by
    // vector search. Here A's boot store counts 0; B's store counts 2.
    const bootGraph = makeGraph({});
    const wsBGraph = makeGraph(B_NODES);
    const bootStorageClient = {
        async verbatimCount() { return 0; }, // A is empty
        async verbatimSearch() { return [] as Array<{ id: string; score?: number }>; },
    };
    let wsBSearch = 0;
    const wsBVerbatim = {
        async count() { return 2; },
        async search(_q: string, _n: number) { wsBSearch++; return [{ id: 'lore:b1', score: 0.8 }]; },
        async bm25Search(_q: string, _n: number) { return [] as Array<{ id: string; score?: number }>; },
    };
    const registry = { getOrOpen: async (ws: string) => (ws === 'wsB' ? wsBGraph : bootGraph),
        getGraphHandle: async (ws: string) => (ws === 'wsB' ? wsBGraph : bootGraph), activeName: () => 'active-ws' };
    const deps = {
        deploymentMode: 'local' as const, dataplane: null,
        detectedScope: { workspace: 'active-ws', ecosystem: '*' },
        store: { loreGraph: bootGraph, storageClient: bootStorageClient } as never,
        graphRegistry: registry as never,
        workspaceVerbatimResolver: { getOrOpen: async (_ws: string) => wsBVerbatim as never },
    };
    const res = fakeRes();
    await trySearchRoutes(
        fakeReq('POST', JSON.stringify({ query: 'topic', workspace: 'wsB' })),
        res, '/api/query', '/api/query', deps as Parameters<typeof trySearchRoutes>[4],
    );
    assert.equal(res._status, 200, `expected 200, got ${res._status}: ${res._body}`);
    const out = JSON.parse(res._body) as { results: Array<{ id: string }> };
    assert.ok(wsBSearch > 0, 'B\'s verbatim store must be consulted even though A is empty');
    assert.ok(out.results.map((r) => r.id).includes('b1'), 'B\'s vector hit must surface despite an empty active store');
});

await test('POST /api/query for B WITHOUT a resolver degrades safely (no A leak)', async () => {
    // No workspaceVerbatimResolver → the route falls back to the boot store for
    // seeding. The boot store is empty (count 0), so the semantic phase is a
    // no-op and B's OWN graph keyword search fills the results. Crucially, no
    // A ids leak and B's graph (routed via the registry) is what answers.
    const bootGraph = makeGraph({});
    const wsBGraph = makeGraph(B_NODES);
    let bootSearch = 0;
    const bootStorageClient = {
        async verbatimCount() { return 0; },
        async verbatimSearch() { bootSearch++; return [{ id: 'lore:a-only', score: 0.99 }]; },
    };
    const registry = { getOrOpen: async (ws: string) => (ws === 'wsB' ? wsBGraph : bootGraph),
        getGraphHandle: async (ws: string) => (ws === 'wsB' ? wsBGraph : bootGraph), activeName: () => 'active-ws' };
    const deps = {
        deploymentMode: 'local' as const, dataplane: null,
        detectedScope: { workspace: 'active-ws', ecosystem: '*' },
        store: { loreGraph: bootGraph, storageClient: bootStorageClient } as never,
        graphRegistry: registry as never,
        // No workspaceVerbatimResolver.
    };
    const res = fakeRes();
    await trySearchRoutes(
        fakeReq('POST', JSON.stringify({ query: 'topic', workspace: 'wsB' })),
        res, '/api/query', '/api/query', deps as Parameters<typeof trySearchRoutes>[4],
    );
    assert.equal(res._status, 200, `expected 200, got ${res._status}: ${res._body}`);
    const out = JSON.parse(res._body) as { results: Array<{ id: string }> };
    const ids = out.results.map((r) => r.id);
    assert.equal(bootSearch, 0, 'boot store search must NOT run when its count is 0');
    assert.ok(ids.includes('b1') && ids.includes('b2'), `B's keyword hits must surface; got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes('a-only'), 'no A id may leak into a wsB query even without a resolver');
});

await test('POST /api/query for B: a resolver getOrOpen FAILURE SKIPS the vector seed (no A leak)', async () => {
    // Round-3 residual — resolveQuerySeedStore's catch branch used to return the
    // BOOT store on a getOrOpen failure, which count-gated + seeded a wsB query
    // from wsA's LanceDB. The fix returns null → the vector pass is SKIPPED and
    // B's OWN graph keyword search fills the results; the boot (A) store is
    // NEVER counted or searched.
    const bootGraph = makeGraph({});
    const wsBGraph = makeGraph(B_NODES);
    let bootCount = 0, bootSearch = 0;
    const bootStorageClient = {
        async verbatimCount() { bootCount++; return 5; },      // A non-empty — would gate B if leaked
        async verbatimSearch() { bootSearch++; return [{ id: 'lore:a-only', score: 0.99 }]; },
    };
    const registry = { getOrOpen: async (ws: string) => (ws === 'wsB' ? wsBGraph : bootGraph),
        getGraphHandle: async (ws: string) => (ws === 'wsB' ? wsBGraph : bootGraph), activeName: () => 'active-ws' };
    const deps = {
        deploymentMode: 'local' as const, dataplane: null,
        detectedScope: { workspace: 'active-ws', ecosystem: '*' },
        store: { loreGraph: bootGraph, storageClient: bootStorageClient } as never,
        graphRegistry: registry as never,
        // Resolver is WIRED but its getOrOpen THROWS (never-embedded / missing
        // LanceDB / chokepoint denial) — the catch branch must return null.
        workspaceVerbatimResolver: { getOrOpen: async (_ws: string) => { throw new Error('missing LanceDB'); } },
    };
    const res = fakeRes();
    await trySearchRoutes(
        fakeReq('POST', JSON.stringify({ query: 'topic', workspace: 'wsB' })),
        res, '/api/query', '/api/query', deps as Parameters<typeof trySearchRoutes>[4],
    );
    assert.equal(res._status, 200, `expected 200, got ${res._status}: ${res._body}`);
    const out = JSON.parse(res._body) as { results: Array<{ id: string }> };
    const ids = out.results.map((r) => r.id);
    assert.equal(bootCount, 0, 'a getOrOpen failure must NOT fall back to counting the boot (A) store');
    assert.equal(bootSearch, 0, 'a getOrOpen failure must NOT fall back to searching the boot (A) store');
    assert.ok(ids.includes('b1') && ids.includes('b2'), `B's keyword hits must still fill in; got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes('a-only'), 'no A id may leak when the resolver open fails');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
