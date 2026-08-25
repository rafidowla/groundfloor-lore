/**
 * latency-spotcheck.mjs — what does a recall actually cost, on the current build?
 *
 * The numbers we have today come from the LongMemEval harness, which pulls a
 * 150-result window for scoring. That is an upper bound, not what an agent
 * issues. The MCP `recall` tool defaults to a small seed window and a compact
 * summary, so THAT is the shape measured here. The deep shape is measured too,
 * as contrast, so the difference is visible rather than asserted.
 *
 * Measured 2026-08-19 on an Apple M5 Max (18 cores, 128 GB), embedded mode,
 * warm embedding model, corpus in one workspace:
 *
 *   corpus    agent default p50 / p95     deep window p50 / p95
 *    1,000            21 / 25 ms                52 /  77 ms
 *   10,000            93 / 123 ms              147 / 187 ms
 *   50,000           397 / 527 ms              498 / 682 ms
 *
 * Read those as a floor, not a typical machine — this hardware is generous.
 * Growth is close to linear in corpus size, so a corpus several times larger
 * than 50k is where a typical call would approach a second.
 *
 * Usage: node scripts/latency-spotcheck.mjs <nodeCount> [queries]
 *   (requires a built tree: npm run build)
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

process.env.LORE_LOG_LEVEL = 'error';
const N = Number(process.argv[2] ?? 1000);
const QUERIES = Number(process.argv[3] ?? 60);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-latency-'));
process.env.LORE_HOME = dataDir;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { createLore } = await import(`${ROOT}/dist/lore/src/index.js`);

/* ── corpus: varied, sentence-like text. Uniform filler would flatter both
 *    BM25 and the vector index and make the numbers meaningless. ─────────── */

const SUBJECTS = ['auth', 'billing', 'search', 'ingestion', 'caching', 'the scheduler',
    'the API gateway', 'session handling', 'the migration runner', 'rate limiting',
    'the outbox', 'vector indexing', 'the CLI', 'webhooks', 'audit logging'];
const VERBS = ['was rewritten to', 'now refuses to', 'must never', 'should always',
    'was changed to', 'fails when it tries to', 'was reverted from'];
const OBJECTS = ['retry on conflict', 'hold a lock across the write', 'batch its writes',
    'validate the tenant scope', 'fall back to keyword search', 'emit a structured error',
    'flush before shutdown', 'cache the parsed result', 'expire idle connections',
    'reject an unbounded page size'];
const TYPES = ['decision', 'convention', 'bug_pattern', 'architecture', 'note'];

const pick = (arr, i) => arr[i % arr.length];

const nodes = [];
for (let i = 0; i < N; i++) {
    const subject = pick(SUBJECTS, i);
    const verb = pick(VERBS, i * 7 + 1);
    const object = pick(OBJECTS, i * 3 + 2);
    nodes.push({
        id: `n-${i}`,
        workspace: 'default',
        ecosystem: 'perf',
        nodeData: {
            id: `n-${i}`, ecosystem: 'perf',
            type: pick(TYPES, i * 5),
            label: `${subject} ${verb} ${object}`,
            content: `${subject} ${verb} ${object}. Recorded during work on `
                + `${pick(SUBJECTS, i * 11)}; the reasoning was that `
                + `${pick(OBJECTS, i * 13)} produced incorrect behaviour under load, `
                + `so ${pick(SUBJECTS, i * 17)} had to change as well. Item ${i}.`,
            tags: [pick(TYPES, i * 5), 'perf-corpus'],
        },
    });
}

// Query text must be DISTINCT per iteration. The first version of this file
// used steps that shared factors with the array lengths (i*3 over 15 entries,
// i*5 over 10), which collapsed 60 queries into 10 distinct strings repeated
// six times — so the read cache served most of them and p50 read 2ms while p95
// read 101ms. The bimodal spread was the tell. Steps are now coprime with each
// array length, and uniqueness is asserted rather than assumed.
const askAbout = [];
for (let i = 0; i < QUERIES; i++) {
    askAbout.push(
        `why does ${pick(SUBJECTS, i * 7)} ${pick(VERBS, i * 2)} `
        + `${pick(OBJECTS, i * 3)}?`,
    );
}
const distinct = new Set(askAbout).size;
if (distinct !== askAbout.length) {
    throw new Error(
        `query generator produced ${distinct} distinct of ${askAbout.length} — `
        + 'repeated queries hit the read cache and the timing is meaningless',
    );
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
function stats(ms) {
    const s = [...ms].sort((a, b) => a - b);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    return {
        n: s.length,
        p50: Math.round(pct(s, 0.5)),
        p90: Math.round(pct(s, 0.9)),
        p95: Math.round(pct(s, 0.95)),
        max: Math.round(s[s.length - 1]),
        mean: Math.round(mean),
    };
}

const lore = await createLore({ deploymentMode: 'embedded', dataDir });
try {
    const t0 = Date.now();
    const BATCH = 500;
    let reportedFailures = 0;
    for (let i = 0; i < nodes.length; i += BATCH) {
        const res = await lore.bulkIngest(nodes.slice(i, i + BATCH), { autolink: false, embed: 'sync' });
        const results = res?.results ?? [];
        reportedFailures += results.filter((r) => r && r.ok === false).length;
    }
    const ingestMs = Date.now() - t0;

    // Did every node actually land? A conflict that loses a row silently is a
    // far more interesting result than any latency number.
    const graph = lore._daemon.getGraph();
    const ops = graph.getSchemaGraphOps?.();
    let actuallyStored = null;
    if (ops) {
        let total = 0;
        for (const t of TYPES) total += await ops.countNodesByType(t);
        actuallyStored = total;
    }
    console.error(`[ingest] asked=${N} reportedFailures=${reportedFailures} actuallyStored=${actuallyStored}`);

    // Warm-up: the first call pays for loading the local embedding model. An
    // agent mid-session never pays that, so it is excluded — and called out.
    for (let i = 0; i < 5; i++) {
        await lore.recall(askAbout[i], { workspace: 'default', ecosystem: 'perf' });
    }

    const shapes = {
        'agent default (max 10, summary)': { workspace: 'default', ecosystem: 'perf' },
        'deep window (max 150, full)': { workspace: 'default', ecosystem: 'perf', max: 150, mode: 'full' },
        'keyword only (max 10)': { workspace: 'default', ecosystem: 'perf', searchMode: 'keyword' },
        'semantic only (max 10)': { workspace: 'default', ecosystem: 'perf', searchMode: 'semantic' },
    };

    const out = {
        nodesRequested: N,
        nodesStored: actuallyStored,
        ingestReportedFailures: reportedFailures,
        ingestSeconds: +(ingestMs / 1000).toFixed(1),
        shapes: {},
    };
    for (const [name, opts] of Object.entries(shapes)) {
        const times = [];
        let totalHits = 0;
        for (let i = 0; i < askAbout.length; i++) {
            const t = process.hrtime.bigint();
            const r = await lore.recall(askAbout[i], opts);
            times.push(Number(process.hrtime.bigint() - t) / 1e6);
            totalHits += (r.knowledge ?? r.hits ?? []).length;
        }
        out.shapes[name] = { ...stats(times), avgHits: +(totalHits / askAbout.length).toFixed(1) };
    }
    console.log(JSON.stringify(out, null, 2));
} finally {
    await lore.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
}
