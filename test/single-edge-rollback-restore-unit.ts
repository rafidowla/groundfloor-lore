#!/usr/bin/env tsx
/**
 * single-edge-rollback-restore-unit.ts — 3.26.0: a failed single-edge write
 * or delete leaves nothing behind, on all four doors (POST /api/edge, DELETE
 * /api/edge, MCP store_edge, MCP delete_edge).
 *
 * The defect: each door records its outbox row before the graph write. A write
 * that then failed kept the row (store_edge retracted it only for a missing
 * endpoint, and then with a forward edge.delete whatever the triple held), so
 * the replicator later applied an operation whose caller had been told it
 * failed: an edge appeared, an existing edge changed, or an edge that was
 * still there was removed. A bidirectional write that failed on the reverse
 * direction also left the forward edge in the graph.
 *
 * The fix (mcp/edgeWriteRollback.ts), pinned here against a real SQLite graph,
 * a real FileOutboxStore and the real outbox dispatcher:
 *   - the edge is read before the row is recorded; a failed read rejects the
 *     call with nothing written or queued;
 *   - a failed write is undone inline, per direction;
 *   - the row is removed while pending; once claimed, compensating rows replay
 *     to the prior state.
 *
 * Also pinned here, same release: the three writers of the `supersedes` edge
 * take the edge lock and queue a ONE-WAY row (replay wrote the reverse edge
 * too), and POST /api/node/unsupersede queues its edge delete (a still-queued
 * supersede row replayed after it and brought the edge back).
 *
 * Run: npx tsx test/single-edge-rollback-restore-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { tryEdgesRoutes } from '../packages/lore/src/mcp/http/routes/edges.js';
import { registerStoreEdgeTool } from '../packages/lore/src/mcp/tools/memory/storeEdge.js';
import { registerDeleteEdgeTool } from '../packages/lore/src/mcp/tools/memory/deleteEdge.js';
import { registerSupersedeNodeTool } from '../packages/lore/src/mcp/tools/memory/supersedeNode.js';
import { handleSupersede, handleUnsupersede } from '../packages/lore/src/mcp/http/routes/nodes/supersede.js';
import type { MemoryToolsDeps } from '../packages/lore/src/mcp/tools/memory/types.js';
import { deleteEdgeOrRestore, writeEdgeOrRestore } from '../packages/lore/src/mcp/edgeWriteRollback.js';
import { applyWriteTimeSupersedes } from '../packages/lore/src/core/supersessionPolicy.js';
import { withEdgeLock } from '../packages/lore/src/core/nodeWriteLock.js';
import { dispatch, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import type { LoreEdge } from '../packages/lore/src/providers/types.js';
import type { OutboxEntry, OutboxStore } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const REL = 'depends_on';
const tmpDirs: string[] = [];
const mkTmp = (prefix: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; };

// ───────────────────────── rig: real graph, real outbox, real replay ─────────────────────────

type Door = 'http' | 'mcp';
const DOORS: Door[] = ['http', 'mcp'];
const SAVE_INITIATOR: Record<Door, string> = { http: 'http:POST /api/edge', mcp: 'mcp:store_edge' };
const DELETE_INITIATOR: Record<Door, string> = { http: 'http:DELETE /api/edge', mcp: 'mcp:delete_edge' };

interface Rig {
    graph: SqliteGraph;
    outbox: FileOutboxStore;
    ws: string;
    substrates: DispatcherSubstrates;
    wal: Array<{ op: string; payload: Record<string, unknown> }>;
}

let rigSeq = 0;
async function rig(): Promise<Rig> {
    const ws = `single-edge-restore-${++rigSeq}`;
    const graph = new SqliteGraph(mkTmp('single-edge-g-'), { workspaceId: ws });
    const outbox = new FileOutboxStore(mkTmp('single-edge-o-'));
    await graph.initialize();
    for (const id of ['a', 'b', 'c']) {
        await graph.upsertNode({ id, type: 'note', label: id, content: `node ${id}`, tags: [], project: ws, ecosystem: '*', metadata: '{}' } as never);
    }
    const wiring = wireOutbox({
        loreDir: mkTmp('single-edge-w-'),
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => graph as never,
        getVerbatim: () => null as never,
    });
    const substrates = (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
    return { graph, outbox, ws, substrates, wal: [] };
}
const closeRig = async (r: Rig): Promise<void> => { await r.graph.close().catch(() => undefined); };

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
function reqWithBody(method: string, body: string): IncomingMessage {
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

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type ToolBag = Record<string, (args: Record<string, unknown>) => Promise<ToolResult>>;
function mcpTools(r: Rig, graph: unknown = r.graph, outbox: OutboxStore | undefined = r.outbox): ToolBag {
    const tools: ToolBag = {};
    const server = {
        tool: (name: string, ...rest: unknown[]) => {
            const handler = rest[rest.length - 1];
            if (typeof handler === 'function') tools[name] = handler as ToolBag[string];
        },
    };
    const deps = {
        store: { loreGraph: graph } as never,
        configManager: {} as never,
        auditLog: { log: () => undefined } as never,
        detectedScope: { workspace: r.ws, ecosystem: '*' },
        getWal: () => ({ append: (op: string, payload: Record<string, unknown>) => { r.wal.push({ op, payload }); } }),
        domain: 'lore',
        edgeRelations: [REL, 'supersedes'],
        nodeTypesEnum: z.enum(['note']),
        nodeTypesDescription: 'note',
        edgeRelationsEnum: z.enum([REL, 'supersedes']),
        outboxStore: outbox as never,
        coreNodeTypes: ['note'],
    } as unknown as MemoryToolsDeps;
    registerStoreEdgeTool(server as never, deps);
    registerDeleteEdgeTool(server as never, deps);
    registerSupersedeNodeTool(server as never, deps);
    return tools;
}

interface Outcome { ok: boolean; status: number; text: string }
interface SaveBody { sourceId: string; targetId: string; bidirectional: boolean; confidence?: string; confidenceScore?: number }

/** Save one edge through a door. `ok` is the caller-visible success. */
async function save(door: Door, r: Rig, e: SaveBody, graph: unknown = r.graph, outbox: OutboxStore | undefined = r.outbox): Promise<Outcome> {
    if (door === 'http') {
        const res = fakeRes();
        await tryEdgesRoutes(
            reqWithBody('POST', JSON.stringify({ ...e, relation: REL, workspace: r.ws })), res, '/api/edge', '/api/edge',
            { deploymentMode: 'local', dataplane: null, store: { loreGraph: graph } as never, outboxStore: outbox as never, auditLog: { log: () => undefined } as never },
        );
        return { ok: res._status === 200, status: res._status, text: res._body };
    }
    const out = await mcpTools(r, graph, outbox)['store_edge']!({ ...e, relation: REL, workspace: r.ws });
    return { ok: !out.isError, status: out.isError ? 500 : 200, text: out.content[0]!.text };
}

/** Delete one edge through a door. `ok` is "the call did not error" (a no-match delete is ok on MCP, 404 on HTTP). */
async function del(door: Door, r: Rig, sourceId: string, targetId: string, graph: unknown = r.graph, outbox: OutboxStore | undefined = r.outbox): Promise<Outcome> {
    if (door === 'http') {
        const res = fakeRes();
        await tryEdgesRoutes(
            { method: 'DELETE', on: () => undefined } as unknown as IncomingMessage, res,
            `/api/edge?sourceId=${sourceId}&targetId=${targetId}&relation=${REL}&workspace=${r.ws}`, '/api/edge',
            { deploymentMode: 'local', dataplane: null, store: { loreGraph: graph } as never, outboxStore: outbox as never, auditLog: { log: () => undefined } as never },
        );
        return { ok: res._status === 200, status: res._status, text: res._body };
    }
    const out = await mcpTools(r, graph, outbox)['delete_edge']!({ source_id: sourceId, target_id: targetId, relation: REL, workspace: r.ws });
    return { ok: !out.isError, status: out.isError ? 500 : 200, text: out.content[0]!.text };
}

const pendingRows = (r: Rig) => r.outbox.listPendingForWorkspace(r.ws, 10_000);
const seenIds = async (r: Rig): Promise<Set<string>> => new Set((await pendingRows(r)).map((e) => e.id));
const newRows = async (r: Rig, seen: Set<string>): Promise<OutboxEntry[]> => (await pendingRows(r)).filter((e) => !seen.has(e.id));
/** Replay every row the call under test left behind, in commit order. */
async function replayNew(r: Rig, seen: Set<string>): Promise<OutboxEntry[]> {
    const rows = await newRows(r, seen);
    for (const e of rows) await dispatch(e, r.substrates);
    return rows;
}
const kinds = (rows: OutboxEntry[]) => rows.map((e) => e.operationKind);
async function edgesOf(r: Rig): Promise<string[]> {
    return (await r.graph.queryEdges({ limit: 1000, offset: 0 }))
        .map((e) => `${e.sourceId}>${e.targetId}:${e.confidence}:${e.confidenceScore}`).sort();
}
/** The replicator already claimed every row: `removeIfPending` answers false. */
function claimRows(r: Rig): void {
    (r.outbox as unknown as { removeIfPending: (id: string) => Promise<boolean> }).removeIfPending = async () => false;
}
type RawGraph = {
    addEdge(e: LoreEdge): Promise<void>;
    addBidirectionalEdge(e: LoreEdge): Promise<void>;
    deleteEdge(s: string, t: string, rel: string): Promise<number>;
    getEdge(s: string, t: string, rel: string): Promise<LoreEdge | null>;
};
const raw = (r: Rig): RawGraph => r.graph as unknown as RawGraph;
/** Make the next write of `inferred` confidence throw with nothing written (restores of the prior edge pass). */
function failInferredWrites(r: Rig): () => void {
    const g = raw(r);
    const addEdge = g.addEdge.bind(r.graph);
    const addBidirectionalEdge = g.addBidirectionalEdge.bind(r.graph);
    g.addEdge = async (e) => { if (e.confidence === 'inferred') throw new Error('SIMULATED substrate failure'); return addEdge(e); };
    g.addBidirectionalEdge = async (e) => { if (e.confidence === 'inferred') throw new Error('SIMULATED substrate failure'); return addBidirectionalEdge(e); };
    return () => { g.addEdge = addEdge; g.addBidirectionalEdge = addBidirectionalEdge; };
}
/** Make `addBidirectionalEdge` write the FORWARD direction for real, then throw. */
function failAfterForward(r: Rig): () => void {
    const g = raw(r);
    const original = g.addBidirectionalEdge.bind(r.graph);
    const addEdge = g.addEdge.bind(r.graph);
    g.addBidirectionalEdge = async (e) => { await addEdge(e); throw new Error('SIMULATED reverse-direction failure'); };
    return () => { g.addBidirectionalEdge = original; };
}
/** Make `deleteEdge` throw; with `landFirst`, the delete is applied for real before it throws. */
function failDelete(r: Rig, landFirst = false): () => void {
    const g = raw(r);
    const original = g.deleteEdge.bind(r.graph);
    g.deleteEdge = async (s, t, rel) => { if (landFirst) await original(s, t, rel); throw new Error('SIMULATED delete failure'); };
    return () => { g.deleteEdge = original; };
}
const NEW: SaveBody = { sourceId: 'a', targetId: 'b', bidirectional: false, confidence: 'inferred', confidenceScore: 0.4 };
const NEW_BIDI: SaveBody = { ...NEW, bidirectional: true };
const seedEdge = (r: Rig, s = 'a', t = 'b') => raw(r).addEdge({ sourceId: s, targetId: t, relation: REL, confidence: 'extracted', confidenceScore: 1 });

// ───────────────────────── Part 1 — a failed SAVE ─────────────────────────

console.log('\nsingle edge: a failed save leaves nothing behind (3.26.0)\n');

for (const door of DOORS) {
    await test(`${door}: a failed write of a new edge is not queued, and replay does not create it`, async () => {
        const r = await rig();
        try {
            const seen = await seenIds(r);
            const restore = failInferredWrites(r);
            const out = await save(door, r, NEW);
            restore();
            assert.equal(out.ok, false, out.text);
            assert.match(out.text, /SIMULATED substrate failure/);
            assert.deepEqual(await newRows(r, seen), [], 'the edge.upsert row was retracted');
            await replayNew(r, seen);
            assert.deepEqual(await edgesOf(r), []);
            if (door === 'mcp') assert.deepEqual(r.wal, [], 'a failed store_edge buffers nothing for sync');
        } finally { await closeRig(r); }
    });

    await test(`${door}: a failed re-write of an existing edge keeps it as it was, now and after replay`, async () => {
        const r = await rig();
        try {
            await seedEdge(r);
            const seen = await seenIds(r);
            const restore = failInferredWrites(r);
            const out = await save(door, r, NEW);
            restore();
            assert.equal(out.ok, false, out.text);
            assert.deepEqual(await newRows(r, seen), []);
            await replayNew(r, seen);
            assert.deepEqual(await edgesOf(r), ['a>b:extracted:1']);
        } finally { await closeRig(r); }
    });

    await test(`${door}: a bidirectional write that fails on the reverse direction leaves no forward edge`, async () => {
        const r = await rig();
        try {
            const seen = await seenIds(r);
            const restore = failAfterForward(r);
            const out = await save(door, r, NEW_BIDI);
            restore();
            assert.equal(out.ok, false, out.text);
            assert.deepEqual(await edgesOf(r), [], 'the forward edge the failed write created is removed');
            assert.deepEqual(await newRows(r, seen), []);
        } finally { await closeRig(r); }
    });

    await test(`${door}: row already claimed, new edge → a compensating edge.delete; replay ends with no edge`, async () => {
        const r = await rig();
        try {
            const seen = await seenIds(r);
            claimRows(r);
            const restore = failInferredWrites(r);
            const out = await save(door, r, NEW);
            restore();
            assert.equal(out.ok, false, out.text);
            const rows = await newRows(r, seen);
            assert.deepEqual(kinds(rows), ['edge.upsert', 'edge.delete']);
            assert.equal(rows[1]!.initiator, SAVE_INITIATOR[door]);
            await replayNew(r, seen);
            assert.deepEqual(await edgesOf(r), []);
        } finally { await closeRig(r); }
    });

    await test(`${door}: row already claimed, bidirectional over an existing forward edge → replay ends on the prior state`, async () => {
        const r = await rig();
        try {
            await seedEdge(r);
            const seen = await seenIds(r);
            claimRows(r);
            const restore = failAfterForward(r);
            const out = await save(door, r, NEW_BIDI);
            restore();
            assert.equal(out.ok, false, out.text);
            assert.deepEqual(await edgesOf(r), ['a>b:extracted:1'], 'restored inline: prior forward edge, no reverse');
            const rows = await newRows(r, seen);
            assert.deepEqual(kinds(rows), ['edge.upsert', 'edge.upsert', 'edge.delete']);
            assert.deepEqual(rows[1]!.payload, { sourceId: 'a', targetId: 'b', relation: REL, confidence: 'extracted', confidenceScore: 1, bidirectional: false });
            assert.deepEqual(rows[2]!.payload, { sourceId: 'b', targetId: 'a', relation: REL });
            assert.equal(rows[1]!.initiator, SAVE_INITIATOR[door]);
            assert.equal(rows[2]!.initiator, SAVE_INITIATOR[door]);
            await replayNew(r, seen);
            assert.deepEqual(await edgesOf(r), ['a>b:extracted:1']);
        } finally { await closeRig(r); }
    });

    await test(`${door}: an edge that cannot be read first is rejected with nothing written or queued`, async () => {
        const r = await rig();
        try {
            const seen = await seenIds(r);
            const g = raw(r);
            const getEdge = g.getEdge.bind(r.graph);
            const addEdge = g.addEdge.bind(r.graph);
            let writes = 0;
            g.getEdge = async () => { throw new Error('SIMULATED read failure'); };
            g.addEdge = async (e) => { writes++; return addEdge(e); };
            const out = await save(door, r, { ...NEW, confidence: 'extracted', confidenceScore: 1 });
            g.getEdge = getEdge; g.addEdge = addEdge;
            assert.equal(out.ok, false, out.text);
            assert.match(out.text, /could not read the edge before writing/);
            if (door === 'http') assert.equal(out.status, 500);
            assert.equal(writes, 0);
            assert.deepEqual(await newRows(r, seen), []);
        } finally { await closeRig(r); }
    });

    await test(`${door}: a missing endpoint is still refused, with no row left`, async () => {
        const r = await rig();
        try {
            const seen = await seenIds(r);
            const out = await save(door, r, { sourceId: 'a', targetId: 'nope', bidirectional: true });
            assert.equal(out.ok, false, out.text);
            if (door === 'http') assert.equal(out.status, 400, out.text);
            assert.deepEqual(await newRows(r, seen), []);
            assert.deepEqual(await edgesOf(r), []);
        } finally { await closeRig(r); }
    });

    await test(`${door}: a successful write is unchanged: one edge.upsert row carrying the flag`, async () => {
        const r = await rig();
        try {
            const seen = await seenIds(r);
            const out = await save(door, r, NEW_BIDI);
            assert.equal(out.ok, true, out.text);
            assert.deepEqual(await edgesOf(r), ['a>b:inferred:0.4', 'b>a:inferred:0.4']);
            const rows = await newRows(r, seen);
            assert.deepEqual(kinds(rows), ['edge.upsert']);
            assert.equal((rows[0]!.payload as { bidirectional?: boolean }).bidirectional, true);
            assert.equal(rows[0]!.initiator, SAVE_INITIATOR[door]);
            if (door === 'mcp') assert.deepEqual(r.wal.map((w) => `${w.op}:${w.payload['sourceId']}>${w.payload['targetId']}`), ['add_edge:a>b', 'add_edge:b>a']);
        } finally { await closeRig(r); }
    });
}

// ───────────────────────── Part 2 — a failed DELETE ─────────────────────────

console.log('\nsingle edge: a failed delete leaves the edge in place (3.26.0)\n');

for (const door of DOORS) {
    await test(`${door}: a failed delete is not queued, and replay does not remove the edge`, async () => {
        const r = await rig();
        try {
            await seedEdge(r);
            const seen = await seenIds(r);
            const restore = failDelete(r);
            const out = await del(door, r, 'a', 'b');
            restore();
            assert.equal(out.ok, false, out.text);
            assert.deepEqual(await newRows(r, seen), [], 'the edge.delete row was retracted');
            await replayNew(r, seen);
            assert.deepEqual(await edgesOf(r), ['a>b:extracted:1']);
            if (door === 'mcp') assert.deepEqual(r.wal, [], 'a failed delete_edge buffers nothing for sync');
        } finally { await closeRig(r); }
    });

    await test(`${door}: a delete that landed and then failed is written back with its confidence`, async () => {
        const r = await rig();
        try {
            await raw(r).addEdge({ sourceId: 'a', targetId: 'b', relation: REL, confidence: 'ambiguous', confidenceScore: 0.3 });
            const seen = await seenIds(r);
            const restore = failDelete(r, true);
            const out = await del(door, r, 'a', 'b');
            restore();
            assert.equal(out.ok, false, out.text);
            assert.deepEqual(await edgesOf(r), ['a>b:ambiguous:0.3']);
            assert.deepEqual(await newRows(r, seen), []);
        } finally { await closeRig(r); }
    });

    await test(`${door}: row already claimed → a compensating edge.upsert of that one direction; replay ends with the edge`, async () => {
        const r = await rig();
        try {
            await seedEdge(r);
            const seen = await seenIds(r);
            claimRows(r);
            const restore = failDelete(r);
            const out = await del(door, r, 'a', 'b');
            restore();
            assert.equal(out.ok, false, out.text);
            const rows = await newRows(r, seen);
            assert.deepEqual(kinds(rows), ['edge.delete', 'edge.upsert']);
            assert.deepEqual(rows[1]!.payload, { sourceId: 'a', targetId: 'b', relation: REL, confidence: 'extracted', confidenceScore: 1, bidirectional: false });
            assert.equal(rows[1]!.initiator, DELETE_INITIATOR[door]);
            await replayNew(r, seen);
            assert.deepEqual(await edgesOf(r), ['a>b:extracted:1'], 'the edge is back, and no reverse edge was written');
        } finally { await closeRig(r); }
    });

    await test(`${door}: row already claimed, edge was absent → nothing to compensate`, async () => {
        const r = await rig();
        try {
            const seen = await seenIds(r);
            claimRows(r);
            const restore = failDelete(r);
            const out = await del(door, r, 'a', 'b');
            restore();
            assert.equal(out.ok, false, out.text);
            assert.deepEqual(kinds(await newRows(r, seen)), ['edge.delete']);
            await replayNew(r, seen);
            assert.deepEqual(await edgesOf(r), []);
        } finally { await closeRig(r); }
    });

    await test(`${door}: an edge that cannot be read first is not deleted and nothing is queued`, async () => {
        const r = await rig();
        try {
            await seedEdge(r);
            const seen = await seenIds(r);
            const g = raw(r);
            const getEdge = g.getEdge.bind(r.graph);
            g.getEdge = async () => { throw new Error('SIMULATED read failure'); };
            const out = await del(door, r, 'a', 'b');
            g.getEdge = getEdge;
            assert.equal(out.ok, false, out.text);
            assert.match(out.text, /could not read the edge before deleting/);
            assert.deepEqual(await newRows(r, seen), []);
            assert.deepEqual(await edgesOf(r), ['a>b:extracted:1']);
        } finally { await closeRig(r); }
    });

    await test(`${door}: a successful delete and a no-match delete are unchanged`, async () => {
        const r = await rig();
        try {
            await seedEdge(r);
            const seen = await seenIds(r);
            const out = await del(door, r, 'a', 'b');
            assert.equal(out.ok, true, out.text);
            assert.deepEqual(await edgesOf(r), []);
            const rows = await newRows(r, seen);
            assert.deepEqual(kinds(rows), ['edge.delete']);
            assert.equal(rows[0]!.initiator, DELETE_INITIATOR[door]);
            if (door === 'mcp') assert.deepEqual(r.wal.map((w) => w.op), ['delete_edge']);
            const again = await del(door, r, 'a', 'b');
            if (door === 'http') assert.equal(again.status, 404, again.text);
            else assert.match(again.text, /"success": false/);
            assert.deepEqual(kinds(await newRows(r, seen)), ['edge.delete', 'edge.delete'], 'a no-match delete still records its row');
        } finally { await closeRig(r); }
    });
}

// ───────────────────────── Part 3 — the helpers on a graph that cannot be read ─────────────────────────

console.log('\nsingle edge: a graph with no edge read keeps the pre-3.26 compensation\n');

function blindGraph(opts: { failAdd?: boolean; failDelete?: boolean } = {}) {
    const calls: string[] = [];
    return {
        calls,
        async addEdge(e: LoreEdge) { calls.push(`add:${e.sourceId}>${e.targetId}`); if (opts.failAdd) throw new Error('SIMULATED substrate failure'); },
        async addBidirectionalEdge(e: LoreEdge) { calls.push(`bidi:${e.sourceId}>${e.targetId}`); if (opts.failAdd) throw new Error('SIMULATED substrate failure'); },
        async deleteEdge(s: string, t: string) { calls.push(`del:${s}>${t}`); if (opts.failDelete) throw new Error('SIMULATED delete failure'); return 1; },
    };
}
function fakeStore(claimed: boolean) {
    const recorded: OutboxEntry[] = [];
    const removed: string[] = [];
    const store: OutboxStore = {
        async record(e: OutboxEntry) { recorded.push(e); },
        async batchRecord(es: OutboxEntry[]) { recorded.push(...es); },
        async markStep() { /* no-op */ },
        async markCompleted() { /* no-op */ },
        async remove(id: string) { removed.push(id); },
        async listUnfinished() { return []; },
        async removeIfPending(id: string) { if (claimed) return false; removed.push(id); return true; },
    };
    return { store, recorded, removed };
}
const E: LoreEdge = { sourceId: 'a', targetId: 'b', relation: REL, confidence: 'extracted', confidenceScore: 1 };

await test('writeEdgeOrRestore: unreadable graph, pending → the row is removed; no inline undo is attempted', async () => {
    const g = blindGraph({ failAdd: true });
    const s = fakeStore(false);
    await assert.rejects(writeEdgeOrRestore({ graph: g, store: s.store, workspace: 'w', edge: E, bidirectional: false, initiator: 'test' }), /SIMULATED substrate failure/);
    assert.deepEqual(g.calls, ['add:a>b']);
    assert.deepEqual(s.removed, [s.recorded[0]!.id]);
    assert.equal(s.recorded.length, 1);
});

await test('writeEdgeOrRestore: unreadable graph, claimed → one forward edge.delete, as before 3.26', async () => {
    const g = blindGraph({ failAdd: true });
    const s = fakeStore(true);
    await assert.rejects(writeEdgeOrRestore({ graph: g, store: s.store, workspace: 'w', edge: E, bidirectional: true, initiator: 'test' }), /SIMULATED substrate failure/);
    assert.deepEqual(s.recorded.map((e) => e.operationKind), ['edge.upsert', 'edge.delete']);
    assert.deepEqual(s.recorded[1]!.payload, { sourceId: 'a', targetId: 'b', relation: REL });
    assert.equal(s.recorded[1]!.initiator, 'test');
});

await test('writeEdgeOrRestore: bidirectional on a graph with no two-way write is rejected, nothing written or queued', async () => {
    const g = blindGraph();
    delete (g as { addBidirectionalEdge?: unknown }).addBidirectionalEdge;
    const s = fakeStore(false);
    await assert.rejects(writeEdgeOrRestore({ graph: g, store: s.store, workspace: 'w', edge: E, bidirectional: true, initiator: 'test' }), /cannot write a bidirectional edge; nothing was written/);
    assert.deepEqual(g.calls, []);
    assert.deepEqual(s.recorded, []);
});

await test('writeEdgeOrRestore: a failed two-way re-write of a self-loop keeps the earlier edge, with no row left', async () => {
    const r = await rig();
    try {
        await seedEdge(r, 'a', 'a');
        const seen = await seenIds(r);
        const restore = failAfterForward(r);
        await assert.rejects(writeEdgeOrRestore({
            graph: r.graph as never, store: r.outbox, workspace: r.ws, initiator: 'test', bidirectional: true,
            edge: { sourceId: 'a', targetId: 'a', relation: REL, confidence: 'inferred', confidenceScore: 0.4 },
        }), /SIMULATED reverse-direction failure/);
        restore();
        assert.deepEqual(await edgesOf(r), ['a>a:extracted:1']);
        assert.deepEqual(await newRows(r, seen), []);
    } finally { await closeRig(r); }
});

await test('http: a pre-read that fails with "not found" in its text is a 500, not a 400', async () => {
    const r = await rig();
    try {
        const g = raw(r);
        const getEdge = g.getEdge.bind(r.graph);
        g.getEdge = async () => { throw new Error('table not found'); };
        const out = await save('http', r, { ...NEW, confidence: 'extracted', confidenceScore: 1 });
        g.getEdge = getEdge;
        assert.equal(out.status, 500, out.text);
        assert.deepEqual(await edgesOf(r), []);
    } finally { await closeRig(r); }
});

await test('writeEdgeOrRestore: no outbox wired → the graph is still undone and the original error thrown', async () => {
    const r = await rig();
    try {
        const restore = failAfterForward(r);
        await assert.rejects(writeEdgeOrRestore({ graph: r.graph as never, workspace: r.ws, edge: E, bidirectional: true, initiator: 'test' }), /SIMULATED reverse-direction failure/);
        restore();
        assert.deepEqual(await edgesOf(r), []);
    } finally { await closeRig(r); }
});

await test('writeEdgeOrRestore: a failed retraction is logged, and the original error is the one thrown', async () => {
    const g = blindGraph({ failAdd: true });
    const s = fakeStore(false);
    s.store.removeIfPending = async () => { throw new Error('outbox unavailable'); };
    await assert.rejects(writeEdgeOrRestore({ graph: g, store: s.store, workspace: 'w', edge: E, bidirectional: false, initiator: 'test' }), /SIMULATED substrate failure/);
});

await test('deleteEdgeOrRestore: unreadable graph → pending row removed; a claimed row is left (nothing known to restore)', async () => {
    const pending = fakeStore(false);
    await assert.rejects(deleteEdgeOrRestore({ graph: blindGraph({ failDelete: true }), store: pending.store, workspace: 'w', sourceId: 'a', targetId: 'b', relation: REL, initiator: 'test' }), /SIMULATED delete failure/);
    assert.deepEqual(pending.removed, [pending.recorded[0]!.id]);
    const claimed = fakeStore(true);
    const g = blindGraph({ failDelete: true });
    await assert.rejects(deleteEdgeOrRestore({ graph: g, store: claimed.store, workspace: 'w', sourceId: 'a', targetId: 'b', relation: REL, initiator: 'test' }), /SIMULATED delete failure/);
    assert.deepEqual(claimed.recorded.map((e) => e.operationKind), ['edge.delete']);
    assert.deepEqual(g.calls, ['del:a>b'], 'no blind re-add');
});

await test('deleteEdgeOrRestore: no outbox wired → returns the count; a delete that landed and failed is written back', async () => {
    const r = await rig();
    try {
        await seedEdge(r);
        assert.equal(await deleteEdgeOrRestore({ graph: r.graph as never, workspace: r.ws, sourceId: 'a', targetId: 'b', relation: REL, initiator: 'test' }), 1);
        assert.equal(await deleteEdgeOrRestore({ graph: r.graph as never, workspace: r.ws, sourceId: 'a', targetId: 'b', relation: REL, initiator: 'test' }), 0);
        await seedEdge(r);
        const restore = failDelete(r, true);
        await assert.rejects(deleteEdgeOrRestore({ graph: r.graph as never, workspace: r.ws, sourceId: 'a', targetId: 'b', relation: REL, initiator: 'test' }), /SIMULATED delete failure/);
        restore();
        assert.deepEqual(await edgesOf(r), ['a>b:extracted:1']);
    } finally { await closeRig(r); }
});

// ───────────────────────── Part 4 — the supersedes edge is written under the edge lock ─────────────────────────

console.log('\nsupersedes edge: written under the same edge lock as every other edge writer\n');

await test('applyWriteTimeSupersedes: the outbox row and the edge write wait for the triple\'s edge lock', async () => {
    const events: string[] = [];
    const graph = {
        async supersedeNode() { events.push('field'); return { ok: true }; },
        async addEdge(e: LoreEdge) { events.push(`edge:${e.sourceId}>${e.targetId}:${e.relation}`); },
    };
    const s = fakeStore(false);
    const record = s.store.record.bind(s.store);
    s.store.record = async (e: OutboxEntry) => { events.push('row'); return record(e); };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = withEdgeLock('w-lock', 'new1', 'old1', 'supersedes', () => held);
    const run = applyWriteTimeSupersedes({
        targetGraph: graph as never, supersedes: ['old1'], newId: 'new1', workspace: 'w-lock',
        initiator: 'test', outboxStore: s.store, logPrefix: '[test]',
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(events, ['field'], 'neither the row nor the edge write ran while the lock was held');
    release();
    await holder;
    assert.deepEqual(await run, { ok: true });
    assert.deepEqual(events, ['field', 'row', 'edge:new1>old1:supersedes']);
});

await test('applyWriteTimeSupersedes: another triple\'s lock does not block it', async () => {
    const events: string[] = [];
    const graph = {
        async supersedeNode() { return { ok: true }; },
        async addEdge(e: LoreEdge) { events.push(`edge:${e.sourceId}>${e.targetId}`); },
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = withEdgeLock('w-lock', 'new2', 'other', 'supersedes', () => held);
    assert.deepEqual(await applyWriteTimeSupersedes({
        targetGraph: graph as never, supersedes: ['old2'], newId: 'new2', workspace: 'w-lock', initiator: 'test', logPrefix: '[test]',
    }), { ok: true });
    assert.deepEqual(events, ['edge:new2>old2']);
    release();
    await holder;
});

// ───────────────────────── Part 5 — the supersedes edge on replay ─────────────────────────

console.log('\nsupersedes edge: one-way on replay, and an unsupersede is not undone by a queued row\n');

async function supersedesOf(r: Rig): Promise<string[]> {
    return (await r.graph.queryEdges({ relation: 'supersedes', limit: 100, offset: 0 })).map((e) => `${e.sourceId}>${e.targetId}`).sort();
}
function nodesDeps(r: Rig) {
    return { store: { loreGraph: r.graph } as never, auditLog: { log: () => undefined } as never, deploymentMode: 'local' as const, dataplane: null, outboxStore: r.outbox as never };
}
type SupersedeWriter = 'write-time' | 'mcp' | 'http';
/** `a` supersedes `b` through one of the three writers of the edge. */
async function supersede(writer: SupersedeWriter, r: Rig): Promise<void> {
    if (writer === 'write-time') {
        assert.deepEqual(await applyWriteTimeSupersedes({
            targetGraph: r.graph as never, supersedes: ['b'], newId: 'a', workspace: r.ws, initiator: 'test', outboxStore: r.outbox, logPrefix: '[test]',
        }), { ok: true });
    } else if (writer === 'mcp') {
        const out = await mcpTools(r)['supersede_node']!({ old_id: 'b', new_id: 'a', workspace: r.ws });
        assert.ok(!out.isError, out.content[0]!.text);
    } else {
        const res = fakeRes();
        await handleSupersede(reqWithBody('POST', JSON.stringify({ oldId: 'b', newId: 'a', workspace: r.ws })), res, '/api/node/supersede', nodesDeps(r));
        assert.equal(res._status, 200, res._body);
    }
}

for (const writer of ['write-time', 'mcp', 'http'] as const) {
    await test(`${writer}: the queued supersedes row is one-way; replay writes no reverse edge`, async () => {
        const r = await rig();
        try {
            const seen = await seenIds(r);
            await supersede(writer, r);
            assert.deepEqual(await supersedesOf(r), ['a>b']);
            const rows = (await newRows(r, seen)).filter((e) => e.operationKind === 'edge.upsert');
            assert.equal(rows.length, 1);
            assert.equal((rows[0]!.payload as { bidirectional?: boolean }).bidirectional, false);
            for (const e of rows) await dispatch(e, r.substrates);
            assert.deepEqual(await supersedesOf(r), ['a>b'], 'no b -[supersedes]-> a after replay');
        } finally { await closeRig(r); }
    });
}

await test('http unsupersede: the edge delete is queued, so replaying the supersede row does not bring the edge back', async () => {
    const r = await rig();
    try {
        const seen = await seenIds(r);
        await supersede('http', r);
        const res = fakeRes();
        await handleUnsupersede(reqWithBody('POST', JSON.stringify({ id: 'b', workspace: r.ws })), res, '/api/node/unsupersede', nodesDeps(r));
        assert.equal(res._status, 200, res._body);
        assert.deepEqual(await supersedesOf(r), []);
        const rows = (await newRows(r, seen)).filter((e) => e.operationKind === 'edge.upsert' || e.operationKind === 'edge.delete');
        assert.deepEqual(kinds(rows), ['edge.upsert', 'edge.delete', 'edge.delete']);
        assert.deepEqual(rows[1]!.payload, { sourceId: 'a', targetId: 'b', relation: 'supersedes' });
        assert.deepEqual(rows[2]!.payload, { sourceId: 'b', targetId: 'a', relation: 'supersedes' }, 'the reverse triple is removed too');
        assert.equal(rows[1]!.initiator, 'http:POST /api/node/unsupersede');
        for (const e of rows) await dispatch(e, r.substrates);
        assert.deepEqual(await supersedesOf(r), [], 'replay ends with no supersedes edge');
    } finally { await closeRig(r); }
});

await test('http unsupersede: with no outbox wired the edge is still removed', async () => {
    const r = await rig();
    try {
        await supersede('write-time', r);
        const res = fakeRes();
        await handleUnsupersede(reqWithBody('POST', JSON.stringify({ id: 'b', workspace: r.ws })), res, '/api/node/unsupersede', { ...nodesDeps(r), outboxStore: undefined } as never);
        assert.equal(res._status, 200, res._body);
        assert.deepEqual(await supersedesOf(r), []);
    } finally { await closeRig(r); }
});

await test('http unsupersede: a failed edge delete keeps its row, and replay removes the edge', async () => {
    const r = await rig();
    try {
        await supersede('write-time', r);
        const seen = await seenIds(r);
        const g = r.graph as unknown as { deleteEdge: (...args: unknown[]) => Promise<number> };
        const original = g.deleteEdge.bind(r.graph);
        g.deleteEdge = async () => { throw new Error('disk full'); };
        const res = fakeRes();
        await handleUnsupersede(reqWithBody('POST', JSON.stringify({ id: 'b', workspace: r.ws })), res, '/api/node/unsupersede', nodesDeps(r));
        g.deleteEdge = original;
        assert.equal(res._status, 200, res._body);
        assert.deepEqual(await supersedesOf(r), ['a>b'], 'the delete failed: the edge is still there');
        const rows = (await newRows(r, seen)).filter((e) => e.operationKind === 'edge.delete');
        assert.equal(rows.length, 2, 'both edge.delete rows are kept');
        for (const e of rows) await dispatch(e, r.substrates);
        assert.deepEqual(await supersedesOf(r), [], 'replay removes the edge');
    } finally { await closeRig(r); }
});

const unsupersedeB = async (r: Rig): Promise<void> => {
    const res = fakeRes();
    await handleUnsupersede(reqWithBody('POST', JSON.stringify({ id: 'b', workspace: r.ws })), res, '/api/node/unsupersede', nodesDeps(r));
    assert.equal(res._status, 200, res._body);
};
const edgeRows = async (r: Rig, seen: Set<string>): Promise<OutboxEntry[]> =>
    (await newRows(r, seen)).filter((e) => e.operationKind === 'edge.upsert' || e.operationKind === 'edge.delete');

await test('http unsupersede: the backwards edge a pre-3.26 replay wrote is removed too, now and after replaying an old two-way row', async () => {
    const r = await rig();
    try {
        const seen = await seenIds(r);
        await supersede('http', r);
        await raw(r).addEdge({ sourceId: 'b', targetId: 'a', relation: 'supersedes', confidence: 'extracted', confidenceScore: 1 });
        assert.deepEqual(await supersedesOf(r), ['a>b', 'b>a']);
        await unsupersedeB(r);
        assert.deepEqual(await supersedesOf(r), []);
        const rows = await edgeRows(r, seen);
        const { bidirectional: _flag, ...oldPayload } = rows[0]!.payload as Record<string, unknown>; // a row queued by 3.25 carries no flag
        await dispatch({ ...rows[0]!, payload: oldPayload }, r.substrates);
        assert.deepEqual(await supersedesOf(r), ['a>b', 'b>a'], 'an old row replays both ways');
        for (const e of rows.slice(1)) await dispatch(e, r.substrates);
        assert.deepEqual(await supersedesOf(r), [], 'the queued deletes remove both');
    } finally { await closeRig(r); }
});

// `supersedeNode` refuses a cycle, so a mutual pair only comes from a writer that skips it (sync pull): simulated on the read.
for (const kind of ['a supersession of its own', 'unreadable'] as const) {
    await test(`http unsupersede: a reverse edge that is ${kind} is kept`, async () => {
        const r = await rig();
        try {
            await supersede('write-time', r); // a supersedes b
            await raw(r).addEdge({ sourceId: 'b', targetId: 'a', relation: 'supersedes', confidence: 'extracted', confidenceScore: 1 });
            const g = r.graph as unknown as { getNode(id: string): Promise<Record<string, unknown> | null> };
            const getNode = g.getNode.bind(r.graph);
            g.getNode = async (id) => {
                if (id !== 'a') return getNode(id);
                if (kind === 'unreadable') throw new Error('SIMULATED read failure');
                return { ...(await getNode(id))!, supersededBy: 'b' };
            };
            const seen = await seenIds(r);
            await unsupersedeB(r);
            g.getNode = getNode;
            assert.deepEqual(await supersedesOf(r), ['b>a']);
            assert.deepEqual((await edgeRows(r, seen)).map((e) => e.payload), [{ sourceId: 'a', targetId: 'b', relation: 'supersedes' }]);
        } finally { await closeRig(r); }
    });
}

await test('http: supersede, unsupersede, supersede again → replay ends with the edge, one way', async () => {
    const r = await rig();
    try {
        const seen = await seenIds(r);
        await supersede('http', r);
        await unsupersedeB(r);
        await supersede('http', r);
        assert.deepEqual(await supersedesOf(r), ['a>b']);
        const rows = await edgeRows(r, seen);
        assert.deepEqual(kinds(rows), ['edge.upsert', 'edge.delete', 'edge.delete', 'edge.upsert']);
        for (const e of rows) await dispatch(e, r.substrates);
        assert.deepEqual(await supersedesOf(r), ['a>b']);
    } finally { await closeRig(r); }
});

/** Hold the edge lock of a -[supersedes]-> b, start `run`, and report whether the graph edge call waited for the release. */
async function waitsForEdgeLock(r: Rig, method: 'addEdge' | 'deleteEdge', run: () => Promise<unknown>): Promise<boolean> {
    const g = r.graph as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = g[method]!.bind(r.graph);
    let called = false;
    g[method] = async (...args: unknown[]) => { called = true; return original(...args); };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = withEdgeLock(r.ws, 'a', 'b', 'supersedes', () => held);
    const running = run();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const calledWhileHeld = called;
    release();
    await holder;
    await running;
    g[method] = original;
    return !calledWhileHeld && called;
}

for (const writer of ['mcp', 'http'] as const) {
    await test(`${writer} supersede: the edge write waits for the triple\'s edge lock`, async () => {
        const r = await rig();
        try {
            assert.equal(await waitsForEdgeLock(r, 'addEdge', () => supersede(writer, r)), true);
            assert.deepEqual(await supersedesOf(r), ['a>b']);
        } finally { await closeRig(r); }
    });
}

await test('http unsupersede: the edge delete waits for the triple\'s edge lock', async () => {
    const r = await rig();
    try {
        await supersede('write-time', r);
        const res = fakeRes();
        assert.equal(await waitsForEdgeLock(r, 'deleteEdge', () =>
            handleUnsupersede(reqWithBody('POST', JSON.stringify({ id: 'b', workspace: r.ws })), res, '/api/node/unsupersede', nodesDeps(r))), true);
        assert.equal(res._status, 200, res._body);
        assert.deepEqual(await supersedesOf(r), []);
    } finally { await closeRig(r); }
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
