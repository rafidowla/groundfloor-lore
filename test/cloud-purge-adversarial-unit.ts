#!/usr/bin/env tsx
/**
 * cloud-purge-adversarial-unit.ts — the DELETING half of the cloud workspace purge
 * (packages/lore/src/engines/dataplaneWorkspacePurgeApply.ts), against the engine-faithful mock only.
 *
 * Proves, in both query modes ('full' SQL push-down, 'sqlite' filter/sort/offset ignored) where meaningful:
 *   - isolation: two orgs on one connector (same workspace id + lore_ids), two workspaces in one org, and a
 *     same-name recreate under a new id: only the target's keyed rows go, everything else is deep-equal before/after;
 *   - lore_verbatim (canonical, #rev snapshots, tombstones) goes by raw scoped deletes: no insert (tombstone) ever;
 *   - unkeyed / spoofed rows (scope columns match, wrong `id`, even a shared lore_id) are never deleted, only reported;
 *   - a filter-ignoring connector: small collections complete, a collection past one page ends exit 3 without
 *     touching a foreign row;
 *   - swallowed per-row delete failures: transient -> single `id_eq` survivor delete completes; persistent -> exit 2
 *     (no-progress) with no further requests;
 *   - an interrupted run (client throws) is exit 2 with partial counts; a rerun completes, other scopes unchanged;
 *   - guard throws before a later pass -> abort, no delete after it; probeCheck throws -> zero lore_node deletes;
 *   - maxRows stops cleanly (exit 3), a rerun finishes; a rerun after completion sends zero deletes (exit 0);
 *   - filter safety over the WHOLE request log of every run: every delete carries both scope clauses and a
 *     `connection`, plus `lore_id in [<=100]` or an `id_eq`; never `all`; never /v1/transaction; no writes but deletes.
 * No network call to any real service: the mock listens on 127.0.0.1.
 */
import assert from 'node:assert/strict';
import { startMockDataplane, type MockDataplane } from './helpers/mock-dataplane.js';
import { createMockDataplaneClient } from './helpers/mock-dataplane-client.js';
import { scopeRowFields, type DataplaneScope } from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import { assertPurgeScopeFilter, purgeCollectionOrder, type WriteProbe } from '../packages/lore/src/engines/dataplaneWorkspacePurge.js';
import { applyWorkspacePurge, type ApplyPurgeInput, type PurgeApplyClient, type PurgeApplyResult } from '../packages/lore/src/engines/dataplaneWorkspacePurgeApply.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${((e as Error).stack ?? (e as Error).message).slice(0, 3000)}`); failed++; }
}

const KEY = 'purge-key';
const DP = 'dp-ws-purge-apply';
const CONN = 'postgresql';
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const TARGET = 'ws-target-0001';
const OTHER = 'ws-other-0002';
const RECREATED = 'ws-target-0001-v2';
const APP = 'lore_app_things';
const COLLECTIONS = purgeCollectionOrder([APP]);

const sc = (orgId: string, ws: string): DataplaneScope => ({ orgId, loreWorkspace: ws, dataplaneWorkspaceId: DP });
const S_A_T = sc(ORG_A, TARGET);
const S_A_O = sc(ORG_A, OTHER);
const S_B_T = sc(ORG_B, TARGET);
const S_A_N = sc(ORG_A, RECREATED);

type Mode = 'full' | 'sqlite';
type Client = ReturnType<typeof createMockDataplaneClient>;
interface World { mock: MockDataplane; client: Client; close(): Promise<void> }

async function world(mode: Mode): Promise<World> {
    const mock = await startMockDataplane({ apiKeys: { [KEY]: DP }, queryFilterMode: mode });
    return { mock, client: createMockDataplaneClient(mock.url, KEY), close: () => mock.close() };
}

const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);
async function seed(w: World, coll: string, scope: DataplaneScope, lids: readonly string[], extra: (id: string) => Record<string, unknown> = () => ({})): Promise<void> {
    for (const id of lids) await w.client.insert(DP, coll, { ...scopeRowFields(scope, id), ...extra(id) }, CONN);
}
/** Identical lore_ids in every scope; `n` scales the volume so counts cannot coincide across scopes. */
async function seedAll(w: World, scope: DataplaneScope, n: number): Promise<void> {
    const rev = (id: string) => `${id}#rev2026-09-01T00:00:00.000Z`;
    await seed(w, 'lore_node', scope, ids('n', 2 * n));
    await seed(w, 'lore_edge', scope, ids('e', 3 * n).map((x) => `${x}__rel__t`));
    for (const k of ['node_version', 'changeset', 'changeset_write']) await seed(w, 'lore_version', scope, ids(`${k}-`, n), () => ({ kind: k }));
    await seed(w, 'lore_verbatim', scope, ids('v', n));
    await seed(w, 'lore_verbatim', scope, ids('v', n).map(rev), () => ({ text: 'snapshot' }));
    await seed(w, 'lore_verbatim', scope, ids('t', n), () => ({ text: '[TOMBSTONED 2026-09-01T00:00:00Z reason: gone]' }));
    await seed(w, APP, scope, ids('x', n));
}

type Row = Record<string, unknown>;
const rowsIn = (w: World, coll: string, pred: (r: Row) => boolean = () => true): Row[] => w.mock.rows(DP, coll, CONN).filter(pred);
const inScope = (s: DataplaneScope) => (r: Row): boolean => r['org_id'] === s.orgId && r['lore_workspace'] === s.loreWorkspace;
const notScope = (s: DataplaneScope) => (r: Row): boolean => !inScope(s)(r);
/** Deep copy of every row (all purge collections) matching `pred`, per collection, in storage order. */
function snapshot(w: World, pred: (r: Row) => boolean = () => true): Record<string, Row[]> {
    return Object.fromEntries(COLLECTIONS.map((c) => [c, rowsIn(w, c, pred)]));
}
const total = (snap: Record<string, Row[]>): number => Object.values(snap).reduce((a, r) => a + r.length, 0);

/** Every request since `from` is a query / count / scoped delete-by-query; every delete is provably scoped. Returns the deletes. */
function assertRequestLog(w: World, from: number, scope: DataplaneScope): Array<{ collection: string; filter: unknown }> {
    const deletes: Array<{ collection: string; filter: unknown }> = [];
    for (const r of w.mock.requests.slice(from)) {
        assert.ok(!r.path.includes('/transaction'), `${r.path}: /v1/transaction must never be used`);
        const m = /^\/v1\/([a-z_]+)\/(query|count|delete-by-query)$/.exec(r.path);
        assert.ok(m, `unexpected route ${r.method} ${r.path} (a purge may only query, count and delete-by-query)`);
        const filter = r.body['filter'];
        assert.notEqual(filter, 'all', `${r.path}: filter 'all'`);
        assert.doesNotThrow(() => assertPurgeScopeFilter(filter, scope), `${r.path} carries no scope filter`);
        assert.equal(r.connection, CONN, `${r.path} sent no connection`);
        if (m[2] !== 'delete-by-query') { assert.equal(r.method, 'POST'); continue; }
        assert.equal(r.method, 'DELETE');
        const items = (filter as { and: unknown[] }).and;
        const idIn = items.find((c) => (c as { field?: { field?: string; operator?: string } }).field?.field === 'lore_id') as
            { field: { operator: string; value: { array: unknown[] } } } | undefined;
        const idEq = items.some((c) => typeof (c as { id_eq?: unknown }).id_eq === 'string');
        assert.ok(idEq || idIn, `${r.path}: neither lore_id in nor id_eq`);
        // The physical id is never matched through a field clause (the engine's in-memory matcher cannot see it).
        assert.ok(!items.some((c) => (c as { field?: { field?: string } }).field?.field === 'id'), `${r.path}: field clause on id`);
        if (idIn) {
            assert.equal(idIn.field.operator, 'in');
            assert.ok(idIn.field.value.array.length >= 1 && idIn.field.value.array.length <= 100, 'chunk size');
            const keys = (items.find((c) => Array.isArray((c as { or?: unknown }).or)) as { or: Array<{ id_eq?: unknown }> } | undefined)?.or;
            assert.ok(keys, `${r.path}: a bulk delete must also name every physical row key`);
            assert.equal(keys.length, idIn.field.value.array.length, 'one id_eq per lore_id');
            assert.ok(keys.every((k) => typeof k.id_eq === 'string' && k.id_eq !== ''), 'or[] holds id_eq only');
        }
        deletes.push({ collection: m[1]!, filter });
    }
    return deletes;
}

interface RunOpts extends Partial<Pick<ApplyPurgeInput, 'collections' | 'maxRows' | 'limits' | 'probeCheck' | 'guard' | 'onProgress'>> { client?: PurgeApplyClient }
/** Run the apply against `scope` and verify the whole request log afterwards. */
async function run(w: World, scope: DataplaneScope, o: RunOpts = {}): Promise<{ res: PurgeApplyResult; deletes: ReturnType<typeof assertRequestLog> }> {
    const from = w.mock.requests.length;
    const res = await applyWorkspacePurge({
        client: o.client ?? w.client,
        target: { orgId: scope.orgId, loreWorkspace: scope.loreWorkspace, dataplaneWorkspaceId: DP },
        connection: CONN,
        collections: o.collections ?? COLLECTIONS,
        guard: o.guard ?? (() => undefined),
        ...(o.probeCheck ? { probeCheck: o.probeCheck } : {}),
        ...(o.maxRows !== undefined ? { maxRows: o.maxRows } : {}),
        ...(o.limits ? { limits: o.limits } : {}),
        ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    });
    const deletes = assertRequestLog(w, from, scope);
    assert.equal(res.deleteRequests, deletes.length, 'result.deleteRequests matches the request log');
    return { res, deletes };
}
const by = (r: PurgeApplyResult, c: string) => r.collections.find((x) => x.collection === c)!;

async function main(): Promise<void> {
    for (const mode of ['full', 'sqlite'] as const) {
        console.log(`\n── query mode: ${mode} ──`);

        await test(`[${mode}] two orgs, one connector, identical workspace id + lore_ids: org B is deep-equal before/after`, async () => {
            const w = await world(mode);
            try {
                await seedAll(w, S_B_T, 3);
                await seedAll(w, S_A_T, 2);
                const bBefore = snapshot(w, inScope(S_B_T));
                assert.ok(total(bBefore) > 0);
                const { res, deletes } = await run(w, S_A_T);
                assert.equal(res.outcome, 'complete');
                assert.equal(res.exitCode, 0);
                assert.equal(total(snapshot(w, inScope(S_A_T))), 0, 'org A target is gone from every collection');
                assert.deepEqual(snapshot(w, inScope(S_B_T)), bBefore, 'org B rows byte-identical');
                assert.ok(deletes.length > 0);
                for (const c of res.collections) assert.ok(c.endState === 'complete' || c.endState === 'complete-small', `${c.collection}: ${c.endState}`);
                assert.equal(res.totals.deleted, 24, 'deleted exactly the 12n = 24 org A target rows');
            } finally { await w.close(); }
        });

        await test(`[${mode}] two workspaces in one org, all collection kinds (versions x3, verbatim canonical/#rev/tombstone, app): only the target goes`, async () => {
            const w = await world(mode);
            try {
                await seedAll(w, S_A_T, 1);
                await seedAll(w, S_A_O, 2);
                await seedAll(w, S_B_T, 1);
                const others = snapshot(w, notScope(S_A_T));
                const inserts = w.mock.requests.length;
                const { res } = await run(w, S_A_T);
                assert.equal(res.exitCode, 0);
                assert.equal(total(snapshot(w, inScope(S_A_T))), 0);
                assert.deepEqual(snapshot(w, notScope(S_A_T)), others, 'every other scope untouched');
                assert.equal(by(res, 'lore_version').deleted, 3, 'all three version kinds');
                assert.equal(by(res, 'lore_verbatim').deleted, 3, 'canonical + #rev snapshot + tombstone');
                assert.deepEqual(res.collections.map((c) => c.collection), COLLECTIONS);
                assert.equal(w.mock.requests.slice(inserts).filter((r) => r.method !== 'POST' && r.method !== 'DELETE').length, 0);
                assert.equal(w.mock.requests.slice(inserts).filter((r) => /\/(insert|bulk|upsert|update)/.test(r.path)).length, 0, 'verbatim purge writes no tombstones');
            } finally { await w.close(); }
        });

        await test(`[${mode}] same-name recreate: rows under the new id (same lore_ids) survive a purge of the old id`, async () => {
            const w = await world(mode);
            try {
                await seedAll(w, S_A_T, 2);
                await seedAll(w, S_A_N, 2); // recreated workspace: new id, same lore_ids
                const fresh = snapshot(w, inScope(S_A_N));
                const { res } = await run(w, S_A_T);
                assert.equal(res.exitCode, 0);
                assert.equal(total(snapshot(w, inScope(S_A_T))), 0);
                assert.deepEqual(snapshot(w, inScope(S_A_N)), fresh);
            } finally { await w.close(); }
        });

        await test(`[${mode}] unkeyed / spoofed rows are never deleted, only reported (even one sharing a keyed lore_id)`, async () => {
            const w = await world(mode);
            try {
                await seed(w, 'lore_node', S_A_T, ['n1', 'n2', 'n3']);
                const base = { org_id: ORG_A, lore_workspace: TARGET };
                await w.client.insert(DP, 'lore_node', { ...base, id: 'attacker-chosen-id', lore_id: 'spoof1' }, CONN);
                await w.client.insert(DP, 'lore_node', { ...base, id: scopeRowFields(S_A_T, 'other-logical').id, lore_id: 'spoof2' }, CONN);
                await w.client.insert(DP, 'lore_node', { ...base, id: 'spoof-same-lore-id', lore_id: 'n1' }, CONN); // shares lore_id with a keyed row
                await w.client.insert(DP, 'lore_node', { ...base, id: scopeRowFields(S_A_T, 'nolore').id }, CONN);
                const keyedIds = new Set(['n1', 'n2', 'n3'].map((x) => scopeRowFields(S_A_T, x).id));
                const spoofs = rowsIn(w, 'lore_node', (r) => !keyedIds.has(r['id'] as string));
                assert.equal(spoofs.length, 4);
                const { res } = await run(w, S_A_T, { collections: ['lore_node'] });
                assert.equal(res.exitCode, 0, 'unkeyed rows left behind are a warning, not a failure');
                const c = by(res, 'lore_node');
                assert.equal(c.deleted, 3);
                assert.equal(c.unkeyed, 4);
                assert.equal(c.unkeyedSamples.length, 4);
                assert.equal(c.endState, 'complete');
                assert.deepEqual(rowsIn(w, 'lore_node'), spoofs, 'only the four unkeyed rows remain, byte-identical');
            } finally { await w.close(); }
        });

        await test(`[${mode}] delete chunks are <= 100 and every chunk is scoped (150 rows -> 100 + 50)`, async () => {
            const w = await world(mode);
            try {
                await seed(w, 'lore_node', S_A_T, ids('n', 150));
                const { res, deletes } = await run(w, S_A_T, { collections: ['lore_node'] });
                assert.equal(res.exitCode, 0);
                assert.deepEqual(deletes.map((d) => ((d.filter as { and: Array<{ field?: { field: string; value: { array: unknown[] } } }> }).and.find((c) => c.field?.field === 'lore_id')!.field!.value.array.length)), [100, 50]);
                assert.equal(res.totals.reportedDeleted, 150);
            } finally { await w.close(); }
        });

        await test(`[${mode}] swallowed delete, transient: the survivor path sends one id_eq single delete and completes`, async () => {
            const w = await world(mode);
            try {
                await seed(w, 'lore_node', S_A_T, ids('n', 5));
                await seed(w, 'lore_node', S_A_O, ids('n', 3));
                const others = snapshot(w, notScope(S_A_T));
                let failures = 1;
                w.mock.options.failRowDelete = (r) => r['lore_id'] === 'n0002' && r['lore_workspace'] === TARGET && failures-- > 0;
                const { res, deletes } = await run(w, S_A_T, { collections: ['lore_node'] });
                assert.equal(res.exitCode, 0);
                const c = by(res, 'lore_node');
                assert.equal(c.survivorsRetried, 1);
                assert.equal(c.deleted, 6, '5 bulk attempts + 1 survivor retry');
                assert.equal(c.reportedDeleted, 5, 'engine counts: 4 (one swallowed) + 1');
                assert.equal(c.keyedSeen, 5);
                assert.equal(c.passes, 3, 'walk, walk (survivor), final zero-keyed walk');
                assert.equal(deletes.length, 2);
                const single = deletes[1]!.filter as { and: unknown[] };
                assert.deepEqual(single.and[0], { id_eq: scopeRowFields(S_A_T, 'n0002').id });
                assert.equal(total(snapshot(w, inScope(S_A_T))), 0);
                assert.deepEqual(snapshot(w, notScope(S_A_T)), others);
            } finally { await w.close(); }
        });

        await test(`[${mode}] swallowed delete, persistent: no-progress abort (exit 2) on the third sighting, nothing more sent`, async () => {
            const w = await world(mode);
            try {
                await seed(w, 'lore_node', S_A_T, ids('n', 5));
                await seed(w, 'lore_node', S_A_O, ids('n', 3));
                const others = snapshot(w, notScope(S_A_T));
                w.mock.options.failRowDelete = (r) => r['lore_id'] === 'n0002' && r['lore_workspace'] === TARGET;
                const { res, deletes } = await run(w, S_A_T, { collections: ['lore_node'] });
                assert.equal(res.outcome, 'aborted-no-progress');
                assert.equal(res.exitCode, 2);
                assert.match(res.message ?? '', /do not take effect/);
                assert.equal(res.stoppedIn, 'lore_node');
                assert.equal(deletes.length, 2, 'one bulk + one single, then the abort: no third attempt');
                assert.deepEqual(rowsIn(w, 'lore_node', inScope(S_A_T)).map((r) => r['lore_id']), ['n0002'], 'only the stuck row remains');
                assert.deepEqual(snapshot(w, notScope(S_A_T)), others);
            } finally { await w.close(); }
        });

        await test(`[${mode}] interrupted run (client throws after 4 deletes): exit 2 with partial counts; a healthy rerun completes, other scopes unchanged`, async () => {
            const w = await world(mode);
            try {
                await seed(w, 'lore_edge', S_A_T, ids('e', 250));
                await seed(w, 'lore_node', S_A_T, ids('n', 250));
                await seed(w, 'lore_node', S_A_O, ids('n', 120));
                await seed(w, 'lore_node', S_B_T, ids('n', 90));
                const others = snapshot(w, notScope(S_A_T));
                let sent = 0;
                const faulty: PurgeApplyClient = { ...w.client, deleteByQuery: async (...a) => { if (sent++ >= 4) throw new Error('injected delete fault'); return w.client.deleteByQuery(...a); } };
                const first = await run(w, S_A_T, { client: faulty });
                assert.equal(first.res.outcome, 'failed');
                assert.equal(first.res.exitCode, 2);
                assert.match(first.res.message ?? '', /injected delete fault/);
                assert.equal(first.res.stoppedIn, 'lore_node');
                assert.equal(by(first.res, 'lore_edge').endState, 'complete', 'edges finished before the fault');
                assert.equal(by(first.res, 'lore_node').endState, 'incomplete');
                assert.equal(by(first.res, 'lore_node').deleted, 100, 'only the one chunk that really went out is counted');
                assert.equal(first.res.totals.deleted, 350);
                assert.equal(rowsIn(w, 'lore_node', inScope(S_A_T)).length, 150);
                assert.deepEqual(snapshot(w, notScope(S_A_T)), others);
                const second = await run(w, S_A_T);
                assert.equal(second.res.exitCode, 0);
                assert.equal(second.res.totals.deleted, 150, 'resume deletes only what is left');
                assert.equal(total(snapshot(w, inScope(S_A_T))), 0);
                assert.deepEqual(snapshot(w, notScope(S_A_T)), others);
            } finally { await w.close(); }
        });

        await test(`[${mode}] guard throws before the second pass: abort, no delete request after the throw`, async () => {
            const w = await world(mode);
            try {
                await seed(w, 'lore_node', S_A_T, ids('n', 5));
                let failures = 1; // one swallowed delete forces a second pass (the survivor pass)
                w.mock.options.failRowDelete = (r) => r['lore_id'] === 'n0002' && failures-- > 0;
                let calls = 0;
                let atThrow = -1;
                const guard = (): void => {
                    calls++;
                    if (calls === 2) { atThrow = w.mock.requests.filter((r) => r.path.endsWith('/delete-by-query')).length; throw new Error('target id is live again'); }
                };
                const { res, deletes } = await run(w, S_A_T, { collections: ['lore_node'], guard });
                assert.equal(res.outcome, 'aborted-guard');
                assert.equal(res.exitCode, 2);
                assert.match(res.message ?? '', /registered again/);
                assert.equal(calls, 2);
                assert.equal(deletes.length, atThrow, 'no delete request after the guard threw');
                assert.equal(deletes.length, 1, 'the first pass happened');
                assert.equal(rowsIn(w, 'lore_node').length, 1, 'the survivor was left');
                // a guard that throws immediately: nothing deleted at all
                const w2 = await world(mode);
                try {
                    await seed(w2, 'lore_node', S_A_T, ids('n', 5));
                    const r2 = await run(w2, S_A_T, { guard: async () => { throw new Error('live'); } });
                    assert.equal(r2.res.outcome, 'aborted-guard');
                    assert.equal(r2.deletes.length, 0);
                    assert.equal(rowsIn(w2, 'lore_node').length, 5);
                } finally { await w2.close(); }
            } finally { await w.close(); }
        });

        await test(`[${mode}] probeCheck throwing: zero lore_node deletes (earlier collections may already be gone); a passing hook runs once`, async () => {
            const w = await world(mode);
            try {
                await seedAll(w, S_A_T, 1);
                await seedAll(w, S_A_O, 1);
                const others = snapshot(w, notScope(S_A_T));
                const nodesBefore = rowsIn(w, 'lore_node', inScope(S_A_T));
                const seen: WriteProbe[] = [];
                const { res } = await run(w, S_A_T, { probeCheck: (p) => { seen.push(p); throw new Error('a write landed after deletion'); } });
                assert.equal(res.outcome, 'aborted-probe');
                assert.equal(res.exitCode, 2);
                assert.equal(res.stoppedIn, 'lore_node');
                assert.equal(seen.length, 1);
                assert.equal(seen[0]!.rowsSeen, 2);
                assert.equal(by(res, 'lore_node').deleted, 0);
                assert.deepEqual(rowsIn(w, 'lore_node', inScope(S_A_T)), nodesBefore, 'lore_node untouched');
                assert.deepEqual(snapshot(w, notScope(S_A_T)), others);
                // a hook that passes: called once even over several passes, run completes
                const w2 = await world(mode);
                try {
                    await seed(w2, 'lore_node', S_A_T, ids('n', 5));
                    let failures = 1;
                    w2.mock.options.failRowDelete = (r) => r['lore_id'] === 'n0002' && failures-- > 0;
                    let calls = 0;
                    const r2 = await run(w2, S_A_T, { collections: ['lore_node'], probeCheck: () => { calls++; } });
                    assert.equal(r2.res.exitCode, 0);
                    assert.equal(calls, 1);
                    assert.ok(by(r2.res, 'lore_node').passes >= 2);
                } finally { await w2.close(); }
            } finally { await w.close(); }
        });

        await test(`[${mode}] maxRows: stops cleanly at the limit (exit 3), exact-fit completes, a rerun finishes`, async () => {
            const w = await world(mode);
            try {
                await seed(w, 'lore_node', S_A_T, ids('n', 250));
                await seed(w, 'lore_node', S_A_O, ids('n', 40));
                const others = snapshot(w, notScope(S_A_T));
                const a = await run(w, S_A_T, { collections: ['lore_node'], maxRows: 150 });
                assert.equal(a.res.outcome, 'max-rows');
                assert.equal(a.res.exitCode, 3);
                assert.equal(a.res.totals.deleted, 150);
                assert.equal(a.deletes.length, 2, '100 + a 50-row final chunk');
                assert.equal(rowsIn(w, 'lore_node', inScope(S_A_T)).length, 100);
                assert.equal(by(a.res, 'lore_node').endState, 'incomplete');
                const b = await run(w, S_A_T, { collections: ['lore_node'], maxRows: 100 }); // exactly what is left
                assert.equal(b.res.outcome, 'complete', 'the verification walk finds zero rows: limit not "reached"');
                assert.equal(b.res.exitCode, 0);
                assert.equal(rowsIn(w, 'lore_node', inScope(S_A_T)).length, 0);
                assert.deepEqual(snapshot(w, notScope(S_A_T)), others);
                // not-reached collections are reported as such
                const w2 = await world(mode);
                try {
                    await seed(w2, 'lore_edge', S_A_T, ids('e', 10));
                    await seed(w2, 'lore_node', S_A_T, ids('n', 10));
                    const c = await run(w2, S_A_T, { maxRows: 4 });
                    assert.equal(c.res.exitCode, 3);
                    assert.equal(by(c.res, 'lore_edge').endState, 'incomplete');
                    assert.equal(by(c.res, 'lore_node').endState, 'not-reached');
                    const d = await run(w2, S_A_T);
                    assert.equal(d.res.exitCode, 0);
                    assert.equal(total(snapshot(w2, inScope(S_A_T))), 0);
                } finally { await w2.close(); }
            } finally { await w.close(); }
        });

        await test(`[${mode}] rerun after completion: zero delete requests, exit 0, idempotent`, async () => {
            const w = await world(mode);
            try {
                await seedAll(w, S_A_T, 2);
                await seedAll(w, S_A_O, 1);
                assert.equal((await run(w, S_A_T)).res.exitCode, 0);
                const others = snapshot(w, notScope(S_A_T));
                const again = await run(w, S_A_T);
                assert.equal(again.deletes.length, 0);
                assert.equal(again.res.exitCode, 0);
                assert.equal(again.res.outcome, 'complete');
                assert.equal(again.res.totals.deleted, 0);
                assert.deepEqual(snapshot(w, notScope(S_A_T)), others);
            } finally { await w.close(); }
        });
    }

    console.log('\n── filter-ignoring connector (sqlite mode) ──');

    await test('[sqlite] small collection: foreign rows seen, completes via client-side checks (complete-small), foreign rows untouched', async () => {
        const w = await world('sqlite');
        try {
            await seed(w, 'lore_node', S_A_O, ids('o', 20));
            await seed(w, 'lore_node', S_B_T, ids('b', 10));
            await seed(w, 'lore_node', S_A_T, ids('t', 4));
            const others = snapshot(w, notScope(S_A_T));
            const { res } = await run(w, S_A_T, { collections: ['lore_node'] });
            assert.equal(res.exitCode, 0);
            const c = by(res, 'lore_node');
            assert.equal(c.endState, 'complete-small');
            assert.equal(c.foreignSeen, 30);
            assert.equal(c.deleted, 4);
            assert.deepEqual(snapshot(w, notScope(S_A_T)), others);
        } finally { await w.close(); }
    });

    await test('[sqlite] collection past one page, all target rows beyond the page: exit 3, nothing deleted, no foreign row touched', async () => {
        const w = await world('sqlite');
        try {
            await seed(w, 'lore_node', S_A_O, ids('o', 520));
            await seed(w, 'lore_node', S_A_T, ids('t', 5));
            const before = snapshot(w);
            const { res, deletes } = await run(w, S_A_T, { collections: ['lore_node'] });
            assert.equal(res.outcome, 'unverifiable');
            assert.equal(res.exitCode, 3);
            assert.equal(by(res, 'lore_node').endState, 'unverifiable');
            assert.equal(deletes.length, 0, 'no keyed row visible, so no delete is sent');
            assert.deepEqual(snapshot(w), before);
        } finally { await w.close(); }
    });

    await test('[sqlite] target rows both inside and beyond page one: the visible ones go, the rest is reported unverifiable (exit 3), foreign rows untouched', async () => {
        const w = await world('sqlite');
        try {
            await seed(w, 'lore_node', S_A_T, ids('a', 5)); // visible on page one
            await seed(w, 'lore_node', S_A_O, ids('o', 520));
            await seed(w, 'lore_node', S_A_T, ids('z', 5)); // beyond page one
            const others = snapshot(w, notScope(S_A_T));
            const { res } = await run(w, S_A_T, { collections: ['lore_node'] });
            assert.equal(res.exitCode, 3);
            assert.equal(by(res, 'lore_node').endState, 'unverifiable');
            assert.equal(by(res, 'lore_node').deleted, 5);
            assert.deepEqual(rowsIn(w, 'lore_node', inScope(S_A_T)).map((r) => r['lore_id']), ids('z', 5), 'the invisible five remain');
            assert.deepEqual(snapshot(w, notScope(S_A_T)), others);
        } finally { await w.close(); }
    });

    await test('[sqlite] one collection unverifiable does not stop the others: they complete, overall exit 3', async () => {
        const w = await world('sqlite');
        try {
            await seed(w, 'lore_edge', S_A_O, ids('o', 520));
            await seed(w, 'lore_edge', S_A_T, ids('t', 3));
            await seed(w, 'lore_node', S_A_T, ids('n', 3));
            const { res } = await run(w, S_A_T);
            assert.equal(res.exitCode, 3);
            assert.equal(by(res, 'lore_edge').endState, 'unverifiable');
            assert.equal(by(res, 'lore_node').endState, 'complete');
            assert.equal(rowsIn(w, 'lore_node', inScope(S_A_T)).length, 0);
        } finally { await w.close(); }
    });

    console.log('\n── input validation and progress ──');

    await test('invalid input throws before any request', async () => {
        const w = await world('full');
        try {
            const from = w.mock.requests.length;
            const base = { client: w.client, target: { orgId: ORG_A, loreWorkspace: TARGET, dataplaneWorkspaceId: DP }, connection: CONN, collections: ['lore_node'], guard: () => undefined };
            await assert.rejects(applyWorkspacePurge({ ...base, target: { orgId: ORG_A, loreWorkspace: '' } }));
            await assert.rejects(applyWorkspacePurge({ ...base, target: { orgId: '', loreWorkspace: TARGET } }));
            await assert.rejects(applyWorkspacePurge({ ...base, connection: '' }));
            await assert.rejects(applyWorkspacePurge({ ...base, guard: undefined as never }));
            await assert.rejects(applyWorkspacePurge({ ...base, maxRows: 0 }));
            await assert.rejects(applyWorkspacePurge({ ...base, maxRows: 1.5 }));
            assert.equal(w.mock.requests.length, from);
        } finally { await w.close(); }
    });

    await test('onProgress reports walks / deletes / collection-done; a throwing listener cannot break the run', async () => {
        const w = await world('full');
        try {
            await seed(w, 'lore_node', S_A_T, ids('n', 3));
            const phases: string[] = [];
            const { res } = await run(w, S_A_T, { collections: ['lore_node'], onProgress: (e) => { phases.push(e.phase); throw new Error('listener bug'); } });
            assert.equal(res.exitCode, 0);
            assert.deepEqual(phases, ['walk', 'delete', 'walk', 'collection-done']);
        } finally { await w.close(); }
    });

    await test('a failing count cross-check downgrades a finished collection to unverifiable (exit 3)', async () => {
        const w = await world('full');
        try {
            await seed(w, 'lore_node', S_A_T, ids('n', 3));
            const lying: PurgeApplyClient = { ...w.client, count: async (...a) => (await w.client.count(...a)) + 1 };
            const { res } = await run(w, S_A_T, { collections: ['lore_node'], client: lying });
            assert.equal(res.exitCode, 3);
            assert.equal(by(res, 'lore_node').endState, 'unverifiable');
            assert.equal(by(res, 'lore_node').countCheck?.exceeds, true);
        } finally { await w.close(); }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
