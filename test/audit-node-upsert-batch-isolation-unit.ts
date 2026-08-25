#!/usr/bin/env tsx
/**
 * audit-node-upsert-batch-isolation-unit.ts — 2026-08-17 functional-correctness
 * audit, Cluster 3 medium: nodeUpsertBatch threw on the FIRST per-node failure
 * instead of returning per-node results, so a batch that PARTIALLY landed was
 * reported to the caller as entirely failed.
 *
 * Mechanism: the per-node mapLimit callback returned
 * `logEmbeddedWrite(...)`, which RETHROWS the write error after appending its
 * audit row (contract: audit never swallows). That rejection aborted the
 * worker's promise → mapLimit's Promise.all rejected → the whole
 * nodeUpsertBatch threw and every sibling result (successes included) was
 * lost. Fix: the callback converts the rethrow into that node's
 * `{ ok: false, code: 'write_failed' }` result slot.
 *
 * Driven through the real embedded entry point: createLore({deploymentMode:
 * 'embedded'}).nodeUpsertBatch, with the middle node targeting an
 * unregistered workspace (deterministic per-node throw via getGraphHandle —
 * same shape as the SurrealDB conflict throw in the finding).
 *
 * Run: npm run test:unit:audit-node-upsert-batch-isolation
 */

import assert from 'node:assert/strict';
import { createLore } from '../packages/lore/src/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

function auditRows(dataDir: string): Array<{ toolName?: string; result?: string; args?: { nodeId?: string } }> {
    const p = path.join(dataDir, 'audit.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function main() {
    const dataDir = process.env.LORE_HOME!;
    const lore = await createLore({ deploymentMode: 'embedded', dataDir });

    console.log('C3-medium — nodeUpsertBatch isolates per-node failures');

    await test('batch [ok, unknown-workspace, ok] resolves with per-node results; siblings still land', async () => {
        const badWs = 'does-not-exist-' + Date.now();
        const mk = (id: string, workspace: string) => ({
            id, workspace, ecosystem: 'probe',
            nodeData: { id, type: 'note', label: id, content: `content of ${id}` },
        });

        // Pre-fix this REJECTED outright (first failure aborted the batch).
        const results = await lore.nodeUpsertBatch([
            mk('c3-iso-good-1', 'default'),
            mk('c3-iso-bad', badWs),
            mk('c3-iso-good-2', 'default'),
        ] as never);

        assert.equal(results.length, 3, 'one result per input node');
        assert.equal(results[0]!.ok, true, `good-1 lands (got ${JSON.stringify(results[0])})`);
        assert.equal(results[1]!.ok, false, 'bad workspace node fails');
        assert.equal((results[1] as { code?: string }).code, 'write_failed', `failure code is write_failed (got ${JSON.stringify(results[1])})`);
        assert.equal(results[2]!.ok, true, `good-2 lands (got ${JSON.stringify(results[2])})`);

        // Every node — including the failed one — got its audit row.
        await lore.awaitEmbeds();
        const rows = auditRows(dataDir).filter((r) => r.toolName === 'lib:nodeUpsertBatch');
        assert.ok(rows.length >= 3, `3 audit rows for the batch (got ${rows.length})`);
        const errRows = rows.filter((r) => r.result === 'error' && r.args?.nodeId === 'c3-iso-bad');
        assert.equal(errRows.length, 1, 'exactly one error audit row, for the failed node');
    });

    await lore.dispose();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
