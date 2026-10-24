#!/usr/bin/env tsx
/**
 * verbatim-promotion-gate-unit.ts - 3.35.3 review finding F1: the final gate must converge under steady
 * writes, and a promotion that cannot must back off instead of re-streaming the table on every write.
 *
 *   (a) FAST WRITER. A live writer in a tight loop for the whole promotion used to leave a new delta
 *       behind every catch-up round, so the gate never saw `max(seq) == lastSeq` and aborted after 25
 *       rounds. With the write barrier the small tail is copied with writers parked and the promotion
 *       COMMITS; the promoted table equals the writer's final state; writes parked at commit fail loudly
 *       (VerbatimStoreRetiredError), never silently onto the retired file.
 *   (b) COOLDOWN. A persisted exponential cooldown (1 min doubling to a 1 h cap) that the automatic
 *       trigger respects; it survives a restart (cache reset), is cleared by a commit.
 *   (c) GATE ABORT. When the tail never gets small the attempt is abandoned: staging is deleted (and why),
 *       triggers and log are dropped, SQLite is untouched, the cooldown is recorded; a second attempt after
 *       the cooldown commits.
 *
 * Run: npx tsx test/verbatim-promotion-gate-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as lancedb from '@lancedb/lancedb';

import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { promoteWorkspace, shouldTriggerPromotion } from '../packages/lore/src/engines/verbatimPromotion.js';
import { promotionTestHooks } from '../packages/lore/src/engines/verbatimPromotionGate.js';
import { VerbatimStoreRetiredError } from '../packages/lore/src/engines/verbatimWriteBarrier.js';
import {
    verbatimSqlitePath, stagingDirPath, lancedbDirPath, readPromotionState,
    promotionCooldownDelayMs, readPromotionCooldown, promotionCooldownRemainingMs, recordPromotionAbort,
    clearPromotionCooldown, resetPromotionCooldownCache,
} from '../packages/lore/src/engines/verbatimPromotionState.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const DIM = 16;
class Det implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'gate-det'; readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private vec(text: string): number[] { const v = new Array(DIM).fill(0); for (let i = 0; i < text.length; i++) v[i % DIM] += text.charCodeAt(i) / 128; const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map((x) => x / n); }
    async embed(t: string) { return this.vec(t); } async embedQuery(t: string) { return this.vec(t); } async embedDocument(t: string) { return this.vec(t); }
}
const provider = new Det();
const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-gate-')); dirs.push(d); return d; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const setImmediateP = (): Promise<void> => new Promise((r) => setImmediate(r));

async function seed(ws: string, n: number): Promise<void> {
    const s = new SqliteVerbatimStore(ws, provider);
    await s.initialize();
    for (let i = 0; i < n; i++) await s.store({ id: `d${i}`, text: `document ${i} alpha beta`, metadata: {} });
    await s.close();
}
async function liveStore(ws: string): Promise<SqliteVerbatimStore> {
    const s = new SqliteVerbatimStore(ws, provider);
    await s.initialize();
    return s;
}
const logTableCount = (db: Database.Database): number =>
    (db.prepare(`SELECT count(*) c FROM sqlite_master WHERE name LIKE 'verbatim_changes_log%' OR name LIKE 'verbatim_changes_%'`).get() as { c: number }).c;

const ENV_KEYS = ['LORE_PROMOTION_COOLDOWN_MS', 'LORE_PROMOTION_COOLDOWN_MAX_MS', 'LORE_PROMOTION_SMALL_TAIL_ROWS', 'LORE_VECTOR_PROMOTE_ROWS'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const restoreEnv = (): void => { for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } };

console.log('F1b: persisted exponential cooldown');

await test('delay doubles from 1 min and is capped at 1 h', async () => {
    restoreEnv();
    assert.equal(promotionCooldownDelayMs(1), 60_000);
    assert.equal(promotionCooldownDelayMs(2), 120_000);
    assert.equal(promotionCooldownDelayMs(3), 240_000);
    assert.equal(promotionCooldownDelayMs(7), 3_600_000, '64 min capped to 1 h');
    assert.equal(promotionCooldownDelayMs(40), 3_600_000);
});

await test('recordPromotionAbort persists, survives a restart, doubles, and clear removes it; the trigger respects it', async () => {
    restoreEnv();
    process.env.LORE_VECTOR_PROMOTE_ROWS = '10';
    const ws = tmp();
    assert.equal(shouldTriggerPromotion(ws, 1000), true, 'no cooldown: triggers');
    const t0 = Date.now();
    const c1 = recordPromotionAbort(ws, 'first', t0);
    assert.equal(c1.failures, 1);
    assert.equal(c1.nextAttemptAt, t0 + 60_000);
    const c2 = recordPromotionAbort(ws, 'second', t0);
    assert.equal(c2.failures, 2);
    assert.equal(c2.nextAttemptAt, t0 + 120_000);
    assert.equal(shouldTriggerPromotion(ws, 1000), false, 'cooldown active: no trigger');
    resetPromotionCooldownCache(); // "restart": must come back from the file
    const back = readPromotionCooldown(ws);
    assert.equal(back?.failures, 2);
    assert.ok(promotionCooldownRemainingMs(ws) > 0);
    assert.ok(fs.existsSync(path.join(ws, '.lore', 'promotion-cooldown.json')));
    clearPromotionCooldown(ws);
    resetPromotionCooldownCache();
    assert.equal(readPromotionCooldown(ws), null);
    assert.equal(shouldTriggerPromotion(ws, 1000), true);
    restoreEnv();
});

await test('a corrupt cooldown file fails open (promotion is not disabled forever)', async () => {
    restoreEnv();
    process.env.LORE_VECTOR_PROMOTE_ROWS = '10';
    const ws = tmp();
    fs.mkdirSync(path.join(ws, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.lore', 'promotion-cooldown.json'), '{not json');
    resetPromotionCooldownCache();
    assert.equal(shouldTriggerPromotion(ws, 1000), true);
    restoreEnv();
});

console.log('F1a: the gate converges under a fast in-process writer');

await test('a tight-loop writer for the whole promotion: promotion COMMITS, Lance == writer final state, parked writes fail loudly', async () => {
    restoreEnv();
    const ws = tmp();
    await seed(ws, 3000);
    const live = await liveStore(ws);
    let stop = false, written = 0, retired = 0;
    const unexpected: unknown[] = [];
    const acked = new Set<string>();
    const writer = (async () => {
        for (let i = 0; !stop; i++) {
            const id = `l${i}`;
            try { await live.store({ id, text: `live ${i}`, metadata: {} }); acked.add(id); written++; }
            catch (e) { if (e instanceof VerbatimStoreRetiredError) { retired++; break; } unexpected.push(e); break; }
            await setImmediateP();
        }
    })();
    const r = await promoteWorkspace(ws, DIM).finally(() => { stop = true; });
    await writer;
    assert.deepEqual(unexpected, [], 'no write failed with anything but the loud retired error');
    assert.equal(r.committed, true, `promotion did not commit: ${r.verify.reasons.join(' | ')}`);
    assert.ok(written > 50, `the writer really ran during the promotion (${written} writes)`);
    // everything the writer was told succeeded is in the promoted table (it is in the retired file's WAL
    // too, which the live store still reads; equality against that is the exact expectation)
    const want = (((live as unknown as { db: Database.Database }).db).prepare(`SELECT id FROM verbatim WHERE is_canonical = 1`).all() as Array<{ id: string }>).map((x) => x.id).sort();
    const t = await (await lancedb.connect(lancedbDirPath(ws))).openTable('lore_verbatim');
    const got = ((await t.query().select(['id']).toArray()) as Array<{ id: string }>).map((x) => x.id).filter((id) => !/#rev\d{4}-/.test(id)).sort();
    assert.deepEqual(got, want, 'promoted canonical rows == final SQLite canonical rows');
    for (const id of acked) assert.ok(got.includes(id), `acknowledged write ${id} survived the promotion`);
    assert.equal(readPromotionState(ws), null, 'state cleared');
    assert.equal(readPromotionCooldown(ws), null, 'a commit leaves no cooldown');
    await live.close();
});

console.log('F1b/c: a non-converging gate aborts cleanly, backs off, and the next attempt after the cooldown commits');

await test('abort -> staging deleted, SQLite intact, log dropped, cooldown persisted and honoured; second attempt after cooldown commits', async () => {
    restoreEnv();
    process.env.LORE_PROMOTION_SMALL_TAIL_ROWS = '0';       // the barrier path only opens on a fully quiet round
    process.env.LORE_PROMOTION_COOLDOWN_MS = '400';         // short enough to wait out in a test
    // default threshold (250k rows): the live store must not auto-trigger its own promotion here
    const ws = tmp();
    await seed(ws, 200);
    const live = await liveStore(ws);
    let n = 0;
    // every catch-up round leaves one new write behind: the tail can never reach 0
    promotionTestHooks.afterRound = async () => { await live.store({ id: `churn${n++}`, text: `churn ${n}`, metadata: {} }); };
    try {
        const r1 = await promoteWorkspace(ws, DIM);
        assert.equal(r1.committed, false, 'first attempt aborts');
        assert.ok(r1.verify.reasons.join(' ').length > 0, 'abort carries a reason');
        assert.ok(n >= 25, `ran the free rounds (${n})`);
        assert.equal(fs.existsSync(stagingDirPath(ws)), false, 'staging deleted on abort');
        assert.equal(readPromotionState(ws), null, 'promotion.json cleared');
        const raw = new Database(verbatimSqlitePath(ws), { readonly: true });
        assert.equal(logTableCount(raw), 0, 'changes-log table and triggers dropped');
        assert.equal((raw.prepare(`SELECT count(*) c FROM verbatim WHERE is_canonical = 1`).get() as { c: number }).c, 200 + n, 'SQLite still has every row, including the churn');
        raw.close();
        const cd = readPromotionCooldown(ws);
        assert.equal(cd?.failures, 1);
        assert.ok((cd?.nextAttemptAt ?? 0) > Date.now() - 50);
        assert.equal(shouldTriggerPromotion(ws, 1_000_000), false, 'automatic trigger is held off during the cooldown');
        // a second failure doubles the delay
        resetPromotionCooldownCache();
        const r2 = await promoteWorkspace(ws, DIM); // manual promote ignores the cooldown but records the abort
        assert.equal(r2.committed, false);
        assert.equal(readPromotionCooldown(ws)?.failures, 2);
        assert.ok(promotionCooldownRemainingMs(ws) > 400 && promotionCooldownRemainingMs(ws) <= 800, 'second delay is double the first');
        // quiet down, wait the cooldown out, the trigger fires again and the attempt commits
        promotionTestHooks.afterRound = undefined;
        await sleep(promotionCooldownRemainingMs(ws) + 50);
        assert.equal(shouldTriggerPromotion(ws, 1_000_000), true, 'trigger re-arms after the cooldown');
        const r3 = await promoteWorkspace(ws, DIM);
        assert.equal(r3.committed, true, r3.verify.reasons.join(' | '));
        assert.equal(readPromotionCooldown(ws), null, 'commit clears the cooldown');
        const t = await (await lancedb.connect(lancedbDirPath(ws))).openTable('lore_verbatim');
        assert.equal(await t.countRows(), 200 + n, 'second attempt promoted every row');
    } finally {
        promotionTestHooks.afterRound = undefined;
        await live.close();
        restoreEnv();
    }
});

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
