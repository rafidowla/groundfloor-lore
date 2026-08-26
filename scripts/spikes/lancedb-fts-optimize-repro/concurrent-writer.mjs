// Throwaway repro script — NOT part of the shipped codebase.
// Variant 2: CONCURRENT writer + maintenance-optimizer against the same
// Table handle, in one process — the actual topology of Atlas's embedded
// daemon (live MCP writes to lore_verbatim landing in the same process as
// the 20-minute runMaintenance() timer, both racing the same native Table
// object with no mutex between them). The sequential-only variant
// (_lancedb-fts-optimize-repro.mjs) ran 1000 ticks clean; upstream research
// says the closest matching bug class (lance-format/lance#7207, "preempted
// Rewrite strands orphaned index files") is triggered by a concurrent/
// interrupted commit, not steady sequential churn — this tries to produce
// that interleaving directly.
//
// Usage: node _lancedb-fts-optimize-repro-concurrent.mjs [durationSeconds]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Schema, Field, Float32, Utf8, List, FixedSizeList } from 'apache-arrow';

const lancedb = await import('@lancedb/lancedb');

const DURATION_S = Number(process.argv[2] ?? 60);
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

const CORRUPTION_PATTERNS = [
    /Cannot open index on column/i,
    /Skipping index merge/i,
    /part_\d+_tokens\.lance.*not found/i,
    /No such file or directory/i,
    /panic/i,
];
const capturedStderr = [];
function installStderrCapture() {
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
        capturedStderr.push(chunk.toString());
        return originalWrite(chunk, ...args);
    };
    return () => { process.stderr.write = originalWrite; };
}

async function main() {
    const restoreStderr = installStderrCapture();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lancedb-fts-repro-conc-'));
    const lancedbDir = path.join(tmpRoot, 'lancedb');
    fs.mkdirSync(lancedbDir, { recursive: true });
    console.log(`[repro-conc] @lancedb/lancedb version: ${JSON.parse(fs.readFileSync(new URL('../../../node_modules/@lancedb/lancedb/package.json', import.meta.url))).version}`);
    console.log(`[repro-conc] workdir: ${lancedbDir}, duration: ${DURATION_S}s`);

    const db = await lancedb.connect(lancedbDir);
    const schema = buildVerbatimSchema(DIM);
    let seed = 0;
    const initialRows = [];
    for (let i = 0; i < 300; i++) initialRows.push(makeRow(seed++));
    const table = await db.createTable('lore_verbatim', initialRows, { schema });
    await table.createIndex('text', {
        config: lancedb.Index.fts({ baseTokenizer: 'simple', stem: true, removeStopWords: true, lowercase: true }),
    });
    console.log('[repro-conc] table + FTS index ready, starting concurrent actors');

    const deadline = Date.now() + DURATION_S * 1000;
    const writeErrors = [];
    const optimizeErrors = [];
    const optimizeRuns = [];
    let writeCount = 0;
    let optimizeCount = 0;
    let liveIds = initialRows.map((r) => r.id);

    // Actor 1: live writer — mimics real verbatim.store() traffic arriving
    // continuously via MCP tool calls, with no coordination against the
    // maintenance timer. Small batches, back-to-back, occasional deletes
    // (mimicking tombstone/update-by-delete-then-add).
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
            // no delay — fire as fast as the native layer allows, to maximize
            // the chance of overlapping with an in-flight optimize() commit
        }
    }

    // Actor 2: maintenance timer — same call adapters.ts's LanceMaintainer
    // makes, on a short compressed interval instead of 20 real minutes, and
    // with aggressive cleanupOlderThan (see the sequential script for why).
    async function maintenanceLoop() {
        while (Date.now() < deadline) {
            const t0 = Date.now();
            try {
                const stats = await table.optimize({ cleanupOlderThan: new Date(Date.now()) });
                optimizeCount++;
                optimizeRuns.push({ ms: Date.now() - t0, fragmentsRemoved: stats?.compaction?.fragmentsRemoved ?? 0 });
            } catch (err) {
                optimizeErrors.push({ at: Date.now(), ms: Date.now() - t0, message: err.message });
                console.log(`[repro-conc] optimize() THREW: ${err.message}`);
            }
            await new Promise((r) => setTimeout(r, 50)); // small gap, still frequent relative to writer
        }
    }

    // Actor 3: concurrent FTS reader — mimics live bm25Search traffic
    // hitting the index WHILE the maintenance actor is mid-optimize.
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

    const stderrCombined = capturedStderr.join('');
    const matchedPatterns = CORRUPTION_PATTERNS.filter((re) => re.test(stderrCombined));

    console.log('\n=== FINAL REPORT (concurrent) ===');
    console.log(`duration: ${DURATION_S}s`);
    console.log(`row count: ${await table.countRows()}`);
    console.log(`writer: ${writeCount} batches added, ${writeErrors.length} errors`);
    for (const e of writeErrors.slice(0, 10)) console.log(`  write error: ${e.message}`);
    console.log(`maintenance: ${optimizeCount} optimize() calls, ${optimizeErrors.length} errors`);
    for (const e of optimizeErrors.slice(0, 15)) console.log(`  optimize error (${e.ms}ms): ${e.message}`);
    const slow = optimizeRuns.filter((r) => r.ms > 2000);
    console.log(`optimize() calls slower than 2s: ${slow.length}`);
    console.log(`reader: ${searchCount} searches, ${searchErrors.length} errors`);
    for (const e of searchErrors.slice(0, 15)) console.log(`  search error: ${e.message}`);
    console.log(`bug-signature patterns matched in captured stderr: ${matchedPatterns.length ? matchedPatterns.map(String).join(', ') : 'none'}`);

    console.log('\n=== VERDICT (concurrent) ===');
    const reproduced = optimizeErrors.length > 0 || searchErrors.length > 0 || matchedPatterns.length > 0;
    console.log(reproduced ? 'REPRODUCED: signs of index corruption / merge failure observed under concurrency.' : 'NOT REPRODUCED: no corruption signal under this concurrent load.');

    restoreStderr();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

main().catch((err) => {
    console.error('[repro-conc] FATAL:', err);
    process.exit(1);
});
