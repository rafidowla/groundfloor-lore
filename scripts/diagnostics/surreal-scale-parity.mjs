#!/usr/bin/env node
/**
 * surreal-scale-parity.mjs — SurrealDB at REAL scale.
 *
 * Originally a legacy-engine-vs-SurrealDB parity benchmark
 * (docs/SURREALDB_BUILD_PLAN.md Phase 2); the legacy engine was removed from
 * this codebase 2026-08-21 (Phase 3d/3e, see docs/KUZU_REMOVAL.md), so there
 * is no second engine left to compare against. Kept as a standalone
 * SurrealDB scale/throughput/RSS/latency benchmark -- the synthetic-corpus and
 * measurement machinery below still has real value on its own.
 *
 * Scale
 * -----
 * Defaults to 50 000 nodes — this repo's own documented scale target
 * (`test/mvp-scale-e2e.ts`, `MVP_SCALE_N` default). Override with `--nodes N`.
 *
 * NOTHING under LORE_HOME is read or written. Generates a synthetic corpus at
 * the given NODE COUNT rather than opening a real workspace.
 *
 * Isolation
 * ---------
 * Runs in its OWN child process, so the RSS figure is the engine plus a bare
 * Node runtime and nothing else. Deliberately NO embedding model and NO
 * daemon: `mvp-scale-e2e` reports ~3-4 GB of ONNX runtime baseline that would
 * swamp the graph-engine number being measured here.
 *
 * Reported: load throughput, steady-state RSS after load, RSS after a read
 * workload, and p50/p95 latency for getNode, search, 1/3/5-hop traverse,
 * listNodes, and getStats.
 *
 * Usage:
 *   node scripts/diagnostics/surreal-scale-parity.mjs
 *   node scripts/diagnostics/surreal-scale-parity.mjs --nodes 5000
 *   node scripts/diagnostics/surreal-scale-parity.mjs --accel
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..');

/* ─── args ───────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
};
const NODES = Number.parseInt(argOf('--nodes', '50000'), 10);
const EDGES_PER_NODE = Number.parseInt(argOf('--edges-per-node', '2'), 10);
const BATCH = 1000;
const QUERY_SAMPLES = 200;

/* ─── synthetic corpus ───────────────────────────────────────────── */

const TYPES = ['decision', 'convention', 'architecture', 'bug_pattern', 'note'];
const TOPICS = ['auth', 'billing', 'search', 'storage', 'sync', 'ingest', 'schema', 'recall'];

/**
 * A node with realistic bulk: ~1 KB of content, a handful of tags, real
 * metadata JSON. An empty-ish fixture would understate memory and overstate
 * throughput.
 */
function makeNode(i) {
    const topic = TOPICS[i % TOPICS.length];
    return {
        id: `scale-node-${i}`,
        type: TYPES[i % TYPES.length],
        label: `${topic} decision ${i}`,
        content:
            `This node records the ${topic} decision number ${i}. `
            + `It exists to give the corpus realistic byte weight per row so that memory and `
            + `scan-latency numbers reflect something like production content rather than an `
            + `empty fixture. Cross-reference: node ${Math.max(0, i - 1)} and node ${i + 1}. `.repeat(6),
        tags: `${topic},scale,batch-${Math.floor(i / BATCH)}`,
        project: `project-${i % 8}`,
        ecosystem: 'scale',
        metadata: JSON.stringify({ seq: i, topic, generated: true }),
    };
}

/* ─── child mode: run SurrealGraph, print a JSON result line ─────── */

if (argv[0] === '--child') {
    const engine = argv[1]; // always 'surreal' or an --accel variant label
    const dir = argv[2];
    const nodes = Number.parseInt(argv[3], 10);
    const edgesPerNode = Number.parseInt(argv[4], 10);

    const rssMb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
    const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    const time = async (fn) => {
        const t0 = performance.now();
        await fn();
        return performance.now() - t0;
    };

    const { SurrealGraph } = await import('../../packages/lore/src/engines/surrealGraph.ts');
    const graph = new SurrealGraph(dir, { workspaceId: 'scale', cacheDisabled: true });

    const rssBaseline = rssMb();
    await graph.initialize();
    const rssAfterOpen = rssMb();

    // ── load ──
    const loadStart = performance.now();
    for (let start = 0; start < nodes; start += BATCH) {
        const batch = [];
        for (let i = start; i < Math.min(start + BATCH, nodes); i++) batch.push(makeNode(i));
        await graph.bulkUpsertNodes(batch);
    }
    const loadMs = performance.now() - loadStart;

    // ── edges: a connected chain plus fan-out, so traversal has real work ──
    const edgeStart = performance.now();
    let edgeCount = 0;
    for (let i = 0; i + 1 < nodes; i++) {
        await graph.addEdge({ sourceId: `scale-node-${i}`, targetId: `scale-node-${i + 1}`, relation: 'next' });
        edgeCount++;
        for (let f = 1; f < edgesPerNode; f++) {
            const target = (i + f * 977) % nodes; // stride keeps the fan-out non-local
            if (target === i) continue;
            await graph.addEdge({ sourceId: `scale-node-${i}`, targetId: `scale-node-${target}`, relation: 'refs' });
            edgeCount++;
        }
    }
    const edgeMs = performance.now() - edgeStart;
    const rssAfterLoad = rssMb();

    // ── read workload ──
    const samples = { getNode: [], search: [], traverse1: [], traverse3: [], traverse5: [], listNodes: [], getStats: [] };
    for (let i = 0; i < QUERY_SAMPLES; i++) {
        const id = `scale-node-${(i * 7919) % nodes}`;
        samples.getNode.push(await time(() => graph.getNode(id)));
    }
    for (let i = 0; i < QUERY_SAMPLES; i++) {
        samples.search.push(await time(() => graph.search(TOPICS[i % TOPICS.length], 20)));
    }
    for (const [key, depth] of [['traverse1', 1], ['traverse3', 3], ['traverse5', 5]]) {
        for (let i = 0; i < Math.min(QUERY_SAMPLES, 50); i++) {
            const id = `scale-node-${(i * 4523) % nodes}`;
            samples[key].push(await time(() => graph.traverse(id, depth)));
        }
    }
    for (let i = 0; i < 20; i++) samples.listNodes.push(await time(() => graph.listNodes(TYPES[i % TYPES.length], undefined, '*', '*', 100)));
    for (let i = 0; i < 20; i++) samples.getStats.push(await time(() => graph.getStats()));

    const rssAfterReads = rssMb();
    const stats = await graph.getStats();
    await graph.close();

    const latency = {};
    for (const [key, values] of Object.entries(samples)) {
        const sorted = [...values].sort((a, b) => a - b);
        latency[key] = {
            p50: Number(percentile(sorted, 0.5).toFixed(3)),
            p95: Number(percentile(sorted, 0.95).toFixed(3)),
        };
    }

    process.stdout.write('RESULT ' + JSON.stringify({
        engine,
        nodes,
        edges: edgeCount,
        counted: { nodeCount: stats.nodeCount, edgeCount: stats.edgeCount },
        loadNodesPerSec: Math.round((nodes / loadMs) * 1000),
        loadEdgesPerSec: Math.round((edgeCount / edgeMs) * 1000),
        rss: { baseline: rssBaseline, afterOpen: rssAfterOpen, afterLoad: rssAfterLoad, afterReads: rssAfterReads },
        diskMb: Math.round(dirSizeBytes(dir) / 1024 / 1024),
        latency,
    }) + '\n');
    process.exit(0);
}

/** Recursive on-disk size — the store's footprint, not just the top file. */
function dirSizeBytes(dir) {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) total += dirSizeBytes(abs);
        else if (entry.isFile()) { try { total += fs.statSync(abs).size; } catch { /* raced */ } }
    }
    return total;
}

/* ─── parent: run each leg in its own process ─────────────────────── */

/**
 * Run one leg and return its result.
 *
 * The child is killed as soon as it has emitted its RESULT line rather than
 * waited on: with `LORE_SURREAL_DEFINE_INDEXES=1` the SurrealDB driver leaks a
 * libuv handle from the index build and the child NEVER exits (see
 * engines/surreal/surrealConnection.ts). The measurement is complete by then,
 * so waiting would only hang the benchmark.
 */
async function runLeg(leg, env = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lore-scale-${leg}-`));
    try {
        const child = spawn(
            process.execPath,
            ['--import', 'tsx', SELF, '--child', leg, dir, String(NODES), String(EDGES_PER_NODE)],
            { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        let stderr = '';
        const { promise, resolve } = Promise.withResolvers();
        child.stdout.on('data', (c) => {
            stdout += c.toString();
            if (stdout.includes('RESULT ')) resolve('result');
        });
        child.stderr.on('data', (c) => { stderr += c.toString(); });
        child.once('exit', (code) => resolve(`exit:${code}`));
        const how = await promise;
        if (how === 'result') { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
        const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
        if (!line) throw new Error(`no result from ${leg} (${how})\n${stderr.slice(-2000)}`);
        return JSON.parse(line.slice('RESULT '.length));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n) => String(v).padStart(n);

console.log(`SurrealDB at scale — ${NODES.toLocaleString()} nodes, ~${EDGES_PER_NODE} edges/node`);
console.log(`node ${process.versions.node} · ${process.platform}/${process.arch} · ${os.cpus().length} cores · ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB RAM`);
console.log('each leg runs in its OWN process — no embedder, no daemon\n');

/**
 * Legs to run.
 *
 * `surreal` is the shipping default (count view OFF as of 2026-08-21, no
 * indexes). `--accel` adds the opt-in variants so the report shows what each
 * one actually buys rather than what it is hoped to buy:
 *   `surreal+view`   — count view ON (correctness risk under concurrent
 *                      same-group writers — see LORE_SURREAL_COUNT_VIEW).
 *   `surreal+fts`    — full-text search ON (behaviour-changing; see
 *                      test/surreal-feature-matrix-unit.ts).
 *   `surreal+idx`    — secondary B-tree indexes ON.
 */
const ACCEL_LEGS = [
    ['surreal+view', { LORE_SURREAL_COUNT_VIEW: '1' }],
    ['surreal+fts', { LORE_SURREAL_FTS: '1' }],
    ['surreal+idx', { LORE_SURREAL_DEFINE_INDEXES: '1' }],
];
const LEGS = argv.includes('--accel') ? [['surreal', {}], ...ACCEL_LEGS] : [['surreal', {}]];

const results = {};
for (const [leg, env] of LEGS) {
    process.stdout.write(`  running ${leg}… `);
    const startedAt = Date.now();
    try {
        results[leg] = await runLeg(leg, env);
        console.log(`done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    } catch (err) {
        console.log('FAILED');
        console.log(`    ${err.message}`);
    }
}

console.log('');
for (const [leg, r] of Object.entries(results)) {
    console.log(`── ${leg} ─────────────────────────────────────────`);
    console.log(`  loaded                 ${r.counted.nodeCount.toLocaleString()} nodes / ${r.counted.edgeCount.toLocaleString()} edges`);
    console.log(`  load throughput        ${r.loadNodesPerSec.toLocaleString()} nodes/s · ${r.loadEdgesPerSec.toLocaleString()} edges/s`);
    console.log(`  RSS baseline→open      ${r.rss.baseline} → ${r.rss.afterOpen} MB`);
    console.log(`  RSS after load         ${r.rss.afterLoad} MB`);
    console.log(`  RSS after reads        ${r.rss.afterReads} MB`);
    console.log(`  on-disk                ${r.diskMb} MB`);
    for (const [op, l] of Object.entries(r.latency)) {
        console.log(`  ${pad(op, 22)} p50 ${num(l.p50, 8)} ms   p95 ${num(l.p95, 8)} ms`);
    }
    console.log('');
}

process.exit(0);
