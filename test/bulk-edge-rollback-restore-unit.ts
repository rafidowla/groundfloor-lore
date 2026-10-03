#!/usr/bin/env tsx
/**
 * bulk-edge-rollback-restore-unit.ts — 3.26.0: a failed item of POST
 * /api/edges/bulk no longer deletes a relationship that existed before it.
 *
 * The defect (the edge twin of test/bulk-rollback-restore-unit.ts): the route
 * recorded one `edge.upsert` outbox row per item, wrote the graph, and on a
 * failed write compensated a CLAIMED row with `edge.delete`. When the triple
 * existed before the request (a re-write that failed transiently), the replay
 * of that delete removed it. A bidirectional item that failed after its forward
 * direction landed also left that direction in the graph, and the compensating
 * delete covered the forward triple only.
 *
 * The fix (mcp/http/routes/bulkEdgeRollback.ts), pinned here:
 *   - each triple is read under the chunk's edge locks before the outbox rows
 *     are recorded; a read that fails rejects that item with nothing written;
 *   - a failed item puts every direction back inline: a direction that existed
 *     is re-written with its prior confidence, a direction it created is deleted;
 *   - a claimed row is compensated per direction: an `edge.upsert` of the prior
 *     edge (bidirectional:false) when it existed, an `edge.delete` when not;
 *   - a graph with no single-edge read keeps the old compensation.
 *
 * Part 1 drives the helpers with fakes. Part 2 runs the real route against a
 * real graph (SQLite and SurrealDB) and a real FileOutboxStore, and replays the
 * outbox through the real dispatcher. Part 3 covers fake graphs.
 *
 * Run: npx tsx test/bulk-edge-rollback-restore-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { edgeKey, markEdgeWritten, readEdge, readEdgePriors, retractBulkEdgeUpsert, undoBulkEdgeWrite, type EdgePriors } from '../packages/lore/src/mcp/http/routes/bulkEdgeRollback.js';
import { dispatch, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import type { EdgeQuery, LoreEdge } from '../packages/lore/src/providers/types.js';
import type { OutboxEntry, OutboxStore } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

// ───────────────────────── Part 1 — the helpers, with fakes ─────────────────────────

const E: LoreEdge = { sourceId: 'a', targetId: 'b', relation: 'rel', confidence: 'extracted', confidenceScore: 1 };
const REV: LoreEdge = { sourceId: 'b', targetId: 'a', relation: 'rel', confidence: 'extracted', confidenceScore: 1 };
const NEW_EDGE: LoreEdge = { sourceId: 'a', targetId: 'b', relation: 'rel', confidence: 'inferred', confidenceScore: 0.4 };

function fakeStore(opts: { claimed?: boolean; withoutRemoveIfPending?: boolean } = {}) {
    const state = { recorded: [] as OutboxEntry[], removed: [] as string[] };
    const store: OutboxStore = {
        async record(e: OutboxEntry) { state.recorded.push(e); },
        async batchRecord(es: OutboxEntry[]) { state.recorded.push(...es); },
        async markStep() { /* no-op */ },
        async markCompleted() { /* no-op */ },
        async remove(id: string) { state.removed.push(id); },
        async listUnfinished() { return []; },
    };
    if (!opts.withoutRemoveIfPending) {
        store.removeIfPending = async (id: string) => { if (opts.claimed) return false; state.removed.push(id); return true; };
    }
    return { store, state };
}
const priorsOf = (entries: Array<[LoreEdge, LoreEdge | null | undefined]>): EdgePriors =>
    new Map(entries.map(([t, p]) => [edgeKey(t.sourceId, t.targetId, t.relation), p]));
/** The payload of each recorded row, keyed by kind. */
const rowsOf = (state: { recorded: OutboxEntry[] }) => state.recorded.map((r) => ({ kind: r.operationKind, payload: r.payload as Record<string, unknown> }));

console.log('\nbulk edge rollback helpers (3.26.0)\n');

await test('readEdge: prefers getEdge; falls back to queryEdges(limit 1) and reports the requested ids', async () => {
    const q: EdgeQuery[] = [];
    const viaQuery = { async queryEdges(x: EdgeQuery) { q.push(x); return [{ ...E, sourceId: 'lore:a', confidence: 'inferred' as const, confidenceScore: 0.3 }]; } };
    assert.deepEqual(await readEdge(viaQuery, 'a', 'b', 'rel'), { sourceId: 'a', targetId: 'b', relation: 'rel', confidence: 'inferred', confidenceScore: 0.3 });
    assert.deepEqual(q, [{ source: 'a', target: 'b', relation: 'rel', limit: 1, offset: 0 }]);
    const both = { async getEdge() { return E; }, async queryEdges() { throw new Error('must not be used'); } };
    assert.deepEqual(await readEdge(both, 'a', 'b', 'rel'), E);
    assert.equal(await readEdge({ async getEdge() { return null; } }, 'a', 'b', 'rel'), null);
    assert.equal(await readEdge({ async queryEdges() { return []; } }, 'a', 'b', 'rel'), null);
});

await test('readEdge: no read API, or a triple queryEdges cannot filter exactly → undefined (unknown)', async () => {
    assert.equal(await readEdge({}, 'a', 'b', 'rel'), undefined);
    assert.equal(await readEdge({ async queryEdges() { return [E]; } }, 'a', 'b', ''), undefined);
});

await test('readEdgePriors: reads both directions of a bidirectional plan; an unreadable plan is failed and dropped', async () => {
    const reads: string[] = [];
    const g = { async getEdge(s: string, t: string, r: string) { reads.push(`${s}>${t}:${r}`); if (s === 'bad') throw new Error('graph read failed'); return s === 'a' ? E : null; } };
    const plans = [
        { idx: 0, edge: E, bidirectional: true },
        { idx: 1, edge: { ...E, sourceId: 'bad' }, bidirectional: false },
        { idx: 2, edge: { ...E, sourceId: 'x', targetId: 'y' }, bidirectional: false },
    ];
    const failures: Array<[number, string]> = [];
    const { chunk, priors } = await readEdgePriors(g, plans, (p, error) => failures.push([p.idx, error]));
    assert.deepEqual(reads, ['a>b:rel', 'b>a:rel', 'bad>b:rel', 'x>y:rel']);
    assert.deepEqual(chunk.map((p) => p.idx), [0, 2]);
    assert.deepEqual(priors.get(edgeKey('a', 'b', 'rel')), E);
    assert.equal(priors.get(edgeKey('b', 'a', 'rel')), null);
    assert.equal(priors.has(edgeKey('bad', 'b', 'rel')), false);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]![0], 1);
    assert.match(failures[0]![1], /graph read failed.*nothing was written/);
});

await test('readEdgePriors: a graph without a read gives unknown priors and keeps every plan', async () => {
    const plans = [{ idx: 0, edge: E, bidirectional: true }];
    const { chunk, priors } = await readEdgePriors({}, plans, () => assert.fail('no failure expected'));
    assert.equal(chunk.length, 1);
    assert.equal(priors.get(edgeKey('a', 'b', 'rel')), undefined);
    assert.equal(priors.has(edgeKey('a', 'b', 'rel')), true);
});

await test('markEdgeWritten: a later item of the chunk restores to the state the earlier one left; unknown stays unknown', async () => {
    const priors = priorsOf([[E, E], [REV, null]]);
    markEdgeWritten(priors, NEW_EDGE, true);
    assert.deepEqual(priors.get(edgeKey('a', 'b', 'rel')), NEW_EDGE);
    assert.deepEqual(priors.get(edgeKey('b', 'a', 'rel')), { ...NEW_EDGE, sourceId: 'b', targetId: 'a' });
    const unknown = priorsOf([[E, undefined]]);
    markEdgeWritten(unknown, NEW_EDGE, false);
    assert.equal(unknown.get(edgeKey('a', 'b', 'rel')), undefined);
});

function fakeWriteGraph(current: Map<string, LoreEdge>) {
    const calls: unknown[] = [];
    return {
        calls,
        async getEdge(s: string, t: string, r: string) { return current.get(edgeKey(s, t, r)) ?? null; },
        async addEdge(e: LoreEdge) { calls.push(['add', e]); current.set(edgeKey(e.sourceId, e.targetId, e.relation), e); },
        async deleteEdge(s: string, t: string, r: string) { calls.push(['delete', s, t, r]); return current.delete(edgeKey(s, t, r)) ? 1 : 0; },
    };
}

await test('undoBulkEdgeWrite: restores an existing direction, deletes a created one, one write per changed direction', async () => {
    const current = new Map([[edgeKey('a', 'b', 'rel'), NEW_EDGE]]); // forward half-written over E; reverse never written
    const g = fakeWriteGraph(current);
    await undoBulkEdgeWrite(g, NEW_EDGE, true, priorsOf([[E, E], [REV, null]]));
    assert.deepEqual(g.calls, [['add', E]]);
    assert.deepEqual(current.get(edgeKey('a', 'b', 'rel')), E);
    // both directions created by the item → both deleted
    const created = new Map([[edgeKey('a', 'b', 'rel'), NEW_EDGE], [edgeKey('b', 'a', 'rel'), { ...NEW_EDGE, sourceId: 'b', targetId: 'a' }]]);
    const g2 = fakeWriteGraph(created);
    await undoBulkEdgeWrite(g2, NEW_EDGE, true, priorsOf([[E, null], [REV, null]]));
    assert.deepEqual(g2.calls, [['delete', 'a', 'b', 'rel'], ['delete', 'b', 'a', 'rel']]);
});

await test('undoBulkEdgeWrite: nothing to undo → no write; removed meanwhile → not brought back; unknown prior → untouched', async () => {
    const same = fakeWriteGraph(new Map([[edgeKey('a', 'b', 'rel'), E]]));
    await undoBulkEdgeWrite(same, NEW_EDGE, false, priorsOf([[E, E]]));
    const gone = fakeWriteGraph(new Map());
    await undoBulkEdgeWrite(gone, NEW_EDGE, false, priorsOf([[E, E]]));
    await undoBulkEdgeWrite(gone, NEW_EDGE, false, priorsOf([[E, null]]));
    const unknown = fakeWriteGraph(new Map([[edgeKey('a', 'b', 'rel'), NEW_EDGE]]));
    await undoBulkEdgeWrite(unknown, NEW_EDGE, false, priorsOf([[E, undefined]]));
    assert.deepEqual([same.calls, gone.calls, unknown.calls], [[], [], []]);
});

await test('undoBulkEdgeWrite: a current state that cannot be read is treated as changed; the first failure is thrown after every direction was tried', async () => {
    const calls: unknown[] = [];
    const g = {
        async getEdge(): Promise<LoreEdge | null> { throw new Error('read down'); },
        async addEdge(e: LoreEdge) { calls.push(['add', e.sourceId]); if (e.sourceId === 'a') throw new Error('write down'); },
        async deleteEdge(s: string) { calls.push(['delete', s]); return 1; },
    };
    await assert.rejects(() => undoBulkEdgeWrite(g, NEW_EDGE, true, priorsOf([[E, E], [REV, null]])), /write down/);
    assert.deepEqual(calls, [['add', 'a'], ['delete', 'b']]);
});

await test('retractBulkEdgeUpsert: a still-pending row is removed and nothing is recorded', async () => {
    const { store, state } = fakeStore();
    await retractBulkEdgeUpsert({ store, entryId: 'e1', workspace: 'ws', edge: NEW_EDGE, bidirectional: true, priors: priorsOf([[E, E], [REV, null]]) });
    assert.deepEqual(state.removed, ['e1']);
    assert.equal(state.recorded.length, 0);
});

await test('retractBulkEdgeUpsert: claimed, edge existed → edge.upsert of the PRIOR edge with bidirectional:false (never a delete)', async () => {
    const { store, state } = fakeStore({ claimed: true });
    const prior: LoreEdge = { ...E, confidence: 'ambiguous', confidenceScore: 0.25 };
    await retractBulkEdgeUpsert({ store, entryId: 'e1', workspace: 'ws', edge: NEW_EDGE, bidirectional: false, priors: priorsOf([[E, prior]]) });
    assert.deepEqual(rowsOf(state), [{ kind: 'edge.upsert', payload: { sourceId: 'a', targetId: 'b', relation: 'rel', confidence: 'ambiguous', confidenceScore: 0.25, bidirectional: false } }]);
    assert.equal(state.recorded[0]!.workspace, 'ws');
});

await test('retractBulkEdgeUpsert: claimed, edge did not exist → edge.delete', async () => {
    const { store, state } = fakeStore({ claimed: true });
    await retractBulkEdgeUpsert({ store, entryId: 'e1', workspace: 'ws', edge: NEW_EDGE, bidirectional: false, priors: priorsOf([[E, null]]) });
    assert.deepEqual(rowsOf(state), [{ kind: 'edge.delete', payload: { sourceId: 'a', targetId: 'b', relation: 'rel' } }]);
});

await test('retractBulkEdgeUpsert: claimed bidirectional → one compensating row per direction, each from its own prior', async () => {
    const { store, state } = fakeStore({ claimed: true });
    await retractBulkEdgeUpsert({ store, entryId: 'e1', workspace: 'ws', edge: NEW_EDGE, bidirectional: true, priors: priorsOf([[E, E], [REV, null]]) });
    assert.deepEqual(rowsOf(state).map((r) => [r.kind, r.payload.sourceId, r.payload.targetId]), [['edge.upsert', 'a', 'b'], ['edge.delete', 'b', 'a']]);
    assert.equal(state.recorded[0]!.operation, 'graph.addEdge');
});

await test('retractBulkEdgeUpsert: claimed, graph with no read → the pre-3.26 forward edge.delete only', async () => {
    const { store, state } = fakeStore({ claimed: true });
    await retractBulkEdgeUpsert({ store, entryId: 'e1', workspace: 'ws', edge: NEW_EDGE, bidirectional: true, priors: priorsOf([[E, undefined], [REV, undefined]]) });
    assert.deepEqual(rowsOf(state), [{ kind: 'edge.delete', payload: { sourceId: 'a', targetId: 'b', relation: 'rel' } }]);
});

await test('retractBulkEdgeUpsert: a store without removeIfPending removes the row', async () => {
    const { store, state } = fakeStore({ withoutRemoveIfPending: true });
    await retractBulkEdgeUpsert({ store, entryId: 'e1', workspace: 'ws', edge: NEW_EDGE, bidirectional: false, priors: priorsOf([[E, E]]) });
    assert.deepEqual(state.removed, ['e1']);
    assert.equal(state.recorded.length, 0);
});

// ───────────────────────── shared route plumbing ─────────────────────────

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
function fakePostReqWithBody(body: string): IncomingMessage {
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

type Graph = SurrealGraph | SqliteGraph;
interface Rig { graph: Graph; outbox: FileOutboxStore; ws: string; substrates: DispatcherSubstrates }
type Item = { ok: boolean; error?: string };
type EdgeBody = { sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number; bidirectional?: boolean };

async function rig(engine: 'sqlite' | 'surreal', tag: string): Promise<Rig> {
    const ws = `bulk-edge-restore-${engine}-${tag}`;
    const graph: Graph = engine === 'sqlite' ? new SqliteGraph(mkTmp('bulk-edge-g-'), { workspaceId: ws }) : new SurrealGraph(mkTmp('bulk-edge-g-'));
    const outbox = new FileOutboxStore(mkTmp('bulk-edge-o-'));
    await graph.initialize();
    for (const id of ['a', 'b', 'c']) {
        await graph.upsertNode({ id, type: 'note', label: id, content: `node ${id}`, tags: [], project: ws, ecosystem: '*', metadata: '{}' } as never);
    }
    const wiring = wireOutbox({
        loreDir: mkTmp('bulk-edge-w-'),
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => graph as never,
        getVerbatim: () => null as never,
    });
    const substrates = (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
    return { graph, outbox, ws, substrates };
}
const closeRig = async (r: Rig): Promise<void> => { await r.graph.close().catch(() => undefined); };

async function postEdges(ws: string, graph: unknown, outbox: OutboxStore | undefined, edges: EdgeBody[]): Promise<Item[]> {
    const res = fakeRes();
    await tryBulkWriteRoutes(
        fakePostReqWithBody(JSON.stringify({ workspace: ws, edges })),
        res, '/api/edges/bulk', '/api/edges/bulk',
        { store: { loreGraph: graph, loreVerbatim: {} } as never, auditLog: { log: () => undefined } as never,
          deploymentMode: 'local', dataplane: null, outboxStore: outbox },
    );
    assert.equal(res._status, 200, res._body);
    return (JSON.parse(res._body) as { results: Item[] }).results;
}
const bulk = (r: Rig, edges: EdgeBody[]) => postEdges(r.ws, r.graph, r.outbox, edges);

const pendingRows = (r: Rig) => r.outbox.listPendingForWorkspace(r.ws, 10_000);
/** Replay every row the call under test left behind, in commit order. */
async function replayNew(r: Rig, seen: Set<string>): Promise<OutboxEntry[]> {
    const rows = (await pendingRows(r)).filter((e) => !seen.has(e.id));
    for (const e of rows) await dispatch(e, r.substrates);
    return rows;
}
const kinds = (rows: OutboxEntry[]) => rows.map((e) => e.operationKind);
/** Every edge in the graph, as sortable strings. */
async function edgesOf(r: Rig): Promise<string[]> {
    return (await r.graph.queryEdges({ limit: 1000, offset: 0 }))
        .map((e) => `${e.sourceId}>${e.targetId}:${e.relation}:${e.confidence}:${e.confidenceScore}`).sort();
}
const FWD = (conf = 'extracted', score = 1) => `a>b:rel:${conf}:${score}`;
const REVS = (conf = 'extracted', score = 1) => `b>a:rel:${conf}:${score}`;
/** Seed through the route itself; returns the outbox rows already there. */
async function seed(r: Rig, edges: EdgeBody[]): Promise<Set<string>> {
    const out = await bulk(r, edges);
    assert.ok(out.every((i) => i.ok), JSON.stringify(out));
    return new Set((await pendingRows(r)).map((e) => e.id));
}
/** The replicator already claimed every row: `removeIfPending` answers false. */
function claimRows(r: Rig): void {
    (r.outbox as unknown as { removeIfPending: (id: string) => Promise<boolean> }).removeIfPending = async () => false;
}
/** Make `addEdge` throw for matching writes (nothing is written). Returns the restore function. */
function failAddEdge(r: Rig, match: (e: LoreEdge) => boolean): () => void {
    const g = r.graph as unknown as { addEdge(e: LoreEdge): Promise<void> };
    const original = g.addEdge.bind(r.graph);
    g.addEdge = async (e) => { if (match(e)) throw new Error('SIMULATED substrate failure'); return original(e); };
    return () => { g.addEdge = original; };
}
/** Make `addBidirectionalEdge` write the FORWARD direction for real, then throw. Returns the restore function. */
function failAfterForward(r: Rig, match: (e: LoreEdge) => boolean): () => void {
    const g = r.graph as unknown as { addEdge(e: LoreEdge): Promise<void>; addBidirectionalEdge(e: LoreEdge): Promise<void> };
    const original = g.addBidirectionalEdge.bind(r.graph);
    const addEdge = g.addEdge.bind(r.graph);
    g.addBidirectionalEdge = async (e) => {
        if (!match(e)) return original(e);
        await addEdge(e);
        throw new Error('SIMULATED reverse-direction failure');
    };
    return () => { g.addBidirectionalEdge = original; };
}
const AB = (e: LoreEdge) => e.sourceId === 'a' && e.targetId === 'b';
const REWRITE: EdgeBody = { sourceId: 'a', targetId: 'b', relation: 'rel', confidence: 'inferred', confidenceScore: 0.4, bidirectional: false };
const SEED_FWD: EdgeBody = { sourceId: 'a', targetId: 'b', relation: 'rel', bidirectional: false };
const SEED_BOTH: EdgeBody = { sourceId: 'a', targetId: 'b', relation: 'rel', bidirectional: true };

// ───────────────────────── Part 2 — the real route ─────────────────────────

for (const engine of ['sqlite', 'surreal'] as const) {
    console.log(`\nPOST /api/edges/bulk — ${engine} graph\n`);

    await test(`[${engine}] getEdge: confidence fields, direction-exact, null when absent`, async () => {
        const r = await rig(engine, 'g');
        try {
            await seed(r, [{ ...SEED_FWD, confidence: 'inferred', confidenceScore: 0.6 }]);
            const g = r.graph as unknown as { getEdge(s: string, t: string, rel: string): Promise<LoreEdge | null> };
            assert.deepEqual(await g.getEdge('a', 'b', 'rel'), { sourceId: 'a', targetId: 'b', relation: 'rel', confidence: 'inferred', confidenceScore: 0.6 });
            assert.equal(await g.getEdge('b', 'a', 'rel'), null, 'the reverse direction is a different triple');
            assert.equal(await g.getEdge('a', 'b', 'other'), null);
            assert.equal(await g.getEdge('a', 'c', 'rel'), null);
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] failed re-write of an EXISTING edge, row already claimed → compensating edge.upsert of the prior edge; the edge survives the replay`, async () => {
        const r = await rig(engine, 'a');
        try {
            const seen = await seed(r, [{ ...SEED_FWD, confidence: 'extracted', confidenceScore: 0.9 }]);
            claimRows(r);
            const restore = failAddEdge(r, AB);
            let out: Item[];
            try { out = await bulk(r, [REWRITE, { sourceId: 'a', targetId: 'c', relation: 'other', bidirectional: false }]); } finally { restore(); }
            assert.equal(out[0]!.ok, false);
            assert.equal(out[1]!.ok, true, 'the rest of the chunk is unaffected');
            const rows = await replayNew(r, seen);
            const mine = rows.filter((e) => (e.payload as { targetId?: string }).targetId === 'b');
            assert.deepEqual(kinds(mine), ['edge.upsert', 'edge.upsert'], 'the claimed row, then a compensating SAVE (never a delete)');
            const comp = mine[1]!.payload as Record<string, unknown>;
            assert.equal(comp.confidence, 'extracted');
            assert.equal(comp.confidenceScore, 0.9);
            assert.equal(comp.bidirectional, false, 'a missing flag would replay as bidirectional and write the reverse');
            assert.deepEqual((await edgesOf(r)).filter((e) => e.startsWith('a>b')), [FWD('extracted', 0.9)], 'the relationship ends on its prior confidence');
            assert.equal((await edgesOf(r)).some((e) => e.startsWith('b>a')), false, 'and no reverse edge appeared');
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] failed write of a NEW edge, row already claimed → compensating edge.delete; nothing is left after the replay`, async () => {
        const r = await rig(engine, 'b');
        try {
            claimRows(r);
            const restore = failAddEdge(r, AB);
            let out: Item[];
            try { out = await bulk(r, [REWRITE]); } finally { restore(); }
            assert.equal(out[0]!.ok, false);
            assert.deepEqual(await edgesOf(r), []);
            const rows = await replayNew(r, new Set());
            assert.deepEqual(kinds(rows), ['edge.upsert', 'edge.delete']);
            assert.deepEqual(await edgesOf(r), [], 'the replayed save is cancelled by the replayed delete');
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] failed re-write of an existing edge, row still pending → row removed, graph unchanged`, async () => {
        const r = await rig(engine, 'c');
        try {
            const seen = await seed(r, [{ ...SEED_FWD, confidence: 'extracted', confidenceScore: 0.9 }]);
            const before = await edgesOf(r);
            const restore = failAddEdge(r, AB);
            let out: Item[];
            try { out = await bulk(r, [REWRITE]); } finally { restore(); }
            assert.equal(out[0]!.ok, false);
            assert.deepEqual(await edgesOf(r), before);
            assert.deepEqual(kinds((await pendingRows(r)).filter((e) => !seen.has(e.id))), [], 'no row left behind');
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] bidirectional item fails after the forward direction landed; both directions existed → both restored, nothing recorded`, async () => {
        const r = await rig(engine, 'd');
        try {
            const seen = await seed(r, [{ ...SEED_BOTH, confidence: 'extracted', confidenceScore: 0.9 }]);
            const before = await edgesOf(r);
            assert.deepEqual(before, [FWD('extracted', 0.9), REVS('extracted', 0.9)]);
            const restore = failAfterForward(r, AB);
            let out: Item[];
            try { out = await bulk(r, [{ ...SEED_BOTH, confidence: 'inferred', confidenceScore: 0.4 }]); } finally { restore(); }
            assert.equal(out[0]!.ok, false);
            assert.deepEqual(await edgesOf(r), before, 'the forward direction the item overwrote is put back');
            assert.deepEqual(kinds((await pendingRows(r)).filter((e) => !seen.has(e.id))), []);
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] bidirectional item fails after the forward direction landed; both existed, row claimed → both directions end on their prior edges`, async () => {
        const r = await rig(engine, 'e');
        try {
            const seen = await seed(r, [{ ...SEED_BOTH, confidence: 'extracted', confidenceScore: 0.9 }]);
            claimRows(r);
            const restore = failAfterForward(r, AB);
            let out: Item[];
            try { out = await bulk(r, [{ ...SEED_BOTH, confidence: 'inferred', confidenceScore: 0.4 }]); } finally { restore(); }
            assert.equal(out[0]!.ok, false);
            const rows = await replayNew(r, seen);
            assert.deepEqual(kinds(rows), ['edge.upsert', 'edge.upsert', 'edge.upsert'], 'the claimed row, then one SAVE per direction');
            // the claimed row replays BOTH directions (inferred 0.4); the compensating rows put both back
            assert.deepEqual(await edgesOf(r), [FWD('extracted', 0.9), REVS('extracted', 0.9)]);
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] bidirectional item fails after the forward direction landed; neither existed → forward removed inline; claimed row → two deletes, nothing survives the replay`, async () => {
        const r = await rig(engine, 'f');
        try {
            // unclaimed first
            const restore1 = failAfterForward(r, AB);
            let out: Item[];
            try { out = await bulk(r, [SEED_BOTH]); } finally { restore1(); }
            assert.equal(out[0]!.ok, false);
            assert.deepEqual(await edgesOf(r), [], 'the half-written forward direction is removed');
            assert.deepEqual(await pendingRows(r), []);
            // claimed
            claimRows(r);
            const restore2 = failAfterForward(r, AB);
            try { out = await bulk(r, [SEED_BOTH]); } finally { restore2(); }
            assert.equal(out[0]!.ok, false);
            assert.deepEqual(await edgesOf(r), []);
            const rows = await replayNew(r, new Set());
            assert.deepEqual(kinds(rows), ['edge.upsert', 'edge.delete', 'edge.delete']);
            assert.deepEqual(await edgesOf(r), [], 'the claimed row replays both directions; both are deleted again (before: the reverse survived)');
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] bidirectional item fails; only the forward direction existed → it is restored, the reverse is removed on replay`, async () => {
        const r = await rig(engine, 'g2');
        try {
            const seen = await seed(r, [{ ...SEED_FWD, confidence: 'extracted', confidenceScore: 0.9 }]);
            claimRows(r);
            const restore = failAfterForward(r, AB);
            let out: Item[];
            try { out = await bulk(r, [{ ...SEED_BOTH, confidence: 'inferred', confidenceScore: 0.4 }]); } finally { restore(); }
            assert.equal(out[0]!.ok, false);
            assert.deepEqual(await edgesOf(r), [FWD('extracted', 0.9)], 'inline: forward restored, reverse never existed');
            const rows = await replayNew(r, seen);
            assert.deepEqual(kinds(rows), ['edge.upsert', 'edge.upsert', 'edge.delete']);
            assert.deepEqual(await edgesOf(r), [FWD('extracted', 0.9)]);
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] two items on the same triple in one chunk: the second fails → it restores to the FIRST item's write, not the original`, async () => {
        const r = await rig(engine, 'h');
        try {
            const seen = await seed(r, [{ ...SEED_FWD, confidence: 'extracted', confidenceScore: 0.9 }]);
            claimRows(r);
            const restore = failAddEdge(r, (e) => e.confidenceScore === 0.2);
            let out: Item[];
            try {
                out = await bulk(r, [REWRITE, { ...REWRITE, confidence: 'ambiguous', confidenceScore: 0.2 }]);
            } finally { restore(); }
            assert.deepEqual(out.map((i) => i.ok), [true, false]);
            assert.deepEqual(await edgesOf(r), [FWD('inferred', 0.4)]);
            await replayNew(r, seen);
            assert.deepEqual(await edgesOf(r), [FWD('inferred', 0.4)], 'the replay also ends on the first item (the one the caller was told succeeded)');
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] two items on the same triple in one chunk: the FIRST fails with its row claimed, the second succeeds → the replay ends on the second item's write`, async () => {
        const r = await rig(engine, 'h2');
        try {
            const seen = await seed(r, [{ ...SEED_FWD, confidence: 'extracted', confidenceScore: 0.9 }]);
            claimRows(r);
            const restore = failAddEdge(r, (e) => e.confidenceScore === 0.4);
            let out: Item[];
            try {
                out = await bulk(r, [REWRITE, { ...REWRITE, confidence: 'ambiguous', confidenceScore: 0.2 }]);
            } finally { restore(); }
            assert.deepEqual(out.map((i) => i.ok), [false, true]);
            assert.deepEqual(await edgesOf(r), [FWD('ambiguous', 0.2)]);
            const rows = await replayNew(r, seen);
            // both items' rows, the failed item's compensation (the prior edge), then the second item again
            assert.deepEqual(kinds(rows), ['edge.upsert', 'edge.upsert', 'edge.upsert', 'edge.upsert']);
            assert.equal((rows[2]!.payload as { confidenceScore?: number }).confidenceScore, 0.9, 'the compensation carries the prior edge');
            const last = rows[3]!.payload as Record<string, unknown>;
            assert.equal(last.confidenceScore, 0.2, 'the acknowledged write is recorded again behind the compensation');
            assert.equal(last.bidirectional, false);
            assert.deepEqual(await edgesOf(r), [FWD('ambiguous', 0.2)], 'the compensation did not undo the write the caller was told succeeded');
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] a failed bidirectional item (row claimed), then an item that writes its REVERSE triple → the replay keeps the second item's edge`, async () => {
        const r = await rig(engine, 'h3');
        try {
            const seen = await seed(r, [{ ...SEED_FWD, confidence: 'extracted', confidenceScore: 0.9 }]);
            claimRows(r);
            const restore = failAfterForward(r, AB);
            let out: Item[];
            try {
                out = await bulk(r, [
                    { ...SEED_BOTH, confidence: 'inferred', confidenceScore: 0.4 },
                    { sourceId: 'b', targetId: 'a', relation: 'rel', confidence: 'ambiguous', confidenceScore: 0.2, bidirectional: false },
                ]);
            } finally { restore(); }
            assert.deepEqual(out.map((i) => i.ok), [false, true]);
            assert.deepEqual(await edgesOf(r), [FWD('extracted', 0.9), REVS('ambiguous', 0.2)]);
            const rows = await replayNew(r, seen);
            assert.deepEqual(kinds(rows), ['edge.upsert', 'edge.upsert', 'edge.upsert', 'edge.delete', 'edge.upsert']);
            assert.deepEqual(await edgesOf(r), [FWD('extracted', 0.9), REVS('ambiguous', 0.2)], 'forward back on its prior; the reverse is the second item\'s, not deleted by the compensation');
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] a failed item whose row was still pending records nothing extra for a later success on the same triple`, async () => {
        const r = await rig(engine, 'h4');
        try {
            const seen = await seed(r, [{ ...SEED_FWD, confidence: 'extracted', confidenceScore: 0.9 }]);
            const restore = failAddEdge(r, (e) => e.confidenceScore === 0.4);
            let out: Item[];
            try {
                out = await bulk(r, [REWRITE, { ...REWRITE, confidence: 'ambiguous', confidenceScore: 0.2 }]);
            } finally { restore(); }
            assert.deepEqual(out.map((i) => i.ok), [false, true]);
            const rows = await replayNew(r, seen);
            assert.deepEqual(kinds(rows), ['edge.upsert'], 'only the successful item\'s row is left');
            assert.deepEqual(await edgesOf(r), [FWD('ambiguous', 0.2)]);
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] the triple cannot be read → that item fails with nothing written or recorded; the rest of the chunk goes through`, async () => {
        const r = await rig(engine, 'i');
        try {
            const seen = await seed(r, [{ ...SEED_FWD, confidence: 'extracted', confidenceScore: 0.9 }]);
            const g = r.graph as unknown as { getEdge(s: string, t: string, rel: string): Promise<LoreEdge | null> };
            const original = g.getEdge.bind(r.graph);
            g.getEdge = async (s, t, rel) => { if (s === 'a' && t === 'b') throw new Error('SIMULATED read failure'); return original(s, t, rel); };
            let out: Item[];
            try { out = await bulk(r, [REWRITE, { sourceId: 'a', targetId: 'c', relation: 'other', bidirectional: false }]); } finally { g.getEdge = original; }
            assert.equal(out[0]!.ok, false);
            assert.match(String(out[0]!.error), /nothing was written/);
            assert.equal(out[1]!.ok, true);
            assert.deepEqual(await edgesOf(r), [FWD('extracted', 0.9), 'a>c:other:extracted:1'], 'the unreadable item did not write');
            const mine = (await pendingRows(r)).filter((e) => !seen.has(e.id));
            assert.deepEqual(mine.map((e) => (e.payload as { targetId?: string }).targetId), ['c'], 'a row exists only for the item that was written');
        } finally { await closeRig(r); }
    });

    await test(`[${engine}] successful writes are unchanged: both directions, rows queued, replay is idempotent`, async () => {
        const r = await rig(engine, 'j');
        try {
            const out = await bulk(r, [{ ...SEED_BOTH, confidence: 'inferred', confidenceScore: 0.4 }]);
            assert.equal(out[0]!.ok, true);
            assert.deepEqual(await edgesOf(r), [FWD('inferred', 0.4), REVS('inferred', 0.4)]);
            assert.deepEqual(kinds(await pendingRows(r)), ['edge.upsert']);
            await replayNew(r, new Set());
            assert.deepEqual(await edgesOf(r), [FWD('inferred', 0.4), REVS('inferred', 0.4)]);
        } finally { await closeRig(r); }
    });
}

// ───────────────────────── Part 3 — graphs without the read API ─────────────────────────

console.log('\nPOST /api/edges/bulk — fake graphs\n');

function fakeGraph(opts: { read?: 'none' | 'queryEdges'; failAdd?: boolean; edges?: LoreEdge[] } = {}) {
    const edges = [...(opts.edges ?? [])];
    const calls: string[] = [];
    const g: Record<string, unknown> = {
        async addEdge(e: LoreEdge) { calls.push(`add ${e.sourceId}>${e.targetId}`); if (opts.failAdd) throw new Error('SIMULATED substrate failure'); edges.push(e); },
        async addBidirectionalEdge(e: LoreEdge) { calls.push(`addBi ${e.sourceId}>${e.targetId}`); throw new Error('SIMULATED substrate failure'); },
        async deleteEdge(s: string, t: string, rel: string) { calls.push(`delete ${s}>${t}`); return edges.length ? 1 : 0; },
    };
    if (opts.read === 'queryEdges') {
        g.queryEdges = async (q: EdgeQuery) => edges.filter((e) => e.sourceId === q.source && e.targetId === q.target && e.relation === q.relation).slice(0, q.limit);
    }
    return { graph: g, calls };
}
async function withClaimedStore<T>(fn: (outbox: FileOutboxStore) => Promise<T>): Promise<T> {
    const outbox = new FileOutboxStore(mkTmp('bulk-edge-fake-o-'));
    (outbox as unknown as { removeIfPending: (id: string) => Promise<boolean> }).removeIfPending = async () => false;
    return fn(outbox);
}

await test('a graph with no single-edge read → old behaviour: no inline undo, a claimed row gets the forward edge.delete', async () => {
    const f = fakeGraph({ read: 'none', failAdd: true });
    await withClaimedStore(async (outbox) => {
        const out = await postEdges('ws-fake', f.graph, outbox, [{ ...REWRITE }]);
        assert.equal(out[0]!.ok, false);
        const rows = await outbox.listPendingForWorkspace('ws-fake', 100);
        assert.deepEqual(kinds(rows), ['edge.upsert', 'edge.delete']);
        assert.deepEqual(rows[1]!.payload, { sourceId: 'a', targetId: 'b', relation: 'rel' });
    });
    assert.deepEqual(f.calls, ['add a>b'], 'nothing else was written to the graph');
});

await test('a graph with only queryEdges → the prior is read through it and a claimed row is compensated by the prior edge', async () => {
    const f = fakeGraph({ read: 'queryEdges', failAdd: true, edges: [{ ...E, confidence: 'ambiguous', confidenceScore: 0.3 }] });
    await withClaimedStore(async (outbox) => {
        const out = await postEdges('ws-fake', f.graph, outbox, [{ ...REWRITE }]);
        assert.equal(out[0]!.ok, false);
        const rows = await outbox.listPendingForWorkspace('ws-fake', 100);
        assert.deepEqual(kinds(rows), ['edge.upsert', 'edge.upsert']);
        assert.deepEqual(rows[1]!.payload, { sourceId: 'a', targetId: 'b', relation: 'rel', confidence: 'ambiguous', confidenceScore: 0.3, bidirectional: false });
    });
});

await test('a graph whose read throws → the item fails before anything is recorded or written', async () => {
    const f = fakeGraph({ read: 'queryEdges' });
    (f.graph as { queryEdges: unknown }).queryEdges = async () => { throw new Error('SIMULATED read failure'); };
    await withClaimedStore(async (outbox) => {
        const out = await postEdges('ws-fake', f.graph, outbox, [{ ...REWRITE }]);
        assert.equal(out[0]!.ok, false);
        assert.match(String(out[0]!.error), /could not read the edge.*nothing was written/);
        assert.deepEqual(await outbox.listPendingForWorkspace('ws-fake', 100), []);
    });
    assert.deepEqual(f.calls, []);
});

for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
