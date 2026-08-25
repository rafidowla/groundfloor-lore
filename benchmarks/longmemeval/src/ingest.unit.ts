#!/usr/bin/env tsx
/**
 * ingest.unit.ts — disambiguateSessionIds (the fix for the duplicate
 * session_id ingest crash found 2026-08-15). Pure function, zero API calls.
 */

import assert from 'node:assert/strict';
import { disambiguateSessionIds } from './ingest.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('disambiguateSessionIds');

test('all-unique ids pass through byte-identical (the common, unaffected case)', () => {
    const ids = ['a', 'b', 'c'];
    assert.deepEqual(disambiguateSessionIds(ids), ['a', 'b', 'c']);
});

test('a repeated id: first occurrence unchanged, later ones get a #n suffix', () => {
    const ids = ['a', 'b', 'a', 'a'];
    assert.deepEqual(disambiguateSessionIds(ids), ['a', 'b', 'a#2', 'a#3']);
});

test('matches the real dataset case: 07b7a667_1 repeated at two positions', () => {
    const ids = ['x1', '07b7a667_1', 'x2', '07b7a667_1', 'x3'];
    const out = disambiguateSessionIds(ids);
    assert.deepEqual(out, ['x1', '07b7a667_1', 'x2', '07b7a667_1#2', 'x3']);
    assert.equal(new Set(out).size, out.length, 'every output id must be unique');
});

test('multiple independently-repeated ids are each disambiguated on their own count', () => {
    const ids = ['a', 'b', 'a', 'b', 'a'];
    assert.deepEqual(disambiguateSessionIds(ids), ['a', 'b', 'a#2', 'b#2', 'a#3']);
});

test('empty input', () => {
    assert.deepEqual(disambiguateSessionIds([]), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
