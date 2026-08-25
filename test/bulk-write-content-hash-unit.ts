#!/usr/bin/env tsx
/**
 * test/bulk-write-content-hash-unit.ts — PR #69 P2 contract test at the
 * bulk-write REST surface (POST /api/nodes/bulk).
 *
 * Why this test exists:
 *   The thorough cross-surface validation workflow flagged the bulk
 *   inline-mode path (bulkWrite.ts:upsertOne, inline branch) as
 *   building verbatim metadata WITHOUT contentHash — same pattern as
 *   the original PR #69 bug at storeNode.ts and postNode.ts. The
 *   engine-level safety net masked it; this test pins the contract
 *   so a future refactor that drops the population would fail loudly.
 *
 * What this test pins:
 *   B1. Bulk inline path → storageClient.verbatimStore receives
 *       metadata.contentHash = computeContentHash(
 *         buildVerbatimText(label, content, tags)
 *       ) for every item in the batch.
 *   B2. Bulk embed='skip' path → storageClient.verbatimStore NOT
 *       called (no contentHash to assert; pins the skip branch).
 *   B3. Bulk embed='queued' path → embed.batch outbox row emitted
 *       with texts in batch order; per-item verbatimStore NOT called
 *       (contentHash belongs to the batch executor on this path).
 *   B4. text field matches the bytes the hash was computed over.
 *
 * Pattern modeled on test/bulk-write-w9-unit.ts + the PR #70 single-
 * write test/post-node-rest-content-hash-unit.ts (recording outbox +
 * recording verbatimStore stubs).
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { computeContentHash } from '../packages/lore/src/engines/contentHash.js';
import { buildVerbatimText } from '../packages/lore/src/engines/verbatimStore.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import type { OutboxStore, OutboxEntry } from '../packages/lore/src/outbox/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

console.log('PR #69 P2 — Bulk write contentHash population (POST /api/nodes/bulk)');

/* ---------- recording fakes ---------- */

type VerbatimDoc = { id: string; text: string; metadata: Record<string, unknown> };

function makeFakeOutboxStore(): { store: OutboxStore; recorded: OutboxEntry[] } {
    const recorded: OutboxEntry[] = [];
    const store: OutboxStore = {
        async record(entry: OutboxEntry) { recorded.push(entry); },
        async markStep() { /* no-op */ },
        async markCompleted() { /* no-op */ },
        async remove() { /* no-op */ },
        async listUnfinished() { return []; },
        // O3: bulk path uses batchRecord (preferred) and falls back to record
        async batchRecord(entries: OutboxEntry[]) {
            for (const e of entries) recorded.push(e);
        },
    };
    return { store, recorded };
}

function makeFakes() {
    const verbatimWrites: VerbatimDoc[] = [];
    const upsertCalls: Array<Record<string, unknown>> = [];

    // The fake must be recognized by isWorkspaceGraph (capability probe:
    // bulkListProjected + queryEdges present on the prototype chain) so the
    // bulk route takes the LOCAL branch this test documents: batched
    // bulkUpsertNodes + ONE embed.batch outbox row in queued mode. (The arcade/
    // non-local branch instead emits per-node verbatim.upsert rows — a different
    // path, covered by the arcade e2e.) We set the prototype rather than
    // constructing a real SurrealGraph so no embedded DB is opened; only the
    // methods the bulk path calls are stubbed.
    const fakeGraph = Object.setPrototypeOf({
        async upsertNode(node: Record<string, unknown>) {
            upsertCalls.push(node);
            return {
                ...node,
                project: node.project ?? 'default',
                ecosystem: node.ecosystem ?? '*',
                updatedAt: '2026-06-09T00:00:00.000Z',
            };
        },
        // LOCAL batch path (RA2-reaudit2) — one write-lane trip. Returns a
        // per-item {ok} result array aligned with the input order.
        async bulkUpsertNodes(nodes: Array<Record<string, unknown>>) {
            for (const n of nodes) upsertCalls.push(n);
            return nodes.map(() => ({ ok: true as const }));
        },
        async deleteNode(_id: string) { /* no-op */ },
        async getNode(_id: string) { return null; },
        getGraphContext() { return {}; },
    }, SurrealGraph.prototype);

    // The bulk-nodes inline path builds a per-workspace target facade
    // (LoreStorageClient.fromLocal({ verbatim: targetVerbatim, … }), L-012/SP-20)
    // and calls target.verbatimStore(doc) → this.v().store(doc) → the resolved
    // workspace's verbatim store, which (with no resolver wired) falls back to
    // deps.store.loreVerbatim. So the inline verbatim seed lands HERE, not on
    // deps.store.storageClient.verbatimStore. Record at this layer.
    const fakeVerbatim = {
        async store(doc: VerbatimDoc) { verbatimWrites.push(doc); },
    };

    const fakeStorageClient = {
        // Retained for any path that routes through the boot facade directly;
        // the bulk-nodes inline path uses the per-workspace target above.
        async verbatimStore(doc: VerbatimDoc) { verbatimWrites.push(doc); },
        async upsertNode(_n: unknown) { return _n as never; },
    };

    return { fakeGraph, fakeVerbatim, fakeStorageClient, verbatimWrites, upsertCalls };
}

function makeReqWithBody(method: string, body: string): IncomingMessage {
    let consumed = false;
    return {
        method,
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

function bulkDeps(
    fakeGraph: unknown,
    fakeVerbatim: unknown,
    fakeStorageClient: unknown,
    outboxStore: OutboxStore | null,
): Parameters<typeof tryBulkWriteRoutes>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: {
            loreGraph: fakeGraph as never,
            loreVerbatim: fakeVerbatim as never,
            storageClient: fakeStorageClient as never,
        } as never,
        auditLog: { log: () => undefined } as never,
        outboxStore: outboxStore ?? undefined,
    } as unknown as Parameters<typeof tryBulkWriteRoutes>[4];
}

async function postBulk(body: Record<string, unknown>) {
    const { fakeGraph, fakeVerbatim, fakeStorageClient, verbatimWrites, upsertCalls } = makeFakes();
    const outbox = makeFakeOutboxStore();
    const req = makeReqWithBody('POST', JSON.stringify(body));
    const res = fakeRes();
    const handled = await tryBulkWriteRoutes(
        req, res,
        '/api/nodes/bulk',
        '/api/nodes/bulk',
        bulkDeps(fakeGraph, fakeVerbatim, fakeStorageClient, outbox.store),
    );
    // Allow microtasks for fire-and-forget verbatim writes to land.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { handled, res, verbatimWrites, upsertCalls, recorded: outbox.recorded };
}

/* ---------- B1: inline contentHash ---------- */

test('B1 inline default — every verbatim write carries contentHash matching its text', async () => {
    const items = [
        { id: 'bulk-1', type: 'decision', label: 'L1', content: 'C1', tags: 't1' },
        { id: 'bulk-2', type: 'decision', label: 'L2', content: 'C2', tags: 't2' },
        { id: 'bulk-3', type: 'decision', label: 'L3', content: 'C3', tags: 't3' },
    ];
    const { res, verbatimWrites } = await postBulk({
        nodes: items,
        workspace: 'pr69-bulk',
        embed: 'inline',
    });

    assert.equal(res._status, 200, `expected 200 OK; got ${res._status}: ${res._body}`);
    assert.equal(verbatimWrites.length, items.length, `expected ${items.length} verbatim writes; got ${verbatimWrites.length}`);

    for (const item of items) {
        const write = verbatimWrites.find(w => w.id === `lore:${item.id}`);
        assert.ok(write, `missing verbatim write for ${item.id}`);
        const md = write!.metadata as { contentHash?: string };
        assert.ok(md.contentHash, `bulk inline write for ${item.id} MUST populate contentHash. Got: ${JSON.stringify(md)}`);
        const expectedText = buildVerbatimText(item.label, item.content, item.tags);
        assert.equal(md.contentHash, computeContentHash(expectedText), `contentHash mismatch for ${item.id}`);
        // B4: text matches the bytes hashed
        assert.equal(write!.text, expectedText);
    }
});

/* ---------- B2: skip mode ---------- */

test("B2 embed='skip' — no verbatim writes regardless of node count", async () => {
    const { res, verbatimWrites } = await postBulk({
        nodes: [
            { id: 'skip-1', type: 'decision', label: 'L1' },
            { id: 'skip-2', type: 'decision', label: 'L2' },
        ],
        workspace: 'pr69-bulk',
        embed: 'skip',
    });
    assert.equal(res._status, 200);
    assert.equal(verbatimWrites.length, 0, `embed=skip MUST skip every verbatim write; saw ${verbatimWrites.length}`);
});

/* ---------- B3: queued mode emits embed.batch outbox row ---------- */

test("B3 embed='queued' — one embed.batch outbox row covering every item; no per-item verbatim writes", async () => {
    const items = [
        { id: 'q-1', type: 'decision', label: 'L1', content: 'C1', tags: '' },
        { id: 'q-2', type: 'decision', label: 'L2', content: 'C2', tags: '' },
    ];
    const { res, verbatimWrites, recorded } = await postBulk({
        nodes: items,
        workspace: 'pr69-bulk',
        embed: 'queued',
    });
    assert.equal(res._status, 200);
    assert.equal(verbatimWrites.length, 0, "queued mode does not perform inline writes");

    // Find the embed.batch entry; the bulk path also writes node.upsert
    // entries — we only care about the embed.batch one here.
    const embedBatch = recorded.find(e => e.steps[0]?.kind === 'embed.batch');
    assert.ok(embedBatch, `expected embed.batch outbox entry; got kinds: ${recorded.map(e => e.steps[0]?.kind).join(', ')}`);
    const payload = embedBatch!.steps[0]!.payload as { texts: string[]; targetNodeIds: string[] };
    assert.equal(payload.texts.length, items.length);
    assert.equal(payload.targetNodeIds.length, items.length);
    for (let i = 0; i < items.length; i++) {
        const expectedText = buildVerbatimText(items[i]!.label, items[i]!.content, items[i]!.tags);
        assert.equal(payload.texts[i], expectedText, `text[${i}] mismatch`);
        assert.equal(payload.targetNodeIds[i], `lore:${items[i]!.id}`);
    }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
