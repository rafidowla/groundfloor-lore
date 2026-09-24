#!/usr/bin/env tsx
/**
 * test/memory-open-close-cycles-unit.ts — memory-leak sprint regression
 * guard, split 2026-09-18 (docs/PERFORMANCE-MEMORY.md "§13 — splitting the
 * memory regression test").
 *
 * Pre-split history: this file ran the full `embedded` createLore()/
 * dispose() cycle and was EXPECTED TO FAIL on 3.19.1 / PASS on 3.20.0, and
 * was deliberately NOT in the main `npm test` chain because of that
 * (§5 of the doc, superseded by §13). By 3.20.0's tip (this branch's base,
 * `pr/3.20.0-19-migrations-close-test`), every close-path fix Lore
 * controls had landed EXCEPT one that Lore cannot fix: `embedded` also
 * opens SurrealDB, and `@surrealdb/node` 3.0.3 never frees a datastore on
 * close() (§9) — so the OLD single embedded-cycle test still failed, at
 * ~100 MB/cycle, for a reason entirely outside this test's own scope.
 *
 * Split into two tests so each asserts only what it can actually verify:
 *
 *   - THIS file — what Lore controls. Two independent cycle shapes, run in
 *     separate child processes (same child-process + --expose-gc method as
 *     before), asserting a FLAT RSS slope for each:
 *       1. bare `VerbatimStore` open -> write -> close (LanceDB only, fresh
 *          temp dir every cycle, `FakeEmbeddingProvider` — no ONNX).
 *       2. `WorkspaceVerbatimResolver.getOrOpen()` -> write -> its own
 *          `evictIdle(now, 0)` (fresh workspace/dir every cycle).
 *     Both reuse `scripts/measure-memory.mjs` / `measure-memory-configs.mjs`
 *     cycle-body shapes (the `inproc` config and `runWorkspaceCycle`'s
 *     vector-store half respectively) — see the child helper's own header
 *     for exactly how. Registered in the main `npm test` chain: it must
 *     (and does) pass today.
 *   - test/memory-surreal-leak-pinned-unit.ts — a PINNED CANARY for the
 *     SurrealDB leak itself (§9), asserting the leak is still present. See
 *     that file's header for why it exists and how to react when it starts
 *     failing (that will mean the leak is fixed upstream).
 *
 * Run directly:
 *
 *   npx tsx test/memory-open-close-cycles-unit.ts
 *   npm run test:unit:memory-open-close-cycles
 *
 * ── Cycle count / runtime ────────────────────────────────────────────────
 *
 * Both shapes here are LanceDB-only (no SurrealDB, no real ONNX) — cheap
 * compared to the old `embedded` cycle, so both run more cycles than that
 * one did (12) while still finishing in well under a minute combined on
 * this machine. CYCLES=20 per shape, ENTRIES=100 entries/cycle.
 *
 * ── Threshold ────────────────────────────────────────────────────────────
 *
 * FAIL_SLOPE_MB_PER_CYCLE_MIN (10 MB/cycle) is unchanged from the pre-split
 * test — still two-to-three orders of magnitude below any leak this sprint
 * has ever measured (60-105 MB/cycle) and well above the flat/negative
 * slopes measured on the leak-free `inproc`/`worker` harnesses (-0.2 to
 * +0.2 MB/cycle) — see docs/PERFORMANCE-MEMORY.md for the raw numbers.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(REPO_ROOT, 'test', 'helpers', 'memory-open-close-cycles-child.ts');

const CYCLES = 20;
const ENTRIES = 100;
// Regression window skips cycles 1-4 (first-ever table/index creation,
// first native mmaps — see scripts/measure-memory.mjs's own "skip warm-up"
// comment for the same reasoning applied there), matching the shipped
// harness's convention.
const REGRESSION_START_CYCLE = 5;

const FAIL_SLOPE_MB_PER_CYCLE_MIN = 10;

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

interface CycleSample { cycle: number; rssMb: number; heapUsedMb: number; elapsedMs: number }

/** Ordinary least squares slope of y over x=0..n-1 (MB per cycle). Same
 *  formula as scripts/measure-memory.mjs's linregSlope — kept as an
 *  independent copy so this test doesn't depend on that script's internals. */
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

// Bounded timeout for the measurement child. Defensive fix, 3.21 Step 5
// goal 4 — this previously spawned a child with NO timeout/kill path at
// all: a hung child (e.g. a native handle wedged on open/close) would wedge
// this test, and therefore `npm test`, forever. Same detached-process-group
// kill pattern as test/embedded-abandoned-dispose-exit-unit.ts's runChild()
// (`detached: true` + `process.kill(-child.pid, 'SIGKILL')`, which kills
// the whole group tsx's own child processes included, not just the
// wrapper).
const CHILD_TIMEOUT_MS = 60_000;

/** Runs the child for CYCLES cycles of `mode` (fresh dir every cycle) and
 *  returns its per-cycle RSS samples. Killed by PROCESS GROUP if it does
 *  not exit within CHILD_TIMEOUT_MS. */
function runCycles(mode: 'verbatim' | 'resolver', cycles: number, entries: number): Promise<CycleSample[]> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            ['--expose-gc', '--import', 'tsx', CHILD, mode, String(cycles), String(entries)],
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
                `memory-open-close-cycles-child.ts (${mode}) did not exit within ${CHILD_TIMEOUT_MS}ms — `
                + `killed (process group). It should never hang; this means a native handle wedged on `
                + `open or close. stdout so far: ${stdout}\nstderr so far: ${stderr}`,
            ));
        }, CHILD_TIMEOUT_MS);
        timer.unref();

        child.on('exit', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`memory-open-close-cycles-child.ts (${mode}) exited ${code}\n${stderr}`));
                return;
            }
            try {
                const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
                const parsed = JSON.parse(lastLine) as { samples: CycleSample[] };
                resolve(parsed.samples);
            } catch (err) {
                reject(new Error(`could not parse child output (${mode}): ${(err as Error).message}\n${stdout}\n${stderr}`));
            }
        });
    });
}

async function runShape(label: string, mode: 'verbatim' | 'resolver'): Promise<void> {
    let samples: CycleSample[] = [];

    await test(`${label}: open/write/close cycles complete and report samples`, async () => {
        samples = await runCycles(mode, CYCLES, ENTRIES);
        assert.equal(samples.length, CYCLES, `expected ${CYCLES} samples, got ${samples.length}`);
        for (const s of samples) {
            assert.ok(Number.isFinite(s.rssMb) && s.rssMb > 0, `cycle ${s.cycle} has a finite positive rssMb`);
        }
    });

    await test(`${label}: RSS slope over cycles ${REGRESSION_START_CYCLE}..${CYCLES} is flat within noise (< ${FAIL_SLOPE_MB_PER_CYCLE_MIN} MB/cycle)`, () => {
        const window = samples.filter((s) => s.cycle >= REGRESSION_START_CYCLE);
        assert.ok(window.length >= 2, `regression window needs >=2 samples, got ${window.length}`);
        const { slope, r2 } = linregSlope(window.map((s) => s.rssMb));
        const first = window[0];
        const last = window[window.length - 1];
        console.log(`    cycles ${first.cycle}..${last.cycle}: first=${first.rssMb.toFixed(1)} MB last=${last.rssMb.toFixed(1)} MB `
            + `slope=${slope.toFixed(3)} MB/cycle R^2=${r2.toFixed(3)}`);
        assert.ok(
            slope < FAIL_SLOPE_MB_PER_CYCLE_MIN,
            `${label}: RSS is climbing ${slope.toFixed(1)} MB/cycle (R^2=${r2.toFixed(3)}) over cycles `
            + `${first.cycle}..${last.cycle} (${first.rssMb.toFixed(1)} MB -> ${last.rssMb.toFixed(1)} MB) — `
            + `this is within what Lore itself controls (no SurrealDB involved); `
            + `see docs/PERFORMANCE-MEMORY.md §9/§13`,
        );
    });
}

console.log(`Memory open/close cycles — verbatim + resolver shapes, ${CYCLES} cycles, ${ENTRIES} entries/cycle each`);
console.log('(SurrealDB is out of scope here — see test/memory-surreal-leak-pinned-unit.ts for that canary)');

await runShape('VerbatimStore', 'verbatim');
await runShape('WorkspaceVerbatimResolver', 'resolver');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
