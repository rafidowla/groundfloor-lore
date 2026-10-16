#!/usr/bin/env tsx
/**
 * 3.35.0 readiness (item 4): verbatim / bulkIngest no-re-embed on re-ingest, through the real embedded `createLore`
 * API on the default SQLite engine. Unlike bulk-ingest-skip-unchanged-wireup this also proves the skip survives a
 * dispose + reopen of the same dataDir (the unchanged-content fingerprint is persisted, not held in memory), that an
 * unchanged single-node re-store embeds nothing, and that vectors remain searchable after skipped re-ingests.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeChecker } from './helpers/readiness335.js';
import { testVectorEngine } from './helpers/testVerbatimStore.js';

process.env['LORE_TEST_VECTOR_ENGINE'] ??= 'sqlite'; // this suite is about the SQLite verbatim engine
const T = makeChecker('readiness335 no-reembed (createLore, SQLite verbatim)');
if (testVectorEngine() !== 'sqlite') {
    console.log('  skip (Lance engine keeps the pre-3.35 re-embed behaviour)');
    process.exit(0);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r335-noreembed-'));
process.env.HOME = path.join(root, 'home'); process.env.LORE_HOME = path.join(root, 'lorehome');
fs.mkdirSync(process.env.HOME, { recursive: true });

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
    dimension: dim, modelId: 'r335-det', dtype: 'fp32',
    async initialize() {}, async embed(t: string) { return vec(t); }, async embedQuery(t: string) { return vec(t); },
    async embedDocument(t: string) { embeds++; return vec(t); },
    async embedDocumentBatch(ts: string[]) { embeds += ts.length; return ts.map(vec); },
    dispose() {},
};
const dataDir = path.join(root, 'data');
const open = () => createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: provider as never });
const mk = (edit: number | number[], n = 30) => Array.from({ length: n }, (_, i) => {
    const id = `nr-${i}`;
    return { id, workspace: 'default', ecosystem: '*', nodeData: { id, type: 'memory', label: id, content: `body of node ${i} about topic ${i % 5}${(Array.isArray(edit) ? edit : [edit]).includes(i) ? ' EDITED' : ''}`, project: 'default', ecosystem: '*' } };
});

let lore = await open();
try {
    const count = (): Promise<number> => lore.store.storageClient.verbatimCount({ workspace: 'default' });
    const run = async (edit: number | number[]) => {
        embeds = 0;
        const r = await lore.bulkIngest(mk(edit) as never, { autolink: false, embed: 'sync' });
        return { ok: r.succeeded, embeds, rows: await count() };
    };
    let r = await run(-1);
    T.check('first ingest embeds all 30', r.ok === 30 && r.embeds === 30 && r.rows === 30, JSON.stringify(r));
    r = await run(-1);
    T.check('identical re-ingest: 0 embeds, rows flat', r.ok === 30 && r.embeds === 0 && r.rows === 30, JSON.stringify(r));
    r = await run(-1);
    T.check('third identical re-ingest: still 0 embeds', r.embeds === 0 && r.rows === 30, JSON.stringify(r));
    r = await run(11);
    T.check('one edited node: exactly 1 embed, rows flat', r.ok === 30 && r.embeds === 1 && r.rows === 30, JSON.stringify(r));
    r = await run(11);
    T.check('re-ingest after the edit: 0 embeds again', r.embeds === 0 && r.rows === 30, JSON.stringify(r));

    await lore.dispose();
    lore = await open();
    const count2 = (): Promise<number> => lore.store.storageClient.verbatimCount({ workspace: 'default' });
    T.check('rows survived dispose + reopen', (await count2()) === 30);
    embeds = 0;
    const r2 = await lore.bulkIngest(mk(11) as never, { autolink: false, embed: 'sync' });
    T.check('after restart: identical ingest still embeds 0', r2.succeeded === 30 && embeds === 0, `succeeded=${r2.succeeded} embeds=${embeds}`);
    embeds = 0;
    const r3 = await lore.bulkIngest(mk([11, 23]) as never, { autolink: false, embed: 'sync' });
    T.check('after restart: one new edit embeds exactly 1', r3.succeeded === 30 && embeds === 1, `succeeded=${r3.succeeded} embeds=${embeds}`);
    T.check('rows flat at 30 after all re-ingests', (await count2()) === 30);

    const rec = await lore.recall('body of node 3 about topic 3', { workspace: 'default', searchMode: 'semantic', mode: 'summary' } as never) as unknown as { hits?: Array<{ id: string }> };
    T.check('semantic recall still returns the vectors after skipped re-ingests', (rec.hits ?? []).length >= 5 && (rec.hits ?? []).every((k) => /^nr-/.test(k.id)), JSON.stringify(rec).slice(0, 160));
} finally {
    await lore.dispose().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
}
T.finish();
