#!/usr/bin/env tsx
/**
 * audit-5b-addedge-upsert-unit.ts — regression for the Cluster-5 medium
 * finding (2026-08-17 functional-correctness audit):
 *
 *   store_edge is documented as an upsert, but addEdge skipped any EXISTING
 *   (source, target, relation) triple entirely — confidence/confidenceScore
 *   were never updated on a re-store while the tool echoed the NEW values
 *   back as if stored.
 *
 * Fixed in engines/surreal/surrealGraphWrites.ts (SurrealDB): existing
 * triple now UPDATEs the edge record instead of skipping it.
 *
 * This test pins the behavior through the real SurrealGraph.addEdge entry
 * point (the one store_edge routes to in embedded mode) — the contract is
 * engine-agnostic, so there is nothing Kùzu-specific left to pin here.
 *
 * Run: npx tsx test/audit-5b-addedge-upsert-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

function node(id: string): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id, type: 'decision', label: `L ${id}`, content: `C ${id}`,
        tags: ['t'], project: 'p', ecosystem: 'e', metadata: '{}',
    };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-audit5b-edge-'));
const g = new SurrealGraph(dir, { workspaceId: 'w', cacheDisabled: true });
await g.initialize();
await g.upsertNode(node('src'));
await g.upsertNode(node('tgt'));

console.log('Audit cluster 5 — addEdge updates confidence on re-store (documented upsert)');

await test('re-storing an existing triple updates confidence/confidenceScore, no duplicate edge', async () => {
    await g.addEdge({ sourceId: 'src', targetId: 'tgt', relation: 'supports', confidence: 'extracted', confidenceScore: 1.0 });
    await g.addEdge({ sourceId: 'src', targetId: 'tgt', relation: 'supports', confidence: 'inferred', confidenceScore: 0.42 });
    const edges = await g.queryEdges({ source: 'src', limit: 50, offset: 0 });
    assert.equal(edges.length, 1, 're-store must not create a duplicate edge row');
    assert.equal(edges[0]!.confidence, 'inferred', 'confidence must be updated to the re-stored value');
    assert.equal(edges[0]!.confidenceScore, 0.42, 'confidenceScore must be updated to the re-stored value');
});

await test('a different relation still creates a separate edge', async () => {
    await g.addEdge({ sourceId: 'src', targetId: 'tgt', relation: 'contradicts', confidence: 'inferred', confidenceScore: 0.7 });
    const edges = await g.queryEdges({ source: 'src', limit: 50, offset: 0 });
    assert.equal(edges.length, 2);
    const supports = edges.find((e) => e.relation === 'supports');
    assert.equal(supports!.confidence, 'inferred', 'the first triple keeps its updated values');
});

await g.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
