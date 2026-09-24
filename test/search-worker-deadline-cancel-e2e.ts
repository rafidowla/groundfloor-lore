#!/usr/bin/env tsx
/**
 * search-worker-deadline-cancel-e2e.ts — Atlas pass-tests (a) and (b) for the
 * 3.20.2 defect-1 fix ("a timed-out search-worker call is never cancelled"),
 * exercised through the REAL child-process IPC boundary
 * (verbatimSearchWorkerProxy.ts <-> verbatimSearchWorkerEntry.ts), not just at
 * the in-process SearchGate layer (that's covered separately by
 * test/search-gate-unit.ts and the R1 assertion in
 * test/search-worker-cancellation-repro-unit.ts).
 *
 * Both sections use the child's `__testHold`/`__testCounters` test-only hooks
 * (LORE_TEST_WORKER_HOOKS=1 — never available in production, see
 * verbatimWorkerProtocol.ts) to hold the child's EXCLUSIVE search-gate permit
 * for a controlled duration, then issue real `bm25Search` calls with
 * deliberately short per-call deadlines while it's held:
 *
 *   (a) One held call (10s), one `bm25Search` issued ~100ms later with a ~2s
 *       deadline. Both the proxy's own promise AND the child's queued wait
 *       must give up at ~2s (NOT ride out the full 10s hold) — proven by
 *       elapsed time — and `__testCounters()` proves bm25Search's native path
 *       never actually ran (checkGateAborted() is the only place that
 *       counter increments, and it runs strictly AFTER the deadline check).
 *
 *   (b) The same hold, but 50 `bm25Search` calls with ~2s deadlines (all
 *       queued and all expiring while the hold is still up), followed by ONE
 *       more `bm25Search` at t~3s with a generous ~30s deadline. The late
 *       call must finish within ~1s of the 10s hold releasing (i.e. it was
 *       never stuck behind the 50 expired ones — each of those must have been
 *       REMOVED from the gate's queue, per requirement 2, not merely
 *       rejected client-side while still occupying a FIFO slot), and
 *       `__testCounters()` must show bm25Search ran exactly once.
 *
 * Per-call deadlines are threaded as the `gate` param on VerbatimStore's own
 * bm25Search signature (`query, limit, filter, actorScopes, gate?`) — the
 * proxy takes the caller's `gate.deadline` and uses it (tightened against its
 * own LORE_SEARCH_WORKER_CALL_MS instance budget) as the wire-level deadline;
 * see verbatimSearchWorkerProxy.ts's `call()`/`extractGateOpts`.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.LORE_TEST_WORKER_HOOKS = '1';
// Generous ambient instance budget for BOTH sections below — large enough
// that it is never itself the thing that trims a call's deadline. Each
// section's own per-call `gate.deadline` is what's actually under test.
process.env.LORE_SEARCH_WORKER_CALL_MS = '40000';
process.env.LORE_SEARCH_WORKER_READY_MS ??= '90000';

const { VerbatimSearchWorkerProxy } = await import('../packages/lore/src/engines/verbatimSearchWorkerProxy.js');
const { SearchWorkerDeadlineError } = await import('../packages/lore/src/engines/verbatimWorkerProtocol.js');

type Proxy = InstanceType<typeof VerbatimSearchWorkerProxy>;

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failures += 1;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

function tmpHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `search-worker-deadline-${tag}-`));
}

/** A `bm25Search` against a table that doesn't exist yet short-circuits before
 *  ever touching the search gate (`if (!this.initialized || !this.table)
 *  return makeBm25Envelope([], true);` in verbatimStore.ts) — it resolves
 *  instantly instead of queuing, which would make every assertion below
 *  vacuous. Seed a handful of real rows first so the table exists and
 *  `bm25Search` actually goes through `searchGate.read()`. Kept tiny (well
 *  under the 256-row FTS auto-build threshold) so seeding stays fast; a
 *  brute-force/no-index BM25 scan still exercises the same gate path. */
async function newProxy(tag: string): Promise<{ proxy: Proxy; home: string }> {
    const home = tmpHome(tag);
    const proxy = new VerbatimSearchWorkerProxy(home) as unknown as Proxy;
    await (proxy as unknown as { initialize(): Promise<void> }).initialize();
    await (proxy as unknown as { storeBatch(rows: unknown[]): Promise<void> }).storeBatch(
        Array.from({ length: 5 }, (_, i) => ({ id: `lore:seed-${tag}-${i}`, text: `seed document ${i} about alpha bravo charlie`, metadata: {} })),
    );
    return { proxy, home };
}

function isDeadlineOrAbort(err: unknown): boolean {
    if (err instanceof SearchWorkerDeadlineError) return true;
    const e = err as { name?: string; message?: string };
    return e?.name === 'SearchWorkerDeadlineError'
        || /deadline/i.test(e?.message ?? '')
        || /timed out/i.test(e?.message ?? '');
}

console.log('\n=== Defect 1 fix: per-call deadline + cancellation through the real search-worker IPC boundary ===\n');

// ── (a): a single expired call must not wait out the hold ──────────────────
{
    const { proxy, home } = await newProxy('a');
    try {
        await test('(a) bm25Search with a 2s deadline rejects at ~2s, not at the 10s hold — and never ran natively', async () => {
            const p = proxy as unknown as {
                __testHold(ms: number): Promise<{ ok: true }>;
                __testCounters(): Promise<Record<string, number>>;
                bm25Search(query: string, limit?: number, filter?: unknown, actorScopes?: unknown, gate?: { deadline?: number }): Promise<unknown>;
            };

            const holdStarted = Date.now();
            const hold = p.__testHold(10_000);
            // Never leave `hold` unhandled: if an assertion below throws before
            // the "await hold" further down runs, this promise would otherwise
            // be a dangling in-flight call — and if proxy.close() (in the outer
            // `finally`) has to force-kill the child while it's still running,
            // that rejects `hold` with SearchWorkerRestartError as an UNHANDLED
            // rejection, crashing the whole test process before later tests run.
            hold.catch(() => undefined);
            await new Promise((r) => setTimeout(r, 100));

            const callStarted = Date.now();
            const deadline = callStarted + 2_000;
            let rejected: unknown;
            try {
                await p.bm25Search('alpha bravo', 10, undefined, undefined, { deadline });
                assert.fail('bm25Search should have rejected at its deadline, not resolved');
            } catch (err) {
                rejected = err;
            }
            const elapsed = Date.now() - callStarted;

            assert.ok(isDeadlineOrAbort(rejected), `expected a deadline/timeout-shaped rejection, got: ${(rejected as Error)?.name}: ${(rejected as Error)?.message}`);
            assert.ok(elapsed < 5_000, `bm25Search must reject near its own 2s deadline, not the 10s hold — took ${elapsed}ms`);
            assert.ok(elapsed >= 1_500, `bm25Search rejected suspiciously early (${elapsed}ms) — deadline may not be honoured at all`);

            const counters = await p.__testCounters();
            assert.equal(counters['bm25Search'] ?? 0, 0, 'bm25Search must never have reached native execution — checkGateAborted only increments AFTER the abort check passes');

            await hold; // let the held exclusive() permit release cleanly before teardown
            assert.ok(Date.now() - holdStarted >= 9_900, 'sanity: the hold really did run its full 10s');
        });
    } finally {
        await proxy.close().catch(() => undefined);
        fs.rmSync(home, { recursive: true, force: true });
    }
}

// ── (b): 50 expired calls must not block one later call with a longer budget ─
{
    const { proxy, home } = await newProxy('b');
    try {
        await test('(b) 50 expired 2s-deadline calls never block a later 30s-deadline call, which finishes ~1s after the hold releases', async () => {
            const p = proxy as unknown as {
                __testHold(ms: number): Promise<{ ok: true }>;
                __testCounters(): Promise<Record<string, number>>;
                bm25Search(query: string, limit?: number, filter?: unknown, actorScopes?: unknown, gate?: { deadline?: number }): Promise<unknown>;
            };

            const holdStarted = Date.now();
            const hold = p.__testHold(10_000);
            hold.catch(() => undefined); // see the identical note in section (a)
            await new Promise((r) => setTimeout(r, 100));

            // 50 calls, each given a ~2s deadline from ITS OWN issue time —
            // all of them expire well before the 10s hold releases.
            const expiring = Array.from({ length: 50 }, (_, i) => {
                const issuedAt = Date.now();
                return p.bm25Search(`doc ${i}`, 10, undefined, undefined, { deadline: issuedAt + 2_000 })
                    .then(() => ({ ok: true as const }))
                    .catch((err) => ({ ok: false as const, err }));
            });

            // At ~t=3s (hold still has ~7s left), issue one more call with a
            // generous 30s deadline — it must be admitted as soon as the hold
            // releases, NOT after riding out 50 FIFO slots ahead of it.
            await new Promise((r) => setTimeout(r, 2_900));
            const lateIssuedAt = Date.now();
            const latePromise = p.bm25Search('late query', 10, undefined, undefined, { deadline: lateIssuedAt + 30_000 });

            const expiredResults = await Promise.all(expiring);
            const expiredElapsed = Date.now() - holdStarted;
            for (const r of expiredResults) {
                assert.equal(r.ok, false, 'every 2s-deadline call must reject, never resolve, while the hold is up');
                if (!r.ok) assert.ok(isDeadlineOrAbort(r.err), `expected a deadline-shaped rejection, got: ${(r.err as Error)?.name}: ${(r.err as Error)?.message}`);
            }
            assert.ok(expiredElapsed < 9_000, `all 50 expired calls must have settled well before the 10s hold releases — took ${expiredElapsed}ms from hold start`);

            const late = await latePromise;
            const totalElapsed = Date.now() - holdStarted;
            assert.ok(late !== undefined, 'the late 30s-deadline call must eventually resolve');
            assert.ok(totalElapsed <= 11_500, `the late call should finish within ~1s of the 10s hold releasing, took ${totalElapsed}ms total`);

            const counters = await p.__testCounters();
            assert.equal(counters['bm25Search'] ?? 0, 1, 'exactly one bm25Search (the late, non-expired call) should have reached native execution');

            await hold;
        });
    } finally {
        await proxy.close().catch(() => undefined);
        fs.rmSync(home, { recursive: true, force: true });
    }
}

console.log(failures === 0 ? '\nall assertions passed\n' : `\n${failures} assertion(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
