#!/usr/bin/env node
/**
 * scripts/measure-surreal-unclean-open.mjs — memory-leak sprint, Step 1,
 * Deliverable B: answers Q2 of ../nirman-tapestry/docs/lore-asks/QUESTIONS-FOR-LORE.md
 * (read-only reference — this repo does not own that file):
 *
 *   "What does SurrealDB's unclean-shutdown recovery cost in RSS?"
 *
 * Q2 cites an alarming number from the PRIOR local graph engine (12,567 MB
 * peak opening a ~13 MB WAL, one data point, on an engine removed 2026-08-21
 * — see docs/KUZU_REMOVAL.md) and asks whether anyone has measured the SAME
 * question for SurrealDB, the only graph engine since that removal.
 * This script is that measurement.
 *
 * Reuses the existing `scripts/diagnostics/wal-memory.ts` harness (already
 * built for exactly this shape: `gen` writes a workload and exits clean or
 * SIGKILLs itself, `open` does one cold open and reports RSS at each step)
 * rather than re-implementing a writer. What this script ADDS on top:
 *
 *   1. Runs BOTH arms (`gen ... WAL_EXIT=clean` and `WAL_EXIT=kill`) against
 *      otherwise-identical workloads, in separate directories.
 *   2. For the `open` stage of each arm, spawns it as a CHILD and polls the
 *      child's own OS-reported RSS via `ps -o rss= -p <pid>` at a short
 *      interval for the child's ENTIRE lifetime, keeping the max. This is
 *      the "peak RSS during first open/initialize" the ask requires —
 *      `wal-memory.ts open` only ever prints RSS AFTER each await resolves,
 *      which can miss a transient spike inside a native call (WAL replay)
 *      that the engine frees again before returning control to JS. Polling
 *      the OS-level RSS from OUTSIDE the child's event loop catches that
 *      even if the child never yields.
 *   3. Prints both arms' peaks + on-disk sizes side by side.
 *
 * Usage:
 *   node scripts/measure-surreal-unclean-open.mjs [--nodes 3000] [--json out.json]
 *
 * Node 22 required (matches the rest of this sprint's harnesses).
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WAL_MEMORY = path.join(REPO_ROOT, 'scripts', 'diagnostics', 'wal-memory.ts');

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
};
const NODES = Number.parseInt(argOf('--nodes', '3000'), 10);
const JSON_OUT = argOf('--json', null);
const POLL_MS = Number.parseInt(argOf('--poll-ms', '15'), 10);

const MB = 1024 * 1024;
const mb = (bytes) => bytes / MB;

/** Runs `tsx scripts/diagnostics/wal-memory.ts <stage>` as a child with the
 *  given env, returns { stdout, exitedBy: 'exit'|'signal', code, signal }.
 *  Never rejects on a non-zero/killed exit — the `kill` arm of `gen`
 *  SIGKILLs itself on purpose. */
function runStage(stage, env) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', WAL_MEMORY, stage], {
            cwd: REPO_ROOT,
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c.toString(); });
        child.stderr.on('data', (c) => { stderr += c.toString(); });
        child.on('exit', (code, signal) => resolve({ stdout, stderr, code, signal }));
    });
}

/** Runs `tsx scripts/diagnostics/wal-memory.ts open` as a child, polling its
 *  OS-reported RSS via `ps` for the child's entire lifetime. Returns the
 *  child's own JSON report plus { peakRssMb, sampleCount }. */
function runOpenWithPeakSampling(env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', WAL_MEMORY, 'open'], {
            cwd: REPO_ROOT,
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let peakRssMb = 0;
        let sampleCount = 0;
        child.stdout.on('data', (c) => { stdout += c.toString(); });
        child.stderr.on('data', (c) => { stderr += c.toString(); });

        const pid = child.pid;
        const poll = setInterval(() => {
            if (!pid) return;
            try {
                const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
                    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
                }).trim();
                if (out) {
                    sampleCount++;
                    const rssMb = Number(out) / 1024;
                    if (rssMb > peakRssMb) peakRssMb = rssMb;
                }
            } catch {
                // Process gone between spawn and first poll, or between polls
                // right before exit — not an error, just stop counting it.
            }
        }, POLL_MS);

        child.on('exit', (code) => {
            clearInterval(poll);
            if (code !== 0) {
                reject(new Error(`wal-memory.ts open exited ${code}\n${stderr}`));
                return;
            }
            let report;
            try {
                report = JSON.parse(stdout);
            } catch (err) {
                reject(new Error(`could not parse wal-memory.ts open output: ${err.message}\n${stdout}`));
                return;
            }
            resolve({ report, peakRssMb, sampleCount });
        });
    });
}

function dirSizeMb(dir) {
    let total = 0;
    function walk(d) {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) { try { total += fs.statSync(p).size; } catch { /* raced away */ } }
        }
    }
    walk(dir);
    return mb(total);
}

/** Best-effort: sum any file under a surreal store dir whose name suggests
 *  a write-ahead log / journal, so "WAL size" is reported even though
 *  surrealkv's on-disk layout is opaque from outside the engine. */
function walLikeSizeMb(surrealDir) {
    let total = 0;
    function walk(d) {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile() && /wal|journal|\.log$/i.test(e.name)) {
                try { total += fs.statSync(p).size; } catch { /* raced away */ }
            }
        }
    }
    walk(surrealDir);
    return mb(total);
}

async function runArm(label, exitMode, workDir) {
    fs.mkdirSync(workDir, { recursive: true });
    console.log(`\n[${label}] gen: writing ${NODES} nodes, exit=${exitMode} ...`);
    const genEnv = {
        WAL_DIR: workDir, WAL_ENGINE: 'surreal', WAL_NODES: String(NODES), WAL_EXIT: exitMode,
    };
    const gen = await runStage('gen', genEnv);
    // The `kill` arm SIGKILLs itself (signal SIGKILL / code null); the
    // `clean` arm exits 0. Anything else is a genuine failure.
    if (exitMode === 'kill') {
        if (gen.signal !== 'SIGKILL' && gen.code !== 0) {
            throw new Error(`[${label}] gen (kill) exited unexpectedly: code=${gen.code} signal=${gen.signal}\n${gen.stderr}`);
        }
    } else if (gen.code !== 0) {
        throw new Error(`[${label}] gen (clean) exited ${gen.code}\n${gen.stderr}`);
    }
    // The kill arm's last line is the JSON printed just before self-SIGKILL.
    let genReport = null;
    try {
        const lastLine = gen.stdout.trim().split('\n').filter(Boolean).pop();
        genReport = lastLine ? JSON.parse(lastLine) : null;
    } catch { /* best-effort — the peak-open numbers below don't depend on this */ }

    const surrealDir = path.join(workDir, 'ws', '.lore', 'surreal');
    const onDiskMbBeforeOpen = dirSizeMb(surrealDir);
    const walLikeMbBeforeOpen = walLikeSizeMb(surrealDir);

    console.log(`[${label}] on-disk .lore/surreal before open: ${onDiskMbBeforeOpen.toFixed(2)} MB (wal-like files: ${walLikeMbBeforeOpen.toFixed(2)} MB)`);
    console.log(`[${label}] open: fresh child, polling RSS every ${POLL_MS}ms ...`);

    const { report: openReport, peakRssMb, sampleCount } = await runOpenWithPeakSampling({
        WAL_DIR: workDir, WAL_ENGINE: 'surreal',
    });

    console.log(`[${label}] peak RSS during open (external ps poll, ${sampleCount} samples): ${peakRssMb.toFixed(1)} MB`);
    console.log(`[${label}] open self-reported: baseline=${openReport.baselineRssMb} MB afterOpen=${openReport.afterOpenRssMb} MB afterStats=${openReport.afterStatsRssMb} MB openMs=${openReport.openMs} nodes=${openReport.nodes} edges=${openReport.edges}`);

    return {
        label,
        exitMode,
        nodesWritten: NODES,
        genReport,
        onDiskMbBeforeOpen,
        walLikeMbBeforeOpen,
        peakRssMbDuringOpen: peakRssMb,
        peakSampleCount: sampleCount,
        openSelfReported: openReport,
    };
}

async function main() {
    console.log(`Surreal unclean-vs-clean first-open peak RSS — nodes=${NODES}`);
    console.log(`node ${process.versions.node} · ${process.platform}/${process.arch}`);

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-unclean-'));
    const cleanDir = path.join(scratch, 'clean');
    const uncleanDir = path.join(scratch, 'unclean');

    try {
        const clean = await runArm('clean', 'clean', cleanDir);
        const unclean = await runArm('unclean', 'kill', uncleanDir);

        console.log('\n=== Summary ===');
        console.log(`clean:    peak RSS during open = ${clean.peakRssMbDuringOpen.toFixed(1)} MB  ` +
            `on-disk before open = ${clean.onDiskMbBeforeOpen.toFixed(2)} MB  ` +
            `wal-like before open = ${clean.walLikeMbBeforeOpen.toFixed(2)} MB`);
        console.log(`unclean:  peak RSS during open = ${unclean.peakRssMbDuringOpen.toFixed(1)} MB  ` +
            `on-disk before open = ${unclean.onDiskMbBeforeOpen.toFixed(2)} MB  ` +
            `wal-like before open = ${unclean.walLikeMbBeforeOpen.toFixed(2)} MB`);
        const deltaMb = unclean.peakRssMbDuringOpen - clean.peakRssMbDuringOpen;
        console.log(`delta (unclean - clean): ${deltaMb.toFixed(1)} MB`);

        const result = {
            tool: 'measure-surreal-unclean-open.mjs',
            nodes: NODES,
            node: process.versions.node,
            platform: `${process.platform}/${process.arch}`,
            loreVersion: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version,
            timestamp: new Date().toISOString(),
            clean,
            unclean,
            deltaPeakRssMb: deltaMb,
        };
        if (JSON_OUT) {
            fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
            console.log(`\nJSON written to ${JSON_OUT}`);
        }
    } finally {
        try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

await main();
