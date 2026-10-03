#!/usr/bin/env tsx
/**
 * cloud-review-b-fixes-unit.ts — regression tests for the senior review of cloud parity Slice B
 * (REVIEW-B.md). They run on the engine-faithful mock (test/helpers/mock-dataplane.ts): every
 * behaviour asserted here is one the REAL engine has and the old, kinder mock hid.
 *
 *   #2  duplicate insert is HTTP 500 (no 409): scopedUpsert disambiguates with a scoped GET
 *   #4  a pre-v2 collection: reduced schema push, one cloud_schema_drift, data still round-trips;
 *       a fresh collection gets the full v2 schema (graph AND lore_verbatim)
 *   #5/#6 identity lookups are GET by row key: correct on a SQLite-style connector that ignores
 *       filters and limit:1 queries (addEdge endpoint check, readRow)
 *   #7  a transient (5xx) GET failure is re-thrown, never read as "row absent"
 *   scopedGetRow contract: envelope / bare row / not found / out-of-scope / 5xx
 */
import assert from 'node:assert/strict';
import { startCloudFixture, bagOfWordsEmbedder, DP_KEY, DP_WORKSPACE, ORG_ID, connectedClient, FIXTURE_CONNECTION, withDefaultConnection } from './helpers/cloud-stores-fixture.js';
import { createMockDataplaneClient } from './helpers/mock-dataplane-client.js';
import { registryAcceptingAny } from './helpers/workspace-registry.js';
import { dataplaneRowKey, type DataplaneScope } from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import { scopedGetRow, scopedUpsert } from '../packages/lore/src/engines/dataplaneScopedIo.js';
import { DataplaneGraph } from '../packages/lore/src/engines/dataplaneGraph.js';
import { DataplaneVectorStore } from '../packages/lore/src/engines/dataplaneVectorStore.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const W1 = 'rb-ws-one';
const W2 = 'rb-ws-two';
const scope = (ws: string): DataplaneScope => ({ orgId: ORG_ID, loreWorkspace: ws, workspaceName: ws, dataplaneWorkspaceId: DP_WORKSPACE });
const node = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, type: 'note', label: id, content: `c ${id}`, tags: [], project: 'p', ecosystem: 'e', metadata: '{}', ...extra });
const doc = (id: string, text: string) =>
    ({ id, text, metadata: { type: 'note', label: id, tags: '', project: 'p', ecosystem: 'e', updatedAt: '2026-09-01T00:00:00.000Z', security_scopes: [] } });

/** Collect what is written to stderr while `fn` runs (the logger writes there). */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
    const lines: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = (chunk: unknown) => { lines.push(String(chunk)); return true; };
    try { return { value: await fn(), lines }; }
    finally { (process.stderr as unknown as { write: unknown }).write = real; }
}

/** Provision a pre-v2 collection exactly as an older Lore did (schema POST). */
async function provision(url: string, schema: unknown): Promise<void> {
    const res = await fetch(`${url}/v1/schema`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${DP_KEY}` }, body: JSON.stringify({ ...(schema as object), connection: FIXTURE_CONNECTION }) });
    assert.ok(res.ok, `provisioning failed: ${res.status}`);
}
const f = (name: string, extra: Record<string, unknown> = {}) => ({ name, field_type: 'string', ...extra });
const SCOPE_COLS = [f('org_id', { indexed: true, required: true }), f('lore_workspace', { indexed: true, required: true }), f('lore_id', { indexed: true, required: true })];

console.log('review B: scopedGetRow contract');
{
    const fx = await startCloudFixture();
    try {
        const mc = connectedClient(fx.mock.url, DP_KEY);
        await fx.as(W1, () => fx.graph.upsertNode(node('g1') as never)); // creates the collections
        const key = dataplaneRowKey(scope(W1), 'g1');

        await test('real engine envelope (HTTP 200 {success,data}) is unwrapped and scope-checked', async () => {
            const row = await scopedGetRow(mc as never, scope(W1), 'lore_node', 'g1');
            assert.equal(row?.['lore_id'], 'g1');
            assert.equal(row?.['id'], key);
        });
        await test('a miss (HTTP 200 + ERR_NOT_FOUND) is null, not an error and not a row', async () => {
            assert.equal(await scopedGetRow(mc as never, scope(W1), 'lore_node', 'nope'), null);
        });
        await test('a row of another Lore workspace is dropped (fail closed) with a cloud_scope_mismatch log', async () => {
            // Ask W2 for the W1 row key through a client that hands the W1 row back regardless of the key.
            const stale = { get: async () => mc.get(DP_WORKSPACE, 'lore_node', key) };
            const { value, lines } = await captureStderr(() => scopedGetRow(stale as never, scope(W2), 'lore_node', 'g1'));
            assert.equal(value, null);
            assert.ok(lines.some((l) => l.includes('cloud_scope_mismatch')));
        });
        await test('a bare row (an SDK build that unwraps the envelope) is accepted', async () => {
            const bare = { get: async () => ({ id: key, lore_id: 'g1', lore_workspace: W1, org_id: ORG_ID, label: 'x' }) };
            assert.equal((await scopedGetRow(bare as never, scope(W1), 'lore_node', 'g1'))?.['label'], 'x');
        });
        await test('a structured 404 / ERR_NOT_FOUND thrown by an SDK build is null', async () => {
            const t404 = { get: async () => { throw Object.assign(new Error('gone'), { statusCode: 404 }); } };
            const tCode = { get: async () => { throw Object.assign(new Error('gone'), { code: 'ERR_NOT_FOUND' }); } };
            assert.equal(await scopedGetRow(t404 as never, scope(W1), 'lore_node', 'g1'), null);
            assert.equal(await scopedGetRow(tCode as never, scope(W1), 'lore_node', 'g1'), null);
        });
        await test('follow-up B: a 3.x SDK THROWS on the engine 200 ERR_NOT_FOUND (engineCode); scopedGetRow treats it as a miss', async () => {
            const v3 = withDefaultConnection(createMockDataplaneClient(fx.mock.url, DP_KEY, { sdk: '3.x' }), FIXTURE_CONNECTION);
            // The 3.x client really throws here (statusCode 200, symbolic code on engineCode only).
            const thrown = await v3.get(DP_WORKSPACE, 'lore_node', 'nope').then(() => null, (e: unknown) => e as { statusCode?: number; engineCode?: string; code?: unknown });
            assert.equal(thrown?.engineCode, 'ERR_NOT_FOUND');
            assert.equal(thrown?.statusCode, 200);
            assert.equal(thrown?.code, undefined, 'the real GroundfloorError has no `code`');
            assert.equal(await scopedGetRow(v3 as never, scope(W1), 'lore_node', 'nope'), null);
            // A hit comes back unwrapped (3.x returns `data`) and is still scope-checked.
            assert.equal((await scopedGetRow(v3 as never, scope(W1), 'lore_node', 'g1'))?.['lore_id'], 'g1');
            assert.equal(await scopedGetRow(v3 as never, scope(W2), 'lore_node', 'g1'), null);
            // Any OTHER engine code on a 200 is still re-thrown, never "absent".
            const other = { get: async () => { throw Object.assign(new Error('boom'), { statusCode: 200, engineCode: 'ERR_QUERY' }); } };
            await assert.rejects(() => scopedGetRow(other as never, scope(W1), 'lore_node', 'g1'), /boom/);
        });
        await test('5xx, network errors and non-not-found error envelopes are RE-THROWN (never "absent")', async () => {
            const c503 = { get: async () => { throw Object.assign(new Error('unavailable'), { statusCode: 503 }); } };
            const net = { get: async () => { throw new TypeError('fetch failed'); } };
            const env = { get: async () => ({ success: false, error: { code: 'ERR_QUERY', message: 'boom' } }) };
            await assert.rejects(() => scopedGetRow(c503 as never, scope(W1), 'lore_node', 'g1'), /unavailable/);
            await assert.rejects(() => scopedGetRow(net as never, scope(W1), 'lore_node', 'g1'), /fetch failed/);
            await assert.rejects(() => scopedGetRow(env as never, scope(W1), 'lore_node', 'g1'), /boom/);
        });
    } finally { await fx.close(); }
}

console.log('review B #2: duplicate insert is 500, not 409');
{
    const fx = await startCloudFixture();
    try {
        const mc = connectedClient(fx.mock.url, DP_KEY);
        await fx.as(W1, () => fx.graph.upsertNode(node('seed') as never));
        await test('a lost insert race (engine 500 on the duplicate PK) is recovered: GET finds the row, the update is retried', async () => {
            // Race: updateByQuery matches nothing (the row is not there yet), then the row appears, then insert 500s.
            let racing = true;
            const racy = {
                get: mc.get,
                insert: async (t: string, c: string, r: unknown) => {
                    if (racing) { racing = false; await mc.insert(t, c, { ...(r as object), label: 'winner' }); }
                    return mc.insert(t, c, r);
                },
                updateByQuery: (() => {
                    let first = true;
                    return async (t: string, c: string, filter: object, fields: object) => {
                        if (first) { first = false; return { updated: 0 }; }
                        return mc.updateByQuery(t, c, filter, fields);
                    };
                })(),
            };
            const out = await scopedUpsert(racy as never, scope(W1), 'lore_node', 'raced', { type: 'note', label: 'loser' });
            assert.equal(out, 'updated');
            const row = fx.mock.rows(DP_WORKSPACE, 'lore_node').find((r) => r['lore_id'] === 'raced')!;
            assert.equal(row['label'], 'loser', 'the retried update wins last-writer');
        });
        await test('an insert that fails for a real reason (no row exists) surfaces the ORIGINAL error', async () => {
            const broken = {
                get: mc.get,
                updateByQuery: async () => ({ updated: 0 }),
                insert: async () => { throw Object.assign(new Error('disk full'), { statusCode: 500 }); },
            };
            await assert.rejects(() => scopedUpsert(broken as never, scope(W1), 'lore_node', 'never', { type: 'note' }), /disk full/);
        });
        await test('a structured 409 is still a conflict (strict connectors)', async () => {
            let n = 0;
            const strict = {
                get: async () => { throw new Error('GET must not be needed for a 409'); },
                updateByQuery: async () => ({ updated: n++ === 0 ? 0 : 1 }),
                insert: async () => { throw Object.assign(new Error('dup'), { statusCode: 409 }); },
            };
            assert.equal(await scopedUpsert(strict as never, scope(W1), 'lore_node', 'x', { type: 'note' }), 'updated');
        });
    } finally { await fx.close(); }
}

console.log('review B #7: a transient GET failure is not "row absent"');
{
    const fx = await startCloudFixture();
    try {
        const mc = connectedClient(fx.mock.url, DP_KEY);
        let failGets = false;
        const flaky = new Proxy(mc, {
            get(target, prop, recv) {
                if (prop === 'get') return async (...a: unknown[]) => { if (failGets) throw Object.assign(new Error('gateway timeout'), { statusCode: 504 }); return (target.get as (...x: unknown[]) => Promise<unknown>)(...a); };
                return Reflect.get(target, prop, recv);
            },
        });
        const graph = new DataplaneGraph({ connection: FIXTURE_CONNECTION, client: flaky as never, dataplaneWorkspaceId: DP_WORKSPACE, orgId: ORG_ID, workspaceRegistry: registryAcceptingAny() });
        const created = '2026-01-01T00:00:00.000Z';
        await fx.as(W1, () => graph.upsertNode(node('keep', { accessCount: 7, confirmationCount: 3 }) as never));
        // Age the row so created_at is recognisably the ORIGINAL one.
        await mc.updateByQuery(DP_WORKSPACE, 'lore_node', { field: { field: 'lore_id', operator: 'eq', value: { string: 'keep' } } }, { created_at: created });
        const before = fx.mock.rows(DP_WORKSPACE, 'lore_node').find((r) => r['lore_id'] === 'keep')!;
        await test('upsertNode during a 5xx GET rejects and leaves created_at and counters untouched', async () => {
            failGets = true;
            try { await assert.rejects(() => fx.as(W1, () => graph.upsertNode(node('keep', { label: 'changed' }) as never)), /gateway timeout/); }
            finally { failGets = false; }
            const after = fx.mock.rows(DP_WORKSPACE, 'lore_node').find((r) => r['lore_id'] === 'keep')!;
            assert.equal(after['created_at'], created);
            assert.equal(after['label'], before['label']);
            assert.equal(after['access_count'], before['access_count']);
            assert.equal(after['confirmation_count'], before['confirmation_count']);
        });
        await test('getNode during a 5xx GET rejects instead of returning null', async () => {
            failGets = true;
            try { await assert.rejects(() => fx.as(W1, () => graph.getNode('keep')), /gateway timeout/); }
            finally { failGets = false; }
            assert.equal((await fx.as(W1, () => graph.getNode('keep')))?.id, 'keep');
        });
        await test('addEdge during a 5xx GET rejects instead of reporting a missing endpoint', async () => {
            await fx.as(W1, () => graph.upsertNode(node('other') as never));
            failGets = true;
            try { await assert.rejects(() => fx.as(W1, () => graph.addEdge({ sourceId: 'keep', targetId: 'other', relation: 'related_to' } as never)), /gateway timeout/); }
            finally { failGets = false; }
        });
    } finally { await fx.close(); }
}

console.log('review B #5/#6: identity lookups are GET by row key (correct on a SQLite-style connector)');
{
    const fx = await startCloudFixture();
    try {
        // Other workspaces' rows fill storage first, so a filter-ignoring `limit: 1` query would return them.
        for (let i = 0; i < 5; i++) await fx.as(W2, () => fx.graph.upsertNode(node(`noise${i}`) as never));
        await fx.as(W1, () => fx.graph.upsertNode(node('a') as never));
        await fx.as(W1, () => fx.graph.upsertNode(node('b') as never));
        await fx.as(W1, () => fx.vector.store(doc('v1', 'hello world') as never));
        fx.mock.options.queryFilterMode = 'sqlite';
        try {
            await test('addEdge finds both endpoints although the connector ignores every filter', async () => {
                await fx.as(W1, () => fx.graph.addEdge({ sourceId: 'a', targetId: 'b', relation: 'related_to' } as never));
                assert.ok(fx.mock.rows(DP_WORKSPACE, 'lore_edge').some((r) => r['lore_workspace'] === W1 && r['source_id'] === 'a'));
            });
            await test('addEdge still rejects an endpoint that exists only in another Lore workspace', async () => {
                await assert.rejects(() => fx.as(W1, () => fx.graph.addEdge({ sourceId: 'a', targetId: 'noise0', relation: 'related_to' } as never)), /endpoint/i);
            });
            await test('graph.getNode is correct on the same connector (no limit:1 query involved)', async () => {
                assert.equal((await fx.as(W1, () => fx.graph.getNode('a')))?.id, 'a');
                assert.equal(await fx.as(W1, () => fx.graph.getNode('noise0')), null);
            });
            await test('verbatim readRow (getById and identical re-store) is correct and performs no write', async () => {
                const got = await fx.as(W1, () => fx.vector.getById('v1')) as Record<string, unknown> | null;
                assert.equal(got?.['text'], 'hello world');
                assert.equal(await fx.as(W2, () => fx.vector.getById('v1')), null);
                const m = fx.mock.requests.length;
                await fx.as(W1, () => fx.vector.store(doc('v1', 'hello world') as never));
                const writes = fx.mock.requests.slice(m).filter((r) => r.method !== 'GET' && !r.path.endsWith('/query') && !r.path.endsWith('/count'));
                assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), []);
            });
        } finally { fx.mock.options.queryFilterMode = 'full'; }
        await test('no cloud identity lookup uses a filtered limit query: graph/vector point reads issue GET /:c/:id', async () => {
            const m = fx.mock.requests.length;
            await fx.as(W1, () => fx.graph.getNode('a'));
            await fx.as(W1, () => fx.vector.getById('v1'));
            const rs = fx.mock.requests.slice(m);
            assert.ok(rs.filter((r) => r.method === 'GET').length >= 2);
            assert.equal(rs.filter((r) => r.path.endsWith('/query')).length, 0, 'no /query for a point read');
        });
    } finally { await fx.close(); }
}

console.log('review B #4: pre-v2 collections and fresh collections');
{
    const fx = await startCloudFixture();
    try {
        await provision(fx.mock.url, { name: 'lore_verbatim', fields: [f('id', { primary_key: true, required: true }), f('text'), f('type'), f('label'), f('tags'), f('project'), f('ecosystem'), ...SCOPE_COLS], indexes: [{ name: 'idx_v_lw', fields: ['lore_workspace', 'lore_id'] }] });
        await test('verbatim: a pre-v2 collection is reconciled (reduced push, no 500), one cloud_schema_drift, data round-trips', async () => {
            const { lines } = await captureStderr(async () => {
                await fx.as(W1, () => fx.vector.store(doc('old1', 'legacy text') as never));
                await fx.as(W1, () => fx.vector.store(doc('old2', 'more legacy') as never));
            });
            const drift = lines.filter((l) => l.includes('cloud_schema_drift') && l.includes('lore_verbatim'));
            assert.equal(drift.length, 1, `expected exactly one drift warning, got ${drift.length}`);
            assert.ok(drift[0]!.includes('content_hash'), 'the warning lists the missing column content_hash');
            const got = await fx.as(W1, () => fx.vector.getById('old1')) as Record<string, unknown> | null;
            assert.equal(got?.['text'], 'legacy text');
            assert.deepEqual(fx.mock.declaredFields(DP_WORKSPACE, 'lore_verbatim')!.includes('content_hash'), false, 'columns are not added by a re-push');
        });
    } finally { await fx.close(); }

    const fresh = await startCloudFixture();
    try {
        await test('fresh collections get the FULL v2 schema, with no drift warning (graph and verbatim)', async () => {
            const { lines } = await captureStderr(async () => {
                await fresh.as(W1, () => fresh.graph.upsertNode(node('n') as never));
                await fresh.as(W1, () => fresh.vector.store(doc('v', 'fresh') as never));
            });
            assert.equal(lines.filter((l) => l.includes('cloud_schema_drift')).length, 0);
            const n = fresh.mock.declaredFields(DP_WORKSPACE, 'lore_node')!;
            for (const c of ['valid_from', 'superseded_by', 'anchors', 'confirmation_score']) assert.ok(n.includes(c), `lore_node declares ${c}`);
            assert.ok(fresh.mock.declaredFields(DP_WORKSPACE, 'lore_verbatim')!.includes('content_hash'));
        });
        await test('a second store against an up-to-date collection re-pushes the full schema and stays quiet', async () => {
            const { lines } = await captureStderr(async () => {
                const other = new DataplaneVectorStore({ connection: FIXTURE_CONNECTION, client: connectedClient(fresh.mock.url, DP_KEY) as never, dataplaneWorkspaceId: DP_WORKSPACE, orgId: ORG_ID, workspaceRegistry: registryAcceptingAny(), embeddingProvider: bagOfWordsEmbedder() });
                await runAs(W1, () => other.store(doc('v2', 'again') as never));
                await other.close();
            });
            assert.equal(lines.filter((l) => l.includes('cloud_schema_drift')).length, 0);
        });
    } finally { await fresh.close(); }
}

async function runAs<T>(ws: string, fn: () => Promise<T>): Promise<T> {
    const { runWithWorkspace } = await import('../packages/lore/src/security/workspaceContext.js');
    return runWithWorkspace({ workspaceId: ws }, fn);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
