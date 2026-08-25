#!/usr/bin/env tsx
/**
 * audit-58-embedding-chunking-unit.ts — regression for audit finding 5.8
 * (2026-08-17 functional-correctness audit, HIGH).
 *
 * Bug: LocalEmbeddingProvider passed the WHOLE document text to the HF
 * pipeline in one call; the model silently truncates at its ~512-token
 * context window and nothing chunked first. Verified live pre-fix: a
 * document containing a unique phrase at character offset 6000 scored
 * BYTE-IDENTICALLY to pure-filler decoys containing no relevant content,
 * and a 117 KB document ranked BELOW filler decoys for a query drawn
 * verbatim from its own tail.
 *
 * Fix: embedDocument()/embedDocumentBatch() now split long documents into
 * overlapping token windows (448 tokens, 64 overlap — headroom under the
 * 512 window), embed each chunk, and mean-pool + renormalize the chunk
 * vectors into one representative vector. One vector row per document id
 * keeps the store/search/tombstone/export surface unchanged.
 *
 * Acceptance (per the finding): a document with a unique, findable phrase
 * placed near the END of a long text (well past 512 tokens) must score
 * MEANINGFULLY higher than filler decoys for a query drawn from that
 * phrase. Scaled down from the 117 KB repro — ~8 KB docs (~2k tokens).
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/audit-58-embedding-chunking-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-audit58-'));
process.env['LORE_HOME'] = TEST_HOME;

import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
        if (process.env['AUDIT58_DEBUG']) console.error((e as Error).stack);
        failed++;
    }
};

/* Deterministic filler prose, lexically distant from the target phrase. */
function filler(targetLen: number, seed: number): string {
    let out = '';
    let n = seed;
    while (out.length < targetLen) {
        out += `The committee reviewed standing agenda item ${n} and deferred the routine budget correspondence to the following session. `;
        n += 7;
    }
    return out.slice(0, targetLen);
}

const PHRASE = 'The Reykjavik vault stores the Nightingale rotation runbook.';
const QUERY = 'Reykjavik vault Nightingale rotation runbook';
/** Well past the ~512-token (~2 KB) context window. */
const TAIL_OFFSET = 8000;
const DOC_LEN = TAIL_OFFSET + PHRASE.length + 400;

function docWithPhraseAt(offset: number): string {
    return filler(offset, 1) + PHRASE + filler(DOC_LEN - offset - PHRASE.length, 99991);
}

function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}

console.log('Audit 5.8 — long-document chunking in the embed path');

await test('provider level: a phrase past the 512-token window CHANGES the embedding', async () => {
    const p = new LocalEmbeddingProvider();
    const withTail = await p.embedDocument(docWithPhraseAt(TAIL_OFFSET));
    const without = await p.embedDocument(filler(DOC_LEN, 12345));
    assert.equal(withTail.length, 384);
    // Pre-fix these were byte-identical (the tail was truncated away).
    const sim = cosine(withTail, without);
    assert.ok(sim < 0.999, `tail phrase must move the embedding (cosine=${sim.toFixed(6)}`);
});

await test('provider level: short documents keep a normal single-chunk embedding', async () => {
    const p = new LocalEmbeddingProvider();
    const a = await p.embedDocument('hello world, this is a short document');
    assert.equal(a.length, 384);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-3, 'document vector must stay L2-normalized');
});

await test('RAN repro (scaled): tail-phrase doc beats pure-filler decoys in verbatim search', async () => {
    const store = new VerbatimStore(path.join(TEST_HOME, 'ws'), new LocalEmbeddingProvider());
    await store.initialize();

    await store.store({ id: 'doc-head', text: docWithPhraseAt(0), metadata: {} });
    await store.store({ id: 'doc-tail', text: docWithPhraseAt(TAIL_OFFSET), metadata: {} });
    for (let i = 0; i < 3; i++) {
        await store.store({ id: `decoy-${i}`, text: filler(DOC_LEN, 5000 + i * 977), metadata: {} });
    }

    const hits = await store.search(QUERY, 10);
    const score = new Map(hits.map((h) => [h.id, h.score]));
    const tailScore = score.get('doc-tail');
    assert.ok(tailScore !== undefined,
        `doc-tail must appear in results; got [${hits.map((h) => `${h.id}:${h.score.toFixed(4)}`).join(', ')}]`);
    for (let i = 0; i < 3; i++) {
        const decoy = score.get(`decoy-${i}`) ?? 0;
        // Pre-fix: tailScore === decoy byte-identically (0.7937 vs 0.7937).
        // Require a MEANINGFUL margin, not just inequality.
        assert.ok(
            tailScore > decoy + 0.01,
            `doc-tail (${tailScore.toFixed(4)}) must score meaningfully above decoy-${i} (${decoy.toFixed(4)})`,
        );
    }
    console.log(`    scores: ${hits.map((h) => `${h.id}=${h.score.toFixed(4)}`).join(' ')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
