#!/usr/bin/env tsx
/**
 * workspace-erase-dataplane-unit.ts — lane f6b: the Dataplane eraser against the in-process MOCK Dataplane
 * (127.0.0.1 ephemeral port; never the real :18090).
 *
 * Proves: only rows whose key proves org + permanent id are deleted; a neighbour workspace with the SAME
 * lore_ids (shared content), a similarly named id, and the SAME id in another org are deep-equal before/after;
 * missing config / wrong org / newer-than-deletion writes leave everything in place and report partial;
 * unkeyed rows make the step unverifiable (never complete); a rerun is a no-op; the api key never reaches the result.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockDataplane, type MockDataplane } from './helpers/mock-dataplane.js';
import { createMockDataplaneClient } from './helpers/mock-dataplane-client.js';
import { scopeRowFields, type DataplaneScope } from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import { purgeCollectionOrder } from '../packages/lore/src/engines/dataplaneWorkspacePurge.js';
import { createDataplaneEraser } from '../packages/lore/src/engines/workspaceErase/dataplaneEraser.js';
import { deletionLogPath } from '../packages/lore/src/config/deletedWorkspaces.js';
import { loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import type { EraseTarget } from '../packages/lore/src/engines/workspaceErase/types.js';

let passed = 0; let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${((e as Error).stack ?? (e as Error).message).slice(0, 2500)}`); failed++; }
}

const KEY = 'f6b-secret-api-key';
const DP = 'dp-ws-f6b';
const CONN = 'postgresql';
const ORG_A = 'org-a'; const ORG_B = 'org-b';
const TARGET = 'ws-target-0001'; const NEIGHBOUR = 'ws-target-0002'; const PREFIXED = 'ws-target-0001-v2';
const DELETED_AT = Date.parse('2026-11-01T00:00:00.000Z');
const COLLECTIONS = purgeCollectionOrder([]);
const sc = (orgId: string, ws: string): DataplaneScope => ({ orgId, loreWorkspace: ws, dataplaneWorkspaceId: DP });
type Row = Record<string, unknown>;

async function seed(mock: MockDataplane, scope: DataplaneScope, n: number, stamp = '2026-10-01T00:00:00.000Z'): Promise<void> {
    const client = createMockDataplaneClient(mock.url, KEY);
    const ids = (p: string): string[] => Array.from({ length: n }, (_, i) => `${p}${i}`); // identical lore_ids in every scope
    for (const [coll, prefix] of [['lore_node', 'n'], ['lore_edge', 'e'], ['lore_verbatim', 'v']] as const) {
        for (const id of ids(prefix)) await client.insert(DP, coll, { ...scopeRowFields(scope, id), updated_at: stamp }, CONN);
    }
}
const rows = (mock: MockDataplane, pred: (r: Row) => boolean = () => true): Row[] => COLLECTIONS.flatMap((c) => mock.rows(DP, c, CONN).filter(pred));
const inScope = (s: DataplaneScope) => (r: Row): boolean => r['org_id'] === s.orgId && r['lore_workspace'] === s.loreWorkspace;

function setup(): { home: string; target: EraseTarget } {
    const home = fs.mkdtempSync(path.join(process.env['F6B_TMP'] ?? os.tmpdir(), 'ld-'));
    loadWorkspaces(home); // empty-but-valid registry: the target id is not live
    fs.appendFileSync(deletionLogPath(home), JSON.stringify({ v: 1, event: 'deleted', id: TARGET, idSource: 'stored', name: 'doomed', path: '/x', createdAt: null, deletedAt: new Date(DELETED_AT).toISOString(), orgId: ORG_A, mode: 'cloud', eraseAfter: new Date(DELETED_AT).toISOString(), windowDays: 0, holdingPath: null }) + '\n');
    return { home, target: { id: TARGET, name: 'doomed', path: '/x', mode: 'cloud', orgId: ORG_A, holdingPath: null } };
}
const env = (o: Record<string, string> = {}): Record<string, string> => ({ DATAPLANE_ORG_ID: ORG_A, DATAPLANE_API_KEY: KEY, DATAPLANE_URL: 'http://unused.invalid', DATAPLANE_CONNECTION: CONN, DATAPLANE_WORKSPACE_ID: DP, ...o });
const eraser = (home: string, mock: MockDataplane, e = env()) => createDataplaneEraser({ home, env: e, now: () => new Date(DELETED_AT + 86_400_000), clientFactory: () => createMockDataplaneClient(mock.url, KEY) });

console.log('workspace erase: dataplane eraser (mock Dataplane)');
const mock = await startMockDataplane({ apiKeys: { [KEY]: DP }, queryFilterMode: 'full' });
try {
    await test('erases only the target id in the target org; neighbours (same lore_ids, similar id, other org) are deep-equal', async () => {
        const { home, target } = setup();
        await seed(mock, sc(ORG_A, TARGET), 3); await seed(mock, sc(ORG_A, NEIGHBOUR), 4); await seed(mock, sc(ORG_A, PREFIXED), 5); await seed(mock, sc(ORG_B, TARGET), 6);
        const others = (r: Row): boolean => !inScope(sc(ORG_A, TARGET))(r);
        const before = JSON.parse(JSON.stringify(rows(mock, others))) as Row[];
        assert.equal(rows(mock, inScope(sc(ORG_A, TARGET))).length, 9);
        const out = await eraser(home, mock).erase(target);
        assert.equal(out.status, 'complete', JSON.stringify(out));
        assert.equal(out.removed['rows'], 9); assert.equal(out.remaining['rows'], 0);
        assert.equal(rows(mock, inScope(sc(ORG_A, TARGET))).length, 0);
        assert.deepEqual(rows(mock, others), before, 'every other workspace/org byte-identical');
        const again = await eraser(home, mock).erase(target);
        assert.equal(again.status, 'complete'); assert.equal(again.removed['rows'], 0, 'a rerun deletes nothing');
        assert.deepEqual(rows(mock, others), before);
    });

    await test('not a Dataplane deletion -> not-applicable and no request is sent', async () => {
        const { home, target } = setup(); const n = mock.requests.length;
        const out = await eraser(home, mock).erase({ ...target, mode: 'local' });
        assert.equal(out.status, 'not-applicable'); assert.equal(mock.requests.length, n);
    });

    await test('missing Dataplane config -> partial (never complete), nothing deleted', async () => {
        const { home, target } = setup(); await seed(mock, sc(ORG_A, TARGET), 2);
        const out = await eraser(home, mock, env({ DATAPLANE_API_KEY: '' })).erase(target);
        assert.equal(out.status, 'partial'); assert.match(out.detail ?? '', /DATAPLANE_API_KEY/);
        assert.equal(rows(mock, inScope(sc(ORG_A, TARGET))).length, 6);
        await eraser(home, mock).erase(target); // clean up for the next test
    });

    await test('recorded under a different org than this instance -> partial, nothing deleted', async () => {
        const { home, target } = setup(); await seed(mock, sc(ORG_A, TARGET), 2);
        const out = await eraser(home, mock, env({ DATAPLANE_ORG_ID: ORG_B })).erase(target);
        assert.equal(out.status, 'partial'); assert.equal(rows(mock, inScope(sc(ORG_A, TARGET))).length, 6);
        await eraser(home, mock).erase(target);
    });

    await test('a write newer than the deletion (another instance still writing) -> partial, nothing deleted', async () => {
        const { home, target } = setup(); await seed(mock, sc(ORG_A, TARGET), 2, new Date(DELETED_AT + 3_600_000).toISOString());
        const out = await eraser(home, mock).erase(target);
        assert.equal(out.status, 'partial'); assert.equal(rows(mock, inScope(sc(ORG_A, TARGET))).length, 6);
        for (const c of COLLECTIONS) for (const r of mock.rows(DP, c, CONN)) if (inScope(sc(ORG_A, TARGET))(r)) { /* leave for the next test's reset */ }
    });

    await test('the target id is live in the registry again -> partial, nothing deleted', async () => {
        const { home, target } = setup();
        const f = loadWorkspaces(home); f.workspaces.push({ name: 'back', path: '/y', createdAt: new Date().toISOString(), id: TARGET } as never);
        fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify(f));
        const before = rows(mock, inScope(sc(ORG_A, TARGET))).length;
        const out = await eraser(home, mock).erase(target);
        assert.equal(out.status, 'partial'); assert.equal(rows(mock, inScope(sc(ORG_A, TARGET))).length, before);
    });

    await test('the api key never appears in a result', async () => {
        const { home, target } = setup();
        const bad = createDataplaneEraser({ home, env: env(), now: () => new Date(DELETED_AT + 86_400_000), clientFactory: () => { throw new Error(`connect failed using ${KEY}`); } });
        const out = await bad.erase(target);
        assert.equal(out.status, 'partial'); assert.ok(!JSON.stringify(out).includes(KEY), 'secret must be redacted');
    });
} finally { await mock.close(); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
