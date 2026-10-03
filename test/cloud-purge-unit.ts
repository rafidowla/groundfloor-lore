#!/usr/bin/env tsx
/**
 * cloud-purge-unit.ts — the READ-ONLY scan half of the cloud workspace purge
 * (packages/lore/src/engines/dataplaneWorkspacePurge.ts), against the engine-faithful mock only.
 *
 * Proves, in both query modes ('full' SQL push-down, 'sqlite' filter/sort/offset ignored):
 *   - a scan counts exactly the target's rows: not another org's (same workspace id + lore_ids), not
 *     another workspace's, across lore_node / lore_edge / lore_version (3 kinds) / lore_verbatim
 *     (canonical, #rev snapshots, tombstones);
 *   - spoofed rows (scope columns match, `id` is not the row key) are unkeyed, never keyed;
 *   - end states: complete / complete-small / capped / unverifiable, the count cross-check downgrade, and
 *     the lower-bound flag at every cap;
 *   - the recent-write probe decision rules;
 *   - the filter-safety assertion;
 *   - ZERO mutating requests: every request a scan sends is a query/count carrying both scope clauses and
 *     a `connection`.
 * No network call to any real service: the mock listens on 127.0.0.1.
 */
import assert from 'node:assert/strict';
import { startMockDataplane, type MockDataplane } from './helpers/mock-dataplane.js';
import { createMockDataplaneClient } from './helpers/mock-dataplane-client.js';
import { engineAnd, engineField, scopeRowFields, type DataplaneScope } from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import {
    KEYED_ID_CAP,
    assertPurgeScopeFilter,
    buildPurgeScanFilter,
    classifyPurgeRow,
    newWriteProbe,
    observeWrite,
    probeDecision,
    purgeCollectionOrder,
    purgeScope,
    scanEndState,
    scanWorkspaceForPurge,
    walkPurgeCollection,
    type PurgeScanClient,
    type PurgeScanReport,
} from '../packages/lore/src/engines/dataplaneWorkspacePurge.js';
import { SCOPED_SCAN_CAP } from '../packages/lore/src/engines/dataplaneScopedIo.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${((e as Error).stack ?? (e as Error).message).slice(0, 3000)}`); failed++; }
}

const KEY = 'purge-key';
const DP = 'dp-ws-purge';
const CONN = 'postgresql';
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const TARGET = 'ws-target-0001';
const OTHER = 'ws-other-0002';
const ALL_COLLECTIONS = purgeCollectionOrder();

const sc = (orgId: string, ws: string): DataplaneScope => ({ orgId, loreWorkspace: ws, dataplaneWorkspaceId: DP });
const S_A_T = sc(ORG_A, TARGET);
const S_A_O = sc(ORG_A, OTHER);
const S_B_T = sc(ORG_B, TARGET);

type Mode = 'full' | 'sqlite';
interface World { mock: MockDataplane; client: ReturnType<typeof createMockDataplaneClient>; close(): Promise<void> }

async function world(mode: Mode): Promise<World> {
    const mock = await startMockDataplane({ apiKeys: { [KEY]: DP }, queryFilterMode: mode });
    return { mock, client: createMockDataplaneClient(mock.url, KEY), close: () => mock.close() };
}

async function seed(w: World, coll: string, scope: DataplaneScope, ids: readonly string[], extra: (id: string) => Record<string, unknown> = () => ({})): Promise<void> {
    for (const id of ids) await w.client.insert(DP, coll, { ...scopeRowFields(scope, id), ...extra(id) }, CONN);
}
const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);

/** Every request since `from` is a query/count with both scope clauses and a connection (and nothing else). */
function assertReadOnly(w: World, from: number, scope: DataplaneScope): number {
    const reqs = w.mock.requests.slice(from);
    assert.ok(reqs.length > 0, 'the scan sent no requests');
    for (const r of reqs) {
        assert.equal(r.method, 'POST', `${r.method} ${r.path} is not a read`);
        assert.match(r.path, /^\/v1\/[a-z_]+\/(query|count)$/, `unexpected route ${r.path}`);
        assert.doesNotThrow(() => assertPurgeScopeFilter(r.body['filter'], scope), `${r.path} carries no scope filter`);
        assert.equal(r.connection, CONN, `${r.path} sent no connection`);
    }
    return reqs.length;
}

async function scan(w: World, scope: DataplaneScope, opts: { collections?: readonly string[]; client?: PurgeScanClient; limits?: { keyedCap?: number; scanCap?: number } } = {}): Promise<PurgeScanReport> {
    const from = w.mock.requests.length;
    const report = await scanWorkspaceForPurge({
        client: opts.client ?? w.client,
        target: { orgId: scope.orgId, loreWorkspace: scope.loreWorkspace, dataplaneWorkspaceId: DP },
        connection: CONN,
        collections: opts.collections ?? ALL_COLLECTIONS,
        ...(opts.limits ? { limits: opts.limits } : {}),
    });
    assertReadOnly(w, from, scope);
    return report;
}
const by = (r: PurgeScanReport, c: string) => r.collections.find((x) => x.collection === c)!;

async function main(): Promise<void> {
    for (const mode of ['full', 'sqlite'] as const) {
        console.log(`\n── query mode: ${mode} ──`);

        await test(`[${mode}] two orgs, identical workspace id + lore_ids: org A counts only org A`, async () => {
            const w = await world(mode);
            try {
                await seed(w, 'lore_node', S_A_T, ['n1', 'n2', 'n3']);
                await seed(w, 'lore_node', S_B_T, ['n1', 'n2', 'n3', 'n4', 'n5']); // same workspace id, same lore_ids, other org
                const a = await scan(w, S_A_T, { collections: ['lore_node'] });
                assert.equal(by(a, 'lore_node').keyed, 3);
                assert.equal(by(a, 'lore_node').unkeyed, 0);
                const b = await scan(w, S_B_T, { collections: ['lore_node'] });
                assert.equal(by(b, 'lore_node').keyed, 5);
                // the walk returns the row keys of exactly the scoped rows
                const walk = await walkPurgeCollection(w.client, S_A_T, 'lore_node', CONN);
                assert.deepEqual(walk.keyed.map((k) => k.loreId).sort(), ['n1', 'n2', 'n3']);
                for (const k of walk.keyed) assert.equal(k.rowKey, scopeRowFields(S_A_T, k.loreId).id);
            } finally { await w.close(); }
        });

        await test(`[${mode}] two workspaces in one org: only the target's rows, across all collection kinds`, async () => {
            const w = await world(mode);
            try {
                const rev = (id: string) => `${id}#rev2026-09-01T00:00:00.000Z`;
                for (const scope of [S_A_T, S_A_O]) {
                    const n = scope === S_A_T ? 1 : 2; // target has 1x, the neighbour 2x the rows: counts cannot coincide
                    await seed(w, 'lore_node', scope, ids('n', 2 * n));
                    await seed(w, 'lore_edge', scope, ids('e', 3 * n).map((x) => `${x}__rel__t`));
                    const kinds = ['node_version', 'changeset', 'changeset_write'];
                    for (const k of kinds) await seed(w, 'lore_version', scope, ids(`${k}-`, n), () => ({ kind: k }));
                    await seed(w, 'lore_verbatim', scope, ids('v', n));
                    await seed(w, 'lore_verbatim', scope, ids('v', n).map(rev), () => ({ text: 'snapshot' }));
                    await seed(w, 'lore_verbatim', scope, ids('t', n), () => ({ text: '[TOMBSTONED 2026-09-01T00:00:00Z reason: gone]' }));
                }
                const r = await scan(w, S_A_T);
                assert.deepEqual(r.collections.map((c) => c.collection), ['lore_edge', 'lore_version', 'lore_verbatim', 'lore_node']);
                assert.equal(by(r, 'lore_node').keyed, 2);
                assert.equal(by(r, 'lore_edge').keyed, 3);
                assert.equal(by(r, 'lore_version').keyed, 3, 'all three version kinds');
                assert.equal(by(r, 'lore_verbatim').keyed, 3, 'canonical + #rev snapshot + tombstone');
                for (const c of r.collections) {
                    assert.equal(c.unkeyed, 0);
                    assert.equal(c.lowerBound, false);
                    assert.ok(c.endState === 'complete' || c.endState === 'complete-small', `${c.collection}: ${c.endState}`);
                    assert.equal(c.countCheck?.exceeds, false);
                    if (mode === 'full') assert.equal(c.foreign, 0);
                }
                // an extra app collection is scanned between the version and verbatim collections
                await seed(w, 'lore_app_things', S_A_T, ['x1', 'x2']);
                const withExtra = await scan(w, S_A_T, { collections: purgeCollectionOrder(['lore_app_things']) });
                assert.deepEqual(withExtra.collections.map((c) => c.collection), ['lore_edge', 'lore_version', 'lore_app_things', 'lore_verbatim', 'lore_node']);
                assert.equal(by(withExtra, 'lore_app_things').keyed, 2);
                // the neighbour is untouched and still countable on its own
                assert.equal(by(await scan(w, S_A_O, { collections: ['lore_node'] }), 'lore_node').keyed, 4);
            } finally { await w.close(); }
        });

        await test(`[${mode}] spoofed / unkeyed rows are classified unkeyed, never keyed`, async () => {
            const w = await world(mode);
            try {
                await seed(w, 'lore_node', S_A_T, ['good1', 'good2']);
                const base = { org_id: ORG_A, lore_workspace: TARGET };
                await w.client.insert(DP, 'lore_node', { ...base, id: 'attacker-chosen-id', lore_id: 'spoof1' }, CONN); // wrong id
                await w.client.insert(DP, 'lore_node', { ...base, id: scopeRowFields(S_A_T, 'other-logical').id, lore_id: 'spoof2' }, CONN); // a real key, for a different lore_id
                await w.client.insert(DP, 'lore_node', { ...base, id: scopeRowFields(S_A_T, 'nolore').id }, CONN); // no lore_id (Arango-style edge doc)
                await w.client.insert(DP, 'lore_node', { ...base, id: scopeRowFields(S_A_T, '').id, lore_id: '' }, CONN); // empty lore_id
                const walk = await walkPurgeCollection(w.client, S_A_T, 'lore_node', CONN);
                assert.equal(walk.keyed.length, 2);
                assert.equal(walk.unkeyed, 4);
                assert.ok(walk.unkeyedSamples.length <= 5 && walk.unkeyedSamples.length === 4);
                assert.ok(!walk.keyed.some((k) => k.loreId.startsWith('spoof')));
                const r = await scan(w, S_A_T, { collections: ['lore_node'] });
                assert.equal(by(r, 'lore_node').keyed, 2);
                assert.equal(by(r, 'lore_node').unkeyed, 4);
                assert.equal(by(r, 'lore_node').countCheck?.exceeds, false, 'count (6) is explained by keyed + unkeyed (6)');
            } finally { await w.close(); }
        });
    }

    console.log('\n── filter-ignoring connector (sqlite mode) ──');

    await test('[sqlite] small collection: foreign rows seen, short page -> complete-small', async () => {
        const w = await world('sqlite');
        try {
            await seed(w, 'lore_node', S_A_O, ids('o', 20));
            await seed(w, 'lore_node', S_B_T, ids('b', 10));
            await seed(w, 'lore_node', S_A_T, ids('t', 4));
            const r = await scan(w, S_A_T, { collections: ['lore_node'] });
            const c = by(r, 'lore_node');
            assert.equal(c.keyed, 4);
            assert.equal(c.foreign, 30, 'the connector ignored the filter and said so');
            assert.equal(c.endState, 'complete-small');
            assert.equal(c.lowerBound, false);
            assert.equal(c.lastPageFull, false);
            assert.equal(c.countCheck?.count, 4, 'count applies the filter in memory on the sqlite mock');
        } finally { await w.close(); }
    });

    await test('[sqlite] collection over one page, target rows beyond the page -> unverifiable, lower bound, stops at the first repeat', async () => {
        const w = await world('sqlite');
        try {
            await seed(w, 'lore_node', S_A_O, ids('o', 520)); // fills page one (storage order)
            await seed(w, 'lore_node', S_A_T, ids('t', 5)); // beyond the first 500 physical rows
            const from = w.mock.requests.length;
            const r = await scan(w, S_A_T, { collections: ['lore_node'] });
            const c = by(r, 'lore_node');
            assert.equal(c.keyed, 0, 'target rows are invisible: no claim of completeness');
            assert.equal(c.foreign, 500);
            assert.equal(c.endState, 'unverifiable');
            assert.equal(c.stoppedBecause, 'repeat');
            assert.equal(c.lastPageFull, true);
            assert.equal(c.lowerBound, true);
            assert.equal(c.countCheck, null, 'no count cross-check on an unverifiable walk');
            const queries = w.mock.requests.slice(from).filter((q) => q.path.endsWith('/query'));
            assert.equal(queries.length, 2, 'page one + the repeated page, then stop');
        } finally { await w.close(); }
    });

    await test('[sqlite] only the target in the table, over one page: offset ignored -> unverifiable at the first repeat', async () => {
        const w = await world('sqlite');
        try {
            await seed(w, 'lore_node', S_A_T, ids('t', 510));
            const walk = await walkPurgeCollection(w.client, S_A_T, 'lore_node', CONN);
            assert.equal(walk.stoppedBecause, 'repeat');
            assert.equal(walk.keyed.length, 500, 'the repeated page is not counted twice');
            assert.equal(walk.lowerBound, true);
            assert.equal(scanEndState(walk), 'unverifiable');
        } finally { await w.close(); }
    });

    console.log('\n── caps, clamping, count cross-check ──');

    await test('[full] keyed cap stops the walk with a lower bound (state capped), no count check', async () => {
        assert.equal(KEYED_ID_CAP, 5_000);
        assert.equal(SCOPED_SCAN_CAP, 50_000);
        const w = await world('full');
        try {
            await seed(w, 'lore_node', S_A_T, ids('t', 520));
            const r = await scan(w, S_A_T, { collections: ['lore_node'], limits: { keyedCap: 400 } });
            const c = by(r, 'lore_node');
            assert.equal(c.stoppedBecause, 'keyed-cap');
            assert.equal(c.keyed, 500, 'the whole page that crossed the cap is kept');
            assert.equal(c.lowerBound, true);
            assert.equal(c.endState, 'capped');
            assert.equal(c.countCheck, null);
        } finally { await w.close(); }
    });

    await test('[full] scan cap stops the walk: unverifiable lower bound', async () => {
        const w = await world('full');
        try {
            await seed(w, 'lore_node', S_A_T, ids('t', 520));
            const r = await scan(w, S_A_T, { collections: ['lore_node'], limits: { scanCap: 500 } });
            const c = by(r, 'lore_node');
            assert.equal(c.stoppedBecause, 'scan-cap');
            assert.equal(c.keyed, 500);
            assert.equal(c.rowsExamined, 500);
            assert.equal(c.lowerBound, true);
            assert.equal(c.endState, 'unverifiable');
        } finally { await w.close(); }
    });

    await test('[full] a full walk over several pages is complete and not a lower bound', async () => {
        const w = await world('full');
        try {
            await seed(w, 'lore_node', S_A_T, ids('t', 1001)); // 500 + 500 + 1: ends on a short page
            const c = by(await scan(w, S_A_T, { collections: ['lore_node'] }), 'lore_node');
            assert.equal(c.keyed, 1001);
            assert.equal(c.stoppedBecause, 'short-page');
            assert.equal(c.endState, 'complete');
            assert.equal(c.lowerBound, false);
        } finally { await w.close(); }
    });

    await test('[full] an empty collection is complete (empty page), zero keyed', async () => {
        const w = await world('full');
        try {
            const c = by(await scan(w, S_A_T, { collections: ['lore_edge'] }), 'lore_edge');
            assert.equal(c.keyed, 0);
            assert.equal(c.stoppedBecause, 'empty-page');
            assert.equal(c.endState, 'complete');
            assert.equal(c.countCheck?.count, 0);
        } finally { await w.close(); }
    });

    await test('[full] a count above what the walk explains downgrades complete -> unverifiable; a failing count too', async () => {
        const w = await world('full');
        try {
            await seed(w, 'lore_node', S_A_T, ids('t', 3));
            const lying: PurgeScanClient = { query: (...a) => w.client.query(...a), count: async (...a) => (await w.client.count(...a)) + 1 };
            const r = await scan(w, S_A_T, { collections: ['lore_node'], client: lying });
            const c = by(r, 'lore_node');
            assert.equal(c.countCheck?.count, 4);
            assert.equal(c.countCheck?.explained, 3);
            assert.equal(c.countCheck?.exceeds, true);
            assert.equal(c.endState, 'unverifiable');
            const broken: PurgeScanClient = { query: (...a) => w.client.query(...a), count: async () => { throw new Error('boom'); } };
            const r2 = await scan(w, S_A_T, { collections: ['lore_node'], client: broken });
            assert.equal(by(r2, 'lore_node').endState, 'unverifiable');
            assert.match(by(r2, 'lore_node').countCheck?.error ?? '', /boom/);
            // a count of zero with zero rows is merely consistent: complete
            const empty = by(await scan(w, S_A_O, { collections: ['lore_edge'] }), 'lore_edge');
            assert.equal(empty.endState, 'complete');
        } finally { await w.close(); }
    });

    await test('[full] a short page that says has_more (engine clamped our limit) is not treated as the end', async () => {
        const w = await world('full');
        try {
            await seed(w, 'lore_node', S_A_T, ids('t', 5));
            const clamping: PurgeScanClient = {
                query: async (...a) => ({ ...(await w.client.query(...a)), has_more: true }) as never,
                count: (...a) => w.client.count(...a),
            };
            const walk = await walkPurgeCollection(clamping, S_A_T, 'lore_node', CONN);
            assert.equal(walk.stoppedBecause, 'clamped');
            assert.equal(walk.lowerBound, true);
            assert.equal(scanEndState(walk), 'unverifiable');
        } finally { await w.close(); }
    });

    console.log('\n── recent-write probe ──');

    await test('probe: tracks the newest KEYED write on lore_node only; decision rules for recorded and unrecorded ids', async () => {
        const w = await world('full');
        try {
            await seed(w, 'lore_node', S_A_T, ['a', 'b'], (id) => ({ created_at: '2026-01-01T00:00:00.000Z', updated_at: id === 'b' ? '2026-03-01T12:00:00.000Z' : '2026-02-01T00:00:00.000Z' }));
            // a newer write on a row that is NOT keyed (spoof) must not move the probe
            await w.client.insert(DP, 'lore_node', { org_id: ORG_A, lore_workspace: TARGET, id: 'spoof', lore_id: 's', updated_at: '2026-12-31T00:00:00.000Z', created_at: '2026-12-31T00:00:00.000Z' }, CONN);
            await seed(w, 'lore_edge', S_A_T, ['e1'], () => ({ updated_at: '2026-12-31T00:00:00.000Z' }));
            const r = await scan(w, S_A_T, { collections: ['lore_edge', 'lore_node'] });
            assert.equal(by(r, 'lore_edge').probe, null, 'only lore_node is probed');
            const p = by(r, 'lore_node').probe!;
            assert.equal(p.newestWriteMs, Date.parse('2026-03-01T12:00:00.000Z'));
            assert.equal(p.rowsSeen, 2);
            const written = Date.parse('2026-03-01T12:00:00.000Z');
            const min = 7 * 86_400_000;
            // recorded: refuse only when the newest write is later than deletedAt + 5 min
            assert.equal(probeDecision(p, { deletedAtMs: written - 6 * 60_000, nowMs: written + 1e9, minAgeMs: min }).refuse, true);
            assert.equal(probeDecision(p, { deletedAtMs: written - 5 * 60_000, nowMs: written + 1e9, minAgeMs: min }).refuse, false, 'exactly deletedAt + 5 min is not later');
            assert.equal(probeDecision(p, { deletedAtMs: written + 1000, nowMs: written + 1e9, minAgeMs: min }).verdict, 'ok');
            // unrecorded: refuse when the newest write is within minAge of now
            assert.equal(probeDecision(p, { deletedAtMs: null, nowMs: written + min - 1, minAgeMs: min }).refuse, true);
            assert.equal(probeDecision(p, { deletedAtMs: null, nowMs: written + min, minAgeMs: min }).refuse, false);
            assert.equal(probeDecision(p, { deletedAtMs: null, nowMs: written + min + 1, minAgeMs: min }).verdict, 'ok');
        } finally { await w.close(); }
    });

    await test('probe: unparsable timestamps are counted, never trusted; no-rows / unknown verdicts', async () => {
        const w = await world('full');
        try {
            await seed(w, 'lore_node', S_A_T, ['a', 'b', 'c'], (id) => ({
                created_at: id === 'a' ? 'not-a-date' : id === 'b' ? 12345 : '2026-01-01T00:00:00.000Z',
                updated_at: id === 'c' ? '9999-99-99T00:00:00Z' : 'yesterday',
            }));
            const p = by(await scan(w, S_A_T, { collections: ['lore_node'] }), 'lore_node').probe!;
            assert.equal(p.unparsable, 5, 'every bad value counted');
            assert.equal(p.newestWriteMs, Date.parse('2026-01-01T00:00:00.000Z'), 'only the one good value is used');
            const none = newWriteProbe();
            assert.equal(probeDecision(none, { deletedAtMs: null, nowMs: 0, minAgeMs: 1 }).verdict, 'no-rows');
            const bad = newWriteProbe();
            observeWrite(bad, { updated_at: 'junk' });
            observeWrite(bad, {});
            assert.equal(bad.unparsable, 1);
            assert.equal(bad.missing, 1);
            const d = probeDecision(bad, { deletedAtMs: 0, nowMs: 1e12, minAgeMs: 1 });
            assert.equal(d.verdict, 'unknown');
            assert.equal(d.refuse, false);
        } finally { await w.close(); }
    });

    console.log('\n── filter safety and pure helpers ──');

    await test('assertPurgeScopeFilter throws on all, on an and missing either scope clause, on non-and shapes', () => {
        const scope = S_A_T;
        const org = engineField('org_id', 'eq', ORG_A);
        const ws = engineField('lore_workspace', 'eq', TARGET);
        assert.throws(() => assertPurgeScopeFilter('all', scope));
        assert.throws(() => assertPurgeScopeFilter(engineAnd([]), scope), 'engineAnd([]) collapses to all');
        assert.throws(() => assertPurgeScopeFilter(undefined, scope));
        assert.throws(() => assertPurgeScopeFilter(null, scope));
        assert.throws(() => assertPurgeScopeFilter(org, scope), 'a bare clause is not an and');
        assert.throws(() => assertPurgeScopeFilter({ and: [] }, scope));
        assert.throws(() => assertPurgeScopeFilter({ and: [org] }, scope), 'missing lore_workspace');
        assert.throws(() => assertPurgeScopeFilter({ and: [ws] }, scope), 'missing org_id');
        assert.throws(() => assertPurgeScopeFilter({ and: [org, engineField('lore_workspace', 'eq', OTHER)] }, scope), 'wrong workspace');
        assert.throws(() => assertPurgeScopeFilter({ and: [engineField('org_id', 'eq', ORG_B), ws] }, scope), 'wrong org');
        assert.throws(() => assertPurgeScopeFilter({ and: [engineField('org_id', 'ne', ORG_A), ws] }, scope), 'wrong operator');
        assert.throws(() => assertPurgeScopeFilter({ or: [org, ws] }, scope));
        assert.doesNotThrow(() => assertPurgeScopeFilter({ and: [org, ws] }, scope));
        assert.doesNotThrow(() => assertPurgeScopeFilter({ and: [{ id_eq: 'lw1_x' }, org, ws] }, scope), 'the apply slice id_eq shape');
        assert.doesNotThrow(() => buildPurgeScanFilter(scope));
        assert.throws(() => purgeScope({ orgId: '', loreWorkspace: TARGET }));
        assert.throws(() => purgeScope({ orgId: ORG_A, loreWorkspace: '' }));
    });

    await test('a scan with a blank target or connection sends nothing', async () => {
        const w = await world('full');
        try {
            const from = w.mock.requests.length;
            await assert.rejects(scanWorkspaceForPurge({ client: w.client, target: { orgId: ORG_A, loreWorkspace: '' }, connection: CONN, collections: ['lore_node'] }));
            await assert.rejects(scanWorkspaceForPurge({ client: w.client, target: { orgId: ORG_A, loreWorkspace: TARGET }, connection: '', collections: ['lore_node'] }));
            assert.equal(w.mock.requests.length, from);
        } finally { await w.close(); }
    });

    await test('classifyPurgeRow: keyed / unkeyed / foreign', () => {
        const ok = scopeRowFields(S_A_T, 'x');
        assert.equal(classifyPurgeRow(ok, S_A_T), 'keyed');
        assert.equal(classifyPurgeRow({ ...ok, id: 'nope' }, S_A_T), 'unkeyed');
        assert.equal(classifyPurgeRow({ ...ok, id: 7 }, S_A_T), 'unkeyed');
        assert.equal(classifyPurgeRow({ ...ok, lore_id: '' }, S_A_T), 'unkeyed');
        assert.equal(classifyPurgeRow({ ...ok, lore_id: 'a\u001fb' }, S_A_T), 'unkeyed', 'separator in an id cannot be a valid key');
        assert.equal(classifyPurgeRow({ ...ok, org_id: ORG_B }, S_A_T), 'foreign');
        assert.equal(classifyPurgeRow({ ...ok, lore_workspace: OTHER }, S_A_T), 'foreign');
        assert.equal(classifyPurgeRow(null, S_A_T), 'foreign');
        assert.equal(classifyPurgeRow({}, S_A_T), 'foreign');
    });

    await test('purgeCollectionOrder: design order, nodes last; rejects transaction, malformed and duplicate names', () => {
        assert.deepEqual(purgeCollectionOrder(), ['lore_edge', 'lore_version', 'lore_verbatim', 'lore_node']);
        assert.deepEqual(purgeCollectionOrder(['b', 'c']), ['lore_edge', 'lore_version', 'b', 'c', 'lore_verbatim', 'lore_node']);
        for (const bad of ['transaction', 'Bad-Name', '', 'lore_node', 'lore_edge', '1x', 'a b']) assert.throws(() => purgeCollectionOrder([bad]), Error, bad);
        assert.throws(() => purgeCollectionOrder(['dup', 'dup']));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
