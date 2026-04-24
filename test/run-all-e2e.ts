#!/usr/bin/env tsx
/**
 * run-all-e2e.ts — Run every e2e suite back-to-back and exit non-zero
 * if any of them fail.
 *
 * Each suite is a separate `tsx` process so suite failures / crashes
 * don't cross-contaminate. Output is streamed live and the exit code
 * propagates.
 *
 * Usage: npm run test:e2e:all
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Suite {
    name: string;
    script: string;
}

const suites: Suite[] = [
    { name: 'Phase 7a (operational hygiene)', script: 'e2e-phase-7a.ts' },
    { name: 'V2.2 multilingual',              script: 'e2e-language.ts' },
    { name: 'Q1.9 overview aggregation',      script: 'e2e-q1-9-overview.ts' },
];

function runOne(suite: Suite): Promise<number> {
    return new Promise((resolve) => {
        console.log('');
        console.log('═'.repeat(72));
        console.log(`  ▸ Running: ${suite.name}`);
        console.log(`  ▸ Script:  test/${suite.script}`);
        console.log('═'.repeat(72));
        const proc = spawn('npx', ['tsx', path.join(__dirname, suite.script)], {
            stdio: 'inherit',
            cwd: path.join(__dirname, '..'),
        });
        proc.on('exit', (code) => resolve(code ?? 1));
    });
}

async function main(): Promise<void> {
    const results: Array<{ suite: Suite; exit: number }> = [];

    for (const suite of suites) {
        const exit = await runOne(suite);
        results.push({ suite, exit });
    }

    console.log('');
    console.log('═'.repeat(72));
    console.log('  OVERALL E2E SUMMARY');
    console.log('═'.repeat(72));
    let anyFail = false;
    for (const r of results) {
        const status = r.exit === 0 ? '\x1b[32m✓ PASS\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m';
        console.log(`  ${status}  ${r.suite.name}`);
        if (r.exit !== 0) anyFail = true;
    }
    console.log('═'.repeat(72));
    process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
    console.error('Runner crashed:', err);
    process.exit(1);
});
