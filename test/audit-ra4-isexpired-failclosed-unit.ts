#!/usr/bin/env tsx
/**
 * audit-ra4-isexpired-failclosed-unit.ts — re-audit 2026-06-25 (LOW, security).
 *
 * isExpired() returned false (NOT expired) when a token's expiresAt was present
 * but unparseable — a corrupted expiry made the token live forever (fail-open).
 * It now FAILS CLOSED: a present-but-unparseable expiresAt is treated as expired.
 * A missing expiresAt still means a legitimate non-expiring token.
 */

import assert from 'node:assert/strict';
import { isExpired } from '../packages/lore/src/auth/tokens.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

const rec = (expiresAt: string | undefined) => ({ expiresAt } as never);
const NOW = Date.parse('2026-06-25T12:00:00.000Z');

console.log('RA-4 — isExpired fails closed on a corrupt expiry');

test('present-but-unparseable expiresAt → expired (fail closed)', () => {
    assert.equal(isExpired(rec('not-a-date'), NOW), true);
    assert.equal(isExpired(rec('garbage'), NOW), true);
    assert.equal(isExpired(rec(''), NOW), false); // empty string is falsy → non-expiring (unchanged)
});

test('missing expiresAt → non-expiring token (not expired)', () => {
    assert.equal(isExpired(rec(undefined), NOW), false);
});

test('expiresAt in the future → not expired; in the past → expired', () => {
    assert.equal(isExpired(rec('2026-06-25T13:00:00.000Z'), NOW), false);
    assert.equal(isExpired(rec('2026-06-25T11:00:00.000Z'), NOW), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
