#!/usr/bin/env tsx
/**
 * cloud-purge-preflight-unit.ts — lane f6d: `applyWorkspacePurge` refuses BEFORE it deletes anything.
 *
 * Bug on main: the "a newer write exists" probe ran inside the lore_node pass, which is purged LAST, so a refusal
 * arrived after lore_edge / lore_version / lore_verbatim rows were already gone (a half-purged workspace).
 *
 * Proves, against the engine-faithful mock Dataplane only (127.0.0.1 ephemeral port; never the real :18090):
 *   - engine level: a probeCheck refusal (newer write on lore_node) -> outcome aborted-probe, exit 2, stoppedIn lore_node,
 *     ZERO delete requests, every row of every table (target and neighbours) deep-equal before/after, every collection
 *     reported `not-reached`; the hook sees exactly one probe;
 *   - the real CLI path (`runCloudPurge --apply`): a write that lands after the CLI's own scan (injected when the apply
 *     walks lore_node a second time) is refused with ZERO deletes and every row (including the late one) still present;
 *   - the normal purge still completes (older writes), deleting only the target's rows, and a probeCheck that passes
 *     runs at the pre-flight and again at the lore_node pass;
 *   - `lore_node` not being purged -> no pre-flight, no probe call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockDataplane, type MockDataplane } from './helpers/mock-dataplane.js';
import { createMockDataplaneClient } from './helpers/mock-dataplane-client.js';
import { scopeRowFields, type DataplaneScope } from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import { probeDecision, purgeCollectionOrder, type WriteProbe } from '../packages/lore/src/engines/dataplaneWorkspacePurge.js';
import { applyWorkspacePurge } from '../packages/lore/src/engines/dataplaneWorkspacePurgeApply.js';
import { runCloudPurge } from '../packages/lore/src/cli/commands/maintainCloudPurge.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${((e as Error).stack ?? (e as Error).message).slice(0, 3000)}`); failed++; }
}

delete process.env['LORE_DEPLOYMENT_MODE'];

const KEY = 'f6d-preflight-secret-key';
const DP = 'dp-ws-f6d';
const CONN = 'postgresql';
const ORG = 'org-a';
const TARGET = 'ws-target-0001';
const OTHER = 'ws-other-0002';
const DELETED_AT = '2026-09-10T00:00:00.000Z';
const DELETED_MS = Date.parse(DELETED_AT);
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const COLLS = purgeCollectionOrder([]);
type Row = Record<string, unknown>;
const stamp = (iso: string): Row => ({ created_at: iso, updated_at: iso });
const OLD = stamp('2026-09-09T10:00:00.000Z');
const LATE = stamp(new Date(DELETED_MS + 3_600_000).toISOString());
const sc = (ws: string): DataplaneScope => ({ orgId: ORG, loreWorkspace: ws, dataplaneWorkspaceId: DP });
const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`);

type Client = ReturnType<typeof createMockDataplaneClient>;
interface World { mock: MockDataplane; client: Client }
async function world(): Promise<World> {
    const mock = await startMockDataplane({ apiKeys: { [KEY]: DP } });
    return { mock, client: createMockDataplaneClient(mock.url, KEY) };
}
async function seed(w: World, coll: string, scope: DataplaneScope, lids: readonly string[], extra: Row = OLD): Promise<void> {
    for (const id of lids) await w.client.insert(DP, coll, { ...scopeRowFields(scope, id), ...extra }, CONN);
}
/** Every purge collection populated (distinct counts per table), identical lore_ids in the neighbour scope. */
async function seedAll(w: World, scope: DataplaneScope, extra: Row = OLD): Promise<void> {
    await seed(w, 'lore_node', scope, ids('n', 3), extra);
    await seed(w, 'lore_edge', scope, ids('e', 4), extra);
    await seed(w, 'lore_version', scope, ids('v', 5), extra);
    await seed(w, 'lore_verbatim', scope, ids('b', 6), extra);
}
const rowsOf = (w: World, coll: string): Row[] => w.mock.rows(DP, coll, CONN);
/** Deep copy of EVERY row of EVERY table (all scopes). */
const everything = (w: World): Record<string, Row[]> => JSON.parse(JSON.stringify(Object.fromEntries(COLLS.map((c) => [c, rowsOf(w, c)])))) as Record<string, Row[]>;
const countIn = (w: World, ws: string): number => COLLS.reduce((a, c) => a + rowsOf(w, c).filter((r) => r['lore_workspace'] === ws).length, 0);
const deleteReqs = (w: World, from: number): number => w.mock.requests.slice(from).filter((r) => r.method === 'DELETE').length;

const decide = (p: WriteProbe) => probeDecision(p, { deletedAtMs: DELETED_MS, nowMs: NOW, minAgeMs: 0 });
const probeCheck = (p: WriteProbe): void => { const v = decide(p); if (v.refuse || v.verdict === 'unknown') throw new Error(v.reason); };

const apply = (w: World, o: { collections?: readonly string[]; probeCheck?: (p: WriteProbe) => void; client?: Client } = {}) => applyWorkspacePurge({
    client: o.client ?? w.client, target: { orgId: ORG, loreWorkspace: TARGET, dataplaneWorkspaceId: DP }, connection: CONN,
    collections: o.collections ?? COLLS, guard: () => undefined, ...(o.probeCheck ? { probeCheck: o.probeCheck } : {}),
});

console.log('cloud purge: pre-flight refusal before any delete (lane f6d)');

await test('engine: a newer lore_node write refuses the apply with ZERO deletes; every row of every table is untouched', async () => {
    const w = await world();
    try {
        await seedAll(w, sc(TARGET));
        await seedAll(w, sc(OTHER));
        await seed(w, 'lore_node', sc(TARGET), ['late'], LATE);
        const before = everything(w);
        const from = w.mock.requests.length;
        const seen: WriteProbe[] = [];
        const res = await apply(w, { probeCheck: (p) => { seen.push(p); probeCheck(p); } });
        assert.equal(res.outcome, 'aborted-probe');
        assert.equal(res.exitCode, 2);
        assert.equal(res.stoppedIn, 'lore_node');
        assert.match(res.message ?? '', /^recent-write probe refused: /);
        assert.equal(res.deleteRequests, 0);
        assert.equal(res.totals.deleted, 0);
        assert.equal(deleteReqs(w, from), 0, 'not one DELETE reached the Dataplane');
        assert.ok(res.collections.every((c) => c.endState === 'not-reached' && c.deleted === 0), JSON.stringify(res.collections.map((c) => [c.collection, c.endState])));
        assert.equal(seen.length, 1, 'the hook ran once, at the pre-flight');
        assert.deepEqual(everything(w), before, 'every row of every table (all scopes) is identical');
        assert.equal(countIn(w, TARGET), 19);
    } finally { await w.mock.close(); }
});

await test('engine: the refusal is the same whether or not earlier collections have rows (empty edges/versions/verbatim)', async () => {
    const w = await world();
    try {
        await seed(w, 'lore_node', sc(TARGET), ['late'], LATE);
        const before = everything(w);
        const res = await apply(w, { probeCheck });
        assert.equal(res.outcome, 'aborted-probe');
        assert.deepEqual(everything(w), before);
    } finally { await w.mock.close(); }
});

await test('engine: the normal purge still completes (older writes), only the target is deleted, hook runs at pre-flight + lore_node pass', async () => {
    const w = await world();
    try {
        await seedAll(w, sc(TARGET));
        await seedAll(w, sc(OTHER));
        const others = everything(w);
        for (const c of COLLS) others[c] = others[c]!.filter((r) => r['lore_workspace'] !== TARGET);
        let calls = 0;
        const res = await apply(w, { probeCheck: (p) => { calls++; probeCheck(p); } });
        assert.equal(res.outcome, 'complete', res.message ?? '');
        assert.equal(res.exitCode, 0);
        assert.equal(res.totals.deleted, 18);
        assert.equal(countIn(w, TARGET), 0);
        assert.equal(calls, 2, 'pre-flight + the lore_node pass (catches a write landing mid-run)');
        const rest = everything(w);
        assert.deepEqual(rest, others, 'the neighbour is byte-identical');
        const again = await apply(w, { probeCheck });
        assert.equal(again.exitCode, 0); assert.equal(again.deleteRequests, 0, 'a rerun sends no delete');
    } finally { await w.mock.close(); }
});

await test('engine: lore_node not purged -> no pre-flight and no probe call', async () => {
    const w = await world();
    try {
        await seedAll(w, sc(TARGET));
        let calls = 0;
        const res = await apply(w, { collections: ['lore_edge', 'lore_version'], probeCheck: () => { calls++; throw new Error('must not run'); } });
        assert.equal(res.exitCode, 0);
        assert.equal(calls, 0);
        assert.equal(rowsOf(w, 'lore_node').length, 3, 'lore_node untouched');
    } finally { await w.mock.close(); }
});

await test('engine: a failure of the pre-flight walk itself is exit 2 / failed with nothing deleted', async () => {
    const w = await world();
    try {
        await seedAll(w, sc(TARGET));
        const before = everything(w);
        const broken = new Proxy(w.client, { get(t, p, r) {
            const v = Reflect.get(t, p, r) as unknown;
            if (p !== 'query') return v;
            return async (_tenant: string, coll: string, ...rest: unknown[]) => {
                if (coll === 'lore_node') throw new Error('injected query fault');
                return (v as (...x: unknown[]) => Promise<unknown>).call(t, _tenant, coll, ...rest);
            };
        } });
        const res = await apply(w, { client: broken, probeCheck });
        assert.equal(res.outcome, 'failed');
        assert.equal(res.exitCode, 2);
        assert.equal(res.stoppedIn, 'lore_node');
        assert.match(res.message ?? '', /injected query fault/);
        assert.equal(res.deleteRequests, 0);
        assert.deepEqual(everything(w), before);
    } finally { await w.mock.close(); }
});

await test('CLI --apply: a write landing after the CLI scan is refused with ZERO deletes; all rows (incl. the late one) remain', async () => {
    const w = await world();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-f6d-'));
    try {
        fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({ active: 'default', workspaces: [{ name: 'default', id: 'default-id', path: home, createdAt: '2026-01-01T00:00:00.000Z' }] }));
        fs.appendFileSync(path.join(home, 'workspace-deletions.jsonl'), `${JSON.stringify({ v: 1, event: 'deleted', idSource: 'stored', name: 'old', path: '/x/old', createdAt: null, mode: 'cloud', id: TARGET, orgId: ORG, deletedAt: DELETED_AT })}\n`);
        await seedAll(w, sc(TARGET));
        await seedAll(w, sc(OTHER));
        // The CLI scan sees only old writes (so its own pre-apply probe passes). A newer write then lands, injected right
        // before the apply's SECOND lore_node query (the first is the scan). On main that second walk is the lore_node pass.
        let nodeQueries = 0;
        const racing = new Proxy(w.client, { get(t, p, r) {
            const v = Reflect.get(t, p, r) as unknown;
            if (p !== 'query') return v;
            return async (tenant: string, coll: string, ...rest: unknown[]) => {
                if (coll === 'lore_node' && ++nodeQueries === 2) await seed(w, 'lore_node', sc(TARGET), ['late'], LATE);
                return (v as (...x: unknown[]) => Promise<unknown>).call(t, tenant, coll, ...rest);
            };
        } });
        const out: string[] = [];
        const from = w.mock.requests.length;
        const { exitCode } = await runCloudPurge(['--id', TARGET, '--apply'], {
            clientFactory: () => racing as unknown as Client,
            env: { LORE_DEPLOYMENT_MODE: 'cloud', DATAPLANE_ORG_ID: ORG, DATAPLANE_API_KEY: KEY, DATAPLANE_URL: w.mock.url, DATAPLANE_CONNECTION: CONN, DATAPLANE_WORKSPACE_ID: DP },
            home, now: () => new Date(NOW), out: (l) => out.push(l), err: (l) => out.push(l),
        });
        const text = out.join('\n');
        assert.ok(nodeQueries >= 2, 'the injection point was reached');
        assert.equal(exitCode, 2, text);
        assert.match(text, /aborted-probe/);
        assert.match(text, /recent-write probe refused/);
        assert.equal(deleteReqs(w, from), 0, `no DELETE may be sent\n${text}`);
        assert.equal(countIn(w, TARGET), 19, 'target: 3+4+5+6 original rows + the late one, all present');
        assert.equal(countIn(w, OTHER), 18);
    } finally { await w.mock.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
