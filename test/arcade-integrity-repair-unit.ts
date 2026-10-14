#!/usr/bin/env tsx
/**
 * arcade-integrity-repair-unit.ts - Lore 3.34.0 slice 2 (repair route for ArcadeDB ghost records).
 *
 * A "ghost" is a LoreNode bucket record the unique LoreNode[id] index has no entry for. The scan
 * walks the bucket by @rid and compares it with the id lookup; removal is by @rid, refuses a record
 * the id lookup can read, and is idempotent. Covered here against an in-memory fake of the ArcadeDB
 * transport (the SQL itself was verified on a real ArcadeDB 26.7.1, see the slice 2 PR):
 *   - library: healthy bucket, null-id ghost, id-less-index ghost, duplicate-id ghost, paging across
 *     the 500-row page, rid-literal cursor (never a bound param), rid validation, removal outcomes
 *   - capability shape: ArcadeGraphStore declares it; runIntegrityRepair answers not_supported for a
 *     graph without it or one that says unsupported
 *   - route: method / body / rid validation, operator-only lane, cell_missing, secret_missing,
 *     cell_lease_held, dry-run default (no write), real run, idempotent re-run, audit content
 *   - the arcade_migrate rate class covers the route
 *
 * Run: npx tsx test/arcade-integrity-repair-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LORE_HOME = path.join(os.tmpdir(), `arcade-integrity-lorehome-${Date.now().toString(36)}${process.pid.toString(36)}`);
fs.mkdirSync(LORE_HOME, { recursive: true });
process.env['LORE_HOME'] = LORE_HOME;

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ArcadeHttp } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { ArcadeGraphStore } from '../packages/lore/src/engines/arcade/arcadeGraphStore.js';
import { assertRid, scanNodeIntegrity, removeNodeRecords } from '../packages/lore/src/engines/arcade/arcadeIntegrity.js';
import { openRegistryDb, closeRegistryDb, upsertTenantAppRow } from '../packages/lore/src/engines/arcade/arcadeRegistryStore.js';
import { secretRefFor } from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';
import { getCellLeaseStore } from '../packages/lore/src/engines/arcade/arcadeCellLease.js';
import { tryArcadeRepairRoutes, runIntegrityRepair } from '../packages/lore/src/mcp/http/routes/arcadeRepair.js';
import { classifyArcadeRequest } from '../packages/lore/src/security/arcadeRateClassifier.js';
import { runWithPrincipal } from '../packages/lore/src/auth/principal.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import type { AuditLog } from '../packages/lore/src/security/audit.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

type Row = Record<string, unknown>;
interface Rec { rid: string; id: string | null; revision: number; createdAt: string; indexed: boolean }

/** In-memory LoreNode bucket + id index, answering exactly the SQL the integrity module issues. */
class FakeBucket {
    records: Rec[] = [];
    queries: string[] = [];
    deletes: string[] = [];
    /** `DELETE VERTEX FROM LoreNode WHERE @rid = :rid` reports count 0 (forces the DELETE FROM #rid fallback). */
    vertexDeleteMatchesNothing = false;
    /** The delete statements run but the record stays (removal must throw rather than claim success). */
    deleteHasNoEffect = false;
    private n = 0;
    add(id: string | null, opts: { indexed?: boolean; revision?: number } = {}): Rec {
        const rec: Rec = { rid: `#9:${this.n++}`, id, revision: opts.revision ?? 1, createdAt: '2026-10-01T00:00:00.000Z', indexed: opts.indexed ?? id !== null };
        this.records.push(rec);
        return rec;
    }
    private static pos = (rid: string): number => Number(rid.split(':')[1]);
    private sorted(): Rec[] { return [...this.records].sort((a, b) => FakeBucket.pos(a.rid) - FakeBucket.pos(b.rid)); }
    async query(_db: string, sql: string, params: Row = {}): Promise<{ result: Row[] }> {
        this.queries.push(sql);
        if (sql.startsWith('SELECT @rid AS rid, id, revision, createdAt FROM LoreNode')) {
            const cursor = /WHERE @rid > (#\d+:\d+) /.exec(sql)?.[1];
            const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1]);
            const page = this.sorted().filter((r) => !cursor || FakeBucket.pos(r.rid) > FakeBucket.pos(cursor)).slice(0, limit);
            return { result: page.map((r) => ({ rid: r.rid, id: r.id, revision: r.revision, createdAt: r.createdAt })) };
        }
        if (sql.startsWith('SELECT id FROM LoreNode WHERE security_scopes IS NULL')) {
            // A null-id ghost has no scopes either, and no backfill UPDATE can ever fix it.
            return { result: this.records.filter((r) => r.id === null).map((r) => ({ id: r.id })) };
        }
        if (sql.includes('WHERE id IN :ids')) {
            const ids = new Set(params['ids'] as string[]);
            return { result: this.records.filter((r) => r.indexed && r.id !== null && ids.has(r.id)).map((r) => ({ rid: r.rid, id: r.id })) };
        }
        if (sql.includes('WHERE @rid = :rid')) {
            const r = this.records.find((x) => x.rid === params['rid']);
            if (!r) return { result: [] };
            return { result: [sql.startsWith('SELECT @rid AS rid, id FROM') ? { rid: r.rid, id: r.id } : { rid: r.rid }] };
        }
        if (sql.includes('WHERE id = :id')) {
            return { result: this.records.filter((r) => r.indexed && r.id === params['id']).map((r) => ({ rid: r.rid })) };
        }
        return { result: [] };
    }
    /** The scope backfill's UPDATE script: accepted, but it can never match a null-id record. */
    async commandScript(): Promise<{ result: Row[] }> { return { result: [] }; }
    async command(_db: string, sql: string, params: Row = {}): Promise<{ result: Row[] }> {
        if (!/^DELETE/.test(sql)) return { result: [] };
        this.queries.push(sql);
        const vertex = /^DELETE VERTEX FROM LoreNode WHERE @rid = :rid$/.exec(sql);
        const direct = /^DELETE FROM (#\d+:\d+)$/.exec(sql);
        const rid = vertex ? String(params['rid']) : direct?.[1];
        if (!rid) throw new Error(`unexpected delete: ${sql}`);
        this.deletes.push(sql);
        if (vertex && this.vertexDeleteMatchesNothing) return { result: [{ count: 0 }] };
        const had = this.records.some((r) => r.rid === rid);
        if (!this.deleteHasNoEffect) this.records = this.records.filter((r) => r.rid !== rid);
        return { result: [{ count: had ? 1 : 0 }] };
    }
}
const asHttp = (b: FakeBucket): ArcadeHttp => b as unknown as ArcadeHttp;
const DB = 'db_fake';

console.log('\nLibrary: scan\n');

await test('a healthy bucket has no suspects', async () => {
    const b = new FakeBucket();
    for (let i = 0; i < 12; i++) b.add(`n${i}`);
    const scan = await scanNodeIntegrity(DB, asHttp(b));
    assert.equal(scan.supported && scan.scanned, 12);
    assert.deepEqual(scan.supported && scan.suspects, []);
});
await test('an empty bucket scans cleanly', async () => {
    const scan = await scanNodeIntegrity(DB, asHttp(new FakeBucket()));
    assert.ok(scan.supported);
    assert.equal(scan.supported && scan.scanned, 0);
});
await test('null-id ghost, index-invisible ghost and duplicate-id ghost are all reported with diagnostics', async () => {
    const b = new FakeBucket();
    b.add('live-1');
    const nullId = b.add(null, { revision: 3 });
    const invisible = b.add('hidden', { indexed: false, revision: 7 });
    const real = b.add('dup');
    const dupGhost = b.add('dup', { indexed: false, revision: 2 });
    const scan = await scanNodeIntegrity(DB, asHttp(b));
    assert.ok(scan.supported);
    const byRid = new Map(scan.suspects.map((s) => [s.rid, s]));
    assert.equal(scan.suspects.length, 3);
    assert.deepEqual(byRid.get(nullId.rid), { rid: nullId.rid, id: null, revision: 3, createdAt: nullId.createdAt, scanFound: true, indexFound: false, indexRid: null });
    assert.deepEqual(byRid.get(invisible.rid), { rid: invisible.rid, id: 'hidden', revision: 7, createdAt: invisible.createdAt, scanFound: true, indexFound: false, indexRid: null });
    const dup = byRid.get(dupGhost.rid)!;
    assert.equal(dup.indexRid, real.rid, 'the duplicate ghost names the record the index does point at');
    assert.equal(byRid.has(real.rid), false, 'the indexed twin is live');
});
await test('paging: 1200 records span three pages, ghosts either side of a page boundary are found, cursor is a rid LITERAL', async () => {
    const b = new FakeBucket();
    const ghosts: string[] = [];
    for (let i = 0; i < 1200; i++) {
        if (i === 499 || i === 500 || i === 1199) ghosts.push(b.add(`g${i}`, { indexed: false }).rid);
        else b.add(`n${i}`);
    }
    const scan = await scanNodeIntegrity(DB, asHttp(b));
    assert.ok(scan.supported);
    assert.equal(scan.scanned, 1200);
    assert.deepEqual(scan.suspects.map((s) => s.rid).sort(), ghosts.sort());
    const scans = b.queries.filter((q) => q.includes('ORDER BY @rid'));
    assert.equal(scans.length, 3);
    assert.ok(scans.slice(1).every((q) => /WHERE @rid > #9:\d+ ORDER BY/.test(q)), 'cursor inlined as a rid literal');
    assert.ok(b.queries.every((q) => !/@rid > :/.test(q)), 'never a bound-param rid comparison (does not match on ArcadeDB)');
});
await test('the scan is read-only', async () => {
    const b = new FakeBucket();
    b.add(null);
    await scanNodeIntegrity(DB, asHttp(b));
    assert.deepEqual(b.deletes, []);
    assert.ok(b.queries.every((q) => q.startsWith('SELECT')));
});
await test('assertRid accepts record ids and rejects anything else', () => {
    assert.equal(assertRid('#12:345'), '#12:345');
    for (const bad of ['12:3', '#12', '#a:b', '#1:2; DROP TYPE LoreNode', '', '#1:2 ', '#-1:2']) {
        assert.throws(() => assertRid(bad), /invalid record id/, bad);
    }
});

console.log('\nLibrary: removal\n');

await test('a ghost is removed by @rid and reported removed', async () => {
    const b = new FakeBucket();
    b.add('live');
    const ghost = b.add(null);
    const out = await removeNodeRecords(DB, asHttp(b), [ghost.rid]);
    assert.ok(out.supported);
    assert.deepEqual(out.supported && out.removed, [ghost.rid]);
    assert.equal(b.records.length, 1);
    assert.deepEqual(b.deletes, ['DELETE VERTEX FROM LoreNode WHERE @rid = :rid']);
});
await test('a live readable node is REFUSED and never deleted', async () => {
    const b = new FakeBucket();
    const live = b.add('live');
    const out = await removeNodeRecords(DB, asHttp(b), [live.rid]);
    assert.ok(out.supported);
    assert.deepEqual(out.supported && out.refused, [{ rid: live.rid, reason: 'live_readable' }]);
    assert.deepEqual(out.supported && out.removed, []);
    assert.equal(b.records.length, 1);
    assert.deepEqual(b.deletes, []);
});
await test('a ghost that shares its id with an indexed twin is removable; the twin is refused', async () => {
    const b = new FakeBucket();
    const twin = b.add('dup');
    const ghost = b.add('dup', { indexed: false });
    const out = await removeNodeRecords(DB, asHttp(b), [twin.rid, ghost.rid]);
    assert.ok(out.supported);
    assert.deepEqual(out.supported && out.removed, [ghost.rid]);
    assert.deepEqual(out.supported && out.refused.map((r) => r.rid), [twin.rid]);
    assert.deepEqual(b.records.map((r) => r.rid), [twin.rid]);
});
await test('a record that is already gone is absent, and a second run is a no-op (idempotent)', async () => {
    const b = new FakeBucket();
    const ghost = b.add(null);
    const first = await removeNodeRecords(DB, asHttp(b), [ghost.rid]);
    const second = await removeNodeRecords(DB, asHttp(b), [ghost.rid]);
    assert.ok(first.supported && second.supported);
    assert.deepEqual(second.supported && second.absent, [ghost.rid]);
    assert.deepEqual(second.supported && second.removed, []);
    assert.equal(b.deletes.length, 1);
});
await test('duplicate rids in one request are removed once', async () => {
    const b = new FakeBucket();
    const ghost = b.add(null);
    const out = await removeNodeRecords(DB, asHttp(b), [ghost.rid, ghost.rid]);
    assert.ok(out.supported);
    assert.deepEqual(out.supported && out.removed, [ghost.rid]);
    assert.equal(b.deletes.length, 1);
});
await test('falls back to DELETE FROM #rid when the type-scoped delete matches nothing', async () => {
    const b = new FakeBucket();
    b.vertexDeleteMatchesNothing = true;
    const ghost = b.add(null);
    const out = await removeNodeRecords(DB, asHttp(b), [ghost.rid]);
    assert.ok(out.supported);
    assert.deepEqual(out.supported && out.removed, [ghost.rid]);
    assert.deepEqual(b.deletes, ['DELETE VERTEX FROM LoreNode WHERE @rid = :rid', `DELETE FROM ${ghost.rid}`]);
});
await test('a delete that does not take effect throws; it is never reported removed', async () => {
    const b = new FakeBucket();
    b.deleteHasNoEffect = true;
    const ghost = b.add(null);
    await assert.rejects(removeNodeRecords(DB, asHttp(b), [ghost.rid]), /did not take effect/);
});
await test('a malformed rid is rejected before any statement runs', async () => {
    const b = new FakeBucket();
    await assert.rejects(removeNodeRecords(DB, asHttp(b), ['#1:2; DROP TYPE LoreNode']), /invalid record id/);
    assert.deepEqual(b.queries, []);
});

console.log('\nCapability shape and runIntegrityRepair\n');

await test('ArcadeGraphStore declares the capability and delegates to the module', async () => {
    const b = new FakeBucket();
    b.add('live');
    const ghost = b.add(null);
    const g = new ArcadeGraphStore({ tenantDb: DB, http: asHttp(b) });
    assert.equal(typeof g.integrityScan, 'function');
    assert.equal(typeof g.integrityRemove, 'function');
    const scan = await g.integrityScan();
    assert.ok(scan.supported);
    assert.deepEqual(scan.supported && scan.suspects.map((s) => s.rid), [ghost.rid]);
    const removal = await g.integrityRemove([ghost.rid]);
    assert.deepEqual(removal.supported && removal.removed, [ghost.rid]);
});
await test('a null-id ghost does not block the repair on a fresh store (live bug: initialize() backfill threw)', async () => {
    const b = new FakeBucket();
    b.add('live');
    const ghost = b.add(null);
    // Regression guard on the fake itself: the ordinary initialize() path DOES throw here.
    await assert.rejects(() => new ArcadeGraphStore({ tenantDb: DB, http: asHttp(b) }).initialize(), /made no progress/);
    const g = new ArcadeGraphStore({ tenantDb: DB, http: asHttp(b) });
    b.queries.length = 0;
    const out = await runIntegrityRepair(g, false, undefined);
    assert.equal(out.kind, 'ok');
    assert.ok(!b.queries.some((q) => q.includes('security_scopes IS NULL')), 'integrity methods must not run the scope backfill');
    assert.deepEqual(b.records.map((r) => r.rid).includes(ghost.rid), false);
});
await test('a graph without the capability answers not_supported (bare object)', async () => {
    const out = await runIntegrityRepair({} as never, true, undefined);
    assert.equal(out.kind, 'not_supported');
});
await test('a graph whose scan says unsupported (the SQLite / Dataplane answer) is not_supported with its reason', async () => {
    const g = {
        integrityScan: async () => ({ supported: false as const, status: 'not_supported' as const, reason: 'no separate index here' }),
        integrityRemove: async () => { throw new Error('must not be called'); },
    };
    const out = await runIntegrityRepair(g as never, false, ['#1:1']);
    assert.deepEqual(out, { kind: 'not_supported', reason: 'no separate index here' });
});
await test('dry run never calls remove; a real run removes the scanned suspects, or only the requested rids', async () => {
    const calls: string[][] = [];
    const g = {
        integrityScan: async () => ({ supported: true as const, status: 'ok' as const, scanned: 5, suspects: [{ rid: '#9:1' }, { rid: '#9:2' }] }),
        integrityRemove: async (rids: string[]) => { calls.push(rids); return { supported: true as const, status: 'ok' as const, removed: rids, absent: [], refused: [] }; },
    };
    const dry = await runIntegrityRepair(g as never, true, ['#9:1']);
    assert.equal(dry.kind === 'ok' && dry.removal, undefined);
    assert.deepEqual(calls, []);
    await runIntegrityRepair(g as never, false, undefined);
    await runIntegrityRepair(g as never, false, ['#9:2']);
    assert.deepEqual(calls, [['#9:1', '#9:2'], ['#9:2']]);
});
await test('a real run with nothing to remove never calls remove', async () => {
    const g = {
        integrityScan: async () => ({ supported: true as const, status: 'ok' as const, scanned: 3, suspects: [] }),
        integrityRemove: async () => { throw new Error('must not be called'); },
    };
    const out = await runIntegrityRepair(g as never, false, undefined);
    assert.deepEqual(out.kind === 'ok' && out.removal, { removed: [], absent: [], refused: [] });
});

console.log('\nRoute: POST /api/arcade/apps/:tenant/:app/repair-integrity\n');

let bucket = new FakeBucket();
const realQuery = ArcadeHttp.prototype.query, realCommand = ArcadeHttp.prototype.command;
ArcadeHttp.prototype.query = (async function (db: string, sql: string, params?: Row) { return bucket.query(db, sql, params ?? {}); }) as never;
ArcadeHttp.prototype.command = (async function (db: string, sql: string, params?: Row) { return bucket.command(db, sql, params ?? {}); }) as never;

function cell(tag: string, opts: { pass?: string | null } = {}): { tenantId: string; appId: string; url: string } {
    const tenantId = `ir${tag}t`, appId = `ir${tag}a`;
    upsertTenantAppRow(openRegistryDb(), {
        tenantId, appId, dbName: `db_${tenantId}_${appId}`, dbUser: 'svc_user', dbPass: opts.pass === undefined ? 'svc_pass' : opts.pass,
        secretRef: secretRefFor(tenantId, appId), status: 'active', createdAt: new Date().toISOString(),
    });
    return { tenantId, appId, url: `/api/arcade/apps/${tenantId}/${appId}/repair-integrity` };
}
function fakeReq(method: string, body?: string): IncomingMessage {
    let consumed = false;
    return {
        method, headers: {},
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data' && body !== undefined && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
type FakeRes = ServerResponse & { _status: number; _body: string };
function fakeRes(): FakeRes {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        setHeader() { return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as FakeRes;
}
const audit: Array<{ toolName: string; args: Record<string, unknown>; result: string; resultDetail?: string }> = [];
const auditLog = { log: (e: never) => { audit.push(e); } } as unknown as AuditLog;
const json = (r: FakeRes): Record<string, unknown> => JSON.parse(r._body) as Record<string, unknown>;
async function call(url: string, method: string, body?: unknown): Promise<FakeRes> {
    const res = fakeRes();
    const handled = await tryArcadeRepairRoutes(fakeReq(method, body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)), res, url, { auditLog });
    assert.equal(handled, true);
    return res;
}

await test('an unrelated path is not handled', async () => {
    const res = fakeRes();
    assert.equal(await tryArcadeRepairRoutes(fakeReq('POST', '{}'), res, '/api/arcade/apps/x/y/backup', { auditLog }), false);
});
await test('only POST is allowed (405)', async () => {
    const c = cell('m');
    const res = await call(c.url, 'GET');
    assert.equal(res._status, 405);
    assert.equal(json(res)['code'], 'method_not_allowed');
});
await test('invalid JSON is 400; a non-boolean dryRun is 400 bad_request', async () => {
    const c = cell('v');
    assert.equal((await call(c.url, 'POST', '{not json'))._status, 400);
    const res = await call(c.url, 'POST', { dryRun: 'false' });
    assert.equal(res._status, 400);
    assert.equal(json(res)['code'], 'bad_request');
});
await test('rids must be an array of at most 1000 well-formed record ids (400 invalid_rids)', async () => {
    const c = cell('r');
    for (const rids of ['#1:2', ['#1:2', 'nope'], ['#1:2; DROP TYPE LoreNode'], [5], Array.from({ length: 1001 }, (_, i) => `#1:${i}`)]) {
        const res = await call(c.url, 'POST', { rids });
        assert.equal(res._status, 400, JSON.stringify(rids).slice(0, 40));
        assert.equal(json(res)['code'], 'invalid_rids');
    }
});
await test('operator lane: an app token without cross-workspace-write is refused and nothing is read', async () => {
    const c = cell('o1');
    bucket = new FakeBucket();
    bucket.add(null);
    const res = fakeRes();
    await runWithPrincipal({ kind: 'app', workspace: 'ws1', scopes: ['read', 'write'], label: 't', allowedWorkspaces: ['ws1'] } as never, async () => {
        await tryArcadeRepairRoutes(fakeReq('POST', '{}'), res, c.url, { auditLog });
    });
    assert.equal(res._status, 403);
    assert.deepEqual(bucket.queries, []);
});
await test('operator lane: a bound non-operator actor (row-scoped) is refused (403 maintenance_forbidden)', async () => {
    const c = cell('o2');
    bucket = new FakeBucket();
    const res = fakeRes();
    await runWithActor({ portalUserId: 'user-1', scopes: ['team-a'] }, async () => {
        await tryArcadeRepairRoutes(fakeReq('POST', '{}'), res, c.url, { auditLog });
    });
    assert.equal(res._status, 403);
    assert.deepEqual(bucket.queries, []);
});
await test('a bootstrap operator principal is admitted', async () => {
    const c = cell('o3');
    bucket = new FakeBucket();
    const res = fakeRes();
    await runWithPrincipal({ kind: 'bootstrap', workspace: 'ws1', scopes: ['read', 'write'], label: 'bootstrap' } as never, async () => {
        await tryArcadeRepairRoutes(fakeReq('POST', '{}'), res, c.url, { auditLog });
    });
    assert.equal(res._status, 200);
});
await test('identifiers are validated (400 invalid_identifier)', async () => {
    const res = await call('/api/arcade/apps/BAD!/app1/repair-integrity', 'POST', {});
    assert.equal(res._status, 400);
    assert.equal(json(res)['code'], 'invalid_identifier');
});
await test('unprovisioned cell is 404 cell_missing; a cell with no secret is 500 secret_missing', async () => {
    const missing = await call('/api/arcade/apps/nosuchtenant/nosuchapp/repair-integrity', 'POST', {});
    assert.equal(missing._status, 404);
    assert.equal(json(missing)['code'], 'cell_missing');
    const c = cell('s', { pass: '' });
    const noSecret = await call(c.url, 'POST', {});
    assert.equal(noSecret._status, 500);
    assert.equal(json(noSecret)['code'], 'secret_missing');
});
await test('a cell lease held by another daemon is 409 cell_lease_held with holder and retryAfterSec', async () => {
    const c = cell('l');
    const store = getCellLeaseStore();
    const got = await store.acquire(c.tenantId, c.appId, 'other-daemon:1:abcd', 60_000);
    assert.ok(got.ok);
    try {
        const res = await call(c.url, 'POST', {});
        assert.equal(res._status, 409);
        const b = json(res);
        assert.equal(b['code'], 'cell_lease_held');
        assert.equal(b['holder'], 'other-daemon:1:abcd');
        assert.equal(typeof b['retryAfterSec'], 'number');
    } finally {
        await store.release(c.tenantId, c.appId, 'other-daemon:1:abcd');
    }
});
await test('default is a DRY RUN: lists suspects with diagnostics, writes nothing, audits counts and rids only', async () => {
    const c = cell('d');
    bucket = new FakeBucket();
    bucket.add('live-a');
    const nullGhost = bucket.add(null, { revision: 4 });
    const hidden = bucket.add('secret-content-id', { indexed: false });
    audit.length = 0;
    for (const body of [undefined, '', {}, { dryRun: true }]) {
        const res = await call(c.url, 'POST', body);
        assert.equal(res._status, 200, JSON.stringify(body));
        const b = json(res);
        assert.equal(b['ok'], true);
        assert.equal(b['dryRun'], true);
        assert.equal(b['scanned'], 3);
        assert.deepEqual((b['suspects'] as Array<{ rid: string }>).map((s) => s.rid).sort(), [nullGhost.rid, hidden.rid].sort());
        assert.equal('removed' in b, false, 'a dry run reports no removal');
    }
    assert.equal(bucket.records.length, 3);
    assert.deepEqual(bucket.deletes, []);
    const row = audit[audit.length - 1]!;
    assert.equal(row.toolName, 'arcade.repair-integrity');
    assert.equal(row.args['dryRun'], true);
    assert.equal(row.args['suspects'], 2);
    assert.deepEqual((row.args['rids'] as string[]).sort(), [nullGhost.rid, hidden.rid].sort());
    assert.ok(!JSON.stringify(row).includes('secret-content-id'), 'the audit row carries record ids, never node ids or content');
});
await test('dryRun:false removes the ghosts by @rid, leaves live nodes, and re-running is a no-op', async () => {
    const c = cell('w');
    bucket = new FakeBucket();
    const live = bucket.add('live-a');
    const g1 = bucket.add(null);
    const g2 = bucket.add('hidden', { indexed: false });
    audit.length = 0;
    const res = await call(c.url, 'POST', { dryRun: false });
    assert.equal(res._status, 200);
    const b = json(res);
    assert.equal(b['dryRun'], false);
    assert.deepEqual((b['removed'] as string[]).sort(), [g1.rid, g2.rid].sort());
    assert.deepEqual(b['refused'], []);
    assert.deepEqual(bucket.records.map((r) => r.rid), [live.rid]);
    assert.equal(audit[audit.length - 1]!.args['removed'], 2);
    const again = json(await call(c.url, 'POST', { dryRun: false }));
    assert.deepEqual(again['removed'], []);
    assert.deepEqual(again['suspects'], []);
    const explicit = json(await call(c.url, 'POST', { dryRun: false, rids: [g1.rid] }));
    assert.deepEqual(explicit['absent'], [g1.rid]);
});
await test('an explicit rid naming a LIVE node is refused (live_readable) and the node survives', async () => {
    const c = cell('x');
    bucket = new FakeBucket();
    const live = bucket.add('live-a');
    const res = await call(c.url, 'POST', { dryRun: false, rids: [live.rid] });
    assert.equal(res._status, 200);
    const b = json(res);
    assert.deepEqual(b['refused'], [{ rid: live.rid, reason: 'live_readable' }]);
    assert.deepEqual(b['removed'], []);
    assert.equal(bucket.records.length, 1);
});
await test('the lease is released after a call (a second call is not 409)', async () => {
    const c = cell('z');
    bucket = new FakeBucket();
    assert.equal((await call(c.url, 'POST', {}))._status, 200);
    assert.equal((await call(c.url, 'POST', {}))._status, 200);
});

console.log('\nRate class\n');

await test('repair-integrity shares the arcade_migrate bucket; the neighbours are unchanged', () => {
    assert.equal(classifyArcadeRequest('/api/arcade/apps/t1/a1/repair-integrity', 'POST'), 'arcade_migrate');
    assert.equal(classifyArcadeRequest('/api/arcade/apps/t1/a1/backup', 'POST'), 'arcade_migrate');
    assert.equal(classifyArcadeRequest('/api/arcade/apps/t1/a1/restore', 'POST'), 'arcade_migrate');
    assert.equal(classifyArcadeRequest('/api/arcade/apps/t1/a1/tokens', 'POST'), 'arcade_admin');
});

ArcadeHttp.prototype.query = realQuery;
ArcadeHttp.prototype.command = realCommand;
closeRegistryDb();
try { fs.rmSync(LORE_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
