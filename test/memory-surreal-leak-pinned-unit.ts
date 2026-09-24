#!/usr/bin/env tsx
/**
 * test/memory-surreal-leak-pinned-unit.ts — PINNED CANARY for the
 * `@surrealdb/node` 3.0.3 close()-doesn't-free-a-datastore leak
 * (docs/PERFORMANCE-MEMORY.md §9), added 2026-09-18 when the memory
 * regression test was split (§13 of that doc; see
 * test/memory-open-close-cycles-unit.ts's header for the full split
 * rationale).
 *
 * This is NOT a regression guard against something Lore can fix — §9's
 * evidence (bare `SurrealGraph`, and separately the native binding driven
 * directly with no Lore/JS-SDK involved at all) rules out Lore's own close
 * path as the cause. It exists so that:
 *
 *   1. The leak stays VISIBLE in the test suite instead of silently
 *      dropped when the old combined `embedded`-cycle test (which failed
 *      for this exact reason, among others it no longer isolates) was
 *      retired.
 *   2. If `@surrealdb/node` ever ships a fix, THIS TEST FAILS — on
 *      purpose — as the trigger to revisit two things this leak currently
 *      shapes:
 *        - `LORE_REGISTRY_IDLE_TTL_MS` / graph idle unloading — §9 "What it
 *          means for hosts" ("Graph idle eviction is net-negative on this
 *          driver"), which is why `pr/3.20.0-21-graph-idle-unload-off`
 *          turned that eviction off by default.
 *        - docs/PERFORMANCE-MEMORY.md §9 itself, which would need a
 *          superseding note rather than a silent edit.
 *
 * A run of ~8 cycles is enough: §9's own evidence table shows this leak at
 * R²=1.000 within a handful of cycles, and unlike the flat-slope tests this
 * canary does not need a long regression window to be confident — it is
 * asserting the OPPOSITE (a large, obvious slope), so noise near the
 * threshold isn't a real risk in either direction.
 *
 * Run directly:
 *
 *   npx tsx test/memory-surreal-leak-pinned-unit.ts
 *   npm run test:unit:memory-surreal-leak-pinned
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(REPO_ROOT, 'test', 'helpers', 'memory-surreal-leak-pinned-child.ts');

const CYCLES = 8;
const ENTRIES = 100;
// Only 8 cycles total; skip cycle 1-2 (first-ever datastore file creation)
// rather than the wider 5-cycle warm-up the flat-slope tests use — the
// leak is already unambiguous by cycle 3 in every measurement to date
// (§9), and a wider skip would leave too few samples in an 8-cycle run.
const REGRESSION_START_CYCLE = 3;

// §9's evidence measures 64.7-100.3 MB/cycle depending on backend/config;
// 50 MB/cycle sits comfortably below the smallest of those and far above
// any plausible noise floor, so this canary fails loudly if the leak ever
// shrinks by roughly half or more — a generous margin against "the leak
// changed shape but isn't actually fixed" false negatives.
const PASS_SLOPE_MB_PER_CYCLE_MIN = 50;

const LEAK_FIXED_MESSAGE = 'the @surrealdb/node close() leak appears fixed — '
    + 're-evaluate LORE_REGISTRY_IDLE_TTL_MS default (graph idle unloading) '
    + 'and docs/PERFORMANCE-MEMORY.md §9, then invert this test';

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

function runCycles(cycles: number, entries: number): Promise<CycleSample[]> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            ['--expose-gc', '--import', 'tsx', CHILD, String(cycles), String(entries)],
            { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c.toString(); });
        child.stderr.on('data', (c) => { stderr += c.toString(); });
        child.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`memory-surreal-leak-pinned-child.ts exited ${code}\n${stderr}`));
                return;
            }
            try {
                const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
                const parsed = JSON.parse(lastLine) as { samples: CycleSample[] };
                resolve(parsed.samples);
            } catch (err) {
                reject(new Error(`could not parse child output: ${(err as Error).message}\n${stdout}\n${stderr}`));
            }
        });
    });
}

console.log(`Memory canary — bare SurrealGraph open/write/close, ${CYCLES} cycles, ${ENTRIES} entries/cycle`);
console.log('(this is EXPECTED TO FAIL loudly, on purpose — see this file header)');

let samples: CycleSample[] = [];

await test('bare SurrealGraph open/write/close cycles complete and report samples', async () => {
    samples = await runCycles(CYCLES, ENTRIES);
    assert.equal(samples.length, CYCLES, `expected ${CYCLES} samples, got ${samples.length}`);
    for (const s of samples) {
        assert.ok(Number.isFinite(s.rssMb) && s.rssMb > 0, `cycle ${s.cycle} has a finite positive rssMb`);
    }
});

await test(`RSS slope over cycles ${REGRESSION_START_CYCLE}..${CYCLES} is STILL leaking (>= ${PASS_SLOPE_MB_PER_CYCLE_MIN} MB/cycle)`, () => {
    const window = samples.filter((s) => s.cycle >= REGRESSION_START_CYCLE);
    assert.ok(window.length >= 2, `regression window needs >=2 samples, got ${window.length}`);
    const { slope, r2 } = linregSlope(window.map((s) => s.rssMb));
    const first = window[0];
    const last = window[window.length - 1];
    console.log(`    cycles ${first.cycle}..${last.cycle}: first=${first.rssMb.toFixed(1)} MB last=${last.rssMb.toFixed(1)} MB `
        + `slope=${slope.toFixed(3)} MB/cycle R^2=${r2.toFixed(3)}`);
    assert.ok(
        slope >= PASS_SLOPE_MB_PER_CYCLE_MIN,
        `RSS only climbed ${slope.toFixed(1)} MB/cycle (R^2=${r2.toFixed(3)}) over cycles `
        + `${first.cycle}..${last.cycle} (${first.rssMb.toFixed(1)} MB -> ${last.rssMb.toFixed(1)} MB), `
        + `below this canary's ${PASS_SLOPE_MB_PER_CYCLE_MIN} MB/cycle floor — ${LEAK_FIXED_MESSAGE}`,
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
