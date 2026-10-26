#!/usr/bin/env tsx
/**
 * workspace-erase-embedded-e2e.ts — lane f6b wire-up proof, EMBEDDED host (real createLore(), real SQLite).
 *
 * The scheduled erase is performed by the tick that createLore() itself started (mcp/server.ts wiring), NOT by a
 * direct runErase call. Only the clock (fake `now`), the tick cadence (200 ms / 300 ms) and the OS keychain
 * (off) are test seams. Flow: write data -> delete (hidden, unreachable, name reusable without old data) ->
 * restore (same id, data back) -> delete again -> clock past the window -> the host's tick erases it ->
 * receipt complete, folder gone -> neighbours (similar name; same content) unchanged. Then crash-after-record
 * recovery by the host tick, and dispose() stops the tick (no leaked interval).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env['LORE_HOME']; delete process.env['LORE_GRAPH_PATH'];
process.env['LORE_MODEL_SERVER'] = '0';

const live = new Map<unknown, number>();
const rSI = globalThis.setInterval, rCI = globalThis.clearInterval;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).setInterval = (fn: never, ms?: number, ...a: never[]) => { const h = rSI(fn, ms as never, ...a); live.set(h, ms ?? 0); return h; };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).clearInterval = (h: unknown) => { live.delete(h); return rCI(h as never); };

const { createLore } = await import('../packages/lore/src/index.js');
const { createWorkspace, loadWorkspaces } = await import('../packages/lore/src/config/workspaces.js');
const { readDeletionLog, recordWorkspaceDeletion } = await import('../packages/lore/src/config/deletedWorkspaces.js');
const { deleteWorkspaceWithLifecycle, setLifecycleTestDefaults } = await import('../packages/lore/src/engines/workspaceErase/lifecycle.js');
const { restoreWorkspace } = await import('../packages/lore/src/engines/workspaceErase/restore.js');
const { holdWorkspaceDir, holdingPathFor } = await import('../packages/lore/src/engines/workspaceErase/localDir.js');

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n       ${((e as Error).stack ?? String(e)).split('\n').slice(0, 5).join('\n       ')}`); }
}
const DAY = 86_400_000;
const clock = { ms: Date.parse('2026-11-01T00:00:00.000Z') };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 15_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await sleep(100); }
    return pred();
}

const home = fs.mkdtempSync(path.join(process.env['F6B_TMP'] ?? os.tmpdir(), 'lf-emb-'));
fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({ active: 'default', workspaces: [{ name: 'default', path: home, createdAt: '2026-06-15T00:00:00.000Z', graphEngine: 'sqlite' }] }, null, 2));

setLifecycleTestDefaults({ now: () => new Date(clock.ms), eraserFactory: { keyringEnabled: false }, lock: { staleMs: 60_000, heartbeatMs: 5_000 }, tick: { firstRunMs: 200, intervalMs: 300 } });
const intervalsBefore = new Set(live.keys());
const lore = await createLore({ deploymentMode: 'embedded', dataDir: home });
const registry = lore._daemon.getGraphRegistry()!;
const handles = { graphRegistry: registry, verbatimResolver: lore._daemon.getVerbatimResolver() as never };
const dels = (): ReturnType<typeof readDeletionLog> => readDeletionLog(home);
const names = (): string[] => loadWorkspaces(home).workspaces.map((w) => w.name);

async function put(ws: string, id: string, content: string): Promise<void> {
    const r = await lore.nodeUpsert({ id, workspace: ws, ecosystem: '*', nodeData: { id, type: 'note', label: id, content, tags: 't', project: ws, ecosystem: '*', metadata: '{}' }, skipEmbed: true });
    assert.ok(r.ok, `nodeUpsert ${ws}/${id}: ${JSON.stringify(r)}`);
}
/** A delete refuses while the vector store is pinned / embed work is pending (by design); drain the outbox, then retry. */
async function drained(): Promise<void> {
    const store = lore._daemon.outboxWiring.store;
    const end = Date.now() + 15_000;
    while (Date.now() < end) { if ((await store.aggregateStats!()).depth === 0) return; await sleep(150); }
}
async function del(name: string, opts: { eraseNow?: boolean } = {}): Promise<Awaited<ReturnType<typeof deleteWorkspaceWithLifecycle>>> {
    await drained();
    for (let i = 0; ; i++) {
        try { return await deleteWorkspaceWithLifecycle(name, opts, { home, handles }); }
        catch (e) { if (i >= 20 || !/still in use/.test((e as Error).message)) throw e; await sleep(300); }
    }
}
async function get(ws: string, id: string): Promise<unknown> { return (await (await registry.getGraphHandle(ws)).getNode(id)); }

try {
    const SHARED = 'identical content shared by two workspaces';
    createWorkspace('doomed', undefined, home); createWorkspace('doomed-2', undefined, home); createWorkspace('sharer', undefined, home);
    await put('doomed', 'n-doomed', 'only in doomed'); await put('doomed', 'n-shared', SHARED);
    await put('doomed-2', 'n-nb', 'neighbour data'); await put('doomed-2', 'n-shared', SHARED);
    await put('sharer', 'n-shared', SHARED);
    const doomed = loadWorkspaces(home).workspaces.find((w) => w.name === 'doomed')!;
    const ID1 = doomed.id!;
    const nbBefore = JSON.stringify([await get('doomed-2', 'n-nb'), await get('doomed-2', 'n-shared'), await get('sharer', 'n-shared')]);
    assert.ok(await get('doomed', 'n-doomed'));

    await check('delete: scheduled, folder hidden under .erase-hold-<id>, workspace gone and unreachable', async () => {
        const r = await del('doomed');
        assert.equal(r.status, 'scheduled'); assert.equal(r.windowDays, 7); assert.equal(r.id, ID1);
        assert.ok(!fs.existsSync(doomed.path)); assert.ok(fs.existsSync(holdingPathFor(home, ID1)));
        assert.ok(!names().includes('doomed'));
        await assert.rejects(registry.getGraphHandle('doomed'), 'a deleted workspace must not open');
        const up = await lore.nodeUpsert({ id: 'x', workspace: 'doomed', ecosystem: '*', nodeData: { id: 'x', type: 'note', label: 'x', content: 'y', tags: '', project: 'doomed', ecosystem: '*', metadata: '{}' }, skipEmbed: true }).catch((e) => ({ ok: false, e }));
        assert.ok(!(up as { ok: boolean }).ok, 'writes to a deleted workspace must fail, not resurrect it');
        assert.ok(!fs.existsSync(doomed.path), 'the failed write must not recreate the old folder');
    });

    await check('same name is reusable and starts EMPTY (old data is not picked up); neighbours unchanged', async () => {
        // The failed write above is audited under the name "doomed". If the new workspace were created in that same
        // millisecond, the audit step could not tell which "doomed" the line belongs to and would (correctly) leave it
        // as ambiguous, turning both erases partial. Step past that millisecond.
        await sleep(2);
        const again = createWorkspace('doomed', undefined, home);
        assert.notEqual(again.id, ID1);
        assert.equal(await get('doomed', 'n-doomed'), null); assert.equal(await get('doomed', 'n-shared'), null);
        assert.equal(JSON.stringify([await get('doomed-2', 'n-nb'), await get('doomed-2', 'n-shared'), await get('sharer', 'n-shared')]), nbBefore);
        // restore must refuse while the name is taken
        await assert.rejects(restoreWorkspace(ID1, {}, { home }), /--as/);
        // remove the new one at once (erase now) so the old name is free again
        const r2 = await del('doomed', { eraseNow: true });
        assert.equal(r2.status, 'erased'); assert.notEqual(r2.id, ID1);
        assert.ok(!fs.existsSync(again.path));
        assert.ok(fs.existsSync(holdingPathFor(home, ID1)), 'erasing the NEW same-named workspace must not touch the held old one');
    });

    await check('restore within the window: same id, data back, readable through the host', async () => {
        const res = await restoreWorkspace(ID1, {}, { home });
        assert.equal(res.name, 'doomed');
        assert.equal(loadWorkspaces(home).workspaces.find((w) => w.name === 'doomed')!.id, ID1);
        assert.ok(await get('doomed', 'n-doomed'), 'restored data is back'); assert.ok(await get('doomed', 'n-shared'));
        assert.ok(!fs.existsSync(holdingPathFor(home, ID1)));
        assert.equal(dels().byId.get(ID1)?.restored !== undefined && dels().byId.get(ID1)?.restored !== null, true);
    });

    await check('delete again; before the window the host tick leaves it; after the window the HOST tick erases it', async () => {
        clock.ms += 1000;
        const r = await del('doomed');
        assert.equal(r.status, 'scheduled');
        await sleep(1200); // several host ticks
        assert.ok(fs.existsSync(holdingPathFor(home, ID1)), 'not erased inside the window');
        assert.equal(dels().byId.get(ID1)?.completedErase ?? null, null);
        clock.ms += 8 * DAY;
        const done = await until(() => !!dels().byId.get(ID1)?.completedErase);
        assert.ok(done, 'the embedded host tick must erase the workspace on its own');
        const st = dels().byId.get(ID1)!;
        assert.equal(st.completedErase!.status, 'complete');
        assert.ok(!fs.existsSync(holdingPathFor(home, ID1)), 'folder gone');
        assert.ok(!fs.existsSync(doomed.path));
        const stores = (st.completedErase as unknown as { stores: Array<{ store: string; status: string }> }).stores;
        assert.ok(stores.some((s) => s.store === 'local-dir' && s.status === 'complete'), JSON.stringify(stores));
        await assert.rejects(restoreWorkspace(ID1, {}, { home }), /erase|already/);
    });

    await check('neighbours (similar name; same content) are unchanged after every step', async () => {
        assert.equal(JSON.stringify([await get('doomed-2', 'n-nb'), await get('doomed-2', 'n-shared'), await get('sharer', 'n-shared')]), nbBefore);
        for (const n of ['doomed-2', 'sharer', 'default']) assert.ok(names().includes(n));
        for (const n of ['doomed-2', 'sharer']) assert.ok(fs.existsSync(loadWorkspaces(home).workspaces.find((w) => w.name === n)!.path));
    });

    await check('crash after the record, before the registry removal: the host tick finishes the delete and erases once', async () => {
        const w = createWorkspace('crashy', undefined, home); await put('crashy', 'c1', 'crashy data');
        const entry = loadWorkspaces(home).workspaces.find((x) => x.name === 'crashy')!;
        await drained(); // a real delete refuses while embed work is pending; the simulated kill happens after that gate
        assert.equal(await registry.closeWorkspace('crashy'), true);
        const hold = holdWorkspaceDir(entry, entry.id!, home);
        const remaining = loadWorkspaces(home).workspaces.filter((x) => x.name !== 'crashy');
        recordWorkspaceDeletion(entry, remaining, home, new Date(clock.ms), { eraseAfter: new Date(clock.ms).toISOString(), windowDays: 0, holdingPath: hold.holdingPath }); // killed before writeControl
        assert.ok(names().includes('crashy')); assert.ok(!fs.existsSync(w.path));
        clock.ms += 3600_000; // past the reconcile grace
        assert.ok(await until(() => !!dels().byId.get(entry.id!)?.completedErase), 'host tick must finish the half-done delete and erase it');
        assert.ok(!names().includes('crashy')); assert.ok(!fs.existsSync(holdingPathFor(home, entry.id!)));
        assert.equal(dels().byId.get(entry.id!)!.completedErase!.status, 'complete');
        assert.equal(JSON.stringify([await get('doomed-2', 'n-nb'), await get('doomed-2', 'n-shared'), await get('sharer', 'n-shared')]), nbBefore);
    });

    await check('dispose() stops the erase tick: no net new interval timers remain', async () => {
        const during = [...live.keys()].filter((h) => !intervalsBefore.has(h)).length;
        assert.ok(during >= 1, 'host registered interval timers');
        await lore.dispose('f6b-embedded-e2e');
        const left = [...live.keys()].filter((h) => !intervalsBefore.has(h)).length;
        assert.equal(left, 0, `leaked interval timers after dispose: ${left}`);
        const logSize = fs.statSync(path.join(home, 'workspace-deletions.jsonl')).size;
        await sleep(900); // ticks would fire every 300 ms if the tick were still alive; nothing is due, so also prove no lock file lingers
        assert.equal(fs.statSync(path.join(home, 'workspace-deletions.jsonl')).size, logSize);
        assert.ok(!fs.existsSync(path.join(home, 'workspace-erase.lock')), 'no lingering lock');
    });
} finally {
    setLifecycleTestDefaults(null);
    try { await lore.dispose('f6b-final'); } catch { /* already disposed */ }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
