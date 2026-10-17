#!/usr/bin/env tsx
/**
 * stats-arcade-cell-counts-unit.ts — Lore 3.35.1: arcade `GET /api/stats` must
 * count the WHOLE cell for the caller's binding.
 *
 * Root cause: the shared handler passes the requested workspace (in arcade, the
 * appId) as a `project` row filter, but arcade rows keep the caller's own
 * `project` (it defaults to the appId only when unset — DEC-SCOPE-HONESTY). So
 * nodeCount/typeBreakdown counted only the unset-project rows (Nokshi saw 0 with
 * 10,101 nodes stored), while the arcade edge count ignored the filter entirely.
 *
 * Covers:
 *   A1 tryArcadeDataRoutes GET /api/stats -> whole-cell node/edge/type counts
 *      (failed before: nodeCount = unset-project rows only).
 *   A2 a count ArcadeDB answers without a number -> null + error, never 0.
 *   A3 arcadeGraphReads.getStats: a project filter narrows the EDGE count too
 *      (both endpoints), and no filter leaves every count unfiltered.
 *   A4 arcadeGraphReads.getStats: a missing/non-numeric count throws
 *      ArcadeStatsCountError instead of reporting 0.
 *   A5 deadLettered / deadSuperseded / deadByReason still come from the cell's
 *      own outbox lane, unchanged; no host-filesystem fields on the arcade
 *      listener (graphPath / engine / graphEngine / verbatimEngine absent).
 */
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryArcadeDataRoutes } from '../packages/lore/src/mcp/http/routes/arcadeData.js';
import { getStats as arcadeGetStats, ArcadeStatsCountError } from '../packages/lore/src/engines/arcade/arcadeGraphReads.js';
import { arcadeCellKey } from '../packages/lore/src/engines/arcade/arcadeOutboxLane.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
type Res = ServerResponse & { _status: number; _body: string };
function mkRes(): Res {
    const r = { _status: 0, _body: '', writableEnded: false, writeHead(s: number) { this._status = s; return this; }, end(b?: string) { this._body = b ?? ''; this.writableEnded = true; }, once() { return this; }, setHeader() { return this; } };
    return r as unknown as Res;
}
const json = (r: Res): Record<string, any> => JSON.parse(r._body);
const getReq = (): IncomingMessage => ({ method: 'GET', headers: {}, on() { return this; } }) as unknown as IncomingMessage;

const TENANT = 'cust1';
const APP = 'nokshi-app';

/** In-memory cell: rows keep the caller's own project; unset defaults to the appId. */
const NODES = [
    ...Array.from({ length: 3 }, (_, i) => ({ id: `u${i}`, type: 'fact', project: APP })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, type: i % 2 ? 'decision' : 'fact', project: 'p1' })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: `q${i}`, type: 'note', project: 'p2' })),
];
const EDGES = [
    { s: 'u0', t: 'u1' }, // both APP
    { s: 'p0', t: 'p1' }, { s: 'p1', t: 'p2' }, // both p1
    { s: 'p0', t: 'q0' }, // cross p1 -> p2
];
const projOf = (id: string) => NODES.find((n) => n.id === id)!.project;

/** Same semantics as the arcade adapter: nodes by project, edges by both endpoints. */
function cellStatsFor(filter?: string) {
    const nodes = filter ? NODES.filter((n) => n.project === filter) : NODES;
    const edges = filter ? EDGES.filter((e) => projOf(e.s) === filter && projOf(e.t) === filter) : EDGES;
    const typeBreakdown: Record<string, number> = {};
    for (const n of nodes) typeBreakdown[n.type] = (typeBreakdown[n.type] ?? 0) + 1;
    return { nodeCount: nodes.length, edgeCount: edges.length, typeBreakdown };
}

function mkDeps(opts: { statsImpl?: (filter?: string) => Promise<unknown>; seen?: Array<string | undefined>; deadAsked?: string[] } = {}) {
    const seen = opts.seen ?? [];
    const graph = {
        getStats: opts.statsImpl ?? (async (filter?: string) => { seen.push(filter); return cellStatsFor(filter); }),
        getGraphContext: () => ({ queryRows: async () => [{ language: 'en', n: NODES.length }] }),
    };
    const cell = { principal: { tenantId: TENANT, appId: APP, db: 'db', dbUser: 'u', scopes: ['read', 'write'] }, graph, verbatim: {}, rawGraph: {}, rawVector: {} };
    const bundle = { loreGraph: graph, storageClient: { verbatimCount: async () => 0 } };
    const pool = { resolve() { /* valid token */ }, evictToken() { /* noop */ }, getOrBuild: async () => ({ cell, bundle }) };
    const outboxStore = {
        deadLetterSummary: async (ws: string) => {
            opts.deadAsked?.push(ws);
            return { deadLettered: 2, deadSuperseded: 1, deadByReason: { permanent: 2 } };
        },
    };
    return { pool: pool as never, auditLog: {} as never, outboxStore: outboxStore as never };
}

async function arcadeStats(deps: ReturnType<typeof mkDeps>): Promise<Res> {
    const res = mkRes();
    const handled = await tryArcadeDataRoutes(getReq(), res, `/api/stats?workspace=${APP}`, '/api/stats', 'lore_at_x', deps);
    assert.equal(handled, true);
    return res;
}

console.log('arcade /api/stats cell counts (3.35.1)');

await test('A1 arcade /api/stats counts the whole cell, not only unset-project rows', async () => {
    const seen: Array<string | undefined> = [];
    const res = await arcadeStats(mkDeps({ seen }));
    assert.equal(res._status, 200, res._body);
    const b = json(res);
    const whole = cellStatsFor(undefined);
    assert.equal(b.nodeCount, 10, `nodeCount ${b.nodeCount} (3 = unset-project rows only)`);
    assert.equal(b.edgeCount, whole.edgeCount);
    assert.deepEqual(b.typeBreakdown, whole.typeBreakdown);
    assert.deepEqual(seen, [undefined], 'the workspace name must not reach the cell as a project filter');
});

await test('A2 an unreadable count is null + error, never a guessed number', async () => {
    const res = await arcadeStats(mkDeps({ statsImpl: async () => { throw new ArcadeStatsCountError('node count'); } }));
    assert.equal(res._status, 200, res._body);
    const b = json(res);
    assert.equal(b.nodeCount, null);
    assert.equal(b.edgeCount, null);
    assert.equal(b.typeBreakdown, null);
    assert.equal(b.error?.code, 'stats_count_unavailable');
});

await test('A5 dead-letter fields come from the cell lane unchanged; no filesystem/engine fields on arcade', async () => {
    const deadAsked: string[] = [];
    const b = json(await arcadeStats(mkDeps({ deadAsked })));
    assert.equal(b.deadLettered, 2);
    assert.equal(b.deadSuperseded, 1);
    assert.deepEqual(b.deadByReason, { permanent: 2 });
    assert.deepEqual(deadAsked, [arcadeCellKey(TENANT, APP)], 'summary is read from this cell\'s own outbox lane');
    for (const k of ['graphPath', 'engine', 'graphEngine', 'verbatimEngine']) assert.ok(!(k in b), `${k} must not appear on the arcade listener`);
});

/** Fake ArcadeHttp recording SQL; answers counts from the in-memory cell. */
function fakeHttp(opts: { malformed?: 'node' | 'edge' | 'type' } = {}) {
    const calls: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const http = {
        async query(_db: string, sql: string, params?: Record<string, unknown>) {
            calls.push({ sql, params });
            const filter = typeof params?.['project'] === 'string' ? params['project'] as string : undefined;
            const s = cellStatsFor(filter);
            if (/GROUP BY type/.test(sql)) {
                if (opts.malformed === 'type') return { result: [{ type: 'fact', n: 'lots' }] };
                return { result: Object.entries(s.typeBreakdown).map(([type, n]) => ({ type, n })) };
            }
            if (/FROM LoreEdge/.test(sql)) {
                if (opts.malformed === 'edge') return { result: [] };
                // Honour the filter only if the SQL actually carries it.
                const e = /WHERE/.test(sql) ? s.edgeCount : EDGES.length;
                return { result: [{ n: e }] };
            }
            if (opts.malformed === 'node') return { result: [{}] };
            return { result: [{ n: s.nodeCount }] };
        },
    };
    return { http: http as never, calls };
}

await test('A3 a project filter narrows nodes, types AND edges (both endpoints); none = whole cell', async () => {
    const f = fakeHttp();
    const p1 = await arcadeGetStats('db', f.http, 'LoreNode', 'LoreEdge', 'p1');
    assert.deepEqual(p1, cellStatsFor('p1'));
    assert.equal(p1.edgeCount, 2, `edgeCount ${p1.edgeCount} (4 = filter ignored)`);
    const edgeSql = f.calls.find((c) => /FROM LoreEdge/.test(c.sql))!;
    assert.match(edgeSql.sql, /outV\(\)\.project = :project AND inV\(\)\.project = :project/);
    assert.equal(edgeSql.params?.['project'], 'p1');

    const g = fakeHttp();
    const all = await arcadeGetStats('db', g.http, 'LoreNode', 'LoreEdge');
    assert.deepEqual(all, cellStatsFor(undefined));
    for (const c of g.calls) assert.ok(!/WHERE/.test(c.sql), `unfiltered call must not filter: ${c.sql}`);
});

await test('A4 a missing or non-numeric count throws ArcadeStatsCountError instead of 0', async () => {
    for (const m of ['node', 'edge', 'type'] as const) {
        await assert.rejects(arcadeGetStats('db', fakeHttp({ malformed: m }).http, 'LoreNode', 'LoreEdge'), ArcadeStatsCountError, m);
    }
});

await test('A6 an empty cell / no edges / a filter matching nothing reads as 0, not an error (ArcadeDB 26.7.1 shape)', async () => {
    // Live 26.7.1 answers count(*) on an empty set with ONE row {n:0}, and an
    // empty GROUP BY with no rows -- both must read as zero, not as unknown.
    const http = { query: async (_db: string, sql: string) => ({ result: /GROUP BY/.test(sql) ? [] : [{ n: 0 }] }) };
    for (const filter of [undefined, 'nomatch']) {
        assert.deepEqual(await arcadeGetStats('db', http as never, 'LoreNode', 'LoreEdge', filter), { nodeCount: 0, edgeCount: 0, typeBreakdown: {} });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
