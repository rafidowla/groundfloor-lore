#!/usr/bin/env node
/**
 * scripts/measure-memory.mjs — memory-leak sprint, Step 1: PROVE the leak on 3.19.1.
 *
 * Repeatedly opens ONE workspace, writes a batch of verbatim entries, and
 * closes it fully — then samples process memory after each cycle. A flat
 * RSS trend across cycles means close() genuinely releases memory; a rising
 * trend confirms the leak described in the sprint background (5 cycles of
 * one workspace: 1,429 MB -> 1,969 MB RSS with a FLAT JS heap — i.e. the
 * growth is NATIVE, not GC-visible garbage).
 *
 * Known root causes this is expected to reproduce (fixed in a LATER step,
 * not here):
 *   1. engines/verbatimStore.ts close() (~:1798) drains the read pool but
 *      never calls this.table.close() / this.db.close() on the native
 *      LanceDB handles — it only nulls the references.
 *   2. outbox/workspaceVerbatimResolver.ts has no idle eviction.
 *   3. storage/loadJobsStore.ts's better-sqlite3 handle isn't in the
 *      shutdown close set.
 *   4. providers/localEmbeddingProvider.ts caches an ONNX pipeline with no
 *      release path.
 *
 * ── Three configs, three different things being isolated ───────────────
 *
 *   inproc   — bare `VerbatimStore`, in-process LanceDB, no SurrealDB, no
 *              createLore() overhead, a FAKE embedding provider (no ONNX).
 *              Isolates root cause #1 as cleanly and cheaply as possible.
 *
 *   worker   — same engine-level harness, but the vector store is a
 *              `VerbatimSearchWorkerProxy` (LORE_SEARCH_WORKER=1): the real
 *              LanceDB native handle lives in a CHILD process that gets
 *              SIGKILLed on close(). This answers a real design question —
 *              does routing the native store through a disposable worker
 *              process HIDE the parent-process symptom, even though root
 *              cause #1 in the child is unfixed? (A `parentEmbedder` is
 *              passed so the child never loads a real ONNX model either —
 *              it receives pre-computed vectors over IPC.)
 *
 *   embedded — the full public API surface via
 *              `createLore({ deploymentMode: 'embedded' })` + `dispose()`.
 *              This is what an embedding host (e.g. Atlas) actually calls.
 *              It exercises SurrealDB + VerbatimStore + loadJobsStore +
 *              the REAL local ONNX embedding provider together, closest to
 *              the background numbers (1,429 MB -> 1,969 MB) which were
 *              measured through a full embedding-host process, not a bare
 *              LanceDB handle.
 *
 * ── RESULT (Step 1, measured 2026-09-17, after the confound fix below) ──
 *
 * Only `embedded` reproduces a leak. 50-cycle runs on this machine
 * (darwin/arm64, node 22.23.2, 200 entries/cycle):
 *
 *   inproc:   slope -0.13 MB/cycle, R^2=0.09  (flat — noise)
 *   worker:   slope -0.11 MB/cycle, R^2=0.11  (flat — noise; 0 leaked/
 *             orphaned child processes at every sample)
 *   embedded: slope +100.2 MB/cycle, R^2=1.00 (1,066 MB -> 5,804 MB over
 *             50 cycles; heapUsed essentially flat at ~226-228 MB the whole
 *             run — the growth is entirely native, not JS-heap garbage,
 *             exactly matching the sprint background's framing)
 *
 * `inproc`'s own docstring reasoning above (root cause #1 — VerbatimStore
 * dereferences its native LanceDB handles instead of closing them) predicts
 * a leak here too, and it does NOT reproduce one, with or without forcing a
 * GC every cycle (`--force-gc 0`). The likely reason: once `store` (the
 * only reference to the old VerbatimStore, and transitively its `table`/
 * `db` wrapper objects) goes out of scope, ANY V8 GC — forced or the
 * engine's own incremental one, both observed to run in this harness even
 * without --force-gc, because per-cycle heap churn from string/array
 * allocations is enough to trigger it on its own — collects the whole
 * graph, and LanceDB's napi bindings apparently free the native handle on
 * GC. So root cause #1 is real (close() really doesn't call the native
 * close), but in THIS harness's low-JS-heap-churn, isolated shape, GC
 * reaps it before it accumulates. `embedded`'s much larger, longer-lived
 * object graph (SurrealDB connection, ONNX pipeline, loadJobsStore,
 * WorkspaceVerbatimResolver, audit/outbox subsystems — see
 * STEP2-CLOSE-PATH-DESIGN.md item (d) for the audit of what else holds a
 * long-lived native handle) is where the leak actually shows up. Full
 * numbers, all three configs, in docs/PERFORMANCE-MEMORY.md.
 *
 * All three configs re-open and re-close the SAME workspace NAME/PATH
 * across every cycle inside one temp LORE_HOME (not a fresh temp dir per
 * cycle) — that's the exact "close a workspace, reopen it" shape the
 * background numbers describe, not N independent workspaces.
 *
 * ── Fixed confound (owner decision, 2026-09-17) ─────────────────────────
 *
 * An earlier partial run of this harness (kept, not deleted: see
 * scratchpad mm_inproc_15.log) reused the SAME on-disk `.lore/` data across
 * every cycle, so entry count — and therefore FTS/vector index size — grew
 * monotonically with the cycle number. That run's own numbers show it:
 * cycle time rose from 4.4s (cycle 1) to 23.1s (cycle 10) purely from data
 * volume, which mixes "more data costs more RSS" into "the leak costs more
 * RSS" and makes the slope uninterpretable.
 *
 * Fix: the workspace NAME/PATH is constant across cycles (unchanged — this
 * is still the "close a workspace, reopen it" shape, not N independent
 * workspaces), but after every close() this harness deletes that path's
 * `.lore/` directory and lets the next cycle's open() recreate it empty.
 * Every cycle therefore opens an EMPTY store and writes the same ENTRIES
 * count — data volume is flat across the whole run, so a rising RSS slope
 * can only be the open/close leak. Cycle times are printed precisely so
 * this is checkable: a flat-data run has flat cycle times too.
 *
 * ── Attribution (3.19.1) — six more configs ─────────────────────────────
 *
 * On top of the three configs above, docs/PERFORMANCE-MEMORY.md's
 * "Attribution (3.19.1)" section adds SIX configs to isolate which
 * subsystem(s) account for `embedded`'s ~100 MB/cycle: `embedded-empty`,
 * `embedded-precomputed`, `embed-only`, `surreal-only`, `inproc-nogc`, and
 * `workspace-cycle`. Their cycle bodies + fd/substrate-file sampling live in
 * the sibling module `scripts/measure-memory-configs.mjs` (kept separate so
 * this file stays under its line budget) — see that file's header for what
 * each one isolates and why. `inproc-nogc` needs no new cycle body: it is
 * `inproc` with forced GC turned off, handled here as a RUN_CONFIG alias.
 *
 * Usage:
 *   node --expose-gc --import tsx scripts/measure-memory.mjs --config inproc
 *   node scripts/measure-memory.mjs --config worker --cycles 50 --entries 200
 *   node scripts/measure-memory.mjs --config embedded --json /tmp/embedded.json
 *   node scripts/measure-memory.mjs --config workspace-cycle --cycles 15
 *
 * (If not already running with --expose-gc, the script re-execs itself with
 * `node --expose-gc --import tsx <self>` so GC is deterministic and TS
 * source imports resolve without a `dist/` build — same pattern as
 * scripts/diagnostics/surreal-scale-parity.mjs.)
 */

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    sampleFdCount,
    sampleSubstrateFileCounts,
    runEmbeddedEmptyCycle,
    runEmbeddedPrecomputedCycle,
    runEmbedOnlyCycle,
    runSurrealOnlyCycle,
    runWorkspaceCycle,
} from './measure-memory-configs.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');

// ── self re-exec with --expose-gc + --import tsx ────────────────────────
if (typeof globalThis.gc !== 'function') {
    const res = spawnSync(
        process.execPath,
        ['--expose-gc', '--import', 'tsx', SELF, ...process.argv.slice(2)],
        { stdio: 'inherit', cwd: REPO_ROOT, env: process.env },
    );
    process.exit(res.status ?? 1);
}
const gc = globalThis.gc;

/* ─── args ───────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
};
const CONFIG = argOf('--config', process.env.MEMORY_CONFIG ?? 'inproc');
const CYCLES = Number.parseInt(argOf('--cycles', process.env.MEMORY_CYCLES ?? '50'), 10);
const ENTRIES = Number.parseInt(argOf('--entries', process.env.MEMORY_ENTRIES ?? '200'), 10);
const JSON_OUT = argOf('--json', null);
// Diagnostic-only escape hatch, default on (matches the mandated protocol:
// force a full GC after every close so JS-heap garbage can't masquerade as
// a native leak). `--force-gc 0` skips the forced collection to answer a
// different question — "does this leak under normal V8 GC scheduling, with
// no operator forcing a full collection?" — which matters because V8 has no
// visibility into napi/native heap growth unless the addon explicitly calls
// napi_adjust_external_memory; if LanceDB's bindings don't, a tiny/flat JS
// heapUsed (as this harness's own FakeEmbeddingProvider produces) may never
// give V8 a reason to run a full GC on its own, so an in-practice leak could
// still be real even though forcing GC every cycle makes it disappear here.
let FORCE_GC = argOf('--force-gc', '1') !== '0';

const VALID_CONFIGS = [
    'inproc', 'worker', 'embedded',
    // Attribution (3.19.1) additions — see the header comment and
    // scripts/measure-memory-configs.mjs.
    'embedded-empty', 'embedded-precomputed', 'embed-only', 'surreal-only',
    'inproc-nogc', 'workspace-cycle',
];
if (!VALID_CONFIGS.includes(CONFIG)) {
    console.error(`unknown --config "${CONFIG}" (expected one of: ${VALID_CONFIGS.join(', ')})`);
    process.exit(2);
}
// `inproc-nogc` is plain `inproc` with forced GC off, as a single
// reproducible config name rather than a flag combination a reader has to
// notice. RUN_CONFIG drives cycle-body dispatch below; CONFIG (unchanged)
// still labels console output and the JSON `config` field.
if (CONFIG === 'inproc-nogc') FORCE_GC = false;
const RUN_CONFIG = CONFIG === 'inproc-nogc' ? 'inproc' : CONFIG;
/** Attribution configs that construct a Lore-adjacent object per cycle
 *  (i.e. NOT the persistent single-instance `workspace-cycle` shape) and
 *  should sample fds / substrate-file counts each cycle. */
const SAMPLE_FDS_CONFIGS = new Set([
    'embedded-empty', 'embedded-precomputed', 'embed-only', 'surreal-only',
]);

/* ─── fake embedding provider (no ONNX; deterministic, cheap) ───────── */

class FakeEmbeddingProvider {
    dimension = 32;
    modelId = 'fake-memory-harness';
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

/* ─── memory sampling ────────────────────────────────────────────────── */

const MB = 1024 * 1024;
const toMb = (bytes) => bytes / MB;

/** Parse `vmmap --summary <pid>`'s "Physical footprint" line (the number
 *  Apple's own tooling reports — distinct from, and usually lower than,
 *  Node's RSS, which includes mapped-but-not-resident pages). Returns null
 *  (never throws) when vmmap is unavailable, needs elevated privilege, or
 *  the platform isn't darwin — callers must treat null as "not measured". */
function vmmapFootprintMb(pid) {
    if (process.platform !== 'darwin') return null;
    try {
        const out = execFileSync('vmmap', ['--summary', String(pid)], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const m = /Physical footprint:\s+([\d.]+)([KMG])/.exec(out);
        if (!m) return null;
        const value = Number.parseFloat(m[1]);
        const unit = m[2];
        const mult = unit === 'G' ? 1024 : unit === 'K' ? 1 / 1024 : 1;
        return value * mult;
    } catch {
        return null; // not installed, needs sudo, timed out, or process already gone
    }
}

function sampleMemory(label, opts = {}) {
    // Force a full GC before sampling so JS-heap garbage can't masquerade
    // as a native leak; if GC is unavailable this still samples (with a
    // note), it just won't be as clean a signal. --force-gc 0 skips this
    // deliberately — see the flag's definition above for why that's a
    // meaningfully different measurement, not just a noisier one.
    if (FORCE_GC) {
        try { gc(); } catch { /* --expose-gc missing; already handled by re-exec above */ }
    }
    const mu = process.memoryUsage();
    const vmmap = vmmapFootprintMb(process.pid);
    const sample = {
        label,
        rssMb: toMb(mu.rss),
        heapUsedMb: toMb(mu.heapUsed),
        externalMb: toMb(mu.external),
        arrayBuffersMb: toMb(mu.arrayBuffers ?? 0),
        vmmapFootprintMb: vmmap,
    };
    // Attribution (3.19.1) — open-fd / substrate-file counts, opt-in per
    // caller (SAMPLE_FDS_CONFIGS below / the workspace-cycle driver) since
    // an lsof snapshot on every sample would slow down the original three
    // configs' already-documented 50-cycle runs for no new signal there.
    if (opts.fds) {
        sample.fdCount = sampleFdCount(process.pid);
        Object.assign(sample, sampleSubstrateFileCounts(process.pid));
    }
    return sample;
}

/**
 * Deletes a workspace's `.lore/` data directory (surreal/, lancedb/,
 * fingerprint sidecars — everything VerbatimStore/SurrealGraph/createLore
 * write under a workspace path) without touching the workspace's NAME or
 * PATH (the parent directory, and — for `embedded` — the sibling
 * `workspaces.json` that names it, are left alone). Called after every
 * close() so the next cycle's open() recreates an empty store: same
 * workspace, fresh data, every cycle. See the "Fixed confound" note above.
 */
function resetWorkspaceData(basePath) {
    fs.rmSync(path.join(basePath, '.lore'), { recursive: true, force: true });
}

/**
 * `worker` config only — the real LanceDB native handle lives in a forked
 * child (VerbatimSearchWorkerProxy). close() asks the child to exit and
 * SIGKILLs it if it doesn't, so in the well-behaved case zero children
 * should be alive after a cycle's close() returns. This counts DIRECT
 * children of this process (ppid === our pid) and sums their RSS, so a
 * leaked/orphaned worker (e.g. a restart that spawned a replacement
 * without the old one fully reaping) shows up as a nonzero count instead
 * of silently vanishing into "the parent's RSS looks fine".
 *
 * A freshly-SIGKILLed child sits briefly in a zombie/exiting state before
 * Node's SIGCHLD handling reaps it on its next event-loop tick — that is
 * NORMAL and clears on its own; it is reported separately (`zombieCount`)
 * from `count` (non-zombie, i.e. genuinely still-running children) so a
 * transient zombie at the instant of sampling is never mistaken for an
 * orphaned worker still doing work. The `ps` process this function itself
 * spawns to take the measurement is excluded from both counts (it would
 * otherwise always self-report as "1 child", every cycle, on every
 * platform — noise, not signal).
 */
function sampleWorkerChildren() {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
        return { count: null, zombieCount: null, rssMb: null };
    }
    try {
        const out = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,state=,comm='], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        let count = 0;
        let zombieCount = 0;
        let rssKb = 0;
        for (const line of out.split('\n')) {
            const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
            if (!m) continue;
            const [, , ppidStr, rssStr, state, comm] = m;
            if (Number(ppidStr) === process.pid) {
                if (/(^|\/)ps$/.test(comm.split(' ')[0])) continue; // the sampling `ps` itself
                // macOS reports a zombie's state starting with '?' (unreadable)
                // or 'Z'; Linux reports 'Z'. Either way it holds ~0 RSS and is
                // mid-reap, not a live process still doing work.
                if (state.startsWith('Z') || state.startsWith('?')) { zombieCount++; continue; }
                count++;
                rssKb += Number(rssStr) || 0;
            }
        }
        return { count, zombieCount, rssMb: rssKb / 1024 };
    } catch {
        return { count: null, zombieCount: null, rssMb: null }; // ps unavailable — not measured
    }
}

/** Ordinary least squares slope of y over x=0..n-1 (MB per cycle). */
function linregSlope(ys) {
    const n = ys.length;
    if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0 };
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
    return { slope, intercept, r2 };
}

/* ─── cycle bodies ───────────────────────────────────────────────────── */

function makeDoc(cycle, i) {
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing '.repeat(6); // ~300 chars
    return {
        id: `mem-cycle${cycle}-${i}`,
        text: `Memory harness verbatim entry cycle ${cycle} #${i}. ${filler}`,
        metadata: {
            type: 'note',
            label: `mem entry c${cycle}#${i}`,
            tags: 'memory-harness',
            project: 'memory-harness',
            ecosystem: 'memory-harness',
        },
    };
}

/** inproc / worker — engine-level cycle against a bare VerbatimStore (or
 *  its search-worker-isolated subclass), reused workspace dir across cycles. */
async function runEngineCycle(config, workspaceDir, cycle, entries) {
    const { VerbatimStore } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/verbatimStore.ts'));
    let store;
    if (config === 'worker') {
        const { VerbatimSearchWorkerProxy } = await import(
            path.join(REPO_ROOT, 'packages/lore/src/engines/verbatimSearchWorkerProxy.ts')
        );
        // parentEmbedder: the child never loads a real ONNX model — it gets
        // pre-computed vectors over IPC and a stub provider sized to match.
        store = new VerbatimSearchWorkerProxy(workspaceDir, undefined, new FakeEmbeddingProvider());
    } else {
        store = new VerbatimStore(workspaceDir, new FakeEmbeddingProvider());
    }
    await store.initialize();
    for (let i = 0; i < entries; i++) {
        await store.store(makeDoc(cycle, i));
    }
    await store.close();
}

/** embedded — full createLore() lifecycle, same on-disk dataDir reused
 *  across cycles (dispose() + a fresh createLore() call each cycle). */
async function runEmbeddedCycle(createLore, dataDir, cycle, entries) {
    const lore = await createLore({ deploymentMode: 'embedded', dataDir });
    for (let i = 0; i < entries; i++) {
        const doc = makeDoc(cycle, i);
        await lore.store.storageClient.verbatimStore(doc);
    }
    await lore.dispose(`measure-memory-cycle-${cycle}`);
}

/* ─── workspace-cycle driver ─────────────────────────────────────────────
 * Structurally different from every other config: ONE Lore instance lives
 * for the whole run (constructed once, disposed once) instead of being
 * opened/closed per cycle, and each cycle's "unit of work" is a whole
 * register/open/write/evict/unregister sequence against a fresh workspace,
 * not a single store's store()/close(). Kept as its own driver rather than
 * shoehorned into the generic per-cycle loop below. See
 * scripts/measure-memory-configs.mjs's runWorkspaceCycle() docstring for the
 * full per-cycle sequence and the two-homes finding it depends on. */
async function runWorkspaceCycleMain() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-memharness-workspace-cycle-'));
    process.env['LORE_HOME'] = home;

    console.log(`Lore memory harness — config=workspace-cycle cycles=${CYCLES} entries/cycle=${ENTRIES}`);
    console.log(`node ${process.versions.node} · ${process.platform}/${process.arch} · LORE_HOME=${home}`);
    console.log('');

    const { createLore } = await import(path.join(REPO_ROOT, 'packages/lore/src/index.ts'));
    const { createWorkspace, registerWorkspaceAlias, deleteWorkspace } = await import(
        path.join(REPO_ROOT, 'packages/lore/src/config/workspaces.ts')
    );
    const dataDir = path.join(home, 'embedded-instance');
    const lore = await createLore({ deploymentMode: 'embedded', dataDir });
    const deps = { createWorkspace, registerWorkspaceAlias, deleteWorkspace, makeDoc };

    const samples = [];
    samples.push({ cycle: 0, ...sampleMemory('baseline', { fds: true }), elapsedMs: 0, registryOpenCount: 0, resolverOpenCount: 0 });

    for (let c = 1; c <= CYCLES; c++) {
        const t0 = performance.now();
        const r = await runWorkspaceCycle(deps, lore, home, dataDir, c, ENTRIES);
        const elapsedMs = performance.now() - t0;
        const sample = {
            cycle: c, ...sampleMemory(`after-cycle-${c}`, { fds: true }), elapsedMs,
            registryOpenCount: r.registryOpenCount,
            resolverOpenCount: r.resolverOpenCount,
            evictedByRegistry: r.evictedByRegistry,
            nodesSucceeded: r.succeeded,
            nodesFailed: r.failed,
        };
        samples.push(sample);
        process.stdout.write(
            `  cycle ${String(c).padStart(3)}/${CYCLES}  `
            + `rss=${sample.rssMb.toFixed(1).padStart(8)} MB  `
            + `fds=${String(sample.fdCount).padStart(4)}  `
            + `lance=${String(sample.lanceFiles).padStart(3)}  `
            + `registryOpen=${String(sample.registryOpenCount).padStart(2)}  `
            + `resolverOpen=${String(sample.resolverOpenCount).padStart(2)}  `
            + `nodesOk=${String(sample.nodesSucceeded).padStart(3)}/${sample.nodesSucceeded + sample.nodesFailed}  `
            + `(${elapsedMs.toFixed(0)} ms)\n`,
        );
    }

    await lore.dispose('measure-memory-workspace-cycle-done');

    const regressionStart = CYCLES >= 5 ? 5 : 1;
    const regressionSamples = samples.filter((s) => s.cycle >= regressionStart);
    const rssReg = linregSlope(regressionSamples.map((s) => s.rssMb));
    const resolverReg = linregSlope(regressionSamples.map((s) => s.resolverOpenCount));
    const first = samples[1];
    const last = samples[samples.length - 1];
    const regFirst = regressionSamples[0];
    const regLast = regressionSamples[regressionSamples.length - 1];

    console.log('');
    console.log(`Full range (cycle 1 -> ${CYCLES}):`);
    console.log(`  RSS:            first=${first.rssMb.toFixed(1)} MB  last=${last.rssMb.toFixed(1)} MB  delta=${(last.rssMb - first.rssMb).toFixed(1)} MB`);
    console.log(`  resolverOpen:   first=${first.resolverOpenCount}  last=${last.resolverOpenCount}  (registry side stayed at ${last.registryOpenCount} via evictIdle each cycle)`);
    console.log(`Regression window (cycle ${regressionStart} -> ${CYCLES}, warm-up excluded):`);
    console.log(`  RSS:            first=${regFirst.rssMb.toFixed(1)} MB  last=${regLast.rssMb.toFixed(1)} MB  `
        + `delta=${(regLast.rssMb - regFirst.rssMb).toFixed(1)} MB  slope=${rssReg.slope.toFixed(3)} MB/cycle  R^2=${rssReg.r2.toFixed(3)}`);
    console.log(`  resolverOpen:   slope=${resolverReg.slope.toFixed(3)} handles/cycle  R^2=${resolverReg.r2.toFixed(3)}`
        + (resolverReg.slope > 0.9 ? '  <-- growing ~1/cycle: NO per-workspace resolver eviction in 3.19.1' : ''));

    const result = {
        tool: 'measure-memory.mjs', config: 'workspace-cycle', cycles: CYCLES, entriesPerCycle: ENTRIES,
        node: process.versions.node, platform: `${process.platform}/${process.arch}`,
        loreVersion: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version,
        timestamp: new Date().toISOString(), home, samples,
        regressionWindow: { startCycle: regressionStart, endCycle: CYCLES },
        regression: { rss: rssReg, resolverOpenCount: resolverReg },
        fullRange: { first, last, deltaMb: { rss: last.rssMb - first.rssMb } },
    };
    if (JSON_OUT) {
        fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
        console.log(`\nJSON written to ${JSON_OUT}`);
    }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/* ─── driver ─────────────────────────────────────────────────────────── */

async function main() {
    // workspace-cycle has its own driver (structurally different — one
    // persistent Lore instance, not open/close per cycle). Dispatch before
    // any of the generic per-cycle setup below.
    if (RUN_CONFIG === 'workspace-cycle') {
        await runWorkspaceCycleMain();
        return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-memharness-${CONFIG}-`));
    process.env['LORE_HOME'] = home;
    // Every config gets a FAKE/no-op sync target — this harness never talks
    // to Dataplane; leaving DATAPLANE_API_KEY unset (the common case) is fine.
    if (RUN_CONFIG === 'worker') {
        // Not read by VerbatimSearchWorkerProxy itself (this harness
        // constructs it directly, bypassing the daemon's selection logic in
        // mcp/services.ts) — set anyway so env dumps / process listings
        // self-document which harness mode produced them.
        process.env['LORE_SEARCH_WORKER'] = '1';
    }

    console.log(`Lore memory harness — config=${CONFIG} cycles=${CYCLES} entries/cycle=${ENTRIES}`);
    console.log(`node ${process.versions.node} · ${process.platform}/${process.arch} · LORE_HOME=${home}`);
    console.log('');

    let createLore;
    let dataDir;
    let workspaceDir;
    let basePath; // the one path whose `.lore/` gets wiped between cycles (undefined for embed-only: no on-disk store)
    let LocalEmbeddingProvider, embedModelId, embedDim; // embed-only
    let SurrealGraph; // surreal-only
    let computeContentHash; // embedded-precomputed
    const NEEDS_LORE = ['embedded', 'embedded-empty', 'embedded-precomputed'].includes(RUN_CONFIG);
    if (NEEDS_LORE) {
        let dim;
        ({ createLore, DEFAULT_LOCAL_MODEL_DIM: dim } = await import(path.join(REPO_ROOT, 'packages/lore/src/index.ts')));
        embedDim = dim;
        dataDir = path.join(home, 'embedded-instance');
        basePath = dataDir; // first-run migration makes the "default" workspace's path == dataDir itself
        if (RUN_CONFIG === 'embedded-precomputed') {
            ({ computeContentHash } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/contentHash.ts')));
        }
    } else if (RUN_CONFIG === 'embed-only') {
        ({ LocalEmbeddingProvider, DEFAULT_LOCAL_MODEL_ID: embedModelId, DEFAULT_LOCAL_MODEL_DIM: embedDim } =
            await import(path.join(REPO_ROOT, 'packages/lore/src/providers/localEmbeddingProvider.ts')));
        // No on-disk store at all for this config — basePath stays undefined
        // and the per-cycle resetWorkspaceData() call below is skipped.
    } else if (RUN_CONFIG === 'surreal-only') {
        ({ SurrealGraph } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/surrealGraph.ts')));
        workspaceDir = path.join(home, 'workspaces', 'memharness');
        fs.mkdirSync(workspaceDir, { recursive: true });
        basePath = workspaceDir;
    } else {
        workspaceDir = path.join(home, 'workspaces', 'memharness');
        fs.mkdirSync(workspaceDir, { recursive: true });
        basePath = workspaceDir;
    }

    const sampleFds = SAMPLE_FDS_CONFIGS.has(RUN_CONFIG);
    const samples = [];
    // Baseline BEFORE any cycle runs, so cycle deltas are visible from zero.
    samples.push({ cycle: 0, ...sampleMemory('baseline', { fds: sampleFds }), elapsedMs: 0 });

    for (let c = 1; c <= CYCLES; c++) {
        const t0 = performance.now();
        let cycleExtra = {};
        if (RUN_CONFIG === 'embedded') {
            await runEmbeddedCycle(createLore, dataDir, c, ENTRIES);
        } else if (RUN_CONFIG === 'embedded-empty') {
            await runEmbeddedEmptyCycle(createLore, dataDir, c);
        } else if (RUN_CONFIG === 'embedded-precomputed') {
            await runEmbeddedPrecomputedCycle({ createLore, computeContentHash, dim: embedDim, makeDoc }, dataDir, c, ENTRIES);
        } else if (RUN_CONFIG === 'embed-only') {
            cycleExtra = await runEmbedOnlyCycle(LocalEmbeddingProvider, embedModelId, embedDim, c, ENTRIES);
        } else if (RUN_CONFIG === 'surreal-only') {
            await runSurrealOnlyCycle(SurrealGraph, workspaceDir, c, ENTRIES);
        } else {
            await runEngineCycle(RUN_CONFIG, workspaceDir, c, ENTRIES);
        }
        const elapsedMs = performance.now() - t0;
        const sample = { cycle: c, ...sampleMemory(`after-cycle-${c}`, { fds: sampleFds }), elapsedMs, ...cycleExtra };
        if (RUN_CONFIG === 'worker') {
            // Give Node's SIGCHLD handling one event-loop pass to reap the
            // just-killed child before sampling — otherwise its normal,
            // transient zombie window (see sampleWorkerChildren's docstring)
            // shows up as noise in `count` on every single cycle.
            await new Promise((r) => setTimeout(r, 100));
            const wc = sampleWorkerChildren();
            sample.workerChildCount = wc.count;
            sample.workerChildZombieCount = wc.zombieCount;
            sample.workerChildRssMb = wc.rssMb;
        }
        samples.push(sample);
        // Fresh, EMPTY data dir for the next cycle — same workspace NAME/PATH
        // (basePath itself is untouched), only its `.lore/` contents reset.
        // Done AFTER sampling so this reset's own I/O never pollutes the
        // sample or the cycle-time measurement above. embed-only has no
        // on-disk store at all (basePath is undefined) — nothing to reset.
        if (basePath) resetWorkspaceData(basePath);
        process.stdout.write(
            `  cycle ${String(c).padStart(3)}/${CYCLES}  `
            + `rss=${sample.rssMb.toFixed(1).padStart(8)} MB  `
            + `heapUsed=${sample.heapUsedMb.toFixed(1).padStart(7)} MB  `
            + `vmmap=${sample.vmmapFootprintMb == null ? '  n/a' : sample.vmmapFootprintMb.toFixed(1).padStart(8) + ' MB'}  `
            + (RUN_CONFIG === 'worker'
                ? `children=${String(sample.workerChildCount).padStart(2)} zombies=${String(sample.workerChildZombieCount).padStart(2)} childRss=${sample.workerChildRssMb == null ? '  n/a' : sample.workerChildRssMb.toFixed(1).padStart(7) + ' MB'}  `
                : '')
            + (sampleFds ? `fds=${String(sample.fdCount).padStart(4)} lance=${String(sample.lanceFiles).padStart(2)} sqlite=${String(sample.sqliteFiles).padStart(2)} surreal=${String(sample.surrealFiles).padStart(2)}  ` : '')
            + (RUN_CONFIG === 'embed-only' ? `initMs=${sample.initMs.toFixed(1).padStart(8)}  ` : '')
            + `(${elapsedMs.toFixed(0)} ms)\n`,
        );
    }

    // ── Regression ───────────────────────────────────────────────────────
    // Skip warm-up: cycles 1-4 carry one-time costs that a steady-state
    // leak slope should not be blamed for — first-ever table/index creation
    // (FTS + IVF_FLAT builds, see the inproc log this harness's confound fix
    // was diagnosed from), first embedding-model load, first native mmap of
    // each LanceDB/SurrealDB file. The regression window is cycles 5..N; a
    // run shorter than 5 cycles falls back to cycle 1..N with a note (there
    // is no warm-up left to skip).
    const regressionStart = CYCLES >= 5 ? 5 : 1;
    if (CYCLES < 5) {
        console.log(`\n(cycles < 5 — regression uses the full run; cycles 1..4 are normally warm-up and excluded)`);
    }
    const regressionSamples = samples.filter((s) => s.cycle >= regressionStart);
    const rssSeries = regressionSamples.map((s) => s.rssMb);
    const heapSeries = regressionSamples.map((s) => s.heapUsedMb);
    const rssReg = linregSlope(rssSeries);
    const heapReg = linregSlope(heapSeries);

    // Full-range first/last/delta (cycle 1 vs cycle N) — a companion sanity
    // number, separate from the (warm-up-excluded) regression slope above.
    const first = samples[1];
    const last = samples[samples.length - 1];
    const regFirst = regressionSamples[0];
    const regLast = regressionSamples[regressionSamples.length - 1];

    console.log('');
    console.log(`Full range (cycle 1 -> ${CYCLES}):`);
    console.log(`  RSS:       first=${first.rssMb.toFixed(1)} MB  last=${last.rssMb.toFixed(1)} MB  delta=${(last.rssMb - first.rssMb).toFixed(1)} MB`);
    console.log(`  heapUsed:  first=${first.heapUsedMb.toFixed(1)} MB  last=${last.heapUsedMb.toFixed(1)} MB  delta=${(last.heapUsedMb - first.heapUsedMb).toFixed(1)} MB`);
    console.log(`Regression window (cycle ${regressionStart} -> ${CYCLES}, warm-up excluded):`);
    console.log(`  RSS:       first=${regFirst.rssMb.toFixed(1)} MB  last=${regLast.rssMb.toFixed(1)} MB  `
        + `delta=${(regLast.rssMb - regFirst.rssMb).toFixed(1)} MB  slope=${rssReg.slope.toFixed(3)} MB/cycle  R^2=${rssReg.r2.toFixed(3)}`);
    console.log(`  heapUsed:  first=${regFirst.heapUsedMb.toFixed(1)} MB  last=${regLast.heapUsedMb.toFixed(1)} MB  `
        + `delta=${(regLast.heapUsedMb - regFirst.heapUsedMb).toFixed(1)} MB  slope=${heapReg.slope.toFixed(3)} MB/cycle  R^2=${heapReg.r2.toFixed(3)}`);
    if (last.vmmapFootprintMb != null && first.vmmapFootprintMb != null) {
        console.log(`  vmmap:     first=${regFirst.vmmapFootprintMb.toFixed(1)} MB  last=${regLast.vmmapFootprintMb.toFixed(1)} MB  `
            + `delta=${(regLast.vmmapFootprintMb - regFirst.vmmapFootprintMb).toFixed(1)} MB`);
    } else {
        console.log('  vmmap:     not available (vmmap missing, needs elevated privilege, or non-darwin)');
    }
    if (RUN_CONFIG === 'worker') {
        const liveAtEnd = last.workerChildCount;
        console.log(`Worker children alive after final close(): ${liveAtEnd == null ? 'n/a (ps unavailable)' : liveAtEnd}`
            + (liveAtEnd ? '  <-- EXPECTED 0; a leaked/orphaned worker child' : ''));
    }

    const result = {
        tool: 'measure-memory.mjs',
        config: CONFIG,
        cycles: CYCLES,
        entriesPerCycle: ENTRIES,
        node: process.versions.node,
        platform: `${process.platform}/${process.arch}`,
        loreVersion: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version,
        timestamp: new Date().toISOString(),
        home,
        samples,
        regressionWindow: { startCycle: regressionStart, endCycle: CYCLES, warmupExcluded: regressionStart > 1 },
        regression: {
            rss: rssReg,
            heapUsed: heapReg,
        },
        fullRange: {
            first,
            last,
            deltaMb: {
                rss: last.rssMb - first.rssMb,
                heapUsed: last.heapUsedMb - first.heapUsedMb,
                vmmapFootprint: last.vmmapFootprintMb != null && first.vmmapFootprintMb != null
                    ? last.vmmapFootprintMb - first.vmmapFootprintMb
                    : null,
            },
        },
        // Kept for back-compat with earlier partial-run JSON consumers:
        // mirrors fullRange's first/last/deltaMb at the top level.
        first,
        last,
        deltaMb: {
            rss: last.rssMb - first.rssMb,
            heapUsed: last.heapUsedMb - first.heapUsedMb,
            vmmapFootprint: last.vmmapFootprintMb != null && first.vmmapFootprintMb != null
                ? last.vmmapFootprintMb - first.vmmapFootprintMb
                : null,
        },
    };

    if (JSON_OUT) {
        fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
        console.log(`\nJSON written to ${JSON_OUT}`);
    }

    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
}

await main();
