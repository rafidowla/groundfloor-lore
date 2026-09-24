#!/usr/bin/env tsx
/**
 * test/verbatim-close-concurrent-write-stress-unit.ts — STEP2-CLOSE-PATH-DESIGN.md (a).
 *
 * The one real hazard the write-drain (engines/verbatimWriteGate.ts) exists to
 * prevent: a write mid-`await` on `this.table` when `close()` calls the native
 * `table.close()`/`db.close()` is a documented use-after-close SIGSEGV class on
 * darwin-arm64 (audit `conc-close-does-not-drain-inflight-reads`, the read-side
 * sibling of this exact bug). test/verbatim-close-releases-natives-unit.ts
 * proves the drain's ORDERING against stubbed handles; this proves the real
 * native LanceDB library does not crash the process under load, on THIS
 * darwin-arm64 box, across many iterations.
 *
 * Deliberately NOT in the main `npm test` chain (same reasoning as
 * test:unit:memory-open-close-cycles in docs/PERFORMANCE-MEMORY.md §5): it
 * drives real concurrent LanceDB writes racing a real close() many times,
 * which is slow and, if it ever DID find a crash, would abort the whole test
 * chain with process death rather than a clean failure. Run directly:
 *
 *   npx tsx test/verbatim-close-concurrent-write-stress-unit.ts
 *   npm run test:unit:verbatim-close-concurrent-stress
 *
 * A native crash exits the process non-zero with no further test output —
 * that IS the failure signal for this file; there is no way to catch a
 * SIGSEGV from JS.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

const ITERATIONS = Number(process.env.LORE_STRESS_ITERATIONS ?? 25);
const WRITES_PER_ITERATION = 12;

/** Deterministic, instant fake embedder — the point of this stress test is
 *  the LanceDB open/write/close race, not embedding latency. */
function fakeEmbeddingProvider(dim = 8): EmbeddingProvider {
    const vec = () => Array.from({ length: dim }, () => Math.random());
    return {
        modelId: 'stress-fake',
        dimension: dim,
        async initialize() { /* no-op */ },
        async embed() { return vec(); },
        async embedDocument() { return vec(); },
        async embedQuery() { return vec(); },
        async embedDocumentBatch(texts: string[]) { return texts.map(() => vec()); },
    };
}

let passed = 0;
let failed = 0;
let crashed = false;

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

process.on('uncaughtException', (err) => {
    // A real native crash bypasses this handler entirely (SIGSEGV kills the
    // process outright) — this only catches a JS-level throw that escaped
    // every await, which is itself a bug this stress test should report.
    console.error('[stress] uncaughtException — treating as a stress-test failure:', err);
    crashed = true;
});

console.log(`\nVerbatimStore — concurrent writes racing close() (${ITERATIONS} iterations, darwin-arm64)\n`);

await test(`${ITERATIONS} iterations of concurrent writes racing close() never crash the process`, async () => {
    for (let iter = 0; iter < ITERATIONS; iter++) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lore-verbatim-stress-${iter}-`));
        try {
            const store = new VerbatimStore(dir, fakeEmbeddingProvider());
            await store.initialize();

            // Fire a burst of concurrent writes, then close() WITHOUT
            // awaiting the burst first — this is the actual race: some
            // writes are still mid-flight (embed resolved instantly above,
            // but the LanceDB table.add/mergeInsert call itself is async)
            // when close() starts draining.
            const writes: Promise<void>[] = [];
            for (let i = 0; i < WRITES_PER_ITERATION; i++) {
                writes.push(store.store({
                    id: `stress:${iter}:${i}`,
                    text: `stress test document ${iter}-${i}`,
                    metadata: { type: 'note', project: 'stress', ecosystem: 'test' },
                }).catch((err) => {
                    // A write losing a benign race (e.g. against a
                    // concurrent identical id) is not what this test is
                    // about — only a hang or a native crash is.
                    console.error(`[stress] iter ${iter} write ${i} rejected (non-fatal for this test): ${(err as Error).message}`);
                }));
            }
            // Close concurrently with the in-flight writes — the drain
            // must make this safe.
            await Promise.all([...writes, store.close()]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    assert.equal(crashed, false, 'no uncaughtException fired during the stress run');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0 || crashed) process.exit(1);
