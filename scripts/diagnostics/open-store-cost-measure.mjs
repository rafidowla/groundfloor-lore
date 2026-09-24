#!/usr/bin/env node
/**
 * scripts/diagnostics/open-store-cost-measure.mjs — M2 (3.20.0 after-
 * measurements, docs/PERFORMANCE-MEMORY.md §10): per-open-store RSS cost
 * and live handle count when a single process opens N DISTINCT workspaces'
 * VerbatimStore, before vs after the role/search-worker-policy/injected-
 * provider/embed-idle-unload integration (scratch/step3-integration).
 *
 * Opens `--n` (default 10) VerbatimStore instances, each rooted at its own
 * fresh temp directory (a distinct "workspace"), keeps every instance alive
 * (pushed into an array so nothing is GC-eligible), then reports:
 *
 *   - RSS delta from the pre-open baseline, divided by N (MB/store)
 *   - vmmap Physical-footprint delta ÷ N, when available (darwin only)
 *   - handleCount() per store when the method exists (role-aware builds —
 *     see engines/verbatimStoreRole.ts); null on a build that predates it
 *     (e.g. `main` before feat/verbatim-store-role) — a null here is a
 *     build-capability signal, not a zero.
 *   - lsof count of open files whose path mentions "lancedb", once for the
 *     whole process (not per-store — LanceDB's own fd layout groups by
 *     table/manifest, not 1:1 with logical stores)
 *
 * `--role <both|write|read>` selects the VerbatimStore role opt (ignored —
 * harmlessly, extra constructor arg — on a build that doesn't have the
 * role feature at all, e.g. `main`; the resulting run is then simply
 * "today's default behaviour", which is what the M2 "before" number is).
 * `--after search` performs one search() per store after writing, so a
 * role:'both' store actually builds its read pool (the thing the role
 * feature is about); `--after writes` only writes (role:'write' shape —
 * no read pool should ever be built).
 *
 * Self re-execs with --expose-gc + --import tsx, same pattern as
 * scripts/measure-memory.mjs, so GC is deterministic and TS source
 * resolves without a dist/ build.
 *
 * MEASUREMENT ONLY. Nothing here edits packages/lore/src/**.
 */

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
const N = Number.parseInt(argOf('--n', '10'), 10);
const ROLE = argOf('--role', null); // 'both' | 'write' | 'read' | null (build default)
const AFTER = argOf('--after', 'search'); // 'search' | 'writes'
const ENTRIES = Number.parseInt(argOf('--entries', '20'), 10);
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

function lsofLanceCount(pid) {
    try {
        const out = execFileSync('lsof', ['-p', String(pid)], {
            encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
        });
        let n = 0;
        for (const line of out.split('\n')) {
            if (line.toLowerCase().includes('lancedb')) n++;
        }
        return n;
    } catch {
        return null;
    }
}

function sample(pid) {
    try { gc(); } catch { /* --expose-gc missing is impossible here */ }
    const mu = process.memoryUsage();
    return { rssMb: toMb(mu.rss), heapUsedMb: toMb(mu.heapUsed), vmmapFootprintMb: vmmapFootprintMb(pid) };
}

class FakeEmbeddingProvider {
    dimension = 32;
    modelId = 'open-store-cost-harness';
    async initialize() { /* no-op */ }
    async embed(text) { return this.vec(text); }
    async embedQuery(text) { return this.vec(text); }
    async embedDocument(text) { return this.vec(text); }
    async embedDocumentBatch(texts) { return texts.map((t) => this.vec(t)); }
    vec(text) {
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
        let s = h >>> 0;
        const out = new Array(this.dimension);
        for (let i = 0; i < this.dimension; i++) {
            s = (s * 1664525 + 1013904223) >>> 0;
            out[i] = (s / 4294967296) * 2 - 1;
        }
        return out;
    }
}

function makeDoc(wsIdx, i) {
    return {
        id: `lore:open-store-cost-ws${wsIdx}-${i}`,
        text: `open-store-cost harness workspace ${wsIdx} entry ${i}. lorem ipsum dolor sit amet consectetur adipiscing elit.`,
        metadata: {
            type: 'note', label: `ws${wsIdx}#${i}`, tags: 'memory-harness',
            project: 'memory-harness', ecosystem: 'memory-harness',
        },
    };
}

async function main() {
    const { VerbatimStore } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/verbatimStore.ts'));

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-open-store-cost-'));
    const baseline = sample(process.pid);
    console.log(`[open-store-cost] baseline: rss=${baseline.rssMb.toFixed(1)}MB vmmap=${baseline.vmmapFootprintMb == null ? 'n/a' : baseline.vmmapFootprintMb.toFixed(1) + 'MB'}`);

    const stores = [];
    const handleCounts = [];
    for (let i = 0; i < N; i++) {
        const dir = path.join(root, `ws-${i}`);
        fs.mkdirSync(dir, { recursive: true });
        const opts = ROLE ? { role: ROLE } : undefined;
        const store = new VerbatimStore(dir, new FakeEmbeddingProvider(), opts);
        await store.initialize();
        for (let j = 0; j < ENTRIES; j++) {
            await store.store(makeDoc(i, j));
        }
        if (AFTER === 'search') {
            await store.search('lorem ipsum', 5);
        }
        stores.push(store); // keep alive — nothing GC-eligible
        if (typeof store.handleCount === 'function') handleCounts.push(store.handleCount());
        else handleCounts.push(null);
    }

    const after = sample(process.pid);
    const lance = lsofLanceCount(process.pid);

    const rssDeltaTotal = after.rssMb - baseline.rssMb;
    const rssDeltaPerStore = rssDeltaTotal / N;
    const vmmapDeltaPerStore = (baseline.vmmapFootprintMb != null && after.vmmapFootprintMb != null)
        ? (after.vmmapFootprintMb - baseline.vmmapFootprintMb) / N
        : null;
    const allHandleCountsKnown = handleCounts.every((h) => h != null);
    const handleCountConsistent = allHandleCountsKnown && handleCounts.every((h) => h === handleCounts[0]);

    const result = {
        n: N,
        role: ROLE ?? '(build default)',
        after: AFTER,
        entriesPerStore: ENTRIES,
        baselineRssMb: baseline.rssMb,
        afterRssMb: after.rssMb,
        rssDeltaTotalMb: rssDeltaTotal,
        rssDeltaPerStoreMb: rssDeltaPerStore,
        vmmapDeltaPerStoreMb: vmmapDeltaPerStore,
        handleCounts,
        handleCountPerStore: handleCountConsistent ? handleCounts[0] : null,
        lsofLanceFileCount: lance,
    };

    console.log(`[open-store-cost] role=${result.role} after=${AFTER} n=${N}: RSS delta/store=${rssDeltaPerStore.toFixed(2)}MB, vmmap delta/store=${vmmapDeltaPerStore == null ? 'n/a' : vmmapDeltaPerStore.toFixed(2) + 'MB'}, handleCount/store=${result.handleCountPerStore ?? 'n/a (not on this build)'}, lsof lancedb fds=${lance ?? 'n/a'}`);
    if (!handleCountConsistent && allHandleCountsKnown) {
        console.log(`[open-store-cost] NOTE: handleCounts were not uniform across stores: ${JSON.stringify(handleCounts)}`);
    }

    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));

    // Best-effort cleanup — not load-bearing for the measurement.
    for (const s of stores) { try { await s.close?.(); } catch { /* ignore */ } }
    fs.rmSync(root, { recursive: true, force: true });
}

main().catch((err) => { console.error(err); process.exit(1); });
