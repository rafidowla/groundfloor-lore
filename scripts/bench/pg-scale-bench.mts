#!/usr/bin/env tsx
/**
 * pg-scale-bench.mts - BENCH ONLY (not shipped). Measures a seeded Postgres workspace (see pg-seed-1m.mts) through the
 * real embedded createLore() path, with an injected fake embedder (query embedding is a few microseconds and is
 * reported separately; it is NOT part of any "server side" number).
 *
 *   LORE_PG_URL=... npx tsx scripts/bench/pg-scale-bench.mts --seed-info <root>/seed-info.json --label 100k \
 *       [--phases startup,recall,keyword,rebuild,graph,asof,arrival,delete,batching] [--rebuild-budget-s 600] [--out <dir>]
 *
 * Phases run in the order given. Every phase resets pg_stat_statements first and reports statements per call
 * (count(*) per recall in particular). Results: <out>/results-<label>.json plus a short stdout summary.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { argv, fmt, makeFakeEmbedder, now, openLore, pgWorkspaceKey, summarize, WS_DEFAULT } from './pg-bench-common.mts';
import { clusterCenters, defaultParams, nodeFields, nodeId, queryVector, VOCAB, zipfRank, type CorpusParams } from './pg-corpus.mts';
import { rng } from './pg-bench-common.mts';

const url = process.env['LORE_PG_URL'];
if (!url) { console.error('LORE_PG_URL is required'); process.exit(2); }
const infoPath = argv('seed-info');
if (!infoPath) { console.error('--seed-info <file> is required'); process.exit(2); }
const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as { home: string; ws: string; n: number; dim: number; params: CorpusParams };
const label = argv('label', String(info.n))!;
const phases = (argv('phases', 'startup,recall,keyword,rebuild,graph,asof,arrival,delete,batching')!).split(',');
const outDir = argv('out', path.dirname(infoPath))!;
const budgetS = Number(argv('rebuild-budget-s', '600'));
const ws = info.ws ?? WS_DEFAULT;
// Lore API calls take the workspace NAME (ws); raw SQL filters workspace_id by the permanent id (wsKey, 3.37.0+).
const wsKey = await pgWorkspaceKey(info.home, ws);
const p = info.params;
const centers = clusterCenters(p);
const resultsFile = path.join(outDir, `results-${label}.json`);
const results: Record<string, unknown> = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : {};
const save = () => fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
const log = (m: string) => console.log(`[bench ${label} ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- helpers --------------------------------------------------------------------------------------------------
const pool = new pg.Pool({ connectionString: url, max: 3 });
async function pgssReset(): Promise<void> {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements'); // needs shared_preload_libraries=pg_stat_statements on the server
    await pool.query('SELECT pg_stat_statements_reset()');
}
async function pgssTop(limit = 12): Promise<Array<{ query: string; calls: number; total_ms: number; mean_ms: number; rows: number }>> {
    const r = await pool.query(`SELECT query, calls, total_exec_time AS total_ms, mean_exec_time AS mean_ms, rows FROM pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND query NOT ILIKE '%pg_stat_statements%'
        ORDER BY total_exec_time DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => ({ query: String(x.query).replace(/\s+/g, ' ').slice(0, 220), calls: Number(x.calls), total_ms: Number(x.total_ms), mean_ms: Number(x.mean_ms), rows: Number(x.rows) }));
}
async function countStarCalls(): Promise<{ calls: number; total_ms: number; stmts: string[] }> {
    const r = await pool.query(`SELECT query, calls, total_exec_time FROM pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND query ~* 'count\\(\\*\\)' AND query ~* 'FROM (verbatim|nodes|edges)' AND query NOT ILIKE '%pg_stat_statements%' AND query NOT ILIKE '%pg_class%'`);
    return { calls: r.rows.reduce((a, x) => a + Number(x.calls), 0), total_ms: r.rows.reduce((a, x) => a + Number(x.total_exec_time), 0), stmts: r.rows.map((x) => `${x.calls}x ${String(x.query).replace(/\s+/g, ' ').slice(0, 140)}`) };
}

/** Embedder that places any text at a deterministic point inside the corpus' cluster structure. */
function corpusEmbedder(opts: { batchLatencyMs?: number; perItemMs?: number } = {}) {
    const base = makeFakeEmbedder(p.dim, opts);
    const vec = (t: string) => queryVector(p, centers, t);
    const stats = { batches: 0, items: 0, queryCalls: 0, queryMs: 0 };
    return Object.assign(base, {
        stats,
        async embed(t: string) { return vec(t); },
        async embedQuery(t: string) { const t0 = now(); const v = vec(t); stats.queryCalls++; stats.queryMs += now() - t0; return v; },
        async embedDocument(t: string) { return vec(t); },
        async embedDocumentBatch(ts: string[]) { stats.batches++; stats.items += ts.length; if (opts.batchLatencyMs || opts.perItemMs) await sleep((opts.batchLatencyMs ?? 0) + (opts.perItemMs ?? 0) * ts.length); return ts.map(vec); },
    });
}

// Recall stage timing bag via the logger (LORE_RECALL_STAGE_TIMING=1).
process.env['LORE_RECALL_STAGE_TIMING'] = '1';
const stageBags: Array<Record<string, number>> = [];
const { log: loreLog } = await import('../../packages/lore/src/logger.js');
const origInfo = (loreLog as any).info.bind(loreLog);
(loreLog as any).info = (msg: string, meta?: any) => { if (msg === 'recall_stage_timing' && meta) stageBags.push(meta); else origInfo(msg, meta); };

function queryTexts(): Array<{ kind: string; text: string }> {
    const r = rng(777);
    const out: Array<{ kind: string; text: string }> = [];
    const w = (rank: number) => VOCAB[rank]!;
    for (let i = 0; i < 8; i++) out.push({ kind: 'common-1term', text: w(5 + i * 3) });                       // very frequent token
    for (let i = 0; i < 8; i++) out.push({ kind: 'mid-1term', text: w(400 + Math.floor(r() * 3000)) });        // mid-frequency
    for (let i = 0; i < 8; i++) out.push({ kind: 'rare-1term', text: w(8000 + Math.floor(r() * 11000)) });     // long tail
    for (let i = 0; i < 12; i++) out.push({ kind: 'phrase-3term', text: [0, 1, 2].map(() => w(zipfRank(r()))).join(' ') });
    for (let i = 0; i < 12; i++) out.push({ kind: 'question-8term', text: Array.from({ length: 8 }, () => w(zipfRank(r()))).join(' ') });
    return out;
}

const embedder = corpusEmbedder();
const lore: any = await (async () => {
    const t0 = now();
    const l = await openLore(info.home, info.dim, { linkOnArrival: true }, embedder as never);
    results['startup'] = { open_ms: now() - t0 };
    log(`createLore open: ${fmt(now() - t0)} ms`);
    return l;
})();
const graph = lore.store.loreGraph;

try {
    for (const phase of phases) {
        log(`--- phase ${phase}`);
        if (phase === 'startup') {
            const t0 = now(); await graph.waitForKeywordIndexes(); const t1 = now();
            const stats = await graph.getStats();
            (results['startup'] as any).keyword_indexes_ready_ms = t1 - t0;
            (results['startup'] as any).getStats_ms = now() - t1;
            (results['startup'] as any).stats = stats;
        }

        if (phase === 'recall' || phase === 'recall2') {
            const qs = queryTexts();
            for (const depth of [1]) {
                await pgssReset(); stageBags.length = 0; embedder.stats.queryCalls = 0; embedder.stats.queryMs = 0;
                // pass 0 = first-seen query text (the read cache is cold for it), pass 1 = the same text again (read-cache hit on the keyword leg).
                const perKind: Record<string, number[]> = {}; const all: number[] = []; const repeat: number[] = [];
                for (const pass of [0, 1]) {
                    for (const q of qs) {
                        const t0 = now();
                        const res = await lore.recall(q.text, { workspace: ws, depth, mode: 'summary' });
                        const ms = now() - t0;
                        if (pass === 0) { (perKind[q.kind] ??= []).push(ms); all.push(ms); } else repeat.push(ms);
                        void res;
                    }
                }
                const calls = qs.length * 2;
                const cs = await countStarCalls();
                const stageAvg: Record<string, number> = {};
                for (const b of stageBags) for (const [k, v] of Object.entries(b)) stageAvg[k] = (stageAvg[k] ?? 0) + Number(v) / stageBags.length;
                results[`recall_depth${depth}${phase === 'recall2' ? '_with_links' : ''}`] = {
                    recalls_measured: all.length, first_seen: summarize(all), repeat_query: summarize(repeat), by_kind: Object.fromEntries(Object.entries(perKind).map(([k, v]) => [k, summarize(v)])),
                    stage_avg_ms_incl_cold_pass: stageAvg, count_star_calls_per_recall: cs.calls / calls, count_star_ms_per_recall: cs.total_ms / calls, count_star_statements: cs.stmts,
                    fake_query_embed_ms_total: embedder.stats.queryMs, fake_query_embed_calls: embedder.stats.queryCalls, top_statements: await pgssTop(),
                };
                log(`recall depth${depth}: first-seen p50 ${fmt(summarize(all).p50)} p95 ${fmt(summarize(all).p95)} ms, repeat p50 ${fmt(summarize(repeat).p50)}; count(*)/recall ${cs.calls / calls}`);
            }
        }

        if (phase === 'keyword') {
            // The graph keyword leg alone (what recall's fts-over-nodes leg calls), per term frequency class.
            const qs = queryTexts().filter((q) => q.kind.endsWith('1term') || q.kind === 'phrase-3term');
            await pgssReset();
            const byKind: Record<string, number[]> = {};
            for (const q of qs) { // first-seen text each (the graph read cache is keyed on the query)
                const t0 = now();
                await graph.search(q.text + ' ', 20);
                (byKind[q.kind] ??= []).push(now() - t0);
            }
            results['keyword_leg'] = { by_kind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, summarize(v)])), top_statements: await pgssTop(6) };
            log(`keyword leg: ${JSON.stringify(Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, fmt(summarize(v).p50)])))}`);
        }

        if (phase === 'rebuild') {
            const svc = lore.store.linkService;
            await pgssReset();
            const t0 = now();
            const start = await svc.startRebuild(ws);
            let last = start.state; let budgetHit = false;
            const samples: Array<{ t: number; done: number; inserted: number }> = [];
            for (;;) {
                await sleep(2000);
                last = svc.rebuildStatus(ws) ?? last;
                samples.push({ t: (now() - t0) / 1000, done: last.done, inserted: last.inserted });
                if (last.status !== 'running') break;
                if ((now() - t0) / 1000 > budgetS) { svc.cancelRebuild(ws); budgetHit = true; await sleep(3000); last = svc.rebuildStatus(ws) ?? last; break; }
                if (samples.length % 15 === 0) log(`rebuild ${last.done}/${last.total} inserted ${last.inserted}`);
            }
            const secs = (now() - t0) / 1000;
            const tail = samples.slice(Math.max(0, samples.length - 30));
            const steady = tail.length > 1 ? (tail[tail.length - 1]!.done - tail[0]!.done) / (tail[tail.length - 1]!.t - tail[0]!.t) : NaN;
            results[`rebuild_${budgetHit ? 'partial' : 'full'}`] = {
                wall_s: secs, status: last.status, total: last.total, done: last.done, inserted: last.inserted, refreshed: last.refreshed, invalidated: last.invalidated, unchanged: last.unchanged,
                nodes_per_s: last.done / secs, steady_nodes_per_s_last60s: steady, edges_per_s: last.inserted / secs,
                projected_full_s_at_steady_rate: last.total / steady, budget_hit: budgetHit, top_statements: await pgssTop(8),
            };
            log(`rebuild ${budgetHit ? 'PARTIAL' : 'full'}: ${fmt(secs)} s, ${last.done}/${last.total} nodes, ${last.inserted} edges (${fmt(last.inserted / secs)}/s)`);
        }

        if (phase === 'graph') {
            // Edge count and walk depth 2/3 from nodes that have links.
            const e = await pool.query(`SELECT count(*) AS c FROM edges WHERE workspace_id = $1`, [wsKey]);
            const seeds = (await pool.query(`SELECT id FROM (SELECT DISTINCT n.id FROM nodes n JOIN edges e ON e.workspace_id = n.workspace_id AND e.src_sk = n.sk WHERE n.workspace_id = $1) d ORDER BY md5(id || 'tv') LIMIT 400`, [wsKey])).rows.map((r) => r.id as string);
            const out: Record<string, unknown> = { edges: Number(e.rows[0].c), seeds: seeds.length };
            // traverse() is memoized per (node, depth) in the graph read cache: use disjoint, hash-random seed slices per
            // depth (and a pass-2 repeat) so the cold numbers are real DB walks, not cache hits.
            for (const depth of [1, 2, 3]) {
                await pgssReset(); const ms: number[] = []; const sizes: number[] = [];
                const slice = seeds.slice((depth - 1) * 100, (depth - 1) * 100 + 30);
                for (const id of slice) { const t0 = now(); const r = await graph.traverse(id, depth); ms.push(now() - t0); sizes.push(r.length); }
                out[`traverse_depth${depth}`] = { ...summarize(ms), result_size_mean: sizes.reduce((a, b) => a + b, 0) / sizes.length, top_statements: await pgssTop(3) };
            }
            // recall with depth 2/3 (end to end)
            const qs = queryTexts().filter((_, i) => i % 3 === 0);
            for (const depth of [2, 3]) {
                const ms: number[] = [];
                for (const q of qs) { const t0 = now(); await lore.recall(q.text, { workspace: ws, depth, mode: 'summary' }); ms.push(now() - t0); }
                out[`recall_depth${depth}`] = summarize(ms);
            }
            results['graph_walk'] = out;
            log(`graph: edges ${out['edges']}; traverse d2 p50 ${fmt((out['traverse_depth2'] as any).p50)} d3 p50 ${fmt((out['traverse_depth3'] as any).p50)}`);
        }

        if (phase === 'asof') {
            // Give 25% of nodes a valid-time window so the filter is selective (idempotent, bench-only mutation).
            const t0 = now();
            const upd = await pool.query(`UPDATE nodes SET "validFrom" = to_char("createdAt"::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), valid_from_at = "createdAt"::timestamptz,
                "validUntil" = to_char(("createdAt"::timestamptz + interval '90 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), valid_until_at = "createdAt"::timestamptz + interval '90 days'
                WHERE workspace_id = $1 AND valid_from_at IS NULL AND (sk % 4) = 0`, [wsKey]);
            await pool.query('ANALYZE nodes');
            const { listNodesAsOf } = await import('../../packages/lore/src/core/temporalQuery.js');
            await pgssReset(); const ms: number[] = []; const sizes: number[] = [];
            const ats = ['2026-03-01T00:00:00Z', '2026-06-15T12:00:00Z', '2026-10-01T00:00:00Z'];
            for (let pass = 0; pass < 3; pass++) for (const at of ats) { const t1 = now(); const r = await listNodesAsOf(graph, at, { limit: 100 }); if (pass > 0) { ms.push(now() - t1); sizes.push(r.length); } }
            const ms2: number[] = [];
            for (const at of ats) { const t1 = now(); await listNodesAsOf(graph, at, { limit: 100, type: 'decision' }); ms2.push(now() - t1); }
            results['asof'] = { windowed_rows: upd.rowCount, prep_ms: now() - t0, limit100: summarize(ms), typed_limit100: summarize(ms2), page_sizes: sizes, top_statements: await pgssTop(4) };
            log(`as-of limit100 p50 ${fmt(summarize(ms).p50)} ms (windowed ${upd.rowCount})`);
        }

        if (phase === 'arrival') {
            // Link-on-arrival: per-node cost of nodeUpsert (embedder + graph + verbatim write) and the link pass that follows.
            const svc = lore.store.linkService; const N = 200;
            await pgssReset(); const up: number[] = [];
            const t0 = now();
            for (let i = 0; i < N; i++) {
                const f = nodeFields(p, p.n + 1000 + i);
                const t1 = now();
                await lore.nodeUpsert({ id: `arr${i}`, workspace: ws, ecosystem: '*', nodeData: { id: `arr${i}`, type: f.type, label: f.label, content: f.content, tags: f.tags, project: 'default', ecosystem: '*' } });
                up.push(now() - t1);
            }
            const upsertWall = now() - t0;
            const t2 = now(); await lore.awaitEmbeds?.(); await svc.flush();
            const linkWall = now() - t2;
            const edges = await pool.query(`SELECT count(*) AS c FROM edges e JOIN nodes n ON n.workspace_id=e.workspace_id AND n.sk=e.src_sk WHERE e.workspace_id=$1 AND n.id LIKE 'arr%'`, [wsKey]);
            results['link_on_arrival'] = { nodes: N, upsert: summarize(up), upsert_wall_ms: upsertWall, flush_after_ms: linkWall, per_node_total_ms: (upsertWall + linkWall) / N, edges_from_new_nodes: Number(edges.rows[0].c), stats: svc.stats?.(), top_statements: await pgssTop(8) };
            log(`arrival: upsert p50 ${fmt(summarize(up).p50)} ms, link flush ${fmt(linkWall)} ms for ${N}; per node ${fmt((upsertWall + linkWall) / N)} ms`);
        }

        if (phase === 'delete') {
            const total = Number((await pool.query('SELECT count(*) AS c FROM nodes WHERE workspace_id=$1', [wsKey])).rows[0].c);
            const ids = (await pool.query(`SELECT id FROM nodes WHERE workspace_id=$1 AND id LIKE 'b%' ORDER BY id DESC LIMIT 10000`, [wsKey])).rows.map((r) => r.id as string);
            await pgssReset(); const t0 = now();
            const res = await lore.nodeDeleteMany({ ids, workspace: ws });
            const wall = now() - t0;
            results['delete_10k'] = { requested: ids.length, wall_s: wall / 1000, per_node_ms: wall / ids.length, deleted: res.deleted ?? res.results?.filter((x: any) => x.deleted).length, nodes_before: total, top_statements: await pgssTop(8) };
            log(`delete ${ids.length}: ${fmt(wall / 1000)} s (${fmt(wall / ids.length)} ms/node)`);
        }

        if (phase === 'batching') {
            // Overhead around the provider with a fake provider of fixed per-batch latency (NOT a real model measurement).
            const out: Record<string, unknown> = {};
            for (const [lat, per] of [[0, 0], [50, 0], [200, 0], [0, 5]] as Array<[number, number]>) {
                const emb = corpusEmbedder({ batchLatencyMs: lat, perItemMs: per });
                const texts = Array.from({ length: 2000 }, (_, i) => nodeFields(p, i).content);
                const t0 = now();
                const size = 32;
                for (let i = 0; i < texts.length; i += size) await emb.embedDocumentBatch(texts.slice(i, i + size));
                const wall = now() - t0;
                out[`lat${lat}ms_per${per}ms`] = { items: texts.length, batches: emb.stats.batches, wall_ms: wall, items_per_s: texts.length / (wall / 1000), floor_ms: emb.stats.batches * lat + texts.length * per };
            }
            results['embed_batching_fake_provider'] = out;
        }
        save();
    }
} finally {
    save();
    await lore.dispose();
    await pool.end();
}
log(`results: ${resultsFile}`);
process.exit(0);
void nodeId;
