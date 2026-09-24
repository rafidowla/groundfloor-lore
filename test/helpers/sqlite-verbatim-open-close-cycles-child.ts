#!/usr/bin/env tsx
/**
 * sqlite-verbatim-open-close-cycles-child.ts — child process for
 * test/sqlite-verbatim-open-close-cycles-unit.ts.
 *
 * 3.21 step 2 part 1 (design CHECK: "The 50-cycle open/close test... acceptance
 * 4" scoped down to the design's own explicit leak-test ask: "20-cycle
 * open/write/close leak test flat (< 5 MB/cycle, 0 leaked fds)"). Same
 * child-process + --expose-gc method as
 * test/helpers/memory-open-close-cycles-child.ts's `verbatim` mode: bare
 * SqliteVerbatimStore open -> write -> close, fresh temp dir every cycle,
 * a deterministic stand-in embedding provider (no ONNX). Additionally
 * tracks open file descriptors via /dev/fd (macOS/BSD; Linux would use
 * /proc/self/fd — this repo's dev/CI machines are macOS per AGENTS.md) so
 * the parent can assert 0 leaked fds across the run, not just flat RSS.
 *
 * Argv: <cycles> <entriesPerCycle>.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CYCLES = Number.parseInt(process.argv[2] ?? '', 10);
const ENTRIES = Number.parseInt(process.argv[3] ?? '', 10);
if (!Number.isFinite(CYCLES) || !Number.isFinite(ENTRIES)) {
    console.error('usage: sqlite-verbatim-open-close-cycles-child.ts <cycles> <entriesPerCycle>');
    process.exit(2);
}
if (typeof globalThis.gc !== 'function') {
    console.error('sqlite-verbatim-open-close-cycles-child.ts requires --expose-gc');
    process.exit(2);
}
const gc = globalThis.gc;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sqlite-memcycle-unit-'));

function makeDoc(cycle: number, i: number) {
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing '.repeat(6);
    return {
        id: `mem-cycle${cycle}-${i}`,
        text: `Memory harness verbatim entry cycle ${cycle} #${i}. ${filler}`,
        metadata: { type: 'note', label: `mem entry c${cycle}#${i}`, tags: 'memory-harness' },
    };
}

/** Deterministic, cheap stand-in embedding provider — no ONNX model load.
 *  Independent copy of memory-open-close-cycles-child.ts's
 *  FakeEmbeddingProvider (same file does not import from another test
 *  helper, by that file's own stated convention). */
class FakeEmbeddingProvider {
    dimension = 32;
    modelId = 'fake-sqlite-memory-harness';
    dtype = 'fp32';
    async initialize() { /* no-op */ }
    async embed(text: string) { return this.vec(text); }
    async embedQuery(text: string) { return this.vec(text); }
    async embedDocument(text: string) { return this.vec(text); }
    vec(text: string) {
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

function fdCount(): number {
    try { return fs.readdirSync('/dev/fd').length; } catch { return -1; } // -1: /dev/fd unavailable on this platform
}

const samples: Array<{ cycle: number; rssMb: number; heapUsedMb: number; elapsedMs: number; fds: number }> = [];
const MB = 1024 * 1024;

const { SqliteVerbatimStore } = await import('../../packages/lore/src/engines/sqliteVerbatimStore.js');

const fdsBefore = fdCount();
for (let c = 1; c <= CYCLES; c++) {
    const t0 = performance.now();
    const dir = fs.mkdtempSync(path.join(home, `svs-${c}-`));
    const store = new SqliteVerbatimStore(dir, new FakeEmbeddingProvider() as never);
    await store.initialize();
    for (let i = 0; i < ENTRIES; i++) {
        await store.store(makeDoc(c, i));
    }
    await store.close();
    const elapsedMs = performance.now() - t0;

    gc();
    const mu = process.memoryUsage();
    samples.push({ cycle: c, rssMb: mu.rss / MB, heapUsedMb: mu.heapUsed / MB, elapsedMs, fds: fdCount() });
}
const fdsAfter = fdCount();

try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(JSON.stringify({ samples, fdsBefore, fdsAfter }));
