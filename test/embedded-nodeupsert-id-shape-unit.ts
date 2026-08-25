#!/usr/bin/env tsx
/**
 * test/embedded-nodeupsert-id-shape-unit.ts — launch-readiness fix 5
 * (2026-08-19): the embedded library's own documented quick-start shape
 * threw at the graph layer.
 *
 * packages/lore/src/index.ts documents:
 *
 *     await lore.nodeUpsert({
 *       id: 'my-decision-1',            // top-level, NOT inside nodeData
 *       workspace: 'default',
 *       ecosystem: 'my-project',
 *       nodeData: { type, label, content },
 *     });
 *
 * but core/nodeService.ts's nodeUpsert() never merged the top-level `id`
 * into `nodeData` before `targetGraph.upsertNode(nodeData)`, and both graph
 * engines key on `nodeData.id` — SurrealDB (the embedded default engine)
 * threw `invalid_node_id: expected a string, received undefined` from
 * toNodeRid. The MCP store_node and REST postNode surfaces were unaffected
 * because both already build nodeData with `id` populated; only the
 * embedded surface (and its lib:nodeUpsertBatch sibling, which funnels
 * through the same shared chokepoint) exposed the gap. The fix adds the
 * same top-level→nodeData normalization `project`/`ecosystem` already had,
 * PLUS a refusal when both are present and disagree — verified live below:
 *
 *   T1 — the exact documented shape succeeds and reads back by id, and its
 *        verbatim row lands under the SAME id (the `lore:<id>` key the
 *        pre-fix mismatch case would have split from the graph row).
 *   T2 — nodeUpsertBatch with the same per-item shape succeeds for every
 *        item (the batch wrapper shares the chokepoint; no separate fix).
 *   T3 — top-level id ≠ nodeData.id is REFUSED with code invalid_node_id
 *        and writes NOTHING under either id (a silent winner would split
 *        graph identity from the verbatim/outbox/version/audit trail, all
 *        of which derive from the top-level arg).
 *   T4 — the populated shape every existing caller uses (identical id in
 *        both places) is untouched.
 *
 * Harness: one real embedded createLore boot (SurrealDB default engine),
 * the production entry point — no mocks, no direct core/nodeService calls.
 *
 * Run: npx tsx test/embedded-nodeupsert-id-shape-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLore } from '../packages/lore/src/index.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

// Seed a single "default" workspace at a throwaway home so the embedded
// boot graph opens there and nowhere else (embeddable-capstone pattern).
function seedDefaultWorkspace(home: string): void {
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    fs.writeFileSync(
        path.join(home, 'workspaces.json'),
        JSON.stringify(
            { active: 'default', workspaces: [{ name: 'default', path: home, createdAt: '2026-08-19T00:00:00.000Z' }] },
            null,
            2,
        ),
    );
}

async function main() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-fix5-id-shape-'));
    seedDefaultWorkspace(dataDir);
    delete process.env['LORE_HOME'];
    delete process.env['LORE_GRAPH_PATH'];

    const lore = await createLore({ deploymentMode: 'embedded', dataDir });
    const client = lore.store.storageClient;

    console.log('fix 5 — embedded nodeUpsert accepts the documented top-level-id shape');

    await test('T1 documented quick-start shape (id top-level, absent from nodeData) writes + reads back', async () => {
        const res = await lore.nodeUpsert({
            id: 'fix5-t1-node',
            workspace: 'default',
            ecosystem: 'fix5-probe',
            nodeData: { type: 'decision', label: 'documented shape', content: 'pangolin fix5 t1 body' },
        });
        assert.ok(res.ok === true, `documented shape must succeed (pre-fix threw invalid_node_id): ${JSON.stringify(res)}`);
        assert.equal(res.node.id, 'fix5-t1-node');
        const back = await client.getNode('fix5-t1-node', { workspace: 'default' });
        assert.ok(back, 'node must be retrievable by the top-level id');
        assert.equal(back!.id, 'fix5-t1-node');
        // The verbatim mirror must land under the SAME id — the pre-fix
        // mismatch path keyed it `lore:<top-level id>` while the graph row
        // took nodeData.id. awaitEmbeds pumps the outbox replicator so the
        // async verbatim row is durable before we count (fc1 T1.M1 pattern).
        await lore.awaitEmbeds();
        const count = await client.verbatimCount({ workspace: 'default' });
        assert.ok(count >= 1, `verbatim row for the node must exist after awaitEmbeds (got ${count})`);
    });

    await test('T2 nodeUpsertBatch with the same per-item shape (top-level id only) writes every item', async () => {
        const results = await lore.nodeUpsertBatch([
            { id: 'fix5-t2-a', workspace: 'default', ecosystem: 'fix5-probe', nodeData: { type: 'note', label: 'b1', content: 'pangolin fix5 t2 batch body a' } },
            { id: 'fix5-t2-b', workspace: 'default', ecosystem: 'fix5-probe', nodeData: { type: 'note', label: 'b2', content: 'pangolin fix5 t2 batch body b' } },
        ]);
        assert.equal(results.length, 2);
        for (const r of results) {
            assert.ok(r.ok === true, `every batch item must succeed (pre-fix all returned write_failed/invalid_node_id): ${JSON.stringify(r)}`);
        }
        for (const id of ['fix5-t2-a', 'fix5-t2-b']) {
            assert.ok(await client.getNode(id, { workspace: 'default' }), `${id} must be retrievable`);
        }
    });

    await test('T3 top-level id ≠ nodeData.id is refused (invalid_node_id) and persists NOTHING under either id', async () => {
        const res = await lore.nodeUpsert({
            id: 'fix5-t3-top',
            workspace: 'default',
            ecosystem: 'fix5-probe',
            nodeData: { id: 'fix5-t3-nested', type: 'note', label: 'mismatch', content: 'pangolin fix5 t3 mismatch body' },
            skipEmbed: true,
        });
        assert.ok(res.ok === false, `a disagreement must fail, not silently pick a winner: ${JSON.stringify(res)}`);
        assert.equal(res.code, 'invalid_node_id');
        assert.match(res.error.message, /node id mismatch/);
        assert.equal(await client.getNode('fix5-t3-top', { workspace: 'default' }), null,
            'the top-level id must NOT persist (no partial write)');
        assert.equal(await client.getNode('fix5-t3-nested', { workspace: 'default' }), null,
            'the nodeData id must NOT persist either (fail BEFORE any write)');
    });

    await test('T4 populated shape (identical id top-level AND inside nodeData — the store_node/postNode shape) is untouched', async () => {
        const res = await lore.nodeUpsert({
            id: 'fix5-t4-node',
            workspace: 'default',
            ecosystem: 'fix5-probe',
            nodeData: { id: 'fix5-t4-node', type: 'note', label: 'both places', content: 'pangolin fix5 t4 body' },
            skipEmbed: true,
        });
        assert.ok(res.ok === true, `the shape every existing caller uses must keep working: ${JSON.stringify(res)}`);
        assert.ok(await client.getNode('fix5-t4-node', { workspace: 'default' }), 'node must be retrievable');
    });

    await lore.dispose('fix5-id-shape');
    fs.rmSync(dataDir, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
