#!/usr/bin/env tsx
/**
 * workspace-sqlite-profile-open-close-child.ts — child process for
 * test/memory-sqlite-profile-open-close-cycles-unit.ts (3.21 Step 5,
 * docs/PERFORMANCE-MEMORY.md §14).
 *
 * Runs CYCLES cycles of: open a fresh "workspace" on the SQLite profile
 * (SqliteGraph + SqliteVerbatimStore — the 3.21 default for a brand-new
 * local workspace, graphEngineSelector.ts / vectorEngineSelector.ts) ->
 * write ENTRIES nodes + verbatim docs -> close both. Fresh temp dir every
 * cycle. Samples RSS twice per cycle:
 *
 *   - openRssMb  — right after open+write, before close (forced GC first).
 *   - closeRssMb — after close, forced GC, and a short settle wait (the
 *     floor this cycle leaves behind).
 *
 * Independent copy of scripts/diagnostics/workspace-profile-memory-
 * measure.mjs's `--mode cycle` cycle body (same reasoning as
 * memory-open-close-cycles-child.ts's own header: this test does not
 * depend on that diagnostic script's internals staying stable) — settle
 * window shortened (50ms vs the diagnostic's 200ms default) to keep the
 * CI gate test's total runtime low across 50 cycles.
 *
 * Not a test itself — invoked only as a child, with --expose-gc (the
 * parent re-execs itself if launched without it; this child assumes its
 * parent already arranged that). Argv: <cycles> <entriesPerCycle>.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CYCLES = Number.parseInt(process.argv[2] ?? '', 10);
const ENTRIES = Number.parseInt(process.argv[3] ?? '', 10);
if (!Number.isFinite(CYCLES) || !Number.isFinite(ENTRIES)) {
    console.error('usage: workspace-sqlite-profile-open-close-child.ts <cycles> <entriesPerCycle>');
    process.exit(2);
}
if (typeof globalThis.gc !== 'function') {
    console.error('workspace-sqlite-profile-open-close-child.ts requires --expose-gc');
    process.exit(2);
}
const gc = globalThis.gc;
const SETTLE_MS = 50;

function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-wsprofile-sqlite-unit-'));

class FakeEmbeddingProvider {
    dimension = 32;
    modelId = 'wsprofile-sqlite-unit';
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

const filler = 'lorem ipsum dolor sit amet consectetur adipiscing '.repeat(6);

function makeDoc(cycle: number, i: number) {
    return {
        id: `wsprofile-sqlite-unit-c${cycle}-${i}`,
        text: `SQLite profile unit harness verbatim entry cycle ${cycle} #${i}. ${filler}`,
        metadata: {
            type: 'note', label: `entry c${cycle}#${i}`, tags: 'memory-harness',
            project: 'memory-harness', ecosystem: 'memory-harness',
        },
    };
}

function makeNode(cycle: number, i: number) {
    return {
        id: `wsprofile-sqlite-unit-node-c${cycle}-${i}`,
        type: 'note',
        label: `sqlite profile unit node c${cycle}#${i}`,
        content: `SQLite profile unit harness node cycle ${cycle} #${i}. ${filler}`,
        tags: ['memory-harness'],
        project: 'memory-harness',
        ecosystem: 'memory-harness',
        metadata: '{}',
    };
}

const MB = 1024 * 1024;

interface CycleSample {
    cycle: number;
    openRssMb: number;
    closeRssMb: number;
    closeHeapUsedMb: number;
    perOpenDeltaMb: number;
    elapsedMs: number;
}

async function main(): Promise<void> {
    const { SqliteGraph } = await import('../../packages/lore/src/engines/sqliteGraph.js');
    const { SqliteVerbatimStore } = await import('../../packages/lore/src/engines/sqliteVerbatimStore.js');

    gc();
    await sleep(SETTLE_MS);
    gc();
    const baselineRssMb = process.memoryUsage().rss / MB;

    const samples: CycleSample[] = [];
    let prevCloseRssMb = baselineRssMb;

    for (let c = 1; c <= CYCLES; c++) {
        const t0 = performance.now();
        const dir = fs.mkdtempSync(path.join(home, `ws-${c}-`));
        const graph = new SqliteGraph(dir, { workspaceId: `wsprofile-sqlite-unit-${c}` });
        const vector = new SqliteVerbatimStore(dir, new FakeEmbeddingProvider() as never);
        await graph.initialize();
        await vector.initialize();

        const nodes = Array.from({ length: ENTRIES }, (_, i) => makeNode(c, i));
        await graph.bulkUpsertNodes(nodes as never);
        for (let i = 0; i < ENTRIES; i++) {
            await vector.store(makeDoc(c, i));
        }

        gc();
        const openRssMb = process.memoryUsage().rss / MB;

        await graph.close();
        await vector.close();

        gc();
        await sleep(SETTLE_MS);
        gc();
        const mu = process.memoryUsage();
        const closeRssMb = mu.rss / MB;
        const closeHeapUsedMb = mu.heapUsed / MB;
        const elapsedMs = performance.now() - t0;

        samples.push({
            cycle: c,
            openRssMb,
            closeRssMb,
            closeHeapUsedMb,
            perOpenDeltaMb: openRssMb - prevCloseRssMb,
            elapsedMs,
        });
        prevCloseRssMb = closeRssMb;
    }

    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }

    console.log(JSON.stringify({ baselineRssMb, samples }));
}

main().catch((err) => { console.error(err); process.exit(1); });
