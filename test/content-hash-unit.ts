#!/usr/bin/env tsx
/**
 * test/content-hash-unit.ts — content fingerprint determinism + properties.
 *
 * PR #69 P2. The hash is the load-bearing primitive behind the sweep
 * skip-on-unchanged optimization. If hashing isn't deterministic, the
 * sweep re-embeds on every pass (the bug we're killing). These tests
 * lock the contract.
 */

import { strict as assert } from 'node:assert';
import { computeContentHash } from '../packages/lore/src/engines/contentHash.js';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

console.log('contentHash determinism');

test('deterministic — same input, same output, every call', () => {
    const text = 'My architectural decision\n\nWe will use SQLite.\n\ntags: arch,db';
    const h1 = computeContentHash(text);
    const h2 = computeContentHash(text);
    const h3 = computeContentHash(text);
    assert.equal(h1, h2);
    assert.equal(h2, h3);
});

test('always 16 hex chars', () => {
    const samples = [
        '',
        'a',
        'a'.repeat(10000),
        '🚀 emoji',
        'multi\nline\ntext',
        'tabs\tand\ttabs',
        JSON.stringify({ a: 1, b: [2, 3] }),
    ];
    for (const s of samples) {
        const h = computeContentHash(s);
        assert.equal(h.length, 16, `len for "${s.slice(0, 20)}"`);
        assert.match(h, /^[0-9a-f]{16}$/, `hex format for "${s.slice(0, 20)}"`);
    }
});

test('different inputs → different outputs (collision sanity)', () => {
    // Not a true collision test — sha1-16 has 2^64 space — just a
    // smoke check that variations produce distinct values.
    const seeds = [
        'decision A',
        'decision B',
        'decision a', // case
        'decision A ', // trailing space
        ' decision A', // leading space
        'decision A', // nbsp
    ];
    const hashes = seeds.map(computeContentHash);
    assert.equal(new Set(hashes).size, seeds.length, 'all distinct');
});

test('whitespace-only difference matters (no normalization)', () => {
    // We deliberately do NOT normalize whitespace. If a caller wants
    // semantic equivalence across whitespace edits, they normalize
    // BEFORE hashing. Hashing the raw text means "the bytes that
    // would be embedded" — which is what skip-on-unchanged needs.
    const h1 = computeContentHash('hello world');
    const h2 = computeContentHash('hello  world'); // two spaces
    assert.notEqual(h1, h2);
});

test('empty string is a valid hashable input', () => {
    const h = computeContentHash('');
    assert.equal(h.length, 16);
    // sha1('') = da39a3ee5e6b4b0d3255bfef95601890afd80709
    assert.equal(h, 'da39a3ee5e6b4b0d');
});

test('unicode handled identically across calls', () => {
    const inputs = ['日本語', '🇯🇵', 'café', 'café']; // last is e+combining
    for (const i of inputs) {
        assert.equal(computeContentHash(i), computeContentHash(i));
    }
    // The two "café" variants normalize differently — hash should
    // reflect the byte difference.
    assert.notEqual(computeContentHash('café'), computeContentHash('café'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
