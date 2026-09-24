#!/usr/bin/env node
/**
 * scripts/diagnostics/embed-release-measure.mjs — M3 (3.20.0 after-
 * measurements, docs/PERFORMANCE-MEMORY.md §10): does
 * `releaseLocalEmbeddingPipeline()` (feat/embed-pipeline-idle-unload)
 * actually give back the ONNX pipeline's resident memory, and does a
 * subsequent embed transparently reload it?
 *
 * Five checkpoints, one process, sampled in order:
 *   1. no model            — before LocalEmbeddingProvider is ever touched
 *   2. after load + 200    — provider.initialize() + 200 embeds (one
 *                            embedDocumentBatch call)
 *   3. after release       — releaseLocalEmbeddingPipeline() + gc() + a
 *                            2s wait (matches the ask's own protocol —
 *                            gives any async native teardown a chance to
 *                            actually run before sampling)
 *   4. after reload + 200  — a FRESH LocalEmbeddingProvider instance,
 *                            initialize() (must reload — the module-level
 *                            pipelineCache was just cleared), 200 embeds
 *   5. after second release — releaseLocalEmbeddingPipeline() + gc() again
 *
 * Meant to be run 3 times (fresh process each time — the pipeline cache is
 * module-global, so repeats need separate processes to be independent) and
 * all runs reported, per the ask ("the first run happened with parallel
 * agents" — this one is a clean, single-agent, serial re-run).
 *
 * Self re-execs with --expose-gc + --import tsx, same pattern as
 * scripts/measure-memory.mjs.
 *
 * MEASUREMENT ONLY. Nothing here edits packages/lore/src/**.
 */

import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..');

if (typeof globalThis.gc !== 'function') {
    const res = spawnSync(
        process.execPath,
        ['--expose-gc', '--import', 'tsx', SELF, ...process.argv.slice(2)],
        { stdio: 'inherit', cwd: REPO_ROOT, env: process.env },
    );
    process.exit(res.status ?? 1);
}
const gc = globalThis.gc;

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
};
const EMBEDS = Number.parseInt(argOf('--embeds', '200'), 10);
const JSON_OUT = argOf('--json', null);

const MB = 1024 * 1024;
const toMb = (b) => b / MB;

function vmmapFootprintMb(pid) {
    if (process.platform !== 'darwin') return null;
    try {
        const out = execFileSync('vmmap', ['--summary', String(pid)], {
            encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
        });
        const m = /Physical footprint:\s+([\d.]+)([KMG])/.exec(out);
        if (!m) return null;
        const value = Number.parseFloat(m[1]);
        const mult = m[2] === 'G' ? 1024 : m[2] === 'K' ? 1 / 1024 : 1;
        return value * mult;
    } catch {
        return null;
    }
}

function sample(label) {
    try { gc(); } catch { /* --expose-gc is guaranteed present here */ }
    const mu = process.memoryUsage();
    const s = {
        label,
        rssMb: toMb(mu.rss),
        heapUsedMb: toMb(mu.heapUsed),
        vmmapFootprintMb: vmmapFootprintMb(process.pid),
    };
    console.log(`[embed-release] ${label}: rss=${s.rssMb.toFixed(1)}MB heapUsed=${s.heapUsedMb.toFixed(1)}MB vmmap=${s.vmmapFootprintMb == null ? 'n/a' : s.vmmapFootprintMb.toFixed(1) + 'MB'}`);
    return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function texts(n, tag) {
    return Array.from({ length: n }, (_, i) =>
        `embed-release harness ${tag} text #${i}. lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.`);
}

async function main() {
    const { LocalEmbeddingProvider, releaseLocalEmbeddingPipeline, _pipelineCacheSizeForTests } =
        await import(path.join(REPO_ROOT, 'packages/lore/src/providers/localEmbeddingProvider.ts'));

    const samples = [];

    samples.push(sample('1-no-model'));
    console.log(`[embed-release] pipelineCacheSize (should be 0): ${_pipelineCacheSizeForTests()}`);

    let provider = new LocalEmbeddingProvider();
    await provider.initialize();
    await provider.embedDocumentBatch(texts(EMBEDS, 'first-load'));
    samples.push(sample('2-after-load-plus-200'));
    console.log(`[embed-release] pipelineCacheSize (should be >=1): ${_pipelineCacheSizeForTests()}`);

    const released1 = releaseLocalEmbeddingPipeline();
    await sleep(2000);
    samples.push(sample('3-after-release'));
    console.log(`[embed-release] released1=${released1} pipelineCacheSize (should be 0): ${_pipelineCacheSizeForTests()}`);

    provider = new LocalEmbeddingProvider();
    await provider.initialize();
    await provider.embedDocumentBatch(texts(EMBEDS, 'reload'));
    samples.push(sample('4-after-reload-plus-200'));
    console.log(`[embed-release] pipelineCacheSize (should be >=1 again): ${_pipelineCacheSizeForTests()}`);

    const released2 = releaseLocalEmbeddingPipeline();
    await sleep(2000);
    samples.push(sample('5-after-second-release'));
    console.log(`[embed-release] released2=${released2} pipelineCacheSize (should be 0): ${_pipelineCacheSizeForTests()}`);

    const result = { embeds: EMBEDS, samples, released1, released2 };
    if (JSON_OUT) {
        const fs = await import('node:fs');
        fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
