#!/usr/bin/env tsx
/**
 * memory-surreal-leak-pinned-child.ts — child process for
 * test/memory-surreal-leak-pinned-unit.ts.
 *
 * Runs N bare `SurrealGraph` open -> write -> close cycles, fresh dir every
 * cycle — the exact shape of the `surreal-only` config's cycle body in
 * scripts/measure-memory-configs.mjs's `runSurrealOnlyCycle` (already
 * measured there at ~100 MB/cycle — docs/PERFORMANCE-MEMORY.md §9,
 * evidence #1), reproduced here as an independent TS copy rather than a
 * cross-import (that script is plain `.mjs`, outside `tsconfig.json`'s
 * `include`/no `allowJs` — importing it from a `.ts` test file would fail
 * `tsc --noEmit` / `test:arch`'s `test-test-types.mjs`; same convention
 * `memory-open-close-cycles-child.ts` already follows for
 * `FakeEmbeddingProvider`). Forces a GC and samples
 * `process.memoryUsage().rss` after every cycle, then prints one JSON line
 * — `{ samples: [...] }` — to stdout and exits.
 *
 * Not a test itself — invoked only as a child, with --expose-gc (the parent
 * re-execs itself if launched without it; this child assumes its parent
 * already arranged that). Argv: <cycles> <entriesPerCycle>.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CYCLES = Number.parseInt(process.argv[2] ?? '', 10);
const ENTRIES = Number.parseInt(process.argv[3] ?? '', 10);
if (!Number.isFinite(CYCLES) || !Number.isFinite(ENTRIES)) {
    console.error('usage: memory-surreal-leak-pinned-child.ts <cycles> <entriesPerCycle>');
    process.exit(2);
}
if (typeof globalThis.gc !== 'function') {
    console.error('memory-surreal-leak-pinned-child.ts requires --expose-gc');
    process.exit(2);
}
const gc = globalThis.gc;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-memcycle-surreal-pinned-'));

const { SurrealGraph } = await import('../../packages/lore/src/engines/surrealGraph.js');

/** Independent TS copy of scripts/measure-memory-configs.mjs's
 *  runSurrealOnlyCycle — see this file's header for why it's copied
 *  rather than cross-imported. */
async function runSurrealOnlyCycle(basePath: string, cycle: number, entries: number): Promise<void> {
    const graph = new SurrealGraph(basePath, { workspaceId: 'surreal-only-harness' });
    await graph.initialize();
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing '.repeat(6);
    const nodes = Array.from({ length: entries }, (_, i) => ({
        id: `surreal-cycle${cycle}-${i}`,
        type: 'note',
        label: `surreal-only entry c${cycle}#${i}`,
        content: `Surreal-only harness node cycle ${cycle} #${i}. ${filler}`,
        tags: ['memory-harness'],
        project: 'memory-harness',
        ecosystem: 'memory-harness',
        metadata: '{}',
    }));
    await graph.bulkUpsertNodes(nodes as never);
    await graph.close();
}

const samples: Array<{ cycle: number; rssMb: number; heapUsedMb: number; elapsedMs: number }> = [];
const MB = 1024 * 1024;

for (let c = 1; c <= CYCLES; c++) {
    const t0 = performance.now();
    const dir = fs.mkdtempSync(path.join(home, `sg-${c}-`));
    await runSurrealOnlyCycle(dir, c, ENTRIES);
    const elapsedMs = performance.now() - t0;

    gc();
    const mu = process.memoryUsage();
    samples.push({ cycle: c, rssMb: mu.rss / MB, heapUsedMb: mu.heapUsed / MB, elapsedMs });
}

try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(JSON.stringify({ samples }));
