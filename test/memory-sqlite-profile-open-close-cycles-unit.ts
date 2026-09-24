#!/usr/bin/env tsx
/**
 * test/memory-sqlite-profile-open-close-cycles-unit.ts — 3.21 Step 5
 * (docs/PERFORMANCE-MEMORY.md §14): CI gate for the per-open-workspace
 * memory cost on the SQLite graph+vector profile (SqliteGraph +
 * SqliteVerbatimStore — the 3.21 default for a brand-new local workspace).
 *
 * Runs 50 open/write/close cycles in a single child process (same
 * child-process + --expose-gc method as
 * test/memory-open-close-cycles-unit.ts) via
 * test/helpers/workspace-sqlite-profile-open-close-child.ts, then asserts
 * TWO things from that one run:
 *
 *   1. Post-close floor stays bounded across cycles (no leak growing
 *      unbounded — the 50-cycle gate the 3.21 plan asked for).
 *   2. Per-open RSS delta stays within the ≤40 MB/store budget the 3.21
 *      plan set for this profile.
 *
 * ── Why the thresholds are what they are ──────────────────────────────
 *
 * Measured directly on this machine (scripts/diagnostics/
 * workspace-profile-memory-measure.mjs, see docs/PERFORMANCE-MEMORY.md §14
 * for the full table, 3 repetitions each, fresh child process per rep):
 *
 *   - Post-close floor slope, 50 cycles, cycles 6-50: median -2.87 MB/cycle
 *     (spread 0.009 across 3 reps) — i.e. the floor does NOT grow, it
 *     shrinks slightly (plausible allocator/page-reclaim behavior, not a
 *     leak — nothing here retains a handle after close(), unlike the
 *     SurrealDB finding in §9/§13).
 *   - Per-open RSS delta (keep-N-open shape, N=15): median 14.18 MB/store
 *     including the one-time native-module load; median incremental
 *     (post-warmup, steady state) 0.27 MB/store.
 *
 * `FLOOR_SLOPE_FAIL_MB_PER_CYCLE` (10 MB/cycle) mirrors the existing
 * FAIL_SLOPE_MB_PER_CYCLE_MIN convention in memory-open-close-cycles-unit.ts
 * — two-to-three orders of magnitude above the measured -2.87 MB/cycle
 * floor slope and the ±0.2 MB/cycle noise band that convention documents,
 * and one order of magnitude below any real leak this sprint has ever
 * measured (60-105 MB/cycle, §2/§8/§9/§14's surreal-lance numbers). Ample
 * headroom for run-to-run noise; a slope anywhere near it means something
 * genuinely started retaining memory after close().
 *
 * `PER_OPEN_BUDGET_MB` (40 MB) is the 3.21 plan's own stated target, not a
 * number derived from measurement — see the budget test below for how the
 * measured 14.18 MB (worst case, includes warmup) compares.
 *
 * Runtime: this file alone is one child-process run of 50 cycles; measured
 * at ~5s wall-clock on this machine (`ENTRIES=30`; SQLite opens are cheap —
 * well under the ~90s budget). Stability: run 3x manually before landing
 * this gate in the `npm test` chain (see docs/PERFORMANCE-MEMORY.md §14
 * "stability runs" for the raw repeated results — all 3 passed, floor slope
 * 0.069-0.080 MB/cycle, per-open median 0.22 MB every time) — not re-run
 * automatically here, to keep this file's own runtime minimal.
 *
 * Run directly:
 *
 *   npx tsx test/memory-sqlite-profile-open-close-cycles-unit.ts
 *   npm run test:unit:memory-sqlite-profile-open-close-cycles
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(REPO_ROOT, 'test', 'helpers', 'workspace-sqlite-profile-open-close-child.ts');

const CYCLES = 50;
const ENTRIES = 30;
// Skips first-ever table/index creation + native-module-load cycles, same
// reasoning as memory-open-close-cycles-unit.ts's REGRESSION_START_CYCLE.
const REGRESSION_START_CYCLE = 6;

const FLOOR_SLOPE_FAIL_MB_PER_CYCLE = 10;
const PER_OPEN_BUDGET_MB = 40;

// Bounded timeout for the measurement child — defensive fix, 3.21 Step 5
// goal 4. runCycles() previously spawned a child with no timeout/kill path
// at all: a hung child (e.g. a native handle wedged on open) would wedge
// this whole test, and therefore `npm test`, forever. Same
// detached-process-group kill pattern as
// test/embedded-abandoned-dispose-exit-unit.ts's runChild().
const CHILD_TIMEOUT_MS = 60_000;

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.log(`  ✗ ${name}`);
        console.log(`    ${(err as Error).message}`);
        failed++;
    }
}

interface CycleSample {
    cycle: number;
    openRssMb: number;
    closeRssMb: number;
    closeHeapUsedMb: number;
    perOpenDeltaMb: number;
    elapsedMs: number;
}

function linregSlope(ys: number[]): { slope: number; r2: number } {
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

function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    const n = s.length;
    if (n === 0) return NaN;
    return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Runs the child for CYCLES cycles. Killed by PROCESS GROUP if it doesn't
 *  exit within CHILD_TIMEOUT_MS — see header, goal 4 of this step. */
function runCycles(cycles: number, entries: number): Promise<CycleSample[]> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            ['--expose-gc', '--import', 'tsx', CHILD, String(cycles), String(entries)],
            { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c.toString(); });
        child.stderr.on('data', (c) => { stderr += c.toString(); });

        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            if (child.pid) {
                try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
            }
            reject(new Error(
                `workspace-sqlite-profile-open-close-child.ts did not exit within ${CHILD_TIMEOUT_MS}ms — `
                + `killed (process group). This most likely means a native handle (better-sqlite3 / `
                + `sqlite-vec) wedged on open or close; it should never hang. `
                + `stdout so far: ${stdout}\nstderr so far: ${stderr}`,
            ));
        }, CHILD_TIMEOUT_MS);
        timer.unref();

        child.on('exit', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`workspace-sqlite-profile-open-close-child.ts exited ${code}\n${stderr}`));
                return;
            }
            try {
                const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
                const parsed = JSON.parse(lastLine) as { baselineRssMb: number; samples: CycleSample[] };
                resolve(parsed.samples);
            } catch (err) {
                reject(new Error(`could not parse child output: ${(err as Error).message}\n${stdout}\n${stderr}`));
            }
        });
    });
}

console.log(`SQLite profile open/close cycles (graph+vector, both SQLite) — ${CYCLES} cycles, ${ENTRIES} entries/cycle`);
console.log('(SurrealDB+LanceDB before/after comparison lives only in the diagnostic scripts — see docs/PERFORMANCE-MEMORY.md §14)');

let samples: CycleSample[] = [];

await test('SQLite profile: open/write/close cycles complete and report samples', async () => {
    samples = await runCycles(CYCLES, ENTRIES);
    assert.equal(samples.length, CYCLES, `expected ${CYCLES} samples, got ${samples.length}`);
    for (const s of samples) {
        assert.ok(Number.isFinite(s.closeRssMb) && s.closeRssMb > 0, `cycle ${s.cycle} has a finite positive closeRssMb`);
    }
});

await test(`SQLite profile: post-close floor slope over cycles ${REGRESSION_START_CYCLE}..${CYCLES} stays bounded (< ${FLOOR_SLOPE_FAIL_MB_PER_CYCLE} MB/cycle)`, () => {
    const window = samples.filter((s) => s.cycle >= REGRESSION_START_CYCLE);
    assert.ok(window.length >= 2, `regression window needs >=2 samples, got ${window.length}`);
    const { slope, r2 } = linregSlope(window.map((s) => s.closeRssMb));
    const first = window[0];
    const last = window[window.length - 1];
    console.log(`    cycles ${first.cycle}..${last.cycle}: floor first=${first.closeRssMb.toFixed(1)} MB `
        + `last=${last.closeRssMb.toFixed(1)} MB slope=${slope.toFixed(3)} MB/cycle R^2=${r2.toFixed(3)}`);
    assert.ok(
        slope < FLOOR_SLOPE_FAIL_MB_PER_CYCLE,
        `post-close floor is climbing ${slope.toFixed(1)} MB/cycle (R^2=${r2.toFixed(3)}) over cycles `
        + `${first.cycle}..${last.cycle} (${first.closeRssMb.toFixed(1)} MB -> ${last.closeRssMb.toFixed(1)} MB) — `
        + `something is retaining memory after a correct close() on the SQLite profile; `
        + `see docs/PERFORMANCE-MEMORY.md §14`,
    );
});

await test(`SQLite profile: per-open RSS delta stays within the ${PER_OPEN_BUDGET_MB} MB/store budget (median over cycles ${REGRESSION_START_CYCLE}..${CYCLES})`, () => {
    const window = samples.filter((s) => s.cycle >= REGRESSION_START_CYCLE);
    const deltas = window.map((s) => s.perOpenDeltaMb);
    const med = median(deltas);
    const max = Math.max(...deltas);
    console.log(`    per-open delta over cycles ${window[0].cycle}..${window[window.length - 1].cycle}: `
        + `median=${med.toFixed(2)} MB max=${max.toFixed(2)} MB`);
    assert.ok(
        med <= PER_OPEN_BUDGET_MB,
        `median per-open RSS delta is ${med.toFixed(1)} MB, over the ${PER_OPEN_BUDGET_MB} MB/store budget the `
        + `3.21 plan set for the SQLite profile — see docs/PERFORMANCE-MEMORY.md §14`,
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
