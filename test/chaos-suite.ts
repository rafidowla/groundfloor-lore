#!/usr/bin/env tsx
/**
 * test/chaos-suite.ts — runs every chaos scenario in sequence.
 *
 * Chaos tests live in `test/chaos/*.ts` and target specific cross-
 * substrate failure modes (outbox crash recovery, sweeper drift
 * healing, backup→restore round-trip, migration partial-failure,
 * orchestration interrupted between phases).
 *
 * Each scenario is its own runnable file (so they can be debugged
 * individually); this suite invokes them via tsx subprocess so a
 * single command runs the whole set. Exit non-zero on any scenario
 * failure so CI can gate on it.
 *
 * Run via: npx tsx test/chaos-suite.ts
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const CHAOS_DIR = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), 'chaos');

async function runScenario(file: string): Promise<{ ok: boolean; tail: string }> {
    return new Promise((resolve) => {
        const proc = spawn('npx', ['tsx', file], { stdio: ['ignore', 'pipe', 'pipe'] });
        const out: string[] = [];
        proc.stdout.on('data', (d) => out.push(String(d)));
        proc.stderr.on('data', (d) => out.push(String(d)));
        proc.on('exit', (code) => {
            const tail = out.join('').split('\n').slice(-5).join('\n');
            resolve({ ok: code === 0, tail });
        });
    });
}

async function main() {
    const scenarios = fs.readdirSync(CHAOS_DIR)
        .filter(f => f.endsWith('.ts'))
        .sort();

    console.log(`chaos suite — ${scenarios.length} scenario(s)`);
    let passed = 0;
    let failed = 0;
    for (const file of scenarios) {
        const fullPath = path.join(CHAOS_DIR, file);
        const result = await runScenario(fullPath);
        if (result.ok) {
            console.log(`  ✓ ${file}`);
            passed++;
        } else {
            console.log(`  ✗ ${file}`);
            console.log(result.tail.split('\n').map(l => `    ${l}`).join('\n'));
            failed++;
        }
    }
    console.log(`\n${passed}/${scenarios.length} scenarios passed${failed > 0 ? `, ${failed} failed` : ''}`);
    process.exit(failed === 0 ? 0 : 1);
}

await main();
