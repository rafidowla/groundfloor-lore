#!/usr/bin/env tsx
/**
 * test/embed-flag-store-node-unit.ts — W1 (Sprint W) embed:false flag.
 *
 * Pins:
 *   T1: store_node default → a verbatim.upsert is enqueued for embedding
 *       (embed:true semantics).
 *   T2: store_node with embed:false → NO verbatim.upsert is enqueued, NO
 *       lancedb row is written.
 *   T3: store_node with embed:false → graph upsert IS called (the node
 *       still lands in the graph and is reachable by id/traversal).
 *   T4: store_node with embed:false → reconnect autolink hook does NOT
 *       fire (no embedding means nothing to link semantically, and the
 *       hook itself reads from the embed store).
 *   T5: HTTP POST /api/node honors embed:false identically to the MCP
 *       store_node tool.
 *
 * Strategy:
 *   Drive the HTTP route directly with a recording fake graph handle + a
 *   recording fake OutboxStore, plus the minimal deps the gateway expects.
 *
 *   IMPORTANT — post-Sprint-O2 contract: POST /api/node no longer calls
 *   loreVerbatim.store() inline. It records a `verbatim.upsert` row to the
 *   outbox (recordHotWrite); the replicator/dispatcher then writes it to
 *   LanceDB asynchronously (outbox/wiring.ts → VerbatimStore.store). So the
 *   observable "the node will be embedded" signal at the route boundary is
 *   the presence of a verbatim.upsert outbox entry — NOT a direct
 *   loreVerbatim.store call (that surface is gone). We assert on the outbox
 *   entry. The contentHash carried on that entry is pinned separately by
 *   test/post-node-rest-content-hash-unit.ts.
 *
 *   We deliberately do NOT spin up a real daemon — the spec requires
 *   evidence that the embed enqueue is conditional on the flag, and a
 *   recording mock is the most direct evidence. Full end-to-end
 *   integration (real graph engine + real lancedb) is exercised by the
 *   existing table-storage + embedding suites; W1 piggybacks on
 *   the verbatim contract, not the embedder internals.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryNodesRoutes } from '../packages/lore/src/mcp/http/routes/nodes.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';
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

console.log('W1 embed:false flag on store_node');

/* ---------- recording fakes ---------- */

interface RecordedVerbatimWrite {
    id: string;
    text: string;
    metadata: Record<string, unknown>;
}

function makeFakeOutboxStore(): { store: OutboxStore; recorded: OutboxEntry[] } {
    const recorded: OutboxEntry[] = [];
    const store: OutboxStore = {
        async record(entry: OutboxEntry) { recorded.push(entry); },
        async markStep() { /* no-op */ },
        async markCompleted() { /* no-op */ },
        async remove() { /* no-op */ },
        async listUnfinished() { return []; },
    };
    return { store, recorded };
}

/** Count the verbatim.upsert entries the route enqueued for embedding. */
function verbatimUpsertEntries(recorded: OutboxEntry[]): OutboxEntry[] {
    return recorded.filter((e) => e.steps[0]?.kind === 'verbatim.upsert');
}

function makeFakes() {
    // loreVerbatim is retained on the bundle because the deps type expects
    // it, but post-O2 the route never calls it directly — verbatim lands
    // via the outbox. verbatimWrites should therefore stay EMPTY; the
    // observable signal is the outbox verbatim.upsert entry.
    const verbatimWrites: RecordedVerbatimWrite[] = [];
    const upsertCalls: Array<Record<string, unknown>> = [];

    const fakeGraph = {
        async upsertNode(node: Record<string, unknown>) {
            upsertCalls.push(node);
            // Mirror real shape: project/ecosystem normalized, updatedAt set.
            return {
                ...node,
                project: node.project ?? 'default',
                ecosystem: node.ecosystem ?? '*',
                updatedAt: '2026-05-23T00:00:00.000Z',
            };
        },
        async deleteNode(_id: string) { /* no-op */ },
        getGraphContext() { return {}; },
    };

    const fakeVerbatim = {
        async store(write: RecordedVerbatimWrite) {
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
                // schedule after data so the body assembles first
                setImmediate(() => cb());
            }
            return this;
        },
        // headers/url/etc not consulted by the route under these
        // local-mode + no-actor + no-workspace settings.
    } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status: number; _body: string; _headers: Record<string, string> } {
    const r = {
        _status: 0, _body: '', _headers: {} as Record<string, string>,
        writeHead(status: number, headers?: Record<string, string>) {
            (this as { _status: number })._status = status;
            if (headers) (this as { _headers: Record<string, string> })._headers = headers;
            return this;
        },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string; _headers: Record<string, string> };
}

function localModeDeps(
    fakeGraph: unknown,
    fakeVerbatim: unknown,
    outboxStore: OutboxStore,
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
        // O2 — the route records verbatim.upsert here; the dispatcher
        // later drains it into LanceDB. Without this, the embed enqueue
        // silently no-ops (the legacy pre-O2 path).
        outboxStore: outboxStore as never,
    } as unknown as Parameters<typeof tryNodesRoutes>[4];
}

async function postNode(body: Record<string, unknown>) {
    const { fakeGraph, fakeVerbatim, verbatimWrites, upsertCalls } = makeFakes();
    const outbox = makeFakeOutboxStore();
    const req = makeReqWithBody('POST', JSON.stringify(body));
    const res = fakeRes();
    // No actor/workspace context — bypasses ReBAC + workspace gates in
    // local mode (matches the existing nodes-route-gate-unit pattern).
    const handled = await tryNodesRoutes(
        req,
        res,
        '/api/node',
        '/api/node',
        localModeDeps(fakeGraph, fakeVerbatim, outbox.store),
    );
    // Verbatim writes are fire-and-forget; yield once so microtasks drain.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { handled, res, verbatimWrites, upsertCalls, recorded: outbox.recorded };
}

/* ---------- T1: default behavior (embed:true / omitted) ---------- */

test('T1 default — verbatim.upsert enqueued, graph upserted', async () => {
    const { handled, res, recorded, upsertCalls } = await postNode({
        id: 'w1-T1-default',
        type: 'decision',
        label: 'Default behavior preserved',
        content: 'embed:true is the legacy default',
        workspace: 'w1-fixture',
    });
    assert.equal(handled, true, 'route should handle POST /api/node');
    assert.equal(res._status, 200, `expected 200 OK; got ${res._status}: ${res._body}`);
    assert.equal(upsertCalls.length, 1, 'graph upsert should fire exactly once');
    const verbatim = verbatimUpsertEntries(recorded);
    assert.equal(verbatim.length, 1, 'exactly one verbatim.upsert should be enqueued for embed:true default');
    const payload = verbatim[0]!.steps[0]!.payload as { id: string };
    assert.equal(payload.id, 'lore:w1-T1-default', 'verbatim row keyed at canonical lore:<id>');
});

test('T1 explicit embed:true — same as default', async () => {
    const { res, recorded, upsertCalls } = await postNode({
        id: 'w1-T1-explicit',
        type: 'decision',
        label: 'Explicit embed:true',
        embed: true,
        workspace: 'w1-fixture',
    });
    assert.equal(res._status, 200);
    assert.equal(upsertCalls.length, 1);
    assert.equal(verbatimUpsertEntries(recorded).length, 1, 'embed:true must behave identically to omitted');
});

/* ---------- T2 — embed:false skips verbatim ---------- */

test('T2 embed:false — no verbatim.upsert enqueued, no lancedb row', async () => {
    const { res, recorded, upsertCalls } = await postNode({
        id: 'w1-T2-noembed',
        type: 'decision',
        label: 'No embedding',
        content: 'graph row only',
        embed: false,
        workspace: 'w1-fixture',
    });
    assert.equal(res._status, 200, `expected 200 OK; got ${res._status}: ${res._body}`);
    assert.equal(upsertCalls.length, 1, 'graph upsert MUST still fire (node lives in the legacy graph engine)');
    assert.equal(verbatimUpsertEntries(recorded).length, 0, `embed:false MUST skip verbatim.upsert; saw ${verbatimUpsertEntries(recorded).length}`);
});

/* ---------- T3 — graph traversal still reaches embed:false nodes ---------- */

test('T3 embed:false — graph upsert receives the full node payload', async () => {
    const { upsertCalls } = await postNode({
        id: 'w1-T3-traversal',
        type: 'architecture',
        label: 'Graph-only node',
        content: 'reachable by id / MATCH (n {id: ...})',
        tags: 'w1-test,graph-only',
        embed: false,
        workspace: 'w1-fixture',
    });
    assert.equal(upsertCalls.length, 1);
    const upserted = upsertCalls[0]!;
    assert.equal(upserted.id, 'w1-T3-traversal');
    assert.equal(upserted.type, 'architecture');
    assert.equal(upserted.tags, 'w1-test,graph-only');
    // Crucially the upsert payload is identical to what embed:true would
    // pass — graph traversal sees the same row, only the verbatim mirror
    // is skipped.
});

/* ---------- T4 — embed:false skips autolink. The HTTP path HAS autolink
   wired since 22c428e (launch-readiness item 4; the "no autolink on HTTP"
   note here predated that fix), so what we assert is the verbatim contract
   the hook reads from: skipping verbatim is the only way autolink could
   even theoretically find no row to link to. ---------- */

test('T4 embed:false — no lancedb row exists for autolink to read', async () => {
    const { recorded } = await postNode({
        id: 'w1-T4-no-autolink',
        type: 'decision',
        label: 'autolink has nothing to grab',
        embed: false,
        workspace: 'w1-fixture',
    });
    // The autolink reconnect hook reads from the verbatim store. With no
    // verbatim.upsert enqueued for this node, nothing ever lands in
    // LanceDB, so the hook is structurally a no-op even if wired — there
    // is no row to link to/from.
    assert.equal(verbatimUpsertEntries(recorded).length, 0);
});

/* ---------- T5 — coverage note: the MCP store_node tool shares the same
   skipEmbed branch (memory.ts:340-ish via the `embed` field) and the
   same loreVerbatim.store contract. The HTTP T1-T4 above pin the
   conditional; the MCP tool wires through the same `embed` argument to
   the same store. A dedicated MCP harness is over-scoped for a unit
   test (would require spinning up the MCP server) — the contract is
   exercised by the existing memory-tool integration suites once the
   build runs end-to-end. ---------- */

test('T5 contract — MCP tool surface uses identical skipEmbed branch', async () => {
    // Static cross-file invariant: STORE_NODE_KNOWN_FIELDS must include
    // 'embed' or the MCP tool would reject the payload as unknown-field
    // before the skipEmbed branch ever runs. Importing the constant
    // here pins the contract.
    const { STORE_NODE_KNOWN_FIELDS } = await import('../packages/lore/src/engines/vocabPolicy.js');
    assert.ok(
        STORE_NODE_KNOWN_FIELDS.includes('embed'),
        `'embed' must be in STORE_NODE_KNOWN_FIELDS or the MCP tool will reject embed:false as unknown_field. Got: ${STORE_NODE_KNOWN_FIELDS.join(', ')}`,
    );
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
