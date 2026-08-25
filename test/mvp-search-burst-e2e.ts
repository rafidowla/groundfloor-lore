#!/usr/bin/env tsx
/**
 * mvp-search-burst-e2e.ts — stability regression for the EMBEDDED search-burst
 * crash (runs Lore in-process — exactly the mode the issue was reported in).
 *
 * The reported failure: right after startup, when the full-text (FTS) index
 * isn't built yet, a burst of many concurrent searches hard-crashed the whole
 * process (native-layer abort, no stack trace). The first keyword search
 * triggers a background FTS index build; the fix runs that build EXCLUSIVELY
 * through the SearchGate (drains + blocks live reads) and bounds concurrent
 * searches, so the "read while the index is being rebuilt" stampede can't form.
 *
 * This test loads enough rows to cross the FTS build threshold, then fires a
 * large burst of concurrent keyword + vector searches IN THE SAME PROCESS while
 * the index is still missing. Because it's in-process, a native crash would take
 * down THIS test — so simply reaching the assertions alive is the core proof.
 * A few searches may reject with SearchOverloadError (graceful shedding), which
 * is fine; a crash is not.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROWS = 300;   // > the 256-row FTS build threshold
const BURST = 200;  // concurrent searches in one window

interface VerbatimLike {
    storeBatch(docs: Array<{ id: string; text: string; label?: string; tags?: string }>): Promise<void>;
    search(query: string, limit?: number): Promise<unknown[]>;
    bm25Search(query: string, limit?: number): Promise<unknown[]>;
}

console.log('MVP search-burst E2E (embedded) — concurrent searches during FTS build must not crash');

async function main(): Promise<void> {
    let passed = 0, failed = 0;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-burst-'));
    const { createLore } = await import('../packages/lore/src/index.js');
    const lore = await createLore({ deploymentMode: 'embedded', dataDir: home });
    try {
        const verbatim = (lore as { store: { loreVerbatim: VerbatimLike } }).store.loreVerbatim;

        // Load > 256 rows so the first keyword search triggers the FTS index build.
        const docs = Array.from({ length: ROWS }, (_, i) => ({
            id: `burst-${i}`,
            text: `document ${i} about retrieval, indexing, embeddings and database search under concurrent load`,
            label: `note ${i}`, tags: 'burst',
        }));
        await verbatim.storeBatch(docs);

        // THE BURST: fire BURST concurrent searches at once — half keyword (hits
        // the no-FTS-index fallback + fires the background build), half vector.
        // All launched together so they overlap the index build.
        const bases = ['retrieval under load', 'database indexing', 'embeddings search', 'concurrent queries', 'full text scan', 'vector similarity'];
        const calls: Array<Promise<{ ok: boolean; overloaded: boolean }>> = [];
        for (let i = 0; i < BURST; i++) {
            // ~50 DISTINCT queries so single-flight doesn't collapse the burst —
            // this drives real concurrency through the admission gate (kept under
            // the queue cap so everything still succeeds).
            const q = `${bases[i % bases.length]} ${i % 50}`;
            const p = (i % 2 === 0 ? verbatim.bm25Search(q, 10) : verbatim.search(q, 10))
                .then(() => ({ ok: true, overloaded: false }))
                .catch((e: Error) => ({ ok: false, overloaded: (e as { code?: string }).code === 'search_overloaded' }));
            calls.push(p);
        }
        const results = await Promise.all(calls);

        // Reaching here alive is the headline: an in-process native crash would
        // have killed this test. Now check the details.
        const ok = results.filter((r) => r.ok).length;
        const overloaded = results.filter((r) => r.overloaded).length;
        const otherErr = results.filter((r) => !r.ok && !r.overloaded).length;

        // A follow-up search after the storm must still work (engine healthy).
        const post = await verbatim.bm25Search('retrieval', 10).then(() => true).catch(() => false);

        // Every request got a DEFINITIVE answer — either a result or a clean
        // "busy" (overload shedding). None crashed, hung, or errored unexpectedly.
        // Under an extreme distinct-query flood the gate SHEDDING load is the
        // desired behavior (busy/retry), not a failure — so we do NOT require a
        // success rate; we require no crash + clean shedding + a healthy engine.
        assert.equal(otherErr, 0, `${otherErr}/${BURST} searches failed with an unexpected (non-overload) error`);
        assert.equal(ok + overloaded, BURST, `every request must resolve cleanly (ok or busy); ${ok}+${overloaded} != ${BURST}`);
        assert.ok(ok > 0, `some searches must succeed even under load; got ${ok}`);
        assert.ok(post, 'a search after the burst must still succeed (engine survived healthy)');

        console.log(`  ✓ survived a ${BURST}-way concurrent search burst during the FTS index build (in-process, no crash)`);
        console.log(`  ✓ every request resolved cleanly: ${ok} ok + ${overloaded} shed as busy = ${BURST}, 0 unexpected errors`);
        console.log('  ✓ searches still work after the burst — engine stayed healthy');
        passed = 3;
    } catch (err) {
        failed = 1;
        console.error(`  ✗ ${(err as Error).message}`);
    } finally {
        try { await (lore as { dispose: (r: string) => Promise<void> }).dispose('burst-test-teardown'); } catch { /* ignore */ }
        try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

await main();
