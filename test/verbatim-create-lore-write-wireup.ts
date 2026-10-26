#!/usr/bin/env tsx
/**
 * Wire-up proof (Wave D d1): the embedded `createLore` API, the way Atlas uses it, must either PERSIST a verbatim
 * write or REPORT it failed - never claim success for a write that landed nowhere.
 *
 *   1. bulkIngest(3 nodes, embed:'sync') on the open store          -> succeeded 3, verbatim rows 3
 *   2. the verbatim store is closed (what a shutdown / eviction does) and bulkIngest(2 more nodes) runs
 *      -> the 2 nodes are reported failed (succeeded 0, per-node error), rows stay 3
 *
 * This is a regression guard on the real entry point (real SQLite engine, real outbox, real bulkIngest); it also
 * passes on origin/main for the closed case, which main already rejected. The never-initialized and post-promotion
 * cases fail on main and are proven in sqlite-verbatim-uninitialized-write-unit and verbatim-post-promotion-stale-write-unit.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.LORE_MODEL_SERVER = '0';
const { createLore } = await import('../packages/lore/src/index.js');
const dim = 8;
const vec = (t: string): number[] => {
    const v = new Array(dim).fill(0);
    for (let i = 0; i < t.length; i++) v[i % dim] += t.charCodeAt(i) / 128;
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
};
const provider = {
    dimension: dim, modelId: 'wireup-det', dtype: 'fp32',
    async initialize() {}, async embed(t: string) { return vec(t); }, async embedQuery(t: string) { return vec(t); },
    async embedDocument(t: string) { return vec(t); },
    async embedDocumentBatch(ts: string[]) { return ts.map(vec); },
    dispose() {},
};
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-wireup-'));
const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: provider as never });
let failed = 0;
try {
    const mk = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => {
        const id = `${prefix}-${i}`;
        return { id, workspace: 'default', ecosystem: '*', nodeData: { id, type: 'memory', label: id, content: `body of ${id}`, project: 'default', ecosystem: '*' } };
    });
    const count = (): Promise<number> => lore.store.storageClient.verbatimCount({ workspace: 'default' });

    const open = await lore.bulkIngest(mk('open', 3) as never, { autolink: false, embed: 'sync' });
    assert.equal(open.succeeded, 3);
    assert.equal(await count(), 3, 'writes on the open store persist');
    console.log('  ok   createLore bulkIngest on an open store: 3 succeeded, 3 verbatim rows');

    await (lore.store.loreVerbatim as unknown as { close(): Promise<void> }).close();
    const closed = await lore.bulkIngest(mk('closed', 2) as never, { autolink: false, embed: 'sync' });
    const rowsAfter = (await (async () => {
        const reopened = lore.store.loreVerbatim as unknown as { initialize(): Promise<void>; count(): Promise<number> };
        await reopened.initialize();
        return reopened.count();
    })());
    assert.equal(rowsAfter, 3, 'nothing landed from the write on the closed store');
    assert.equal(closed.succeeded, 0, `a write that landed nowhere must not be reported as succeeded (succeeded=${closed.succeeded} of ${closed.count})`);
    assert.equal(closed.results.filter((r) => !r.ok).length, 2, 'both nodes carry a per-node error');
    console.log('  ok   createLore bulkIngest on a closed store: reported failed, no rows written');
    console.log('\n2 passed, 0 failed');
} catch (e) {
    failed = 1;
    console.error(`  FAIL ${(e as Error).stack ?? (e as Error).message}`);
} finally {
    await lore.dispose().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
}
process.exit(failed);
