#!/usr/bin/env tsx
/**
 * test/bulk-write-w9-unit.ts — W9 bulk endpoints + rate-limit exemption.
 *
 * Drives tryBulkWriteRoutes directly with a recording fake graph handle
 * so the per-item semantics + cap enforcement + 404-non-fatal behaviour
 * are pinned without needing a live daemon.
 *
 * Spec pins:
 *   T4: POST /api/nodes/bulk with 1000 nodes — all upsert + per-item results.
 *   T5: POST /api/nodes/bulk-delete with 1000 ids — per-item; 404s non-fatal.
 *   T6: Bulk endpoints are exempt from rate limiting (classifier returns null).
 *       (Wire-level "10×1000 in 1s" is a runtime smoke; this unit pins the
 *       classifier contract that the middleware reads.)
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { classifyRequest, RATE_LIMIT_EXEMPT_PATHS } from '../packages/lore/src/security/rateLimit.js';

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
const test = (name: string, fn: () => Promise<void>) => {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })());
};

console.log('W9 bulk-write endpoints');

interface FakeNode { id: string; type: string; label: string }
function makeFakeGraph(opts: { seedNodes?: FakeNode[] } = {}) {
    const nodes = new Map<string, FakeNode>((opts.seedNodes ?? []).map((n) => [n.id, n]));
    const upsertCalls: string[] = [];
    const addEdgeCalls: Array<{ s: string; t: string; r: string; bidi: boolean }> = [];
    const deleteCalls: string[] = [];
    return {
        nodes, upsertCalls, addEdgeCalls, deleteCalls,
        graph: {
            async upsertNode(n: FakeNode & { project?: string; ecosystem?: string }) {
                upsertCalls.push(n.id);
                nodes.set(n.id, n);
                return { ...n, project: '*', ecosystem: '*', updatedAt: new Date().toISOString() };
            },
            async addEdge(e: { sourceId: string; targetId: string; relation: string }) {
                addEdgeCalls.push({ s: e.sourceId, t: e.targetId, r: e.relation, bidi: false });
            },
            async addBidirectionalEdge(e: { sourceId: string; targetId: string; relation: string }) {
                addEdgeCalls.push({ s: e.sourceId, t: e.targetId, r: e.relation, bidi: true });
                addEdgeCalls.push({ s: e.targetId, t: e.sourceId, r: e.relation, bidi: true });
            },
            async deleteNode(id: string) {
                deleteCalls.push(id);
                if (!nodes.has(id)) return false;
                nodes.delete(id);
                return true;
            },
            async search(q: string, limit: number) {
                // Return one fake hit per query so bulk-recall tests see structure.
                return [{ id: `hit-${q}`, type: 'decision', label: q, project: '*', tags: '' }].slice(0, limit) as never;
            },
        },
    };
}

function makeFakeVerbatim() {
    const stored: Array<{ id: string }> = [];
    const tombstoned: string[] = [];
    return {
        stored, tombstoned,
        store: {
            async store(rec: { id: string }) { stored.push({ id: rec.id }); },
            async tombstone(id: string) { tombstoned.push(id); },
            async delete(id: string) { tombstoned.push(id); },
        },
    };
}

function makeFakeAudit() {
    return { log: () => undefined };
}

function makeReqWithBody(body: string): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST',
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(s: number) { (this as { _status: number })._status = s; return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

function makeDeps(
    graph: ReturnType<typeof makeFakeGraph>['graph'],
    verbatim: ReturnType<typeof makeFakeVerbatim>['store'],
): Parameters<typeof tryBulkWriteRoutes>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: { loreGraph: graph as never, loreVerbatim: verbatim as never } as never,
        auditLog: makeFakeAudit() as never,
    };
}

/* T4 — bulk-nodes: 1000 nodes, all upserted, per-item results */
test('T4 POST /api/nodes/bulk 1000 nodes → ok:true count=1000 succeeded=1000', async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const nodes = Array.from({ length: 1000 }, (_, i) => ({
        id: `bulk-${i}`, type: 'decision', label: `Bulk ${i}`,
    }));
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsX', nodes })),
        res, '/api/nodes/bulk', '/api/nodes/bulk', makeDeps(fake.graph, verbatim.store),
    );
    assert.equal(res._status, 200, `status: ${res._status} body=${res._body.slice(0, 200)}`);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.count, 1000);
    assert.equal(body.succeeded, 1000);
    assert.equal(body.results.length, 1000);
    assert.equal(body.results[0]!.ok, true);
    assert.equal(body.results[0]!.id, 'bulk-0');
    assert.equal(fake.upsertCalls.length, 1000);
});

test('T4 POST /api/nodes/bulk 1001 nodes → 400 over cap', async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const nodes = Array.from({ length: 1001 }, (_, i) => ({
        id: `over-${i}`, type: 'decision', label: 'X',
    }));
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsX', nodes })),
        res, '/api/nodes/bulk', '/api/nodes/bulk', makeDeps(fake.graph, verbatim.store),
    );
    assert.equal(res._status, 400);
    assert.match(res._body, /at most 1000/);
    assert.equal(fake.upsertCalls.length, 0);
});

test('T4 POST /api/nodes/bulk with one bad item → succeeded<count, per-item error', async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const nodes = [
        { id: 'good', type: 'decision', label: 'good' },
        { id: 'bad-missing-type', label: 'no type' }, // missing type
    ];
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsX', nodes })),
        res, '/api/nodes/bulk', '/api/nodes/bulk', makeDeps(fake.graph, verbatim.store),
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.count, 2);
    assert.equal(body.succeeded, 1);
    assert.equal(body.results[0]!.ok, true);
    assert.equal(body.results[1]!.ok, false);
    assert.match(body.results[1]!.error, /required strings/);
});

/* 2.3 (2026-08-17) — the bulk route must reject server-managed lifecycle/security fields */
test('2.3 POST /api/nodes/bulk with security_scopes/status → per-item unknown_field rejection', async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const nodes = [
        { id: 'ok-node', type: 'decision', label: 'ok' },
        { id: 'evil-node', type: 'decision', label: 'evil', security_scopes: ['finance'], status: 'protected' },
    ];
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsX', nodes })),
        res, '/api/nodes/bulk', '/api/nodes/bulk', makeDeps(fake.graph, verbatim.store),
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.results[0]!.ok, true);
    assert.equal(body.results[1]!.ok, false, 'server-managed fields must be rejected');
    assert.match(body.results[1]!.error, /unknown_field/);
    assert.equal(fake.upsertCalls.length, 1, 'only the clean node reaches the graph writer');
});

// R3 audit #6 — an UNSAFE (but string) LanceDB id must be rejected per-item
// BEFORE the graph write. The bulk path writes via storageClient.upsertNode
// directly (not the nodeService chokepoint), so without the up-front guard an
// unsafe id wrote a graph node while the verbatim write threw and was dropped
// (fire-and-forget) — a durable orphan reported ok:true.
//
// fix/id-alphabet-sql-interpolation (2026-08-04): quote-bearing ids are no
// longer unsafe (escaping is the injection control), so the rejected case is
// now a NUL-byte id; the quote-bearing id must be ACCEPTED end to end.
test('R3#6 POST /api/nodes/bulk NUL id → per-item invalid_node_id, NO graph write (no orphan)', async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const nodes = [
        { id: 'safe-1', type: 'decision', label: 'ok' },
        { id: 'evil\x00drop', type: 'decision', label: 'unsafe' },
    ];
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsX', nodes })),
        res, '/api/nodes/bulk', '/api/nodes/bulk', makeDeps(fake.graph, verbatim.store),
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.succeeded, 1, 'only the safe node succeeds');
    assert.equal(body.results[0]!.ok, true);
    assert.equal(body.results[1]!.ok, false, 'NUL id rejected per-item');
    assert.equal(body.results[1]!.error, 'invalid_node_id');
    // the orphan guard: the NUL id must NEVER have hit the graph
    assert.ok(!fake.upsertCalls.includes('evil\x00drop'), 'no graph node written for the NUL id (no orphan)');
    assert.deepEqual(fake.upsertCalls, ['safe-1'], 'only the safe id was upserted');
});

// Companion to R3#6 post-fix: a quote-bearing id (old-alphabet "unsafe") is
// legitimate now — it must succeed per-item AND reach both substrates.
test('R3#6b POST /api/nodes/bulk quote-bearing id → accepted, graph + verbatim written', async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const nodes = [
        { id: "evil'(;--drop", type: 'decision', label: 'hostile-looking but safe' },
    ];
    const res = fakeRes();
    await tryBulkWriteRoutes(
        // embed:'inline' routes the verbatim seed synchronously into the wired
        // store (the default 'queued' path goes through the embed batch instead).
        makeReqWithBody(JSON.stringify({ workspace: 'wsX', embed: 'inline', nodes })),
        res, '/api/nodes/bulk', '/api/nodes/bulk', makeDeps(fake.graph, verbatim.store),
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.succeeded, 1, 'quote-bearing id succeeds post-fix');
    assert.equal(body.results[0]!.ok, true);
    assert.deepEqual(fake.upsertCalls, ["evil'(;--drop"], 'graph node written under the exact id');
    assert.ok(verbatim.stored.some((r) => r.id.includes("evil'(;--drop")), 'verbatim row written (no silent drop)');
});

/* T5 — bulk-delete: 1000 ids, per-item, 404s non-fatal */
test('T5 POST /api/nodes/bulk-delete 1000 ids (500 hit, 500 miss) → all reported', async () => {
    const seed = Array.from({ length: 500 }, (_, i) => ({
        id: `existing-${i}`, type: 'decision', label: `n${i}`,
    }));
    const fake = makeFakeGraph({ seedNodes: seed });
    const verbatim = makeFakeVerbatim();
    const ids = [
        ...seed.map((n) => n.id),
        ...Array.from({ length: 500 }, (_, i) => `missing-${i}`),
    ];
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsX', ids })),
        res, '/api/nodes/bulk-delete', '/api/nodes/bulk-delete', makeDeps(fake.graph, verbatim.store),
    );
    assert.equal(res._status, 200, `body=${res._body.slice(0, 200)}`);
    const body = JSON.parse(res._body);
    assert.equal(body.count, 1000);
    assert.equal(body.deleted, 500);
    assert.equal(body.notFound, 500);
    // Per-item statuses present
    assert.equal(body.results.length, 1000);
    // 404-non-fatal: missing ids return ok:true, deleted:false
    const missingResult = body.results.find((r: { id: string }) => r.id === 'missing-0');
    assert.ok(missingResult);
    assert.equal(missingResult.ok, true);
    assert.equal(missingResult.deleted, false);
    // Tombstone called for each actually-deleted node
    assert.equal(verbatim.tombstoned.length, 500);
    assert.ok(verbatim.tombstoned.every((id) => id.startsWith('lore:existing-')));
});

test('T5 POST /api/nodes/bulk-delete empty array → 400', async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsX', ids: [] })),
        res, '/api/nodes/bulk-delete', '/api/nodes/bulk-delete', makeDeps(fake.graph, verbatim.store),
    );
    assert.equal(res._status, 400);
});

/* T6 — bulk endpoints are exempt from rate limiting */
test('T6 all 4 bulk endpoints + bulk-list classify to null (rate-limit-exempt)', () => {
    const bulkPaths = [
        '/api/nodes/bulk',
        '/api/edges/bulk',
        '/api/nodes/bulk-delete',
        '/api/recall/bulk',
        '/api/nodes/bulk-list',
    ];
    for (const p of bulkPaths) {
        assert.equal(classifyRequest(p, 'POST'), null, `${p} POST must be exempt`);
        assert.ok(RATE_LIMIT_EXEMPT_PATHS.includes(p), `${p} not in RATE_LIMIT_EXEMPT_PATHS constant`);
    }
});

/* Edge-cases */
test('bulk-edges happy + bad mix', async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const edges = [
        { sourceId: 'a', targetId: 'b', relation: 'depends_on' },
        { sourceId: 'c', targetId: 'd', relation: 'related_to', bidirectional: true },
        { sourceId: 'bad' /* missing targetId */ },
    ];
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsX', edges })),
        res, '/api/edges/bulk', '/api/edges/bulk', makeDeps(fake.graph, verbatim.store),
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.count, 3);
    assert.equal(body.succeeded, 2);
    assert.equal(body.results[2]!.ok, false);
    // Bidi → 2 underlying addEdge calls; uni → 1 → total 3
    assert.equal(fake.addEdgeCalls.length, 3);
});

test('bulk-recall happy path', async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsX', topics: [{ topic: 'auth' }, { topic: 'rate-limit' }] })),
        res, '/api/recall/bulk', '/api/recall/bulk', makeDeps(fake.graph, verbatim.store),
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.count, 2);
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0]!.ok, true);
    assert.equal(body.results[0]!.topic, 'auth');
    assert.equal(body.results[0]!.hits[0]!.id, 'hit-auth');
});

/* L-012 — inline embed must land in the REQUESTED workspace's verbatim store,
 * not the boot-active one. Wire a per-workspace resolver returning distinct
 * recording stores and assert the embedding routes to workspace B. */
test('L-012 inline embed routes verbatim to requested workspace (not boot)', async () => {
    const fake = makeFakeGraph();
    const bootVerbatim = makeFakeVerbatim();      // deps.store.loreVerbatim (boot/active)
    const wsB = makeFakeVerbatim();               // workspace B's LanceDB
    // Fake SP-F3 resolver: name → distinct recording verbatim store.
    const resolver = {
        getOrOpen: async (ws: string) => {
            if (ws === 'B') return wsB.store as never;
            throw new Error(`workspace_not_found: "${ws}" (known: B)`);
        },
    };
    const deps = {
        ...makeDeps(fake.graph, bootVerbatim.store),
        workspaceVerbatimResolver: resolver as never,
    } as Parameters<typeof tryBulkWriteRoutes>[4];
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({
            workspace: 'B',
            embed: 'inline',
            nodes: [{ id: 'n1', type: 'decision', label: 'Bee node', content: 'body' }],
        })),
        res, '/api/nodes/bulk', '/api/nodes/bulk', deps,
    );
    assert.equal(res._status, 200, `body=${res._body.slice(0, 200)}`);
    const body = JSON.parse(res._body);
    assert.equal(body.succeeded, 1);
    assert.equal(fake.upsertCalls.length, 1, 'graph node upserted');
    // The embedding must have landed in workspace B's store...
    assert.equal(wsB.stored.length, 1, 'inline embed must seed the REQUESTED workspace store');
    assert.equal(wsB.stored[0]!.id, 'lore:n1');
    // ...and NOT in the boot/active store (the L-012 split bug).
    assert.equal(bootVerbatim.stored.length, 0, 'inline embed must NOT seed the boot/active store');
});

test('L-012 fallback: no resolver → inline embed uses boot store (legacy unchanged)', async () => {
    const fake = makeFakeGraph();
    const bootVerbatim = makeFakeVerbatim();
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({
            workspace: 'wsX',
            embed: 'inline',
            nodes: [{ id: 'n2', type: 'decision', label: 'legacy', content: 'x' }],
        })),
        res, '/api/nodes/bulk', '/api/nodes/bulk', makeDeps(fake.graph, bootVerbatim.store),
    );
    assert.equal(res._status, 200, `body=${res._body.slice(0, 200)}`);
    assert.equal(bootVerbatim.stored.length, 1, 'no resolver → boot store still used (back-compat)');
    assert.equal(bootVerbatim.stored[0]!.id, 'lore:n2');
});

/* L-042 — bulk-DELETE must tombstone the verbatim row in the REQUESTED
 * workspace's store (mirroring L-012 on bulk-STORE), not the boot/active one.
 * The per-workspace verbatim resolver was wired into bulk-STORE but not
 * bulk-DELETE, so a cross-workspace bulk delete split the graph delete (ws B)
 * from its tombstone (boot). */
test('L-042 bulk-delete routes verbatim tombstone to requested workspace (not boot)', async () => {
    const seed = [{ id: 'existing-0', type: 'decision', label: 'n0' }];
    const fake = makeFakeGraph({ seedNodes: seed });
    const bootVerbatim = makeFakeVerbatim();      // deps.store.loreVerbatim (boot/active)
    const wsB = makeFakeVerbatim();               // workspace B's LanceDB
    const resolver = {
        getOrOpen: async (ws: string) => {
            if (ws === 'B') return wsB.store as never;
            throw new Error(`workspace_not_found: "${ws}" (known: B)`);
        },
    };
    const deps = {
        ...makeDeps(fake.graph, bootVerbatim.store),
        workspaceVerbatimResolver: resolver as never,
    } as Parameters<typeof tryBulkWriteRoutes>[4];
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'B', ids: ['existing-0'] })),
        res, '/api/nodes/bulk-delete', '/api/nodes/bulk-delete', deps,
    );
    assert.equal(res._status, 200, `body=${res._body.slice(0, 200)}`);
    const body = JSON.parse(res._body);
    assert.equal(body.deleted, 1);
    // Tombstone (fire-and-forget) must have hit workspace B's store...
    await new Promise((r) => setImmediate(r)); // let the .catch()-guarded op settle
    assert.equal(wsB.tombstoned.length, 1, 'tombstone must hit the REQUESTED workspace store');
    assert.equal(wsB.tombstoned[0], 'lore:existing-0');
    // ...and NOT the boot/active store (the L-042 split bug).
    assert.equal(bootVerbatim.tombstoned.length, 0, 'tombstone must NOT hit the boot/active store');
});

test('L-042 fallback: no resolver → bulk-delete tombstones boot store (legacy unchanged)', async () => {
    const seed = [{ id: 'existing-1', type: 'decision', label: 'n1' }];
    const fake = makeFakeGraph({ seedNodes: seed });
    const bootVerbatim = makeFakeVerbatim();
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsX', ids: ['existing-1'] })),
        res, '/api/nodes/bulk-delete', '/api/nodes/bulk-delete', makeDeps(fake.graph, bootVerbatim.store),
    );
    assert.equal(res._status, 200, `body=${res._body.slice(0, 200)}`);
    await new Promise((r) => setImmediate(r));
    assert.equal(bootVerbatim.tombstoned.length, 1, 'no resolver → boot store still used (back-compat)');
    assert.equal(bootVerbatim.tombstoned[0], 'lore:existing-1');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
