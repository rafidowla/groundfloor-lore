#!/usr/bin/env node
/**
 * scripts/diagnostics/workspace-profile-memory-measure.mjs — 3.21 Step 5
 * (docs/PERFORMANCE-MEMORY.md §14): per-open-workspace memory cost on the
 * SQLite graph+vector profile, vs the prior SurrealDB+LanceDB profile.
 *
 * Two independent `--mode`s, because "per-open-workspace cost" and "leak
 * across cycles" are different experiments (matching the 3.21 plan's own
 * split, and docs/PERFORMANCE-MEMORY.md §10.2 M2's precedent for the first
 * one):
 *
 *   --mode keep-open (default): opens `--cycles` fresh "workspaces" — a
 *     graph engine + a vector engine, both matching `--profile` — writes
 *     `--entries` nodes/docs to each, and keeps EVERY one open (nothing
 *     closed, nothing GC-eligible) until the end, then reports
 *     (finalRss - baseline) / N. This is "RSS delta per open" — the
 *     steady-state cost of a host keeping N workspaces open at once, the
 *     shape the ≤40 MB/store target is about.
 *
 *   --mode cycle: opens ONE workspace at a time, writes, closes, forces GC,
 *     settles, repeats for `--cycles` cycles (fresh dir each cycle). Samples
 *     RSS twice per cycle — `openRssMb` (after open+write, before close) and
 *     `closeRssMb` (after close + GC + settle) — and reports the post-close
 *     floor's slope across cycles. Should be flat (no leak); a positive
 *     slope means something stays resident after a correct close(), same
 *     shape as §2/§8/§9's SurrealDB finding.
 *
 * `--profile sqlite`        : SqliteGraph + SqliteVerbatimStore — the 3.21
 *                              default for a brand-new local workspace
 *                              (vectorEngineSelector.ts / graphEngineSelector.ts).
 * `--profile surreal-lance` : SurrealGraph + VerbatimStore (LanceDB) — the
 *                              pre-3.21 default, measured the same way for
 *                              a before/after (docs/PERFORMANCE-MEMORY.md §9
 *                              already established SurrealGraph never frees
 *                              its datastore on close; this reproduces that
 *                              cost on the SAME harness as the SQLite number
 *                              so the two are comparable apples-to-apples).
 *
 * Self re-execs with --expose-gc + --import tsx, same pattern as
 * scripts/measure-memory.mjs / open-store-cost-measure.mjs.
 *
 * Use scripts/diagnostics/workspace-profile-memory-repeat.mjs to run this
 * several times (fresh child process each rep) and report median/spread —
 * this script alone is ONE rep.
 *
 * MEASUREMENT ONLY. Nothing here edits packages/lore/src/**.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..');

if (typeof globalThis.gc !== 'function') {
    const res = spawnSync(
        process.execPath,
        ['--expose-gc', '--import', 'tsx', SELF, ...process.argv.slice(2)],
        { stdio: 'inherit', cwd: REPO_ROOT, env: process.env },
    );
    process.exit(res.status ?? 1);
}
const gc = globalThis.gc;

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
};
const PROFILE = argOf('--profile', 'sqlite'); // 'sqlite' | 'surreal-lance'
const MODE = argOf('--mode', 'keep-open'); // 'keep-open' | 'cycle'
const CYCLES = Number.parseInt(argOf('--cycles', '15'), 10);
const ENTRIES = Number.parseInt(argOf('--entries', '100'), 10);
const SETTLE_MS = Number.parseInt(argOf('--settle-ms', '200'), 10);
const SKIP_WARMUP = Number.parseInt(argOf('--skip-warmup', '3'), 10);
const JSON_OUT = argOf('--json', null);

if (PROFILE !== 'sqlite' && PROFILE !== 'surreal-lance') {
    console.error(`unknown --profile ${PROFILE} (expected sqlite | surreal-lance)`);
    process.exit(2);
}

const MB = 1024 * 1024;
const toMb = (b) => b / MB;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function settledSample() {
    gc();
    await sleep(SETTLE_MS);
    gc();
    const mu = process.memoryUsage();
    return { rssMb: toMb(mu.rss), heapUsedMb: toMb(mu.heapUsed), externalMb: toMb(mu.external) };
}

class FakeEmbeddingProvider {
    dimension = 32;
    modelId = 'workspace-profile-harness';
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

const filler = 'lorem ipsum dolor sit amet consectetur adipiscing '.repeat(6);

function makeDoc(cycle, i) {
    return {
        id: `wsprofile-cycle${cycle}-${i}`,
        text: `Workspace profile harness verbatim entry cycle ${cycle} #${i}. ${filler}`,
        metadata: {
            type: 'note', label: `entry c${cycle}#${i}`, tags: 'memory-harness',
            project: 'memory-harness', ecosystem: 'memory-harness',
        },
    };
}

function makeNode(cycle, i) {
    return {
        id: `wsprofile-node-c${cycle}-${i}`,
        type: 'note',
        label: `workspace profile node c${cycle}#${i}`,
        content: `Workspace profile harness node cycle ${cycle} #${i}. ${filler}`,
        tags: ['memory-harness'],
        project: 'memory-harness',
        ecosystem: 'memory-harness',
        metadata: '{}',
    };
}

/** OLS slope of y over x=0..n-1 (MB per cycle) + R^2. Independent copy of
 *  the same formula used elsewhere in this sprint's harnesses (measure-
 *  memory.mjs / memory-open-close-cycles-unit.ts) — kept local so this
 *  script has no import dependency on either. */
function linregSlope(ys) {
    const n = ys.length;
    if (n < 2) return { slope: 0, r2: 0 };
    const xs = Array.from({ length: n }, (_, i) => i);
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - meanX) * (ys[i] - meanY); den += (xs[i] - meanX) ** 2; }
    const slope = den === 0 ? 0 : num / den;
    const intercept = meanY - slope * meanX;
    let ssTot = 0, ssRes = 0;
    for (let i = 0; i < n; i++) {
        const pred = intercept + slope * xs[i];
        ssRes += (ys[i] - pred) ** 2;
        ssTot += (ys[i] - meanY) ** 2;
    }
    const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
    return { slope, r2 };
}

function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const n = s.length;
    if (n === 0) return NaN;
    return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

async function openEngines(dir, cycle) {
    if (PROFILE === 'sqlite') {
        const { SqliteGraph } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/sqliteGraph.ts'));
        const { SqliteVerbatimStore } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/sqliteVerbatimStore.ts'));
        const graph = new SqliteGraph(dir, { workspaceId: `wsprofile-${cycle}` });
        const vector = new SqliteVerbatimStore(dir, new FakeEmbeddingProvider());
        await graph.initialize();
        await vector.initialize();
        return { graph, vector };
    }
    const { SurrealGraph } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/surrealGraph.ts'));
    const { VerbatimStore } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/verbatimStore.ts'));
    const graph = new SurrealGraph(dir, { workspaceId: `wsprofile-${cycle}` });
    const vector = new VerbatimStore(dir, new FakeEmbeddingProvider());
    await graph.initialize();
    await vector.initialize();
    return { graph, vector };
}

/** --mode keep-open: opens CYCLES workspaces, keeps them ALL alive, reports
 *  (finalRss - baseline) / CYCLES. Same shape as open-store-cost-measure.mjs
 *  §10.2 M2, extended to open the GRAPH engine too (not vector-only), since
 *  a "workspace" on the SQLite profile is graph+vector together. */
async function mainKeepOpen() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-wsprofile-keepopen-${PROFILE}-`));
    const baseline = await settledSample();
    console.log(`[workspace-profile] mode=keep-open profile=${PROFILE} n=${CYCLES} entries=${ENTRIES} baseline rss=${baseline.rssMb.toFixed(1)}MB`);

    const held = [];
    const perStoreRss = [];
    let prevRssMb = baseline.rssMb;
    for (let i = 1; i <= CYCLES; i++) {
        const dir = fs.mkdtempSync(path.join(home, `ws-${i}-`));
        const { graph, vector } = await openEngines(dir, i);
        const nodes = Array.from({ length: ENTRIES }, (_, j) => makeNode(i, j));
        await graph.bulkUpsertNodes(nodes);
        for (let j = 0; j < ENTRIES; j++) {
            await vector.store(makeDoc(i, j));
        }
        held.push({ graph, vector }); // keep alive — nothing GC-eligible
        gc();
        const rssMb = toMb(process.memoryUsage().rss);
        perStoreRss.push(rssMb - prevRssMb); // incremental delta, cycle 1 includes one-time module load
        prevRssMb = rssMb;
    }

    const finalSample = await settledSample();
    const totalDeltaMb = finalSample.rssMb - baseline.rssMb;
    const perOpenDeltaMedianMb = totalDeltaMb / CYCLES;
    // Also report the median of the WINDOWED incremental per-store deltas
    // (skips the first store's one-time native-module-load cost), which is
    // the more honest "cost of the Nth store" once warm — the ÷N figure
    // above dilutes that one-time cost across all N and understates it at
    // small N, overstates the true per-store marginal cost less as N grows.
    const windowedIncremental = perStoreRss.slice(SKIP_WARMUP);
    const summary = {
        profile: PROFILE,
        mode: 'keep-open',
        n: CYCLES,
        entries: ENTRIES,
        baselineRssMb: baseline.rssMb,
        finalRssMb: finalSample.rssMb,
        totalDeltaMb,
        perOpenDeltaAvgMb: perOpenDeltaMedianMb,
        perOpenDeltaMedianIncrementalMb: windowedIncremental.length ? median(windowedIncremental) : null,
        perOpenDeltaMinIncrementalMb: windowedIncremental.length ? Math.min(...windowedIncremental) : null,
        perOpenDeltaMaxIncrementalMb: windowedIncremental.length ? Math.max(...windowedIncremental) : null,
    };

    console.log(`[workspace-profile] keep-open: total delta=${totalDeltaMb.toFixed(1)}MB over n=${CYCLES} `
        + `-> avg/store=${perOpenDeltaMedianMb.toFixed(2)}MB, median incremental (post-warmup)=`
        + `${summary.perOpenDeltaMedianIncrementalMb == null ? 'n/a' : summary.perOpenDeltaMedianIncrementalMb.toFixed(2) + 'MB'}`);

    try { for (const { graph, vector } of held) { await graph.close?.(); await vector.close?.(); } } catch { /* best-effort */ }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }

    const result = { summary, perStoreIncrementalDeltasMb: perStoreRss };
    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
}

async function mainCycle() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-wsprofile-${PROFILE}-`));
    const baseline = await settledSample();
    console.log(`[workspace-profile] mode=cycle profile=${PROFILE} cycles=${CYCLES} entries=${ENTRIES} baseline rss=${baseline.rssMb.toFixed(1)}MB`);

    const samples = [];
    let prevCloseRssMb = baseline.rssMb;

    for (let c = 1; c <= CYCLES; c++) {
        const t0 = performance.now();
        const dir = fs.mkdtempSync(path.join(home, `ws-${c}-`));
        const { graph, vector } = await openEngines(dir, c);

        const nodes = Array.from({ length: ENTRIES }, (_, i) => makeNode(c, i));
        await graph.bulkUpsertNodes(nodes);
        for (let i = 0; i < ENTRIES; i++) {
            await vector.store(makeDoc(c, i));
        }

        gc();
        const muOpen = process.memoryUsage();
        const openRssMb = toMb(muOpen.rss);
        const openHeapUsedMb = toMb(muOpen.heapUsed);
        const openExternalMb = toMb(muOpen.external);

        await graph.close();
        await vector.close();

        const closeSample = await settledSample();
        const elapsedMs = performance.now() - t0;

        const perOpenDeltaMb = openRssMb - prevCloseRssMb;
        samples.push({
            cycle: c,
            openRssMb, openHeapUsedMb, openExternalMb,
            closeRssMb: closeSample.rssMb, closeHeapUsedMb: closeSample.heapUsedMb, closeExternalMb: closeSample.externalMb,
            perOpenDeltaMb,
            elapsedMs,
        });
        prevCloseRssMb = closeSample.rssMb;
    }

    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }

    const windowed = samples.filter((s) => s.cycle > SKIP_WARMUP);
    const perOpenDeltas = windowed.map((s) => s.perOpenDeltaMb);
    const floorSeries = windowed.map((s) => s.closeRssMb);
    const { slope: floorSlopeMbPerCycle, r2: floorR2 } = linregSlope(floorSeries);
    const { slope: heapFloorSlope, r2: heapFloorR2 } = linregSlope(windowed.map((s) => s.closeHeapUsedMb));

    const summary = {
        profile: PROFILE,
        cycles: CYCLES,
        entries: ENTRIES,
        skipWarmupCycles: SKIP_WARMUP,
        baselineRssMb: baseline.rssMb,
        perOpenDeltaMedianMb: median(perOpenDeltas),
        perOpenDeltaMinMb: Math.min(...perOpenDeltas),
        perOpenDeltaMaxMb: Math.max(...perOpenDeltas),
        floorFirstMb: floorSeries[0],
        floorLastMb: floorSeries[floorSeries.length - 1],
        floorGrowthMb: floorSeries[floorSeries.length - 1] - floorSeries[0],
        floorSlopeMbPerCycle,
        floorR2,
        heapFloorSlopeMbPerCycle: heapFloorSlope,
        heapFloorR2,
    };

    console.log(`[workspace-profile] per-open delta: median=${summary.perOpenDeltaMedianMb.toFixed(2)}MB `
        + `min=${summary.perOpenDeltaMinMb.toFixed(2)}MB max=${summary.perOpenDeltaMaxMb.toFixed(2)}MB `
        + `(window: cycles ${SKIP_WARMUP + 1}..${CYCLES})`);
    console.log(`[workspace-profile] post-close floor: ${summary.floorFirstMb.toFixed(1)}MB -> ${summary.floorLastMb.toFixed(1)}MB `
        + `(growth=${summary.floorGrowthMb.toFixed(1)}MB, slope=${floorSlopeMbPerCycle.toFixed(3)}MB/cycle, R^2=${floorR2.toFixed(3)})`);

    const result = { summary, samples };
    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
}

if (MODE !== 'keep-open' && MODE !== 'cycle') {
    console.error(`unknown --mode ${MODE} (expected keep-open | cycle)`);
    process.exit(2);
}
const main = MODE === 'keep-open' ? mainKeepOpen : mainCycle;
main().catch((err) => { console.error(err); process.exit(1); });
