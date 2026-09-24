#!/usr/bin/env tsx
/**
 * search-worker-cancellation-repro-unit.ts — DIAGNOSTIC repro for the
 * 3.20.2 P1 "timed-out search-worker call is never cancelled" defect.
 *
 * R1 originally proved the pre-fix defect (a queued SearchGate waiter could
 * never be removed). Now that fix/search-worker-call-cancellation has
 * shipped cancellable acquire()/read()/exclusive(), R1 is INVERTED to prove
 * the fix instead: it was a failing assertion before the fix (an abandoned
 * waiter ran anyway) and is a passing assertion after it (an aborted waiter
 * is removed and never runs, and the queue returns to 0 — Atlas pass-test
 * (c) at the SearchGate layer).
 *
 *   R1  A caller that aborts its own signal while queued behind a held
 *       exclusive() is removed from the queue immediately — it never runs,
 *       even after the hold releases — and stats().queued returns to 0.
 *   R2  storeBatch() takes searchGate.exclusive() unconditionally, even when
 *       the FTS index already exists and nothing needs building — so every
 *       bulk write drains all reads. (Atlas pass-test (d).) Unchanged by this
 *       inversion: this assertion already encodes the FIXED behaviour (0
 *       acquisitions) and failed pre-fix exactly as required.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SearchGate } from '../packages/lore/src/engines/searchGate.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); }
}

const DIM = 8;
const fake: EmbeddingProvider = {
    dimension: DIM,
    modelId: 'fake-test-model',
    initialize: async () => {},
    embed: async (t: string) => vec(t),
    embedQuery: async (t: string) => vec(t),
    embedDocument: async (t: string) => vec(t),
    embedDocumentBatch: async (ts: string[]) => ts.map(vec),
} as unknown as EmbeddingProvider;

function vec(t: string): number[] {
    const out = new Array(DIM).fill(0);
    for (let i = 0; i < t.length; i++) out[i % DIM] += t.charCodeAt(i) / 255;
    return out;
}

console.log('\n=== Defect 1 repro: search-worker call cancellation ===\n');

// ── R1 (FIXED): an aborted SearchGate waiter is removed, never runs ────────
await test('R1: aborting a queued caller removes it — it never runs, queue returns to 0', async () => {
    const gate = new SearchGate({ maxConcurrent: 1, maxQueue: 100 });
    let holdRelease!: () => void;
    const held = new Promise<void>((r) => { holdRelease = r; });
    const holder = gate.exclusive(async () => { await held; });
    await new Promise((r) => setTimeout(r, 10));

    let abandonedRan = false;
    const controller = new AbortController();
    // The caller "times out" and walks away — exactly what the proxy does on
    // a call timeout, now carrying its own AbortSignal (requirement 2).
    const abandoned = gate.read(async () => { abandonedRan = true; }, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(gate.stats().queued, 1, 'the queued read holds its FIFO place before abort');

    controller.abort(new Error('caller gave up'));
    await assert.rejects(abandoned, /caller gave up/, 'the aborted caller rejects immediately, without waiting for the hold to release');
    assert.equal(gate.stats().queued, 0, 'FIXED: the aborted waiter is removed from the queue immediately (Atlas pass-test (c))');

    holdRelease();
    await holder;
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(abandonedRan, false,
        'FIXED: the aborted waiter never ran, even after the hold released');
});

// ── R2: storeBatch takes exclusive() even with the FTS index already built ──
await test('R2: storeBatch takes searchGate.exclusive() with an existing FTS index', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-d1-repro-'));
    const store = new VerbatimStore(home, fake);
    await store.initialize();

    const rows = (tag: string, n: number) => Array.from({ length: n }, (_, i) => ({
        id: `lore:${tag}-${i}`,
        text: `alpha bravo charlie document ${tag} number ${i}`,
        metadata: {},
    }));

    // Seed + force the FTS index to exist.
    await store.storeBatch(rows('seed', 60));
    await store.ensureFtsIndex({ minRows: 1 });

    // Instrument the private gate: count exclusive() acquisitions from here on.
    const gate = (store as unknown as { searchGate: SearchGate }).searchGate;
    let exclusiveCount = 0;
    const realExclusive = gate.exclusive.bind(gate);
    (gate as unknown as Record<string, unknown>)['exclusive'] =
        <T>(fn: () => Promise<T>): Promise<T> => { exclusiveCount++; return realExclusive(fn); };

    await store.storeBatch(rows('second', 20));

    console.log(`      exclusive() acquisitions during one storeBatch: ${exclusiveCount}`);
    assert.equal(exclusiveCount, 0,
        `DEFECT REPRODUCED: storeBatch took searchGate.exclusive() ${exclusiveCount}× ` +
        'although the FTS index already existed — every bulk write drains all reads');

    await store.close();
    fs.rmSync(home, { recursive: true, force: true });
});

console.log(failed === 0 ? '\nall repro assertions passed (defect NOT reproduced)\n'
    : `\n${failed} repro assertion(s) failed — defect reproduced as described\n`);
process.exit(failed === 0 ? 0 : 1);
