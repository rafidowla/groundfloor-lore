#!/usr/bin/env tsx
/**
 * test/provenance-unit.ts — T6 unit tests
 */

import { strict as assert } from 'node:assert';
import {
    aggregate,
    forConnectorItem,
    forManual,
    merge,
} from '../packages/lore/src/engines/provenance.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

console.log('provenance — T6');

/* ---------- builders ---------- */

test('forConnectorItem captures connector + uri + ts', () => {
    const p = forConnectorItem('filesystem', { sourceId: '/tmp/foo.txt', sourceUrl: 'file:///tmp/foo.txt' });
    assert.equal(p.sourceConnector, 'filesystem');
    assert.equal(p.sourceUri, 'file:///tmp/foo.txt');
    assert.ok(p.ingestedAtIso);
});

test('forConnectorItem falls back to connector:sourceId when no sourceUrl', () => {
    const p = forConnectorItem('gmail', { sourceId: 'thread/abc/msg/xyz' });
    assert.equal(p.sourceUri, 'gmail:thread/abc/msg/xyz');
});

test('forManual records actor', () => {
    const p = forManual('user:alice');
    assert.equal(p.sourceConnector, 'manual');
    assert.equal(p.sourceUri, 'manual:user:alice');
});

// forPlugin was removed in NW-6a (plugin system removed in v3.11.0).
// The import at the top no longer includes it; this comment is the regression note.

/* ---------- merge ---------- */

test('merge: earliest ingestedAtIso wins', () => {
    const earlier = '2026-05-01T10:00:00Z';
    const later = '2026-05-07T10:00:00Z';
    const a = { sourceConnector: 'filesystem', sourceUri: 'a', ingestedAtIso: earlier };
    const b = { sourceConnector: 'gmail', sourceUri: 'b', ingestedAtIso: later };
    const m = merge(a, b);
    assert.equal(m.ingestedAtIso, earlier);
});

test('merge: existing connector + uri win; incoming uri appended to transformChain', () => {
    const a = { sourceConnector: 'filesystem', sourceUri: 'a', ingestedAtIso: '2026-05-01T10:00:00Z' };
    const b = { sourceConnector: 'gmail', sourceUri: 'b', ingestedAtIso: '2026-05-02T10:00:00Z' };
    const m = merge(a, b);
    assert.equal(m.sourceConnector, 'filesystem');
    assert.equal(m.sourceUri, 'a');
    assert.ok(m.transformChain?.includes('merged-from:b'));
});

test('merge: transformChain dedup-preserves order', () => {
    const a = { sourceUri: 'a', transformChain: ['x', 'y'] };
    const b = { sourceUri: 'b', transformChain: ['y', 'z'] };
    const m = merge(a, b);
    assert.deepEqual(m.transformChain, ['x', 'y', 'z', 'merged-from:b']);
});

/* ---------- aggregate ---------- */

test('aggregate: dedups sources by nodeId', () => {
    const r = aggregate({
        storesHit: ['graph', 'vector'],
        contributions: [
            { nodeId: 'a', provenance: { sourceConnector: 'filesystem', sourceUri: 'fs:a' } },
            { nodeId: 'b', provenance: { sourceConnector: 'gmail', sourceUri: 'gmail:b' } },
            { nodeId: 'a', provenance: { sourceConnector: 'filesystem', sourceUri: 'fs:a' } },
        ],
    });
    assert.equal(r.sources.length, 2);
    assert.deepEqual(r.storesHit, ['graph', 'vector']);
});

test('aggregate: dedups storesHit', () => {
    const r = aggregate({
        storesHit: ['graph', 'graph', 'vector'],
        contributions: [],
    });
    assert.deepEqual(r.storesHit, ['graph', 'vector']);
});

test('aggregate: passes through edgesTraversed', () => {
    const edges = [{ from: 'a', to: 'b', type: 'depends_on' }];
    const r = aggregate({ storesHit: ['graph'], contributions: [], edgesTraversed: edges });
    assert.deepEqual(r.edgesTraversed, edges);
});

test('aggregate: empty contributions still produces well-formed result', () => {
    const r = aggregate({ storesHit: [], contributions: [] });
    assert.deepEqual(r.storesHit, []);
    assert.deepEqual(r.sources, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
