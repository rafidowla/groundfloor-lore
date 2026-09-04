#!/usr/bin/env tsx
/**
 * test/E2-skip-on-write-unit.ts — Sprint E2 producer-side wiring.
 *
 * Pins the new behaviour the E2 commit landed in
 * `packages/lore/src/mcp/http/routes/bulkWrite.ts`:
 *
 *   1. Default bulk POST /api/nodes/bulk uses embed-mode 'queued':
 *      N `node.upsert` outbox rows + 1 `embed.batch` outbox row,
 *      and the inline verbatim store is NOT touched per-item.
 *   2. Explicit `embed: 'inline'` reverts to legacy W2/W9 behaviour:
 *      no `embed.batch` row, per-item `loreVerbatim.store` calls.
 *   3. Explicit `embed: 'skip'` writes N `node.upsert` rows and NO
 *      `embed.batch` row — the vector tier stays empty for those ids.
 *   4. Per-item `embed: 'inline'` override beats the call-level
 *      default (mixed-mode call).
 *   5. Per-item failure semantics from W9 are preserved (invalid
 *      items report ok:false and DO NOT contribute to the embed.batch
 *      payload).
 *   6. workspace_required (Sprint L) still applies — missing workspace
 *      returns 400 with `error: 'workspace_required'`.
 *   7. The hot single POST /api/node code path is untouched by E2 —
 *      this is enforced as a source-level sentinel against
 *      `routes/nodes.ts` (regression sentinel for E-D5).
 *
 * The test drives `tryBulkWriteRoutes` directly with a recording
 * fake OutboxStore + fake graph + fake VerbatimStore so the
 * behaviour is pinned without needing a live daemon.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import type { OutboxEntry, OutboxStore } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
const test = (name: string, fn: () => Promise<void> | void) => {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })());
};

console.log('Sprint E2 — skip-on-write default for bulk lane');

interface FakeNode { id: string; type: string; label: string }
function makeFakeGraph() {
    const upsertCalls: string[] = [];
    const upsertNode = async (n: FakeNode) => {
        upsertCalls.push(n.id);
        return { ...n, project: '*', ecosystem: '*', updatedAt: new Date().toISOString() };
    };
    return {
        upsertCalls,
        graph: {
            upsertNode,
            async addEdge() { /* unused */ },
            async addBidirectionalEdge() { /* unused */ },
            async deleteNode() { return false; },
            async search() { return []; },
            // isWorkspaceGraph (engines/requireWorkspaceGraph.ts) probes for
            // bulkListProjected + queryEdges to decide LOCAL vs ARCADE in
            // handleBulkNodes (bulkWrite.ts). Without these two, this fake
            // failed the probe and every test below silently ran the ARCADE
            // per-id branch (per-node verbatim.upsert rows via
            // bulkEmbedFlush.ts) instead of the LOCAL batched branch
            // (one embed.batch row) the assertions below are written for.
            // Neither body is exercised by handleBulkNodes — only their
            // presence as functions matters for the probe — but they return
            // shapes matching SurrealGraph's (engines/surrealGraph.ts) in
            // case a future test starts exercising them for real.
            async bulkListProjected() {
                return { rows: [], nextCursor: null };
            },
            async queryEdges() {
                return [];
            },
            // bulkUpsertNodes IS exercised by the LOCAL branch — mirrors
            // SurrealGraph.bulkUpsertNodes's per-node error isolation: one
            // call to the fake's own upsertNode per batch item, {id, ok,
            // error} per result, batch continues past a per-node failure.
            async bulkUpsertNodes(batch: FakeNode[]) {
                const results: Array<{ id: string; ok: boolean; error?: string }> = [];
                for (const n of batch) {
                    try {
                        await upsertNode(n);
                        results.push({ id: n.id, ok: true });
                    } catch (err) {
                        results.push({ id: n.id, ok: false, error: (err as Error).message });
                    }
                }
                return results;
            },
        },
    };
}

function makeFakeVerbatim() {
    // The inline embed path in bulkWrite.ts calls
    // `deps.store.storageClient.verbatimStore({ id: 'lore:<id>', ... })`
    // (Sprint 15 facade), NOT `loreVerbatim.store(...)` directly. We
    // record both surfaces here so the fake mirrors the real
    // StorageBundle: `store` stands in for `loreVerbatim` (used by the
    // bulk-delete tombstone path) and `storageClient` stands in for the
    // LoreStorageClient facade whose `verbatimStore` the inline upsert
    // path drives.
    const stored: Array<{ id: string }> = [];
    return {
        stored,
        store: {
            async store(rec: { id: string }) { stored.push({ id: rec.id }); },
            async tombstone() { /* unused */ },
            async delete() { /* unused */ },
        },
        storageClient: {
            async verbatimStore(doc: { id: string }) { stored.push({ id: doc.id }); },
        },
    };
}

function makeFakeOutbox(): { store: OutboxStore; entries: OutboxEntry[] } {
    const entries: OutboxEntry[] = [];
    const store: Partial<OutboxStore> = {
        async record(e: OutboxEntry) { entries.push(e); },
        async batchRecord(es: OutboxEntry[]) { for (const e of es) entries.push(e); },
    };
    return { store: store as OutboxStore, entries };
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
    verbatim: ReturnType<typeof makeFakeVerbatim>,
    outbox?: OutboxStore,
): Parameters<typeof tryBulkWriteRoutes>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        // Mirror the real StorageBundle: loreGraph + loreVerbatim +
        // the Sprint 15 storageClient facade. The bulk inline embed
        // path drives `storageClient.verbatimStore`, so it must be
        // present or inline-mode writes silently no-op against the fake.
        store: {
            loreGraph: graph as never,
            loreVerbatim: verbatim.store as never,
            storageClient: verbatim.storageClient as never,
        } as never,
        auditLog: { log: () => undefined } as never,
        outboxStore: outbox,
    };
}

/* ============================================================
 * 1. Default mode = queued
 * ============================================================ */
test('default bulk POST emits N node.upsert + 1 embed.batch; no inline verbatim store', async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const outbox = makeFakeOutbox();
    const nodes = Array.from({ length: 5 }, (_, i) => ({
        id: `q-${i}`, type: 'decision', label: `Q${i}`, content: `body ${i}`, tags: 't',
    }));
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsQ', nodes })),
        res, '/api/nodes/bulk', '/api/nodes/bulk',
        makeDeps(fake.graph, verbatim, outbox.store),
    );
    assert.equal(res._status, 200, `body=${res._body.slice(0, 200)}`);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.succeeded, 5);
    // Substrate writes ran (idempotent in-line writes from O3 lane).
    assert.equal(fake.upsertCalls.length, 5);
    // Inline verbatim store was NOT touched.
    assert.equal(verbatim.stored.length, 0, 'queued mode must NOT call loreVerbatim.store per-item');
    // Outbox got 5 node.upsert rows + 1 embed.batch row = 6 total.
    assert.equal(outbox.entries.length, 6, `expected 6 outbox rows, got ${outbox.entries.length}`);
    const upsertRows = outbox.entries.filter((e) => e.operationKind === 'node.upsert');
    const embedRows = outbox.entries.filter((e) => e.operationKind === 'embed.batch');
    assert.equal(upsertRows.length, 5);
    assert.equal(embedRows.length, 1);
    const embedPayload = embedRows[0]!.payload as { texts: string[]; targetNodeIds: string[] };
    assert.equal(embedPayload.texts.length, 5);
    assert.equal(embedPayload.targetNodeIds.length, 5);
    assert.equal(embedPayload.targetNodeIds[0], 'lore:q-0');
    assert.equal(embedRows[0]!.workspace, 'wsQ');
});

/* ============================================================
 * 2. Explicit inline mode = legacy
 * ============================================================ */
test("embed: 'inline' restores legacy W2/W9 behaviour (no embed.batch row)", async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const outbox = makeFakeOutbox();
    const nodes = [
        { id: 'i-1', type: 'decision', label: 'I1', content: 'b', tags: '' },
        { id: 'i-2', type: 'decision', label: 'I2', content: 'b', tags: '' },
    ];
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsI', embed: 'inline', nodes })),
        res, '/api/nodes/bulk', '/api/nodes/bulk',
        makeDeps(fake.graph, verbatim, outbox.store),
    );
    assert.equal(res._status, 200);
    assert.equal(verbatim.stored.length, 2, 'inline mode must call loreVerbatim.store per item');
    const embedRows = outbox.entries.filter((e) => e.operationKind === 'embed.batch');
    assert.equal(embedRows.length, 0, 'inline mode must NOT enqueue embed.batch');
});

/* ============================================================
 * 3. Explicit skip = no embed at all
 * ============================================================ */
test("embed: 'skip' writes node.upsert but no embed.batch and no inline verbatim", async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const outbox = makeFakeOutbox();
    const nodes = Array.from({ length: 3 }, (_, i) => ({
        id: `s-${i}`, type: 'decision', label: `S${i}`,
    }));
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsS', embed: 'skip', nodes })),
        res, '/api/nodes/bulk', '/api/nodes/bulk',
        makeDeps(fake.graph, verbatim, outbox.store),
    );
    assert.equal(res._status, 200);
    assert.equal(verbatim.stored.length, 0);
    const embedRows = outbox.entries.filter((e) => e.operationKind === 'embed.batch');
    assert.equal(embedRows.length, 0, 'skip mode must NOT enqueue embed.batch');
    const upsertRows = outbox.entries.filter((e) => e.operationKind === 'node.upsert');
    assert.equal(upsertRows.length, 3);
});

/* ============================================================
 * 4. Per-item override
 * ============================================================ */
test("per-item embed override beats call-level default", async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const outbox = makeFakeOutbox();
    // Call default queued, but item 0 forces inline, item 2 forces skip.
    const nodes = [
        { id: 'mix-0', type: 'decision', label: 'M0', embed: 'inline' },
        { id: 'mix-1', type: 'decision', label: 'M1' },
        { id: 'mix-2', type: 'decision', label: 'M2', embed: 'skip' },
    ];
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsM', nodes })),
        res, '/api/nodes/bulk', '/api/nodes/bulk',
        makeDeps(fake.graph, verbatim, outbox.store),
    );
    assert.equal(res._status, 200);
    // Inline item → 1 verbatim store call.
    assert.equal(verbatim.stored.length, 1);
    assert.equal(verbatim.stored[0]!.id, 'lore:mix-0');
    // embed.batch row covers ONLY the queued item (mix-1).
    const embedRows = outbox.entries.filter((e) => e.operationKind === 'embed.batch');
    assert.equal(embedRows.length, 1);
    const payload = embedRows[0]!.payload as { texts: string[]; targetNodeIds: string[] };
    assert.equal(payload.targetNodeIds.length, 1);
    assert.equal(payload.targetNodeIds[0], 'lore:mix-1');
});

/* ============================================================
 * 5. Per-item failure semantics preserved
 * ============================================================ */
test('invalid items do NOT contribute to the embed.batch payload', async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const outbox = makeFakeOutbox();
    const nodes = [
        { id: 'ok-1', type: 'decision', label: 'OK' },
        { id: 'bad', label: 'missing type' }, // invalid — missing type
        { id: 'ok-2', type: 'decision', label: 'OK2' },
    ];
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsP', nodes })),
        res, '/api/nodes/bulk', '/api/nodes/bulk',
        makeDeps(fake.graph, verbatim, outbox.store),
    );
    const body = JSON.parse(res._body);
    assert.equal(body.count, 3);
    assert.equal(body.succeeded, 2);
    assert.equal(body.results[1]!.ok, false);
    const embedRows = outbox.entries.filter((e) => e.operationKind === 'embed.batch');
    assert.equal(embedRows.length, 1);
    const payload = embedRows[0]!.payload as { texts: string[]; targetNodeIds: string[] };
    assert.equal(payload.targetNodeIds.length, 2, 'bad item must NOT appear in embed.batch payload');
});

/* ============================================================
 * 6. Sprint L workspace_required preserved
 * ============================================================ */
test('missing workspace returns 400 workspace_required (Sprint L invariant)', async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const outbox = makeFakeOutbox();
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ nodes: [{ id: 'x', type: 'decision', label: 'X' }] })),
        res, '/api/nodes/bulk', '/api/nodes/bulk',
        makeDeps(fake.graph, verbatim, outbox.store),
    );
    assert.equal(res._status, 400);
    assert.match(res._body, /workspace_required/);
    assert.equal(outbox.entries.length, 0, 'no outbox rows when workspace missing');
});

/* ============================================================
 * 7. Hot single-write path source-level sentinel (E-D5)
 * ============================================================ */
test('hot single-write path (nodes/postNode.ts) still uses inline embed (E-D5 regression sentinel)', () => {
    // routes/nodes.ts is now a pure (pathname, method) dispatcher — the
    // POST /api/node hot-write handler (with its synchronous inline
    // verbatim seed) was extracted into ./nodes/postNode.ts. The E-D5
    // sentinel asserts against the file that actually owns the hot path.
    const path = join(process.cwd(), 'packages/lore/src/mcp/http/routes/nodes/postNode.ts');
    const src = readFileSync(path, 'utf8');
    // Hot path must reference the verbatim store synchronously — no
    // mention of 'embed.batch' (the bulk-lane queued-mode marker) in
    // this file.
    assert.ok(
        !src.includes('embed.batch'),
        'nodes/postNode.ts must NOT reference embed.batch — hot path stays inline (E-D5 sentinel)',
    );
    assert.match(src, /verbatim|VerbatimStore/i,
        'nodes/postNode.ts must keep referencing the verbatim store on the hot path');
});

/* ============================================================
 * 8. Inline-mode legacy callers: empty embed.batch payload is never written
 * ============================================================ */
test('all-inline call writes zero embed.batch rows even when outboxStore present', async () => {
    const fake = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const outbox = makeFakeOutbox();
    const nodes = Array.from({ length: 4 }, (_, i) => ({
        id: `ai-${i}`, type: 'decision', label: `AI${i}`,
    }));
    const res = fakeRes();
    await tryBulkWriteRoutes(
        makeReqWithBody(JSON.stringify({ workspace: 'wsAI', embed: 'inline', nodes })),
        res, '/api/nodes/bulk', '/api/nodes/bulk',
        makeDeps(fake.graph, verbatim, outbox.store),
    );
    const embedRows = outbox.entries.filter((e) => e.operationKind === 'embed.batch');
    assert.equal(embedRows.length, 0, 'all-inline call must skip the embed.batch flush');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
