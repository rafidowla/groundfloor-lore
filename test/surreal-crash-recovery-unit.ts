#!/usr/bin/env tsx
/**
 * surreal-crash-recovery-unit.ts — durability + close/reopen for the
 * SurrealDB engine (Phase 1 hard constraint: "a close/reopen crash-and-
 * recovery test, not just the SIGKILL-mid-write test already done").
 *
 * Why close/reopen specifically: Kùzu has documented close/reopen SEGFAULT
 * behaviour in this very codebase — `cli/commands/migrateWorkspaceToWorkspace.ts`
 * carries explicit handling for it, and `LocalGraph.close()` has a
 * drain-before-teardown dance guarding a use-after-free. That is a property of
 * the incumbent engine, not a law of nature, and a replacement inherits none of
 * it automatically. If SurrealDB has an equivalent problem, it has to surface
 * here, in a test, and not during a Phase-5 pilot.
 *
 * Covered:
 *   A. Close then reopen IN THE SAME PROCESS, repeatedly — the exact shape
 *      that segfaults Kùzu. Data survives every cycle.
 *   B. Reopen after a HARD KILL (SIGKILL, no close, mid-write) in a child
 *      process. Committed writes survive; nothing is corrupted; the store is
 *      writable again afterwards.
 *   C. No gaps and no duplicates across the crash boundary — a torn write
 *      must not resurrect as a half-row or a double-row.
 *   D. Both storage backends (`surrealkv` and `rocksdb`) get the same
 *      treatment, because the build plan does not let `surrealkv` be chosen on
 *      "it worked once".
 *
 * Run: npx tsx test/surreal-crash-recovery-unit.ts
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import type { SurrealBackend } from '../packages/lore/src/engines/surreal/surrealConnection.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITER_SCRIPT = path.join(REPO_ROOT, 'test', 'helpers', 'surreal-crash-writer.ts');

/**
 * Both on-disk backends survive a crash, so both are covered for SIGKILL.
 *
 * In-process close/reopen is a different story and the cases are split
 * accordingly: `rocksdb://` NEVER releases its directory lock inside the
 * process that held it, so a reopen there cannot succeed by design. That is
 * asserted explicitly below rather than skipped, so the limitation is a
 * ratcheted fact instead of a gap — and it is the reason `surrealkv` is the
 * default backend.
 */
const CRASH_BACKENDS: readonly SurrealBackend[] = ['surrealkv', 'rocksdb'];
const REOPENABLE_BACKENDS: readonly SurrealBackend[] = ['surrealkv'];

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

function node(id: string, over: Partial<LoreNode> = {}): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id,
        type: 'decision',
        label: `Label ${id}`,
        content: `Content ${id}`,
        tags: ['durable'],
        project: 'proj',
        ecosystem: '*',
        metadata: '{}',
        ...over,
    };
}

function sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
}

console.log('SurrealGraph — close/reopen + crash recovery');

/* ─── A. close / reopen in the same process ──────────────────────── */

for (const backend of REOPENABLE_BACKENDS) {
    await test(`[${backend}] close then reopen in-process preserves data (no segfault)`, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lore-surreal-reopen-${backend}-`));
        try {
            const first = new SurrealGraph(dir, { backend });
            await first.initialize();
            await first.upsertNode(node('persisted', { label: 'written before close' }));
            await first.close();

            const second = new SurrealGraph(dir, { backend });
            await second.initialize();
            const read = await second.getNode('persisted');
            assert.equal(read?.label, 'written before close', 'data survives close/reopen');
            // And the reopened handle is fully WRITABLE, not just readable.
            await second.upsertNode(node('after-reopen'));
            assert.ok(await second.getNode('after-reopen'), 'reopened store accepts writes');
            await second.close();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    await test(`[${backend}] five close/reopen cycles on one directory stay stable`, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lore-surreal-cycles-${backend}-`));
        try {
            for (let cycle = 0; cycle < 5; cycle++) {
                const graph = new SurrealGraph(dir, { backend });
                await graph.initialize();
                await graph.upsertNode(node(`cycle-${cycle}`));
                // Every previously-written row must still be there.
                for (let prior = 0; prior <= cycle; prior++) {
                    assert.ok(await graph.getNode(`cycle-${prior}`), `cycle ${prior} survived to cycle ${cycle}`);
                }
                assert.equal((await graph.getStats()).nodeCount, cycle + 1, 'exact row count each cycle');
                await graph.close();
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    await test(`[${backend}] close() is idempotent and a double-close does not throw`, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lore-surreal-dblclose-${backend}-`));
        try {
            const graph = new SurrealGraph(dir, { backend });
            await graph.initialize();
            await graph.upsertNode(node('x'));
            await graph.close();
            await graph.close();
            // And it can be brought back up after the double close.
            await graph.initialize();
            assert.ok(await graph.getNode('x'));
            await graph.close();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    await test(`[${backend}] edges and traversal survive close/reopen`, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lore-surreal-edges-${backend}-`));
        try {
            const first = new SurrealGraph(dir, { backend });
            await first.initialize();
            for (const id of ['a', 'b', 'c']) await first.upsertNode(node(id));
            await first.addEdge({ sourceId: 'a', targetId: 'b', relation: 'r1' });
            await first.addEdge({ sourceId: 'b', targetId: 'c', relation: 'r2' });
            await first.close();

            const second = new SurrealGraph(dir, { backend });
            await second.initialize();
            const hops = await second.traverse('a', 2);
            assert.deepEqual(hops.map((h) => h.node.id).sort(), ['b', 'c'], 'graph shape survived');
            assert.equal((await second.getStats()).edgeCount, 2);
            await second.close();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
}

await test('[rocksdb] in-process reopen fails LOUDLY within the budget (never hangs)', async () => {
    // The measured limitation that decided the default backend: rocksdb does
    // not release its directory lock inside the process that held it, so a
    // reopen can never succeed there. What MUST hold regardless is that the
    // attempt raises a named error instead of hanging — the raw driver behaviour
    // is an unsettled promise holding no libuv handle, which makes Node exit 13
    // with no error and no log line. This asserts the guard in openSurreal
    // converts that silence into a diagnosable failure.
    //
    // If a future @surrealdb/node release fixes the lock, this test starts
    // failing — which is the signal to move rocksdb into REOPENABLE_BACKENDS.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-rocks-reopen-'));
    const previousBudget = process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
    const previousTimeout = process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'];
    // Keep the case fast: the outcome is the same at 2s as at the 15s default.
    process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = '1500';
    process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'] = '500';
    try {
        const first = new SurrealGraph(dir, { backend: 'rocksdb' });
        await first.initialize();
        await first.upsertNode(node('written'));
        await first.close();

        const second = new SurrealGraph(dir, { backend: 'rocksdb' });
        const startedAt = Date.now();
        await assert.rejects(
            () => second.initialize(),
            /Failed to open embedded SurrealDB \(rocksdb\) after \d+ attempt/,
            'a blocked reopen must raise, not hang',
        );
        assert.ok(Date.now() - startedAt < 10_000, 'the budget is enforced, not merely documented');
        await second.close().catch(() => undefined);
    } finally {
        if (previousBudget === undefined) delete process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
        else process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = previousBudget;
        if (previousTimeout === undefined) delete process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'];
        else process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'] = previousTimeout;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* ─── B/C. SIGKILL mid-write, then reopen ────────────────────────── */

/**
 * Spawn the writer helper, let it commit rows, then SIGKILL the process GROUP
 * mid-write. Returns the highest row index the child reported as committed —
 * everything at or below it MUST survive.
 */
async function killMidWrite(dir: string, backend: SurrealBackend): Promise<number> {
    const child = spawn(
        process.execPath,
        ['--import', 'tsx', WRITER_SCRIPT, dir, backend],
        { cwd: REPO_ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    let lastCommitted = -1;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
            const match = /^committed (\d+)$/.exec(line.trim());
            if (match) lastCommitted = Number(match[1]);
        }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    // Wait until it is genuinely mid-run, not still opening the store.
    const deadline = Date.now() + 30_000;
    while (lastCommitted < 5 && Date.now() < deadline) await sleep(20);
    assert.ok(lastCommitted >= 5, `writer never got going (last=${lastCommitted})\n${stderr}`);

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // Negative pid → the whole group, so no orphan keeps the store open.
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
    await Promise.race([exited, sleep(8000)]);
    return lastCommitted;
}

for (const backend of CRASH_BACKENDS) {
    await test(`[${backend}] SIGKILL mid-write: every committed row survives, none duplicated`, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lore-surreal-kill-${backend}-`));
        try {
            const lastCommitted = await killMidWrite(dir, backend);

            const graph = new SurrealGraph(dir, { backend });
            await graph.initialize();

            // Every row the child reported committed BEFORE the kill must be
            // readable and intact. (Rows after it may or may not exist — that
            // is the torn write, and either outcome is durable-correct.)
            for (let i = 0; i <= lastCommitted; i++) {
                const read = await graph.getNode(`row-${i}`);
                assert.ok(read, `committed row-${i} is missing after SIGKILL`);
                assert.equal(read.label, `row ${i}`, `row-${i} content is intact, not torn`);
            }

            // No duplicates: the row count cannot exceed what was attempted,
            // and each id resolves to exactly one node.
            const all = await graph.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
            const ids = all.map((n) => n.id);
            assert.equal(new Set(ids).size, ids.length, 'no duplicate rows after crash');
            assert.ok(ids.length >= lastCommitted + 1, 'no committed row vanished');

            // The store is not merely readable — it accepts new writes.
            await graph.upsertNode(node('post-crash'));
            assert.ok(await graph.getNode('post-crash'), 'store is writable after crash recovery');
            await graph.close();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

}

for (const backend of REOPENABLE_BACKENDS) {
    await test(`[${backend}] a store crashed mid-write reopens cleanly a SECOND time`, async () => {
        // Two crashes in a row: a recovery path that only works once (e.g. a
        // WAL replayed but not truncated) fails here and nowhere else.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lore-surreal-kill2-${backend}-`));
        try {
            await killMidWrite(dir, backend);
            const first = new SurrealGraph(dir, { backend });
            await first.initialize();
            const countAfterFirst = (await first.getStats()).nodeCount;
            await first.close();

            await killMidWrite(dir, backend);
            const second = new SurrealGraph(dir, { backend });
            await second.initialize();
            const countAfterSecond = (await second.getStats()).nodeCount;
            assert.ok(countAfterSecond >= countAfterFirst,
                `second recovery lost rows (${countAfterFirst} → ${countAfterSecond})`);
            await second.upsertNode(node('still-writable'));
            assert.ok(await second.getNode('still-writable'));
            await second.close();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
}

await test('[rocksdb] a closed store stays locked against OTHER processes too', async () => {
    // The decisive half of the backend decision. rocksdb's lock is not merely
    // slow to clear in-process — it is held for the LIFETIME of the process
    // that opened it, so after `close()` even a separate process cannot open
    // the same directory. surrealkv releases it (~500ms) and the cases above
    // prove both reopen paths work there.
    //
    // Consequence if this were ever the default: a daemon that touched a
    // workspace once would lock every other tool out of it — CLI, migration,
    // backup — until the daemon exited.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-rocks-xproc-'));
    try {
        const holder = new SurrealGraph(dir, { backend: 'rocksdb' });
        await holder.initialize();
        await holder.upsertNode(node('written'));
        await holder.close();

        // A SEPARATE process, after this one closed, still cannot get in.
        const child = spawn(
            process.execPath,
            ['--import', 'tsx', WRITER_SCRIPT, dir, 'rocksdb'],
            { cwd: REPO_ROOT, env: { ...process.env, LORE_SURREAL_OPEN_BUDGET_MS: '1500', LORE_SURREAL_OPEN_TIMEOUT_MS: '500' },
              stdio: ['ignore', 'pipe', 'pipe'], detached: true },
        );
        let committed = false;
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('committed')) committed = true; });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        await Promise.race([exited, sleep(20_000)]);
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }

        assert.equal(committed, false, 'the child must NOT have been able to open the locked store');
        assert.match(stderr, /Failed to open embedded SurrealDB \(rocksdb\)/,
            'and it must fail with the named error rather than hanging silently');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
