#!/usr/bin/env tsx
/**
 * corpus-health-anchor-stale-unit.ts — regression coverage for the
 * anchor_stale latent no-op.
 *
 * rowToLoreNode() coerced `stale` back onto LoreNode but never read
 * `anchor_stale` (or `anchor_stale_since`), even though both columns are
 * declared in the schema and written by upsertNode / check_anchors(mark_stale).
 * Every consumer of listNodes/getNode therefore always saw
 * node.anchor_stale === undefined. corpusHealthCompute.ts's P1 paged path
 * compounded this by deliberately EXCLUDING anchor_stale from its
 * projection, so anchor_stale_nodes was permanently 0 for any real
 * (non-fake) graph — the exact path production traffic uses.
 *
 * This test exercises the REAL SurrealGraph + real paged
 * (bulkListProjected) branch of computeCorpusHealth — not the in-memory
 * fakes used by rest-feature-apis-unit.ts, which bypass rowToLoreNode
 * entirely and so never caught this. rowToLoreNode itself (loreNodeRow.ts)
 * is a pure, engine-agnostic row mapper shared by every engine, so its
 * coercion behavior is identical regardless of backend.
 *
 * Run: npx tsx test/corpus-health-anchor-stale-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { AuxStore } from '../packages/lore/src/outbox/auxStore.js';
import { computeCorpusHealth } from '../packages/lore/src/mcp/corpusHealthCompute.js';
import { rowToLoreNode } from '../packages/lore/src/engines/loreNodeRow.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WORKSPACE = 'w1';
function nodeData(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, type: 'note', label: 'L', content: 'c', tags: ['t'], project: WORKSPACE, ecosystem: '*', metadata: '{}', ...extra };
}

console.log('CORPUS HEALTH — anchor_stale round-trip');

// ── rowToLoreNode unit-level coercion (mirrors the `stale` pattern) ──
await test('rowToLoreNode: anchor_stale=true/1/"true" → true; false/absent → undefined', () => {
    assert.equal(rowToLoreNode({ 'n.anchor_stale': true }).anchor_stale, true);
    assert.equal(rowToLoreNode({ 'n.anchor_stale': 1 }).anchor_stale, true);
    assert.equal(rowToLoreNode({ 'n.anchor_stale': 'true' }).anchor_stale, true);
    assert.equal(rowToLoreNode({ 'n.anchor_stale': false }).anchor_stale, undefined);
    assert.equal(rowToLoreNode({}).anchor_stale, undefined);
});

await test('rowToLoreNode: anchor_stale_since "" → null; non-empty preserved; absent → null', () => {
    assert.equal(rowToLoreNode({ 'n.anchor_stale_since': '' }).anchor_stale_since, null);
    assert.equal(rowToLoreNode({ 'n.anchor_stale_since': '2026-07-01T00:00:00.000Z' }).anchor_stale_since, '2026-07-01T00:00:00.000Z');
    assert.equal(rowToLoreNode({}).anchor_stale_since, null);
});

// ── End-to-end: real SurrealGraph + real paged corpus-health computation ──
await test('computeCorpusHealth (paged/bulkListProjected path): marking a node anchor-stale makes anchor_stale_nodes > 0', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-health-anchor-stale-'));
    try {
        const g = new SurrealGraph(dir, { workspaceId: WORKSPACE });
        await g.initialize();
        // Sanity: this graph exposes bulkListProjected, so
        // computeCorpusHealth takes the paged branch under test (not the
        // unbounded listNodes fallback fakes exercise).
        assert.ok(typeof (g as unknown as { bulkListProjected?: unknown }).bulkListProjected === 'function');

        await g.upsertNode(nodeData('n1') as never);
        await g.upsertNode(nodeData('n2', {
            anchor_stale: true,
            anchor_stale_since: new Date().toISOString(),
        }) as never);

        // Confirm the write + read round-trips at the node level first.
        const stale = await g.getNode('n2');
        assert.equal(stale?.anchor_stale, true, 'anchor_stale round-trips through getNode');
        assert.ok(stale?.anchor_stale_since, 'anchor_stale_since round-trips through getNode');
        const clean = await g.getNode('n1');
        assert.equal(clean?.anchor_stale, undefined, 'unmarked node stays anchor_stale=undefined');

        const aux = AuxStore.open(dir);
        try {
            const report = await computeCorpusHealth(g, aux, WORKSPACE);
            assert.equal(report.total_nodes, 2);
            assert.equal(report.anchor_stale_nodes, 1, 'anchor_stale_nodes must reflect the real marked node, not 0');
        } finally {
            aux.close();
        }
        await g.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
