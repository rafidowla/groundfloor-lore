#!/usr/bin/env tsx
/**
 * verbatim-search-worker-e2e.ts — worker-process isolation for the native search
 * engine (opt-in #4). Proves the whole point: a native-style crash of the store
 * kills only a CHILD process; the supervisor restarts it (self-healing a corrupt
 * index on the way) and the host survives.
 *
 * Runs the real child_process fork path (verbatimSearchWorkerEntry) under the
 * same Node as the test runner (native ABI match — Node 22).
 *
 * Section A — parity: the proxy forwards store/search/bm25/getById/storeBatch to
 *              the worker and returns the same results a direct in-process store
 *              would (deterministic local embeddings).
 * Section B — instanceof: proxy IS-A VerbatimStore (keeps the 5 runtime
 *              instanceof-gated paths working) yet opens no LanceDB in-process.
 * Section C — crash containment: SIGKILL the worker, then a new search SUCCEEDS
 *              (worker restarted) and the HOST is still alive; in-flight calls at
 *              crash time reject retriably rather than crashing the host.
 * Section D — self-heal through a restart: corrupt the index + strand a build
 *              marker, kill the worker, and the restarted worker reopens clean.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { VerbatimStore } = await import('../packages/lore/src/engines/verbatimStore.js');
const { VerbatimSearchWorkerProxy, SearchWorkerRestartError } =
    await import('../packages/lore/src/engines/verbatimSearchWorkerProxy.js');
const { markBuildStart, hasInterruptedBuild } =
    await import('../packages/lore/src/engines/indexIntegrity.js');

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

const ROWS = 300; // > the 256-row index-build threshold
function seedDocs(tag: string) {
    return Array.from({ length: ROWS }, (_, i) => ({
        id: `lore:${tag}-${i}`,
        text: `document ${i} about search indexing, retrieval, embeddings and recovery`,
        metadata: {},
    }));
}

// Give the child a generous ready budget on slower machines (model load).
process.env.LORE_SEARCH_WORKER_READY_MS ??= '90000';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'search-worker-e2e-'));
const LANCEDB_DIR = path.join(HOME, '.lore', 'lancedb');

// ── Section A + B: parity + instanceof ──────────────────────────────────────
console.log('\n=== Section A/B: parity + instanceof (worker forwards correctly) ===\n');

const proxy = new VerbatimSearchWorkerProxy(HOME);

await test('proxy IS-A VerbatimStore (instanceof-gated paths keep working)', () => {
    assert.ok(proxy instanceof VerbatimStore, 'proxy must be an instanceof VerbatimStore');
});

await test('proxy never opens LanceDB in the host process', () => {
    // The host-side base fields stay null — all native work is in the child.
    assert.equal((proxy as unknown as { table: unknown }).table, null, 'no in-process table handle');
    assert.equal((proxy as unknown as { db: unknown }).db, null, 'no in-process db handle');
});

await test('initialize spawns the worker + it becomes ready', async () => {
    await proxy.initialize();
    const pid = (proxy as unknown as { child: { pid?: number } | null }).child?.pid;
    assert.ok(typeof pid === 'number' && pid > 0, 'a worker child process is running');
});

await test('storeBatch + search + bm25 + getById forward and return correct data', async () => {
    await proxy.storeBatch(seedDocs('wk') as never[]);
    await proxy.ensureVectorIndex();
    await proxy.ensureFtsIndex();

    const hits = await proxy.search('search indexing retrieval', 5);
    assert.ok(hits.length > 0, `vector search returns hits (got ${hits.length})`);
    assert.ok(hits.every((h: { id: string }) => h.id.startsWith('lore:wk-')), 'all hits are seeded ids');

    const { hits: kw, ranked: kwRanked } = await proxy.bm25Search('recovery', 5);
    assert.ok(kw.length > 0, `bm25 keyword search returns hits (got ${kw.length})`);
    assert.equal(kwRanked, true, 'the `ranked` signal must survive the child-process IPC boundary as a plain boolean (JSON-safe envelope, not a Symbol-tagged array)');

    const one = await proxy.getById('lore:wk-7');
    assert.ok(one && typeof one.text === 'string' && one.text.includes('document 7'), 'getById round-trips text');
});

await test('parity: proxy keyword result matches a direct in-process store', async () => {
    // Distinctive per-doc token so keyword (BM25) search — which is exact, not
    // approximate like IVF-PQ vector search — has an unambiguous, deterministic
    // top hit in BOTH stores. (Vector top-1 across two independently-built
    // approximate indexes over near-identical docs is legitimately non-
    // deterministic, so it's the wrong thing to assert parity on.)
    const distinctive = Array.from({ length: 50 }, (_, i) => ({
        id: `lore:par-${i}`,
        text: `record ${i} unique-token-${i} about retrieval`,
        metadata: {},
    }));
    const directHome = fs.mkdtempSync(path.join(os.tmpdir(), 'search-worker-direct-'));
    const direct = new VerbatimStore(directHome);
    await direct.initialize();
    await direct.storeBatch(distinctive as never[]);

    const proxyHome2 = fs.mkdtempSync(path.join(os.tmpdir(), 'search-worker-par-'));
    const proxy2 = new VerbatimSearchWorkerProxy(proxyHome2);
    await proxy2.initialize();
    await proxy2.storeBatch(distinctive as never[]);

    const { hits: hitsA, ranked: rankedA } = await proxy2.bm25Search('unique-token-42', 3);
    const { hits: hitsB, ranked: rankedB } = await direct.bm25Search('unique-token-42', 3);
    const [a] = hitsA;
    const [b] = hitsB;
    assert.ok(a && b, 'both stores return a keyword hit');
    assert.equal(a.id, b.id, `same top keyword hit (worker=${a?.id} direct=${b?.id})`);
    assert.equal(a.id, 'lore:par-42', 'top hit is the doc carrying the queried token');
    assert.equal(rankedA, true, 'worker-proxied bm25Search must report ranked:true (native FTS, not the LIKE-scan fallback)');
    assert.equal(rankedA, rankedB, `the ranked signal must be IDENTICAL across the worker boundary vs. direct in-process (worker=${rankedA} direct=${rankedB})`);

    await proxy2.close();
    await direct.close();
    fs.rmSync(directHome, { recursive: true, force: true });
    fs.rmSync(proxyHome2, { recursive: true, force: true });
});


// ── Section C: crash containment ────────────────────────────────────────────
console.log('\n=== Section C: crash containment (SIGKILL worker → host survives, restarts) ===\n');

await test('SIGKILL the worker mid-flight: in-flight rejects retriably, host survives', async () => {
    // Fire a burst, then hard-kill the child to simulate a native abort.
    const inflight = Array.from({ length: 20 }, (_, i) => proxy.search(`indexing ${i}`, 3));
    const pid = (proxy as unknown as { child: { pid?: number } | null }).child?.pid;
    assert.ok(pid, 'have a worker pid to kill');
    process.kill(pid!, 'SIGKILL');

    const results = await Promise.allSettled(inflight);
    // Every call either completed before the kill or rejected retriably — none
    // may take the host down (we're still running to assert this).
    for (const r of results) {
        if (r.status === 'rejected') {
            assert.ok(
                r.reason instanceof SearchWorkerRestartError || /worker/i.test(String(r.reason?.message)),
                `in-flight rejection must be retriable/worker-scoped, got: ${r.reason?.message}`,
            );
        }
    }
    assert.ok(true, 'host process survived the worker crash');
});

await test('after the crash, a new search SUCCEEDS on the restarted worker', async () => {
    // Supervisor auto-respawns; retry briefly to let the new worker finish init.
    let hits: Array<{ id: string }> = [];
    let lastErr: unknown;
    for (let i = 0; i < 30; i++) {
        try {
            hits = await proxy.search('search indexing retrieval', 5);
            if (hits.length > 0) break;
        } catch (err) {
            lastErr = err; // worker still restarting — retriable
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(hits.length > 0, `restarted worker serves search again (last err: ${(lastErr as Error)?.message ?? 'none'})`);
    assert.ok(hits.every((h) => h.id.startsWith('lore:wk-')), 'data survived the restart');
});

// ── Section D: self-heal through a worker restart ───────────────────────────
console.log('\n=== Section D: corrupt index + kill → restarted worker self-heals ===\n');

await test('corrupt the index + strand a marker, kill worker → restart reopens clean', async () => {
    // Simulate a crash mid-index-build: strand a marker + physically corrupt the
    // on-disk index, then hard-kill the worker so it must reopen.
    markBuildStart(LANCEDB_DIR, 'vector');
    markBuildStart(LANCEDB_DIR, 'fts');
    const indicesDir = path.join(LANCEDB_DIR, 'lore_verbatim.lance', '_indices');
    if (fs.existsSync(indicesDir)) {
        for (const f of fs.readdirSync(indicesDir)) {
            const idxDir = path.join(indicesDir, f);
            for (const inner of fs.readdirSync(idxDir)) {
                fs.writeFileSync(path.join(idxDir, inner), 'CORRUPTGARBAGE');
            }
        }
    }
    assert.equal(hasInterruptedBuild(LANCEDB_DIR), true, 'marker stranded before kill');

    const pid = (proxy as unknown as { child: { pid?: number } | null }).child?.pid;
    if (pid) process.kill(pid, 'SIGKILL');

    // The restarted worker's initialize() runs the crash-safe heal. Search must
    // recover (never crash-loop the host).
    let ok = false;
    for (let i = 0; i < 40; i++) {
        try {
            const hits = await proxy.search('search indexing retrieval', 5);
            if (hits.length > 0) { ok = true; break; }
        } catch { /* still restarting/healing — retriable */ }
        await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(ok, 'restarted worker self-healed the corrupt index and serves search');
    assert.equal(hasInterruptedBuild(LANCEDB_DIR), false, 'build markers cleared by the heal');
});

await test('close shuts the worker down cleanly', async () => {
    await proxy.close();
    const child = (proxy as unknown as { child: unknown }).child;
    assert.equal(child, null, 'no child after close');
});
// ── Section E: unranked signal survives the worker boundary ────────────────
console.log('\n=== Section E: unranked/fail-closed signal crosses the worker boundary ===\n');

await test('an empty corpus reports ranked:true (no rows, nothing to disagree with) through the worker proxy', async () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'search-worker-empty-'));
    const proxy3 = new VerbatimSearchWorkerProxy(emptyHome);
    await proxy3.initialize();
    try {
        const { hits, ranked } = await proxy3.bm25Search('anything', 5);
        assert.deepEqual(hits, [], 'no rows stored → no hits');
        assert.equal(ranked, true, 'no table exists yet — trivially empty, not a degraded/unranked result');
    } finally {
        await proxy3.close();
        fs.rmSync(emptyHome, { recursive: true, force: true });
    }
});

await test('a genuine (non-erroring) zero-match query reports ranked:true with empty hits through the worker proxy — does NOT degrade to the LIKE scan', async () => {
    // Post-review fix (2026-08-04): the LIKE-scan fallback used to fire
    // whenever native FTS returned zero rows, regardless of whether that
    // was a real error or just "no match" — the exact perf cliff the
    // fallback comment warns about, moved onto the common no-match path.
    // "the" is an English stopword this store's default tokenizer excludes
    // from the index (removeStopWords:true), so native FTS correctly,
    // successfully finds zero rows for it — even though "the" is a literal
    // substring of the target doc's text below. Falling back to LIKE would
    // resurrect it via raw substring matching, contradicting the
    // tokenizer's own decision. Above minRows so a real index exists
    // (proving this is "index worked, found nothing", not "no index").
    const zeroHome = fs.mkdtempSync(path.join(os.tmpdir(), 'search-worker-zero-'));
    const proxy4 = new VerbatimSearchWorkerProxy(zeroHome);
    await proxy4.initialize();
    try {
        const filler = Array.from({ length: 30 }, (_, i) => ({
            id: `lore:z-${i}`, text: `record number ${i} about widgets`, metadata: {},
        }));
        await proxy4.storeBatch([...filler, { id: 'lore:z-target', text: 'the artifact is a teapot', metadata: {} }] as never[]);
        const { hits, ranked } = await proxy4.bm25Search('the', 5);
        assert.deepEqual(hits, [], '"the" is stopword-excluded from the index — native FTS genuinely finds nothing');
        assert.equal(ranked, true, 'a genuine (non-erroring) zero-match query must report ranked:true, not degrade to the unranked LIKE-scan fallback, across the worker boundary');
    } finally {
        await proxy4.close();
        fs.rmSync(zeroHome, { recursive: true, force: true });
    }
});

await test('the unranked LIKE-scan fallback (triggered by a genuine index error) reports ranked:false (non-empty hits) through the worker proxy', async () => {
    // Post-review fix: the ONLY thing that should trigger the LIKE-scan
    // fallback now is a genuine native-FTS error — simulate that by
    // physically corrupting the on-disk FTS index after it builds, then
    // prove that a non-empty, UNRANKED hit set still carries ranked:false
    // intact across the child-process IPC boundary — the exact case a
    // Symbol-keyed marker could not survive (see verbatimBm25Result.ts's
    // header).
    const fbHome = fs.mkdtempSync(path.join(os.tmpdir(), 'search-worker-fallback-'));
    const proxy5 = new VerbatimSearchWorkerProxy(fbHome);
    await proxy5.initialize();
    try {
        await proxy5.storeBatch(Array.from({ length: 30 }, (_, i) => ({
            id: `lore:fb-${i}`, text: `document number ${i} about quarterly widgets`, metadata: {},
        })) as never[]);
        const indicesDir = path.join(fbHome, '.lore', 'lancedb', 'lore_verbatim.lance', '_indices');
        for (const f of fs.readdirSync(indicesDir)) {
            const idxDir = path.join(indicesDir, f);
            for (const inner of fs.readdirSync(idxDir)) {
                fs.writeFileSync(path.join(idxDir, inner), 'CORRUPTGARBAGE');
            }
        }
        const { hits, ranked } = await proxy5.bm25Search('quarterly', 5);
        assert.ok(hits.length > 0, `expected the LIKE-scan fallback to find the substring hit, got ${hits.length}`);
        assert.ok(hits.every((h: { score: number }) => h.score === 1), 'LIKE-scan hits are unranked — every score forced to 1.0');
        assert.equal(ranked, false, 'ranked must survive the worker boundary as false — the RRF fusion step must exclude this leg rather than treat forced-1.0 scores as a genuine BM25 rank');
    } finally {
        await proxy5.close();
        fs.rmSync(fbHome, { recursive: true, force: true });
    }
});

fs.rmSync(HOME, { recursive: true, force: true });

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
    console.log(`\x1b[31m${failures} test(s) failed\x1b[0m`);
    process.exit(1);
}
console.log('\x1b[32mAll worker-isolation tests passed\x1b[0m');
process.exit(0);
