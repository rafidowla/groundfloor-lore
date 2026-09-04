#!/usr/bin/env tsx
/**
 * mvp-scale-e2e.ts — MVP readiness P1b: live-daemon SCALE / perf sanity.
 *
 * STANDALONE PERF JOB — not in the fast gate or run-all-e2e. Loads a large
 * corpus into a real daemon WITH embeddings and measures the numbers that
 * decide "is this fast enough for MVP": load throughput, time to embed the
 * whole corpus, recall-latency percentiles against the FULL vector index, and
 * daemon memory at rest. Default 50k nodes (~20-30 min locally because the
 * in-process embedder runs every vector); override with MVP_SCALE_N.
 *
 *   MVP_SCALE_N=2000 npx tsx test/mvp-scale-e2e.ts   # quick smoke
 *   npx tsx test/mvp-scale-e2e.ts                    # full 50k (slow)
 *
 * Verifies the corpus landed via SAMPLED node-full (not /api/stats, which is
 * known to under-report bulk/registry-routed writes — tracked separately) and
 * via recall actually returning hits.
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { spawnDaemon, waitForReady, fetchAuthToken, cleanup, type DaemonHandle } from './helpers/live-daemon.js';

const N = parseInt(process.env.MVP_SCALE_N ?? '50000', 10);
const BATCH = 1000;
const DRAIN_TIMEOUT_MS = parseInt(process.env.MVP_SCALE_DRAIN_MS ?? String(45 * 60_000), 10);
const RECALL_QUERIES = 40;
const RECALL_P95_BUDGET_MS = parseInt(process.env.MVP_SCALE_RECALL_P95_MS ?? '3000', 10);
const RSS_BUDGET_MB = parseInt(process.env.MVP_SCALE_RSS_MB ?? '4096', 10);

// A few topic categories so the corpus has semantic structure + recall queries
// have something meaningful to retrieve.
const CATS = [
    'database migration and schema evolution',
    'authentication tokens and session security',
    'vector embeddings and semantic retrieval',
    'distributed sync and conflict resolution',
    'incremental backup and disaster recovery',
    'rate limiting and request throttling',
    'graph traversal and relationship queries',
    'observability metrics and structured logging',
];
const QUERIES = [
    'how do we evolve the data model safely',
    'protecting user credentials and login state',
    'finding related notes by meaning not keywords',
    'reconciling edits made on multiple devices',
    'restoring data after a catastrophic failure',
    'preventing clients from overwhelming the service',
    'walking connections between knowledge nodes',
    'measuring system health and tracing requests',
];

let passed = 0;
let failed = 0;

function pct(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}

function daemonRssMb(port: number): number | null {
    try {
        const pid = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8' }).trim().split('\n')[0];
        if (!pid) return null;
        const rssKb = parseInt(execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim(), 10);
        return Number.isFinite(rssKb) ? Math.round(rssKb / 1024) : null;
    } catch { return null; }
}

console.log(`MVP scale E2E — ${N.toLocaleString()} nodes WITH embeddings (perf sanity)`);

async function main(): Promise<void> {
    let h: DaemonHandle | null = null;
    try {
        h = await spawnDaemon();
        assert.ok(await waitForReady(h.port), `daemon never ready\n${h.log.text}`);
        h.token = await fetchAuthToken(h.port, h.home);
        const base = `http://127.0.0.1:${h.port}`;
        const hdr = { Authorization: `Bearer ${h.token}`, Origin: base, 'Content-Type': 'application/json' };
        const get = (p: string) => fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${h!.token}`, Origin: base } });

        // ── Phase 1: load N nodes (embed:queued — producer is fast; the
        //    replicator embeds asynchronously, measured in phase 2) ──────────
        const loadStart = Date.now();
        for (let off = 0; off < N; off += BATCH) {
            const count = Math.min(BATCH, N - off);
            const nodes = Array.from({ length: count }, (_, j) => {
                const i = off + j;
                const cat = CATS[i % CATS.length];
                return { id: `scale-${i}`, type: 'note', label: `note ${i} on ${cat}`, content: `Node ${i}. Topic: ${cat}. Detailed discussion of ${cat} with specifics and rationale.`, tags: `scale,cat${i % CATS.length}` };
            });
            let r: Response;
            let attempt = 0;
            for (;;) {
                r = await fetch(`${base}/api/nodes/bulk`, { method: 'POST', headers: hdr, body: JSON.stringify({ workspace: 'default', nodes, embed: 'queued' }) });
                if (r.status !== 503) break;
                const errBody = await r.json().catch(() => ({})) as { code?: string; retryAfterSeconds?: number };
                if (errBody.code !== 'outbox_lag' || ++attempt > 30) throw new Error(`bulk @${off} failed: 503 ${JSON.stringify(errBody)}`);
                // Server is signaling backpressure (producer outruns the embed pipeline) — back off and
                // retry as any well-behaved client should, rather than treating admission control as fatal.
                const waitS = errBody.retryAfterSeconds ?? 2;
                if (attempt === 1 || attempt % 10 === 0) console.log(`  …outbox lag @${off}, backing off ${waitS}s (attempt ${attempt})`);
                await new Promise((res) => setTimeout(res, waitS * 1000));
            }
            if (r.status !== 200) throw new Error(`bulk @${off} failed: ${r.status} ${await r.text()}`);
            const body = await r.json() as { succeeded?: number };
            if (body.succeeded !== count) throw new Error(`bulk @${off} only ${body.succeeded}/${count} succeeded`);
            if ((off / BATCH) % 10 === 0) console.log(`  …loaded ${off + count}/${N}`);
        }
        const loadMs = Date.now() - loadStart;
        const loadRate = Math.round((N / loadMs) * 1000);
        console.log(`  ✓ load (producer): ${N} nodes in ${(loadMs / 1000).toFixed(1)}s = ${loadRate} nodes/s`);

        // ── Phase 2: wait for the embed pipeline to drain the whole corpus ────
        // FINDING 4 (2026-09-03): /api/health's `outbox` block is now only in
        // the Bearer-authenticated body; an anonymous probe here would read
        // `hb.outbox` as undefined and the `?? 0` fallback would make the
        // loop wrongly declare "drained" on its very first iteration.
        const embedStart = Date.now();
        let depth = Infinity;
        while (Date.now() - embedStart < DRAIN_TIMEOUT_MS) {
            const hb = await (await fetch(`${base}/api/health`, { headers: hdr })).json() as { outbox?: { depth?: number } };
            depth = hb.outbox?.depth ?? 0;
            if (depth === 0) break;
            await new Promise((r) => setTimeout(r, 2000));
        }
        assert.equal(depth, 0, `embed pipeline did not drain within ${(DRAIN_TIMEOUT_MS / 60000)}min (depth=${depth})`);
        const embedMs = Date.now() - embedStart;
        console.log(`  ✓ embed drain: whole corpus embedded in ${(embedMs / 1000).toFixed(1)}s = ${Math.round((N / embedMs) * 1000)} embeds/s`);

        // ── Phase 3: verify the corpus actually landed (sampled node-full) ────
        for (const i of [0, Math.floor(N / 2), N - 1]) {
            const f = await (await get(`/api/node-full?id=${encodeURIComponent(`scale-${i}`)}&workspace=default`)).json() as { found?: boolean };
            assert.equal(f.found, true, `sampled node scale-${i} must be retrievable after load`);
        }
        console.log('  ✓ corpus landed (sampled node-full: first / middle / last all found)');

        // ── Phase 4: recall-latency percentiles against the full vector index ─
        const lat: number[] = [];
        let hitQueries = 0;
        for (let q = 0; q < RECALL_QUERIES; q++) {
            const topic = QUERIES[q % QUERIES.length];
            const t0 = Date.now();
            const rr = await get(`/api/recall?topic=${encodeURIComponent(topic)}&workspace=default`);
            const dt = Date.now() - t0;
            assert.equal(rr.status, 200, `recall must 200 at scale, got ${rr.status}`);
            if (JSON.stringify(await rr.json()).includes('scale-')) hitQueries++;
            lat.push(dt);
        }
        lat.sort((a, b) => a - b);
        const p50 = pct(lat, 50), p95 = pct(lat, 95), p99 = pct(lat, 99);
        console.log(`  ✓ recall latency over ${RECALL_QUERIES} queries: p50=${p50}ms p95=${p95}ms p99=${p99}ms (${hitQueries}/${RECALL_QUERIES} returned hits)`);
        assert.ok(hitQueries >= RECALL_QUERIES * 0.9, `recall returned hits for only ${hitQueries}/${RECALL_QUERIES} queries`);
        assert.ok(p95 <= RECALL_P95_BUDGET_MS, `recall p95 ${p95}ms exceeds budget ${RECALL_P95_BUDGET_MS}ms at ${N} nodes`);

        // ── Phase 5: daemon memory at rest (ADVISORY) ────────────────────────
        // RSS is dominated by the ONNX runtime + embedding model loaded once
        // (~3-4 GB baseline regardless of corpus size), so an absolute ceiling is
        // arbitrary. Report it (and flag if over the soft budget) but don't fail
        // the perf job on it — what matters is that it doesn't grow unbounded
        // with the corpus, which the operator can watch across N values.
        const rss = daemonRssMb(h.port);
        if (rss != null) {
            const flag = rss > RSS_BUDGET_MB ? `  ⚠ over soft budget ${RSS_BUDGET_MB} MB (advisory)` : '';
            console.log(`  ✓ daemon RSS at ${N} nodes: ${rss} MB${flag}`);
        } else {
            console.log('  ⊘ daemon RSS: could not resolve daemon pid (skipped — not fatal)');
        }

        console.log(`\n  PERF SUMMARY @ ${N.toLocaleString()} nodes: load ${loadRate}/s · embed-all ${(embedMs / 1000).toFixed(0)}s · recall p95 ${p95}ms · RSS ${rss ?? '?'}MB`);
        passed = 1;
    } catch (err) {
        failed = 1;
        console.error(`  ✗ ${(err as Error).message}`);
        if (h) console.error(`--- daemon log tail ---\n${h.log.text.slice(-2000)}`);
    } finally {
        cleanup(h);
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

await main();
