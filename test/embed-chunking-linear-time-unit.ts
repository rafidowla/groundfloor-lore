#!/usr/bin/env tsx
/**
 * embed-chunking-linear-time-unit.ts — timing guard for long-document
 * chunking in LocalEmbeddingProvider.
 *
 * transformers 4.2.x (bundled @huggingface/tokenizers < 0.2.0) tokenized one
 * Unigram pre-token in O(n²), and the e5 Metaspace pre-tokenizer makes a
 * whole document one pre-token. Measured on 4.2.x: 20k chars ~4 s, 50k
 * ~30 s, 100k ~115 s, 150k did not finish in 120 s. Fixed upstream in
 * tokenizers 0.2.0 (transformers 4.3.0). This drives 100k and 200k chars
 * through the real provider path (acquirePipeline →
 * splitTextIntoChunks / splitIntoWindows → forward passes) under generous
 * bounds, and checks that doubling the input does not come close to
 * quadrupling the tokenize+split time.
 *
 * Run: npx tsx test/embed-chunking-linear-time-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-chunk-linear-'));
process.env['LORE_HOME'] = TEST_HOME;

import {
    LocalEmbeddingProvider,
    releaseLocalEmbeddingPipeline,
} from '../packages/lore/src/providers/localEmbeddingProvider.js';
import { longText } from './helpers/unigramTestText.js';

/** Unpatched, 100k chars took ~115 s to tokenize alone. */
const EMBED_100K_BOUND_MS = 30_000;
const SPLIT_BOUND_MS = 10_000;

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
    const t0 = performance.now();
    const v = await fn();
    return [v, performance.now() - t0];
}

console.log('Long-document chunking runs in ~linear time');

const provider = new LocalEmbeddingProvider();
await provider.initialize();

await test(`embedDocument(100k chars) < ${EMBED_100K_BOUND_MS} ms`, async () => {
    const [vec, ms] = await timed(() => provider.embedDocument(longText(100_000, 41)));
    console.log(`    100k embedDocument: ${Math.round(ms)} ms`);
    assert.equal(vec.length, provider.dimension);
    assert.ok(vec.every(Number.isFinite));
    assert.ok(ms < EMBED_100K_BOUND_MS, `took ${Math.round(ms)} ms`);
});

await test(`splitIntoWindows 100k / 200k < ${SPLIT_BOUND_MS} ms each, 2× input ≪ 4× time`, async () => {
    await provider.splitIntoWindows(longText(5_000, 3), 448, 64); // warm
    const [w1, t1] = await timed(() => provider.splitIntoWindows(longText(100_000, 43), 448, 64));
    const [w2, t2] = await timed(() => provider.splitIntoWindows(longText(200_000, 47), 448, 64));
    console.log(`    splitIntoWindows 100k: ${Math.round(t1)} ms (${w1.length} windows), 200k: ${Math.round(t2)} ms (${w2.length} windows)`);
    assert.ok(w2.length > w1.length);
    assert.ok(t1 < SPLIT_BOUND_MS, `100k took ${Math.round(t1)} ms`);
    assert.ok(t2 < SPLIT_BOUND_MS, `200k took ${Math.round(t2)} ms`);
    // Quadratic would be ~4×; allow noise on a busy machine, floor tiny timings.
    assert.ok(t2 < 3.2 * Math.max(t1, 250), `ratio ${(t2 / t1).toFixed(2)} looks super-linear`);
});

releaseLocalEmbeddingPipeline();
fs.rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
