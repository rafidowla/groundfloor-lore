#!/usr/bin/env tsx
/**
 * test/node-batch-engine-contract-unit.ts - 3.35.0: the `commitNodeBatch` engine contract.
 *
 *   sqlite    real SqliteGraph over a temp file: all-pass, precondition false, ifRevision miss, ifAbsent
 *             duplicate, mixed, empty batch, caps, "touches" never bump revision/updatedAt, and TWO
 *             connections on one file (the second BEGIN IMMEDIATE waits, then fails its precondition)
 *   arcade    the real ArcadeGraphStore over a fake ArcadeHttp that records the generated sqlscript:
 *             sorted touches, one CAS per touch, ROLLBACK + RETURN after every IF, no `RETURN COUNT`,
 *             no `COMMIT RETRY`, bound parameters only; outcome mapping (CME -> contention, duplicate ->
 *             exists, timeout -> unknown, failed guard -> precondition/revision)
 *   dataplane not supported: no `commitNodeBatch`, nothing written
 *
 * Run: npx tsx test/node-batch-engine-contract-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { ArcadeGraphStore } from '../packages/lore/src/engines/arcade/arcadeGraphStore.js';
import { ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { DataplaneGraph } from '../packages/lore/src/engines/dataplaneGraph.js';
import {
    hasNodeBatchSupport, MAX_NODE_BATCH_WRITES, MAX_NODE_BATCH_CHECKS, NodeBatchInvalidError,
    type NodeBatchWrite, type NodeBatchNodeInput,
} from '../packages/lore/src/engines/graphShared/nodeBatch.js';
import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import {
    commitNodeBatchWithRetry, isNodeBatchContention, NodeBatchContentionError,
} from '../packages/lore/src/engines/graphShared/nodeBatchRetry.js';
import { OutcomeUnknownError } from '../packages/lore/src/engines/graphShared/writeOutcome.js';
import { createGatePool, cleanupGateWorkspaces, closeGatePool, gateDbUrl } from './helpers/testPostgres.js';
import { Client as PgClient, Pool as PgPoolClass } from 'pg';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

const input = (id: string, label = id): NodeBatchNodeInput =>
    ({ id, type: 'note', label, content: `content ${label}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' });
const cas = (id: string, expected: number, label = id, mustExist = false): NodeBatchWrite =>
    ({ kind: 'cas', node: input(id, label), expectedRevision: expected, mustExist, updatedAt: '2026-10-01T00:00:00.000Z' });
const ins = (id: string): NodeBatchWrite => ({ kind: 'insert', node: input(id), updatedAt: '2026-10-01T00:00:00.000Z' });

// ───────────────────────── sqlite ─────────────────────────
console.log('\nsqlite');

async function sqliteGraph(dir = mkTmp('nb-sq-')): Promise<SqliteGraph> {
    const g = new SqliteGraph(dir, { workspaceId: 'nb' });
    await g.initialize();
    return g;
}
/** Seed `id` at revision `n` (n writes). */
async function seed(g: SqliteGraph, id: string, n = 1): Promise<void> {
    for (let i = 0; i < n; i++) await g.upsertNode({ ...input(id, `${id}-v${i}`) } as never);
}

await test('all pass: every write lands at expected + 1 (insert at 1) and the outcome reports them', async () => {
    const g = await sqliteGraph();
    await seed(g, 'x', 2); await seed(g, 'a', 1);
    const out = await g.commitNodeBatch([{ id: 'x', revision: 2 }], [cas('a', 1), ins('b')]);
    assert.deepEqual(out, { ok: true, revisions: { a: 2, b: 1 } });
    assert.equal((await g.getNode('a'))!.revision, 2);
    assert.equal((await g.getNode('b'))!.revision, 1);
});

await test('precondition false: nothing is written; the failing index and actual revision are reported', async () => {
    const g = await sqliteGraph();
    await seed(g, 'x', 3); await seed(g, 'a', 1);
    const out = await g.commitNodeBatch([{ id: 'x', revision: 3 }, { id: 'a', revision: 5 }], [cas('a', 1, 'changed'), ins('b')]);
    assert.deepEqual(out, { ok: false, code: 'precondition', index: 1, id: 'a', actual: 1 });
    assert.equal((await g.getNode('a'))!.label, 'a-v0', 'untouched');
    assert.equal(await g.getNode('b'), null, 'the insert did not land');
});

await test('ifRevision miss (cas with the wrong expected revision): nothing is written', async () => {
    const g = await sqliteGraph();
    await seed(g, 'a', 2);
    const out = await g.commitNodeBatch([], [ins('b'), cas('a', 1)]);
    assert.deepEqual(out, { ok: false, code: 'revision', index: 1, id: 'a', actual: 2 });
    assert.equal(await g.getNode('b'), null);
});

await test('mustExist cas on an absent node is a revision miss, not a create', async () => {
    const g = await sqliteGraph();
    const out = await g.commitNodeBatch([], [cas('ghost', 0, 'ghost', true)]);
    assert.equal(out.ok, false);
    assert.equal((out as { code: string }).code, 'revision');
    assert.equal(await g.getNode('ghost'), null);
});

await test('ifAbsent duplicate: `exists`, nothing else written', async () => {
    const g = await sqliteGraph();
    await seed(g, 'taken', 1);
    const out = await g.commitNodeBatch([], [ins('fresh'), ins('taken')]);
    assert.deepEqual(out, { ok: false, code: 'exists', index: 1, id: 'taken' });
    assert.equal(await g.getNode('fresh'), null);
});

await test('mixed batch: checks + cas + insert commit together', async () => {
    const g = await sqliteGraph();
    await seed(g, 'x', 1); await seed(g, 'y', 4); await seed(g, 'a', 1);
    const out = await g.commitNodeBatch([{ id: 'x', revision: 1 }, { id: 'y', revision: 4 }], [cas('a', 1), ins('n1'), ins('n2')]);
    assert.equal(out.ok, true);
    assert.deepEqual((out as { revisions: unknown }).revisions, { a: 2, n1: 1, n2: 1 });
});

await test('an empty batch, an over-cap batch and a repeated write id are rejected up front', async () => {
    const g = await sqliteGraph();
    await assert.rejects(g.commitNodeBatch([], []), NodeBatchInvalidError);
    const many = Array.from({ length: MAX_NODE_BATCH_WRITES + 1 }, (_, i) => ins(`n${i}`));
    await assert.rejects(g.commitNodeBatch([], many), /at most 100 writes/);
    const checks = Array.from({ length: MAX_NODE_BATCH_CHECKS + 1 }, (_, i) => ({ id: `c${i}`, revision: 0 }));
    await assert.rejects(g.commitNodeBatch(checks, [ins('z')]), /at most 400 checks/);
    await assert.rejects(g.commitNodeBatch([], [ins('dup'), ins('dup')]), /appears twice/);
    assert.equal(await g.getNode('n0'), null);
    // exactly at the cap is fine
    const ok = await g.commitNodeBatch([], Array.from({ length: MAX_NODE_BATCH_WRITES }, (_, i) => ins(`m${i}`)));
    assert.equal(ok.ok, true);
});

await test('a precondition check never bumps the checked node (revision and updatedAt unchanged)', async () => {
    const g = await sqliteGraph();
    await seed(g, 'x', 2);
    const before = await g.getNode('x');
    await g.commitNodeBatch([{ id: 'x', revision: 2 }], [ins('t')]);
    const after = await g.getNode('x');
    assert.equal(after!.revision, before!.revision);
    assert.equal(after!.updatedAt, before!.updatedAt);
});

await test('two connections on one file: the second BEGIN IMMEDIATE waits for the first, then fails its precondition', async () => {
    const dir = mkTmp('nb-sq2-');
    const g1 = await sqliteGraph(dir);
    await seed(g1, 'x', 1);
    const g2 = await sqliteGraph(dir);
    // Connection 1 holds the write lock (open IMMEDIATE transaction) and bumps X before committing.
    const dbFile = g1.dataPath;
    const raw = new Database(dbFile);
    raw.pragma('busy_timeout = 5000');
    raw.exec('BEGIN IMMEDIATE');
    raw.prepare('UPDATE nodes SET revision = revision + 1 WHERE id = ?').run('x');
    // Connection 2 starts its batch NOW (it will block inside better-sqlite3 until the lock is free).
    // A synchronous call would block this thread, so run it from a child process.
    const { spawn } = await import('node:child_process');
    const script = `
      import { SqliteGraph } from ${JSON.stringify(path.resolve('packages/lore/src/engines/sqliteGraph.ts'))};
      const g = new SqliteGraph(${JSON.stringify(dir)}, { workspaceId: 'nb' });
      await g.initialize();
      const out = await g.commitNodeBatch([{ id: 'x', revision: 1 }], [{ kind: 'insert', node: { id: 'w', type: 'note', label: 'w', content: 'w', tags: [], project: 'p', ecosystem: '*', metadata: '{}' }, updatedAt: '2026-10-01T00:00:00.000Z' }]);
      console.log(JSON.stringify(out));
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    await new Promise((r) => setTimeout(r, 1500)); // let the child reach (and wait on) the write lock
    assert.equal(stdout, '', 'the second connection has not decided yet - it is waiting for the lock');
    raw.exec('COMMIT');
    raw.close();
    await new Promise<void>((resolve, reject) => { child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`child exit ${c}: ${stderr}`)))); });
    const out = JSON.parse(stdout.trim().split('\n').pop()!);
    assert.deepEqual(out, { ok: false, code: 'precondition', index: 0, id: 'x', actual: 2 });
    assert.equal(await g2.getNode('w'), null, 'nothing was written by the loser');
});

// ───────────────────────── postgres (real a real Postgres container) ─────────────────────────
// Brief §3 gate: the FULL sqlite case list re-run against a real PostgresGraph,
// plus the concurrent-clients case (FOR UPDATE serialization) and the forced
// failure mapping checks (40001 -> contention -> shared bounded retry; statement
// timeout -> unknown). Skips cleanly (printed reason, exit 0) without LORE_PG_URL.
console.log('\npostgres (real a real Postgres container; skips cleanly without LORE_PG_URL)');

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
/** Rows right now parked on a lock acquisition (the batch's FOR UPDATE waiting). */
const lockWaiters = async (probe: PgPoolClass): Promise<number> => {
    const r = await probe.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active'`);
    return Number(r.rows[0]?.n ?? 0);
};
/** Wait until at least one session is lock-waiting (bounded), so a mid-flight rival COMMIT is deterministic. */
const waitLockWaiter = async (probe: PgPoolClass): Promise<void> => {
    for (let i = 0; i < 100 && (await lockWaiters(probe)) === 0; i++) await sleep(50);
};

const pgGatePool = await createGatePool('node-batch/postgres');
if (pgGatePool) {
    // A previous run may have crashed before its cleanup: start clean.
    await cleanupGateWorkspaces(pgGatePool);
    // Fresh workspace per case — the exact analogue of the sqlite rig's fresh
    // temp dir per case. A shared workspace would leak revisions/rows between
    // cases (an sqlite rig would never see that state); the pid suffix keeps
    // reruns after a crashed run (whose cleanup never ran) collision-free.
    let wsCounter = 0;
    async function pgGraph(ws?: string): Promise<PostgresGraph> {
        const g = new PostgresGraph(ws ?? `pg-gate-batch-${process.pid}-${++wsCounter}`, pgGatePool as PgPoolClass);
        await g.initialize();
        return g;
    }
    async function pgSeed(g: PostgresGraph, id: string, n = 1): Promise<void> {
        for (let i = 0; i < n; i++) await g.upsertNode({ ...input(id, `${id}-v${i}`) } as never);
    }

    await test('all pass: every write lands at expected + 1 (insert at 1) and the outcome reports them', async () => {
        const g = await pgGraph();
        assert.equal(hasNodeBatchSupport(g), true);
        await pgSeed(g, 'x', 2); await pgSeed(g, 'a', 1);
        const out = await g.commitNodeBatch([{ id: 'x', revision: 2 }], [cas('a', 1), ins('b')]);
        assert.deepEqual(out, { ok: true, revisions: { a: 2, b: 1 } });
        assert.equal((await g.getNode('a'))!.revision, 2);
        assert.equal((await g.getNode('b'))!.revision, 1);
    });

    await test('precondition false: nothing is written; the failing index and actual revision are reported', async () => {
        const g = await pgGraph();
        await pgSeed(g, 'x', 3); await pgSeed(g, 'a', 1);
        const out = await g.commitNodeBatch([{ id: 'x', revision: 3 }, { id: 'a', revision: 5 }], [cas('a', 1, 'changed'), ins('b')]);
        assert.deepEqual(out, { ok: false, code: 'precondition', index: 1, id: 'a', actual: 1 });
        assert.equal((await g.getNode('a'))!.label, 'a-v0', 'untouched');
        assert.equal(await g.getNode('b'), null, 'the insert did not land');
    });

    await test('ifRevision miss (cas with the wrong expected revision): nothing is written', async () => {
        const g = await pgGraph();
        await pgSeed(g, 'a', 2);
        const out = await g.commitNodeBatch([], [ins('b'), cas('a', 1)]);
        assert.deepEqual(out, { ok: false, code: 'revision', index: 1, id: 'a', actual: 2 });
        assert.equal(await g.getNode('b'), null);
    });

    await test('mustExist cas on an absent node is a revision miss, not a create', async () => {
        const g = await pgGraph();
        const out = await g.commitNodeBatch([], [cas('ghost', 0, 'ghost', true)]);
        assert.equal(out.ok, false);
        assert.equal((out as { code: string }).code, 'revision');
        assert.equal(await g.getNode('ghost'), null);
    });

    await test('ifAbsent duplicate: `exists`, nothing else written', async () => {
        const g = await pgGraph();
        await pgSeed(g, 'taken', 1);
        const out = await g.commitNodeBatch([], [ins('fresh'), ins('taken')]);
        assert.deepEqual(out, { ok: false, code: 'exists', index: 1, id: 'taken' });
        assert.equal(await g.getNode('fresh'), null);
    });

    await test('mixed batch: checks + cas + insert commit together', async () => {
        const g = await pgGraph();
        await pgSeed(g, 'x', 1); await pgSeed(g, 'y', 4); await pgSeed(g, 'a', 1);
        const out = await g.commitNodeBatch([{ id: 'x', revision: 1 }, { id: 'y', revision: 4 }], [cas('a', 1), ins('n1'), ins('n2')]);
        assert.equal(out.ok, true);
        assert.deepEqual((out as { revisions: unknown }).revisions, { a: 2, n1: 1, n2: 1 });
    });

    await test('an empty batch, an over-cap batch and a repeated write id are rejected up front', async () => {
        const g = await pgGraph();
        await assert.rejects(g.commitNodeBatch([], []), NodeBatchInvalidError);
        const many = Array.from({ length: MAX_NODE_BATCH_WRITES + 1 }, (_, i) => ins(`n${i}`));
        await assert.rejects(g.commitNodeBatch([], many), /at most 100 writes/);
        const checks = Array.from({ length: MAX_NODE_BATCH_CHECKS + 1 }, (_, i) => ({ id: `c${i}`, revision: 0 }));
        await assert.rejects(g.commitNodeBatch(checks, [ins('z')]), /at most 400 checks/);
        await assert.rejects(g.commitNodeBatch([], [ins('dup'), ins('dup')]), /appears twice/);
        assert.equal(await g.getNode('n0'), null);
        // exactly at the cap is fine
        const ok = await g.commitNodeBatch([], Array.from({ length: MAX_NODE_BATCH_WRITES }, (_, i) => ins(`m${i}`)));
        assert.equal(ok.ok, true);
    });

    await test('a precondition check never bumps the checked node (revision and updatedAt unchanged)', async () => {
        const g = await pgGraph();
        await pgSeed(g, 'x', 2);
        const before = await g.getNode('x');
        await g.commitNodeBatch([{ id: 'x', revision: 2 }], [ins('t')]);
        const after = await g.getNode('x');
        assert.equal(after!.revision, before!.revision);
        assert.equal(after!.updatedAt, before!.updatedAt);
    });

    await test('two pool clients on one batch: FOR UPDATE serializes them; the loser re-judges against the committed state, and nothing partial survives', async () => {
        const ws = 'pg-gate-batch-race';
        // Watchdog: if the fresh graph's schema DDL cannot get its locks within
        // 8s something still holds them — dump WHO before failing fast (a 30s
        // statement_timeout wait ends the same way, just with no evidence).
        const watchdog = setInterval(async () => {
            try {
                console.error(`  [lock-watchdog] pool total=${pgGatePool.totalCount} idle=${pgGatePool.idleCount} waiting=${pgGatePool.waitingCount}`);
                const c = await pgGatePool.connect();
                try {
                    const r = await c.query(
                        `SELECT a.pid, a.state, a.wait_event_type, a.wait_event,
                                now() - a.xact_start AS xact_age, left(a.query, 110) AS q,
                                array_agg(DISTINCT l.locktype || ':' || coalesce(l.relation::regclass::text, l.virtualtransaction)) FILTER (WHERE l.granted) AS granted
                           FROM pg_stat_activity a LEFT JOIN pg_locks l ON l.pid = a.pid
                          WHERE a.datname = current_database() AND a.state <> 'idle'
                          GROUP BY a.pid, a.state, a.wait_event_type, a.wait_event, a.xact_start, a.query`,
                    );
                    console.error('  [lock-watchdog] non-idle sessions:', JSON.stringify(r.rows, null, 1));
                } finally { c.release(); }
            } catch { /* diagnostic only */ }
        }, 2000);
        let g1: PostgresGraph;
        try {
            g1 = await pgGraph(ws);
        } finally {
            clearInterval(watchdog);
        }
        await pgSeed(g1, 'x', 1);
        // BOTH handles are opened BEFORE any transaction exists: initialize()
        // runs schema DDL, and CREATE TABLE IF NOT EXISTS takes an ACCESS
        // EXCLUSIVE lock on `nodes` even when nothing changes — it must not
        // race a held row lock (that deadlock was this test's own bug).
        const g2 = await pgGraph(ws);
        // Client 1 holds an open transaction that has already bumped X (uncommitted).
        const clientA = await pgGatePool.connect();
        await clientA.query('BEGIN');
        await clientA.query('UPDATE nodes SET revision = revision + 1 WHERE workspace_id = $1 AND id = $2', [ws, 'x']);
        // Client 2 starts its batch NOW: its sorted FOR UPDATE parks on X until client 1 commits.
        const pending = g2.commitNodeBatch([{ id: 'x', revision: 1 }], [ins('w')]);
        await waitLockWaiter(pgGatePool);
        assert.equal(await lockWaiters(pgGatePool) >= 1, true, 'the second client is parked on the first one’s row lock');
        await clientA.query('COMMIT');
        clientA.release();
        const out = await pending;
        assert.deepEqual(out, { ok: false, code: 'precondition', index: 0, id: 'x', actual: 2 }, 'the loser re-judges against what actually committed');
        assert.equal(await g2.getNode('w'), null, 'nothing was written by the loser');
    });

    // Forced 40001: REPEATABLE READ + a rival commit landing after the batch's
    // snapshot makes the batch's own FOR UPDATE raise serialization_failure —
    // the exact server failure the outcome map turns into `contention`.
    const rrUrl = gateDbUrl();
    if (!rrUrl) throw new Error('unreachable: gate pool exists but gate URL does not');
    const rrPool = new PgPoolClass({ connectionString: rrUrl, max: 1, application_name: 'lore-pg-gate-rr' });
    rrPool.on('error', () => undefined);
    // Session default isolation (the batch's BEGIN is plain, so the session
    // default governs). Pool max=1 is the determinism trick: the ONE client is
    // warmed here — SET awaited — and every later checkout (the batch's) reuses
    // that same session. A client created later on demand would never have run
    // the SET, which is exactly the read-committed misfire this rig once hit.
    {
        const c = await rrPool.connect();
        try { await c.query("SET default_transaction_isolation = 'repeatable read'"); } finally { c.release(); }
    }
    await test('forced 40001: contention outcome goes through nodeBatchRetry — the re-judged second attempt commits (attempts=2)', async () => {
        const ws = 'pg-gate-batch-rr';
        // cacheDisabled: attempt 2's prepare must RE-READ x afresh — a cached
        // revision-1 read would re-judge against a stale world (and the parity
        // of interest here is the retry path, not the cache).
        const g = new PostgresGraph(ws, rrPool, { cacheDisabled: true });
        await g.initialize();
        await pgSeed(g, 'x', 1);
        const rival = new PgClient({ connectionString: rrUrl });
        await rival.connect();
        await rival.query('BEGIN');
        await rival.query('UPDATE nodes SET revision = revision + 1 WHERE workspace_id = $1 AND id = $2', [ws, 'x']);
        let attempts = 0;
        const pending = commitNodeBatchWithRetry(g, async (attempt) => {
            attempts = attempt;
            const n = await g.getNode('x'); // prepare re-reads afresh EVERY attempt
            return { checks: [{ id: 'x', revision: n!.revision ?? 0 }], writes: [ins('w')] };
        });
        pending.catch(() => undefined); // handled below; never an unhandled rejection while we wait
        // Probe on the GATE pool, not rrPool: rrPool's only clients are the
        // rival's transaction and the parked batch, so a probe there queues
        // forever behind them (this rig self-deadlocked exactly that way).
        await waitLockWaiter(pgGatePool);
        await rival.query('COMMIT'); // lands after the batch's RR snapshot -> 40001 on attempt 1
        await rival.end();
        const result = await pending;
        assert.equal(result.ok, true, `the retry re-judged and committed: ${JSON.stringify(result)} attempts=${attempts}`);
        assert.equal(attempts, 2, 'attempt 1 hit the forced serialization failure, attempt 2 committed');
        assert.equal((await g.getNode('w'))!.revision, 1);
        assert.equal((await g.getNode('x'))!.revision, 2);
    });

    await test('forced 40001 outlasting the attempt budget throws the 503-shaped NodeBatchContentionError; nothing was written', async () => {
        const ws = 'pg-gate-batch-rr2';
        const g = new PostgresGraph(ws, rrPool, { cacheDisabled: true });
        await g.initialize();
        await pgSeed(g, 'x', 1);
        const rival = new PgClient({ connectionString: rrUrl });
        await rival.connect();
        await rival.query('BEGIN');
        await rival.query('UPDATE nodes SET revision = revision + 1 WHERE workspace_id = $1 AND id = $2', [ws, 'x']);
        const pending = commitNodeBatchWithRetry(
            g,
            async () => ({ checks: [{ id: 'x', revision: 1 }], writes: [ins('w')] }),
            { maxAttempts: 1, sleep: async () => undefined },
        );
        // Attach the rejection handler NOW: with maxAttempts=1 the throw can
        // land while we are still waiting for the lock waiter, and a floating
        // rejection would crash the process as unhandled.
        const asserted = assert.rejects(pending, (e: unknown) => {
            assert.ok(isNodeBatchContention(e), `expected NodeBatchContentionError, got ${String(e)}`);
            assert.equal((e as NodeBatchContentionError).status, 503, 'contention exhaustion maps to the retryable 503 shape, never a 500');
            assert.equal((e as NodeBatchContentionError).retryable, true);
            assert.equal((e as NodeBatchContentionError).attempts, 1);
            return true;
        });
        await waitLockWaiter(pgGatePool); // gate pool: rrPool's only client is the parked batch
        await rival.query('COMMIT');
        await rival.end();
        await asserted;
        assert.equal(await g.getNode('w'), null, 'a refused batch leaves nothing behind');
    });

    await rrPool.end();

    // Forced statement timeout: a held row lock + a 300ms statement_timeout
    // makes the batch's FOR UPDATE abort with 57014 — mapped to `unknown`
    // (the transaction MAY have committed), never blindly replayed.
    const toUrl = gateDbUrl();
    if (!toUrl) throw new Error('unreachable: gate pool exists but gate URL does not');
    const toPool = new PgPoolClass({ connectionString: toUrl, max: 2, statement_timeout: 300, application_name: 'lore-pg-gate-to' });
    toPool.on('error', () => undefined);
    await test('forced statement timeout: the outcome is `unknown`; the retry helper settles it by re-reading (OutcomeUnknownError), and nothing is replayed blindly', async () => {
        const ws = 'pg-gate-batch-to';
        const g = new PostgresGraph(ws, toPool);
        await g.initialize();
        await pgSeed(g, 'tx1', 1);
        const holder = await toPool.connect();
        await holder.query('BEGIN');
        await holder.query('UPDATE nodes SET revision = revision + 1 WHERE workspace_id = $1 AND id = $2', [ws, 'tx1']);
        const direct = await g.commitNodeBatch([{ id: 'tx1', revision: 1 }], [ins('tw')]);
        assert.deepEqual(direct, { ok: false, code: 'unknown' }, 'statement timeout maps to unknown, not contention');
        assert.equal(await g.getNode('tw'), null, 'nothing landed');
        // Through the retry helper an `unknown` is SETTLED by re-reading the
        // plan's own stamps: 'tw' is absent, so the honest answer is the
        // OutcomeUnknownError (the caller's outbox row stays pending_commit).
        await assert.rejects(
            commitNodeBatchWithRetry(
                g,
                async () => ({ checks: [{ id: 'tx1', revision: 1 }], writes: [{ kind: 'insert', node: input('tw'), updatedAt: '2026-10-01T00:00:00.000Z' }] }),
                { sleep: async () => undefined },
            ),
            OutcomeUnknownError,
        );
        await holder.query('ROLLBACK');
        holder.release();
    });
    await toPool.end();

    await cleanupGateWorkspaces(pgGatePool);
    await closeGatePool(pgGatePool);
}

// ───────────────────────── arcade (fake http) ─────────────────────────
console.log('\narcade (fake ArcadeHttp, generated script)');

type Row = Record<string, unknown>;
class FakeArcade {
    nodes = new Map<string, Row>();
    scripts: Array<{ script: string; params: Row }> = [];
    scriptValue: unknown = { ok: true };
    scriptError: Error | null = null;
    async command(): Promise<{ result: unknown[] }> { return { result: [] }; }
    async commandScript(_db: string, script: string, params: Row = {}): Promise<{ result: unknown[] }> {
        if (!script.startsWith('BEGIN;')) return { result: [] }; // schema DDL
        this.scripts.push({ script, params });
        if (this.scriptError) throw this.scriptError;
        return { result: [{ value: this.scriptValue }] };
    }
    async query(_db: string, sql: string, params: Row = {}): Promise<{ result: Row[] }> {
        if (/FROM LoreNode WHERE id = :id LIMIT 1$/.test(sql)) { const r = this.nodes.get(String(params['id'])); return { result: r ? [{ ...r }] : [] }; }
        return { result: [] };
    }
}
const row = (id: string, revision: number): Row =>
    ({ id, type: 'note', label: id, content: id, tags: '[]', project: 'p', ecosystem: '*', metadata: '{}', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision });
function arcadeRig(): { fake: FakeArcade; g: ArcadeGraphStore } {
    const fake = new FakeArcade();
    return { fake, g: new ArcadeGraphStore({ tenantDb: 't', http: fake as never }) };
}

await test('script shape: sorted touches, one CAS per touch, ROLLBACK + RETURN after each IF, writes sorted, no RETURN COUNT / COMMIT RETRY', async () => {
    const { fake, g } = arcadeRig();
    fake.nodes.set('zz', row('zz', 3)); fake.nodes.set('aa', row('aa', 7)); fake.nodes.set('m2', row('m2', 1)); fake.nodes.set('m1', row('m1', 1));
    const out = await g.commitNodeBatch([{ id: 'zz', revision: 3 }, { id: 'aa', revision: 7 }], [cas('m2', 1), cas('m1', 1), ins('k')]);
    assert.equal(out.ok, true);
    const { script, params } = fake.scripts[0]!;
    assert.match(script, /^BEGIN;/);
    assert.match(script, /COMMIT;\nRETURN \{"ok":true\};$/);
    assert.doesNotMatch(script, /RETURN COUNT/i);
    assert.doesNotMatch(script, /COMMIT RETRY/i);
    const touchLines = script.split('\n').filter((l) => l.startsWith('LET t'));
    assert.equal(touchLines.length, 2);
    for (const l of touchLines) {
        assert.match(l, /UPDATE LoreNode SET txTouch = ifnull\(txTouch, 0\) \+ 1 WHERE id = :t\d+_id AND ifnull\(revision, 0\) = :t\d+_rev;$/);
    }
    assert.equal(params['t0_id'], 'aa', 'touches run in ascending id order');
    assert.equal(params['t1_id'], 'zz');
    // every IF is followed by ROLLBACK and a RETURN inside the same block
    const ifLines = script.split('\n').filter((l) => l.startsWith('IF '));
    assert.equal(ifLines.length, 4, '2 touches + 2 cas writes');
    for (const l of ifLines) assert.match(l, /^IF \(\$[tw]\d+\[0\]\.count < 1\) \{ ROLLBACK; RETURN \{"failed":"(precondition|revision)","i":\d+\}; \}$/);
    // writes: ascending id order (k, m1, m2); one CAS (`ifnull(revision, 0) = :wN_exp`) per cas item; the insert has no guard
    const ids = Object.entries(params).filter(([k]) => /^w\d+_id$/.test(k)).sort().map(([, v]) => v);
    assert.deepEqual(ids, ['k', 'm1', 'm2']);
    assert.equal(script.split('\n').filter((l) => /ifnull\(revision, 0\) = :w\d+_exp;$/.test(l)).length, 2);
    assert.equal(script.split('\n').filter((l) => l.startsWith('INSERT INTO LoreNode')).length, 1);
    // bound parameters only: no node content in the script text
    assert.doesNotMatch(script, /content m1|content k/);
});

await test('outcome mapping: guard failures, CME -> contention, duplicate -> exists, timeout -> unknown', async () => {
    const { fake, g } = arcadeRig();
    fake.nodes.set('x', row('x', 1)); fake.nodes.set('a', row('a', 1));
    fake.scriptValue = { failed: 'precondition', i: 0 };
    assert.deepEqual(await g.commitNodeBatch([{ id: 'x', revision: 1 }], [cas('a', 1)]), { ok: false, code: 'precondition', index: 0, id: 'x', actual: 1 });
    fake.scriptValue = { failed: 'revision', i: 0 };
    assert.deepEqual(await g.commitNodeBatch([{ id: 'x', revision: 1 }], [cas('a', 1)]), { ok: false, code: 'revision', index: 0, id: 'a', actual: 1 });
    fake.scriptValue = { ok: true };
    fake.scriptError = new ArcadeHttpError(500, '{"exception":"com.arcadedb.exception.ConcurrentModificationException","error":"Concurrent modification"}');
    assert.deepEqual(await g.commitNodeBatch([{ id: 'x', revision: 1 }], [cas('a', 1)]), { ok: false, code: 'contention' });
    // (A) the commit-time RecordNotFoundException (real 26.7.1 body) is contention too; a plain 500 stays a refusal.
    fake.scriptError = new ArcadeHttpError(500, '{"error":"Error on transaction commit","detail":"Record #1:77 not found","exception":"com.arcadedb.exception.RecordNotFoundException"}');
    assert.deepEqual(await g.commitNodeBatch([{ id: 'x', revision: 1 }], [cas('a', 1)]), { ok: false, code: 'contention' });
    fake.scriptError = new ArcadeHttpError(500, '{"error":"Internal error","detail":"Record #1:77 not found","exception":"com.arcadedb.exception.RecordNotFoundException"}');
    await assert.rejects(g.commitNodeBatch([{ id: 'x', revision: 1 }], [cas('a', 1)]), /ArcadeDB HTTP 500/, 'a RecordNotFound that is NOT the commit error is not retried');
    fake.scriptError = new ArcadeHttpError(409, '{"exception":"com.arcadedb.exception.DuplicatedKeyException"}');
    const dup = await g.commitNodeBatch([], [ins('fresh')]);
    assert.equal(dup.ok, false); assert.equal((dup as { code: string }).code, 'exists');
    fake.scriptError = new Error('request timeout');
    assert.deepEqual(await g.commitNodeBatch([{ id: 'x', revision: 1 }], [cas('a', 1)]), { ok: false, code: 'unknown' });
    fake.scriptError = new ArcadeHttpError(400, 'bad sql');
    await assert.rejects(g.commitNodeBatch([], [cas('a', 1)]), /bad sql|400/);
});

await test('reads judge what a read can: a stale expected revision or an existing insert id never reaches the server', async () => {
    const { fake, g } = arcadeRig();
    fake.nodes.set('a', row('a', 4));
    assert.deepEqual(await g.commitNodeBatch([], [cas('a', 1)]), { ok: false, code: 'revision', index: 0, id: 'a', actual: 4 });
    assert.deepEqual(await g.commitNodeBatch([], [ins('a')]), { ok: false, code: 'exists', index: 0, id: 'a' });
    assert.equal(fake.scripts.length, 0);
});

await test('a cas on a row that is ABSENT creates it with an INSERT (found live: an UPDATE has no record to match); a rival creating it first is a revision conflict, not "exists"', async () => {
    const { fake, g } = arcadeRig();
    const out = await g.commitNodeBatch([], [cas('fresh', 0)]);
    assert.equal(out.ok, true);
    const { script } = fake.scripts[0]!;
    assert.equal(script.split('\n').filter((l) => l.startsWith('INSERT INTO LoreNode')).length, 1);
    assert.equal(script.split('\n').filter((l) => l.startsWith('LET w')).length, 0, 'no guarded UPDATE for an absent row');
    // the rival: duplicate key on the INSERT, and the row now exists at revision 2 -> the cas lost a revision race
    fake.scriptError = new ArcadeHttpError(409, '{"exception":"com.arcadedb.exception.DuplicatedKeyException"}');
    fake.nodes.set('late', row('late', 2));
    const realQuery = fake.query.bind(fake);
    let reads = 0;
    fake.query = async (db: string, sql: string, params: Row = {}) => {
        if (String(params['id']) === 'late' && reads++ === 0) return { result: [] }; // absent at read time, present afterwards
        return realQuery(db, sql, params);
    };
    assert.deepEqual(await g.commitNodeBatch([], [cas('late', 0)]), { ok: false, code: 'revision', index: 0, id: 'late', actual: 2 });
});

await test('D7: a revision-0 check on an absent node holds and is not touched; on an existing revision-0 row it is touched', async () => {
    const { fake, g } = arcadeRig();
    fake.nodes.set('legacy', row('legacy', 0));
    const out = await g.commitNodeBatch([{ id: 'ghost', revision: 0 }, { id: 'legacy', revision: 0 }], [ins('n')]);
    assert.equal(out.ok, true);
    const touchIds = Object.entries(fake.scripts[0]!.params).filter(([k]) => /^t\d+_id$/.test(k)).map(([, v]) => v);
    assert.deepEqual(touchIds, ['legacy']);
});

await test('empty batch and the caps are rejected before any request', async () => {
    const { fake, g } = arcadeRig();
    await assert.rejects(g.commitNodeBatch([], []), NodeBatchInvalidError);
    await assert.rejects(g.commitNodeBatch([], Array.from({ length: MAX_NODE_BATCH_WRITES + 1 }, (_, i) => ins(`n${i}`))), /at most 100 writes/);
    assert.equal(fake.scripts.length, 0);
});

// ───────────────────────── dataplane ─────────────────────────
console.log('\ndataplane');

await test('the Dataplane graph has no commitNodeBatch (not supported); hasNodeBatchSupport is false and nothing is written', async () => {
    const writes: string[] = [];
    const dp = Object.create(DataplaneGraph.prototype) as object;
    assert.equal(hasNodeBatchSupport(dp), false);
    assert.equal(hasNodeBatchSupport({ upsertNode: async () => { writes.push('w'); } }), false);
    assert.equal(hasNodeBatchSupport(await sqliteGraph()), true);
    assert.equal(hasNodeBatchSupport(arcadeRig().g), true);
    assert.deepEqual(writes, []);
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
