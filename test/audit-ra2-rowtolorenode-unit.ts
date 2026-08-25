#!/usr/bin/env tsx
/**
 * audit-ra2-rowtolorenode-unit.ts — re-audit 2026-06-25-reaudit2 (HIGH).
 *
 * rowToLoreNode dropped the Feature-2 outcome columns (success_count,
 * failure_count, partial_count, confirmation_score) on every read, so
 * outcome-weighted recall + avg_confirmation_score were permanent no-ops.
 * They must now round-trip; traversal projections that don't SELECT them
 * surface undefined (callers treat as 0).
 */

import assert from 'node:assert/strict';
import { rowToLoreNode } from '../packages/lore/src/engines/loreNodeRow.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

console.log('RA2 — rowToLoreNode maps outcome columns');

test('maps success/failure/partial counts + confirmation_score from a full row', () => {
    const node = rowToLoreNode({
        'n.id': 'x1', 'n.type': 'decision', 'n.label': 'L', 'n.content': 'C',
        'n.success_count': 7, 'n.failure_count': 2, 'n.partial_count': 1, 'n.confirmation_score': 0.83,
    });
    assert.equal(node.success_count, 7);
    assert.equal(node.failure_count, 2);
    assert.equal(node.partial_count, 1);
    assert.equal(node.confirmation_score, 0.83);
});

test('coerces stringified counts (kuzu-lite numeric-as-string) and rejects NaN', () => {
    const node = rowToLoreNode({ 'n.id': 'x2', 'n.success_count': '5', 'n.confirmation_score': 'not-a-number' });
    assert.equal(node.success_count, 5, 'numeric string coerced');
    assert.equal(node.confirmation_score, undefined, 'NaN → undefined, not 0/NaN');
});

test('traversal projection without outcome columns → undefined (treated as 0 by callers)', () => {
    const node = rowToLoreNode({ 'connected.id': 'x3', 'connected.label': 'T' });
    assert.equal(node.success_count, undefined);
    assert.equal(node.failure_count, undefined);
    assert.equal(node.partial_count, undefined);
    assert.equal(node.confirmation_score, undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
