#!/usr/bin/env tsx
/**
 * test/bulk-write-scope-metadata-unit.ts — the graph node and its verbatim row
 * are two representations of ONE fact and MUST agree on `project` +
 * `ecosystem`.
 *
 * Why this exists:
 *   Recall now pushes the ecosystem filter INTO the vector query
 *   (recall/retrieve.ts `resolveSeedStore`) rather than filtering after
 *   hydration. That filter matches on the VERBATIM ROW's metadata copy of the
 *   ecosystem, while the authoritative value lives on the GRAPH node. Two bulk
 *   write paths stamped a literal '*' into the verbatim copy while the graph
 *   node kept the caller's real ecosystem:
 *
 *     - `bulkWrite.ts`, batched-local `embed:'inline'` branch — hardcoded
 *       `project: '*', ecosystem: '*'`. It arrived with the batched-upsert
 *       perf work, which (unlike the sibling `upsertOne`) has no returned
 *       `node` object to read, so the '*' was a placeholder, never a decision.
 *       `project` was wrong on EVERY row: the route stamps
 *       project = workspace onto the graph node two dozen lines earlier,
 *       precisely because /api/stats counts on it.
 *     - `bulkEmbedFlush.buildVerbatimSpec` (arcade queued branch) — threaded
 *       `project` but hardcoded `ecosystem: '*'`.
 *
 *   Effect: those nodes were written fine, reported ok, and were reachable by
 *   id — but an ecosystem-scoped semantic recall silently could not see them.
 *   No error, no log, nothing to grep for.
 *
 *   The LOCAL queued path is the control: `outbox/wiring.ts storeEmbedBatch`
 *   already enriches metadata from the live graph node, which is what made the
 *   two paths above look like oversights rather than intent.
 *
 * Harness copied from test/bulk-write-content-hash-unit.ts (recording outbox +
 * recording verbatim store + prototype-swapped SurrealGraph so no embedded DB opens).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { buildVerbatimSpec } from '../packages/lore/src/mcp/http/routes/bulkEmbedFlush.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { rowToLoreNode } from '../packages/lore/src/engines/loreNodeRow.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import { dispatch, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
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

console.log('\nBulk write — verbatim metadata must agree with the graph node on project/ecosystem\n');

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
        async batchRecord(entries: OutboxEntry[]) { for (const e of entries) recorded.push(e); },
    };
    return { store, recorded };
}

/**
 * @param localEngine true → prototype-swapped SurrealGraph, so `isWorkspaceGraph`
 *        passes and the route takes the BATCHED local branch (the one with the
 *        hardcoded '*' metadata). false → a bare object, so the route takes the
 *        per-item `upsertOne` / arcade branch instead.
 */
function makeFakes(localEngine: boolean) {
    const verbatimWrites: VerbatimDoc[] = [];
    const upsertCalls: Array<Record<string, unknown>> = [];

    const methods = {
        async upsertNode(node: Record<string, unknown>) {
            upsertCalls.push(node);
            // Mirror what the engine + rowToLoreNode actually return.
            return rowToLoreNode(node) as unknown as Record<string, unknown>;
        },
        async bulkUpsertNodes(nodes: Array<Record<string, unknown>>) {
            for (const n of nodes) upsertCalls.push(n);
            return nodes.map(() => ({ ok: true as const }));
        },
        async deleteNode(_id: string) { /* no-op */ },
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

async function postBulk(body: Record<string, unknown>, opts: { localEngine?: boolean } = {}) {
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
            outboxStore: outbox.store,
        } as unknown as Parameters<typeof tryBulkWriteRoutes>[4],
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { handled, res, ...f, recorded: outbox.recorded };
}

const WS = 'scope-meta-ws';

/* ---------- M1: the inline batched branch ---------- */

test('M1: bulk inline verbatim metadata carries the node\'s REAL ecosystem, not \'*\'', async () => {
    const { res, verbatimWrites, upsertCalls } = await postBulk({
        nodes: [{ id: 'm1', type: 'decision', label: 'L', content: 'C', ecosystem: 'acme' }],
        workspace: WS,
        embed: 'inline',
    });
    assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);

    const graphNode = rowToLoreNode(upsertCalls[0]!);
    const write = verbatimWrites.find((w) => w.id === 'lore:m1');
    assert.ok(write, 'no verbatim write recorded');
    assert.equal(
        write!.metadata.ecosystem, graphNode.ecosystem,
        `verbatim metadata says ecosystem=${JSON.stringify(write!.metadata.ecosystem)} while the graph node says ` +
        `${JSON.stringify(graphNode.ecosystem)} — an ecosystem-scoped recall will silently not find this node`,
    );
    assert.equal(write!.metadata.ecosystem, 'acme', 'and it must be the value the caller actually supplied');
});

test('M1b: bulk inline verbatim metadata carries the stamped project (= workspace), not \'*\'', async () => {
    const { res, verbatimWrites, upsertCalls } = await postBulk({
        nodes: [{ id: 'm1b', type: 'decision', label: 'L', content: 'C', ecosystem: 'acme' }],
        workspace: WS,
        embed: 'inline',
    });
    assert.equal(res._status, 200);
    const graphNode = rowToLoreNode(upsertCalls[0]!);
    const write = verbatimWrites.find((w) => w.id === 'lore:m1b')!;
    assert.equal(graphNode.project, WS, 'precondition: the route stamps project = workspace on the graph node');
    assert.equal(
        write.metadata.project, WS,
        `verbatim project=${JSON.stringify(write.metadata.project)} disagrees with the graph node's ${WS}`,
    );
});

test("M1c: an omitted ecosystem normalises to '*' on BOTH representations", async () => {
    // '*' is LoreNode.ecosystem's schema DEFAULT and rowToLoreNode's fallback,
    // so "unset" must land as '*' on the graph row AND the verbatim row —
    // agreeing on purpose rather than by luck.
    const { res, verbatimWrites, upsertCalls } = await postBulk({
        nodes: [{ id: 'm1c', type: 'decision', label: 'L', content: 'C' }],
        workspace: WS,
        embed: 'inline',
    });
    assert.equal(res._status, 200);
    const graphNode = rowToLoreNode(upsertCalls[0]!);
    const write = verbatimWrites.find((w) => w.id === 'lore:m1c')!;
    assert.equal(graphNode.ecosystem, '*');
    assert.equal(write.metadata.ecosystem, '*');
});

test('M1d: a multi-ecosystem batch keeps each node with ITS OWN ecosystem', async () => {
    // Guard against "fixing" this by hoisting one ecosystem out of the loop.
    const { res, verbatimWrites } = await postBulk({
        nodes: [
            { id: 'a', type: 'decision', label: 'A', content: 'A', ecosystem: 'alpha' },
            { id: 'b', type: 'decision', label: 'B', content: 'B', ecosystem: 'beta' },
        ],
        workspace: WS,
        embed: 'inline',
    });
    assert.equal(res._status, 200);
    assert.equal(verbatimWrites.find((w) => w.id === 'lore:a')!.metadata.ecosystem, 'alpha');
    assert.equal(verbatimWrites.find((w) => w.id === 'lore:b')!.metadata.ecosystem, 'beta');
});

/* ---------- M2: the arcade queued branch (buildVerbatimSpec) ---------- */

test('M2: buildVerbatimSpec threads the ecosystem through instead of hardcoding \'*\'', async () => {
    const spec = buildVerbatimSpec({
        id: 'm2', text: 'T', type: 'decision', label: 'L', tags: '',
        project: WS, ecosystem: 'acme',
    });
    assert.equal(spec.metadata.ecosystem, 'acme', 'ecosystem must be threaded, like project already was');
    assert.equal(spec.metadata.project, WS);
});

test("M2b: buildVerbatimSpec falls back to '*' when ecosystem is unset", async () => {
    const spec = buildVerbatimSpec({ id: 'm2b', text: 'T', type: 'decision', label: 'L', tags: '', project: WS });
    assert.equal(spec.metadata.ecosystem, '*', "unset must land as '*', matching the schema DEFAULT");
});

test('M2c: the arcade queued route path emits verbatim.upsert rows with the real ecosystem', async () => {
    const { res, recorded } = await postBulk({
        nodes: [{ id: 'm2c', type: 'decision', label: 'L', content: 'C', ecosystem: 'acme' }],
        workspace: WS,
        embed: 'queued',
    }, { localEngine: false });
    assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
    const row = recorded.find((e) => e.steps[0]?.kind === 'verbatim.upsert');
    assert.ok(row, `expected a verbatim.upsert row; got kinds: ${recorded.map((e) => e.steps[0]?.kind).join(', ')}`);
    const payload = row!.steps[0]!.payload as { metadata: Record<string, unknown> };
    assert.equal(payload.metadata.ecosystem, 'acme', 'arcade queued rows must carry the real ecosystem');
    assert.equal(payload.metadata.project, WS);
});

/* ---------- M3: the LOCAL queued path (outbox storeEmbedBatch) ---------- */

/**
 * The third verbatim writer, and the one the shared `core/bulkNodeScope.ts`
 * module could not reach while it lived under `mcp/http/routes/` (outbox must
 * not import from the HTTP layer). It spelled its own "unset" convention:
 * `node?.ecosystem ?? ''`.
 *
 * Reachability, stated precisely (an earlier version of this comment claimed
 * the fallback path is live in production; it is not, and both claims cannot
 * be true at once). All THREE production `wireOutbox` call sites — mcp/server.ts,
 * cli/commands/embed.ts, cli/commands/outbox.ts — DO wire `getGraph`, so on the
 * shipped paths `node` is always resolved and the fallbacks never fire. They
 * are reachable because `getGraph` is OPTIONAL on the input type: a library
 * consumer, a cloud/embed-only wiring, or a test can construct the wiring
 * without it, at which point `node` stays null and EVERY field falls through.
 *
 * That is enough to require them to be correct, and the two that carry scope
 * are held to the shared `core/bulkNodeScope.ts` convention:
 *
 *   - `ecosystem` → `'*'`, never `''`. Not because `'*'` is more matchable —
 *     a `ecosystem = 'acme'` pushdown is strict equality and misses both — but
 *     because `'*'` is the ONE spelling of "unset/wildcard" every other writer
 *     and reader (reconnect.ts, retrieve.ts) recognises.
 *   - `project` → the row's WORKSPACE. This is the more damaging of the two and
 *     was left as `''`: project==workspace is an invariant core/nodeService.ts
 *     enforces, because `GET /api/stats?workspace=<ws>` counts rows with
 *     project === <ws>. A `''` project is the documented cause of stats
 *     under-counting fully-retrievable nodes.
 */
function fakeVerbatimRecorder() {
    return {
        rows: [] as Array<Record<string, unknown>>,
        async bulkUpsertPrebuiltRows(rows: Array<Record<string, unknown>>) { this.rows.push(...rows); },
        async physicalDeleteMany() { return 0; },
        async bulkAddPrebuiltRows() { /* unused */ },
        async store() { /* unused */ },
        async storeBatch() { /* unused */ },
    };
}

class FixedProvider implements EmbeddingProvider {
    public readonly dimension = 4;
    public readonly modelId = 'fake/m3';
    async initialize(): Promise<void> { /* no-op */ }
    async embed(t: string): Promise<number[]> { return this.embedDocument(t); }
    async embedQuery(t: string): Promise<number[]> { return this.embedDocument(t); }
    async embedDocument(_t: string): Promise<number[]> { return [0.1, 0.2, 0.3, 0.4]; }
    async embedDocumentBatch(texts: string[]): Promise<number[][]> { return texts.map(() => [0.1, 0.2, 0.3, 0.4]); }
}

function embedBatchEntry(payload: Record<string, unknown>, workspace?: string): OutboxEntry {
    const now = new Date().toISOString();
    return {
        id: `m3-${Math.random().toString(36).slice(2)}`,
        operation: 'embed.batch', initiator: 'test', createdAt: now, updatedAt: now,
        steps: [], completed: false, workspace, operationKind: 'embed.batch',
        payload, status: 'pending', attempts: 0,
    } as OutboxEntry;
}

/** Drive the REAL wireOutbox storeEmbedBatch closure, WITHOUT a graph getter. */
async function queuedEmbedRows(graph?: unknown, workspace?: string): Promise<Array<Record<string, unknown>>> {
    const verbatim = fakeVerbatimRecorder();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-m3-'));
    const wiring = wireOutbox({
        loreDir: tmp,
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getVerbatim: () => verbatim as never,
        getEmbedder: () => new FixedProvider(),
        ...(graph ? { getGraph: () => graph as never } : {}),
    });
    const subs = (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
    await dispatch(embedBatchEntry({ texts: ['t'], targetNodeIds: ['lore:m3'] }, workspace), subs);
    return verbatim.rows;
}

test("M3: the queued outbox path stamps '*' — not '' — when no graph node is resolvable", async () => {
    const rows = await queuedEmbedRows();
    assert.equal(rows.length, 1, 'one prebuilt row persisted');
    assert.equal(
        rows[0]!.ecosystem, '*',
        "queued verbatim rows must use the shared unset convention ('*'), not an empty string no scoped recall can match",
    );
});

test('M3: the queued outbox path still carries a resolved node\'s REAL ecosystem', async () => {
    // Guard against "fixing" the drift by hardcoding '*' everywhere.
    const graph = {
        async getNode(id: string) {
            return { id, type: 'decision', label: 'L', tags: '', project: 'ws', ecosystem: 'acme', updatedAt: 'u' };
        },
    };
    const rows = await queuedEmbedRows(graph);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.ecosystem, 'acme', "a resolved node's own ecosystem must win over the default");
});

test("M4: the queued outbox path stamps the WORKSPACE as project — not '' — with no graph node", async () => {
    // `project == workspace` is an invariant (core/nodeService.ts enforces it on
    // the single-write path) because GET /api/stats?workspace=<ws> counts rows
    // with project === <ws>. Round 3 normalised `ecosystem` on this exact branch
    // and left `project: node?.project ?? ''` beside it — the strictly worse of
    // the two, since '' breaks a documented invariant rather than a convention.
    const rows = await queuedEmbedRows(undefined, 'acme-ws');
    assert.equal(rows.length, 1, 'one prebuilt row persisted');
    assert.equal(
        rows[0]!.project, 'acme-ws',
        "queued verbatim rows must carry the row's workspace as project; '' makes /api/stats under-count them",
    );
});

test("M4: with no workspace either, project falls back to '*' — never ''", async () => {
    const rows = await queuedEmbedRows();
    assert.equal(rows[0]!.project, '*', "the shared unset convention, not an empty string");
});

test("M4: a resolved node's REAL project still wins over the workspace fallback", async () => {
    // Guard against "fixing" it by hardcoding the workspace everywhere.
    const graph = {
        async getNode(id: string) {
            return { id, type: 'decision', label: 'L', tags: '', project: 'real-project', ecosystem: 'acme', updatedAt: 'u' };
        },
    };
    const rows = await queuedEmbedRows(graph, 'acme-ws');
    assert.equal(rows[0]!.project, 'real-project', "the node's own project is authoritative");
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
