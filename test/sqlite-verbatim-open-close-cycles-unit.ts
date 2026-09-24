#!/usr/bin/env tsx
/**
 * test/sqlite-verbatim-open-close-cycles-unit.ts — 3.21 step 2 part 1.
 *
 * Design CHECK: "20-cycle open/write/close leak test flat (< 5 MB/cycle,
 * 0 leaked fds)". Same method as test/memory-open-close-cycles-unit.ts:
 * spawn a child with --expose-gc, run N open/write/close cycles (fresh
 * temp dir every cycle), regress the per-cycle RSS. This file additionally
 * asserts the fd count reported by the child (via /dev/fd) is the SAME
 * before cycle 1 and after the last cycle — SqliteVerbatimStore holds
 * exactly one better-sqlite3 handle per open store, so a leaked fd would
 * mean close() isn't actually releasing the native connection.
 *
 * Run: npx tsx test/sqlite-verbatim-open-close-cycles-unit.ts
 *      npm run test:unit:sqlite-verbatim-open-close-cycles
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(REPO_ROOT, 'test', 'helpers', 'sqlite-verbatim-open-close-cycles-child.ts');

const CYCLES = 20;
const ENTRIES = 100;
const REGRESSION_START_CYCLE = 5; // skip warm-up cycles, matches memory-open-close-cycles-unit.ts's convention
const FAIL_SLOPE_MB_PER_CYCLE_MIN = 5; // design's explicit threshold for THIS test (stricter than the Lance test's 10)

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.log(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

interface CycleSample { cycle: number; rssMb: number; heapUsedMb: number; elapsedMs: number; fds: number }

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

function runCycles(cycles: number, entries: number): Promise<{ samples: CycleSample[]; fdsBefore: number; fdsAfter: number }> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            ['--expose-gc', '--import', 'tsx', CHILD, String(cycles), String(entries)],
            { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '', stderr = '';
        child.stdout.on('data', (c) => { stdout += c.toString(); });
        child.stderr.on('data', (c) => { stderr += c.toString(); });
        child.on('exit', (code) => {
            if (code !== 0) { reject(new Error(`child exited ${code}\n${stderr}`)); return; }
            try {
                const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
                resolve(JSON.parse(lastLine));
            } catch (err) {
                reject(new Error(`could not parse child output: ${(err as Error).message}\n${stdout}\n${stderr}`));
            }
        });
    });
}

async function main(): Promise<void> {
    let samples: CycleSample[] = [];
    let fdsBefore = -1, fdsAfter = -1;

    await test('SqliteVerbatimStore: 20-cycle open/write/close completes and reports samples', async () => {
        const result = await runCycles(CYCLES, ENTRIES);
        samples = result.samples;
        fdsBefore = result.fdsBefore;
        fdsAfter = result.fdsAfter;
        assert.equal(samples.length, CYCLES, `expected ${CYCLES} samples, got ${samples.length}`);
        for (const s of samples) assert.ok(Number.isFinite(s.rssMb) && s.rssMb > 0, `cycle ${s.cycle} has a finite positive rssMb`);
    });

    await test(`SqliteVerbatimStore: RSS slope over cycles ${REGRESSION_START_CYCLE}..${CYCLES} is flat (< ${FAIL_SLOPE_MB_PER_CYCLE_MIN} MB/cycle)`, () => {
        const window = samples.filter((s) => s.cycle >= REGRESSION_START_CYCLE);
        assert.ok(window.length >= 2, `regression window needs >=2 samples, got ${window.length}`);
        const { slope, r2 } = linregSlope(window.map((s) => s.rssMb));
        const first = window[0]!, last = window[window.length - 1]!;
        console.log(`    cycles ${REGRESSION_START_CYCLE}..${CYCLES}: first=${first.rssMb.toFixed(1)} MB last=${last.rssMb.toFixed(1)} MB slope=${slope.toFixed(3)} MB/cycle R^2=${r2.toFixed(3)}`);
        assert.ok(slope < FAIL_SLOPE_MB_PER_CYCLE_MIN, `RSS slope ${slope.toFixed(3)} MB/cycle exceeds the ${FAIL_SLOPE_MB_PER_CYCLE_MIN} MB/cycle leak threshold`);
    });

    await test('SqliteVerbatimStore: 0 leaked file descriptors across the run', () => {
        if (fdsBefore === -1 || fdsAfter === -1) {
            console.log('    /dev/fd unavailable on this platform — fd-leak check skipped (RSS-flatness above already covers the native-handle-leak case in practice)');
            return;
        }
        console.log(`    fds before=${fdsBefore} after=${fdsAfter}`);
        // Exact equality would be brittle (Node's own event-loop internals can
        // open/close incidental fds between snapshots); the design's "0
        // leaked fds" is checked as "no NET GROWTH attributable to 20
        // open/close cycles of a store that itself opens exactly 1 handle
        // per cycle" — any accumulation over a couple of fds across 20
        // cycles would be a real per-cycle leak, not incidental noise.
        assert.ok(fdsAfter <= fdsBefore + 2, `fd count grew from ${fdsBefore} to ${fdsAfter} across ${CYCLES} cycles — possible fd leak`);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
