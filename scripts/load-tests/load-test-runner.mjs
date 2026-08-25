#!/usr/bin/env node
/**
 * scripts/load-tests/load-test-runner.mjs — Sprint C4 harness driver.
 *
 * NOT operator-facing. Dev-team tool to characterize Lore daemon
 * limits before saying SLA things to enterprise customers.
 *
 * Usage:
 *   BEARER=<token> node scripts/load-tests/load-test-runner.mjs <scenario> [--N=N] [--duration=secs] [--concurrency=k]
 *
 * Scenarios live in scripts/load-tests/scenarios/ and export a default
 * async function `(runOpts) => { ... }`. Each scenario is responsible
 * for emitting per-request latency observations via the supplied
 * recorder.
 *
 * Output:
 *   { scenario, durationMs, requests, errors, errorRate, throughputRps,
 *     latency: { p50, p95, p99, mean, min, max } }
 *
 * Intentionally tiny: async loops + perf marks. No heavy deps. Single
 * file under 200 LOC.
 */

import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(
        'Usage: BEARER=<token> node scripts/load-tests/load-test-runner.mjs <scenario> [options]\n' +
        '\n' +
        'Scenarios: bulk-write hot-write streaming-ingest recall-mixed\n' +
        '\n' +
        'Options:\n' +
        '  --N=<n>             requests/iterations per worker (default 100)\n' +
        '  --duration=<secs>   target wall-clock (default ignored if --N set)\n' +
        '  --concurrency=<k>   parallel workers (default 1)\n' +
        '  --base=<url>        daemon URL (default http://127.0.0.1:3847)\n' +
        '  --workspace=<name>  workspace to write to (default load-test-<ts>)\n',
    );
    process.exit(args.length === 0 ? 1 : 0);
}

const scenarioName = args[0];
const opts = parseOpts(args.slice(1));
opts.base = opts.base ?? process.env.BASE ?? 'http://127.0.0.1:3847';
opts.bearer = process.env.BEARER;
opts.workspace = opts.workspace ?? `load-test-${Date.now()}`;
opts.N = Number(opts.N ?? 100);
opts.concurrency = Number(opts.concurrency ?? 1);
opts.duration = opts.duration ? Number(opts.duration) : null;

if (!opts.bearer) {
    console.error('BEARER env required');
    process.exit(2);
}

const scenarioPath = path.join(__dirname, 'scenarios', `${scenarioName}.mjs`);
let scenario;
try {
    scenario = (await import(pathToFileURL(scenarioPath).href)).default;
} catch (err) {
    console.error(`Failed to load scenario '${scenarioName}': ${err.message}`);
    process.exit(2);
}
if (typeof scenario !== 'function') {
    console.error(`Scenario module ${scenarioPath} must export a default function.`);
    process.exit(2);
}

const observations = [];
let errors = 0;
const recorder = {
    observe(latencyMs) { observations.push(latencyMs); },
    error(err) { errors++; if (process.env.VERBOSE) console.error(`  err: ${err?.message ?? err}`); },
};

console.log(`scenario=${scenarioName} workspace=${opts.workspace} N=${opts.N} concurrency=${opts.concurrency} base=${opts.base}`);

const startedAt = performance.now();
const workers = Array.from({ length: opts.concurrency }, () => scenario({ ...opts, recorder }));
await Promise.all(workers);
const durationMs = performance.now() - startedAt;

const stats = summarize(observations, errors, durationMs, scenarioName);
console.log(JSON.stringify(stats, null, 2));

function parseOpts(arr) {
    const out = {};
    for (const a of arr) {
        const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
        if (m) out[m[1]] = m[2] ?? true;
    }
    return out;
}

function summarize(samples, errs, durMs, name) {
    const sorted = [...samples].sort((a, b) => a - b);
    const p = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0;
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
        scenario: name,
        durationMs: Math.round(durMs),
        requests: n,
        errors: errs,
        errorRate: (n + errs) > 0 ? errs / (n + errs) : 0,
        throughputRps: durMs > 0 ? Math.round((n * 1000 / durMs) * 100) / 100 : 0,
        latency: {
            p50: round(p(0.5)),
            p95: round(p(0.95)),
            p99: round(p(0.99)),
            mean: round(n > 0 ? sum / n : 0),
            min: round(sorted[0] ?? 0),
            max: round(sorted[n - 1] ?? 0),
        },
    };
}

function round(x) { return Math.round(x * 100) / 100; }
