#!/usr/bin/env tsx
/**
 * memory-open-close-cycles-child.ts — child process for
 * test/memory-open-close-cycles-unit.ts.
 *
 * Split 2026-09-18 (docs/PERFORMANCE-MEMORY.md "§13 — splitting the memory
 * regression test"). The original version of this file ran a full
 * `embedded` createLore()/dispose() cycle, which — after 3.20.0's
 * VerbatimStore/LoadJobsStore/etc. close-path fixes landed — still leaks,
 * because `embedded` also opens SurrealDB, and `@surrealdb/node` 3.0.3
 * never frees a datastore on close() (docs/PERFORMANCE-MEMORY.md §9). That
 * upstream leak is now covered on its own, as a PINNED CANARY, by
 * test/memory-surreal-leak-pinned-unit.ts +
 * test/helpers/memory-surreal-leak-pinned-child.ts.
 *
 * This file now runs the two cycle shapes that are entirely within Lore's
 * own control and are expected to be FLAT today:
 *
 *   verbatim  — bare `VerbatimStore` open -> write -> close, fresh temp dir
 *               every cycle. Same shape as scripts/measure-memory.mjs's
 *               `inproc` config's cycle body (a `FakeEmbeddingProvider`, no
 *               ONNX, no SurrealDB), reproduced here as an independent copy
 *               (that script exports `runEngineCycle` only implicitly, not
 *               as a named export) so this test does not depend on the
 *               diagnostic script's internals staying stable — same
 *               convention this file already followed pre-split.
 *   resolver  — `WorkspaceVerbatimResolver.getOrOpen()` -> write -> its own
 *               `evictIdle(now, 0)`, fresh workspace (and therefore fresh
 *               on-disk dir — `createWorkspace()` always mkdirs a new one)
 *               every cycle. Narrower than
 *               scripts/measure-memory-configs.mjs's `runWorkspaceCycle`
 *               (which also drives the graph registry and a full
 *               `lore.bulkIngest()`): this isolates the vector-store half
 *               of that shape only, matching what
 *               `test:unit:memory-open-close-cycles` is scoped to assert.
 *
 * Not a test itself — invoked only as a child, with --expose-gc (the parent
 * re-execs itself if launched without it; this child assumes its parent
 * already arranged that). Argv: <mode: verbatim|resolver> <cycles>
 * <entriesPerCycle>.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MODE = process.argv[2];
const CYCLES = Number.parseInt(process.argv[3] ?? '', 10);
const ENTRIES = Number.parseInt(process.argv[4] ?? '', 10);
if (MODE !== 'verbatim' && MODE !== 'resolver') {
    console.error('usage: memory-open-close-cycles-child.ts <verbatim|resolver> <cycles> <entriesPerCycle>');
    process.exit(2);
}
if (!Number.isFinite(CYCLES) || !Number.isFinite(ENTRIES)) {
    console.error('usage: memory-open-close-cycles-child.ts <verbatim|resolver> <cycles> <entriesPerCycle>');
    process.exit(2);
}
if (typeof globalThis.gc !== 'function') {
    console.error('memory-open-close-cycles-child.ts requires --expose-gc');
    process.exit(2);
}
const gc = globalThis.gc;

const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-memcycle-unit-${MODE}-`));
process.env['LORE_HOME'] = home;

function makeDoc(cycle: number, i: number) {
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing '.repeat(6);
    return {
        id: `mem-cycle${cycle}-${i}`,
        text: `Memory harness verbatim entry cycle ${cycle} #${i}. ${filler}`,
        metadata: {
            type: 'note',
            label: `mem entry c${cycle}#${i}`,
            tags: 'memory-harness',
            project: 'memory-harness',
            ecosystem: 'memory-harness',
        },
    };
}

/** Deterministic, cheap stand-in embedding provider — no ONNX model load.
 *  Independent copy of scripts/measure-memory.mjs's FakeEmbeddingProvider
 *  (same reasoning as this file's header: don't depend on that script's
 *  internals staying stable). */
class FakeEmbeddingProvider {
    dimension = 32;
    modelId = 'fake-memory-harness';
    async initialize() { /* no-op */ }
    async embed(text: string) { return this.vec(text); }
    async embedQuery(text: string) { return this.vec(text); }
    async embedDocument(text: string) { return this.vec(text); }
    async embedDocumentBatch(texts: string[]) { return texts.map((t) => this.vec(t)); }
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

const samples: Array<{ cycle: number; rssMb: number; heapUsedMb: number; elapsedMs: number }> = [];
const MB = 1024 * 1024;

if (MODE === 'verbatim') {
    const { VerbatimStore } = await import('../../packages/lore/src/engines/verbatimStore.js');
    for (let c = 1; c <= CYCLES; c++) {
        const t0 = performance.now();
        const dir = fs.mkdtempSync(path.join(home, `vs-${c}-`));
        const store = new VerbatimStore(dir, new FakeEmbeddingProvider() as never);
        await store.initialize();
        for (let i = 0; i < ENTRIES; i++) {
            await store.store(makeDoc(c, i));
        }
        await store.close();
        const elapsedMs = performance.now() - t0;

        gc();
        const mu = process.memoryUsage();
        samples.push({ cycle: c, rssMb: mu.rss / MB, heapUsedMb: mu.heapUsed / MB, elapsedMs });
    }
} else {
    const { WorkspaceVerbatimResolver } = await import('../../packages/lore/src/outbox/workspaceVerbatimResolver.js');
    const { createWorkspace } = await import('../../packages/lore/src/config/workspaces.js');
    const resolver = new WorkspaceVerbatimResolver(new FakeEmbeddingProvider() as never, false, undefined, { home });
    for (let c = 1; c <= CYCLES; c++) {
        const t0 = performance.now();
        const name = `wvr-cycle-${c}`;
        createWorkspace(name, {}, home);
        const store = await resolver.getOrOpen(name);
        for (let i = 0; i < ENTRIES; i++) {
            await store.store(makeDoc(c, i));
        }
        await resolver.evictIdle(Date.now(), 0);
        const elapsedMs = performance.now() - t0;

        gc();
        const mu = process.memoryUsage();
        samples.push({ cycle: c, rssMb: mu.rss / MB, heapUsedMb: mu.heapUsed / MB, elapsedMs });
    }
}

try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(JSON.stringify({ samples }));
