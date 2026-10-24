#!/usr/bin/env tsx
/**
 * verbatim-promotion-lock-eventloop-unit.ts - 3.35.3 review finding F4.
 *
 * `busy_timeout` is a synchronous sleep inside sqlite3_step: with the usual 5000 ms, a foreign process
 * holding the SQLite write lock froze the WHOLE Node process (timers, HTTP, MCP) in 5 s slices while the
 * promotion's final `BEGIN EXCLUSIVE` waited. Measured before the fix: 14.5 s promotion, event-loop stalls
 * of 5168 ms and 5191 ms.
 *
 * Real two-process test: a child process takes `BEGIN IMMEDIATE` on verbatim.sqlite and holds it. The
 * promotion must (1) keep the event loop responsive (max stall <= 200 ms, sampled every 10 ms), (2) commit
 * once the holder lets go, and (3) when the holder outlives the lock-wait budget, abort cleanly with a
 * cooldown instead of hanging. runWithoutBlocking restores busy_timeout in a `finally`.
 *
 * Run: npx tsx test/verbatim-promotion-lock-eventloop-unit.ts
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { promoteWorkspace } from '../packages/lore/src/engines/verbatimPromotion.js';
import { promotionTestHooks, runWithoutBlocking } from '../packages/lore/src/engines/verbatimPromotionGate.js';
import { verbatimSqlitePath, stagingDirPath, readPromotionState, readPromotionCooldown, clearPromotionCooldown } from '../packages/lore/src/engines/verbatimPromotionState.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const DIM = 16;
class Det implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'lock-det'; readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private vec(text: string): number[] { const v = new Array(DIM).fill(0); for (let i = 0; i < text.length; i++) v[i % DIM] += text.charCodeAt(i) / 128; const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map((x) => x / n); }
    async embed(t: string) { return this.vec(t); } async embedQuery(t: string) { return this.vec(t); } async embedDocument(t: string) { return this.vec(t); }
}
const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-lock-')); dirs.push(d); return d; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sqlitePkg = createRequire(import.meta.url).resolve('better-sqlite3');

async function seed(ws: string, n: number): Promise<void> {
    const s = new SqliteVerbatimStore(ws, new Det());
    await s.initialize();
    for (let i = 0; i < n; i++) await s.store({ id: `d${i}`, text: `document ${i} alpha beta`, metadata: {} });
    await s.close();
}

/** A separate OS process that takes the write lock and holds it for `holdMs`. Resolves once it HOLDS the lock. */
const HOLDER = `
const Database = require(process.argv[1]);
const db = new Database(process.argv[2]);
db.pragma('busy_timeout=1000');
db.exec('BEGIN IMMEDIATE');
console.log('locked');
setTimeout(() => { db.exec('ROLLBACK'); db.close(); process.exit(0); }, Number(process.argv[3]));
`;
function startHolder(file: string, holdMs: number): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', HOLDER, sqlitePkg, file, String(holdMs)], { stdio: ['ignore', 'pipe', 'inherit'] });
        const t = setTimeout(() => { child.kill(); reject(new Error('holder did not take the lock in time')); }, 15_000);
        child.stdout!.on('data', (d) => { if (String(d).includes('locked')) { clearTimeout(t); resolve(child); } });
        child.on('error', reject);
    });
}
const exited = (c: ChildProcess): Promise<void> => new Promise((r) => { if (c.exitCode !== null) r(); else c.on('exit', () => r()); });

/** Samples event-loop delay every 10 ms. */
function monitor(): { stop: () => number } {
    let last = Date.now(), max = 0;
    const t = setInterval(() => { const now = Date.now(); max = Math.max(max, now - last - 10); last = now; }, 10);
    return { stop: () => { clearInterval(t); return max; } };
}

const savedBudget = process.env.LORE_PROMOTION_LOCK_WAIT_MS;
const savedCool = process.env.LORE_PROMOTION_COOLDOWN_MS;

await test('foreign process holds the write lock at the gate: loop stays responsive (<= 200 ms stall), promotion commits after release', async () => {
    const ws = tmp();
    await seed(ws, 2000);
    let holder: ChildProcess | null = null;
    let lockedAt = 0;
    // Take the foreign lock deterministically at the gate (barrier is up, tail is copied next, then BEGIN EXCLUSIVE).
    promotionTestHooks.beforeGate = async () => {
        if (holder) return;
        holder = await startHolder(verbatimSqlitePath(ws), 2500);
        lockedAt = Date.now();
    };
    const mon = monitor();
    const t0 = Date.now();
    let r;
    try { r = await promoteWorkspace(ws, DIM); }
    finally { promotionTestHooks.beforeGate = undefined; }
    const maxStall = mon.stop();
    assert.ok(holder, 'the holder ran');
    await exited(holder!);
    assert.equal(r.committed, true, r.verify.reasons.join(' | '));
    assert.ok(Date.now() - lockedAt >= 2000, 'the promotion really waited for the foreign lock');
    assert.ok(maxStall <= 200, `event loop stalled ${maxStall} ms (limit 200) while a foreign process held the write lock`);
    assert.ok(Date.now() - t0 < 60_000);
});

await test('foreign lock outlives the wait budget: clean abort (no hang, no stall), cooldown recorded, SQLite writable afterwards', async () => {
    process.env.LORE_PROMOTION_LOCK_WAIT_MS = '500';
    process.env.LORE_PROMOTION_COOLDOWN_MS = '60000';
    const ws = tmp();
    await seed(ws, 300);
    let holder: ChildProcess | null = null;
    promotionTestHooks.beforeGate = async () => { if (!holder) holder = await startHolder(verbatimSqlitePath(ws), 6000); }; // outlives barrier hold (2 s) + lock budget (0.5 s)
    const mon = monitor();
    let r;
    try { r = await promoteWorkspace(ws, DIM); }
    finally { promotionTestHooks.beforeGate = undefined; }
    const maxStall = mon.stop();
    await exited(holder!);
    assert.equal(r.committed, false);
    assert.match(r.verify.reasons.join(' '), /write lock/);
    assert.ok(maxStall <= 200, `event loop stalled ${maxStall} ms`);
    assert.equal(fs.existsSync(stagingDirPath(ws)), false, 'staging deleted');
    assert.equal(readPromotionState(ws), null);
    assert.equal(readPromotionCooldown(ws)?.failures, 1, 'cooldown recorded');
    // SQLite untouched and fully usable once the holder is gone (the triggers/log were dropped by the abort)
    const raw = new Database(verbatimSqlitePath(ws));
    raw.pragma('busy_timeout = 2000');
    assert.equal((raw.prepare(`SELECT count(*) c FROM verbatim`).get() as { c: number }).c, 300);
    assert.equal((raw.prepare(`SELECT count(*) c FROM sqlite_master WHERE name LIKE 'verbatim_changes%'`).get() as { c: number }).c, 0);
    raw.close();
    clearPromotionCooldown(ws);
});

await test('runWithoutBlocking: retries on a timer (loop alive), restores busy_timeout on success AND on failure', async () => {
    const ws = tmp();
    await seed(ws, 5);
    const file = verbatimSqlitePath(ws);
    const a = new Database(file);
    const b = new Database(file);
    b.pragma('busy_timeout = 5000');
    a.exec('BEGIN IMMEDIATE');
    // budget exhausted -> the lock error propagates, timeout restored, and it never slept inside SQLite
    const mon = monitor();
    const t0 = Date.now();
    await assert.rejects(() => runWithoutBlocking(b, () => b.exec('BEGIN IMMEDIATE'), 300), /locked|busy/i);
    const stall = mon.stop();
    assert.ok(Date.now() - t0 >= 250 && Date.now() - t0 < 2500, 'waited about the budget');
    assert.ok(stall <= 200, `loop stalled ${stall} ms`);
    assert.equal(b.pragma('busy_timeout', { simple: true }), 5000, 'busy_timeout restored after failure');
    // released mid-wait -> succeeds
    setTimeout(() => a.exec('ROLLBACK'), 150);
    await runWithoutBlocking(b, () => { b.exec('BEGIN IMMEDIATE'); b.exec('ROLLBACK'); }, 3000);
    assert.equal(b.pragma('busy_timeout', { simple: true }), 5000, 'busy_timeout restored after success');
    // a non-lock error is not swallowed or retried
    await assert.rejects(() => runWithoutBlocking(b, () => b.exec('SELECT * FROM no_such_table'), 3000), /no such table/);
    assert.equal(b.pragma('busy_timeout', { simple: true }), 5000);
    a.close(); b.close();
});

if (savedBudget === undefined) delete process.env.LORE_PROMOTION_LOCK_WAIT_MS; else process.env.LORE_PROMOTION_LOCK_WAIT_MS = savedBudget;
if (savedCool === undefined) delete process.env.LORE_PROMOTION_COOLDOWN_MS; else process.env.LORE_PROMOTION_COOLDOWN_MS = savedCool;
await sleep(0);
for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
