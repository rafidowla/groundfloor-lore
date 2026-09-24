#!/usr/bin/env tsx
/**
 * test/verbatim-search-flight-cancellation-unit.ts — 3.20.2 review, finding 1
 * (BLOCKING): cross-caller cancellation bleed via VerbatimStore's search
 * single-flight cache.
 *
 * THE ACTUAL PRE-FIX MECHANISM (confirmed by reading the reviewed commit's
 * own code, 46a5c7f2222fea11e12a15d2c72c92d249c325fb): `cachedRead()`'s
 * single-flight promise is the literal return value of
 * `searchGate.read(fn, { signal: <the FIRST caller's own gate.signal> })`.
 * Every OTHER caller who joins the same in-flight query (`if (inFlight)
 * return inFlight;`) gets that exact same promise — including the searchGate
 * wait it's tied to. So while the shared call is still QUEUED behind
 * SearchGate (no free permit), aborting the FIRST caller's own signal removes
 * that ONE queued waiter and rejects the shared `searchGate.read()` promise —
 * which is the SAME promise every joined caller (who supplied no signal of
 * their own, or a signal that never fired) is also awaiting. They reject too,
 * even though nothing THEY asked for ever fired. (`gate.deadline` is not a
 * live timer at this layer at all pre-fix — it's a synchronous check made
 * once, at the moment a permit is granted — so only the AbortSignal path
 * actually demonstrates the live, in-flight cross-caller bleed; seeing that
 * clearly is itself part of why this needed a real repro rather than
 * inspection alone.)
 *
 * This test proves the fix (a reference-counted `SearchFlight` whose shared
 * native work is tied to its OWN controller, aborted only once every joined
 * caller has individually given up — never to any single caller's own
 * signal) for BOTH bm25Search and search(), the two call sites review
 * finding 1 flagged as affected ("reproduced 3 ways" — the three cached
 * methods sharing this one mechanism; searchByVector shares the identical
 * `cachedRead` body, so it is not re-proven a third time here).
 *
 * Mechanism used to force a genuine QUEUED wait: `__testHold()` takes the
 * search gate's EXCLUSIVE permit for the hold's duration (the same
 * test-only hook test/search-worker-deadline-cancel-e2e.ts uses through the
 * worker-process boundary; here it's exercised directly, in-process).
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; },
            (err: Error) => { console.error(`  \x1b[31m✗ ${name}\x1b[0m\n    ${err.stack ?? err.message}`); failed++; },
        );
}

/** Resolves 'settled' if `p` settles within `ms`, otherwise 'pending' — used
 *  to prove a joined caller is NOT collaterally rejected the instant a
 *  different caller's own cancellation fires. */
async function settleStateAfter<T>(p: Promise<T>, ms: number): Promise<'settled' | 'pending'> {
    const sentinel = Symbol('pending');
    const raced = await Promise.race([
        p.then(() => 'settled' as const, () => 'settled' as const),
        new Promise<typeof sentinel>((r) => setTimeout(() => r(sentinel), ms)),
    ]);
    return raced === sentinel ? 'pending' : 'settled';
}

async function seed(store: VerbatimStore, tag: string): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await store.store({
            id: `flight-${tag}-${i}`,
            text: `alpha bravo charlie document ${tag} ${i}`,
            metadata: {
                type: 'note', label: `Seed ${tag} ${i}`, tags: 'seed',
                project: '*', ecosystem: '*',
                updatedAt: new Date().toISOString(), security_scopes: [],
            },
        });
    }
}

/** Each sub-test gets its OWN store/tmp-dir and unconditionally drains its
 *  own exclusive hold + both calls in a `finally`, regardless of whether the
 *  test's assertions passed — so a failure in one sub-test (expected,
 *  against pre-fix code) can never leave a queued waiter or a still-running
 *  hold to pollute a later sub-test's gate-stats() reading. Sharing one
 *  store across sub-tests bit us exactly this way during development: sub-1
 *  failing before draining its hold left sub-2 racing a leftover queued
 *  waiter, which made sub-2 fail for a spurious reason unrelated to finding 1. */
async function withFreshStore(fn: (store: VerbatimStore) => Promise<void>): Promise<void> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-flight-cancel-'));
    const store = new VerbatimStore(tmp, new LocalEmbeddingProvider());
    try {
        await store.initialize();
        await seed(store, 'x');
        await fn(store);
    } finally {
        await store.close().catch(() => undefined);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

async function run() {
    console.log('\n=== 3.20.2 review, finding 1 (BLOCKING): single-flight cross-caller cancellation bleed ===\n');

    await test('bm25Search: caller A aborts while the shared query is still QUEUED; caller B (no signal of its own), joined to the same flight, is unaffected and later resolves with the real result', async () => {
        await withFreshStore(async (store) => {
            const holdMs = 3_000;
            const hold = store.__testHold(holdMs);
            hold.catch(() => undefined); // best-effort; see the identical note in the e2e test
            await new Promise((r) => setTimeout(r, 100)); // let the hold actually take the exclusive permit

            const query = 'alpha bravo bm25-flight';
            const controllerA = new AbortController();
            const callA = store.bm25Search(query, 10, undefined, undefined, { signal: controllerA.signal });
            const callB = store.bm25Search(query, 10, undefined, undefined, undefined);
            callA.catch(() => undefined);
            callB.catch(() => undefined);

            try {
                // Confirm both are genuinely joined to ONE queued waiter (not
                // two independent calls) before aborting — otherwise this
                // proves nothing about cross-caller sharing.
                await new Promise((r) => setTimeout(r, 50));
                const gateStats = (store as unknown as { searchGate: { stats(): { queued: number } } }).searchGate.stats();
                assert.equal(gateStats.queued, 1, 'bm25Search(A) and bm25Search(B) must share ONE queued searchGate waiter (same cache key) — otherwise this test is vacuous');

                controllerA.abort(new Error('caller A gave up while queued'));
                let aRejected: unknown;
                try { await callA; assert.fail('caller A should reject on its own abort'); }
                catch (err) { aRejected = err; }
                assert.match((aRejected as Error).message, /caller A gave up while queued/, `expected A's own abort reason, got: ${(aRejected as Error)?.message}`);

                // THE ACTUAL FINDING-1 ASSERTION: caller B must still be
                // waiting — not collaterally rejected by A's abort — this is
                // exactly the cross-caller bleed the review reproduced.
                const bState = await settleStateAfter(callB, 200);
                assert.equal(bState, 'pending', 'caller B must NOT be rejected by caller A\'s own abort — this is the cross-caller bleed review finding 1 describes');

                await hold; // let the exclusive permit release so the queued call can finally run
                const bResult = await callB as { hits: unknown[] };
                assert.ok(Array.isArray(bResult.hits) && bResult.hits.length > 0, 'caller B must eventually resolve with the real bm25 result once admitted');
            } finally {
                // Unconditionally drain, so a failed assertion above never
                // leaves this store's gate holding a permit or a queued
                // waiter for anything else run afterwards.
                await hold.catch(() => undefined);
                await callA.catch(() => undefined);
                await callB.catch(() => undefined);
            }
        });
    });

    await test('search() (semantic): the same cross-caller bleed does not occur — caller B is unaffected by caller A\'s abort and resolves with real hits', async () => {
        await withFreshStore(async (store) => {
            const holdMs = 3_000;
            const hold = store.__testHold(holdMs);
            hold.catch(() => undefined);
            await new Promise((r) => setTimeout(r, 100));

            const query = 'alpha bravo semantic-flight';
            const controllerA = new AbortController();
            // search(query, limit, filter, opts, actorScopes, gate)
            const callA = store.search(query, 10, undefined, undefined, undefined, { signal: controllerA.signal });
            const callB = store.search(query, 10, undefined, undefined, undefined, undefined);
            callA.catch(() => undefined);
            callB.catch(() => undefined);

            try {
                await new Promise((r) => setTimeout(r, 50));
                const gateStats = (store as unknown as { searchGate: { stats(): { queued: number } } }).searchGate.stats();
                assert.equal(gateStats.queued, 1, 'search(A) and search(B) must share ONE queued searchGate waiter (same cache key)');

                controllerA.abort(new Error('caller A gave up while queued (search)'));
                let aRejected: unknown;
                try { await callA; assert.fail('caller A should reject on its own abort'); }
                catch (err) { aRejected = err; }
                assert.match((aRejected as Error).message, /caller A gave up while queued \(search\)/, `expected A's own abort reason, got: ${(aRejected as Error)?.message}`);

                const bState = await settleStateAfter(callB, 200);
                assert.equal(bState, 'pending', 'caller B must NOT be rejected by caller A\'s own abort (search())');

                await hold;
                const bResult = await callB as unknown[];
                assert.ok(Array.isArray(bResult) && bResult.length > 0, 'caller B must eventually resolve with real search hits once admitted');
            } finally {
                await hold.catch(() => undefined);
                await callA.catch(() => undefined);
                await callB.catch(() => undefined);
            }
        });
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
