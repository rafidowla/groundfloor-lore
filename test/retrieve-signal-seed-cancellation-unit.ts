#!/usr/bin/env tsx
/**
 * test/retrieve-signal-seed-cancellation-unit.ts — fix/search-worker-call-
 * cancellation (3.20.2 follow-up): proves `RecallOpts.signal` /
 * `RetrieveOptions.signal` is genuinely threaded all the way down into the
 * seed store's search()/bm25Search() calls, not just raced against the OUTER
 * `inProcessRecall()` promise.
 *
 * THE GAP THIS CLOSES: before this follow-up, aborting a recall() call made
 * the caller's own promise reject (inProcessRecall() already raced the outer
 * promise against opts.signal), but the real native search kept running
 * inside retrieve() → resolveSeedStore() → LoreStorageClient.verbatimSearch/
 * verbatimBm25Search → VerbatimStore.search/bm25Search, continuing to hold or
 * queue on the shared SearchGate until it finished on its own. So an aborted
 * caller stopped waiting, but never freed the worker slot it was consuming.
 *
 * These tests are driven from the PUBLIC `inProcessRecall()` entry point
 * (the same function `lore.recall()` calls), through a REAL `VerbatimStore`
 * (with its real, private `SearchGate`/`SearchFlight`), so they exercise the
 * actual admission/queue path end to end — not just a mock at the top-level
 * API boundary. `graph`/`sessionCache` are lightweight stand-ins (retrieve()
 * only touches search/getNodesByIds/traverse/getNode/pushNode on them; none
 * of those are the thing under test), but the vector store, its facade
 * (`LoreStorageClient`), and its `SearchGate` are all the real production
 * classes.
 *
 * `__testHold()` / `__testCounters()` require LORE_TEST_WORKER_HOOKS=1 (set
 * below, before any VerbatimStore is constructed).
 */

process.env.LORE_TEST_WORKER_HOOKS = '1';

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import { LoreStorageClient } from '../packages/lore/src/storage/loreStorageClient.js';
import { inProcessRecall } from '../packages/lore/src/recall/inProcessRecall.js';
import { retrieve } from '../packages/lore/src/recall/retrieve.js';
import type { StorageBundle } from '../packages/lore/src/mcp/services.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

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

/** Resolves 'settled' if `p` settles within `ms`, otherwise 'pending' —
 *  mirrors the identical helper in verbatim-search-flight-cancellation-unit.ts. */
async function settleStateAfter<T>(p: Promise<T>, ms: number): Promise<'settled' | 'pending'> {
    const sentinel = Symbol('pending');
    const raced = await Promise.race([
        p.then(() => 'settled' as const, () => 'settled' as const),
        new Promise<typeof sentinel>((r) => setTimeout(() => r(sentinel), ms)),
    ]);
    return raced === sentinel ? 'pending' : 'settled';
}

async function seedVerbatim(store: VerbatimStore, tag: string): Promise<LoreNode[]> {
    const nodes: LoreNode[] = [];
    for (let i = 0; i < 5; i++) {
        const id = `flight-${tag}-${i}`;
        await store.store({
            id,
            text: `alpha bravo charlie document ${tag} ${i}`,
            metadata: {
                type: 'note', label: `Seed ${tag} ${i}`, tags: 'seed',
                project: '*', ecosystem: '*',
                updatedAt: new Date().toISOString(), security_scopes: [],
            },
        });
        nodes.push({
            id,
            type: 'note',
            label: `Seed ${tag} ${i}`,
            content: `alpha bravo charlie document ${tag} ${i}`,
            tags: [],
            project: '*',
            ecosystem: '*',
            metadata: '{}',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            syncedAt: null,
            security_scopes: [],
        });
    }
    return nodes;
}

/** Minimal stand-in for the graph handle retrieve()/recallPreset touch:
 *  search() (keyword path — returns nothing extra so it can never mask a
 *  vector-seed regression), getNodesByIds() (hydrates the real vector seed
 *  ids into real LoreNodes), traverse() (unused — every test below passes
 *  depth: 0), getNode() (recallPreset's auto-escalate path, only reached at
 *  very high topScore; included defensively). */
function fakeGraph(nodes: LoreNode[]) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return {
        async search() { return []; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, LoreNode>();
            for (const id of ids) { const n = byId.get(id); if (n) m.set(id, n); }
            return m;
        },
        async traverse() { return []; },
        async getNode(id: string) { return byId.get(id) ?? null; },
        // recallPreset's deferred-sidecar scan (findDeferredMatches ->
        // scanDeferredNodes) falls back to this portable listNodes() scan
        // when the graph doesn't support its paged variant — return no
        // rows, so it never contributes deferred matches in these tests.
        async listNodes() { return []; },
    };
}

function fakeSessionCache() {
    return { pushNode() { /* no-op */ }, getHotContext() { return []; }, flushNow: async () => undefined };
}

/** Builds a real VerbatimStore + real LoreStorageClient.fromLocal(...) (the
 *  exact facade retrieve()'s resolveSeedStore() calls for the boot/active
 *  workspace path) wired into a minimal-but-real RetrieveContext-shaped
 *  StorageBundle. Each sub-test gets its own tmp dir/store so a failed
 *  assertion in one can never leave a queued waiter polluting another. */
async function withFreshCtx(
    fn: (store: VerbatimStore, deps: { store: StorageBundle }) => Promise<void>,
): Promise<void> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-retrieve-signal-'));
    const store = new VerbatimStore(tmp, new LocalEmbeddingProvider());
    try {
        await store.initialize();
        const nodes = await seedVerbatim(store, 'x');
        const storageClient = LoreStorageClient.fromLocal({
            graph: {} as unknown as Parameters<typeof LoreStorageClient.fromLocal>[0]['graph'],
            verbatim: store as unknown as Parameters<typeof LoreStorageClient.fromLocal>[0]['verbatim'],
        });
        const bundle = {
            sdk: null,
            loreGraph: fakeGraph(nodes),
            loreVerbatim: store,
            sessionCache: fakeSessionCache(),
            storageClient,
        } as unknown as StorageBundle;
        await fn(store, { store: bundle });
    } finally {
        await store.close().catch(() => undefined);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

async function run() {
    console.log('\n=== fix/search-worker-call-cancellation (3.20.2 follow-up): signal reaches seed-store search calls ===\n');

    await test('inProcessRecall(): aborting a queued call frees the SearchGate slot — the queue actually shrinks, not just the caller\'s own wait', async () => {
        await withFreshCtx(async (store, deps) => {
            const holdMs = 3_000;
            const hold = store.__testHold(holdMs);
            hold.catch(() => undefined);
            await new Promise((r) => setTimeout(r, 100)); // let the hold take the exclusive permit

            const controllerA = new AbortController();
            const call = inProcessRecall('alpha bravo charlie', {
                workspace: 'default', searchMode: 'semantic', depth: 0, max: 5,
                signal: controllerA.signal,
            }, deps);
            call.catch(() => undefined);

            try {
                await new Promise((r) => setTimeout(r, 50));
                const statsBefore = (store as unknown as { searchGate: { stats(): { queued: number } } }).searchGate.stats();
                assert.equal(statsBefore.queued, 1, 'the recall\'s own seed search must be genuinely queued behind the held exclusive permit — otherwise this proves nothing about the gate');

                controllerA.abort(new Error('caller gave up while queued'));
                await assert.rejects(call, /caller gave up while queued/, 'inProcessRecall() must reject on its own signal aborting');

                // Give the abort's rejection a tick to propagate down through
                // resolveSeedStore -> verbatimSearch -> VerbatimStore.search's
                // own searchGate.read({signal}) waiter removal.
                await new Promise((r) => setTimeout(r, 20));
                const statsAfter = (store as unknown as { searchGate: { stats(): { queued: number } } }).searchGate.stats();
                assert.equal(statsAfter.queued, 0, 'THE FIX: the SearchGate queue must shrink back to 0 once the signal reaches the real seed-store search() call — pre-fix, the signal never reached this layer, so the native call kept queuing/running after the caller gave up');
            } finally {
                await hold.catch(() => undefined);
                await call.catch(() => undefined);
            }
        });
    });

    await test('inProcessRecall(): aborting caller A while B still references the same shared query does NOT free the gate slot (no bleed) — but once BOTH A and B abort, the shared work IS actually cancelled (refcount-to-zero), driven from the top', async () => {
        await withFreshCtx(async (store, deps) => {
            const holdMs = 3_000;
            const hold = store.__testHold(holdMs);
            hold.catch(() => undefined);
            await new Promise((r) => setTimeout(r, 100));

            const topic = 'alpha bravo charlie shared-flight';
            const controllerA = new AbortController();
            const controllerB = new AbortController();
            const callA = inProcessRecall(topic, {
                workspace: 'default', searchMode: 'semantic', depth: 0, max: 5,
                signal: controllerA.signal,
            }, deps);
            const callB = inProcessRecall(topic, {
                workspace: 'default', searchMode: 'semantic', depth: 0, max: 5,
                signal: controllerB.signal,
            }, deps);
            callA.catch(() => undefined);
            callB.catch(() => undefined);

            try {
                await new Promise((r) => setTimeout(r, 50));
                const statsShared = (store as unknown as { searchGate: { stats(): { queued: number } } }).searchGate.stats();
                assert.equal(statsShared.queued, 1, 'callA and callB must share ONE queued searchGate waiter (identical query/limit/filter -> same single-flight cache key) — otherwise this test is vacuous');

                // A gives up. B still wants the result: the shared native work
                // must NOT be torn down out from under B (the cross-caller
                // bleed review finding 1 fixed at the VerbatimStore layer) —
                // now proven reachable/preserved through inProcessRecall().
                controllerA.abort(new Error('caller A gave up'));
                await assert.rejects(callA, /caller A gave up/, 'caller A must reject on its own abort');

                const bState = await settleStateAfter(callB, 150);
                assert.equal(bState, 'pending', 'caller B must NOT be collaterally rejected by caller A\'s own abort while B still references the shared flight');

                await new Promise((r) => setTimeout(r, 20));
                const statsAfterA = (store as unknown as { searchGate: { stats(): { queued: number } } }).searchGate.stats();
                assert.equal(statsAfterA.queued, 1, 'the shared waiter must still be queued after ONLY A aborts — B still holds a reference, so the underlying work must stay alive for B');

                // B now ALSO gives up — the LAST reference is gone. THE FIX:
                // this is the case that requires the signal to have actually
                // reached VerbatimStore's own SearchFlight/SearchGate waiter;
                // pre-fix, no signal from either caller ever reached this
                // layer at all, so the waiter could never be freed by any
                // caller's abort — only the hold's own timer released it.
                controllerB.abort(new Error('caller B gave up too'));
                await assert.rejects(callB, /caller B gave up too/, 'caller B must reject on its own abort');

                await new Promise((r) => setTimeout(r, 20));
                const statsAfterBoth = (store as unknown as { searchGate: { stats(): { queued: number } } }).searchGate.stats();
                assert.equal(statsAfterBoth.queued, 0, 'THE FIX: once EVERY referencing caller has aborted, the shared queued waiter must actually be freed — pre-fix nothing ever reached this layer, so the waiter stayed queued regardless of how many callers gave up');
            } finally {
                await hold.catch(() => undefined);
                await callA.catch(() => undefined);
                await callB.catch(() => undefined);
            }
        });
    });

    await test('retrieve(): a signal already aborted before the call starts short-circuits inside retrieveInner() itself — resolveSeedStore()/the seed store are never even reached, not merely aborted once reached', async () => {
        await withFreshCtx(async (store, deps) => {
            const controller = new AbortController();
            controller.abort(new Error('aborted before start'));

            // Driven through retrieve() directly (not inProcessRecall()) so
            // this specifically exercises retrieveInner()'s OWN eager check
            // (added by this follow-up) rather than inProcessRecall()'s
            // pre-existing outer-promise race, which already short-circuited
            // before ever calling retrieve() and would make this assertion
            // pass even without retrieveInner()'s own check.
            const ctx = { store: deps.store };

            // THE MASKING PROBLEM THIS SPY CLOSES (independent review,
            // 3.20.2 follow-up): asserting only `__testCounters().search ===
            // 0` / `.bm25Search === 0` does NOT pin retrieveInner()'s own
            // eager check — cachedRead()'s OWN buildOwnAbort() short-circuit
            // (verbatimStore.ts) throws before ever calling searchGate/
            // checkGateAborted whenever the `gate` it receives is already
            // aborted, which is exactly what resolveSeedStore()'s `gate =
            // signal ? { signal } : undefined` bakes into search()/
            // bm25Search() regardless of whether retrieveInner()'s eager
            // check exists. Confirmed by deleting the eager-check line from
            // retrieve.ts: the old test 3 stayed green — `counters.search`/
            // `.bm25Search` were still 0, satisfied by cachedRead()'s own
            // check one layer down, not by the thing under test.
            //
            // `verbatimCount()` is the discriminator: unlike search()/
            // bm25Search(), it takes no `gate` at all (see
            // storageClient.verbatimCount / VerbatimStore.count()), so
            // cachedRead()'s abort short-circuit can NEVER cover it — the
            // ONLY thing that can stop it from running is retrieveInner()'s
            // own `if (signal?.aborted) throw ...` firing before
            // resolveSeedStore()'s result is ever probed with
            // `seedStore.count()`. So: eager check present -> 0 calls; eager
            // check absent -> resolveSeedStore() would return a real seed
            // store and retrieveInner() would call `seedStore.count()`
            // unconditionally (verbatimConsulted check, before any
            // gated search/bm25Search call) -> 1+ calls. This is exactly the
            // "no seed-store work happens before the eager check" property
            // finding 2 asked for, expressed as something cachedRead's own
            // check structurally cannot also satisfy.
            const storageClient = deps.store.storageClient as unknown as {
                verbatimCount: (...args: unknown[]) => Promise<number>;
            };
            const originalVerbatimCount = storageClient.verbatimCount.bind(storageClient);
            let verbatimCountCalls = 0;
            storageClient.verbatimCount = async (...args: unknown[]) => {
                verbatimCountCalls++;
                return originalVerbatimCount(...args);
            };

            const call = retrieve(ctx, 'alpha bravo charlie', {
                workspace: 'default', mode: 'hybrid', depth: 0, limit: 5,
                signal: controller.signal,
            });

            await assert.rejects(call, /aborted before start/, 'an already-aborted signal must reject immediately with its own reason, before any seed-store work starts');

            assert.equal(verbatimCountCalls, 0, 'THE FIX UNDER TEST: retrieveInner()\'s eager check must fire before resolveSeedStore()\'s store is ever probed — verbatimCount() takes no gate at all, so only the eager check (not cachedRead\'s independent abort short-circuit, which never applies to an ungated call) can be responsible for zero calls here');

            // Kept as a secondary sanity check — NOT the property this test
            // pins (see the note above: these alone pass even without the
            // eager check, because cachedRead()'s own short-circuit also
            // yields zero).
            const counters = store.__testCounters();
            assert.equal(counters.search ?? 0, 0, 'sanity: eager abort also means VerbatimStore.search() never runs');
            assert.equal(counters.bm25Search ?? 0, 0, 'sanity: eager abort also means VerbatimStore.bm25Search() never runs');
        });
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
