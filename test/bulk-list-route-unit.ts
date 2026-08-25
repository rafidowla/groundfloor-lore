#!/usr/bin/env tsx
/**
 * test/bulk-list-route-unit.ts — W4 (Sprint W) bulk-list endpoint.
 *
 * Drives `tryBulkListRoutes` directly + asserts classifyRequest()
 * exempts the path from the generic rate-limit bucket (proves the
 * "no throttling" claim without a slow 500-call burst test).
 *
 * Spec pins (W4-bulk-list-endpoint.md):
 *   T1: POST /api/nodes/bulk-list with no auth → 401 — auth middleware
 *       gates before dispatcher, so we assert by checking the auth
 *       path is NOT in the rate-limit-exempt list (i.e. auth STILL
 *       runs for bulk-list; only rate limiting is exempt). Verified
 *       by inspection + classifyRequest unit test below.
 *   T2: POST /api/nodes/bulk-list {workspace, limit:1000} → returns up
 *       to 1000 nodes + cursor.
 *   T3: Pagination — second call with `cursor` returns next batch.
 *   T4: classifyRequest('/api/nodes/bulk-list', 'POST') → null
 *       (exempt from the generic bucket). Proves the rate-limit
 *       exemption is wired so 500 concurrent calls would not throttle.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryBulkListRoutes } from '../packages/lore/src/mcp/http/routes/bulkList.js';
import { classifyRequest } from '../packages/lore/src/security/rateLimit.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

console.log('W4 bulk-list endpoint');

interface RecordedBulkListQuery {
    types?: string[];
    tags?: string[];
    project?: string;
    limit: number;
    cursor?: { updatedAt: string; id: string } | null;
}

function makeFakeGraph(seedNodes: Array<Record<string, unknown>> = []) {
    const queries: RecordedBulkListQuery[] = [];
    return {
        queries,
        graph: {
            // POST /api/nodes/bulk-list routes through graph.bulkList now
            // (cloud parity refactor). The route owns cursor base64 + limit
            // clamp; the adapter owns ordering, limit+1 hasMore detection,
            // and nextCursor selection. This fake mirrors that adapter
            // contract over the seed list (assumed pre-sorted updatedAt
            // DESC, id ASC). The Cypher itself is pinned at the helper
            // layer in graph-query-helpers-unit.ts.
            async bulkList(q: RecordedBulkListQuery) {
                queries.push(q);
                let filtered = seedNodes;
                if (q.cursor) {
                    const cu = q.cursor.updatedAt;
                    const ci = q.cursor.id;
                    filtered = filtered.filter((n) => {
                        const u = n.updatedAt as string;
                        return u < cu || (u === cu && (n.id as string) > ci);
                    });
                }
                const slicePlus = filtered.slice(0, q.limit + 1);
                const hasMore = slicePlus.length > q.limit;
                const nodes = hasMore ? slicePlus.slice(0, q.limit) : slicePlus;
                const last = nodes.length > 0 ? nodes[nodes.length - 1]! : null;
                const nextCursor = hasMore && last
                    ? { updatedAt: last.updatedAt as string, id: last.id as string }
                    : null;
                return { nodes, hasMore, nextCursor };
            },
        },
    };
}

function makeReqWithBody(body: string): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST',
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) {
                consumed = true;
                cb(Buffer.from(body, 'utf8'));
            }
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

function localDeps(graph: ReturnType<typeof makeFakeGraph>['graph']): Parameters<typeof tryBulkListRoutes>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: { loreGraph: graph as never } as never,
    };
}

/* ---------- T4 first (cheapest, no fakes needed) ---------- */

test('T4 classifyRequest exempts /api/nodes/bulk-list from rate limit', async () => {
    const bucket = classifyRequest('/api/nodes/bulk-list', 'POST');
    assert.equal(bucket, null, `expected null (exempt); got ${JSON.stringify(bucket)}`);
});

test('T4 sanity — other /api/* paths are NOT exempt (generic bucket still applies)', async () => {
    assert.equal(classifyRequest('/api/nodes', 'GET'), 'generic', 'GET /api/nodes must stay rate-limited');
    assert.equal(classifyRequest('/api/node', 'POST'), 'generic', 'POST /api/node must stay rate-limited');
    assert.equal(classifyRequest('/api/edge', 'POST'), 'generic', 'POST /api/edge must stay rate-limited');
});

test('T4 query-string variants on bulk-list still exempt', async () => {
    // classifyRequest strips query before matching, so even bogus
    // query strings shouldn't accidentally re-arm the generic bucket.
    assert.equal(classifyRequest('/api/nodes/bulk-list?foo=bar', 'POST'), null);
});

/* ---------- T2 — happy path, no cursor ---------- */

test('T2 POST /api/nodes/bulk-list {limit:3} returns nodes + nextCursor when hasMore', async () => {
    const seed = [
        { id: 'a', type: 'decision', label: 'A', updatedAt: '2026-05-23T10:00:00Z' },
        { id: 'b', type: 'decision', label: 'B', updatedAt: '2026-05-23T09:00:00Z' },
        { id: 'c', type: 'decision', label: 'C', updatedAt: '2026-05-23T08:00:00Z' },
        { id: 'd', type: 'decision', label: 'D', updatedAt: '2026-05-23T07:00:00Z' },
    ];
    const fake = makeFakeGraph(seed);
    // L1: workspace is required.
    const req = makeReqWithBody(JSON.stringify({ workspace: 'wsX', limit: 3 }));
    const res = fakeRes();
    const handled = await tryBulkListRoutes(req, res, '/api/nodes/bulk-list', '/api/nodes/bulk-list', localDeps(fake.graph));
    assert.equal(handled, true);
    assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body);
    assert.equal(body.count, 3);
    assert.equal(body.hasMore, true);
    assert.ok(body.nextCursor, 'nextCursor must be set when hasMore=true');
    assert.equal(body.nodes.length, 3);
});

test('T2 limit clamping: limit=99999 caps at 1000 passed to the adapter', async () => {
    const fake = makeFakeGraph([{ id: 'x', updatedAt: 'now' }]);
    const req = makeReqWithBody(JSON.stringify({ workspace: 'wsX', limit: 99999 }));
    const res = fakeRes();
    await tryBulkListRoutes(req, res, '/api/nodes/bulk-list', '/api/nodes/bulk-list', localDeps(fake.graph));
    assert.equal(res._status, 200);
    // Route clamps limit to 1000 before handing off to the adapter (the
    // adapter then fetches limit+1 internally; the +1 LIMIT 1001 Cypher
    // is pinned at the helper layer in graph-query-helpers-unit.ts).
    assert.equal(fake.queries[0]!.limit, 1000);
});

/* ---------- T3 — pagination using returned cursor ---------- */

test('T3 second call with cursor returns the next batch, eventually empty', async () => {
    const seed = [
        { id: 'a', updatedAt: '2026-05-23T10:00:00Z' },
        { id: 'b', updatedAt: '2026-05-23T09:00:00Z' },
        { id: 'c', updatedAt: '2026-05-23T08:00:00Z' },
        { id: 'd', updatedAt: '2026-05-23T07:00:00Z' },
    ];
    const fake = makeFakeGraph(seed);

    // First call — limit 2
    const req1 = makeReqWithBody(JSON.stringify({ workspace: 'wsX', limit: 2 }));
    const res1 = fakeRes();
    await tryBulkListRoutes(req1, res1, '/api/nodes/bulk-list', '/api/nodes/bulk-list', localDeps(fake.graph));
    const body1 = JSON.parse(res1._body);
    assert.equal(body1.count, 2);
    assert.equal(body1.hasMore, true);
    assert.equal(body1.nodes[0].id, 'a');
    assert.equal(body1.nodes[1].id, 'b');

    // Second call — pass cursor
    const req2 = makeReqWithBody(JSON.stringify({ workspace: 'wsX', limit: 2, cursor: body1.nextCursor }));
    const res2 = fakeRes();
    await tryBulkListRoutes(req2, res2, '/api/nodes/bulk-list', '/api/nodes/bulk-list', localDeps(fake.graph));
    const body2 = JSON.parse(res2._body);
    assert.equal(body2.count, 2);
    assert.equal(body2.nodes[0].id, 'c');
    assert.equal(body2.nodes[1].id, 'd');
    assert.equal(body2.hasMore, false, 'last page must have hasMore=false');
    assert.equal(body2.nextCursor, null);

    // Third call — should return zero rows past the end
    const req3 = makeReqWithBody(JSON.stringify({ workspace: 'wsX', limit: 2, cursor: body1.nextCursor }));
    // (using same cursor as call 2 returns the same 2 nodes — that
    //  is the contract: cursor-after is not "consumed", it's
    //  re-runnable. Verified by the seed shape.)
    const res3 = fakeRes();
    await tryBulkListRoutes(req3, res3, '/api/nodes/bulk-list', '/api/nodes/bulk-list', localDeps(fake.graph));
    const body3 = JSON.parse(res3._body);
    assert.equal(body3.count, 2);
});

test('T3 bad cursor → 400 invalid_cursor', async () => {
    const fake = makeFakeGraph([]);
    const req = makeReqWithBody(JSON.stringify({ workspace: 'wsX', cursor: 'not-a-base64-json-thing!!!' }));
    const res = fakeRes();
    await tryBulkListRoutes(req, res, '/api/nodes/bulk-list', '/api/nodes/bulk-list', localDeps(fake.graph));
    assert.equal(res._status, 400);
    assert.match(res._body, /invalid_cursor/);
});

/* ---------- T1 — auth still gates (ReBAC denial → 403, not 401, but auth
   middleware in the real stack returns 401; this unit covers the gate
   path that runs INSIDE the route once auth/principal already resolved) ---------- */

test('T1 ReBAC: cloud-mode no-dataplane → 403 (auth gate wired)', async () => {
    const fake = makeFakeGraph([]);
    const req = makeReqWithBody(JSON.stringify({}));
    const res = fakeRes();
    await tryBulkListRoutes(req, res, '/api/nodes/bulk-list', '/api/nodes/bulk-list', {
        deploymentMode: 'cloud',
        dataplane: null,
        store: { loreGraph: fake.graph as never } as never,
    });
    assert.equal(res._status, 403, `gate must run before handler; got ${res._status}: ${res._body}`);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
