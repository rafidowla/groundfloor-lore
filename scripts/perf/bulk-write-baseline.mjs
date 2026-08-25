#!/usr/bin/env node
/**
 * scripts/perf/bulk-write-baseline.mjs — O0 W9 baseline measurement.
 *
 * Posts 1000 standard-shape decision nodes via POST /api/nodes/bulk,
 * 5 runs, drops slowest, averages. Records numbers for O-D11
 * (post-Sprint-O must be within 10% of these). One-shot — not in CI.
 *
 * Sprint 8 — by default this script now mints its own ephemeral perf
 * token via `lore auth issue --ephemeral --ttl 1h --workspace <ws>`,
 * so a perf run never rebinds (or even touches) the bootstrap token at
 * `lore-local-data/auth.token` or `~/.groundfloor/auth.token`. The
 * minted token is held in process memory only and expires naturally
 * after the run; the periodic sweeper drops it from the registry.
 *
 * Usage:
 *   # default — mints its own ephemeral token
 *   node scripts/perf/bulk-write-baseline.mjs
 *
 *   # explicit token override (still never written to disk by this script)
 *   BEARER=<token> WORKSPACE=existing-ws node scripts/perf/bulk-write-baseline.mjs
 */
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3847';
// Sprint O3c — ephemeral workspace pattern. Each invocation creates a
// fresh workspace named perf-baseline-<timestamp> so consecutive runs
// don't accumulate outbox depth from prior runs (which masked the
// real per-row perf in O3b).
const EPHEMERAL = process.env.EPHEMERAL !== '0';
const WORKSPACE = process.env.WORKSPACE ?? (EPHEMERAL
    ? `perf-baseline-${Date.now()}`
    : 'o0-perf-baseline');
const RUNS = Number(process.env.RUNS ?? '5');
const N = Number(process.env.N ?? '1000');

// Sprint 8 — mint an ephemeral perf token if the caller didn't supply
// one. The token is captured from stdout of `lore auth issue --json`
// and used only for HTTP calls in this process; nothing is written to
// the bootstrap token files. The ephemeral workspace must already exist
// — the auth issue gate validates that (matches operator UX for typos).
let BEARER = process.env.BEARER;
if (!BEARER) {
    const ttl = process.env.TTL ?? '1h';
    const res = spawnSync('lore', [
        'auth', 'issue',
        '--workspace', WORKSPACE,
        '--ephemeral',
        '--ttl', ttl,
        '--json',
    ], { encoding: 'utf8' });
    if (res.status !== 0) {
        console.error(`failed to mint ephemeral perf token (lore auth issue exit=${res.status})`);
        if (res.stderr) console.error(res.stderr);
        console.error('hint: ensure the workspace exists (`lore workspaces add <name>`) and `lore` is on PATH');
        console.error('       or pass BEARER=<token> explicitly to bypass this step');
        process.exit(2);
    }
    try {
        const parsed = JSON.parse(res.stdout);
        BEARER = parsed.token;
        if (!BEARER) throw new Error('token field missing');
        console.log(`minted ephemeral token (expires ${parsed.expiresAt})`);
    } catch (parseErr) {
        console.error(`failed to parse 'lore auth issue --json' output: ${parseErr.message}`);
        console.error(res.stdout);
        process.exit(2);
    }
}

console.log(`workspace: ${WORKSPACE}${EPHEMERAL ? ' (ephemeral)' : ''}`);

function makeNodes(runIdx) {
    const filler = 'lorem ipsum dolor sit amet '.repeat(15); // ~390 chars
    return Array.from({ length: N }, (_, i) => ({
        id: `o0-baseline-r${runIdx}-${i}`,
        type: 'decision',
        label: `O0 baseline node r${runIdx} #${i} ${filler.slice(0, 40)}`,
        content: `O0 W9 perf baseline measurement row ${i} of run ${runIdx}. ${filler}`,
        tags: ['o0-baseline', `run-${runIdx}`],
    }));
}

async function oneRun(runIdx) {
    const nodes = makeNodes(runIdx);
    const body = JSON.stringify({ workspace: WORKSPACE, nodes });
    const t0 = performance.now();
    const r = await fetch(`${BASE}/api/nodes/bulk`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${BEARER}`,
            'Content-Type': 'application/json',
        },
        body,
    });
    const txt = await r.text();
    const t1 = performance.now();
    if (!r.ok) throw new Error(`run ${runIdx} HTTP ${r.status}: ${txt.slice(0, 200)}`);
    return t1 - t0;
}

const times = [];
for (let r = 0; r < RUNS; r++) {
    process.stdout.write(`run ${r + 1}/${RUNS}... `);
    const ms = await oneRun(r);
    times.push(ms);
    process.stdout.write(`${ms.toFixed(0)} ms\n`);
}

times.sort((a, b) => a - b);
const kept = times.slice(0, -1); // drop slowest
const median = kept[Math.floor(kept.length / 2)];
const avg = kept.reduce((s, x) => s + x, 0) / kept.length;
const min = kept[0];
const max = kept[kept.length - 1];
const rowsPerSec = (N * 1000) / avg;

console.log('');
console.log(`runs: ${RUNS}, N per run: ${N}, dropped slowest: ${times[times.length - 1].toFixed(0)} ms`);
console.log(`kept times (ms): ${kept.map(x => x.toFixed(0)).join(', ')}`);
console.log(`min:    ${min.toFixed(0)} ms`);
console.log(`median: ${median.toFixed(0)} ms`);
console.log(`max:    ${max.toFixed(0)} ms (after drop = p99 proxy for 4-sample set)`);
console.log(`avg:    ${avg.toFixed(0)} ms`);
console.log(`rate:   ${rowsPerSec.toFixed(0)} rows/sec`);
