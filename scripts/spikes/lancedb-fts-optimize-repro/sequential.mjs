// Throwaway repro script — NOT part of the shipped codebase.
// Reproduces (or fails to reproduce) the FTS-index-corruption-on-optimize
// bug against whatever @lancedb/lancedb version is currently installed in
// node_modules. Mirrors the real lore_verbatim table shape from
// packages/lore/src/engines/verbatimStore.ts (buildVerbatimSchema) and the
// real maintenance path from packages/lore/src/engines/maintain/adapters.ts
// (LanceMaintainer.optimizeTable).
//
// Usage: node _lancedb-fts-optimize-repro.mjs [ticks]
//   ticks = number of simulated 20-minute maintenance-timer ticks (default 400)

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Schema, Field, Float32, Utf8, List, FixedSizeList } from 'apache-arrow';

const lancedb = await import('@lancedb/lancedb');

const TICKS = Number(process.argv[2] ?? 400);
const DIM = 8;
const NEW_ROWS_PER_TICK = 6;
const DELETE_EVERY_N_TICKS = 3;
const DELETE_COUNT = 2;

const WORDS = [
    'contract', 'lease', 'renewal', 'tenant', 'landlord', 'invoice', 'payment',
    'schema', 'migration', 'workspace', 'embedding', 'vector', 'index', 'search',
    'approval', 'audit', 'outbox', 'dispatcher', 'node', 'edge', 'graph', 'query',
    'aggregate', 'collection', 'table', 'token', 'tokenizer', 'stemming', 'daemon',
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
        vector: randomVector(seed),
        id: `row-${seed}`,
        text: randomText(seed),
        type: 'note',
        label: null,
        tags: null,
        project: '*',
        ecosystem: '*',
        updatedAt: new Date().toISOString(),
        security_scopes: [],
        contentHash: `hash-${seed}`,
    };
}

/**
 * Purely informational disk snapshot — NOT a corruption verdict. LanceDB is
 * a versioned format: `_indices/<uuid>/` directories from prior versions
 * are expected to persist until `cleanupOlderThan` actually vacuums them,
 * so "a dir not equal to the current listIndices() uuid" is normal
 * time-travel state, not orphaning. We only report the raw count here;
 * the real corruption signal is the exact stderr error text below.
 */
function countIndexDirs(tableDir) {
    const idxDir = path.join(tableDir, '_indices');
    if (!fs.existsSync(idxDir)) return 0;
    return fs.readdirSync(idxDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}

/** The exact error signature from the bug report. Rust's tracing/log
 *  layer writes straight to the process's real stderr fd, bypassing
 *  Node's console — so we hook the fd-level write, not console.error. */
const CORRUPTION_PATTERNS = [
    /Cannot open index on column/i,
    /Skipping index merge/i,
    /part_\d+_tokens\.lance.*not found/i,
    /No such file or directory/i,
];
const capturedStderr = [];
function installStderrCapture() {
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
        const str = chunk.toString();
        capturedStderr.push(str);
        return originalWrite(chunk, ...args);
    };
    return () => { process.stderr.write = originalWrite; };
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
    const restoreStderr = installStderrCapture();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lancedb-fts-repro-'));
    const lancedbDir = path.join(tmpRoot, 'lancedb');
    fs.mkdirSync(lancedbDir, { recursive: true });
    console.log(`[repro] @lancedb/lancedb version: ${JSON.parse(fs.readFileSync(new URL('../../../node_modules/@lancedb/lancedb/package.json', import.meta.url))).version}`);
    console.log(`[repro] workdir: ${lancedbDir}`);
    console.log(`[repro] ticks: ${TICKS}`);

    const db = await lancedb.connect(lancedbDir);
    const schema = buildVerbatimSchema(DIM);

    let seed = 0;
    const initialRows = [];
    for (let i = 0; i < 300; i++) initialRows.push(makeRow(seed++));
    const table = await db.createTable('lore_verbatim', initialRows, { schema });
    console.log(`[repro] created lore_verbatim with ${initialRows.length} seed rows`);

    await table.createIndex('text', {
        config: lancedb.Index.fts({ baseTokenizer: 'simple', stem: true, removeStopWords: true, lowercase: true }),
    });
    console.log('[repro] FTS index built on text');

    try {
        await table.createIndex('vector', { config: lancedb.Index.ivfFlat({ numPartitions: 6 }) });
        console.log('[repro] IVF_FLAT index built on vector');
    } catch (err) {
        console.log(`[repro] vector index build skipped/failed (non-fatal for this repro): ${err.message}`);
    }

    const tableDir = path.join(lancedbDir, 'lore_verbatim.lance');
    const errors = [];
    const slowTicks = [];
    let liveIds = initialRows.map((r) => r.id);

    for (let tick = 1; tick <= TICKS; tick++) {
        const newRows = [];
        for (let i = 0; i < NEW_ROWS_PER_TICK; i++) newRows.push(makeRow(seed++));
        await table.add(newRows);
        liveIds.push(...newRows.map((r) => r.id));

        if (tick % DELETE_EVERY_N_TICKS === 0 && liveIds.length > DELETE_COUNT + 10) {
            const toDelete = liveIds.splice(0, DELETE_COUNT);
            const pred = toDelete.map((id) => `id = '${id}'`).join(' OR ');
            await table.delete(pred);
        }

        // Aggressive cleanup every tick: prune anything not part of the
        // current version. Real production uses a 7-day-old default, so a
        // fast synthetic loop would never actually reach the pruning
        // threshold (wall-clock barely advances) — this compresses the
        // "retention window rolls old fragments/index-segments out from
        // under an in-flight merge" condition into every single tick,
        // which is the state most likely to trigger the reported race.
        const t0 = Date.now();
        try {
            const stats = await withTimeout(
                table.optimize({ cleanupOlderThan: new Date(Date.now()) }),
                20000,
                `optimize() at tick ${tick}`,
            );
            const dt = Date.now() - t0;
            if (dt > 2000) slowTicks.push({ tick, ms: dt });
            if (tick % 25 === 0) {
                const dirs = countIndexDirs(tableDir);
                console.log(`[repro] tick ${tick}/${TICKS}: optimize ${dt}ms, fragmentsRemoved=${stats?.compaction?.fragmentsRemoved ?? 0}, versionsRemoved=${stats?.prune?.oldVersionsRemoved ?? 0}, _indices dirs=${dirs}`);
            }
        } catch (err) {
            const dt = Date.now() - t0;
            errors.push({ tick, ms: dt, message: err.message });
            console.log(`[repro] tick ${tick}: optimize THREW/TIMED OUT after ${dt}ms: ${err.message}`);
        }

        // Periodic functional check, mirroring what bm25Search actually
        // does — not just "did it throw" but "does it still find a term
        // that's definitely in the corpus" (a real-search rows). Catches
        // the case where optimize() itself succeeds but leaves the FTS
        // index unable to answer, not just the case where optimize() throws.
        if (tick % 25 === 0) {
            try {
                const rows = await withTimeout(
                    table.query().fullTextSearch('contract', { columns: 'text' }).limit(5).toArray(),
                    10000,
                    `fullTextSearch at tick ${tick}`,
                );
                if (rows.length === 0) {
                    errors.push({ tick, ms: 0, message: 'fullTextSearch("contract") returned 0 rows on a corpus that definitely contains it' });
                    console.log(`[repro] tick ${tick}: FTS query returned 0 rows unexpectedly`);
                }
            } catch (err) {
                errors.push({ tick, ms: 0, message: `fullTextSearch threw: ${err.message}` });
                console.log(`[repro] tick ${tick}: FTS query THREW: ${err.message}`);
            }
        }
    }

    const finalDirs = countIndexDirs(tableDir);
    const stderrCombined = capturedStderr.join('');
    const matchedPatterns = CORRUPTION_PATTERNS.filter((re) => re.test(stderrCombined));

    console.log('\n=== FINAL REPORT ===');
    console.log(`ticks run: ${TICKS}`);
    console.log(`row count: ${await table.countRows()}`);
    console.log(`optimize()/search() calls that threw or timed out: ${errors.length}`);
    for (const e of errors.slice(0, 15)) console.log(`  tick ${e.tick} (${e.ms}ms): ${e.message}`);
    console.log(`optimize() calls slower than 2s: ${slowTicks.length}`);
    for (const s of slowTicks.slice(0, 10)) console.log(`  tick ${s.tick}: ${s.ms}ms`);
    console.log(`final _indices/ dir count (informational, not a corruption signal by itself): ${finalDirs}`);
    console.log(`bug-signature patterns matched in captured stderr: ${matchedPatterns.length ? matchedPatterns.map(String).join(', ') : 'none'}`);

    let ftsStillFunctional = true;
    try {
        const res = await table.query().fullTextSearch('contract', { columns: 'text' }).limit(5).toArray();
        console.log(`FTS query after churn returned ${res.length} rows`);
    } catch (err) {
        ftsStillFunctional = false;
        console.log(`FTS query after churn THREW: ${err.message}`);
    }

    console.log('\n=== VERDICT ===');
    const reproduced = errors.length > 0 || matchedPatterns.length > 0 || !ftsStillFunctional;
    console.log(reproduced ? 'REPRODUCED: signs of index corruption / merge failure observed.' : 'NOT REPRODUCED: no corruption signal across this run.');

    restoreStderr();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

main().catch((err) => {
    console.error('[repro] FATAL:', err);
    process.exit(1);
});
