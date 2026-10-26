#!/usr/bin/env tsx
/**
 * workspace-erase-needs-operator-unit.ts — terminal `needs-operator` state for erases that can never resolve by retrying.
 *
 * Fake clock, isolated homes, fake erasers. Covers: N consecutive all-unverifiable attempts -> needs-operator (tick stops,
 * listing shows reason per store, receipt kept); a `partial` step or a failure never counts and resets the run; erase-now
 * retries a needs-operator record with the counter reset; env limit parsing (1-100, default 5); records written without the
 * counter load as 0.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import { deletionLogPath, readDeletionLog } from '../packages/lore/src/config/deletedWorkspaces.js';
import { deleteWorkspaceWithLifecycle, type LifecycleDeps } from '../packages/lore/src/engines/workspaceErase/lifecycle.js';
import { listDeletions } from '../packages/lore/src/engines/workspaceErase/restore.js';
import { eraseNow, runEraseTick, selectDueErasures } from '../packages/lore/src/engines/workspaceErase/tick.js';
import { DEFAULT_MAX_UNVERIFIABLE_ATTEMPTS, readMaxUnverifiableAttempts } from '../packages/lore/src/engines/workspaceErase/config.js';
import type { EraseStatus, WorkspaceEraser } from '../packages/lore/src/engines/workspaceErase/types.js';

let passed = 0; let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const homes: string[] = [];
const mkHome = (): string => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'lno-')); homes.push(h); loadWorkspaces(h); return h; };
const clock = { ms: T0 };
const WIN = DAY * 400; // jump past any backoff (24 h cap) between attempts

/** A fake store whose status is controlled by the test. */
function fake(store: string, status: () => EraseStatus, detail?: string): WorkspaceEraser {
    return { store, async erase() { const s = status(); return { store, status: s, removed: {}, remaining: s === 'complete' || s === 'not-applicable' ? { rows: 0 } : { rows: 1 }, ...(detail ? { detail } : {}) }; } };
}
const mk = (home: string, erasers: WorkspaceEraser[], env: Record<string, string> = {}): LifecycleDeps => ({
    home, now: () => new Date(clock.ms), env, erasers, lock: { staleMs: 60_000, heartbeatMs: 5_000 },
});
async function deleted(h: string, d: LifecycleDeps, name: string): Promise<string> {
    createWorkspace(name, undefined, h);
    return (await deleteWorkspaceWithLifecycle(name, { windowDays: 1 }, d)).id;
}
const tick = async (d: LifecycleDeps): Promise<string> => { clock.ms += WIN; const t = await runEraseTick(d); return t.outcomes[0]?.outcome.kind ?? 'none'; };

console.log('workspace erase needs-operator');
try {
    await test('env limit: default 5, accepts 1-100, anything else falls back to the default', () => {
        const r = (v?: string): number => readMaxUnverifiableAttempts(v === undefined ? {} : { LORE_WORKSPACE_ERASE_MAX_UNVERIFIABLE_ATTEMPTS: v });
        assert.equal(r(), DEFAULT_MAX_UNVERIFIABLE_ATTEMPTS); assert.equal(DEFAULT_MAX_UNVERIFIABLE_ATTEMPTS, 5);
        assert.equal(r('1'), 1); assert.equal(r('100'), 100); assert.equal(r(' 7 '), 7);
        for (const bad of ['0', '101', '-3', 'abc', '2.5', '']) assert.equal(r(bad), 5, bad);
    });

    await test('N consecutive all-unverifiable attempts -> needs-operator; tick stops retrying; listing shows reason per store', async () => {
        clock.ms = T0; const h = mkHome();
        const d = mk(h, [fake('postgres', () => 'unverifiable', 'rows keyed by name'), fake('blobs-fs', () => 'complete')], { LORE_WORKSPACE_ERASE_MAX_UNVERIFIABLE_ATTEMPTS: '3' });
        const id = await deleted(h, d, 'alpha');
        assert.equal(await tick(d), 'partial'); assert.equal(await tick(d), 'partial');
        let st = readDeletionLog(h).byId.get(id)!;
        assert.equal(st.unverifiableStreak, 2); assert.equal(st.needsOperator, undefined);
        assert.equal(await tick(d), 'needs-operator');
        st = readDeletionLog(h).byId.get(id)!;
        assert.equal(st.needsOperator?.status, 'needs-operator'); assert.equal(st.needsOperator?.unverifiableStreak, 3);
        assert.equal(st.completedErase, undefined);
        assert.deepEqual(selectDueErasures({ ...d, now: () => new Date(clock.ms + 100 * WIN) }), [], 'never due again');
        assert.equal(await tick(d), 'none');
        const row = listDeletions(d).find((x) => x.id === id)!;
        assert.equal(row.state, 'needs-operator'); assert.equal(row.unverifiableAttempts, 3); assert.equal(row.restorable, false);
        assert.deepEqual(row.reasons, [{ store: 'postgres', status: 'unverifiable', reason: 'rows keyed by name' }]);
        assert.ok(row.summary.includes('erase-now') && row.summary.includes('postgres: rows keyed by name'));
        assert.equal(row.receipt?.length, 2, 'receipt kept');
    });

    await test('a partial step never counts and resets the run; a failure resets it too', async () => {
        clock.ms = T0; const h = mkHome(); let pg: EraseStatus = 'unverifiable'; let boom = false;
        const flaky: WorkspaceEraser = { store: 'x', async erase() { if (boom) throw new Error('down'); return { store: 'x', status: 'complete', removed: {}, remaining: { rows: 0 } }; } };
        const d = mk(h, [flaky, fake('postgres', () => pg)], { LORE_WORKSPACE_ERASE_MAX_UNVERIFIABLE_ATTEMPTS: '3' });
        const id = await deleted(h, d, 'beta');
        await tick(d); await tick(d);
        assert.equal(readDeletionLog(h).byId.get(id)!.unverifiableStreak, 2);
        pg = 'partial';
        assert.equal(await tick(d), 'partial');
        assert.equal(readDeletionLog(h).byId.get(id)!.unverifiableStreak, 0, 'partial resets');
        pg = 'unverifiable'; await tick(d); await tick(d);
        assert.equal(readDeletionLog(h).byId.get(id)!.unverifiableStreak, 2);
        boom = true; assert.equal(await tick(d), 'failed');
        assert.equal(readDeletionLog(h).byId.get(id)!.unverifiableStreak, 0, 'failure resets');
        boom = false; await tick(d); await tick(d);
        assert.equal(readDeletionLog(h).byId.get(id)!.needsOperator, undefined, 'still only 2 in a row');
        assert.equal(await tick(d), 'needs-operator');
    });

    await test('erase-now retries a needs-operator record with the counter reset; success completes it', async () => {
        clock.ms = T0; const h = mkHome(); let pg: EraseStatus = 'unverifiable';
        const d = mk(h, [fake('postgres', () => pg, 'cannot tell')], { LORE_WORKSPACE_ERASE_MAX_UNVERIFIABLE_ATTEMPTS: '2' });
        const id = await deleted(h, d, 'gamma');
        await tick(d); assert.equal(await tick(d), 'needs-operator');
        // still unverifiable: manual retry runs, counter restarts at 1, so the record goes back to retrying
        const again = await eraseNow(id, d);
        assert.equal(again.kind, 'partial');
        let st = readDeletionLog(h).byId.get(id)!;
        assert.equal(st.unverifiableStreak, 1); assert.equal(st.needsOperator, undefined);
        assert.equal(listDeletions(d).find((x) => x.id === id)!.state, 'partial');
        assert.equal(await tick(d), 'needs-operator', 'one more attempt reaches the limit again');
        pg = 'complete';
        assert.equal((await eraseNow(id, d)).kind, 'complete');
        st = readDeletionLog(h).byId.get(id)!;
        assert.equal(st.completedErase?.status, 'complete'); assert.equal(st.needsOperator, undefined);
    });

    await test('limit 1: first all-unverifiable attempt is terminal; a record with nothing unverifiable is unaffected', async () => {
        clock.ms = T0; const h = mkHome();
        const d = mk(h, [fake('postgres', () => 'unverifiable')], { LORE_WORKSPACE_ERASE_MAX_UNVERIFIABLE_ATTEMPTS: '1' });
        assert.equal(await tick(await (async () => { await deleted(h, d, 'delta'); return d; })()), 'needs-operator');
        const h2 = mkHome(); const d2 = mk(h2, [fake('postgres', () => 'complete')], { LORE_WORKSPACE_ERASE_MAX_UNVERIFIABLE_ATTEMPTS: '1' });
        await deleted(h2, d2, 'eps'); assert.equal(await tick(d2), 'complete');
    });

    await test('records and receipts written before the counter existed load as 0', async () => {
        clock.ms = T0; const h = mkHome(); let pg: EraseStatus = 'partial';
        const d = mk(h, [fake('postgres', () => pg)], { LORE_WORKSPACE_ERASE_MAX_UNVERIFIABLE_ATTEMPTS: '2' });
        const id = await deleted(h, d, 'zeta');
        await tick(d); // old-style partial receipt (no streak field written when 0)
        const lines = fs.readFileSync(deletionLogPath(h), 'utf8');
        assert.ok(!lines.includes('unverifiableStreak'), 'no field when the count is 0');
        let st = readDeletionLog(h).byId.get(id)!;
        assert.equal(st.unverifiableStreak, 0); assert.equal(st.attempts, 1); assert.equal(st.needsOperator, undefined);
        pg = 'unverifiable'; await tick(d);
        assert.equal(readDeletionLog(h).byId.get(id)!.unverifiableStreak, 1, 'counts from 0, not from the old attempts');
        st = readDeletionLog(h).byId.get(id)!; assert.equal(st.attempts, 2);
    });
} finally {
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
