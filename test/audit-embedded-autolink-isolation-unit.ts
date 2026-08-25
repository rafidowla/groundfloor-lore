#!/usr/bin/env tsx
/**
 * test/audit-embedded-autolink-isolation-unit.ts — Audit fix #5.
 *
 * Before fix #5, embedded nodeUpsert/nodeUpsertBatch hardcoded the autolink
 * (reconnect) + embed routing to the BOOT workspace's verbatim store
 * (`store.loreVerbatim`) regardless of which workspace was written. A node
 * written into workspace B could therefore leak its vector into workspace A's
 * search index — a cross-workspace data-contamination bug specific to the
 * library (createLore) path.
 *
 * This test creates TWO workspaces, writes a distinctive node into the
 * NON-active workspace B, and asserts that:
 *   T1: workspace B's LanceDB dir gains data (vector landed in the right store)
 *   T2: workspace A (active/boot) does NOT contain the marker in a recall over
 *       its own index (the leak direction is closed)
 *
 * The marker is a unique string we then recall against each workspace's own
 * store via the per-workspace resolver.
 */

import assert from 'node:assert/strict';
import { createLore } from '../packages/lore/src/index.js';
import { createWorkspace } from '../packages/lore/src/config/workspaces.js';
import { WorkspaceVerbatimResolver } from '../packages/lore/src/outbox/workspaceVerbatimResolver.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

let passed = 0, failed = 0;
const test = (name: string, fn: () => Promise<void>) => {
    return (async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })();
};

function dirSize(p: string): number {
    if (!fs.existsSync(p)) return 0;
    let total = 0;
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, entry.name);
        if (entry.isDirectory()) total += dirSize(full);
        else try { total += fs.statSync(full).size; } catch { /* ignore */ }
    }
    return total;
}

async function main() {
    const dataDir = process.env.LORE_HOME!;
    const lore = await createLore({ deploymentMode: 'embedded', dataDir });

    console.log('Audit fix #5 — embedded autolink routes to the TARGET workspace');

    // Register a second workspace. 'default' is the active/boot one.
    createWorkspace('workspace-b', undefined, dataDir);

    const wsA_lancedb = path.join(dataDir, 'workspaces', 'default', '.lore', 'lancedb');
    const wsB_lancedb = path.join(dataDir, 'workspaces', 'workspace-b', '.lore', 'lancedb');

    const marker = 'isolation-marker-zq9p5-fix5-autolink';

    await test('T1 writing to workspace B lands its vector in B (not boot A)', async () => {
        const bSizeBefore = dirSize(wsB_lancedb);
        // Write to workspace B with SYNC embed so the vector lands before we check.
        const r = await lore.nodeUpsert({
            id: 'wsb-node-1', workspace: 'workspace-b', ecosystem: 'probe',
            nodeData: { id: 'wsb-node-1', type: 'decision', label: 'wsb', content: marker },
        } as any);
        assert.equal(r.ok, true, 'write to workspace-b should succeed');
        await lore.awaitEmbeds?.();
        await new Promise(res => setTimeout(res, 1500));
        const bSizeAfter = dirSize(wsB_lancedb);
        assert.ok(bSizeAfter > bSizeBefore,
            `workspace-b lancedb did not grow (before=${bSizeBefore} after=${bSizeAfter}) — vector did NOT land in B`);
    });

    await test('T2 the marker is NOT in workspace A (boot) recall index', async () => {
        // Recall against workspace A's OWN verbatim store via the resolver.
        const embeddingProvider = (lore as any).store?.embeddingProvider;
        const resolver = new WorkspaceVerbatimResolver(embeddingProvider);
        try {
            const storeA = await resolver.getOrOpen('default');
            // search the boot workspace's index for the marker
            const hits = await storeA.search(marker, 5);
            const leaked = Array.isArray(hits)
                ? hits.some((h: any) => JSON.stringify(h).includes(marker))
                : false;
            assert.equal(leaked, false,
                'LEAK: workspace B marker found in workspace A (boot) verbatim index');
        } finally {
            await resolver.closeAll();
        }
    });

    await lore.dispose();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
