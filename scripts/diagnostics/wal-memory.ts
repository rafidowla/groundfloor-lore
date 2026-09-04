#!/usr/bin/env tsx
/**
 * wal-memory.ts — item 2 of docs/SURREALDB_PHASE6.md: how big is the
 * write-ahead-log replay spike on SurrealDB, the only graph engine since the
 * legacy engine's removal (2026-08-21, see docs/KUZU_REMOVAL.md)?
 *
 * Phase 5 measured 12,567 MB peak inside `initialize()` opening a workspace that
 * carried a 12,976,690-byte `graph.wal`, and 516 MB on every open after. That
 * was ONE data point, on ONE engine, and the conclusion drawn from it ("roughly
 * 1000× the WAL size") is doing a lot of load-bearing work. This harness exists
 * to confirm or break it.
 *
 * ONE STAGE PER PROCESS, deliberately, so every `open` stage is a cold,
 * uncontaminated peak-RSS reading; run it under `/usr/bin/time -l` for the
 * authoritative figure. `WAL_ENGINE` also still accepts the legacy graph
 * engine's sentinel value (`GraphEngineKind`, engines/graphEngineSelector.ts),
 * purely to confirm the engine-removed guard rejects it loudly rather than
 * silently falling back to something else.
 *
 *   WAL_DIR=<dir> WAL_ENGINE=surreal WAL_NODES=<n> WAL_EXIT=clean|kill \
 *     tsx scripts/diagnostics/wal-memory.ts gen
 *   WAL_DIR=<dir> WAL_ENGINE=surreal tsx scripts/diagnostics/wal-memory.ts open
 *   WAL_DIR=<dir> tsx scripts/diagnostics/wal-memory.ts sizes
 *
 * `gen` builds a workspace, writes a representative workload, and either closes
 * cleanly or SIGKILLs itself mid-life to leave an unclean store behind.
 * `open` opens it once and reports RSS at each step.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { LocalGraphRegistry } from '../../packages/lore/src/engines/localGraphRegistry.js';
import type { GraphEngineKind } from '../../packages/lore/src/engines/graphEngineSelector.js';
import type { LoreNode } from '../../packages/lore/src/providers/types.js';

const DIR = process.env['WAL_DIR'];
if (!DIR) throw new Error('wal-memory: WAL_DIR is required');
// Cast through the sentinel file's own exported type rather than a locally
// re-declared literal union, so this script exercises the SAME vocabulary
// the engine-removed guard checks against instead of a copy of it.
const ENGINE = (process.env['WAL_ENGINE'] ?? 'surreal') as GraphEngineKind;
const NODES = Number(process.env['WAL_NODES'] ?? '2000');
const EXIT_MODE = (process.env['WAL_EXIT'] ?? 'clean') as 'clean' | 'kill';
const EDGES_PER_NODE = Number(process.env['WAL_EDGES_PER_NODE'] ?? '2');

const HOME = path.join(DIR, 'home');
const WS = path.join(DIR, 'ws');
const mb = (b: number): number => Math.round(b / 1048576);
const rssMb = (): number => mb(process.memoryUsage().rss);

function ensureHome(): void {
    fs.mkdirSync(path.join(WS, '.lore'), { recursive: true });
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(
        path.join(HOME, 'workspaces.json'),
        JSON.stringify({
            active: 'w',
            workspaces: [{
                name: 'w', path: WS, createdAt: new Date().toISOString(),
                graphEngine: ENGINE,
            }],
        }, null, 2),
    );
}

function fileSize(p: string): number {
    try { return fs.statSync(p).size; } catch { return 0; }
}

function dirSize(d: string): number {
    let total = 0;
    if (!fs.existsSync(d)) return 0;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) total += dirSize(p);
        else if (e.isFile()) total += fileSize(p);
    }
    return total;
}

/** Every on-disk artefact that could carry unreplayed state, per engine. */
function storeSizes(): Record<string, number> {
    const lore = path.join(WS, '.lore');
    return {
        legacyGraphBytes: fileSize(path.join(lore, 'graph')),
        legacyWalBytes: fileSize(path.join(lore, 'graph.wal')),
        surrealBytes: dirSize(path.join(lore, 'surreal')),
    };
}

function node(i: number): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    // Content sized so the workload writes real bytes rather than empty rows —
    // a WAL made of 20-byte records would not exercise the replay path.
    return {
        id: `wal-node-${String(i).padStart(7, '0')}`,
        type: 'decision',
        label: `WAL bench node ${i}`,
        content: `Representative body for node ${i}. `.repeat(12),
        tags: ['wal', `bucket-${i % 16}`],
        project: 'walbench',
        ecosystem: 'bench',
        metadata: JSON.stringify({ i, note: 'wal-memory harness' }),
    };
}

const stage = process.argv[2];

/* ── gen — build a workspace and leave it clean or unclean ───────── */
if (stage === 'gen') {
    ensureHome();
    const registry = new LocalGraphRegistry({ home: HOME });
    const graph = await registry.getGraphHandle('w');
    const t0 = Date.now();
    for (let i = 0; i < NODES; i++) await graph.upsertNode(node(i));
    for (let i = 0; i + 1 < NODES; i++) {
        for (let k = 1; k <= EDGES_PER_NODE && i + k < NODES; k++) {
            await graph.addEdge({
                sourceId: `wal-node-${String(i).padStart(7, '0')}`,
                targetId: `wal-node-${String(i + k).padStart(7, '0')}`,
                relation: 'refers_to',
            });
        }
    }
    const writeMs = Date.now() - t0;
    const beforeClose = storeSizes();

    if (EXIT_MODE === 'kill') {
        // Unclean: no close, no checkpoint, no flush of anything the engine
        // defers to shutdown. SIGKILL cannot be trapped, which is the point.
        console.log(JSON.stringify({
            stage: 'gen', engine: ENGINE, nodes: NODES, exit: 'kill',
            writeMs, beforeClose, rssMb: rssMb(),
        }));
        process.kill(process.pid, 'SIGKILL');
    }

    const c0 = Date.now();
    await registry.disposeAll();
    const closeMs = Date.now() - c0;
    console.log(JSON.stringify({
        stage: 'gen', engine: ENGINE, nodes: NODES, exit: 'clean',
        writeMs, closeMs, beforeClose, afterClose: storeSizes(), rssMb: rssMb(),
    }, null, 2));
}

/* ── open — one cold open, RSS at each step ──────────────────────── */
if (stage === 'open') {
    const before = storeSizes();
    const baseline = rssMb();
    const registry = new LocalGraphRegistry({ home: HOME });
    const t0 = Date.now();
    // getGraphHandle opens the SurrealGraph, which is the shape the runtime
    // actually uses.
    const graph = await registry.getGraphHandle('w');
    const afterOpenMb = rssMb();
    const openMs = Date.now() - t0;
    const stats = await graph.getStats();
    const afterStats = rssMb();
    console.log(JSON.stringify({
        stage: 'open', engine: ENGINE,
        walBytesBeforeOpen: before.legacyWalBytes,
        surrealBytesBeforeOpen: before.surrealBytes,
        openMs, baselineRssMb: baseline,
        afterOpenRssMb: afterOpenMb, afterStatsRssMb: afterStats,
        nodes: stats.nodeCount, edges: stats.edgeCount,
        afterOpen: storeSizes(),
    }, null, 2));
    await registry.disposeAll();
}

/* ── sizes — just report on-disk state, opening nothing ──────────── */
if (stage === 'sizes') {
    console.log(JSON.stringify({ stage: 'sizes', ...storeSizes() }, null, 2));
}
