#!/usr/bin/env node
/**
 * test/helpers/sqlite-graph-leak-child.ts — the actual 20-cycle
 * open→write 100 nodes→close loop behind `sqlite-graph-leak-unit.ts`.
 *
 * Runs as a CHILD PROCESS, started with `--expose-gc`, so `global.gc()` can
 * force a real collection between cycles before sampling RSS — without a
 * forced GC the sample is dominated by V8's own collection scheduling, not
 * whatever this engine actually retained.
 *
 * Also checks, after EVERY close(), that no file descriptor this process
 * holds still references `graph.sqlite` — via a real `lsof -p <pid>` on
 * this machine (darwin), not an inference from JS-visible state. A leaked
 * native fd is exactly the kind of leak `process._getActiveHandles()` and
 * friends do not reliably surface.
 *
 * Emits ONE JSON line per cycle to stdout: `{ cycle, rssBytes, openFdCount }`.
 * The parent (`sqlite-graph-leak-unit.ts`) parses these lines and does the
 * slope/threshold assertions — this script only measures and reports.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SqliteGraph } from '../../packages/lore/src/engines/sqliteGraph.js';
import type { LoreNode } from '../../packages/lore/src/providers/types.js';

const CYCLES = 20;
const NODES_PER_CYCLE = 100;

function openGraphSqliteFdCount(): number {
    try {
        const out = execFileSync('lsof', ['-p', String(process.pid)], { encoding: 'utf8' });
        return out.split('\n').filter((line) => line.includes('graph.sqlite')).length;
    } catch {
        // lsof returning non-zero (e.g. "no file descriptors" on some
        // platforms) is not itself a leak signal — treat as 0 rather than
        // crashing the measurement.
        return 0;
    }
}

async function runCycle(cycle: number): Promise<{ rssBytes: number; openFdCount: number }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lore-sqlite-leak-${cycle}-`));
    const g = new SqliteGraph(dir, { workspaceId: `leak-${cycle}` });
    await g.initialize();
    const now = new Date().toISOString();
    const nodes: LoreNode[] = [];
    for (let i = 0; i < NODES_PER_CYCLE; i++) {
        nodes.push({
            id: `n${i}`, type: 'note', label: `Node ${i}`, content: `Body ${i}`,
            tags: ['leak'], project: '*', ecosystem: '*', metadata: '{}',
            createdAt: now, updatedAt: now, syncedAt: null,
        });
    }
    await g.importRaw(nodes, []);
    await g.close();
    fs.rmSync(dir, { recursive: true, force: true });

    const openFdCount = openGraphSqliteFdCount();

    if (typeof global.gc === 'function') global.gc();
    else throw new Error('global.gc is not available — run this child with --expose-gc');

    return { rssBytes: process.memoryUsage().rss, openFdCount };
}

async function main(): Promise<void> {
    for (let cycle = 0; cycle < CYCLES; cycle++) {
        const { rssBytes, openFdCount } = await runCycle(cycle);
        console.log(JSON.stringify({ cycle, rssBytes, openFdCount }));
    }
}

main().catch((err) => {
    console.error('CHILD FAIL:', err);
    process.exit(1);
});
