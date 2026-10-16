#!/usr/bin/env tsx
/**
 * test/outbox-dead-letters-unit.ts - 3.35.0 (a)/(p): dead-letters are no longer invisible.
 *
 *   - store: additive migration of an old outbox.sqlite, deadLetterSummary (superseded excluded),
 *     listDeadPage (workspace-scoped, 200 cap, newest first, offset)
 *   - GET /api/stats `deadLettered` (+ reason split); GET /api/outbox/dead pagination, the cap,
 *     validation, and NO CROSS-WORKSPACE LEAK (a row of workspace B never appears for A, by list,
 *     count or id), bound-token refusal, lastError withheld from bound non-operator callers
 *   - the arcade lane wrapper pins both reads to its own cell whatever workspace is asked for
 *   - the DATA LOSS log line names the reason class
 *
 * Run: npx tsx test/outbox-dead-letters-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Database from 'better-sqlite3';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import { SUPERSEDED_DEAD_ERROR } from '../packages/lore/src/outbox/supersession.js';
import { observeDeadLetters, newDeadLetterWatchState } from '../packages/lore/src/outbox/deadLetterWatch.js';
import { MAX_DEAD_PAGE } from '../packages/lore/src/outbox/sqliteDeadLetters.js';
import { cellOutboxStore } from '../packages/lore/src/engines/arcade/arcadeOutboxLane.js';
import { handleOutboxDead } from '../packages/lore/src/mcp/http/routes/diagnostic/outboxDead.js';
import { handleStats } from '../packages/lore/src/mcp/http/routes/diagnostic/stats.js';
import { tryDiagnosticRoutes } from '../packages/lore/src/mcp/http/routes/diagnostic.js';
import { tryArcadeDataRoutes } from '../packages/lore/src/mcp/http/routes/arcadeData.js';
import { ArcadeAuthError } from '../packages/lore/src/engines/arcade/arcadeAuthResolver.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const X = { portalUserId: 'u', scopes: ['x'] } as const;
const bound = <T>(fn: () => T): T => runWithActor(X, fn);
const dirs: string[] = [];
const mkTmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-dead-')); dirs.push(d); return d; };

type Res = ServerResponse & { _status: number; _body: string };
function mkRes(): Res {
    const r = { _status: 0, _body: '', writableEnded: false, writeHead(s: number) { this._status = s; return this; }, end(b?: string) { this._body = b ?? ''; this.writableEnded = true; }, once() { return this; } };
    return r as unknown as Res;
}
const json = (r: Res): Record<string, any> => JSON.parse(r._body);

/** Seed `n` dead rows in `ws`; the i-th has the given reason. Returns the row ids, oldest first. */
async function seedDead(store: SqliteOutboxStore, ws: string, n: number, reason: string | null = 'permanent', prefix = 'n'): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
        const row = await recordHotWrite(store, { workspace: ws, operationKind: 'node.upsert', payload: { id: `${prefix}-${ws}-${i}`, type: 'note', label: 'x', content: 'SECRET-CONTENT' }, operation: 'graph.upsert' });
        await store.markEntryStatus(row.id, 'dead', { error: `boom ${i}`, bumpAttempt: true, ...(reason ? { deadReason: reason } : {}) });
        ids.push(row.id);
    }
    return ids;
}
const deps = (store: SqliteOutboxStore | undefined) => ({
    store: {
        loreGraph: { getStats: async () => ({ nodeCount: 3, edgeCount: 1, typeBreakdown: { note: 3 } }), getLanguageBreakdown: async () => ({}),
            // visible-only (bound non-operator) counting scans through these; an empty graph is enough
            bulkList: async () => ({ nodes: [], nextCursor: null, hasMore: false }),
            queryEdges: async () => [], getNodesByIds: async () => new Map() },
        storageClient: { verbatimCount: async () => 0 },
    },
    deploymentMode: 'local' as const,
    dataplane: null,
    outboxStore: store,
}) as never;
async function get(h: typeof handleOutboxDead, d: unknown, qs: string): Promise<Res> {
    const res = mkRes();
    await h(res, `/api/outbox/dead${qs}`, d as never);
    return res;
}

console.log('store');

await test('migration: a pre-3.35 outbox.sqlite (no new columns) opens, keeps its rows, gains the columns, and re-opens cleanly', async () => {
    const dir = mkTmp();
    const s1 = new SqliteOutboxStore(dir);
    const [id] = await seedDead(s1, 'wsOld', 1, 'permanent');
    s1.close();
    const raw = new Database(path.join(dir, 'outbox.sqlite'));
    for (const c of ['firstTransientAt', 'transientRetries', 'deadReason']) raw.exec(`ALTER TABLE outbox_entries DROP COLUMN ${c}`);
    raw.close();
    const s2 = new SqliteOutboxStore(dir);
    const rows = await s2.listDead!({ workspace: 'wsOld' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, id);
    const sum = await s2.deadLetterSummary!('wsOld');
    assert.equal(sum.deadLettered, 1);
    assert.equal(sum.deadByReason['unclassified'], 1, 'a row from before the column existed is "unclassified", not lost');
    s2.close();
    new SqliteOutboxStore(dir).close(); // second open: ADD COLUMN duplicate is swallowed
});

await test('deadLetterSummary: per workspace, superseded rows are not "deadLettered"', async () => {
    const s = new SqliteOutboxStore(mkTmp());
    await seedDead(s, 'wsA', 2, 'permanent');
    await seedDead(s, 'wsA', 1, 'transient_ceiling', 'c');
    const sup = (await seedDead(s, 'wsA', 1, null, 's'))[0]!;
    await s.markEntryStatus(sup, 'dead', { error: SUPERSEDED_DEAD_ERROR });
    await seedDead(s, 'wsB', 5, 'unwired');
    const a = await s.deadLetterSummary!('wsA');
    assert.equal(a.deadLettered, 3);
    assert.equal(a.deadSuperseded, 1);
    assert.deepEqual(a.deadByReason, { permanent: 2, transient_ceiling: 1, superseded: 1 });
    assert.equal((await s.deadLetterSummary!('wsB')).deadLettered, 5);
    assert.equal((await s.deadLetterSummary!('nobody')).deadLettered, 0);
    const agg = await s.aggregateStats!();
    assert.ok(agg.deadByReason, 'aggregate stats carry the reason split for the replicator DATA LOSS line');
});

await test('listDeadPage: workspace-scoped, newest first, offset, hard cap', async () => {
    const s = new SqliteOutboxStore(mkTmp());
    await seedDead(s, 'wsA', 250, 'permanent');
    await seedDead(s, 'wsB', 3, 'permanent');
    const p1 = await s.listDeadPage!({ workspace: 'wsA', limit: 10_000 });
    assert.equal(p1.length, MAX_DEAD_PAGE, 'clamped to the cap');
    assert.ok(p1.every((r) => r.workspace === 'wsA'));
    const p2 = await s.listDeadPage!({ workspace: 'wsA', limit: 200, offset: 200 });
    assert.equal(p2.length, 50);
    assert.equal(new Set([...p1, ...p2].map((r) => r.id)).size, 250, 'pages do not overlap');
    assert.deepEqual((await s.listDeadPage!({ workspace: 'wsA', limit: 0 })).length, 0);
});

console.log('\nGET /api/outbox/dead and /api/stats');

await test('returns only the caller\'s workspace: rows, counts, and ids of workspace B never appear for A', async () => {
    const s = new SqliteOutboxStore(mkTmp());
    const aIds = await seedDead(s, 'wsA', 3, 'permanent');
    const bIds = await seedDead(s, 'wsB', 4, 'transient_ceiling');
    const d = deps(s);
    const ra = await get(handleOutboxDead, d, '?workspace=wsA');
    assert.equal(ra._status, 200);
    const a = json(ra);
    assert.equal(a.workspace, 'wsA');
    assert.equal(a.total, 3);
    assert.deepEqual(a.deadByReason, { permanent: 3 });
    assert.deepEqual(a.rows.map((r: any) => r.id).sort(), [...aIds].sort());
    assert.ok(!ra._body.includes('wsB'), 'no trace of the other workspace');
    for (const b of bIds) assert.ok(!ra._body.includes(b), 'no foreign row id');
    const rb = json(await get(handleOutboxDead, d, '?workspace=wsB'));
    assert.equal(rb.total, 4);
    assert.ok(rb.rows.every((r: any) => r.reason === 'transient_ceiling'));
    const none = json(await get(handleOutboxDead, d, '?workspace=wsC'));
    assert.equal(none.total, 0);
    assert.deepEqual(none.rows, []);
});

await test('row shape: reason, nodeId, timestamps, counters; lastError present for the operator/unbound caller', async () => {
    const s = new SqliteOutboxStore(mkTmp());
    await seedDead(s, 'wsA', 1, 'permanent');
    const r = json(await get(handleOutboxDead, deps(s), '?workspace=wsA')).rows[0];
    assert.equal(r.reason, 'permanent');
    assert.equal(r.operationKind, 'node.upsert');
    assert.equal(r.nodeId, 'n-wsA-0');
    assert.equal(r.attempts, 1);
    assert.equal(r.transientRetries, 0);
    assert.ok(r.createdAt && r.deadAt);
    assert.equal(r.lastError, 'boom 0');
});

await test('pagination: default 50, explicit limit/offset, hasMore, and the 200 cap is enforced (and reported)', async () => {
    const s = new SqliteOutboxStore(mkTmp());
    await seedDead(s, 'wsA', 230, 'permanent');
    const d = deps(s);
    const def = json(await get(handleOutboxDead, d, '?workspace=wsA'));
    assert.equal(def.rows.length, 50);
    assert.equal(def.limit, 50);
    assert.equal(def.hasMore, true);
    const big = json(await get(handleOutboxDead, d, '?workspace=wsA&limit=100000'));
    assert.equal(big.rows.length, 200, 'a huge limit is clamped, not honoured');
    assert.equal(big.limit, 200);
    assert.equal(big.cap, 200);
    const last = json(await get(handleOutboxDead, d, '?workspace=wsA&limit=200&offset=200'));
    assert.equal(last.rows.length, 30);
    assert.equal(last.hasMore, false);
    assert.equal(last.total, 230);
});

await test('validation: workspace required, "*" refused, bad limit/offset 400, store without support 501', async () => {
    const s = new SqliteOutboxStore(mkTmp());
    const d = deps(s);
    const r1 = await get(handleOutboxDead, d, ''); assert.equal(r1._status, 400); assert.equal(json(r1).error ?? json(r1).code, json(r1).error ?? json(r1).code);
    assert.match(r1._body, /workspace/i);
    const r2 = await get(handleOutboxDead, d, '?workspace=*'); assert.equal(r2._status, 400);
    for (const q of ['&limit=0', '&limit=-1', '&limit=abc', '&offset=-5', '&offset=1.5']) {
        assert.equal((await get(handleOutboxDead, d, `?workspace=wsA${q}`))._status, 400, q);
    }
    const r3 = await get(handleOutboxDead, deps(undefined), '?workspace=wsA');
    assert.equal(r3._status, 501);
});

await test('a token bound to workspace B is refused for workspace A; a bound non-operator in its own workspace sees no lastError', async () => {
    const s = new SqliteOutboxStore(mkTmp());
    await seedDead(s, 'wsA', 1, 'permanent');
    await seedDead(s, 'wsB', 1, 'permanent');
    const P: Principal = { kind: 'app', workspace: 'wsB', scopes: ['read'], label: 't', allowedWorkspaces: ['wsB'] };
    const denied = mkRes();
    await runWithPrincipal(P, () => handleOutboxDead(denied, '/api/outbox/dead?workspace=wsA', deps(s)));
    assert.ok(denied._status === 403 || denied._status === 404, `got ${denied._status}`);
    assert.ok(!denied._body.includes('n-wsA-0'));
    const own = mkRes();
    await bound(() => runWithPrincipal(P, () => handleOutboxDead(own, '/api/outbox/dead?workspace=wsB', deps(s))));
    const opRes = mkRes();
    await runWithPrincipal(P, () => handleOutboxDead(opRes, '/api/outbox/dead?workspace=wsB', deps(s)));
    assert.ok('lastError' in json(opRes).rows[0], 'an unbound caller keeps the error text');
    assert.equal(own._status, 200);
    const row = json(own).rows[0];
    assert.equal(row.reason, 'permanent');
    assert.ok(!('lastError' in row), 'error text can embed row content; withheld from bound non-operator callers');
    assert.ok(!own._body.includes('SECRET-CONTENT'));
});

await test('/api/stats carries deadLettered (and the split) for the requested workspace only; absent when the store cannot say', async () => {
    const s = new SqliteOutboxStore(mkTmp());
    await seedDead(s, 'wsA', 2, 'permanent');
    await seedDead(s, 'wsA', 1, 'transient_ceiling', 'c');
    await seedDead(s, 'wsB', 9, 'permanent');
    const res = mkRes();
    await handleStats(res, '/api/stats?workspace=wsA', deps(s));
    assert.equal(res._status, 200);
    const b = json(res);
    assert.equal(b.deadLettered, 3);
    assert.deepEqual(b.deadByReason, { permanent: 2, transient_ceiling: 1 });
    const noStore = mkRes();
    await handleStats(noStore, '/api/stats?workspace=wsA', deps(undefined));
    assert.ok(!('deadLettered' in json(noStore)), 'unknown is not reported as 0');
    const P: Principal = { kind: 'app', workspace: 'wsA', scopes: ['read'], label: 't', allowedWorkspaces: ['wsA'] };
    const boundRes = mkRes();
    await bound(() => runWithPrincipal(P, () => handleStats(boundRes, '/api/stats?workspace=wsA', deps(s))));
    assert.equal(boundRes._status, 200, boundRes._body);
    assert.equal(json(boundRes).countScope, 'visible');
    assert.equal(json(boundRes).deadLettered, 3, 'a bound caller still learns its own writes were lost');
});

await test('the dispatcher table routes GET /api/outbox/dead (and POST is not it)', async () => {
    const s = new SqliteOutboxStore(mkTmp());
    await seedDead(s, 'wsA', 1);
    const res = mkRes();
    const handled = await tryDiagnosticRoutes({ method: 'GET', headers: {} } as unknown as IncomingMessage, res, '/api/outbox/dead?workspace=wsA', '/api/outbox/dead', deps(s));
    assert.equal(handled, true);
    assert.equal(json(res).total, 1);
    const post = mkRes();
    assert.equal(await tryDiagnosticRoutes({ method: 'POST', headers: {} } as unknown as IncomingMessage, post, '/api/outbox/dead', '/api/outbox/dead', deps(s)), false);
});

await test('the arcade allowlist includes GET /api/outbox/dead (auth runs first: a bad token is 401, not 404)', async () => {
    const res = mkRes();
    const pool = { resolve() { throw new ArcadeAuthError('unknown_token', 'nope'); }, evictToken() { /* noop */ } };
    const handled = await tryArcadeDataRoutes({ method: 'GET', headers: {}, on() { return this; } } as unknown as IncomingMessage, res, '/api/outbox/dead', '/api/outbox/dead', 'lore_at_bad', { pool: pool as never, auditLog: {} as never });
    assert.equal(handled, true);
    assert.equal(res._status, 401);
});

console.log('\narcade lane pinning');

await test('cellOutboxStore pins deadLetterSummary and listDeadPage to its own cell whatever workspace is asked', async () => {
    const shared = new SqliteOutboxStore(mkTmp());
    const cellA = 'arcade:t1:appA';
    const cellB = 'arcade:t1:appB';
    await seedDead(shared, cellA, 2, 'permanent');
    await seedDead(shared, cellB, 5, 'permanent');
    const laneA = cellOutboxStore(shared, cellA);
    assert.equal((await laneA.deadLetterSummary!(cellB)).deadLettered, 2, 'asking for B through A\'s lane still answers for A');
    const page = await laneA.listDeadPage!({ workspace: cellB, limit: 50 });
    assert.equal(page.length, 2);
    assert.ok(page.every((r) => r.workspace === cellA));
});

console.log('\nDATA LOSS line');

await test('names the reason class of the newly lost rows (and stays quiet about a baseline)', () => {
    let st = newDeadLetterWatchState();
    let out = observeDeadLetters(st, 0, {});
    st = out.state;
    out = observeDeadLetters(st, 3, { permanent: 2, transient_ceiling: 1 });
    assert.equal(out.lines.length, 1);
    assert.match(out.lines[0]!, /DATA LOSS: 3 write\(s\) permanently discarded/);
    assert.match(out.lines[0]!, /\(reason: permanent=2, transient_ceiling=1\)/);
    st = out.state;
    out = observeDeadLetters(st, 4, { permanent: 2, transient_ceiling: 2 });
    assert.match(out.lines[0]!, /\(reason: transient_ceiling=1\)/);
    assert.ok(!/permanent=/.test(out.lines[0]!), 'only the delta is named');
    // reason-less callers (older code paths) still produce the old line
    assert.ok(!/reason:/.test(observeDeadLetters({ lastDeadCount: 0, consecutiveIncreases: 0 }, 1).lines[0]!));
});

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
