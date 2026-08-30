#!/usr/bin/env tsx
/**
 * test/post-node-rest-content-hash-unit.ts — PR #69 P2 contract test at
 * the REST surface (POST /api/node → outbox payload).
 *
 * Why this test exists:
 *   PR #70 (the implementation of PR #69's proposal) ships a
 *   contentHash population at three callsites:
 *     1. storeNode.ts (MCP tool inline-verbatim path)
 *     2. postNode.ts (REST route outbox payload)    ← THIS TEST
 *     3. embed/wiring.ts (EmbedQueue executor)
 *   The engine-level safety net (verbatimStore.store auto-computes
 *   when caller omits the hash) means a regression that drops the
 *   contentHash population from any callsite would still work — but
 *   silently, at the cost of recomputing the hash on every write.
 *   That's precisely the failure mode the original PR #69 bug
 *   exhibited for months. This test asserts the CONTRACT at the
 *   callsite where it must be honored.
 *
 *   Per workflow critique (PR #70): all 45 PR-70 tests bypass the
 *   REST + MCP tool surfaces. The contentHash flow on storeNode.ts
 *   and postNode.ts has ZERO coverage without this test (and its MCP
 *   sibling). A refactor that drops `contentHash: computeContentHash(...)`
 *   from postNode.ts would still pass the full PR #70 suite — and
 *   only this test would catch it.
 *
 * What this test pins (REST-route layer):
 *   R1. POST /api/node default → outboxStore.record() receives an
 *       entry whose verbatim.upsert payload.metadata.contentHash
 *       equals computeContentHash(buildVerbatimText(label, content, tags)).
 *   R2. POST /api/node with embed:false → no verbatim.upsert outbox
 *       entry written (and no contentHash to assert) — pins that the
 *       skip path doesn't accidentally still emit a stale-metadata
 *       payload.
 *   R3. The contentHash matches the EXACT bytes that would be embedded
 *       (i.e. matches what verbatimStore.store() would auto-compute if
 *       it had to — proving the two sides agree).
 *   R4. The outbox payload's `text` field is the SAME verbatim text the
 *       hash was computed over (catches a refactor that hashes one
 *       buffer and writes a different one).
 *
 * Modeled on test/embed-flag-store-node-unit.ts (same recording-fakes
 * + tryNodesRoutes pattern; same minimum local-mode deps). The new
 * piece is a recording outboxStore stub.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryNodesRoutes } from '../packages/lore/src/mcp/http/routes/nodes.js';
import { computeContentHash } from '../packages/lore/src/engines/contentHash.js';
import { buildVerbatimText } from '../packages/lore/src/engines/verbatimSchema.js';
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

console.log('PR #69 P2 — REST contentHash population (POST /api/node)');

/* ---------- recording fakes ---------- */

function makeFakeOutboxStore(): { store: OutboxStore; recorded: OutboxEntry[] } {
    const recorded: OutboxEntry[] = [];
    const store: OutboxStore = {
        async record(entry: OutboxEntry) {
            recorded.push(entry);
        },
        async markStep() { /* no-op */ },
        async markCompleted() { /* no-op */ },
        async remove() { /* no-op */ },
        async listUnfinished() { return []; },
    };
    return { store, recorded };
}

function makeFakes() {
    const verbatimWrites: Array<{ id: string; text: string; metadata: Record<string, unknown> }> = [];
    const upsertCalls: Array<Record<string, unknown>> = [];

    const fakeGraph = {
        async upsertNode(node: Record<string, unknown>) {
            upsertCalls.push(node);
            return {
                ...node,
                project: node.project ?? 'default',
                ecosystem: node.ecosystem ?? '*',
                updatedAt: '2026-06-09T00:00:00.000Z',
            };
        },
        async deleteNode(_id: string) { /* no-op */ },
        getGraphContext() { return {}; },
    };

    const fakeVerbatim = {
        async store(write: { id: string; text: string; metadata: Record<string, unknown> }) {
            verbatimWrites.push(write);
        },
    };

    return { fakeGraph, fakeVerbatim, verbatimWrites, upsertCalls };
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
            if (event === 'end') {
                setImmediate(() => cb());
            }
            return this;
        },
    } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) {
            (this as { _status: number })._status = status;
            return this;
        },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

function localModeDeps(
    fakeGraph: unknown,
    fakeVerbatim: unknown,
    outboxStore: OutboxStore | null,
): Parameters<typeof tryNodesRoutes>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: {
            loreGraph: fakeGraph as never,
            loreVerbatim: fakeVerbatim as never,
        } as never,
        auditLog: { append: () => undefined } as never,
        coreNodeTypes: ['decision', 'convention', 'bug_pattern', 'architecture', 'troubleshooting'],
        outboxStore: outboxStore ?? undefined,
    } as unknown as Parameters<typeof tryNodesRoutes>[4];
}

async function postNode(
    body: Record<string, unknown>,
    opts: { withOutbox: boolean } = { withOutbox: true },
) {
    const { fakeGraph, fakeVerbatim, verbatimWrites, upsertCalls } = makeFakes();
    const outbox = opts.withOutbox ? makeFakeOutboxStore() : null;
    const req = makeReqWithBody('POST', JSON.stringify(body));
    const res = fakeRes();
    const handled = await tryNodesRoutes(
        req,
        res,
        '/api/node',
        '/api/node',
        localModeDeps(fakeGraph, fakeVerbatim, outbox?.store ?? null),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { handled, res, verbatimWrites, upsertCalls, recorded: outbox?.recorded ?? [] };
}

/* ---------- R1: contentHash lands in outbox payload ---------- */

test('R1 default — verbatim.upsert outbox entry contains contentHash matching the verbatim text', async () => {
    const label = 'PR #69 P2 contract';
    const content = 'verbatim text body, used to seed the hash';
    const tags = 'pr69,p2,contract';
    const { recorded } = await postNode({
        id: 'rest-r1',
        type: 'decision',
        label, content, tags,
        workspace: 'pr69-fixture',
    });

    // Two outbox entries expected: one node.upsert + one verbatim.upsert.
    // We assert only the verbatim.upsert payload here.
    const verbatimEntry = recorded.find(e =>
        e.steps[0]?.kind === 'verbatim.upsert',
    );
    assert.ok(verbatimEntry, `verbatim.upsert outbox entry not found; got ${recorded.map(r => r.steps[0]?.kind).join(', ')}`);
    const payload = verbatimEntry!.steps[0]!.payload as { text: string; metadata: { contentHash?: string } };
    assert.ok(payload.metadata, 'payload must include metadata');
    assert.ok(payload.metadata.contentHash, `payload.metadata.contentHash MUST be present (PR #69 P2). Got: ${JSON.stringify(payload.metadata)}`);

    // R3 implicit: hash matches what computeContentHash would produce
    // for the SAME verbatim text we sent. This is the contract.
    const expectedText = buildVerbatimText(label, content, tags);
    const expectedHash = computeContentHash(expectedText);
    assert.equal(
        payload.metadata.contentHash,
        expectedHash,
        `contentHash mismatch — REST callsite computed ${payload.metadata.contentHash}, expected ${expectedHash}. ` +
        `A refactor likely changed buildVerbatimText input or hashed the wrong buffer.`,
    );
});

/* ---------- R2: embed:false skips verbatim outbox entry entirely ---------- */

test('R2 embed:false — no verbatim.upsert outbox entry (no contentHash payload to leak)', async () => {
    const { recorded } = await postNode({
        id: 'rest-r2-noembed',
        type: 'decision',
        label: 'graph only',
        content: 'no embedding needed',
        embed: false,
        workspace: 'pr69-fixture',
    });
    const verbatimEntries = recorded.filter(e => e.steps[0]?.kind === 'verbatim.upsert');
    assert.equal(verbatimEntries.length, 0, `embed:false MUST skip verbatim.upsert; saw ${verbatimEntries.length}`);
});

/* ---------- R3 (explicit): hash is over exact bytes that will be embedded ---------- */

test('R3 — outbox text field equals the bytes hashed, no off-by-one', async () => {
    const label = 'unicode 日本語';
    const content = 'multi\nline\ncontent with tabs\there';
    const tags = 'tag1,tag2';
    const { recorded } = await postNode({
        id: 'rest-r3',
        type: 'decision',
        label, content, tags,
        workspace: 'pr69-fixture',
    });
    const verbatimEntry = recorded.find(e => e.steps[0]?.kind === 'verbatim.upsert');
    assert.ok(verbatimEntry);
    const payload = verbatimEntry!.steps[0]!.payload as { text: string; metadata: { contentHash: string } };

    const expectedText = buildVerbatimText(label, content, tags);
    assert.equal(
        payload.text,
        expectedText,
        'outbox payload.text must be the same bytes used to compute contentHash',
    );
    assert.equal(payload.metadata.contentHash, computeContentHash(payload.text));
});

/* ---------- R4: when outboxStore is unwired, verbatim outbox path silently skips ---------- */

test('R4 — outboxStore unwired → no verbatim.upsert entry (legacy path)', async () => {
    // Pre-Sprint-O2 deployments don't wire outboxStore; the route
    // silently no-ops the outbox entry. This isn't a P2 bug — it's
    // pre-existing — but the test pins the conditional: contentHash
    // is populated only when there IS an outbox to populate.
    const { recorded } = await postNode(
        {
            id: 'rest-r4',
            type: 'decision',
            label: 'no outbox',
            workspace: 'pr69-fixture',
        },
        { withOutbox: false },
    );
    assert.equal(recorded.length, 0, 'no outbox → no recorded entries');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
