#!/usr/bin/env tsx
/**
 * workspace-erase-lifecycle-unit.ts — lane f6b: honest workspace delete (library level).
 *
 * Fake clock, isolated homes, no OS keychain (keyring step disabled), no Dataplane. Covers:
 *   delete = hide at once + schedule; name reuse; restore (same id, --as, refusals); the erase tick (not before
 *   the window, receipt after, backoff after a failure, partial retried); erase-now; legacy records kept;
 *   alias keeps data live; crash recovery at every kill point; NEIGHBOUR workspaces byte-identical throughout.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace, loadWorkspaces, registerWorkspaceAlias, writeControl } from '../packages/lore/src/config/workspaces.js';
import { appendRestoredEvent, deletionLogPath, readDeletionLog, recordWorkspaceDeletion } from '../packages/lore/src/config/deletedWorkspaces.js';
import { deleteWorkspaceWithLifecycle, runErase, type LifecycleDeps } from '../packages/lore/src/engines/workspaceErase/lifecycle.js';
import { restoreWorkspace, reconcileDeletions, listDeletions } from '../packages/lore/src/engines/workspaceErase/restore.js';
import { eraseNow, runEraseTick, selectDueErasures } from '../packages/lore/src/engines/workspaceErase/tick.js';
import { holdWorkspaceDir, holdingPathFor } from '../packages/lore/src/engines/workspaceErase/localDir.js';
import type { WorkspaceEraser } from '../packages/lore/src/engines/workspaceErase/types.js';

let passed = 0; let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const homes: string[] = [];
const mkHome = (): string => { const h = fs.mkdtempSync(path.join(process.env['F6B_TMP'] ?? os.tmpdir(), 'lf-')); homes.push(h); loadWorkspaces(h); return h; };

/** Hash of every file name + byte below `dir` (the "byte-identical neighbour" proof). */
function treeHash(dir: string): string {
    const h = createHash('sha256');
    const walk = (d: string): void => {
        for (const n of fs.readdirSync(d).sort()) {
            const p = path.join(d, n); const st = fs.lstatSync(p);
            h.update(path.relative(dir, p) + (st.isDirectory() ? '/' : ':'));
            if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p));
        }
    };
    walk(dir);
    return h.digest('hex');
}
function seedData(entryPath: string, tag: string): void {
    fs.mkdirSync(path.join(entryPath, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(entryPath, '.lore', 'graph.db'), `rows-${tag}`.repeat(50));
    fs.writeFileSync(path.join(entryPath, 'shared.txt'), 'identical shared content');
}
const clock = { ms: T0 };
const base = (home: string, extra: Partial<LifecycleDeps> = {}): LifecycleDeps => ({
    home, now: () => new Date(clock.ms), env: {}, eraserFactory: { keyringEnabled: false },
    lock: { staleMs: 60_000, heartbeatMs: 5_000 }, ...extra,
});
const names = (h: string): string[] => loadWorkspaces(h).workspaces.map((w) => w.name);

console.log('workspace erase lifecycle (library)');
try {
    await test('delete hides the folder, removes the entry, records eraseAfter + holdingPath + entry; name is reusable without old data', async () => {
        clock.ms = T0; const h = mkHome(); const d = base(h);
        const a = createWorkspace('alpha', undefined, h); seedData(a.path, 'alpha');
        const nb = createWorkspace('alpha-2', undefined, h); seedData(nb.path, 'nb'); // similarly named neighbour
        const sh = createWorkspace('shares', undefined, h); seedData(sh.path, 'sh'); // shares content bytes (shared.txt)
        const nbHash = treeHash(nb.path); const shHash = treeHash(sh.path);
        const r = await deleteWorkspaceWithLifecycle('alpha', {}, d);
        assert.equal(r.status, 'scheduled');
        assert.equal(r.windowDays, 7);
        assert.equal(r.eraseAfter, new Date(T0 + 7 * DAY).toISOString());
        assert.ok(!fs.existsSync(a.path), 'old path must be gone from the live location');
        assert.ok(fs.existsSync(holdingPathFor(h, r.id)), 'held under .erase-hold-<id>');
        assert.ok(!names(h).includes('alpha'));
        const rec = readDeletionLog(h).byId.get(r.id)!.deletion!;
        assert.equal(rec.eraseAfter, r.eraseAfter); assert.equal(rec.holdingPath, holdingPathFor(h, r.id)); assert.equal(rec.entry?.name, 'alpha');
        const again = createWorkspace('alpha', undefined, h);
        assert.ok(!fs.existsSync(path.join(again.path, '.lore', 'graph.db')), 'a re-created workspace must not see the old data');
        assert.notEqual(again.id, r.id);
        assert.equal(treeHash(nb.path), nbHash); assert.equal(treeHash(sh.path), shHash);
    });

    await test('refuses like deleteWorkspace (unknown / active / bootstrap) without moving anything', async () => {
        const h = mkHome(); const d = base(h); const before = JSON.stringify(loadWorkspaces(h).workspaces);
        await assert.rejects(deleteWorkspaceWithLifecycle('nope', {}, d), /Unknown workspace/);
        await assert.rejects(deleteWorkspaceWithLifecycle('default', {}, d), /bootstrap|active/);
        assert.equal(readDeletionLog(h).byId.size, 0, 'no record for a refused delete');
        assert.equal(JSON.stringify(loadWorkspaces(h).workspaces), before);
    });

    await test('open handles that cannot be closed refuse the delete before anything moves', async () => {
        const h = mkHome(); const d = base(h, { handles: { graphRegistry: { closeWorkspace: async () => false } as never } });
        const a = createWorkspace('busy', undefined, h); seedData(a.path, 'busy');
        const before = treeHash(a.path);
        await assert.rejects(deleteWorkspaceWithLifecycle('busy', {}, d), /refusing to delete/);
        assert.ok(names(h).includes('busy')); assert.equal(treeHash(a.path), before);
        assert.equal(readDeletionLog(h).byId.size, 0, 'no record for a refused delete');
    });

    await test('restore within the window: same id, data back; refuses a taken name; --as works; refuses once erase started', async () => {
        clock.ms = T0; const h = mkHome(); const d = base(h);
        const a = createWorkspace('beta', undefined, h); seedData(a.path, 'beta'); const hash = treeHash(a.path);
        const r = await deleteWorkspaceWithLifecycle('beta', {}, d);
        createWorkspace('beta', undefined, h); // name now taken
        await assert.rejects(restoreWorkspace(r.id, {}, d), /--as/);
        const res = await restoreWorkspace(r.id, { as: 'beta-old' }, d);
        assert.equal(res.name, 'beta-old'); assert.equal(res.renamed, true);
        const e = loadWorkspaces(h).workspaces.find((w) => w.name === 'beta-old')!;
        assert.equal(e.id, r.id); assert.equal(treeHash(e.path), hash);
        assert.ok(!fs.existsSync(holdingPathFor(h, r.id)));
        await assert.rejects(restoreWorkspace(r.id, {}, d), /already restored/);
        // restored => never erased
        clock.ms = T0 + 30 * DAY; const tick = await runEraseTick(d);
        assert.equal(tick.outcomes.length, 0); assert.equal(treeHash(e.path), hash);
        // a second delete cycle then erase started => restore refused
        const r2 = await deleteWorkspaceWithLifecycle('beta-old', { eraseNow: true }, d);
        assert.equal(r2.id, r.id); assert.equal(r2.status, 'erased');
        await assert.rejects(restoreWorkspace(r.id, {}, d), /already|erase/);
    });

    await test('restore under the original name when it is free', async () => {
        clock.ms = T0; const h = mkHome(); const d = base(h);
        const a = createWorkspace('gamma', undefined, h); seedData(a.path, 'g'); const hash = treeHash(a.path);
        const r = await deleteWorkspaceWithLifecycle('gamma', {}, d);
        const res = await restoreWorkspace(r.id, {}, d);
        assert.equal(res.name, 'gamma'); assert.equal(res.path, a.path); assert.equal(treeHash(a.path), hash);
        const row = listDeletions(d).find((x) => x.id === r.id)!; assert.equal(row.state, 'restored');
    });

    await test('tick: nothing before the window; after it, erased + receipt complete + folder gone; neighbours byte-identical', async () => {
        clock.ms = T0; const h = mkHome(); const d = base(h);
        const a = createWorkspace('delta', undefined, h); seedData(a.path, 'd');
        const nb = createWorkspace('delta-neighbour', undefined, h); seedData(nb.path, 'n');
        const keep = createWorkspace('keeper', undefined, h); seedData(keep.path, 'k');
        const nbH = treeHash(nb.path); const kH = treeHash(keep.path);
        const r = await deleteWorkspaceWithLifecycle('delta', {}, d);
        clock.ms = T0 + 6 * DAY; assert.deepEqual(selectDueErasures(d), []);
        assert.equal((await runEraseTick(d)).outcomes.length, 0); assert.ok(fs.existsSync(holdingPathFor(h, r.id)));
        clock.ms = T0 + 7 * DAY + 1;
        const t = await runEraseTick(d);
        assert.equal(t.outcomes.length, 1); assert.equal(t.outcomes[0]!.outcome.kind, 'complete');
        assert.ok(!fs.existsSync(holdingPathFor(h, r.id)));
        const st = readDeletionLog(h).byId.get(r.id)!;
        assert.equal(st.completedErase?.status, 'complete');
        const local = st.completedErase!.stores.find((s) => s.store === 'local-dir')!;
        assert.equal(local.status, 'complete'); assert.ok((local.removed['files'] ?? 0) >= 2); assert.equal(local.remaining['files'], 0);
        assert.equal(treeHash(nb.path), nbH); assert.equal(treeHash(keep.path), kH);
        // idempotent: a second tick does nothing and does not double-count
        const t2 = await runEraseTick(d); assert.equal(t2.outcomes.length, 0);
        assert.equal(readDeletionLog(h).byId.get(r.id)!.attempts, 0);
        assert.equal(listDeletions(d).find((x) => x.id === r.id)!.state, 'erased');
    });

    await test('window 0 / eraseNow erases at once through the lock and writes the receipt', async () => {
        clock.ms = T0; const h = mkHome(); const d = base(h);
        const a = createWorkspace('epsilon', undefined, h); seedData(a.path, 'e');
        const nb = createWorkspace('epsilon-x', undefined, h); seedData(nb.path, 'x'); const nbH = treeHash(nb.path);
        const r = await deleteWorkspaceWithLifecycle('epsilon', { windowDays: 0 }, d);
        assert.equal(r.status, 'erased'); assert.ok(!fs.existsSync(holdingPathFor(h, r.id)));
        assert.equal(readDeletionLog(h).byId.get(r.id)!.completedErase?.status, 'complete');
        assert.equal(treeHash(nb.path), nbH);
        const b = createWorkspace('zeta', undefined, h); seedData(b.path, 'z');
        const r2 = await deleteWorkspaceWithLifecycle('zeta', { eraseNow: true }, d);
        assert.equal(r2.status, 'erased'); assert.ok(!fs.existsSync(b.path));
    });

    await test('eraseNow on a pending record skips the window; refuses restored / unknown', async () => {
        clock.ms = T0; const h = mkHome(); const d = base(h);
        const a = createWorkspace('eta', undefined, h); seedData(a.path, 'eta');
        const r = await deleteWorkspaceWithLifecycle('eta', {}, d);
        const out = await eraseNow(r.id, d); assert.equal(out.kind, 'complete');
        await assert.rejects(eraseNow(r.id, d), /already erased/);
        await assert.rejects(eraseNow('no-such-id', d), /no deleted workspace/);
    });

    await test('failed erase step: erase-failed recorded, backoff honoured, next due tick completes; nothing double-counted', async () => {
        clock.ms = T0; const h = mkHome(); let fail = true;
        const flaky: WorkspaceEraser = { store: 'postgres', async erase() { if (fail) throw new Error('db down password=hunter2'); return { store: 'postgres', status: 'complete', removed: { rows: 3 }, remaining: { rows: 0 } }; } };
        const d = base(h, { extraErasers: [flaky] });
        const a = createWorkspace('theta', undefined, h); seedData(a.path, 't'); const hash = treeHash(a.path);
        const r = await deleteWorkspaceWithLifecycle('theta', { windowDays: 1 }, d);
        clock.ms = T0 + DAY + 1;
        const t1 = await runEraseTick(d);
        assert.equal(t1.outcomes[0]!.outcome.kind, 'failed');
        const st1 = readDeletionLog(h).byId.get(r.id)!;
        assert.equal(st1.failedAttempts, 1); assert.equal(st1.attempts, 1);
        assert.ok(!/hunter2/.test(st1.lastFailure!.error), 'no secrets in the failure text');
        assert.equal(treeHash(holdingPathFor(h, r.id)), hash, 'local data untouched while an earlier store failed (rows before dir)');
        assert.equal((await runEraseTick(d)).outcomes.length, 0, 'inside the backoff nothing runs');
        fail = false; clock.ms += 16 * 60_000;
        const t2 = await runEraseTick(d);
        assert.equal(t2.outcomes[0]!.outcome.kind, 'complete');
        const st2 = readDeletionLog(h).byId.get(r.id)!;
        assert.equal(st2.completedErase?.status, 'complete');
        assert.equal(st2.completedErase!.stores.filter((s) => s.store === 'postgres').length, 1);
        assert.ok(!fs.existsSync(holdingPathFor(h, r.id)));
    });

    await test('mid-erase crash (removal stops half way) -> partial receipt, next tick finishes the same folder', async () => {
        clock.ms = T0; const h = mkHome(); let crash = true;
        const rm = (p: string): void => { if (crash) { fs.rmSync(path.join(p, '.lore'), { recursive: true, force: true }); throw new Error('simulated crash'); } fs.rmSync(p, { recursive: true, force: true }); };
        const d = base(h, { eraserFactory: { keyringEnabled: false, rm } });
        const a = createWorkspace('iota', undefined, h); seedData(a.path, 'i');
        const nb = createWorkspace('iota-nb', undefined, h); seedData(nb.path, 'n'); const nbH = treeHash(nb.path);
        const r = await deleteWorkspaceWithLifecycle('iota', { windowDays: 0 }, d);
        assert.equal(r.status, 'erasing');
        const s1 = readDeletionLog(h).byId.get(r.id)!;
        assert.equal(s1.lastErased?.status, 'partial'); assert.equal(s1.completedErase, undefined);
        assert.ok(fs.existsSync(holdingPathFor(h, r.id)));
        crash = false; clock.ms += 16 * 60_000;
        const t = await runEraseTick(d);
        assert.equal(t.outcomes[0]!.outcome.kind, 'complete');
        assert.ok(!fs.existsSync(holdingPathFor(h, r.id)));
        assert.equal(treeHash(nb.path), nbH);
    });

    await test('crash after rename, before the record: reconcile (after the grace) puts the folder back', async () => {
        clock.ms = Date.now(); const h = mkHome(); const d = base(h);
        const a = createWorkspace('kappa', undefined, h); seedData(a.path, 'k'); const hash = treeHash(a.path);
        holdWorkspaceDir(a, a.id!, h); // killed right here: no record, entry still registered
        assert.ok(!fs.existsSync(a.path));
        assert.deepEqual(reconcileDeletions(d), [], 'inside the grace nothing moves');
        const acts = reconcileDeletions({ ...d, now: () => new Date(Date.now() + 3600_000) });
        assert.equal(acts[0]?.action, 'rolled-back-hold'); assert.equal(treeHash(a.path), hash);
    });

    await test('crash after the record, before the registry removal: reconcile finishes the delete; tick then erases once', async () => {
        clock.ms = T0; const h = mkHome(); const d = base(h);
        const a = createWorkspace('lambda', undefined, h); seedData(a.path, 'l');
        const nb = createWorkspace('lambda-nb', undefined, h); seedData(nb.path, 'n'); const nbH = treeHash(nb.path);
        const hold = holdWorkspaceDir(a, a.id!, h);
        const remaining = loadWorkspaces(h).workspaces.filter((w) => w.name !== 'lambda');
        recordWorkspaceDeletion(a, remaining, h, new Date(T0), { eraseAfter: new Date(T0).toISOString(), windowDays: 0, holdingPath: hold.holdingPath }); // killed before writeControl
        assert.ok(names(h).includes('lambda'));
        assert.deepEqual(selectDueErasures(d), [], 'a live id is never due');
        assert.equal((await runErase(a.id!, d)).kind, 'skipped');
        clock.ms = T0 + 3600_000;
        const t = await runEraseTick(d);
        assert.equal(t.reconciled[0]?.action, 'finished-delete');
        assert.ok(!names(h).includes('lambda'));
        assert.equal(t.outcomes.length, 1, 'the same tick may erase it only once'); // window 0 => due at once
        assert.equal(readDeletionLog(h).byId.get(a.id!)!.completedErase?.status, 'complete');
        assert.equal(treeHash(nb.path), nbH);
        assert.equal((await runEraseTick(d)).outcomes.length, 0);
    });

    await test('registry write failure after the record: the stale record is marked, never erased', async () => {
        clock.ms = T0; const h = mkHome(); const d = base(h);
        const a = createWorkspace('mu', undefined, h); seedData(a.path, 'mu'); const hash = treeHash(a.path);
        recordWorkspaceDeletion(a, loadWorkspaces(h).workspaces.filter((w) => w.name !== 'mu'), h, new Date(T0), { eraseAfter: new Date(T0).toISOString(), windowDays: 0, holdingPath: holdingPathFor(h, a.id!) });
        clock.ms = T0 + 3600_000;
        const t = await runEraseTick(d);
        assert.equal(t.reconciled[0]?.action, 'marked-stale'); assert.equal(t.outcomes.length, 0);
        assert.equal(treeHash(a.path), hash); assert.ok(names(h).includes('mu'));
    });

    await test('interrupted restore (restored event written, folder still held) is finished by reconcile', async () => {
        clock.ms = T0; const h = mkHome(); const d = base(h);
        const a = createWorkspace('nu', undefined, h); seedData(a.path, 'nu'); const hash = treeHash(a.path);
        const r = await deleteWorkspaceWithLifecycle('nu', {}, d);
        appendRestoredEvent({ id: r.id, name: 'nu', path: a.path, at: new Date(T0).toISOString() }, h); // killed right after
        const acts = reconcileDeletions(d);
        assert.equal(acts[0]?.action, 'finished-restore');
        assert.equal(loadWorkspaces(h).workspaces.find((w) => w.name === 'nu')!.id, r.id); assert.equal(treeHash(a.path), hash);
        clock.ms = T0 + 30 * DAY; assert.equal((await runEraseTick(d)).outcomes.length, 0);
    });

    await test('an alias that keeps the data live: entry removed, nothing moved, nothing erased', async () => {
        clock.ms = T0; const h = mkHome(); const d = base(h);
        const a = createWorkspace('omega', undefined, h); seedData(a.path, 'o'); const hash = treeHash(a.path);
        registerWorkspaceAlias('omega-view', a.path, { }, h);
        const r = await deleteWorkspaceWithLifecycle('omega', {}, d);
        assert.equal(r.status, 'not-scheduled'); assert.equal(treeHash(a.path), hash);
        assert.equal(readDeletionLog(h).byId.size, 0);
    });

    await test('legacy record (no eraseAfter) is listed as kept, never auto-erased, and erase-now removes it', async () => {
        clock.ms = T0; const h = mkHome(); const d = base(h);
        const a = createWorkspace('legacy', undefined, h); seedData(a.path, 'lg');
        recordWorkspaceDeletion(a, loadWorkspaces(h).workspaces.filter((w) => w.name !== 'legacy'), h, new Date(T0 - 100 * DAY));
        const f = loadWorkspaces(h); f.workspaces = f.workspaces.filter((w) => w.name !== 'legacy'); writeControl(f, h);
        clock.ms = T0 + 400 * DAY;
        assert.deepEqual(selectDueErasures(d), []); assert.equal((await runEraseTick(d)).outcomes.length, 0); assert.ok(fs.existsSync(a.path));
        const row = listDeletions(d).find((x) => x.id === a.id)!; assert.equal(row.state, 'kept-legacy'); assert.match(row.summary, /kept — legacy delete/);
        await assert.rejects(restoreWorkspace(a.id!, {}, d), /legacy/);
        const out = await eraseNow(a.id!, d); assert.equal(out.kind, 'complete'); assert.ok(!fs.existsSync(a.path));
    });

    await test('local-dir never erases when a live entry has the id or the folder (guard), and never follows names', async () => {
        clock.ms = T0; const h = mkHome(); const d = base(h);
        const a = createWorkspace('pi', undefined, h); seedData(a.path, 'pi');
        const r = await deleteWorkspaceWithLifecycle('pi', {}, d);
        // someone hand-edits the registry to put the same id back
        const f = loadWorkspaces(h); const ghost = { ...a, name: 'pi-ghost', path: path.join(h, 'workspaces', 'pi-ghost') }; f.workspaces.push(ghost); writeControl(f, h);
        assert.equal((await eraseNow(r.id, d)).kind, 'skipped');
        assert.ok(fs.existsSync(holdingPathFor(h, r.id)), 'held data kept while the id is live');
    });

    await test('an unverifiable store: receipt is partial (never complete), later stores still erased, record stays due and retried', async () => {
        clock.ms = T0; const h = mkHome();
        const unv: WorkspaceEraser = { store: 'postgres', async erase() { return { store: 'postgres', status: 'unverifiable', removed: {}, remaining: {}, detail: 'keyed by name' }; } };
        const d = base(h, { extraErasers: [unv] });
        const a = createWorkspace('unv', undefined, h); seedData(a.path, 'u');
        const nb = createWorkspace('unv-nb', undefined, h); seedData(nb.path, 'n'); const nbH = treeHash(nb.path);
        const r = await deleteWorkspaceWithLifecycle('unv', { windowDays: 0 }, d);
        assert.equal(r.status, 'erasing');
        const st = readDeletionLog(h).byId.get(r.id)!;
        assert.equal(st.lastErased?.status, 'partial'); assert.equal(st.completedErase, undefined);
        assert.ok(!fs.existsSync(holdingPathFor(h, r.id)), 'the local dir was still erased');
        assert.ok(st.lastErased!.stores.some((x) => x.store === 'local-dir' && x.status === 'complete'));
        assert.equal(listDeletions(d).find((x) => x.id === r.id)!.state, 'partial');
        assert.match(listDeletions(d).find((x) => x.id === r.id)!.summary, /could not verify: postgres/);
        clock.ms += 16 * 60_000;
        const t = await runEraseTick(d);
        assert.equal(t.outcomes.length, 1, 'still due: retried');
        assert.equal(treeHash(nb.path), nbH);
    });

    await test('torn and unknown log lines are skipped; log stays v1', async () => {
        const h = mkHome(); const d = base(h);
        const a = createWorkspace('rho', undefined, h); seedData(a.path, 'r');
        const r = await deleteWorkspaceWithLifecycle('rho', {}, d);
        fs.appendFileSync(deletionLogPath(h), '{"v":1,"event":"mystery","id":"x"}\n{"v":1,"event":"erased","id":"' );
        const st = readDeletionLog(h).byId.get(r.id)!; assert.ok(st.deletion); assert.ok(readDeletionLog(h).skippedLines >= 1);
        const out = await eraseNow(r.id, d); assert.equal(out.kind, 'complete');
        for (const line of fs.readFileSync(deletionLogPath(h), 'utf8').split('\n').filter(Boolean)) { try { assert.equal((JSON.parse(line) as { v: number }).v, 1); } catch { /* torn line */ } }
    });
} finally {
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
