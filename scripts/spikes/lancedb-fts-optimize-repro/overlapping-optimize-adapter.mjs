// Benchmark script — NOT part of the shipped runtime, not run by `npm test`.
// Same scenario as overlapping-optimize.mjs, but both "maintenance timer"
// actors go through the REAL LanceMaintainer.optimizeTable() (via two
// independent LanceMaintainer instances, same directory) instead of calling
// table.optimize() directly. Models two maintenance-timer calls overlapping
// with no shared state between them (e.g. a slow/hung tick still running
// when the next tick fires) — the adversarial case that the
// retryOptimizeOnConflict fix improves but does not fully eliminate, since
// retry-with-checkout only protects one caller's own retry loop, not two
// independent callers racing each other.
//
// Run with tsx:
//   npx tsx scripts/spikes/lancedb-fts-optimize-repro/overlapping-optimize-adapter.mjs [durationSeconds]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Schema, Field, Float32, Utf8, List, FixedSizeList } from 'apache-arrow';
import { LanceMaintainer } from '../../../packages/lore/src/engines/maintain/adapters.ts';

const lancedb = await import('@lancedb/lancedb');
const DURATION_S = Number(process.argv[2] ?? 15);
const DIM = 8;
const WORDS = ['contract', 'lease', 'renewal', 'tenant', 'landlord', 'invoice', 'payment', 'schema', 'migration', 'workspace'];

function randomText(seed) {
    const n = 8 + (seed % 12);
    const out = [];
    for (let i = 0; i < n; i++) out.push(WORDS[(seed * 31 + i * 17) % WORDS.length]);
    return out.join(' ');
}
function randomVector(seed) {
    const v = [];
    for (let i = 0; i < DIM; i++) v.push(((seed * 7 + i * 13) % 1000) / 1000);
    return v;
}
function buildVerbatimSchema(dimension) {
    return new Schema([
        new Field('vector', new FixedSizeList(dimension, new Field('item', new Float32(), true)), false),
        new Field('id', new Utf8(), false),
        new Field('text', new Utf8(), false),
        new Field('type', new Utf8(), true), new Field('label', new Utf8(), true),
        new Field('tags', new Utf8(), true), new Field('project', new Utf8(), true),
        new Field('ecosystem', new Utf8(), true), new Field('updatedAt', new Utf8(), true),
        new Field('security_scopes', new List(new Field('item', new Utf8(), true)), true),
        new Field('contentHash', new Utf8(), true),
    ]);
}
function makeRow(seed) {
    return {
        vector: randomVector(seed), id: `row-${seed}`, text: randomText(seed),
        type: 'note', label: null, tags: null, project: '*', ecosystem: '*',
        updatedAt: new Date().toISOString(), security_scopes: [], contentHash: `hash-${seed}`,
    };
}

async function main() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lancedb-bench-overlap-'));
    const lancedbDir = path.join(tmpRoot, 'lancedb');
    fs.mkdirSync(lancedbDir, { recursive: true });
    console.log(`[bench-overlap] @lancedb/lancedb version: ${JSON.parse(fs.readFileSync(new URL('../../../node_modules/@lancedb/lancedb/package.json', import.meta.url))).version}`);

    const db = await lancedb.connect(lancedbDir);
    const schema = buildVerbatimSchema(DIM);
    let seed = 0;
    const initialRows = [];
    for (let i = 0; i < 300; i++) initialRows.push(makeRow(seed++));
    const table = await db.createTable('lore_verbatim', initialRows, { schema });
    await table.createIndex('text', { config: lancedb.Index.fts({ baseTokenizer: 'simple', stem: true, removeStopWords: true, lowercase: true }) });
    console.log('[bench-overlap] ready, launching overlapping optimizeTable() loops');

    // Two independent LanceMaintainer instances, same directory — exactly
    // "two maintenance timers racing," through the real adapter class.
    const maintainerA = new LanceMaintainer(lancedbDir);
    const maintainerB = new LanceMaintainer(lancedbDir);

    const deadline = Date.now() + DURATION_S * 1000;
    const errors = [];
    let optimizeCount = 0;
    let liveIds = initialRows.map((r) => r.id);
    let addSeq = 0;

    const writerErrors = [];
    async function trickleWriter() {
        while (Date.now() < deadline) {
            try {
                const batch = [makeRow(seed++), makeRow(seed++)];
                await table.add(batch);
                liveIds.push(...batch.map((r) => r.id));
                addSeq++;
                if (addSeq % 5 === 0 && liveIds.length > 20) {
                    const v = liveIds.splice(0, 1);
                    await table.delete(`id = '${v[0]}'`);
                }
            } catch (err) {
                writerErrors.push({ ms: Date.now(), message: err.message });
            }
            await new Promise((r) => setTimeout(r, 30));
        }
    }

    async function overlappingOptimizer(label, maintainer) {
        while (Date.now() < deadline) {
            const t0 = Date.now();
            try {
                await maintainer.optimizeTable('lore_verbatim', { compact: true, cleanupOlderThanMs: 0, now: Date.now() });
                optimizeCount++;
            } catch (err) {
                errors.push({ label, ms: Date.now() - t0, message: err.message });
            }
        }
    }

    await Promise.all([trickleWriter(), overlappingOptimizer('A', maintainerA), overlappingOptimizer('B', maintainerB)]);

    console.log('\n=== FINAL REPORT (adapter-routed, overlapping optimize) ===');
    const total = optimizeCount + errors.length;
    console.log(`optimizeTable() successes: ${optimizeCount}, failures: ${errors.length} out of ${total} attempts (${((errors.length / Math.max(1, total)) * 100).toFixed(1)}% failure rate)`);
    console.log(`trickleWriter errors (separate, unrelated table handle): ${writerErrors.length}`);
    for (const e of writerErrors.slice(0, 5)) console.log(`  writer error: ${e.message.split('\n')[0].slice(0, 160)}`);
    const byMessage = new Map();
    for (const e of errors) {
        const key = e.message.split('\n')[0].slice(0, 100);
        byMessage.set(key, (byMessage.get(key) ?? 0) + 1);
    }
    for (const [msg, count] of byMessage) console.log(`  x${count}: ${msg}`);

    let ftsOk = true;
    try {
        const rows = await table.query().fullTextSearch('contract', { columns: 'text' }).limit(5).toArray();
        console.log(`final FTS query returned ${rows.length} rows`);
    } catch (err) {
        ftsOk = false;
        console.log(`final FTS query THREW: ${err.message}`);
    }
    console.log(`FTS still functional: ${ftsOk}`);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

main().catch((err) => { console.error('[bench-overlap] FATAL:', err); process.exit(1); });
