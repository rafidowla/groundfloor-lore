#!/usr/bin/env tsx
/**
 * sp05-topology-clamp-unit.ts — SP-05 regression: LIMIT sanitisation.
 *
 * The original half of this file asserted computeTopology's Cypher LIMIT
 * clauses through a stubbed Kùzu WithConnection; it died with graphTopology
 * .ts and the engine (Kùzu removal Phase 3d, 2026-08-21). What survives is
 * the engine-agnostic clampLimit/TOPOLOGY_LIMIT_CEILING half (re-pointed to
 * topologyOverviewFold.ts in Step 1): the same numeric-clamping contract the
 * Surreal path's overview fold relies on.
 */

import assert from 'node:assert/strict';
import { clampLimit, TOPOLOGY_LIMIT_CEILING } from '../packages/lore/src/engines/topologyOverviewFold.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void> | void) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

/* ──────────────────── A. clampLimit direct unit tests ──────────────────── */

test('clampLimit: NaN → 0', () => {
    assert.equal(clampLimit(NaN), 0);
});

test('clampLimit: Infinity → 0', () => {
    assert.equal(clampLimit(Infinity), 0);
});

test('clampLimit: -Infinity → 0', () => {
    assert.equal(clampLimit(-Infinity), 0);
});

test('clampLimit: negative integer → 0', () => {
    assert.equal(clampLimit(-500), 0);
});

test('clampLimit: -1 → 0', () => {
    assert.equal(clampLimit(-1), 0);
});

test('clampLimit: fractional → floored (not rounded)', () => {
    assert.equal(clampLimit(299.9), 299);
    assert.equal(clampLimit(1.1), 1);
    assert.equal(clampLimit(0.9), 0);
});

test('clampLimit: value above ceiling → clamped to ceiling', () => {
    assert.equal(clampLimit(TOPOLOGY_LIMIT_CEILING + 1), TOPOLOGY_LIMIT_CEILING);
    assert.equal(clampLimit(999_999_999), TOPOLOGY_LIMIT_CEILING);
});

test('clampLimit: custom max respected', () => {
    assert.equal(clampLimit(500, 300), 300);
    assert.equal(clampLimit(200, 300), 200);
});

test('clampLimit: normal value passes through unchanged', () => {
    assert.equal(clampLimit(300), 300);
    assert.equal(clampLimit(0), 0);
    assert.equal(clampLimit(1), 1);
});

test('clampLimit: TOPOLOGY_LIMIT_CEILING itself is allowed', () => {
    assert.equal(clampLimit(TOPOLOGY_LIMIT_CEILING), TOPOLOGY_LIMIT_CEILING);
});

/* ─────────────────────────── runner ─────────────────────────── */

console.log('\n=== SP-05 clampLimit / TOPOLOGY_LIMIT_CEILING regression ===\n');
await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
