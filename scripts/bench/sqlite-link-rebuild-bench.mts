#!/usr/bin/env tsx
/**
 * sqlite-link-rebuild-bench.mts - BENCH ONLY (not shipped). SQLite counterpart of the pg-scale-bench rebuild phase,
 * used by lane f3 to compare LORE_LINK_REBUILD_IDLE_YIELD_MS (rebuildIdleYieldMs) 10 vs 200 on a real SQLite workspace.
 *
 *   seed : npx tsx scripts/bench/sqlite-link-rebuild-bench.mts seed --n 100000 --root <dir> [--dim 384]
 *   run  : npx tsx scripts/bench/sqlite-link-rebuild-bench.mts run --root <dir> --idle-ms 10 --label a1
 *            [--budget-s 60] [--writers none|raw|api] [--out <file.jsonl>]
 *
 * `run` copies the seeded template to a fresh dir, opens createLore (embedded, SQLite graph + vectors, fake embedder),
 * starts the Loop C rebuild and polls it for <budget-s>, then cancels. While it runs, an optional writer loop does
 * small upserts and records per-call latency:
 *   raw : graph.bulkUpsertNodes([one node]) every 20 ms - pure SQLite write-lock contention, no link queue / embed work.
 *   api : lore.nodeUpsert(...) every 100 ms - the real write path (also feeds the embed queue and link queue, i.e. it
 *         makes the host genuinely busy, which is what the busy signal is meant to see).
 * One JSON line per run is appended to --out.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { argv, makeFakeEmbedder, openLore, summarize, now } from './pg-bench-common.mts';
import { defaultParams, nodeFields, nodeVector, clusterCenters, verbatimText, contentHash, nodeId } from './pg-corpus.mts';

const mode = process.argv[2];
const root = argv('root');
if (!root || (mode !== 'seed' && mode !== 'run')) { console.error('usage: seed|run --root <dir> ...'); process.exit(2); }
const WS = 'sqbench';
const dim = Number(argv('dim', '384'));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[sqbench ${new Date().toISOString().slice(11, 19)}] ${m}`);

function writeWorkspaces(home: string): string {
    const wsPath = path.join(home, 'workspaces', WS);
    fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        version: 1, active: WS,
        workspaces: [{ name: WS, path: wsPath, graphEngine: 'sqlite', vectorEngine: 'sqlite', createdAt: new Date().toISOString() }],
    }));
    return wsPath;
}

if (mode === 'seed') {
    const n = Number(argv('n', '100000'));
    const p = defaultParams(n, dim);
    const home = path.join(root, 'template');
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { recursive: true });
    writeWorkspaces(home);
    const fake = makeFakeEmbedder(dim);
    {
        const lore = await openLore(home, dim, {}, fake);
        const f = nodeFields(p, 0);
        await lore.nodeUpsert({ id: f.id, workspace: WS, ecosystem: '*', nodeData: { id: f.id, type: f.type, label: f.label, content: f.content, tags: f.tags, project: 'default', ecosystem: '*' } });
        await lore.awaitEmbeds?.();
        await lore.dispose();
    }
    const lore = await openLore(home, dim, {}, fake);
    const graph = lore.store.loreGraph, verb = lore.store.loreVerbatim;
    const centers = clusterCenters(p);
    const t0 = now();
    const B = 1000;
    for (let from = 1; from < n; from += B) {
        const to = Math.min(n, from + B);
        const nodes: any[] = [], rows: any[] = [];
        for (let i = from; i < to; i++) {
            const f = nodeFields(p, i);
            nodes.push({ id: f.id, type: f.type, label: f.label, content: f.content, tags: f.tags, project: 'default', ecosystem: '*' });
            const text = verbatimText(f);
            rows.push({ id: `lore:${f.id}`, text, vector: nodeVector(p, centers, i, f.cluster), contentHash: contentHash(text), type: f.type, label: f.label, tags: f.tags.join(','), project: 'default', ecosystem: '*', updatedAt: f.updatedAt });
        }
        const out = await graph.bulkUpsertNodes(nodes);
        const bad = out.filter((o: any) => !o.ok);
        if (bad.length) throw new Error(`bulkUpsertNodes failed: ${JSON.stringify(bad.slice(0, 2))}`);
        await verb.bulkAddPrebuiltRows(rows);
        if ((from / B) % 20 === 0) log(`seeded ${to}/${n} (${((now() - t0) / 1000).toFixed(0)} s)`);
    }
    const stats = await graph.getStats();
    await lore.dispose();
    fs.writeFileSync(path.join(root, 'seed-info.json'), JSON.stringify({ home, n, dim, params: p, stats, seed_s: (now() - t0) / 1000 }, null, 2));
    log(`seed done in ${((now() - t0) / 1000).toFixed(0)} s; stats=${JSON.stringify(stats).slice(0, 200)}`);
    process.exit(0);
}

// ---- run ----
const info = JSON.parse(fs.readFileSync(path.join(root, 'seed-info.json'), 'utf8')) as { home: string; n: number; dim: number; params: any };
const idleMs = Number(argv('idle-ms', '10'));
const label = argv('label', `idle${idleMs}`)!;
const budgetS = Number(argv('budget-s', '60'));
const writers = argv('writers', 'none')!;
const outFile = argv('out', path.join(root, 'results.jsonl'))!;
const uptime = () => execSync('uptime').toString().trim().replace(/^.*load averages?: /, '');

const runHome = fs.mkdtempSync(path.join(root, `run-${label}.`));
fs.cpSync(info.home, runHome, { recursive: true });
writeWorkspaces(runHome); // rewrites the absolute workspace path to this copy (workspaces.json path fields win over dataDir)

const loadBefore = uptime();
const embedder = makeFakeEmbedder(info.dim);
const lore = await openLore(runHome, info.dim, {
    linkOnArrival: { enabled: true, rebuildYieldMs: 200, rebuildIdleYieldMs: idleMs },
}, embedder);
const svc = lore.store.linkService;
const graph = lore.store.loreGraph;
const lat: number[] = [];
const lag: number[] = []; // event-loop scheduling delay of the writer's timer = how long a request arriving now waits before the loop serves it
const e2e: number[] = [];
let stop = false;
let wcount = 0;
const writer = async () => {
    const p = info.params;
    while (!stop) {
        const k = wcount++;
        const f = nodeFields(p, 900_000 + k);
        const interval = writers === 'raw' ? 20 : 100;
        const due = now() + interval;
        await sleep(interval);
        const late = now() - due; lag.push(late);
        const t0 = now();
        try {
            if (writers === 'raw') await graph.bulkUpsertNodes([{ id: `w${k}`, type: 'note', label: f.label, content: f.content, tags: [], project: 'default', ecosystem: '*' }]);
            else await lore.nodeUpsert({ id: `w${k}`, workspace: WS, ecosystem: '*', nodeData: { id: `w${k}`, type: 'note', label: f.label, content: f.content, tags: [], project: 'default', ecosystem: '*' } });
            lat.push(now() - t0); e2e.push(late + (now() - t0));
        } catch (e) { lat.push(Number.NaN); log(`write error: ${(e as Error).message}`); }
    }
};

let result: Record<string, unknown> = {};
try {
    const noRebuild = argv('no-rebuild') !== undefined;
    const wp = writers !== 'none' ? writer() : Promise.resolve();
    const t0 = now();
    let last: any = null; let budgetHit = false;
    if (!noRebuild) {
        const start = await svc.startRebuild(WS);
        last = start.state;
        for (;;) {
            await sleep(1000);
            last = svc.rebuildStatus(WS) ?? last;
            if (last.status !== 'running') break;
            if ((now() - t0) / 1000 > budgetS) { svc.cancelRebuild(WS); budgetHit = true; await sleep(2000); last = svc.rebuildStatus(WS) ?? last; break; }
        }
    } else {
        await sleep(budgetS * 1000);
    }
    const secs = (now() - t0) / 1000;
    stop = true; await wp;
    const rb = svc.stats?.()?.rebuild;
    const clean = lat.filter((x) => Number.isFinite(x));
    result = {
        label, idleMs, writers, budgetS, wall_s: secs, budget_hit: budgetHit,
        rebuild: last ? { status: last.status, total: last.total, done: last.done, inserted: last.inserted, nodes_per_s: last.done / secs } : null,
        rebuild_stats: rb ?? null,
        writes: clean.length ? { ...summarize(clean), errors: lat.length - clean.length, per_s: clean.length / secs } : null,
        sched_lag_ms: lag.length ? summarize(lag) : null,
        write_e2e_ms: e2e.length ? summarize(e2e) : null,
        uptime_before: loadBefore, uptime_after: uptime(),
    };
} finally {
    stop = true;
    try { await lore.dispose(); } catch { /* ignore */ }
    fs.rmSync(runHome, { recursive: true, force: true });
}
fs.appendFileSync(outFile, JSON.stringify(result) + '\n');
log(JSON.stringify(result));
process.exit(0);
