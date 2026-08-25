#!/usr/bin/env tsx
/**
 * test/verbatim-cache-scope-unit.ts — the search result cache is PERMISSION-SAFE.
 *
 * VerbatimStore.search()/bm25Search() put the caller's (sorted) actor scopes into
 * the cache-key params, so the short-lived result cache can never serve one
 * principal's filtered result to a principal with different access. This asserts
 * that cache-key contract directly: same query + different scopes → DIFFERENT
 * keys (no cross-scope reuse); same query + same scopes → SAME key (correct
 * dedupe). The row-level filter that runs inside the cached body is the
 * belt-and-suspenders backstop and is covered in scope-filter-unit.ts.
 */

import assert from 'node:assert/strict';
import { cacheKey } from '../packages/lore/src/engines/cache.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

// Mirror how verbatimStore builds the key: scopes are sorted, then included in
// the params object alongside the query.
function keyFor(query: string, scopes: string[] | null): string {
    const sortedScopes = scopes ? [...scopes].sort() : null;
    return cacheKey('verbatim-search', 'default', 0, { q: query, limit: 10, filter: null, scopes: sortedScopes });
}

console.log('VerbatimStore search cache — permission-safe keying (RBAC/ReBAC)');

test('same query + DIFFERENT scopes → different cache keys (no cross-user reuse)', () => {
    const a = keyFor('secret roadmap', ['team:eng']);
    const b = keyFor('secret roadmap', ['team:sales']);
    assert.notEqual(a, b, 'a team:eng result must NOT be served from a team:sales cache entry');
});

test('same query + SAME scopes → same key (correct dedupe/sharing within a permission set)', () => {
    const a = keyFor('shared note', ['team:eng', 'org:acme']);
    const b = keyFor('shared note', ['team:eng', 'org:acme']);
    assert.equal(a, b, 'identical permissions + query should share the cached result');
});

test('scope order does not fragment the key (sorted before hashing)', () => {
    const a = keyFor('note', ['b', 'a']);
    const b = keyFor('note', ['a', 'b']);
    assert.equal(a, b, 'call-order of the same scope set must not change the key');
});

test('an authenticated zero-scope caller and an unscoped (daemon-internal) caller do NOT share a key', () => {
    const zeroScope = keyFor('note', []);      // authenticated, no scopes → only public rows
    const unscoped = keyFor('note', null);     // no actor bound → unfiltered (daemon-internal)
    assert.notEqual(zeroScope, unscoped, 'the fail-closed public-only view must not collide with the unfiltered view');
});

test('adding a scope changes the key (broader access = separate entry)', () => {
    const narrow = keyFor('doc', ['team:eng']);
    const broad = keyFor('doc', ['team:eng', 'admin:all']);
    assert.notEqual(narrow, broad, 'a caller with an extra scope must not read the narrower caller\'s cached result');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
