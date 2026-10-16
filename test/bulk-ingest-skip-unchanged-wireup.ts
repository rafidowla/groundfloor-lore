#!/usr/bin/env tsx
/**
 * Wire-up proof (3.35.0): the embedded `createLore` API, the way Atlas uses it, must stop re-embedding an unchanged
 * corpus. `bulkIngest(20 nodes, { autolink:false, embed:'sync' })` twice → 20 embeds then 0, rows 20 then 20; one
 * edited node → exactly 1 embed. Only meaningful on the SQLite verbatim engine (Lance keeps the old behaviour).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { testVectorEngine } from './helpers/testVerbatimStore.js';

if (testVectorEngine() !== 'sqlite') {
    console.log('  skip (Lance engine keeps the pre-3.35 re-embed behaviour; covered by bulk-ingest-skip-unchanged-unit)');
    process.exit(0);
}

const { createLore } = await import('../packages/lore/src/index.js');
const dim = 8;
let embeds = 0;
const vec = (t: string): number[] => {
    const v = new Array(dim).fill(0);
    for (let i = 0; i < t.length; i++) v[i % dim] += t.charCodeAt(i) / 128;
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
};
const provider = {
    dimension: dim, modelId: 'wireup-det', dtype: 'fp32',
    async initialize() {}, async embed(t: string) { return vec(t); }, async embedQuery(t: string) { return vec(t); },
    async embedDocument(t: string) { embeds++; return vec(t); },
    async embedDocumentBatch(ts: string[]) { embeds += ts.length; return ts.map(vec); },
    dispose() {},
};
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-skip-wireup-'));
const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: provider as never });
try {
    const mk = (edit: number) => Array.from({ length: 20 }, (_, i) => {
        const id = `wire-${i}`;
        return { id, workspace: 'default', ecosystem: '*', nodeData: { id, type: 'memory', label: id, content: `body of node ${i}${edit === i ? ' EDITED' : ''}`, project: 'default', ecosystem: '*' } };
    });
    const count = (): Promise<number> => lore.store.storageClient.verbatimCount({ workspace: 'default' });
    const run = async (edit: number) => {
        embeds = 0;
        const r = await lore.bulkIngest(mk(edit) as never, { autolink: false, embed: 'sync' });
        assert.equal(r.succeeded, 20);
        return { embeds, rows: await count() };
    };
    assert.deepEqual(await run(-1), { embeds: 20, rows: 20 });
    assert.deepEqual(await run(-1), { embeds: 0, rows: 20 }, 'identical re-ingest: no embeds, rows flat');
    assert.deepEqual(await run(7), { embeds: 1, rows: 20 }, 'one edited node: exactly one embed');
    console.log('  ok   createLore bulkIngest: 20/0/1 embeds, 20/20/20 rows');
    console.log('\n1 passed, 0 failed');
} finally {
    await lore.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
}
process.exit(0);
