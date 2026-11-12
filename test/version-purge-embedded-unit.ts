#!/usr/bin/env tsx
/**
 * version-purge-embedded-unit.ts — `nodeDelete({ purge: true })` / `nodeDeleteMany({ purge: true })` also erase the
 * node's version history (`versions.sqlite` node_versions), on SQLite and Postgres workspaces.
 *
 * Boots a real embedded `createLore()` through the golden-baseline opener (two workspaces, golden-a / golden-b), so
 * this proves the production wire-up (server.ts -> embedded nodeDelete deps -> purgeNodeVersions), not just the store.
 * Postgres workspaces keep their versions in the same local `versions.sqlite`, so the same path is exercised; the
 * Postgres variant skips only when LORE_PG_URL is not set.
 *
 * Pinned (per engine):
 *   - after purge `getVersions` is empty for that node; another node and the same id in the other workspace keep theirs;
 *   - plain delete keeps versions;
 *   - purging again (and an unknown id) is a no-op;
 *   - nodeDeleteMany purges the versions of every purged id;
 *   - crash/replay: with the versions back and only the queued `verbatim.purge` row left (current payload and a legacy
 *     payload without `nodeIds`), draining the outbox converges to no versions.
 *
 * Run: npx tsx test/version-purge-embedded-unit.ts
 */
import assert from 'node:assert/strict';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import { gateDbUrl } from './helpers/testPostgres.js';
import { openRun, type Engine } from './golden-baseline/open.js';
import { WS_A, WS_B } from './golden-baseline/workload.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const save = (lore: Any, ws: string, id: string, content: string): Promise<unknown> => lore.nodeUpsert({
    id, workspace: ws, ecosystem: '*', autolink: false,
    nodeData: { id, type: 'note', label: id, content, tags: 'vp', project: ws, ecosystem: '*' },
});
async function settle(lore: Any): Promise<void> {
    const store = lore._daemon.outboxWiring.store;
    const r = lore._daemon.outboxWiring.replicator as { tickOnce(): Promise<number> };
    const deadline = Date.now() + 30_000;
    for (;;) {
        await lore.awaitEmbeds();
        if ((await store.listUnfinished()).length === 0) return;
        if (Date.now() > deadline) assert.fail('outbox did not drain');
        await r.tickOnce();
        await new Promise((x) => setTimeout(x, 10));
    }
}
const vers = (lore: Any, ws: string, id: string): unknown[] => lore._daemon.versionStore.getVersions(id, ws, 100);
const secret = (id: string): string => `Secret body of ${id}: zebrafish quartz.`;

async function suite(engine: Engine): Promise<void> {
    if (engine === 'postgres' && !gateDbUrl()) { console.log('  SKIP postgres: LORE_PG_URL is not set'); return; }
    console.log(`engine: ${engine}`);
    const run = await openRun(engine);
    const lore = run.lore as Any;
    try {
        await test('purge erases the node\'s version history; other nodes and the other workspace keep theirs', async () => {
            await save(lore, WS_A, 'p1', secret('p1')); await save(lore, WS_A, 'p1', secret('p1') + ' rev2');
            await save(lore, WS_A, 'keep', secret('keep')); await save(lore, WS_B, 'p1', secret('p1-b'));
            await settle(lore);
            assert.ok(vers(lore, WS_A, 'p1').length >= 2, 'precondition: versions exist');
            const keepBefore = JSON.stringify(vers(lore, WS_A, 'keep')); const otherBefore = JSON.stringify(vers(lore, WS_B, 'p1'));
            const r = await lore.nodeDelete({ id: 'p1', workspace: WS_A, purge: true });
            assert.equal(r.purged, true);
            assert.deepEqual(vers(lore, WS_A, 'p1'), [], 'inline: versions are already gone BEFORE the outbox drains');
            await settle(lore);
            assert.deepEqual(vers(lore, WS_A, 'p1'), []);
            assert.equal(JSON.stringify(vers(lore, WS_A, 'keep')), keepBefore);
            assert.equal(JSON.stringify(vers(lore, WS_B, 'p1')), otherBefore, 'same id in another workspace untouched');
        });

        await test('plain delete keeps version history', async () => {
            await save(lore, WS_A, 'plain', secret('plain')); await settle(lore);
            const before = vers(lore, WS_A, 'plain').length; assert.ok(before >= 1);
            await lore.nodeDelete({ id: 'plain', workspace: WS_A }); await settle(lore);
            assert.ok(vers(lore, WS_A, 'plain').length >= before, 'versions kept (plain delete is recoverable)');
        });

        await test('re-purge and purge of an unknown id are no-ops', async () => {
            await lore.nodeDelete({ id: 'p1', workspace: WS_A, purge: true }); await settle(lore);
            await lore.nodeDelete({ id: 'never-existed', workspace: WS_A, purge: true }); await settle(lore);
            assert.deepEqual(vers(lore, WS_A, 'p1'), []);
        });

        await test('nodeDeleteMany purge erases the versions of every purged id only', async () => {
            for (const id of ['m1', 'm2', 'm3']) await save(lore, WS_A, id, secret(id));
            await settle(lore);
            const m3 = JSON.stringify(vers(lore, WS_A, 'm3'));
            await lore.nodeDeleteMany({ ids: ['m1', 'm2'], workspace: WS_A, purge: true });
            assert.deepEqual(vers(lore, WS_A, 'm1'), [], 'inline (many): gone before settle'); assert.deepEqual(vers(lore, WS_A, 'm2'), []);
            await settle(lore);
            assert.deepEqual(vers(lore, WS_A, 'm1'), []); assert.deepEqual(vers(lore, WS_A, 'm2'), []);
            assert.equal(JSON.stringify(vers(lore, WS_A, 'm3')), m3);
        });

        await test('H1: a stale verbatim.purge replay does not wipe history of a node re-created after the purge', async () => {
            await save(lore, WS_A, 'h1', secret('h1-old')); await settle(lore);
            await lore.nodeDelete({ id: 'h1', workspace: WS_A, purge: true });
            await new Promise((x) => setTimeout(x, 5));
            await save(lore, WS_A, 'h1', secret('h1-new')); // re-created; the purge row may still be pending
            await settle(lore);
            const v = vers(lore, WS_A, 'h1') as Array<{ newState?: { content?: string } }>;
            assert.equal(v.length, 1, 'the re-created node keeps its one new version');
            assert.ok(JSON.stringify(v[0]).includes('h1-new') && !JSON.stringify(v).includes('h1-old'));
            // Explicit stale row: queued purge bounded at a moment BEFORE the re-created version was written.
            const wiring = lore._daemon.outboxWiring;
            await recordHotWrite(wiring.store, { workspace: WS_A, operationKind: 'verbatim.purge', payload: { id: 'lore:h1', ids: ['lore:h1'], nodeIds: ['h1'], purgedAt: new Date(Date.now() - 60_000).toISOString() } });
            await settle(lore);
            assert.equal(vers(lore, WS_A, 'h1').length, 1, 'a replay bounded earlier than the new version leaves it alone');
        });

        await test('H2: purging a node that was already plain-deleted still erases its version history', async () => {
            await save(lore, WS_A, 'b1', secret('b1')); await settle(lore);
            await lore.nodeDelete({ id: 'b1', workspace: WS_A }); await settle(lore);
            assert.ok(vers(lore, WS_A, 'b1').length >= 1, 'precondition: plain delete kept history');
            const r = await lore.nodeDelete({ id: 'b1', workspace: WS_A, purge: true });
            assert.equal(r.deleted, false); assert.equal(r.purged, true);
            assert.deepEqual(vers(lore, WS_A, 'b1'), [], 'gone before settle');
            await save(lore, WS_A, 'b2', secret('b2')); await save(lore, WS_A, 'b3', secret('b3')); await settle(lore);
            await lore.nodeDelete({ id: 'b2', workspace: WS_A }); await settle(lore);
            const many = await lore.nodeDeleteMany({ ids: ['b2', 'b3', 'b-never'], workspace: WS_A, purge: true });
            const byId = Object.fromEntries((many.results as Array<{ id: string; deleted: boolean; purged?: boolean }>).map((x) => [x.id, x]));
            assert.equal(byId['b2']!.deleted, false); assert.equal(byId['b2']!.purged, true);
            assert.equal(byId['b3']!.deleted, true); assert.equal(byId['b-never']!.deleted, false);
            assert.deepEqual(vers(lore, WS_A, 'b2'), []); assert.deepEqual(vers(lore, WS_A, 'b3'), []);
            await settle(lore);
        });

        await test('M2: an upsert racing a purge never leaves history for an erased node', async () => {
            for (let i = 0; i < 12; i++) {
                const id = `race-${i}`;
                await save(lore, WS_A, id, secret(id)); await settle(lore);
                await Promise.all([save(lore, WS_A, id, secret(id) + ' rev2'), lore.nodeDelete({ id, workspace: WS_A, purge: true })]);
                await settle(lore);
                const exists = !!(await lore.store.storageClient.getNode(id, { workspace: WS_A }));
                const n = vers(lore, WS_A, id).length;
                assert.equal(exists, n > 0, `${id}: node exists=${exists} but versions=${n} (erased content must not reappear in history)`);
            }
        });

        await test('replay converges: a queued verbatim.purge row (current and legacy payload) removes the versions', async () => {
            const wiring = lore._daemon.outboxWiring;
            const rows: Array<[string, Record<string, unknown>]> = [
                ['r1', { id: 'lore:r1', ids: ['lore:r1'], nodeIds: ['r1'] }],
                ['r2', { id: 'lore:r2', ids: ['lore:r2'] }], // written before `nodeIds` existed
            ];
            for (const [id] of rows) await save(lore, WS_A, id, secret(id));
            await settle(lore);
            for (const [id] of rows) assert.ok(vers(lore, WS_A, id).length >= 1);
            // The "crash": the purge row is durable, the version erase never ran.
            for (const [, payload] of rows) await recordHotWrite(wiring.store, { workspace: WS_A, operationKind: 'verbatim.purge', payload });
            await settle(lore);
            for (const [id] of rows) assert.deepEqual(vers(lore, WS_A, id), [], `${id} versions erased by replay`);
            // Replaying again is harmless.
            for (const [, payload] of rows) await recordHotWrite(wiring.store, { workspace: WS_A, operationKind: 'verbatim.purge', payload });
            await settle(lore);
            assert.ok(vers(lore, WS_A, 'keep').length >= 1, 'unrelated history intact');
        });
    } finally {
        await run.close();
    }
}

await suite('sqlite');
await suite('postgres');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
