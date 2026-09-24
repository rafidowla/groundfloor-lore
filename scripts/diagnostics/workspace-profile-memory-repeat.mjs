#!/usr/bin/env node
/**
 * scripts/diagnostics/workspace-profile-memory-repeat.mjs — 3.21 Step 5.
 * Runs workspace-profile-memory-measure.mjs `--reps` times, SERIALLY, each
 * as its own fresh `node --expose-gc` child process (so one rep's warm-up
 * cost never bleeds into the next), and reports the median + spread of the
 * headline number(s) across reps.
 *
 * `--mode keep-open` (default) reports `perOpenDeltaAvgMb` per rep and
 * `perOpenDeltaMedianIncrementalMb` per rep (the two numbers
 * workspace-profile-memory-measure.mjs itself prints for that mode).
 * `--mode cycle` reports `floorGrowthMb` and `floorSlopeMbPerCycle` per rep.
 *
 * Does NOT itself need --expose-gc — it only spawns children that do.
 *
 * MEASUREMENT ONLY.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SELF);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const CHILD = path.join(SCRIPT_DIR, 'workspace-profile-memory-measure.mjs');

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
};
const PROFILE = argOf('--profile', 'sqlite');
const MODE = argOf('--mode', 'keep-open');
const CYCLES = argOf('--cycles', '15');
const ENTRIES = argOf('--entries', '100');
const SKIP_WARMUP = argOf('--skip-warmup', '3');
const REPS = Number.parseInt(argOf('--reps', '5'), 10);
const JSON_OUT = argOf('--json', null);

function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const n = s.length;
    if (n === 0) return NaN;
    return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function spread(xs) { return Math.max(...xs) - Math.min(...xs); }

const runs = [];
for (let r = 1; r <= REPS; r++) {
    const outFile = path.join(os.tmpdir(), `lore-wsprofile-repeat-${PROFILE}-${MODE}-${r}-${process.pid}.json`);
    console.log(`[repeat] rep ${r}/${REPS}: profile=${PROFILE} mode=${MODE} cycles=${CYCLES} entries=${ENTRIES} ...`);
    const res = spawnSync(
        process.execPath,
        [CHILD, '--profile', PROFILE, '--mode', MODE, '--cycles', CYCLES, '--entries', ENTRIES, '--skip-warmup', SKIP_WARMUP, '--json', outFile],
        { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' },
    );
    if (res.status !== 0) {
        console.error(`[repeat] rep ${r} FAILED (exit ${res.status})\n${res.stdout ?? ''}`);
        process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    runs.push(data.summary);
    try { fs.unlinkSync(outFile); } catch { /* best-effort */ }
}

let headline;
if (MODE === 'keep-open') {
    const avgs = runs.map((s) => s.perOpenDeltaAvgMb);
    const incrementals = runs.map((s) => s.perOpenDeltaMedianIncrementalMb).filter((x) => x != null);
    headline = {
        perOpenDeltaAvgMb: { median: median(avgs), spread: spread(avgs), values: avgs },
        perOpenDeltaMedianIncrementalMb: { median: median(incrementals), spread: spread(incrementals), values: incrementals },
    };
} else {
    const growths = runs.map((s) => s.floorGrowthMb);
    const slopes = runs.map((s) => s.floorSlopeMbPerCycle);
    headline = {
        floorGrowthMb: { median: median(growths), spread: spread(growths), values: growths },
        floorSlopeMbPerCycle: { median: median(slopes), spread: spread(slopes), values: slopes },
    };
}

console.log(`\n[repeat] profile=${PROFILE} mode=${MODE} reps=${REPS} — headline:`);
console.log(JSON.stringify(headline, null, 2));

const result = { profile: PROFILE, mode: MODE, cycles: CYCLES, entries: ENTRIES, reps: REPS, headline, runs };
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
