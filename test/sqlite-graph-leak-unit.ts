#!/usr/bin/env tsx
/**
 * sqlite-graph-leak-unit.ts — 3.21 step 1b leak gate.
 *
 * 20-cycle SqliteGraph open → write 100 nodes → close, fresh directory per
 * cycle, run in a CHILD PROCESS started with `--expose-gc` (see
 * `test/helpers/sqlite-graph-leak-child.ts` for the actual loop — it has to
 * run out-of-process because `--expose-gc` is a process-launch flag, not
 * something this process can retroactively grant itself).
 *
 * Two independent assertions:
 *   - memory: linear-regression slope of RSS-after-forced-gc across the 20
 *     cycles is < 5 MB/cycle (a real leak grows without bound; GC noise
 *     does not have a consistent slope);
 *   - file descriptors: a real `lsof -p <pid>` after EVERY close() finds
 *     zero descriptors referencing `graph.sqlite` — better-sqlite3's
 *     `close()` is documented as synchronous and complete, so this proves
 *     that rather than assuming it.
 *
 * Run: npx tsx test/sqlite-graph-leak-unit.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL ${name}`);
        console.error('       ' + ((err as Error).message ?? String(err)));
    }
}

interface CycleSample { cycle: number; rssBytes: number; openFdCount: number }

/** Least-squares slope of y over x (x = cycle index, y = RSS bytes). */
function linearRegressionSlope(samples: CycleSample[]): number {
    const n = samples.length;
    const xs = samples.map((s) => s.cycle);
    const ys = samples.map((s) => s.rssBytes);
    const xMean = xs.reduce((a, b) => a + b, 0) / n;
    const yMean = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        num += (xs[i]! - xMean) * (ys[i]! - yMean);
        den += (xs[i]! - xMean) ** 2;
    }
    return den === 0 ? 0 : num / den;
}

async function main(): Promise<void> {
    console.log('SQLITE-GRAPH-LEAK — 20-cycle open/write-100/close, child process, --expose-gc');
    console.log('='.repeat(72));

    const here = path.dirname(fileURLToPath(import.meta.url));
    const childPath = path.join(here, 'helpers', 'sqlite-graph-leak-child.ts');
    const tsxBin = path.join(here, '..', 'node_modules', '.bin', 'tsx');

    const result = spawnSync(tsxBin, ['--expose-gc', childPath], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    });

    if (result.error) {
        console.error('FAIL: could not spawn child:', result.error);
        process.exit(1);
    }
    if (result.stderr) console.error(result.stderr);

    const samples: CycleSample[] = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CycleSample);

    await check('child process ran all 20 cycles', () => {
        assert.equal(samples.length, 20, `got ${samples.length} cycle sample(s); exit code ${result.status}`);
    });

    if (samples.length > 0) {
        const slopeBytesPerCycle = linearRegressionSlope(samples);
        const slopeMbPerCycle = slopeBytesPerCycle / (1024 * 1024);
        console.log(`  RSS samples (MB): ${samples.map((s) => (s.rssBytes / 1024 / 1024).toFixed(1)).join(', ')}`);
        console.log(`  slope = ${slopeMbPerCycle.toFixed(4)} MB/cycle`);

        await check('memory slope < 5 MB/cycle over 20 cycles', () => {
            assert.ok(slopeMbPerCycle < 5, `slope was ${slopeMbPerCycle.toFixed(4)} MB/cycle`);
        });

        const nonZeroFd = samples.filter((s) => s.openFdCount !== 0);
        await check('graph.sqlite file descriptors are 0 after every close()', () => {
            assert.equal(
                nonZeroFd.length, 0,
                `cycle(s) with a leaked fd: ${nonZeroFd.map((s) => `#${s.cycle}=${s.openFdCount}`).join(', ')}`,
            );
        });
    }

    console.log('');
    console.log(`leak: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch((err) => {
    console.error('FAIL:', err);
    process.exit(1);
});
