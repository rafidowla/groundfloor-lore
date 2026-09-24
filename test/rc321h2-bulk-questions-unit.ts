#!/usr/bin/env tsx
/**
 * test/rc321h2-bulk-questions-unit.ts — Lore 3.21 step 3(h) round 2 (Opus
 * review): `POST /api/nodes/bulk` now accepts per-node `questions[]` with
 * the SAME alias semantics, limits, and outbox durability as the
 * single-write path (store_node / POST /api/node).
 *
 * Harness copied from test/bulk-write-scope-metadata-unit.ts (recording
 * outbox + recording verbatim store + prototype-swapped SurrealGraph so no
 * embedded DB opens) — exercises the REAL route handler (tryBulkWriteRoutes)
 * against BOTH substrate shapes bulkWrite.ts branches on:
 *   - `localEngine: true`  → the batched `bulkUpsertNodes` branch
 *   - `localEngine: false` → the per-item `upsertOne` (ARCADE/cloud) branch
 *
 * Alias rows are verified by inspecting the recorded outbox entries
 * (verbatim.tombstone / verbatim.upsert), the SAME operationKinds + shapes
 * `core/nodeServiceVerbatim.ts` uses for the single-write path — this test
 * does not re-implement or duplicate that logic, only proves
 * `core/bulkQuestionAliases.ts` calls it correctly from the bulk route.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { rowToLoreNode } from '../packages/lore/src/engines/loreNodeRow.js';
import { aliasRowId } from '../packages/lore/src/core/questionAliases.js';
import type { OutboxStore, OutboxEntry } from '../packages/lore/src/outbox/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

console.log('\n3.21 step 3(h) round 2 — POST /api/nodes/bulk questions[] alias support\n');

/* ---------- recording fakes (copied pattern) ---------- */

type VerbatimDoc = { id: string; text: string; metadata: Record<string, unknown> };

function makeFakeOutboxStore(): { store: OutboxStore; recorded: OutboxEntry[] } {
    const recorded: OutboxEntry[] = [];
    const store: OutboxStore = {
        async record(entry: OutboxEntry) { recorded.push(entry); },
        async markStep() { /* no-op */ },
        async markCompleted() { /* no-op */ },
        async remove() { /* no-op */ },
        async listUnfinished() { return []; },
        async batchRecord(entries: OutboxEntry[]) { for (const e of entries) recorded.push(e); },
    } as unknown as OutboxStore;
    return { store, recorded };
}

function makeFakes(localEngine: boolean) {
    const verbatimWrites: VerbatimDoc[] = [];
    const upsertCalls: Array<Record<string, unknown>> = [];

    const methods = {
        async upsertNode(node: Record<string, unknown>) {
            upsertCalls.push(node);
            return rowToLoreNode(node) as unknown as Record<string, unknown>;
        },
        async bulkUpsertNodes(nodes: Array<Record<string, unknown>>) {
            for (const n of nodes) upsertCalls.push(n);
            return nodes.map((n) => ({ id: n.id as string, ok: true as const }));
        },
        async deleteNode(_id: string) { return true; },
        async getNode(_id: string) { return null; },
        getGraphContext() { return {}; },
    };
    const fakeGraph = localEngine
        ? Object.setPrototypeOf({ ...methods }, SurrealGraph.prototype)
        : { ...methods };

    const fakeVerbatim = { async store(doc: VerbatimDoc) { verbatimWrites.push(doc); } };
    const fakeStorageClient = {
        async verbatimStore(doc: VerbatimDoc) { verbatimWrites.push(doc); },
        async upsertNode(n: Record<string, unknown>) {
            upsertCalls.push(n);
            return rowToLoreNode(n) as never;
        },
        rawGraph() { return fakeGraph; },
    };
    return { fakeGraph, fakeVerbatim, fakeStorageClient, verbatimWrites, upsertCalls };
}

function makeReqWithBody(method: string, body: string): IncomingMessage {
    let consumed = false;
    return {
        method,
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
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

async function postBulk(body: Record<string, unknown>, opts: { localEngine?: boolean; noOutbox?: boolean } = {}) {
    const f = makeFakes(opts.localEngine ?? true);
    const outbox = makeFakeOutboxStore();
    const res = fakeRes();
    const handled = await tryBulkWriteRoutes(
        makeReqWithBody('POST', JSON.stringify(body)), res,
        '/api/nodes/bulk', '/api/nodes/bulk',
        {
            deploymentMode: 'local',
            dataplane: null,
            store: {
                loreGraph: f.fakeGraph as never,
                loreVerbatim: f.fakeVerbatim as never,
                storageClient: f.fakeStorageClient as never,
            } as never,
            auditLog: { log: () => undefined } as never,
            outboxStore: opts.noOutbox ? undefined : outbox.store,
        } as unknown as Parameters<typeof tryBulkWriteRoutes>[4],
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { handled, res, ...f, recorded: outbox.recorded, body: () => JSON.parse(res._body) };
}

const WS = 'rc321h2-ws';

/** Every alias-shaped entry (tombstone or upsert) for `id` across `#q0..#q(MAX-1)`. */
function aliasEntries(recorded: OutboxEntry[], id: string): OutboxEntry[] {
    const ids = new Set(Array.from({ length: 5 }, (_, i) => aliasRowId(id, i)));
    return recorded.filter((e) => {
        const payload = e.payload as { id?: string } | undefined;
        return payload?.id !== undefined && ids.has(payload.id);
    });
}

/* ---------- batched local branch (bulkUpsertNodes) ---------- */

test('local branch: questions[] produces a full tombstone sweep + one verbatim.upsert alias row per question', async () => {
    const { res, recorded } = await postBulk({
        nodes: [{ id: 'n1', type: 'decision', label: 'L', content: 'C', questions: ['how does auth work?', 'what handles login?'] }],
        workspace: WS,
        embed: 'inline',
    }, { localEngine: true });
    assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
    const entries = aliasEntries(recorded, 'n1');
    const tombstones = entries.filter((e) => e.operationKind === 'verbatim.tombstone');
    const upserts = entries.filter((e) => e.operationKind === 'verbatim.upsert');
    assert.equal(tombstones.length, 5, 'must sweep all 5 fixed alias slots, same as the single-write path');
    assert.equal(upserts.length, 2, 'one verbatim.upsert per supplied question');
    const q0 = upserts.find((e) => (e.payload as { id: string }).id === aliasRowId('n1', 0))!;
    assert.equal((q0.payload as { text: string }).text, 'how does auth work?');
    assert.equal((q0.payload as { metadata: { aliasOf: string } }).metadata.aliasOf, 'n1', 'alias metadata must identify its parent');
});

test('local branch: a node WITHOUT `questions` produces NO tombstone/alias-upsert rows at all', async () => {
    const { res, recorded } = await postBulk({
        nodes: [{ id: 'n2', type: 'decision', label: 'L', content: 'C' }],
        workspace: WS,
        embed: 'inline',
    }, { localEngine: true });
    assert.equal(res._status, 200);
    assert.equal(aliasEntries(recorded, 'n2').length, 0, 'a caller that never mentions `questions` must not touch pre-existing aliases');
});

test('local branch: `questions: []` (explicit clear) tombstones all 5 slots but records zero new aliases', async () => {
    const { res, recorded } = await postBulk({
        nodes: [{ id: 'n3', type: 'decision', label: 'L', content: 'C', questions: [] }],
        workspace: WS,
        embed: 'inline',
    }, { localEngine: true });
    assert.equal(res._status, 200);
    const entries = aliasEntries(recorded, 'n3');
    assert.equal(entries.filter((e) => e.operationKind === 'verbatim.tombstone').length, 5);
    assert.equal(entries.filter((e) => e.operationKind === 'verbatim.upsert').length, 0);
});

test('local branch: over-cap questions[] fails the ITEM with invalid_questions_meta, no outbox rows for it at all', async () => {
    const { res, recorded, body } = await postBulk({
        nodes: [
            { id: 'n4-bad', type: 'decision', label: 'L', content: 'C', questions: Array(6).fill('q') },
            { id: 'n4-good', type: 'decision', label: 'L', content: 'C', questions: ['ok question'] },
        ],
        workspace: WS,
        embed: 'inline',
    }, { localEngine: true });
    assert.equal(res._status, 200);
    const parsed = body();
    const badResult = parsed.results.find((r: { id?: string }) => r.id === 'n4-bad');
    assert.equal(badResult.ok, false);
    assert.ok(String(badResult.error).includes('invalid_questions_meta'), badResult.error);
    assert.equal(aliasEntries(recorded, 'n4-bad').length, 0, 'a rejected item must not commit ANY outbox rows, alias or otherwise');
    // The sibling valid item in the SAME batch must be unaffected.
    const goodResult = parsed.results.find((r: { id?: string }) => r.id === 'n4-good');
    assert.equal(goodResult.ok, true);
    assert.equal(aliasEntries(recorded, 'n4-good').filter((e) => e.operationKind === 'verbatim.upsert').length, 1);
});

test('local branch: a too-long single question fails the item, same cap as the single-write path (300 chars)', async () => {
    const { body } = await postBulk({
        nodes: [{ id: 'n5', type: 'decision', label: 'L', content: 'C', questions: ['x'.repeat(301)] }],
        workspace: WS,
        embed: 'inline',
    }, { localEngine: true });
    const r = body().results.find((x: { id?: string }) => x.id === 'n5');
    assert.equal(r.ok, false);
    assert.ok(String(r.error).includes('invalid_questions_meta'));
});

test('local branch: summary/entities/topics AND questions[] both apply on the same item', async () => {
    const { res, recorded, upsertCalls } = await postBulk({
        nodes: [{
            id: 'n6', type: 'decision', label: 'L', content: 'C',
            questions: ['q?'], summary: 'a short summary', entities: ['acme'], topics: ['billing'],
        }],
        workspace: WS,
        embed: 'inline',
    }, { localEngine: true });
    assert.equal(res._status, 200, res._body);
    const node = upsertCalls.find((n) => n.id === 'n6')!;
    const meta = JSON.parse(node.metadata as string);
    assert.equal(meta.summary, 'a short summary');
    assert.deepEqual(meta.entities, ['acme']);
    assert.deepEqual(meta.topics, ['billing']);
    assert.equal(aliasEntries(recorded, 'n6').filter((e) => e.operationKind === 'verbatim.upsert').length, 1);
});

test('local branch: `questions` is never written onto the graph row itself (not a graph field)', async () => {
    const { upsertCalls } = await postBulk({
        nodes: [{ id: 'n7', type: 'decision', label: 'L', content: 'C', questions: ['q?'] }],
        workspace: WS,
        embed: 'inline',
    }, { localEngine: true });
    const node = upsertCalls.find((n) => n.id === 'n7')!;
    assert.equal('questions' in node, false, 'questions must be stripped before reaching targetGraph.upsertNode');
});

/* ---------- ARCADE / per-item branch (upsertOne) ---------- */

test('ARCADE branch: questions[] produces the same tombstone-sweep + alias-upsert shape as the local branch', async () => {
    const { res, recorded } = await postBulk({
        nodes: [{ id: 'a1', type: 'decision', label: 'L', content: 'C', questions: ['q1', 'q2', 'q3'] }],
        workspace: WS,
        embed: 'queued',
    }, { localEngine: false });
    assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
    const entries = aliasEntries(recorded, 'a1');
    assert.equal(entries.filter((e) => e.operationKind === 'verbatim.tombstone').length, 5);
    assert.equal(entries.filter((e) => e.operationKind === 'verbatim.upsert').length, 3);
});

test('ARCADE branch: a node WITHOUT `questions` produces no alias rows', async () => {
    const { res, recorded } = await postBulk({
        nodes: [{ id: 'a2', type: 'decision', label: 'L', content: 'C' }],
        workspace: WS,
        embed: 'queued',
    }, { localEngine: false });
    assert.equal(res._status, 200);
    assert.equal(aliasEntries(recorded, 'a2').length, 0);
});

/* ---------- no outbox wired ---------- */

test('no outboxStore wired: the write still succeeds, alias fan-out is a silent no-op (best-effort, matches item d\'s precedent)', async () => {
    const { res, body } = await postBulk({
        nodes: [{ id: 'n8', type: 'decision', label: 'L', content: 'C', questions: ['q?'] }],
        workspace: WS,
        embed: 'inline',
    }, { localEngine: true, noOutbox: true });
    assert.equal(res._status, 200, res._body);
    assert.equal(body().results[0].ok, true, 'the node write itself must not fail just because outbox/alias fan-out is unavailable');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
