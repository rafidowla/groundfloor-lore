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
    { name: 'Q1 intersections (1.3×1.4×1.7×1.9)', script: 'e2e-q1-intersections.ts' },
    { name: 'Q2.1 server mode (deploy toggle)', script: 'e2e-q2-1-server-mode.ts' },
    { name: 'Q2.2 cloud roundtrip (DataplaneGraph)', script: 'e2e-q2-2-cloud-roundtrip.ts' },
    { name: 'MVP live daemon (local: store·recall·search·get-full·bulk·isolation)', script: 'mvp-live-e2e.ts' },
    { name: 'Load-job cancel over live --http daemon', script: 'load-job-cancel-live-e2e.ts' },
    { name: 'Wave 4 multi-app isolation (adversarial cross-workspace matrix)', script: 'wave4-multi-app-isolation-e2e.ts' },
    { name: 'MVP crash recovery (SIGKILL → restart → zero loss)', script: 'mvp-crash-recovery-e2e.ts' },
    { name: 'MVP getting-started (cold install → connect over MCP → store+recall)', script: 'mvp-getting-started-e2e.ts' },
    { name: 'REST vs MCP autolink parity (identical payload, both surfaces link)', script: 'rest-mcp-autolink-parity-e2e.ts' },
    { name: 'MVP search burst (concurrent searches during FTS build must not crash)', script: 'mvp-search-burst-e2e.ts' },
    { name: 'MVP tarball install (npm pack -> npm install -> compiled dist/ smoke test)', script: 'mvp-tarball-install-e2e.ts' },
    { name: 'Search worker isolation (child-process crash containment + self-heal)', script: 'verbatim-search-worker-e2e.ts' },
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
