// Benchmark script — NOT part of the shipped runtime, not run by `npm test`.
// Same scenario as concurrent-writer.mjs, but the maintenance actor goes
// through the REAL LanceMaintainer.optimizeTable()
// (packages/lore/src/engines/maintain/adapters.ts) instead of calling
// table.optimize() directly — this measures the actual shipped code path's
// failure rate, and was used to validate the retryOptimizeOnConflict fix.
//
// Run with tsx (needs TS import resolution):
//   npx tsx scripts/spikes/lancedb-fts-optimize-repro/concurrent-writer-adapter.mjs [durationSeconds]
// Optional: WRITER_DELAY_MS=20 to pace the writer to a more realistic rate
// (the default, 0, is an intentionally extreme zero-gap stress test).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Schema, Field, Float32, Utf8, List, FixedSizeList } from 'apache-arrow';
import { LanceMaintainer } from '../../../packages/lore/src/engines/maintain/adapters.ts';

const lancedb = await import('@lancedb/lancedb');

const DURATION_S = Number(process.argv[2] ?? 15);
const WRITER_DELAY_MS = Number(process.env.WRITER_DELAY_MS ?? 0);
const DIM = 8;

const WORDS = [
    'contract', 'lease', 'renewal', 'tenant', 'landlord', 'invoice', 'payment',
    'schema', 'migration', 'workspace', 'embedding', 'vector', 'index', 'search',
    'approval', 'audit', 'outbox', 'dispatcher', 'node', 'edge', 'graph', 'query',
];

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
        new Field('type', new Utf8(), true),
        new Field('label', new Utf8(), true),
        new Field('tags', new Utf8(), true),
        new Field('project', new Utf8(), true),
        new Field('ecosystem', new Utf8(), true),
        new Field('updatedAt', new Utf8(), true),
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
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lancedb-bench-conc-'));
    const lancedbDir = path.join(tmpRoot, 'lancedb');
    fs.mkdirSync(lancedbDir, { recursive: true });
    console.log(`[bench-conc] @lancedb/lancedb version: ${JSON.parse(fs.readFileSync(new URL('../../../node_modules/@lancedb/lancedb/package.json', import.meta.url))).version}`);
    console.log(`[bench-conc] duration: ${DURATION_S}s, writer delay: ${WRITER_DELAY_MS}ms, routing maintenance through the REAL LanceMaintainer.optimizeTable()`);

    const db = await lancedb.connect(lancedbDir);
    const schema = buildVerbatimSchema(DIM);
    let seed = 0;
    const initialRows = [];
    for (let i = 0; i < 300; i++) initialRows.push(makeRow(seed++));
    const table = await db.createTable('lore_verbatim', initialRows, { schema });
    await table.createIndex('text', {
        config: lancedb.Index.fts({ baseTokenizer: 'simple', stem: true, removeStopWords: true, lowercase: true }),
    });
    console.log('[bench-conc] table + FTS index ready, starting concurrent actors');

    const maintainer = new LanceMaintainer(lancedbDir);
    const deadline = Date.now() + DURATION_S * 1000;
    const writeErrors = [];
    const optimizeErrors = [];
    let writeCount = 0;
    let optimizeCount = 0;
    let liveIds = initialRows.map((r) => r.id);

    async function writerLoop() {
        while (Date.now() < deadline) {
            try {
                const batch = [];
                for (let i = 0; i < 4; i++) batch.push(makeRow(seed++));
                await table.add(batch);
                liveIds.push(...batch.map((r) => r.id));
                writeCount++;
                if (writeCount % 7 === 0 && liveIds.length > 20) {
                    const victims = liveIds.splice(0, 2);
                    await table.delete(victims.map((id) => `id = '${id}'`).join(' OR '));
                }
            } catch (err) {
                writeErrors.push({ at: Date.now(), message: err.message });
            }
            if (WRITER_DELAY_MS > 0) await new Promise((r) => setTimeout(r, WRITER_DELAY_MS));
        }
    }

    // Maintenance actor — REAL adapter, real optimizeTable() signature.
    async function maintenanceLoop() {
        while (Date.now() < deadline) {
            const t0 = Date.now();
            try {
                await maintainer.optimizeTable('lore_verbatim', { compact: true, cleanupOlderThanMs: 0, now: Date.now() });
                optimizeCount++;
            } catch (err) {
                optimizeErrors.push({ at: Date.now(), ms: Date.now() - t0, message: err.message });
            }
            await new Promise((r) => setTimeout(r, 50));
        }
    }

    const searchErrors = [];
    let searchCount = 0;
    async function readerLoop() {
        while (Date.now() < deadline) {
            try {
                await table.query().fullTextSearch('contract', { columns: 'text' }).limit(5).toArray();
                searchCount++;
            } catch (err) {
                searchErrors.push({ at: Date.now(), message: err.message });
            }
            await new Promise((r) => setTimeout(r, 20));
        }
    }

    await Promise.all([writerLoop(), maintenanceLoop(), readerLoop()]);

    console.log('\n=== FINAL REPORT (adapter-routed, concurrent writer+reader) ===');
    console.log(`duration: ${DURATION_S}s`);
    console.log(`row count: ${await table.countRows()}`);
    console.log(`writer: ${writeCount} batches added, ${writeErrors.length} errors`);
    const total = optimizeCount + optimizeErrors.length;
    console.log(`maintenance: ${optimizeCount} optimizeTable() successes, ${optimizeErrors.length} failures out of ${total} attempts (${((optimizeErrors.length / Math.max(1, total)) * 100).toFixed(1)}% failure rate)`);
    const byMessage = new Map();
    for (const e of optimizeErrors) {
        const key = e.message.split('\n')[0].slice(0, 100);
        byMessage.set(key, (byMessage.get(key) ?? 0) + 1);
    }
    for (const [msg, count] of byMessage) console.log(`  x${count}: ${msg}`);
    console.log(`reader: ${searchCount} searches, ${searchErrors.length} errors`);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

main().catch((err) => { console.error('[bench-conc] FATAL:', err); process.exit(1); });
