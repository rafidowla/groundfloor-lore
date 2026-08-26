// Throwaway repro script — NOT part of the shipped codebase.
// Variant 3: TWO overlapping optimize() calls on the same table, no
// separate writer actor. Models the "next 20-minute tick fires while the
// previous tick's optimize() is still running/hung" scenario described in
// the bug report (occasional hangs blowing past Atlas's RPC timeout) — if
// Atlas's timer isn't guarded against re-entrancy, two optimize() calls
// can genuinely overlap on the same Table handle.
//
// Usage: node _lancedb-fts-optimize-repro-overlap.mjs [durationSeconds]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Schema, Field, Float32, Utf8, List, FixedSizeList } from 'apache-arrow';

const lancedb = await import('@lancedb/lancedb');
const DURATION_S = Number(process.argv[2] ?? 30);
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
const CORRUPTION_PATTERNS = [/Cannot open index on column/i, /Skipping index merge/i, /part_\d+_tokens\.lance.*not found/i, /No such file or directory/i, /panic/i];
const capturedStderr = [];
function installStderrCapture() {
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => { capturedStderr.push(chunk.toString()); return orig(chunk, ...args); };
    return () => { process.stderr.write = orig; };
}

async function main() {
    const restore = installStderrCapture();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lancedb-fts-repro-overlap-'));
    const lancedbDir = path.join(tmpRoot, 'lancedb');
    fs.mkdirSync(lancedbDir, { recursive: true });
    console.log(`[repro-overlap] @lancedb/lancedb version: ${JSON.parse(fs.readFileSync(new URL('../../../node_modules/@lancedb/lancedb/package.json', import.meta.url))).version}`);

    const db = await lancedb.connect(lancedbDir);
    const schema = buildVerbatimSchema(DIM);
    let seed = 0;
    const initialRows = [];
    for (let i = 0; i < 300; i++) initialRows.push(makeRow(seed++));
    const table = await db.createTable('lore_verbatim', initialRows, { schema });
    await table.createIndex('text', { config: lancedb.Index.fts({ baseTokenizer: 'simple', stem: true, removeStopWords: true, lowercase: true }) });
    console.log('[repro-overlap] ready, launching overlapping optimize() loops');

    const deadline = Date.now() + DURATION_S * 1000;
    const errors = [];
    let optimizeCount = 0;
    let liveIds = initialRows.map((r) => r.id);
    let addSeq = 0;

    // Background trickle of writes so there's always something new for
    // each optimize() to compact/merge — without this, two optimize()
    // calls on an unchanged table are trivially compatible.
    async function trickleWriter() {
        while (Date.now() < deadline) {
            const batch = [makeRow(seed++), makeRow(seed++)];
            await table.add(batch);
            liveIds.push(...batch.map((r) => r.id));
            addSeq++;
            if (addSeq % 5 === 0 && liveIds.length > 20) {
                const v = liveIds.splice(0, 1);
                await table.delete(`id = '${v[0]}'`);
            }
            await new Promise((r) => setTimeout(r, 30));
        }
    }

    // Two independent "maintenance timer" loops hitting optimize() on the
    // SAME table concurrently — deliberately unsynchronized, exactly what
    // happens if a slow tick N is still in flight when tick N+1 fires.
    async function overlappingOptimizer(label) {
        while (Date.now() < deadline) {
            const t0 = Date.now();
            try {
                await table.optimize({ cleanupOlderThan: new Date(Date.now()) });
                optimizeCount++;
            } catch (err) {
                errors.push({ label, ms: Date.now() - t0, message: err.message });
            }
        }
    }

    await Promise.all([trickleWriter(), overlappingOptimizer('A'), overlappingOptimizer('B')]);

    const combined = capturedStderr.join('');
    const matched = CORRUPTION_PATTERNS.filter((re) => re.test(combined));

    console.log('\n=== FINAL REPORT (overlap) ===');
    console.log(`optimize() successes: ${optimizeCount}, failures: ${errors.length}`);
    const byMessage = new Map();
    for (const e of errors) {
        const key = e.message.split('\n')[0].slice(0, 120);
        byMessage.set(key, (byMessage.get(key) ?? 0) + 1);
    }
    for (const [msg, count] of byMessage) console.log(`  x${count}: ${msg}`);
    console.log(`bug-signature patterns matched in stderr: ${matched.length ? matched.map(String).join(', ') : 'none'}`);

    let ftsOk = true;
    try {
        const rows = await table.query().fullTextSearch('contract', { columns: 'text' }).limit(5).toArray();
        console.log(`final FTS query returned ${rows.length} rows`);
    } catch (err) {
        ftsOk = false;
        console.log(`final FTS query THREW: ${err.message}`);
    }

    console.log('\n=== VERDICT (overlap) ===');
    console.log((matched.length > 0 || !ftsOk) ? 'REPRODUCED the exact reported error signature.' : 'Did not reproduce the exact reported error signature (may still show related commit-conflict errors above).');

    restore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

main().catch((err) => { console.error('[repro-overlap] FATAL:', err); process.exit(1); });
