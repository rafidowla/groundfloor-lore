#!/usr/bin/env tsx
/**
 * scope-filter-unit.ts — applyActorScopeFilter tests.
 *
 * Verifies the policy:
 *   - undefined actorScopes → no actor bound → no filtering
 *   - empty [] actorScopes → authenticated, zero scopes → only public rows (fail-closed)
 *   - empty row scopes → public-within-workspace, always kept
 *   - non-empty row scopes → kept iff the sets intersect
 *   - normalizes both string[] and CSV-string row shapes
 */

import assert from 'node:assert/strict';
import { applyActorScopeFilter, normalizeScopes } from '../packages/lore/src/security/scopeFilter.js';

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

console.log('applyActorScopeFilter');

test('undefined actorScopes → no filtering (daemon-internal callers)', () => {
    const rows = [
        { id: 'a', metadata: { security_scopes: ['secret'] } },
        { id: 'b', metadata: { security_scopes: [] } },
    ];
    assert.deepEqual(applyActorScopeFilter(rows, undefined), rows);
});

test('empty actorScopes (authenticated, zero scopes) → only public rows kept (fail-closed, audit 2026-06-25)', () => {
    const rows = [
        { id: 'scoped', metadata: { security_scopes: ['secret'] } },
        { id: 'public', metadata: { security_scopes: [] } },
    ];
    // An actor holding zero scopes must NOT see scoped rows. Returning all rows
    // here was a fail-open: empty [] now means "public-within-workspace only".
    assert.deepEqual(applyActorScopeFilter(rows, []).map(x => x.id), ['public']);
});

test('row with empty scopes is always kept (public-within-workspace)', () => {
    const rows = [
        { id: 'public', metadata: { security_scopes: [] } },
        { id: 'public2', metadata: {} },
        { id: 'public3', metadata: { security_scopes: null as unknown as string[] } },
    ];
    const r = applyActorScopeFilter(rows, ['admin']);
    assert.equal(r.length, 3);
});

test('row scopes intersecting actor scopes is kept', () => {
    const rows = [
        { id: 'a', metadata: { security_scopes: ['admin', 'finance'] } },
        { id: 'b', metadata: { security_scopes: ['legal'] } },
    ];
    const r = applyActorScopeFilter(rows, ['admin']);
    assert.deepEqual(r.map(x => x.id), ['a']);
});

test('row scopes disjoint from actor scopes is dropped', () => {
    const rows = [{ id: 'a', metadata: { security_scopes: ['legal'] } }];
    const r = applyActorScopeFilter(rows, ['admin']);
    assert.deepEqual(r, []);
});

test('CSV-string row shape (cloud connector) is normalized', () => {
    const rows = [
        { id: 'a', metadata: { security_scopes: 'admin,finance' as unknown as string[] } },
        { id: 'b', metadata: { security_scopes: 'legal' as unknown as string[] } },
    ];
    const r = applyActorScopeFilter(rows, ['admin']);
    assert.deepEqual(r.map(x => x.id), ['a']);
});

test('CSV with extra spaces is trimmed', () => {
    const rows = [{ id: 'a', metadata: { security_scopes: ' admin , finance ' as unknown as string[] } }];
    const r = applyActorScopeFilter(rows, ['admin']);
    assert.equal(r.length, 1);
});

test('multiple actor scopes — any-of intersection', () => {
    const rows = [
        { id: 'a', metadata: { security_scopes: ['legal'] } },
        { id: 'b', metadata: { security_scopes: ['finance'] } },
        { id: 'c', metadata: { security_scopes: ['hr'] } },
    ];
    const r = applyActorScopeFilter(rows, ['legal', 'finance']);
    assert.deepEqual(r.map(x => x.id).sort(), ['a', 'b']);
});

test('mixed public + restricted rows under partial actor scope set', () => {
    const rows = [
        { id: 'p', metadata: { security_scopes: [] } },
        { id: 'a', metadata: { security_scopes: ['admin'] } },
        { id: 'l', metadata: { security_scopes: ['legal'] } },
    ];
    const r = applyActorScopeFilter(rows, ['admin']);
    assert.deepEqual(r.map(x => x.id).sort(), ['a', 'p']);
});

test('handles missing metadata field gracefully', () => {
    const rows = [
        { id: 'a' },
        { id: 'b', metadata: { security_scopes: ['restricted'] } },
    ];
    const r = applyActorScopeFilter(rows, ['public']);
    assert.deepEqual(r.map(x => x.id), ['a']);
});

// L-006: normalizeScopes is now exported and is the single-source normalizer
// both the semantic and BM25 paths of DataplaneVectorStore rely on.
console.log('\nnormalizeScopes (L-006)');

test('array of strings passes through, dropping empties', () => {
    assert.deepEqual(normalizeScopes(['a', '', 'b']), ['a', 'b']);
});

test('comma-joined string is split + trimmed (cloud connector shape)', () => {
    assert.deepEqual(normalizeScopes('secret, legal ,'), ['secret', 'legal']);
});

test('empty string → []', () => {
    assert.deepEqual(normalizeScopes(''), []);
});

test('null / undefined / non-string-array → []', () => {
    assert.deepEqual(normalizeScopes(null), []);
    assert.deepEqual(normalizeScopes(undefined), []);
    assert.deepEqual(normalizeScopes(42), []);
});

test('array and comma-string yield identical scope sets', () => {
    assert.deepEqual(normalizeScopes(['secret', 'legal']), normalizeScopes('secret,legal'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
