#!/usr/bin/env tsx
/**
 * audit-5b-reconnect-budget-unit.ts — regression for the Cluster-5 low
 * finding (2026-08-17 functional-correctness audit):
 *
 *   The bulk reconnect sweep drew at most ceil(k/2) semantic edges per
 *   node instead of k: half the top-K budget was reserved for the removed
 *   plugin system's 'other' stratum (perKindK = ceil(k/2)), and the
 *   'other' bucket was then discarded at insertion ("Cross-pillar edges:
 *   plugin system removed, silently skip").
 *
 * Fix: the lore pillar gets the full k; only the (never-inserted) 'other'
 * bucket keeps the smaller cap for observability.
 *
 * Drives the REAL reconnectGraph with a fake graph + fake verbatim search
 * (the nw4a harness pattern) — the verbatim.search fake returns MORE than
 * ceil(k/2) above-threshold lore: hits per node, so the proposed-edge
 * count per node directly measures the budget.
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/audit-5b-reconnect-budget-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-audit5b-reconnect-'));
process.env['LORE_HOME'] = TEST_HOME;

import { reconnectGraph } from '../packages/lore/src/engines/reconnect.js';
import type { BulkListQuery, BulkListPage } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

const NODE_COUNT = 8;
const K = 5;

function makeNode(i: number) {
    return {
        id: `n${i}`,
        type: 'lore',
        label: `node ${i}`,
        content: `content of node ${i}`,
        tags: 'a',
        project: 'p',
        ecosystem: 'e',
        updatedAt: new Date(2_000_000_000_000 - i * 1000).toISOString(),
        security_scopes: [],
    };
}

console.log('Audit cluster 5 — reconnect draws up to k semantic edges per node');

await test(`with ${NODE_COUNT} nodes and k=${K}, each node proposes ${K} lore edges (pre-fix: ${Math.ceil(K / 2)})`, async () => {
    const nodes = Array.from({ length: NODE_COUNT }, (_, i) => makeNode(i));
    const sorted = [...nodes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const graph = {
        async bulkList(q: BulkListQuery): Promise<BulkListPage> {
            let start = 0;
            if (q.cursor) {
                const idx = sorted.findIndex((n) => n.updatedAt === q.cursor!.updatedAt && n.id === q.cursor!.id);
                start = idx >= 0 ? idx + 1 : 0;
            }
            const slice = sorted.slice(start, start + q.limit);
            const last = slice[slice.length - 1];
            return {
                nodes: slice as unknown as Array<Record<string, unknown>>,
                hasMore: start + q.limit < sorted.length,
                nextCursor: last ? { updatedAt: last.updatedAt, id: last.id } : null,
            };
        },
        async getNode(id: string) { return nodes.find((n) => n.id === id) ?? null; },
        async addEdge() { /* dryRun */ },
        async pruneInferredLoreEdges() { return 0; },
    };
    // Every node's search returns ALL other nodes as high-similarity lore:
    // hits — more than ceil(k/2), so the per-node cap is the only limit.
    const verbatim = {
        async initialize() { /* no-op */ },
        async getById() { return null; },
        async getContentHashesByIds() { return new Map<string, string>(); },
        async storeBatch() { /* no-op */ },
        async search(_text: string, _limit: number) {
            return nodes.map((n) => ({
                id: `lore:${n.id}`,
                score: 0.9,
                metadata: { ecosystem: 'e' },
            }));
        },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await reconnectGraph(graph as any, verbatim as any, { k: K, minSim: 0.65, dryRun: true });

    // Count proposed edges per from-node (lore: prefixed ids).
    const perNode = new Map<string, number>();
    for (const e of result.proposedEdges) {
        perNode.set(e.from, (perNode.get(e.from) ?? 0) + 1);
    }
    // n0 is processed FIRST (highest updatedAt), so no pair it touches has
    // been seen yet — its from-count is a direct read of the per-node
    // budget: k post-fix, ceil(k/2) pre-fix.
    assert.equal(
        perNode.get('lore:n0') ?? 0, K,
        `first-processed node must propose k=${K} edges (pre-fix budget was ceil(k/2)=${Math.ceil(K / 2)})`,
    );
    // And globally the sweep must propose MORE than the pre-fix ceiling
    // (18 for this fixture with cap 3; 25 with cap 5).
    assert.ok(
        result.proposedEdges.length > 18,
        `expected > 18 proposed edges with the full-k budget, got ${result.proposedEdges.length}`,
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
