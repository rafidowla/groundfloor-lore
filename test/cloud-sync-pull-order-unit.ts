#!/usr/bin/env tsx
/**
 * cloud-sync-pull-order-unit.ts — cloud parity Slice B (sync fix): TsSdkAdapter.pull must return
 * rows in a stable (updated_at, lore_id) order and must never split a run of equal updated_at
 * values across the 1000-row page boundary.
 *
 * Why: SyncEngine paginates by advancing `since` to the max updatedAt of the page and the adapter
 * treats `since` as exclusive (`updated_at > since`). With an unsorted `limit: 1000` query the
 * engine could (a) get an arbitrary 1000 of N rows and move the cursor past rows it never saw, or
 * (b) cut a run of equal timestamps in half, after which `> since` drops the remainder forever.
 * The test drives the same cursor loop SyncEngine uses.
 */
import assert from 'node:assert/strict';
import { startCloudFixture, DP_KEY, DP_WORKSPACE, ORG_ID, connectedClient, FIXTURE_CONNECTION } from './helpers/cloud-stores-fixture.js';
import { dataplaneRowKey } from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import { TsSdkAdapter } from '../packages/lore/src/engines/tsSdkAdapter.js';
import { testRegistry } from './helpers/workspace-registry.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const PAGE_FULL = 1000; // SyncEngine PULL_PAGE_FULL_THRESHOLD
const MAX_PAGES = 50; // SyncEngine PULL_MAX_PAGES
const WS = 'pull-ws';
const OTHER = 'pull-other-ws';
const base = Date.parse('2026-09-01T00:00:00.000Z');
const iso = (n: number) => new Date(base + n * 1000).toISOString();
const pad = (n: number) => String(n).padStart(5, '0');

console.log('cloud parity B: TsSdkAdapter.pull ordering and page boundary');

const fx = await startCloudFixture();
try {
    const mc = connectedClient(fx.mock.url, DP_KEY);
    const raw = {
        insert: (c: string, r: unknown) => mc.insert(DP_WORKSPACE, c, r),
        updateByQuery: (c: string, f: object, fields: object) => mc.updateByQuery(DP_WORKSPACE, c, f, fields),
        deleteByQuery: (c: string, f: object) => mc.deleteByQuery(DP_WORKSPACE, c, f),
        query: (c: string, o: unknown) => mc.query(DP_WORKSPACE, c, o),
        graph: mc.graph,
    };
    const adapter = (ws: string) => {
        const a = new TsSdkAdapter({ baseUrl: 'x', apiKey: 'x', tenantId: DP_WORKSPACE, orgId: ORG_ID, workspaceRegistry: testRegistry(ws), loreWorkspace: ws });
        (a as unknown as { client: unknown; connected: boolean }).client = raw;
        (a as unknown as { connected: boolean }).connected = true;
        return a;
    };
    // Initialise the cloud collections through the real graph (schema + indexes).
    await fx.as('pull-init', () => fx.graph.upsertNode({ id: 'init', type: 'note', label: 'init', content: 'c', tags: [], project: 'p', ecosystem: 'e', metadata: '{}' } as never));

    const row = (ws: string, id: string, ts: string) => ({
        id: dataplaneRowKey({ orgId: ORG_ID, loreWorkspace: ws, dataplaneWorkspaceId: DP_WORKSPACE } as never, id),
        lore_id: id, lore_workspace: ws, org_id: ORG_ID,
        type: 'note', label: id, content: `c ${id}`, tags: [], project: 'p', ecosystem: 'e',
        created_at: ts, updated_at: ts,
    });
    const seed = async (rows: Array<Record<string, unknown>>) => {
        // Per-row insert: /bulk ignores the caller id (engine handlers.rs bulk_insert), and
        // the scope guard requires id == the D2 row key, so bulk-seeded rows would be dropped.
        for (let i = 0; i < rows.length; i += 25) await Promise.all(rows.slice(i, i + 25).map((r) => mc.insert(DP_WORKSPACE, 'lore_node', r)));
    };
    /** The cursor loop SyncEngine.pullRemote runs: exclusive `since`, advance to max updatedAt, stop on a short page. */
    const drain = async (a: TsSdkAdapter, since = '1970-01-01T00:00:00.000Z') => {
        const seen: string[] = [];
        let cursor = since;
        for (let page = 0; page < MAX_PAGES; page++) {
            const { nodes } = await a.pull(cursor);
            let max = cursor;
            for (const n of nodes) { seen.push(n.id); if (n.updatedAt > max) max = n.updatedAt; }
            const advanced = max > cursor;
            cursor = max;
            if (nodes.length < PAGE_FULL) break;
            assert.ok(advanced, 'a full page must advance the cursor (SyncEngine would report a stall)');
        }
        return seen;
    };

    // 990 rows with distinct timestamps, then 210 rows sharing ONE timestamp: the 1000-row page
    // boundary falls inside that run. Inserted in a scrambled order on purpose.
    const distinct = Array.from({ length: 990 }, (_, i) => row(WS, `n${pad(i)}`, iso(i)));
    const tie = Array.from({ length: 210 }, (_, i) => row(WS, `t${pad(i)}`, iso(5000)));
    const all = [...distinct, ...tie];
    const scrambled = all.map((r, i) => ({ r, k: (i * 7919) % all.length })).sort((x, y) => x.k - y.k).map((x) => x.r);
    await seed(scrambled);
    await seed(Array.from({ length: 50 }, (_, i) => row(OTHER, `o${pad(i)}`, iso(5000)))); // foreign workspace, same timestamps

    await test('pull returns rows ordered by (updated_at, lore_id)', async () => {
        const { nodes } = await adapter(WS).pull('1970-01-01T00:00:00.000Z');
        const keys = nodes.map((n) => `${n.updatedAt}|${n.id}`);
        assert.deepEqual(keys, [...keys].sort());
        assert.equal(nodes[0]!.id, 'n00000'); // earliest first, not insertion order
    });

    await test('a run of equal updated_at cut by the page boundary is still delivered whole', async () => {
        const seen = await drain(adapter(WS));
        const want = all.map((r) => r.lore_id as string).sort();
        assert.equal(new Set(seen).size, seen.length, 'no duplicates');
        assert.deepEqual([...new Set(seen)].sort(), want, 'every row in the workspace is delivered exactly once');
        assert.ok(!seen.some((id) => id.startsWith('o')), 'rows of another Lore workspace never leak in');
    });

    await test('more than 1000 rows sharing one updated_at are all delivered', async () => {
        const bigTs = iso(9000);
        await seed(Array.from({ length: 1150 }, (_, i) => row(WS, `b${pad(i)}`, bigTs)));
        const seen = await drain(adapter(WS), iso(6000));
        assert.equal(seen.length, 1150);
        assert.equal(new Set(seen).size, 1150);
    });

    await test('a short page is returned as-is and the next pull (since = max) is empty', async () => {
        const a = adapter(WS);
        const { nodes } = await a.pull(iso(8999));
        assert.equal(nodes.length, 1150);
        const last = nodes[nodes.length - 1]!.updatedAt;
        assert.deepEqual((await a.pull(last)).nodes, []);
    });

    // Review B #8 — SQLite-connector emulation: filters (except id_eq), sort and offset are ignored
    // and the first `limit` rows in storage order come back (sqlite.rs:186-245).
    await test('sqlite connector, collection > 1 page: refuses a truncated page instead of reporting it as the last', async () => {
        fx.mock.options.queryFilterMode = 'sqlite';
        try {
            await assert.rejects(() => adapter(WS).pull('1970-01-01T00:00:00.000Z'), /ignored the scope filter or sort/);
        } finally { fx.mock.options.queryFilterMode = 'full'; }
    });
} finally {
    await fx.close();
}

// A separate small fixture: the whole collection fits in one raw page, so a filter-ignoring
// connector can still be read completely as long as the adapter filters and sorts client-side.
const fx2 = await startCloudFixture();
try {
    const mc2 = connectedClient(fx2.mock.url, DP_KEY);
    const raw2 = {
        insert: (c: string, r: unknown) => mc2.insert(DP_WORKSPACE, c, r),
        updateByQuery: (c: string, f: object, fields: object) => mc2.updateByQuery(DP_WORKSPACE, c, f, fields),
        deleteByQuery: (c: string, f: object) => mc2.deleteByQuery(DP_WORKSPACE, c, f),
        query: (c: string, o: unknown) => mc2.query(DP_WORKSPACE, c, o),
        graph: mc2.graph,
    };
    const a2 = new TsSdkAdapter({ baseUrl: 'x', apiKey: 'x', tenantId: DP_WORKSPACE, orgId: ORG_ID, workspaceRegistry: testRegistry(WS), loreWorkspace: WS });
    (a2 as unknown as { client: unknown; connected: boolean }).client = raw2;
    (a2 as unknown as { connected: boolean }).connected = true;
    await fx2.as('pull-init', () => fx2.graph.upsertNode({ id: 'init', type: 'note', label: 'init', content: 'c', tags: [], project: 'p', ecosystem: 'e', metadata: '{}' } as never));
    const row2 = (ws: string, id: string, ts: string) => ({
        id: dataplaneRowKey({ orgId: ORG_ID, loreWorkspace: ws, dataplaneWorkspaceId: DP_WORKSPACE } as never, id),
        lore_id: id, lore_workspace: ws, org_id: ORG_ID, type: 'note', label: id, content: 'c', tags: [], project: 'p', ecosystem: 'e',
        created_at: ts, updated_at: ts,
    });
    // Newest first in storage order, plus foreign rows, plus a row at/below the cursor.
    for (const r of [row2(WS, 'c', iso(30)), row2(OTHER, 'x', iso(25)), row2(WS, 'b', iso(20)), row2(WS, 'old', iso(1)), row2(WS, 'a', iso(10))]) await mc2.insert(DP_WORKSPACE, 'lore_node', r);
    await test('sqlite connector, small collection: rows are scoped, filtered by since and sorted client-side', async () => {
        fx2.mock.options.queryFilterMode = 'sqlite';
        try {
            const { nodes } = await a2.pull(iso(5));
            assert.deepEqual(nodes.map((n) => n.id), ['a', 'b', 'c']);
        } finally { fx2.mock.options.queryFilterMode = 'full'; }
    });
    await test('full-mode pull of the same data is identical (local/PG behaviour unchanged)', async () => {
        const { nodes } = await a2.pull(iso(5));
        assert.deepEqual(nodes.map((n) => n.id), ['a', 'b', 'c']);
    });
} finally {
    await fx2.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
