#!/usr/bin/env tsx
/**
 * audit-ra2-bulk-upsert-batch-unit.ts — re-audit 2026-06-25-reaudit2
 * (bulk wall-time follow-up).
 *
 * bulkUpsertNodes exists so a whole batch writes without N round-trips
 * (originally LocalGraph's one write-lane trip with statements prepared
 * once — ~1.9x faster than N× upsertNode on a re-scan; SurrealGraph keeps
 * the same batched surface). This pins its CORRECTNESS: create + update
 * (createdAt preserved), duplicate-id-in-batch, and per-node error isolation.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const node = (id: string, content: string) => ({
    id, type: 'code-file', label: id, content,
    project: 'bt', ecosystem: '*', tags: 'code', embed: false,
} as never);

async function withGraph(fn: (g: SurrealGraph) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ra2-batch-'));
    const g = new SurrealGraph(dir);
    try { await g.initialize(); await fn(g); }
    finally { await g.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log('RA2 — bulkUpsertNodes correctness');

await test('creates a batch; every node persisted + readable with its content', async () => {
    await withGraph(async (g) => {
        const batch = Array.from({ length: 50 }, (_, i) => node(`n${i}`, `body ${i}`));
        const res = await g.bulkUpsertNodes(batch);
        assert.equal(res.filter((r) => r.ok).length, 50, 'all 50 ok');
        for (let i = 0; i < 50; i++) {
            const n = await g.getNode(`n${i}`);
            assert.ok(n, `n${i} readable`);
            assert.equal(n!.content, `body ${i}`, `n${i} content`);
        }
    });
});

await test('re-upsert updates content + PRESERVES createdAt (SET path)', async () => {
    await withGraph(async (g) => {
        await g.bulkUpsertNodes([node('x', 'v1')]);
        const before = await g.getNode('x');
        await new Promise((r) => setTimeout(r, 5));
        const res = await g.bulkUpsertNodes([node('x', 'v2')]);
        assert.ok(res[0]!.ok);
        const after = await g.getNode('x');
        assert.equal(after!.content, 'v2', 'content updated');
        assert.equal(after!.createdAt, before!.createdAt, 'createdAt preserved across update');
        assert.notEqual(after!.updatedAt, before!.updatedAt, 'updatedAt advanced');
    });
});

await test('duplicate id within one batch is handled (second takes the SET path)', async () => {
    await withGraph(async (g) => {
        const res = await g.bulkUpsertNodes([node('dup', 'first'), node('dup', 'second')]);
        assert.equal(res.filter((r) => r.ok).length, 2, 'both report ok');
        const n = await g.getNode('dup');
        assert.equal(n!.content, 'second', 'last write wins');
    });
});

await test('per-node error isolation — a bad node fails in its slot, the rest succeed', async () => {
    await withGraph(async (g) => {
        // A non-string id breaks the write for that one node; neighbours are fine.
        const batch = [node('ok1', 'a'), { ...node('', 'b'), id: 123 as unknown as string }, node('ok2', 'c')];
        const res = await g.bulkUpsertNodes(batch as never);
        assert.ok(res[0]!.ok, 'ok1 succeeded');
        assert.ok(res[2]!.ok, 'ok2 succeeded (batch continued past the bad node)');
        assert.ok(await g.getNode('ok1') && await g.getNode('ok2'), 'good nodes persisted');
    });
});

await test('anchor_stale / anchor_stale_since round-trip through bulkUpsertNodes (CREATE + SET)', async () => {
    await withGraph(async (g) => {
        // CREATE path — a node marked anchor-stale must PERSIST the flag + timestamp.
        // Regression guard: setStmt/createStmt formerly omitted these columns, so a
        // bulk check_anchors(mark_stale=true) silently dropped the flag (same write-side
        // gap that was fixed in single-node upsertNode).
        const since = '2026-07-02T00:00:00.000Z';
        await g.bulkUpsertNodes([{ ...node('as1', 'body'), anchor_stale: true, anchor_stale_since: since } as never]);
        const created = await g.getNode('as1');
        assert.equal(created!.anchor_stale, true, 'anchor_stale persisted on CREATE');
        assert.equal(created!.anchor_stale_since, since, 'anchor_stale_since persisted on CREATE');
        // SET path — clearing the flag on re-upsert must also persist (not stay true).
        await g.bulkUpsertNodes([{ ...node('as1', 'body2'), anchor_stale: false } as never]);
        const updated = await g.getNode('as1');
        assert.ok(!updated!.anchor_stale, 'anchor_stale cleared on SET');
    });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
