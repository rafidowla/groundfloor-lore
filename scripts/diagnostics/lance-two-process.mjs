#!/usr/bin/env node
/**
 * scripts/diagnostics/lance-two-process.mjs — Q4 from
 * ../nirman-tapestry/docs/lore-asks/QUESTIONS-FOR-LORE.md:
 * "is two-process LanceDB read/write on one directory safe?"
 *
 * Three scenarios, each run for ~2 minutes of wall-clock concurrent traffic
 * against ONE shared LanceDB-backed VerbatimStore directory:
 *
 *   1. reader-opens-empty-dir — process W and process R are started
 *      SIMULTANEOUSLY against an EMPTY directory, so R's `initialize()`
 *      almost certainly runs before the table exists (`this.table` stays
 *      `null` → `count()` returns 0, `search()` returns []). This measures
 *      "a store opened on an empty dir never discovers a table another
 *      process creates later" — it does NOT measure read freshness against
 *      an existing table. See §12.1/§12.3 in docs/PERFORMANCE-MEMORY.md for
 *      why this distinction matters (an earlier pass mislabelled this
 *      result as a general freshness verdict).
 *   1b. reader-opens-after-seed — process W writes ONE batch first; the
 *      orchestrator polls (via short-lived `verify` children) until a
 *      `count() > 0` is confirmed, i.e. the table demonstrably exists on
 *      disk. ONLY THEN does process R open its own `VerbatimStore` against
 *      the same dir and run its read loop for ~2 minutes while W keeps
 *      writing. This is the real "does a long-lived reader in another
 *      process see new commits" question — R's handle is opened against a
 *      table that already exists, so any staleness observed is about
 *      freshness, not discovery.
 *   2. two-writer     — process W1 and process W2 both write continuously
 *      into the SAME table (disjoint id namespaces so a final-count check
 *      is possible), no reader.
 *
 * Every participant is a separate child Node process (spawned with
 * `--import tsx` so the TS source resolves without a dist/ build), each
 * opening its OWN `VerbatimStore` instance against the shared directory —
 * this is the actual multi-process shape the question asks about, not
 * multiple handles inside one process.
 *
 * Each child prints exactly one `RESULT_JSON:<json>` line right before it
 * exits; the parent parses that line. After both/all children exit, the
 * parent opens a FRESH, independent VerbatimStore (a 3rd process) against
 * the same directory to read the final row count with no cached state.
 *
 * Uses a tiny constant-shape fake EmbeddingProvider (no ONNX) so the run
 * time is dominated by LanceDB I/O, not model inference, and so the run is
 * deterministic across machines.
 *
 * MEASUREMENT ONLY. Nothing here edits packages/lore/src/**.
 */

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..');

if (!process.env.__LANCE_2P_REEXEC) {
    const res = spawnSync(
        process.execPath,
        ['--import', 'tsx', SELF, ...process.argv.slice(2)],
        { stdio: 'inherit', cwd: REPO_ROOT, env: { ...process.env, __LANCE_2P_REEXEC: '1' } },
    );
    process.exit(res.status ?? 1);
}

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
};
const ROLE = argOf('--role', null); // internal: 'writer' | 'reader' | 'verify' when re-invoked as a child
const DIR = argOf('--dir', null);
const DURATION_MS = Number.parseInt(argOf('--duration-ms', '120000'), 10);
const WRITER_ID = argOf('--writer-id', 'w1');
const JSON_OUT = argOf('--json', null);

class ConstEmbedProvider {
    dimension = 32;
    modelId = 'lance-2p-harness';
    async initialize() { /* no-op */ }
    async embed(text) { return this.vec(text); }
    async embedQuery(text) { return this.vec(text); }
    async embedDocument(text) { return this.vec(text); }
    async embedDocumentBatch(texts) { return texts.map((t) => this.vec(t)); }
    vec(text) {
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
        let s = h >>> 0;
        const out = new Array(this.dimension);
        for (let i = 0; i < this.dimension; i++) {
            s = (s * 1664525 + 1013904223) >>> 0;
            out[i] = (s / 4294967296) * 2 - 1;
        }
        return out;
    }
}

function classifyError(err) {
    const name = err?.constructor?.name ?? 'Error';
    const msg = String(err?.message ?? err ?? '').split('\n')[0].slice(0, 200);
    return { name, msg };
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------
// Child role: writer — writes batches continuously for DURATION_MS.
// ---------------------------------------------------------------------
async function runWriter() {
    const { VerbatimStore } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/verbatimStore.ts'));
    const store = new VerbatimStore(DIR, new ConstEmbedProvider());
    await store.initialize();

    const deadline = Date.now() + DURATION_MS;
    let batchSeq = 0;
    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    const errors = new Map(); // "Name: msg" -> count
    const errorExamples = [];

    while (Date.now() < deadline) {
        const batchSize = 5;
        const docs = [];
        for (let i = 0; i < batchSize; i++) {
            const id = `lore:2p-${WRITER_ID}-b${batchSeq}-${i}`;
            docs.push({
                id,
                text: `two-process lance harness writer ${WRITER_ID} batch ${batchSeq} entry ${i}. quick brown fox jumps over the lazy dog.`,
                metadata: { type: 'note', label: id, tags: 'lance-2p-harness', project: 'lance-2p-harness', ecosystem: 'lance-2p-harness' },
            });
        }
        attempted += docs.length;
        try {
            await store.storeBatch(docs);
            succeeded += docs.length;
        } catch (err) {
            failed += docs.length;
            const { name, msg } = classifyError(err);
            const key = `${name}: ${msg}`;
            errors.set(key, (errors.get(key) ?? 0) + 1);
            if (errorExamples.length < 10) errorExamples.push(key);
        }
        batchSeq++;
        await sleep(15);
    }

    try { await store.close(); } catch { /* best-effort */ }

    const result = {
        role: 'writer', writerId: WRITER_ID, batches: batchSeq,
        attempted, succeeded, failed,
        errorsByType: Object.fromEntries(errors), errorExamples,
    };
    console.log(`RESULT_JSON:${JSON.stringify(result)}`);
}

// ---------------------------------------------------------------------
// Child role: reader — search() + count() in a loop for DURATION_MS.
// ---------------------------------------------------------------------
async function runReader() {
    const { VerbatimStore } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/verbatimStore.ts'));
    const store = new VerbatimStore(DIR, new ConstEmbedProvider());
    await store.initialize();

    const deadline = Date.now() + DURATION_MS;
    let iterations = 0;
    let searchOk = 0, searchErr = 0, countOk = 0, countErr = 0;
    const errors = new Map();
    const errorExamples = [];
    let prevCount = -1;
    let countRegressions = 0; // count() observed to DECREASE between two reads
    const countSamples = [];
    let malformedHits = 0; // a search hit missing text/score/id
    let maxHitsSeen = 0;
    let firstNonZeroHitAtMs = null;
    const t0 = Date.now();

    while (Date.now() < deadline) {
        iterations++;
        try {
            const hits = await store.search('quick brown fox', 10);
            searchOk++;
            if (hits.length > 0 && firstNonZeroHitAtMs === null) firstNonZeroHitAtMs = Date.now() - t0;
            if (hits.length > maxHitsSeen) maxHitsSeen = hits.length;
            for (const h of hits) {
                if (h == null || typeof h.score !== 'number' || typeof h.text !== 'string' || h.text.length === 0 || !h.id) {
                    malformedHits++;
                }
            }
        } catch (err) {
            searchErr++;
            const { name, msg } = classifyError(err);
            const key = `${name}: ${msg}`;
            errors.set(key, (errors.get(key) ?? 0) + 1);
            if (errorExamples.length < 10) errorExamples.push(key);
        }
        try {
            const c = await store.count();
            countOk++;
            countSamples.push(c);
            if (prevCount !== -1 && c < prevCount) countRegressions++;
            prevCount = c;
        } catch (err) {
            countErr++;
            const { name, msg } = classifyError(err);
            const key = `${name}: ${msg}`;
            errors.set(key, (errors.get(key) ?? 0) + 1);
            if (errorExamples.length < 10) errorExamples.push(key);
        }
        await sleep(50);
    }

    try { await store.close(); } catch { /* best-effort */ }

    // Explicit reconnect at the end — a fresh store.close()+new instance
    // against the SAME dir, to see whether a reconnect (not just a long-
    // lived handle) observes the writer's commits. Answers "is count()'s
    // staleness a stale-handle artifact, or does even a fresh open lag".
    let reconnectCount = null;
    try {
        const { VerbatimStore: VS2 } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/verbatimStore.ts'));
        const fresh = new VS2(DIR, new ConstEmbedProvider());
        await fresh.initialize();
        reconnectCount = await fresh.count();
        await fresh.close();
    } catch { /* best-effort */ }

    const result = {
        role: 'reader', iterations,
        searchOk, searchErr, countOk, countErr,
        countRegressions,
        firstCount: countSamples[0] ?? null,
        lastCount: countSamples[countSamples.length - 1] ?? null,
        maxCountObserved: countSamples.length ? Math.max(...countSamples) : null,
        maxHitsSeen, firstNonZeroHitAtMs,
        reconnectCount,
        malformedHits,
        errorsByType: Object.fromEntries(errors), errorExamples,
    };
    console.log(`RESULT_JSON:${JSON.stringify(result)}`);
}

// ---------------------------------------------------------------------
// Child role: reader1b — scenario 1b. Opens AFTER the caller has confirmed
// (via a separate 'verify' child) that the table already has rows, then
// runs search()/count() in a loop for DURATION_MS same as runReader(), PLUS
// a targeted exact-id freshness probe: `--target-id` names a row the
// orchestrator computed to land a comfortable number of batches AFTER this
// reader's own open, so `getById(targetId)` transitioning from null -> a
// row is a direct, unambiguous "this specific post-open write became
// visible" signal — not confounded by table-didn't-exist-yet (scenario 1's
// issue) or by vector-index top-K ranking noise (a plain content search
// can't guarantee a specific new row surfaces in the top 10 hits).
// ---------------------------------------------------------------------
async function runReader1b() {
    const { VerbatimStore } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/verbatimStore.ts'));
    const store = new VerbatimStore(DIR, new ConstEmbedProvider());
    await store.initialize();
    const targetId = argOf('--target-id', null);

    const t0 = Date.now();
    const deadline = t0 + DURATION_MS;
    let iterations = 0;
    let searchOk = 0, searchErr = 0, countOk = 0, countErr = 0;
    const errors = new Map();
    const errorExamples = [];
    // {tMs, count} per successful count() — timestamped (not just ordinal),
    // so "time-to-first-visible-new-write" via count() is a real elapsed-ms
    // number, not an index-proportional estimate.
    const countSamples = [];
    let countRegressions = 0;
    let malformedHits = 0;
    let maxHitsSeen = 0;
    let firstNonZeroHitAtMs = null; // first time ANY hit came back (table already has rows, so this is expected to be near-0)
    let targetFoundAtMs = null; // first time getById(targetId) resolved — the freshness signal for a write made strictly after this reader opened
    // Periodic (~2s) {tMs, count, hits} snapshots — "search hits over time"
    // / "count over time" as an actual time series, not just first/last/max.
    const timeSeries = [];
    let lastSampledAtMs = -Infinity;

    while (Date.now() < deadline) {
        iterations++;
        const nowMs0 = Date.now() - t0;
        let hitsLen = 0;
        try {
            const hits = await store.search('quick brown fox', 10);
            searchOk++;
            hitsLen = hits.length;
            if (hits.length > 0 && firstNonZeroHitAtMs === null) firstNonZeroHitAtMs = Date.now() - t0;
            if (hits.length > maxHitsSeen) maxHitsSeen = hits.length;
            for (const h of hits) {
                if (h == null || typeof h.score !== 'number' || typeof h.text !== 'string' || h.text.length === 0 || !h.id) {
                    malformedHits++;
                }
            }
        } catch (err) {
            searchErr++;
            const { name, msg } = classifyError(err);
            const key = `${name}: ${msg}`;
            errors.set(key, (errors.get(key) ?? 0) + 1);
            if (errorExamples.length < 10) errorExamples.push(key);
        }
        try {
            const c = await store.count();
            countOk++;
            const tMs = Date.now() - t0;
            const prev = countSamples.length ? countSamples[countSamples.length - 1].count : -1;
            if (prev !== -1 && c < prev) countRegressions++;
            countSamples.push({ tMs, count: c });
        } catch (err) {
            countErr++;
            const { name, msg } = classifyError(err);
            const key = `${name}: ${msg}`;
            errors.set(key, (errors.get(key) ?? 0) + 1);
            if (errorExamples.length < 10) errorExamples.push(key);
        }
        if (targetId && targetFoundAtMs === null) {
            try {
                const rec = await store.getById(targetId);
                if (rec) targetFoundAtMs = Date.now() - t0;
            } catch { /* not found yet / transient — keep polling */ }
        }
        if (nowMs0 - lastSampledAtMs >= 2000) {
            timeSeries.push({ tMs: nowMs0, count: countSamples.length ? countSamples[countSamples.length - 1].count : null, hits: hitsLen });
            lastSampledAtMs = nowMs0;
        }
        await sleep(50);
    }

    try { await store.close(); } catch { /* best-effort */ }

    // Same "explicit reconnect at the end" check as runReader(), PLUS
    // whether a brand-new handle sees the target row — answers "is this a
    // stale-handle artifact of THIS reader's open, or does even a fresh
    // open at end-of-run lag".
    let reconnectCount = null;
    let reconnectTargetFound = null;
    try {
        const { VerbatimStore: VS2 } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/verbatimStore.ts'));
        const fresh = new VS2(DIR, new ConstEmbedProvider());
        await fresh.initialize();
        reconnectCount = await fresh.count();
        if (targetId) {
            try { reconnectTargetFound = Boolean(await fresh.getById(targetId)); } catch { reconnectTargetFound = false; }
        }
        await fresh.close();
    } catch { /* best-effort */ }

    const baselineCount = countSamples.length ? countSamples[0].count : null;
    const firstIncrease = baselineCount === null ? null : countSamples.find((s) => s.count > baselineCount) ?? null;

    const result = {
        role: 'reader1b', iterations,
        searchOk, searchErr, countOk, countErr,
        countRegressions,
        baselineCount,
        firstCount: countSamples[0]?.count ?? null,
        lastCount: countSamples[countSamples.length - 1]?.count ?? null,
        maxCountObserved: countSamples.length ? Math.max(...countSamples.map((s) => s.count)) : null,
        timeToFirstCountIncreaseMs: firstIncrease ? firstIncrease.tMs : null,
        maxHitsSeen, firstNonZeroHitAtMs,
        targetId, targetFoundAtMs,
        reconnectCount, reconnectTargetFound,
        malformedHits,
        timeSeries,
        errorsByType: Object.fromEntries(errors), errorExamples,
    };
    console.log(`RESULT_JSON:${JSON.stringify(result)}`);
}

// ---------------------------------------------------------------------
// Child role: verify — fresh, independent open; report final count().
// ---------------------------------------------------------------------
async function runVerify() {
    const { VerbatimStore } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/verbatimStore.ts'));
    const store = new VerbatimStore(DIR, new ConstEmbedProvider());
    await store.initialize();
    let count = null, err = null;
    try { count = await store.count(); } catch (e) { err = classifyError(e); }
    try { await store.close(); } catch { /* best-effort */ }
    console.log(`RESULT_JSON:${JSON.stringify({ role: 'verify', count, err })}`);
}

// ---------------------------------------------------------------------
// Orchestrator (top-level, no --role): runs both scenarios in sequence.
// ---------------------------------------------------------------------
function spawnChild(role, extraArgs, dir, durationMsOverride = DURATION_MS) {
    return new Promise((resolve) => {
        const args = ['--import', 'tsx', SELF, '--role', role, '--dir', dir, '--duration-ms', String(durationMsOverride), ...extraArgs];
        const child = spawn(process.execPath, args, {
            cwd: REPO_ROOT,
            env: { ...process.env, __LANCE_2P_REEXEC: '1' },
            stdio: ['ignore', 'pipe', 'inherit'],
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.on('close', (code) => {
            const line = out.split('\n').find((l) => l.startsWith('RESULT_JSON:'));
            let parsed = null;
            if (line) {
                try { parsed = JSON.parse(line.slice('RESULT_JSON:'.length)); } catch { /* leave null */ }
            }
            resolve({ code, parsed, rawStdout: out });
        });
        child.on('error', (e) => resolve({ code: -1, parsed: null, rawStdout: '', spawnError: String(e) }));
    });
}

async function runScenario(name, dir, participants) {
    console.log(`\n=== scenario: ${name} — dir=${dir} — duration=${DURATION_MS}ms ===`);
    fs.mkdirSync(dir, { recursive: true });
    const started = Date.now();
    const results = await Promise.all(participants.map((p) => spawnChild(p.role, p.extraArgs ?? [], dir)));
    const elapsedMs = Date.now() - started;
    console.log(`  all participants exited after ${elapsedMs}ms`);
    for (const r of results) {
        if (r.code !== 0) console.log(`  ! participant exited code=${r.code}${r.spawnError ? ` spawnError=${r.spawnError}` : ''}`);
        if (!r.parsed) console.log(`  ! participant produced no RESULT_JSON; raw tail: ${r.rawStdout.slice(-500)}`);
    }
    const verify = await spawnChild('verify', [], dir);
    return { name, dir, elapsedMs, participantResults: results.map((r) => r.parsed), participantExitCodes: results.map((r) => r.code), verify: verify.parsed };
}

// ---------------------------------------------------------------------
// Scenario 1b orchestrator — seed first (writer alone, verified via a
// 'verify' child polling until count() > 0), THEN open the reader against
// the now-existing table and run it concurrently with the still-writing
// writer for ~DURATION_MS. Unlike scenario 1, the reader here can never be
// racing table creation — the orchestrator has direct proof (a real
// count() > 0 from an independent process) that the table exists before
// the reader's own `initialize()` runs.
// ---------------------------------------------------------------------
async function runScenario1b(dir) {
    console.log(`\n=== scenario: 1b-reader-opens-after-seed — dir=${dir} — duration=${DURATION_MS}ms ===`);
    fs.mkdirSync(dir, { recursive: true });
    const readerDurationMs = DURATION_MS; // ~2 min, per the ask
    const writerDurationMs = readerDurationMs + 30000; // outlives the reader's full window + seed-wait margin, so W is still writing for R's entire run
    const started = Date.now();

    // 1. Writer starts alone so the table gets created before any reader touches the dir.
    const writerPromise = spawnChild('writer', ['--writer-id', 'w1b'], dir, writerDurationMs);

    // 2. Poll via independent short-lived 'verify' children until a REAL
    //    count() > 0 comes back — proof the table exists on disk, not an
    //    assumption based on elapsed time.
    const seedDeadline = Date.now() + 20000;
    let seedCount = null;
    let seedWaitedMs = null;
    while (Date.now() < seedDeadline) {
        const v = await spawnChild('verify', [], dir);
        if (v.parsed && typeof v.parsed.count === 'number' && v.parsed.count > 0) {
            seedCount = v.parsed.count;
            seedWaitedMs = Date.now() - started;
            break;
        }
        await sleep(400);
    }
    if (seedCount === null) {
        console.log('  ! seed wait timed out after 20s without a non-zero verify count — aborting scenario 1b');
        await writerPromise; // let the writer finish so we don't leave an orphan child
        return { name: 'scenario-1b-reader-opens-after-seed', dir, seedTimedOut: true };
    }
    console.log(`  seeded: verify count()=${seedCount} after ${seedWaitedMs}ms — opening reader now`);

    // 3. A target id comfortably ahead of the seed point (10 batches × 5
    //    rows = 50-row margin, ~150ms+IO of writer time), so it is
    //    guaranteed to be written strictly AFTER this reader opens, not
    //    racing a batch that landed just before.
    const seedBatchSeq = Math.floor(seedCount / 5);
    const targetBatchSeq = seedBatchSeq + 10;
    const targetId = `lore:2p-w1b-b${targetBatchSeq}-0`;

    // 4. Open the reader now that existence is confirmed; it runs for its
    //    own ~2-minute window while the writer (already running, and set to
    //    outlive this) keeps writing.
    const readerPromise = spawnChild('reader1b', ['--target-id', targetId], dir, readerDurationMs);

    const [writerResult, readerResult] = await Promise.all([writerPromise, readerPromise]);
    const elapsedMs = Date.now() - started;
    console.log(`  writer+reader finished after ${elapsedMs}ms`);
    for (const r of [writerResult, readerResult]) {
        if (r.code !== 0) console.log(`  ! participant exited code=${r.code}${r.spawnError ? ` spawnError=${r.spawnError}` : ''}`);
        if (!r.parsed) console.log(`  ! participant produced no RESULT_JSON; raw tail: ${r.rawStdout.slice(-500)}`);
    }

    const verify = await spawnChild('verify', [], dir);
    return {
        name: 'scenario-1b-reader-opens-after-seed',
        dir, elapsedMs, seedCount, seedWaitedMs, targetId, targetBatchSeq,
        writer: writerResult.parsed, writerExitCode: writerResult.code,
        reader: readerResult.parsed, readerExitCode: readerResult.code,
        verify: verify.parsed,
    };
}

function summarize1b(scn) {
    if (scn.seedTimedOut) return { name: scn.name, seedTimedOut: true };
    const w = scn.writer;
    const r = scn.reader;
    const finalCount = scn.verify?.count ?? null;
    const totalAcked = w?.succeeded ?? null;
    return {
        name: scn.name,
        seedCount: scn.seedCount, seedWaitedMs: scn.seedWaitedMs,
        targetId: scn.targetId, targetBatchSeq: scn.targetBatchSeq,
        writer: w ? { attempted: w.attempted, succeeded: w.succeeded, failed: w.failed, errorsByType: w.errorsByType } : null,
        writerExitCode: scn.writerExitCode,
        reader: r ? {
            iterations: r.iterations, searchOk: r.searchOk, searchErr: r.searchErr,
            countOk: r.countOk, countErr: r.countErr, countRegressions: r.countRegressions,
            baselineCount: r.baselineCount, firstCount: r.firstCount, lastCount: r.lastCount,
            maxCountObserved: r.maxCountObserved, timeToFirstCountIncreaseMs: r.timeToFirstCountIncreaseMs,
            maxHitsSeen: r.maxHitsSeen, firstNonZeroHitAtMs: r.firstNonZeroHitAtMs,
            targetId: r.targetId, targetFoundAtMs: r.targetFoundAtMs,
            reconnectCount: r.reconnectCount, reconnectTargetFound: r.reconnectTargetFound,
            malformedHits: r.malformedHits, timeSeries: r.timeSeries,
            errorsByType: r.errorsByType,
        } : null,
        readerExitCode: scn.readerExitCode,
        totalAcked, finalCount,
        finalCountMatchesAcked: finalCount === totalAcked,
        finalCountDelta: (finalCount == null || totalAcked == null) ? null : finalCount - totalAcked,
    };
}

async function main() {
    if (ROLE === 'writer') return runWriter();
    if (ROLE === 'reader') return runReader();
    if (ROLE === 'reader1b') return runReader1b();
    if (ROLE === 'verify') return runVerify();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-lance-2p-'));
    console.log(`[lance-two-process] root=${root} duration/scenario=${DURATION_MS}ms`);

    // Scenario 1 — writer and reader started SIMULTANEOUSLY against an
    // EMPTY dir. Labelled accurately per docs/PERFORMANCE-MEMORY.md §12.1:
    // this measures table-discovery-on-an-empty-dir, not read freshness
    // against an existing table (that's scenario 1b, below).
    const scenario1Dir = path.join(root, 'scenario-1-reader-opens-empty-dir');
    const scenario1 = await runScenario('reader-opens-empty-dir (writer+reader started simultaneously, table not yet created)', scenario1Dir, [
        { role: 'writer', extraArgs: ['--writer-id', 'w1'] },
        { role: 'reader' },
    ]);

    const scenario1bDir = path.join(root, 'scenario-1b-reader-opens-after-seed');
    const scenario1b = await runScenario1b(scenario1bDir);

    const scenario2Dir = path.join(root, 'scenario-2-two-writers');
    const scenario2 = await runScenario('two-writers', scenario2Dir, [
        { role: 'writer', extraArgs: ['--writer-id', 'w1'] },
        { role: 'writer', extraArgs: ['--writer-id', 'w2'] },
    ]);

    // Consistency check helper: sum acknowledged writes vs verified count.
    function summarize(scn) {
        const writers = scn.participantResults.filter((r) => r && r.role === 'writer');
        const readers = scn.participantResults.filter((r) => r && r.role === 'reader');
        const totalAcked = writers.reduce((s, w) => s + (w.succeeded ?? 0), 0);
        const totalFailed = writers.reduce((s, w) => s + (w.failed ?? 0), 0);
        const finalCount = scn.verify?.count ?? null;
        return {
            name: scn.name,
            writers: writers.map((w) => ({ writerId: w.writerId, attempted: w.attempted, succeeded: w.succeeded, failed: w.failed, errorsByType: w.errorsByType })),
            readers: readers.map((r) => ({ iterations: r.iterations, searchOk: r.searchOk, searchErr: r.searchErr, countOk: r.countOk, countErr: r.countErr, countRegressions: r.countRegressions, firstCount: r.firstCount, lastCount: r.lastCount, maxCountObserved: r.maxCountObserved, maxHitsSeen: r.maxHitsSeen, firstNonZeroHitAtMs: r.firstNonZeroHitAtMs, reconnectCount: r.reconnectCount, malformedHits: r.malformedHits, errorsByType: r.errorsByType })),
            totalAcked, totalFailed, finalCount,
            finalCountMatchesAcked: finalCount === totalAcked,
            finalCountDelta: finalCount == null ? null : finalCount - totalAcked,
            participantExitCodes: scn.participantExitCodes,
        };
    }

    const summary1 = summarize(scenario1);
    const summary1b = summarize1b(scenario1b);
    const summary2 = summarize(scenario2);

    console.log('\n=== SUMMARY: scenario 1 — reader opens on an EMPTY dir ===');
    console.log(JSON.stringify(summary1, null, 2));
    console.log('\n=== SUMMARY: scenario 1b — reader opens AFTER the table is seeded ===');
    console.log(JSON.stringify(summary1b, null, 2));
    console.log('\n=== SUMMARY: two-writers ===');
    console.log(JSON.stringify(summary2, null, 2));

    const verdict = {
        // Scenario 1's own safety numbers (integrity, not freshness — see
        // the note above and readerOnExistingTableSeesNewWrites below).
        readerOnEmptyDirIntegritySafe: summary1.totalFailed === 0
            && summary1.finalCountMatchesAcked
            && summary1.readers.every((r) => r.searchErr === 0 && r.countErr === 0 && r.countRegressions === 0 && r.malformedHits === 0),
        // Scenario 1b — the actual "does a long-lived reader in another
        // process see NEW commits on an already-existing table" question.
        // true only if BOTH the count()-based signal and the exact-id
        // getById() freshness probe actually observed the post-open write
        // during the reader's own run (not just via the end-of-run fresh
        // reconnect, which is a different, already-known-safe path).
        readerOnExistingTableSeesNewWrites: !summary1b.seedTimedOut
            && summary1b.reader != null
            && summary1b.reader.timeToFirstCountIncreaseMs != null
            && summary1b.reader.targetFoundAtMs != null,
        twoWritersSafe: summary2.totalFailed === 0 && summary2.finalCountMatchesAcked,
    };
    console.log('\n=== VERDICT ===');
    console.log(JSON.stringify(verdict, null, 2));

    if (JSON_OUT) {
        fs.writeFileSync(JSON_OUT, JSON.stringify({ scenario1: summary1, scenario1b: summary1b, scenario2: summary2, verdict, root }, null, 2));
        console.log(`\n[lance-two-process] wrote ${JSON_OUT}`);
    }

    fs.rmSync(root, { recursive: true, force: true });
}

main().catch((err) => {
    console.error('[lance-two-process] fatal:', err);
    process.exit(1);
});
