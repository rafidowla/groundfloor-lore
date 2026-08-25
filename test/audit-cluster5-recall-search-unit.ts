#!/usr/bin/env tsx
/**
 * audit-cluster5-recall-search-unit.ts — Cluster 5a regression tests
 * (REMEDIATION-PLAN-2026-08-17-functional-correctness.md, findings 5.1–5.4
 * plus the keyword-phrase / full-mode-tokenMeta / empty-full-mode items).
 *
 * Every recall scenario drives the REAL MCP `recall` tool handler
 * (registerSearchTools over a stub server) over a REAL SurrealGraph
 * (embedded SurrealDB) — only the vector store is mocked (a ranked id list
 * honouring the requested fetch limit), which is exactly the seam the
 * findings' repros manipulated with real embeddings: WHO ranks where in the
 * seed window.

 *   5.1  vector-seeded recall must UNION the keyword scan (nodes with no
 *        verbatim row are reachable through the default recall path).
 *   5.2  recall(tags:[...]) applies the tag predicate BEFORE the top-limit
 *        slice, over the whole over-fetched seed window.
 *   5.3  hidden-row starvation: adaptive over-fetch rescues a live node
 *        outranked by >seedFetch archived rows; a still-starved FULL window
 *        raises _meta.possible_starvation instead of confident absence.
 *   5.4  re-rank uses the REAL similarity score and a bounded recency
 *        nudge — a node at similarity 0.928 aged many half-lives still
 *        outranks 0.75 same-day filler (both the retrieve() path and the
 *        shared rankScore the cross-workspace path uses).
 *   med  keyword search is AND-of-significant-terms, not whole-phrase
 *        substring (SurrealGraph).
 *
 *   med  mode:'full' carries tokenMeta (truncated/dropped_count/
 *        total_matched) in _meta.
 *   low  an empty recall in mode:'full' keeps the full-mode shape.
 *
 * Run: npx tsx test/audit-cluster5-recall-search-unit.ts   (Node 22)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { registerSearchTools } from '../packages/lore/src/mcp/tools/search.js';
import { rankScore } from '../packages/lore/src/recall/ranking.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

type ToolHandler = (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

/** Wire the REAL search/recall MCP tools over a stub server, exactly as the
 *  daemon registers them. `storageClient` is the mocked vector store seam. */
function wireTools(graph: SurrealGraph, storageClient: Record<string, unknown>): Record<string, ToolHandler> {
    const tools: Record<string, ToolHandler> = {};
    const mcpServerStub = {
        tool: (name: string, ...rest: unknown[]) => {
            const handler = rest[rest.length - 1];
            if (typeof handler === 'function') tools[name] = handler as ToolHandler;
        },
    };
    registerSearchTools(mcpServerStub as never, {
        store: {
            loreGraph: graph,
            storageClient: storageClient as never,
            loreVerbatim: { store: async () => undefined } as never,
            sessionCache: { pushNode: () => undefined } as never,
        } as never,
        // ecosystem '*' = the DEFAULT scope (the finding's "ordinary recall"):
        // the old confinement fall-through was gated on ecosystemScope !== '*'
        // and therefore never fired on this path.
        detectedScope: { workspace: 'wsA', ecosystem: '*' },
        graphRegistry: { getOrOpen: async () => graph, getGraphHandle: async () => graph } as never,
        nodeTypesEnum: z.enum(['note', 'decision']),
        edgeRelationsEnum: z.enum(['related_to']),
    } as never);
    return tools;
}

/** Mocked verbatim store: a fixed ranked list, honouring the requested
 *  window size (like the real ANN top-K). BM25 returns a bare array, which
 *  readBm25Envelope fail-closed reads as UNRANKED → excluded from fusion, so
 *  the semantic window alone decides seed order (deterministic). */
function mockVectorStore(ranked: Array<{ id: string; score: number }>): Record<string, unknown> {
    return {
        async verbatimCount() { return ranked.length; },
        async verbatimSearch(_q: string, n: number) {
            return ranked.slice(0, n).map((h) => ({ id: h.id, score: h.score, text: 'mock' }));
        },
        async verbatimBm25Search() { return []; },
    };
}

async function putNode(
    g: SurrealGraph,
    id: string,
    content: string,
    extra: Record<string, unknown> = {},
): Promise<void> {
    await g.upsertNode({
        id, type: 'note', label: id, content, tags: [],
        project: 'wsA', ecosystem: '*', metadata: '{}', language: null,
        ephemeral: false, ttl_ms: null, ...extra,
    } as never);
}

async function recallIds(
    tools: Record<string, ToolHandler>,
    args: Record<string, unknown>,
): Promise<{ ids: string[]; body: Record<string, unknown> }> {
    const out = await tools['recall']!({ workspace: 'wsA', ...args });
    const body = JSON.parse(out.content[0]!.text) as Record<string, unknown>;
    const hits = (body.hits ?? []) as Array<{ id?: string }>;
    return { ids: hits.map((h) => h.id ?? ''), body };
}

/* ═══ 5.1 — keyword supplement unioned into vector-seeded recall ═══ */
await test('5.1: node with NO verbatim row is reachable via the keyword supplement on a populated vector index', async () => {
    const dir = tmpDir('c5-51-');
    const g = new SurrealGraph(dir, { workspaceId: 'wsA', cacheDisabled: true });
    try {
        await g.initialize();
        await putNode(g, 'vec-seed', 'notes on the quixotic zebra protocol from the vector side');
        // graph-only has NO verbatim row (the mock never returns it) — the
        // embed:false / failed-embed shape from the finding.
        await putNode(g, 'graph-only', 'the quixotic zebra handshake lives only in the graph');

        const tools = wireTools(g, mockVectorStore([{ id: 'lore:vec-seed', score: 0.9 }]));
        const { ids } = await recallIds(tools, { topic: 'quixotic zebra', depth: 0 });

        assert.ok(ids.includes('vec-seed'), `vector seed must survive the union; got ${JSON.stringify(ids)}`);
        assert.ok(ids.includes('graph-only'),
            `keyword supplement must surface the no-verbatim node on the DEFAULT ('*') scope; got ${JSON.stringify(ids)}`);
    } finally {
        await g.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* ═══ 5.2 — tags filter applies before the top-limit slice ═══ */
await test('5.2: recall(tags) finds a genuinely tag-matching node ranked outside the raw top-10 (25 fillers above it)', async () => {
    const dir = tmpDir('c5-52-');
    const g = new SurrealGraph(dir, { workspaceId: 'wsA', cacheDisabled: true });
    try {
        await g.initialize();
        const ranked: Array<{ id: string; score: number }> = [];
        // The finding's live repro: 25 untagged topically-strong fillers…
        for (let i = 0; i < 25; i++) {
            await putNode(g, `fill${i}`, `Kafka consumer lag monitoring and rebalance tuning, note ${i}`);
            ranked.push({ id: `lore:fill${i}`, score: 0.99 - i * 0.01 });
        }
        // …and ONE tagged genuine match ranked 26th. Its text deliberately
        // shares NO query terms, so only the over-fetch window + pre-slice
        // tag filter can surface it (the keyword supplement cannot).
        await putNode(g, 'k-tagged', 'Topic retention is seven days for the audit stream.', { tags: ['keepme'] });
        ranked.push({ id: 'lore:k-tagged', score: 0.5 });

        const tools = wireTools(g, mockVectorStore(ranked));

        // Control: unfiltered recall returns the top fillers (window works).
        const control = await recallIds(tools, { topic: 'kafka consumer lag', depth: 0 });
        assert.equal(control.ids.length, 10);
        assert.ok(!control.ids.includes('k-tagged'), 'control: tagged node ranks outside the raw top-10');

        // The bug: tag filter ran AFTER the top-10 slice → 0 hits + false
        // "no stored memory" negative_evidence.
        const { ids, body } = await recallIds(tools, { topic: 'kafka consumer lag', depth: 0, tags: ['keepme'] });
        assert.deepEqual(ids, ['k-tagged'], `tag-filtered recall must find the tagged node; got ${JSON.stringify(ids)}`);
        const meta = body._meta as { negative_evidence?: string } | undefined;
        // The finding's false claim was "the topic has no stored memory yet";
        // a low-similarity note on a FOUND hit is legitimate.
        assert.ok(!/no stored memory yet/.test(meta?.negative_evidence ?? ''),
            `no false absence claim when the tagged node was found; got: ${meta?.negative_evidence}`);
    } finally {
        await g.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* ═══ 5.3 — hidden-row starvation: adaptive over-fetch + honest signal ═══ */
await test('5.3a: 45 archived rows outranking 1 live node no longer starve it out (adaptive over-fetch)', async () => {
    const dir = tmpDir('c5-53a-');
    const g = new SurrealGraph(dir, { workspaceId: 'wsA', cacheDisabled: true });
    try {
        await g.initialize();
        const ranked: Array<{ id: string; score: number }> = [];
        for (let i = 0; i < 45; i++) {
            await putNode(g, `ar${i}`, `Redis cache eviction policy allkeys-lru revision ${i}`, { status: 'archived' });
            ranked.push({ id: `lore:ar${i}`, score: 0.99 - i * 0.001 });
        }
        // The finding's live node: healthy, topically strong (verbatimSearch
        // scored it 0.950 live), but 46th in the window — past the old fixed
        // 4×10=40 over-fetch. Its text lacks 'policy', so the keyword
        // supplement cannot rescue it: only the adaptive re-fetch can.
        await putNode(g, 'live1', 'Redis eviction is now volatile-ttl for the session cache.');
        ranked.push({ id: 'lore:live1', score: 0.95 });

        const tools = wireTools(g, mockVectorStore(ranked));
        const { ids, body } = await recallIds(tools, { topic: 'redis cache eviction policy', depth: 0 });

        assert.deepEqual(ids, ['live1'], `the live node must surface despite 45 archived rows above it; got ${JSON.stringify(ids)}`);
        const meta = body._meta as { possible_starvation?: boolean; negative_evidence?: string };
        assert.ok(!meta.possible_starvation, 'starvation flag must NOT be set when the retry recovered the live node');
        assert.ok(!meta.negative_evidence, 'no absence claim when the live node was found');

        // The finding's control: include_archived surfaces the archived rows.
        const withArchived = await recallIds(tools, { topic: 'redis cache eviction policy', depth: 0, include_archived: true });
        assert.equal(withArchived.ids.length, 10, 'include_archived returns a full window of archived rows');
        assert.ok(withArchived.ids.every((id) => id.startsWith('ar')), 'control window is all archived rows');
    } finally {
        await g.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('5.3b: a still-full starved window at the over-fetch cap raises possible_starvation, not confident absence', async () => {
    const dir = tmpDir('c5-53b-');
    const g = new SurrealGraph(dir, { workspaceId: 'wsA', cacheDisabled: true });
    try {
        await g.initialize();
        // 170 archived rows > the 160-row adaptive cap (limit 10 × 16), with
        // the live node ranked last — unreachable by any bounded window.
        const ranked: Array<{ id: string; score: number }> = [];
        for (let i = 0; i < 170; i++) {
            await putNode(g, `ar${i}`, `Redis cache eviction policy allkeys-lru revision ${i}`, { status: 'archived' });
            ranked.push({ id: `lore:ar${i}`, score: 0.99 - i * 0.0001 });
        }
        await putNode(g, 'live1', 'Redis eviction is now volatile-ttl for the session cache.');
        ranked.push({ id: 'lore:live1', score: 0.5 });

        const tools = wireTools(g, mockVectorStore(ranked));
        const { ids, body } = await recallIds(tools, { topic: 'redis cache eviction policy', depth: 0 });

        assert.equal(ids.length, 0, 'live node beyond the bounded window is not returned (bound held)');
        const meta = body._meta as { possible_starvation?: boolean; negative_evidence?: string };
        assert.equal(meta.possible_starvation, true, 'starved full window must raise possible_starvation');
        assert.ok(meta.negative_evidence, 'starved empty result must carry an explanation');
        assert.ok(!/no stored memory yet/.test(meta.negative_evidence ?? ''),
            `must NOT claim authoritative absence while starved; got: ${meta.negative_evidence}`);
        assert.ok(/starved/.test(meta.negative_evidence ?? ''), 'explanation names the starvation');
    } finally {
        await g.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* ═══ 5.4 — re-rank: real similarity + bounded recency nudge ═══ */
await test('5.4: a much stronger semantic match aged many half-lives still outranks same-day filler', async () => {
    const dir = tmpDir('c5-54-');
    const g = new SurrealGraph(dir, { workspaceId: 'wsA', cacheDisabled: true });
    // The finding compressed time with LORE_RECALL_RECENCY_HALF_LIFE_DAYS so
    // real seconds stand in for months — same trick: 50ms half-life, so the
    // 600ms sleep below ages TARGET by 12 half-lives (≈ a year at the default
    // 30-day half-life). Only the age/half-life ratio enters the formula.
    const PREV_HL = process.env.LORE_RECALL_RECENCY_HALF_LIFE_DAYS;
    process.env.LORE_RECALL_RECENCY_HALF_LIFE_DAYS = String(0.05 / 86400);
    try {
        await g.initialize();
        // The finding's repro corpus: one clearly-best answer…
        await putNode(g, 'TARGET-decision', 'We decided the postgres connection pool size limit is 40 connections per node, after benchmarking.');
        await sleep(600); // TARGET ages ~12 half-lives
        // …then a dozen fresh same-day trivia fillers.
        const trivia = ['coffee machine roster', 'bike shed colour vote', 'lunch rota draft', 'parking lottery',
            'office plant watering', 'keyboard fundraiser', 'standing desk lottery', 'fridge etiquette notice',
            'holiday party planning', 'whiteboard marker count', 'desk fan schedule', 'snack budget thread'];
        const ranked: Array<{ id: string; score: number }> = [{ id: 'lore:TARGET-decision', score: 0.928 }];
        for (let i = 0; i < trivia.length; i++) {
            await putNode(g, `f${i}`, `Office trivia: ${trivia[i]}.`);
            ranked.push({ id: `lore:f${i}`, score: 0.75 - i * 0.005 });
        }

        const tools = wireTools(g, mockVectorStore(ranked));
        const { ids, body } = await recallIds(tools, {
            topic: 'what did we decide about the postgres connection pool size limit', depth: 0,
        });

        assert.equal(ids[0], 'TARGET-decision',
            `the 0.928-similarity answer must rank first regardless of age; got ${JSON.stringify(ids)}`);
        const meta = body._meta as { top_score?: number; confidence?: number };
        assert.equal(meta.top_score, 0.928, 'top_score reports the REAL best similarity, not the best SURVIVOR');
        assert.equal(meta.confidence, 1.0, 'confidence reflects the real top score');

        // The finding's control: ranking OFF already returned TARGET first —
        // confirm the escape hatch still does (raw baseScore ordering).
        process.env.LORE_RECALL_RANKING = 'off';
        try {
            const off = await recallIds(tools, { topic: 'postgres connection pool', depth: 0 });
            assert.equal(off.ids[0], 'TARGET-decision', 'ranking-off control orders by raw similarity');
        } finally {
            delete process.env.LORE_RECALL_RANKING;
        }
    } finally {
        if (PREV_HL === undefined) delete process.env.LORE_RECALL_RECENCY_HALF_LIFE_DAYS;
        else process.env.LORE_RECALL_RECENCY_HALF_LIFE_DAYS = PREV_HL;
        await g.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('5.4 (shared formula): rankScore — the cross-workspace path\'s function — keeps a stronger old match above weaker fresh filler, and recency stays a bounded nudge', async () => {
    // recallCrossWorkspace.ts:286 re-ranks with rankScore({node, baseScore: real
    // score}) — the SAME function fixed here, so this direct assertion covers
    // the workspace:"*" path without re-standing-up its fan-out harness.
    const now = Date.now();
    const oldBest = { type: 'note', label: 'old best', updatedAt: new Date(now - 400 * 86_400_000).toISOString() };
    const freshWeak = { type: 'note', label: 'fresh weak', updatedAt: new Date(now).toISOString() };

    const sOld = rankScore({ node: oldBest, baseScore: 0.928, nowMs: now });
    const sFresh = rankScore({ node: freshWeak, baseScore: 0.75, nowMs: now });
    assert.ok(sOld > sFresh,
        `400-day-old 0.928 match (${sOld}) must beat same-day 0.75 filler (${sFresh})`);

    // Recency still nudges among comparable candidates, but the nudge is
    // BOUNDED (floor 0.85): equal scores → fresh wins; the discount never
    // exceeds 15% no matter the age.
    const sEqualOld = rankScore({ node: oldBest, baseScore: 0.8, nowMs: now });
    const sEqualFresh = rankScore({ node: freshWeak, baseScore: 0.8, nowMs: now });
    assert.ok(sEqualFresh > sEqualOld, 'recency still prefers the fresher of two equally relevant nodes');
    // 400 days at the 30-day default half-life leaves a decay residue of
    // ~1.6e-6, so the ratio is the 0.85 floor plus that residue — assert the
    // bound, not exact float equality.
    assert.ok(sEqualOld / sEqualFresh >= 0.85 && sEqualOld / sEqualFresh < 0.851,
        `recency discount is bounded at the 0.85 floor, got ratio ${sEqualOld / sEqualFresh}`);
});

/* ═══ medium — keyword search is AND-of-significant-terms, not whole-phrase ═══ */
await test('keyword: multi-word query with scattered terms matches on SurrealGraph (whole-phrase did not)', async () => {
    const dir = tmpDir('c5-kw-');
    const g = new SurrealGraph(dir, { workspaceId: 'wsA', cacheDisabled: true });
    try {
        await g.initialize();
        // Terms present but NOT adjacent — the old whole-phrase substring
        // match returned nothing for 'retention audit' here.
        const content = 'The audit stream keeps retention for seven days before compaction.';
        await putNode(g, 'kw-hit', content);
        await putNode(g, 'kw-partial', 'retention appears but the other term does not');

        const multi = (await g.search('retention audit', 10, '*', '*')).map((n) => n.id);
        assert.deepEqual(multi, ['kw-hit'], `AND-of-terms finds the scattered-terms node only; got ${JSON.stringify(multi)}`);

        const natural = (await g.search('what is the retention for the audit stream', 10, '*', '*')).map((n) => n.id);
        assert.deepEqual(natural, ['kw-hit'], `stopwords do not break a natural-language query; got ${JSON.stringify(natural)}`);

        const single = (await g.search('retention', 10, '*', '*')).map((n) => n.id).sort();
        assert.deepEqual(single, ['kw-hit', 'kw-partial'], 'single-word behaviour unchanged');

        const none = await g.search('nonexistent xyzzy', 10, '*', '*');
        assert.equal(none.length, 0, 'genuinely absent terms still return nothing');
    } finally {
        await g.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* ═══ medium — mode:'full' exposes token-budget truncation in _meta ═══ */
await test('full mode: max_tokens truncation is visible in _meta (truncated/dropped_count/total_matched)', async () => {
    const dir = tmpDir('c5-full-');
    const g = new SurrealGraph(dir, { workspaceId: 'wsA', cacheDisabled: true });
    try {
        await g.initialize();
        const ranked: Array<{ id: string; score: number }> = [];
        for (let i = 0; i < 3; i++) {
            // ~53 estimated tokens each (≈210 chars / 4): budget 100 keeps 1.
            await putNode(g, `tok${i}`, `zeta ${'x'.repeat(200)} ${i}`);
            ranked.push({ id: `lore:tok${i}`, score: 0.9 - i * 0.01 });
        }

        const tools = wireTools(g, mockVectorStore(ranked));
        const out = await tools['recall']!({ topic: 'zeta', workspace: 'wsA', mode: 'full', depth: 0, max_tokens: 100 });
        const body = JSON.parse(out.content[0]!.text) as {
            mode: string; totalRecalled: number; knowledge: unknown[];
            _meta?: { truncated?: boolean; dropped_count?: number; total_matched?: number };
        };
        assert.equal(body.mode, 'full');
        assert.equal(body.knowledge.length, 1, 'budget keeps exactly one node');
        assert.ok(body._meta, 'full mode must carry the _meta envelope');
        assert.equal(body._meta!.truncated, true, 'truncation is signalled in full mode');
        assert.equal(body._meta!.dropped_count, 2, 'dropped_count reports the cut nodes');
        assert.equal(body._meta!.total_matched, 3, 'total_matched reports the pre-truncation count');
    } finally {
        await g.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* ═══ low — an empty recall keeps the requested mode:'full' shape ═══ */
await test('empty result in mode:"full" returns the full-mode shape (empty knowledge array), not the summary shape', async () => {
    const dir = tmpDir('c5-empty-');
    const g = new SurrealGraph(dir, { workspaceId: 'wsA', cacheDisabled: true });
    try {
        await g.initialize();
        const tools = wireTools(g, {
            async verbatimCount() { return 0; },
            async verbatimSearch() { return []; },
            async verbatimBm25Search() { return []; },
        });
        const out = await tools['recall']!({ topic: 'nothing here', workspace: 'wsA', mode: 'full', depth: 0 });
        const body = JSON.parse(out.content[0]!.text) as Record<string, unknown>;
        assert.equal(body.mode, 'full', `empty full-mode recall must keep mode:"full"; got ${body.mode}`);
        assert.ok(Array.isArray(body.knowledge), 'full-mode shape carries a knowledge array');
        assert.equal((body.knowledge as unknown[]).length, 0);
        assert.equal(body.totalRecalled, 0);
        const meta = body._meta as { confidence?: number; negative_evidence?: string } | undefined;
        assert.equal(meta?.confidence, 0, 'empty full-mode result still carries the confidence envelope');
        assert.ok(meta?.negative_evidence, 'empty full-mode result still carries negative evidence');
    } finally {
        await g.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
