#!/usr/bin/env tsx
/**
 * recall-signal-abort-unit.ts — Atlas pass-test (c) for the 3.20.2 defect-1
 * fix ("a timed-out search-worker call is never cancelled"), requirement 3:
 * public entry points take an optional `{ signal }`.
 *
 * Exercises the REAL exported `inProcessRecall()` (packages/lore/src/recall/
 * inProcessRecall.ts) against two scenarios:
 *
 *   (c1) Signal already aborted before the call — must reject synchronously
 *        (well, on a microtask) WITHOUT ever touching `deps` at all. Proven
 *        with a `deps` stub whose every field throws if read/called.
 *
 *   (c2) Signal aborted WHILE queued/in flight — `retrieve()`'s keyword path
 *        calls `graph.search(...)` (see retrieve.ts); a minimal `loreGraph`
 *        mock holds that call open indefinitely (a controllable deferred,
 *        the same pattern search-gate-unit.ts uses for the SearchGate
 *        primitive itself). Aborting mid-flight must reject the OUTER
 *        `inProcessRecall()` promise immediately — proven by elapsed time
 *        staying near-zero while the mock's deferred is still unresolved —
 *        matching `RecallOpts.signal`'s documented "light-touch: rejects the
 *        outer promise immediately" contract (it deliberately does NOT
 *        interrupt the native call already under way inside retrieve() —
 *        that half of requirement 3's guarantee, i.e. that an abandoned
 *        waiter is actually REMOVED from the search gate's FIFO queue, is
 *        covered independently and more directly at the SearchGate layer by
 *        test/search-gate-unit.ts's two "aborted queued ... is removed
 *        immediately" tests and by R1 in
 *        test/search-worker-cancellation-repro-unit.ts — this test does not
 *        re-prove that lower-layer guarantee, only the public-API contract
 *        that sits on top of it. See openIssues in the defect-1 patch notes
 *        for why that split is deliberate, not a gap.)
 *
 * `searchMode: 'keyword'` is used deliberately for (c2): retrieve() only
 * calls `resolveSeedStore()` (and therefore `ctx.store.storageClient`) when
 * mode !== 'keyword' (see retrieve.ts), so a keyword-mode call never touches
 * `storageClient` at all — the mock needs to implement only `loreGraph`.
 */

import assert from 'node:assert/strict';

const { inProcessRecall } = await import('../packages/lore/src/recall/inProcessRecall.js');

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

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

console.log('\n=== Defect 1 fix: recall() honours an optional AbortSignal (requirement 3) ===\n');

await test('(c1) an already-aborted signal rejects inProcessRecall() immediately, without touching deps', async () => {
    const untouchable = new Proxy({}, {
        get(): never { throw new Error('deps must not be read at all once the signal is already aborted'); },
    });
    const controller = new AbortController();
    controller.abort(new Error('caller gave up before calling recall'));

    await assert.rejects(
        inProcessRecall('anything', { workspace: 'default', signal: controller.signal }, untouchable as never),
        /caller gave up before calling recall/,
        'an already-aborted signal must reject with the abort reason, before deps is ever read',
    );
});

await test('(c2) aborting while retrieve() is still in flight rejects the outer promise immediately, not after the pending search settles', async () => {
    const searchGate = deferred<never>();
    let searchCalls = 0;
    const loreGraph = {
        search: (..._args: unknown[]) => {
            searchCalls += 1;
            return searchGate.promise; // never resolves until we release it below
        },
        getNodesByIds: async () => new Map(),
        traverse: async () => [],
    };
    // Minimal StorageBundle-shaped stub. 3.21 step 3(a) (see
    // recall/retrieveSeedStore.ts) resolves a seed store for EVERY mode now,
    // including 'keyword', and calls its cheap `count()` to decide whether to
    // run a vector seed pass at all — that alone is not an embedding call and
    // is expected here (`verbatimCount` below resolves to 0, so
    // `verbatimConsulted` stays false and retrieve() falls through to the
    // graph-keyword path exactly as this test expects). What must still never
    // happen for `searchMode:'keyword'` is the actual semantic/BM25 query —
    // `verbatimSearch`/`verbatimBm25Search` deliberately still throw, so a
    // regression that made keyword mode consult the vector/BM25 index itself
    // is still caught here, not papered over.
    const store = {
        loreGraph,
        storageClient: {
            verbatimCount: async () => 0,
            verbatimSearch: (): never => { throw new Error('keyword mode must never call verbatimSearch'); },
            verbatimBm25Search: (): never => { throw new Error('keyword mode must never call verbatimBm25Search'); },
        },
        sessionCache: { pushNode: () => undefined },
    };

    const controller = new AbortController();
    const started = Date.now();
    const p = inProcessRecall(
        'alpha bravo',
        { workspace: 'default', searchMode: 'keyword', signal: controller.signal },
        { store: store as never },
    );
    // Never leave a promise racing a mock that may resolve much later
    // unhandled if an assertion below throws first.
    p.catch(() => undefined);

    // Give retrieve() a real microtask/tick to actually reach graph.search()
    // before we abort — otherwise a pass here would be vacuous (aborting
    // before any work started proves nothing about in-flight cancellation).
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(searchCalls, 1, 'retrieve() must have already reached graph.search() (i.e. genuinely be "in flight") before we abort');

    controller.abort(new Error('caller gave up while queued'));
    await assert.rejects(p, /caller gave up while queued/, 'an in-flight abort must reject the outer recall promise with the abort reason');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `abort must reject near-immediately, not wait for the pending search — took ${elapsed}ms`);

    // Let the abandoned mock search settle so nothing is left dangling; safe
    // because inProcessRecall's own signal-race wrapper already attaches a
    // handler to `work` regardless of which side of the race wins (see its
    // `work.then(...)` in inProcessRecall.ts) — this does not resurface as a
    // second, unhandled settlement of `p` itself.
    searchGate.resolve(undefined as never);
});

console.log(failures === 0 ? '\nall assertions passed\n' : `\n${failures} assertion(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
