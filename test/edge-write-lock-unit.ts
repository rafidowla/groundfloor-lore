#!/usr/bin/env tsx
/**
 * test/edge-write-lock-unit.ts — Round-E X-edges regression.
 *
 * Pre-fix: edges had none of the write-ordering protections nodes got.
 *   (1) HIGH — no per-key serialization for edge writes. MCP store_edge/
 *       delete_edge, REST POST/DELETE /api/edge, and POST /api/edges/bulk
 *       never took a lock; SurrealGraph.addEdge chained on its own
 *       INSTANCE-local edgeWriteChain but deleteEdge/addBidirectionalEdge
 *       did not, and none of that instance-local chain covers the
 *       outbox-record-then-graph-write ordering across call sites the way
 *       core/nodeWriteLock.ts's withNodeLock does for nodes.
 *       handleBulkEdges committed ALL edge.upsert outbox rows via
 *       recordHotWriteBatch BEFORE the substrate loop — the exact
 *       pre-lock ordering race ef551757/de8367e7 fixed for nodes.
 *   (2) MEDIUM — edges.ts wrote no audit row for POST/DELETE /api/edge,
 *       unlike the MCP edge tools and POST /api/node.
 *   (3) HIGH (dormant) — no code path appended a WAL delete entry; only
 *       'add_edge' existed as a WAL op, and even that was only appended
 *       for the FORWARD direction of a bidirectional store_edge.
 *   (4) MEDIUM — a malformed JSON body to POST /api/edge fell through to
 *       the generic catch and surfaced as a 500 instead of 400.
 *
 * Fix: a new per-(workspace, sourceId, targetId, relation) lock
 * (core/nodeWriteLock.ts `withEdgeLock`/`withEdgeLocks`) wraps every
 * edge-mutating path's outbox-record + substrate-write critical section,
 * same shape as `withNodeLock` for nodes; a `delete_edge` WAL op now
 * exists and is appended/consumed; edges.ts gained NW-5b audit coverage
 * and a dedicated invalid_json_body 400.
 *
 * Method: each case is a mechanism/behavior test against the REAL
 * production code (registerStoreEdgeTool / registerDeleteEdgeTool /
 * tryEdgesRoutes / handleBulkEdges / SyncEngine), driven with light fakes
 * for the graph substrate and a REAL SqliteOutboxStore + WriteAheadLog so
 * the outbox-ordering and WAL assertions exercise real code, not a mock
 * of it. These fail against the pre-fix source and pass against the fix.
 *
 * Run: npx tsx test/edge-write-lock-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { registerStoreEdgeTool } from '../packages/lore/src/mcp/tools/memory/storeEdge.js';
import { registerDeleteEdgeTool } from '../packages/lore/src/mcp/tools/memory/deleteEdge.js';
import type { MemoryToolsDeps } from '../packages/lore/src/mcp/tools/memory/types.js';
import { tryEdgesRoutes } from '../packages/lore/src/mcp/http/routes/edges.js';
import { handleBulkEdges } from '../packages/lore/src/mcp/http/routes/bulkWriteEdgesDelete.js';
import type { BulkWriteDeps } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { withEdgeLock, withEdgeLocks } from '../packages/lore/src/core/nodeWriteLock.js';
import { SyncEngine, WriteAheadLog, type SyncAdapter, type SyncResult } from '../packages/lore/src/engines/syncEngine.js';

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
const test = (name: string, fn: () => Promise<void> | void) => {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })());
};

console.log('Round-E X-edges — edge write lock, audit, WAL, malformed-JSON regressions');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'edge-lock-'));
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ---------- fakes ---------- */

interface FakeEdge { sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number }

function edgeKey(s: string, t: string, r: string): string { return `${s}|${t}|${r}`; }

function makeFakeGraph() {
    const edges = new Set<string>();
    const calls: string[] = [];
    const graph = {
        edges, calls,
        async addEdge(e: FakeEdge): Promise<void> {
            calls.push(`add:${edgeKey(e.sourceId, e.targetId, e.relation)}`);
            await delay(Math.random() * 4);
            edges.add(edgeKey(e.sourceId, e.targetId, e.relation));
        },
        async addBidirectionalEdge(e: FakeEdge): Promise<void> {
            await graph.addEdge(e);
            await graph.addEdge({ sourceId: e.targetId, targetId: e.sourceId, relation: e.relation, confidence: e.confidence, confidenceScore: e.confidenceScore });
        },
        async deleteEdge(s: string, t: string, r: string): Promise<number> {
            calls.push(`del:${edgeKey(s, t, r)}`);
            await delay(Math.random() * 4);
            const had = edges.has(edgeKey(s, t, r));
            edges.delete(edgeKey(s, t, r));
            return had ? 1 : 0;
        },
        async queryEdges(): Promise<FakeEdge[]> { return []; },
    };
    return graph;
}

function makeSpyAudit() {
    const entries: Array<Record<string, unknown>> = [];
    return { entries, log: (e: Record<string, unknown>) => { entries.push(e); } };
}

function makeMcpDeps(
    graph: ReturnType<typeof makeFakeGraph>,
    outboxStore: SqliteOutboxStore | undefined,
    wal: WriteAheadLog,
    audit: ReturnType<typeof makeSpyAudit>,
): MemoryToolsDeps {
    return {
        store: { loreGraph: graph } as never,
        configManager: {} as never,
        auditLog: audit as never,
        detectedScope: { workspace: 'ws1', ecosystem: '*' },
        getWal: () => wal,
        domain: 'lore',
        edgeRelations: ['depends_on'],
        nodeTypesEnum: z.enum(['decision']),
        nodeTypesDescription: 'decision',
        edgeRelationsEnum: z.enum(['depends_on']),
        outboxStore: outboxStore as never,
        coreNodeTypes: ['decision'],
    } as unknown as MemoryToolsDeps;
}

interface ToolBag { [name: string]: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> }
function makeToolCapture(): { server: object; tools: ToolBag } {
    const tools: ToolBag = {};
    const server = {
        tool: (name: string, ..._rest: unknown[]) => {
            const handler = _rest[_rest.length - 1];
            if (typeof handler === 'function') tools[name] = handler as ToolBag[string];
        },
    };
    return { server, tools };
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
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

function edgesDeps(
    graph: ReturnType<typeof makeFakeGraph>,
    outboxStore: SqliteOutboxStore | undefined,
    auditLog?: ReturnType<typeof makeSpyAudit>,
): Parameters<typeof tryEdgesRoutes>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: { loreGraph: graph } as never,
        outboxStore: outboxStore as never,
        auditLog: auditLog as never,
    };
}

function bulkDeps(
    graph: ReturnType<typeof makeFakeGraph>,
    outboxStore: SqliteOutboxStore | undefined,
    auditLog: ReturnType<typeof makeSpyAudit>,
): BulkWriteDeps {
    return {
        store: { loreGraph: graph } as never,
        auditLog: auditLog as never,
        deploymentMode: 'local',
        dataplane: null,
        outboxStore: outboxStore as never,
    };
}

/** Replay a workspace's edge.upsert/edge.delete outbox rows in sequenceId
 *  order and return whether the given triple ends up present. Used to
 *  prove "outbox order matches the real substrate order" — the whole
 *  point of the lock: replaying the outbox must converge to the SAME
 *  state the live calls actually left the graph in. */
async function replayTripleState(store: SqliteOutboxStore, s: string, t: string, r: string): Promise<boolean> {
    const all = await store.listUnfinished();
    const relevant = all
        .filter((e) => (e.operationKind === 'edge.upsert' || e.operationKind === 'edge.delete')
            && (e.payload as { sourceId?: string })?.sourceId === s
            && (e.payload as { targetId?: string })?.targetId === t
            && (e.payload as { relation?: string })?.relation === r)
        .sort((a, b) => (a.sequenceId ?? 0) - (b.sequenceId ?? 0));
    let present = false;
    for (const e of relevant) present = e.operationKind === 'edge.upsert';
    return present;
}

/* ============================================================
 * (1) HIGH — per-triple lock: mechanism
 * ============================================================ */

test('withEdgeLock: two calls on the SAME triple serialize FIFO (no interleave)', async () => {
    const trace: string[] = [];
    const p1 = withEdgeLock('ws', 'A', 'B', 'r', async () => { trace.push('1-start'); await delay(15); trace.push('1-end'); });
    const p2 = withEdgeLock('ws', 'A', 'B', 'r', async () => { trace.push('2-start'); await delay(1); trace.push('2-end'); });
    await Promise.all([p1, p2]);
    assert.deepEqual(trace, ['1-start', '1-end', '2-start', '2-end'],
        'the second acquisition must not start until the first fully releases');
});

test('withEdgeLocks: two concurrent bidirectional (forward+reverse) holds on the SAME pair serialize FIFO', async () => {
    // Both calls need the SAME two keys (forward + reverse triple). Because
    // withEdgeLocks acquires in canonical sorted order, both attempt the
    // lower-sorted key FIRST — the caller that registers on it first (call
    // order, same as withEdgeLock's own FIFO guarantee) forces the other to
    // wait for the whole nested acquisition (both keys) to release, not just
    // the first one. This is the realistic case the fix cares about: two
    // concurrent bidirectional store_edge/addBidirectionalEdge calls on the
    // same node pair must not interleave their forward/reverse writes.
    const trace: string[] = [];
    const keys = [{ sourceId: 'X', targetId: 'Y', relation: 'r' }, { sourceId: 'Y', targetId: 'X', relation: 'r' }];
    const p1 = withEdgeLocks('ws2', keys, async () => { trace.push('1-start'); await delay(15); trace.push('1-end'); });
    const p2 = withEdgeLocks('ws2', keys, async () => { trace.push('2-start'); await delay(1); trace.push('2-end'); });
    await Promise.all([p1, p2]);
    assert.deepEqual(trace, ['1-start', '1-end', '2-start', '2-end'],
        'the second bidirectional acquisition must not start until the first fully releases BOTH keys');
});

test('withEdgeLock: different triples never contend', async () => {
    const trace: string[] = [];
    const p1 = withEdgeLock('ws3', 'A', 'B', 'r', async () => { trace.push('a-start'); await delay(15); trace.push('a-end'); });
    const p2 = withEdgeLock('ws3', 'C', 'D', 'r', async () => { trace.push('b-start'); await delay(1); trace.push('b-end'); });
    await Promise.all([p1, p2]);
    // The short op finishes while the long one is still mid-flight.
    assert.deepEqual(trace, ['a-start', 'b-start', 'b-end', 'a-end']);
});

/* ============================================================
 * (1) HIGH — MCP store_edge / delete_edge race, 20x
 * ============================================================ */

test('store_edge/delete_edge: 20x concurrent races on one triple — outbox order matches final graph state (replay converges)', async () => {
    const graph = makeFakeGraph();
    const outbox = new SqliteOutboxStore(tmpDir());
    const wal = new WriteAheadLog(tmpDir());
    const audit = makeSpyAudit();
    const deps = makeMcpDeps(graph, outbox, wal, audit);
    const { server, tools } = makeToolCapture();
    registerStoreEdgeTool(server as never, deps);
    registerDeleteEdgeTool(server as never, deps);

    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < 20; i++) {
        if (i % 2 === 0) {
            ops.push(tools['store_edge']!({ sourceId: 'A', targetId: 'B', relation: 'depends_on', bidirectional: false, workspace: 'ws1' }));
        } else {
            ops.push(tools['delete_edge']!({ source_id: 'A', target_id: 'B', relation: 'depends_on', workspace: 'ws1' }));
        }
    }
    await Promise.all(ops);

    const replayedPresent = await replayTripleState(outbox, 'A', 'B', 'depends_on');
    const actuallyPresent = graph.edges.has(edgeKey('A', 'B', 'depends_on'));
    assert.equal(replayedPresent, actuallyPresent,
        `replaying the outbox's edge.upsert/edge.delete rows in sequenceId order must land on the SAME state (${replayedPresent}) the live calls actually left the graph in (${actuallyPresent})`);
});

/* ============================================================
 * (1) HIGH — bulk edges racing a single delete
 * ============================================================ */

test('handleBulkEdges racing a single DELETE /api/edge on the same triple — outbox order matches final graph state', async () => {
    const graph = makeFakeGraph();
    const outbox = new SqliteOutboxStore(tmpDir());
    const audit = makeSpyAudit();
    const bDeps = bulkDeps(graph, outbox, audit);
    const eDeps = edgesDeps(graph, outbox, audit);

    const runs: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i++) {
        const resBulk = fakeRes();
        runs.push(handleBulkEdges(resBulk, { edges: [{ sourceId: 'M', targetId: 'N', relation: 'depends_on', bidirectional: false }], workspace: 'wsBulk' }, bDeps));
        const reqDel = { method: 'DELETE', on: () => undefined } as unknown as IncomingMessage;
        const resDel = fakeRes();
        runs.push(tryEdgesRoutes(reqDel, resDel, '/api/edge?sourceId=M&targetId=N&relation=depends_on&workspace=wsBulk', '/api/edge', eDeps));
    }
    await Promise.all(runs);

    const replayedPresent = await replayTripleState(outbox, 'M', 'N', 'depends_on');
    const actuallyPresent = graph.edges.has(edgeKey('M', 'N', 'depends_on'));
    assert.equal(replayedPresent, actuallyPresent,
        `bulk-add vs single-delete on the same triple must not interleave their outbox-commit/graph-write pairs — replay (${replayedPresent}) vs actual (${actuallyPresent})`);
});

/* ============================================================
 * (2) MEDIUM — audit row present for REST edge ops
 * ============================================================ */

test('POST /api/edge writes an audit row (http:post_edge, success)', async () => {
    const graph = makeFakeGraph();
    const audit = makeSpyAudit();
    const req = makeReqWithBody('POST', JSON.stringify({ sourceId: 'P', targetId: 'Q', relation: 'depends_on', bidirectional: false, workspace: 'ws-audit' }));
    const res = fakeRes();
    await tryEdgesRoutes(req, res, '/api/edge', '/api/edge', edgesDeps(graph, undefined, audit));
    assert.equal(res._status, 200, res._body);
    const rows = audit.entries.filter((e) => e['toolName'] === 'http:post_edge');
    assert.equal(rows.length, 1, `expected exactly one http:post_edge audit row, got ${audit.entries.length} total entries`);
    assert.equal(rows[0]!['result'], 'success');
});

test('DELETE /api/edge writes an audit row (http:delete_edge, success)', async () => {
    const graph = makeFakeGraph();
    graph.edges.add(edgeKey('P2', 'Q2', 'depends_on'));
    const audit = makeSpyAudit();
    const req = { method: 'DELETE', on: () => undefined } as unknown as IncomingMessage;
    const res = fakeRes();
    await tryEdgesRoutes(req, res, '/api/edge?sourceId=P2&targetId=Q2&relation=depends_on&workspace=ws-audit', '/api/edge', edgesDeps(graph, undefined, audit));
    assert.equal(res._status, 200, res._body);
    const rows = audit.entries.filter((e) => e['toolName'] === 'http:delete_edge');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['result'], 'success');
});

test('DELETE /api/edge with no match still writes an audit row (result: error, edge_not_found)', async () => {
    const graph = makeFakeGraph();
    const audit = makeSpyAudit();
    const req = { method: 'DELETE', on: () => undefined } as unknown as IncomingMessage;
    const res = fakeRes();
    await tryEdgesRoutes(req, res, '/api/edge?sourceId=Zz&targetId=Yy&relation=depends_on&workspace=ws-audit', '/api/edge', edgesDeps(graph, undefined, audit));
    assert.equal(res._status, 404);
    const rows = audit.entries.filter((e) => e['toolName'] === 'http:delete_edge');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['result'], 'error');
    assert.equal(rows[0]!['resultDetail'], 'edge_not_found');
});

/* ============================================================
 * (4) MEDIUM — malformed JSON body → 400, not 500
 * ============================================================ */

test('POST /api/edge with malformed JSON body → 400 invalid_json_body (not 500)', async () => {
    const graph = makeFakeGraph();
    const req = makeReqWithBody('POST', '{not valid json');
    const res = fakeRes();
    await tryEdgesRoutes(req, res, '/api/edge', '/api/edge', edgesDeps(graph, undefined));
    assert.equal(res._status, 400, `expected 400; got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body);
    assert.equal(body.code, 'invalid_json_body');
});

/* ============================================================
 * (3) HIGH (dormant) — delete_edge WAL op + consumption
 * ============================================================ */

function baseAdapter(over: Partial<SyncAdapter> = {}): SyncAdapter {
    return {
        async push(): Promise<SyncResult> { return { nodesPushed: 0, edgesPushed: 0, failures: 0, errors: [] }; },
        async pull() { return { nodes: [], edges: [] }; },
        async isConnected() { return true; },
        async connect() { /* no-op */ },
        async disconnect() { /* no-op */ },
        ...over,
    };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopGraph = {} as any;

test('WAL: a delete_edge entry is consumed by pushPendingInner via pushEdgeDeletes, truncated only on ack', async () => {
    const dir = tmpDir();
    const wal = new WriteAheadLog(dir);
    wal.append('delete_edge', { sourceId: 'E1', targetId: 'E2', relation: 'depends_on' });

    const seen: Array<{ sourceId: string; targetId: string; relation: string }> = [];
    const adapter = baseAdapter({
        async pushEdgeDeletes(edges) { seen.push(...edges); return { nodesPushed: edges.length, edgesPushed: 0, failures: 0, errors: [] }; },
    });
    const engine = new SyncEngine(noopGraph, dir, adapter);
    const r = await engine.pushPending();
    assert.equal(r.failures, 0, 'edge delete should push cleanly');
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { sourceId: 'E1', targetId: 'E2', relation: 'depends_on' });
    assert.equal(wal.readPending().length, 0, 'acked edge delete is truncated from the WAL');
});

test('WAL: a delete_edge entry is retained when the adapter has no pushEdgeDeletes', async () => {
    const dir = tmpDir();
    const wal = new WriteAheadLog(dir);
    wal.append('delete_edge', { sourceId: 'E3', targetId: 'E4', relation: 'depends_on' });
    const adapter = baseAdapter(); // no pushEdgeDeletes
    const engine = new SyncEngine(noopGraph, dir, adapter);
    const r = await engine.pushPending();
    assert.ok(r.failures > 0, 'missing edge-delete support should surface as a failure');
    assert.equal(wal.readPending().length, 1, 'delete_edge must NOT be silently dropped');
});

test('WAL: a delete_edge entry is NOT truncated when the adapter rejects it', async () => {
    const dir = tmpDir();
    const wal = new WriteAheadLog(dir);
    wal.append('delete_edge', { sourceId: 'E5', targetId: 'E6', relation: 'depends_on' });
    const adapter = baseAdapter({ async pushEdgeDeletes() { return { nodesPushed: 0, edgesPushed: 0, failures: 1, errors: ['boom'] }; } });
    const engine = new SyncEngine(noopGraph, dir, adapter);
    const r = await engine.pushPending();
    assert.ok(r.failures > 0);
    assert.equal(wal.readPending().length, 1, 'a rejected edge delete must remain in the WAL');
});

test('MCP delete_edge appends a delete_edge WAL entry on an actual removal', async () => {
    const graph = makeFakeGraph();
    graph.edges.add(edgeKey('W1', 'W2', 'depends_on'));
    const wal = new WriteAheadLog(tmpDir());
    const audit = makeSpyAudit();
    const deps = makeMcpDeps(graph, undefined, wal, audit);
    const { server, tools } = makeToolCapture();
    registerDeleteEdgeTool(server as never, deps);
    await tools['delete_edge']!({ source_id: 'W1', target_id: 'W2', relation: 'depends_on', workspace: 'ws1' });
    const entries = wal.readPending();
    const found = entries.find((e) => e.op === 'delete_edge'
        && (e.data as { sourceId?: string }).sourceId === 'W1' && (e.data as { targetId?: string }).targetId === 'W2');
    assert.ok(found, `expected a delete_edge WAL entry; WAL holds: ${JSON.stringify(entries)}`);
});

test('MCP delete_edge does NOT append a WAL entry when nothing matched (no-op delete)', async () => {
    const graph = makeFakeGraph(); // triple absent
    const wal = new WriteAheadLog(tmpDir());
    const audit = makeSpyAudit();
    const deps = makeMcpDeps(graph, undefined, wal, audit);
    const { server, tools } = makeToolCapture();
    registerDeleteEdgeTool(server as never, deps);
    await tools['delete_edge']!({ source_id: 'Nope1', target_id: 'Nope2', relation: 'depends_on', workspace: 'ws1' });
    assert.equal(wal.readPending().length, 0);
});

test('MCP store_edge appends BOTH directions to the WAL when bidirectional (previously only the forward direction)', async () => {
    const graph = makeFakeGraph();
    const wal = new WriteAheadLog(tmpDir());
    const audit = makeSpyAudit();
    const deps = makeMcpDeps(graph, undefined, wal, audit);
    const { server, tools } = makeToolCapture();
    registerStoreEdgeTool(server as never, deps);
    await tools['store_edge']!({ sourceId: 'F1', targetId: 'F2', relation: 'depends_on', bidirectional: true, workspace: 'ws1' });
    const addEdgeEntries = wal.readPending().filter((e) => e.op === 'add_edge');
    assert.equal(addEdgeEntries.length, 2, `expected 2 add_edge WAL entries (forward+reverse); got ${addEdgeEntries.length}`);
    const forward = addEdgeEntries.find((e) => (e.data as { sourceId?: string }).sourceId === 'F1');
    const reverse = addEdgeEntries.find((e) => (e.data as { sourceId?: string }).sourceId === 'F2');
    assert.ok(forward && (forward.data as { targetId?: string }).targetId === 'F2');
    assert.ok(reverse && (reverse.data as { targetId?: string }).targetId === 'F1');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
