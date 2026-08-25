#!/usr/bin/env tsx
/**
 * fc-round5-bulk-autolink-workspace-e2e.ts — 2026-08-18 gap 1 (regression).
 *
 * bulkIngest({ autolink: true }) routing, at the REAL production entry point
 * (createLore embedded; default SurrealGraph engine — no Kùzu, no mocks).
 *
 * The 1.4 fix removed nodeService's boot-workspace gate but left bulkIngest
 * hardcoding the BOOT graph + BOOT verbatim store in the autolink handles for
 * every node in the batch. Live-reproduced symptoms this file locks down:
 *
 *   T1: autolink edges land in the NODE'S OWN workspace's graph (wsc).
 *       Pre-fix: zero semantic_neighbor edges in wsc (they went to boot).
 *   T2: the node text does NOT leak into the boot workspace's verbatim
 *       store. Pre-fix: reconnectOneNode stored the full text into boot's
 *       LanceDB (skipEmbed:true → skipStore:false), making wsc-only content
 *       searchable from the boot workspace.
 *   T3: the nodes' canonical rows DO land in wsc's own verbatim store.
 */

import assert from 'node:assert/strict';
import { createLore } from '../packages/lore/src/index.js';
import { createWorkspace } from '../packages/lore/src/config/workspaces.js';
import { WorkspaceVerbatimResolver } from '../packages/lore/src/outbox/workspaceVerbatimResolver.js';

let passed = 0, failed = 0;
const test = (name: string, fn: () => Promise<void>) =>
    (async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
    })();

async function main() {
    const dataDir = process.env.LORE_HOME!;
    const lore = await createLore({ deploymentMode: 'embedded', dataDir });

    console.log('fc-round5 gap 1 — bulkIngest autolink workspace routing (real engine)');

    createWorkspace('wsc', undefined, dataDir);
    const marker = 'wsc-autolink-marker-fc-round5';

    const nodes = [1, 2, 3, 4].map((n) => ({
        id: `wsc-node-${n}`,
        workspace: 'wsc',
        ecosystem: 'probe',
        nodeData: { id: `wsc-node-${n}`, type: 'note', label: `wsc ${n}`, content: `${marker} variant ${n}` },
    }));

    const res = await lore.bulkIngest(nodes as never, { autolink: true, embed: 'sync' });
    assert.ok(res.ok, `bulkIngest should succeed: ${JSON.stringify(res.results.filter(r => !r.ok))}`);

    // Autolink is fire-and-forget on the tracker; drain it before asserting.
    const tracker = (lore as any).store?.autolinkTracker;
    if (tracker?.drain) await tracker.drain(Date.now() + 30_000);
    await new Promise(r => setTimeout(r, 1500));

    await test('T1 autolink edges land in wsc\'s own graph', async () => {
        const wscGraph = await lore._daemon.getGraphRegistry()!.getGraphHandle('wsc');
        const edges = await wscGraph.queryEdges({ relation: 'semantic_neighbor', limit: 50, offset: 0 });
        assert.ok(edges.length > 0,
            `wsc graph has ${edges.length} semantic_neighbor edges — expected >0 (edges went to the wrong graph)`);
    });

    await test('T2 boot workspace verbatim store has NO wsc-only content', async () => {
        const embeddingProvider = (lore as any).store?.embeddingProvider;
        const resolver = new WorkspaceVerbatimResolver(embeddingProvider);
        try {
            const boot = await resolver.getOrOpen('default');
            const hits = await boot.search(marker, 10);
            const leaked = Array.isArray(hits) && hits.some((h: any) => JSON.stringify(h).includes(marker));
            assert.equal(leaked, false, 'LEAK: wsc-only content searchable from boot workspace verbatim store');
        } finally {
            await resolver.closeAll();
        }
    });

    await test('T3 wsc\'s own verbatim store holds the canonical rows', async () => {
        const embeddingProvider = (lore as any).store?.embeddingProvider;
        const resolver = new WorkspaceVerbatimResolver(embeddingProvider);
        try {
            const wsc = await resolver.getOrOpen('wsc');
            const hits = await wsc.search(marker, 10);
            assert.ok(Array.isArray(hits) && hits.length >= 4,
                `wsc store returned ${hits?.length ?? 0} hits for its own content — expected >=4`);
        } finally {
            await resolver.closeAll();
        }
    });

    await lore.dispose();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
