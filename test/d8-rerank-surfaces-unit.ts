#!/usr/bin/env tsx
/**
 * test/d8-rerank-surfaces-unit.ts — D8b (Lore 3.23): surface-level coverage
 * for the optional local cross-encoder re-rank stage (rerankStage.ts /
 * rerankConfig.ts, both D8a) now that D8b has threaded `rerank` through
 * every production recall surface and surfaced `_meta.rerank` /
 * `rerank_score` in recallPreset.ts.
 *
 * d8-rerank-stage-unit.ts (D8a) already covers applyRerankStage's own
 * algorithm (margin gate, piece windowing, fail-open reasons) in isolation.
 * d8-rerank-offline-unit.ts (D8a) covers the model-not-cached fail-open
 * path end to end. This file covers what D8b actually added:
 *
 *  A. Config precedence — resolveRerankConfig / getWorkspaceRecallRerank /
 *     setWorkspaceRecallRerank (zero prior test coverage before this file;
 *     confirmed via grep).
 *  B. buildRecallResult presentation — `_meta.rerank` + `rerank_score`
 *     present/absent in summary + full, and the "auto_full order follows
 *     the already-reranked outcome.results" guarantee, exercised directly
 *     against buildRecallResult() with a synthetic RetrieveOutcome (the
 *     same level d8a's own recallPreset.ts changes operate at) rather than
 *     through a full retrieve() semantic pipeline.
 *  C. The `recall` MCP tool — reordering via an injected test scorer,
 *     summary/full/compact meta shapes.
 *  D. REST GET /api/recall — reordering + meta (no mode:'full' on REST).
 *  E. In-process lore.recall() — reordering against a REAL embedded Lore
 *     instance (keyword mode, NullEmbeddingProvider).
 *  F. Cross-workspace recall (workspace:"*") — the stage applies ONCE to
 *     the merged list (not per-workspace), and config precedence collapses
 *     to per-call > env > off (no single workspace to resolve against).
 *
 * Every reordering assertion uses `setRerankScorerForTest` with a scorer
 * that assigns ASCENDING scores by piece position (piece i -> score i).
 * Because each candidate's `content` here is short (<1000 chars), every
 * candidate produces exactly ONE piece, in candidate order — so this
 * scorer deterministically REVERSES the pre-rerank order (the first/
 * incumbent candidate gets the lowest score, the last gets the highest),
 * with a huge margin (>= K-1 >= 1.0 default margin) so the gate always
 * lets the new order stand. This needs no query/content matching at all.
 *
 * Run: npx tsx test/d8-rerank-surfaces-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setRerankScorerForTest, applyRerankStageIfEnabled, type RerankScorer } from '../packages/lore/src/recall/rerankStage.js';
import { buildRecallResult, type RecallPresentationParams } from '../packages/lore/src/recall/recallPreset.js';
import type { RetrieveOutcome, RetrieveMeta, RetrievalResult } from '../packages/lore/src/recall/retrieveTypes.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
    finally { setRerankScorerForTest(null); }
}

console.log('D8b — rerank surface coverage: precedence, presentation, MCP/REST/in-process/cross-workspace\n');

/** Ascending-by-position scorer — see file header. */
const reverseScorer: RerankScorer = async (_q, passages) => passages.map((_, i) => i);

/* ════════════════════════════════════════════════════════════════════
 * A. Config precedence — resolveRerankConfig / get|setWorkspaceRecallRerank
 * ════════════════════════════════════════════════════════════════════ */

await (async () => {
    console.log('A. config precedence\n');

    const { resolveRerankConfig, setWorkspaceRecallRerank, getWorkspaceRecallRerank, DEFAULT_RERANK_MODEL } =
        await import('../packages/lore/src/recall/rerankConfig.js');
    const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');

    const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-precedence-'));
    const WS = 'd8-precedence-ws';
    createWorkspace(WS, {}, HOME);

    const ENV_KEYS = ['LORE_RECALL_RERANK', 'LORE_RECALL_RERANK_MODEL', 'LORE_RECALL_RERANK_K', 'LORE_RECALL_RERANK_MARGIN'] as const;
    function clearEnv(): void { for (const k of ENV_KEYS) delete process.env[k]; }

    try {
        await test('D8d: default ON with nothing set anywhere', async () => {
            clearEnv();
            setWorkspaceRecallRerank(WS, null, HOME);
            const cfg = resolveRerankConfig(undefined, WS, HOME);
            assert.equal(cfg.enabled, true);
            assert.equal(cfg.model, DEFAULT_RERANK_MODEL);
        });

        await test('D8d: explicit env "off" overrides the new default-on (no workspace policy, no per-call opinion)', async () => {
            clearEnv();
            setWorkspaceRecallRerank(WS, null, HOME);
            process.env['LORE_RECALL_RERANK'] = 'off';
            const cfg = resolveRerankConfig(undefined, WS, HOME);
            assert.equal(cfg.enabled, false);
            assert.equal(cfg.disabledReason, undefined, 'env-off is not workspace_disabled — byte-identical-off path, no meta at all');
        });

        await test('enabled: workspace policy overrides env in both directions (workspace off beats env on; workspace on beats env off)', async () => {
            clearEnv();
            process.env['LORE_RECALL_RERANK'] = 'on';
            setWorkspaceRecallRerank(WS, { enabled: false }, HOME);
            let cfg = resolveRerankConfig(undefined, WS, HOME);
            assert.equal(cfg.enabled, false, 'workspace policy (off) must win over env (on)');

            process.env['LORE_RECALL_RERANK'] = 'off';
            setWorkspaceRecallRerank(WS, { enabled: true }, HOME);
            cfg = resolveRerankConfig(undefined, WS, HOME);
            assert.equal(cfg.enabled, true, 'workspace policy (on) must win over env (off)');
        });

        await test('D8d OWNER DECISION: workspace off is AUTHORITATIVE — per-call true does NOT force it on', async () => {
            clearEnv();
            setWorkspaceRecallRerank(WS, { enabled: false }, HOME);
            const cfg = resolveRerankConfig(true, WS, HOME);
            assert.equal(cfg.enabled, false, 'a per-query rerank:true on a workspace set to off must NOT force it on');
            assert.equal(cfg.disabledReason, 'workspace_disabled');
        });

        await test('B1: workspace off with NO per-call opinion is a PLAIN off — byte-identical to pre-D8 (owner decision 1), not workspace_disabled', async () => {
            clearEnv();
            setWorkspaceRecallRerank(WS, { enabled: false }, HOME);
            const cfg = resolveRerankConfig(undefined, WS, HOME);
            assert.equal(cfg.enabled, false);
            assert.equal(cfg.disabledReason, undefined, 'workspace-off with no per-call opinion must NOT set disabledReason — only workspace-off overriding an explicit per-call true is the "authoritative override" case that gets a reason/meta');

            // End to end through the wiring layer: applyRerankStageIfEnabled
            // must return no rerankMeta at all for this case, matching its
            // own documented "plain off -> no meta" contract.
            const savedHome = process.env['LORE_HOME'];
            process.env['LORE_HOME'] = HOME;
            try {
                const dummyResults = [
                    { node: { id: 'b1x1', content: 'c1' } }, { node: { id: 'b1x2', content: 'c2' } },
                ] as unknown as RetrievalResult[];
                const out = await applyRerankStageIfEnabled(dummyResults, 'q', undefined, WS);
                assert.equal(out.rerankMeta, undefined, 'plain workspace-off must produce zero rerank meta (no _meta.rerank on the wire)');
                assert.deepEqual(out.results, dummyResults);
            } finally {
                if (savedHome === undefined) delete process.env['LORE_HOME']; else process.env['LORE_HOME'] = savedHome;
            }
        });

        await test('D8d: per-call false always wins, even over workspace-on / env-on / the new default-on', async () => {
            clearEnv();
            process.env['LORE_RECALL_RERANK'] = 'on';
            setWorkspaceRecallRerank(WS, { enabled: true }, HOME);
            const cfg = resolveRerankConfig(false, WS, HOME);
            assert.equal(cfg.enabled, false, 'explicit per-call false must always win');
            assert.equal(cfg.disabledReason, undefined, 'explicit per-call off is byte-identical-off, not workspace_disabled');
        });

        await test('D8d: per-call true wins over env/default when workspace has no opinion', async () => {
            clearEnv();
            setWorkspaceRecallRerank(WS, null, HOME);
            process.env['LORE_RECALL_RERANK'] = 'off';
            const cfg = resolveRerankConfig(true, WS, HOME);
            assert.equal(cfg.enabled, true, 'per-call true must win over env(off) when workspace has no opinion');
        });

        await test('model/k/margin: workspace > env > default', async () => {
            clearEnv();
            setWorkspaceRecallRerank(WS, null, HOME);
            let cfg = resolveRerankConfig(true, WS, HOME);
            assert.equal(cfg.model, DEFAULT_RERANK_MODEL, 'no workspace/env override -> default model');
            assert.equal(cfg.k, 10);
            assert.equal(cfg.margin, 1.0);

            process.env['LORE_RECALL_RERANK_MODEL'] = 'some-org/env-model-id';
            process.env['LORE_RECALL_RERANK_K'] = '4';
            process.env['LORE_RECALL_RERANK_MARGIN'] = '2.5';
            cfg = resolveRerankConfig(true, WS, HOME);
            assert.equal(cfg.model, 'some-org/env-model-id', 'env override applies when no workspace override');
            assert.equal(cfg.k, 4);
            assert.equal(cfg.margin, 2.5);

            setWorkspaceRecallRerank(WS, { enabled: true, model: 'some-org/ws-model-id', k: 6, margin: 0.5 }, HOME);
            cfg = resolveRerankConfig(true, WS, HOME);
            assert.equal(cfg.model, 'some-org/ws-model-id', 'workspace model must win over env model');
            assert.equal(cfg.k, 6, 'workspace k must win over env k');
            assert.equal(cfg.margin, 0.5, 'workspace margin must win over env margin');
        });

        await test('getWorkspaceRecallRerank/setWorkspaceRecallRerank round-trip; unknown workspace throws', async () => {
            clearEnv();
            setWorkspaceRecallRerank(WS, { enabled: true, model: 'some-org/m', k: 8, margin: 1.5 }, HOME);
            const read = getWorkspaceRecallRerank(WS, HOME);
            assert.deepEqual(read, { enabled: true, model: 'some-org/m', k: 8, margin: 1.5 });
            setWorkspaceRecallRerank(WS, null, HOME);
            assert.deepEqual(getWorkspaceRecallRerank(WS, HOME), { enabled: false }, 'cleared policy reads back as the back-compat default');
            assert.throws(() => getWorkspaceRecallRerank('d8-no-such-ws', HOME), /Unknown workspace/);
            assert.throws(() => setWorkspaceRecallRerank('d8-no-such-ws', { enabled: true }, HOME), /Unknown workspace/);
        });

        await test('no workspace context (undefined workspaceName): workspace lookup is skipped, per-call > env > off', async () => {
            clearEnv();
            setWorkspaceRecallRerank(WS, { enabled: false }, HOME); // must be irrelevant — no workspace name passed
            process.env['LORE_RECALL_RERANK'] = 'on';
            const cfg = resolveRerankConfig(undefined, undefined, HOME);
            assert.equal(cfg.enabled, true, 'with no workspace name, env must decide (workspace policy is unreachable)');
        });
    } finally {
        clearEnv();
        fs.rmSync(HOME, { recursive: true, force: true });
    }
})();

/* ════════════════════════════════════════════════════════════════════
 * B. buildRecallResult presentation — meta shapes + auto_full order
 * ════════════════════════════════════════════════════════════════════ */

type FNode = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; language: string | null; updatedAt: string;
};
const fnode = (id: string, over: Partial<FNode> = {}): FNode => ({
    id, type: 'note', label: `Label ${id}`, content: `content body for ${id}`,
    tags: [], project: 'd8b', ecosystem: '*', language: null,
    updatedAt: '2026-06-01T00:00:00.000Z', ...over,
});

function baseCalibration() {
    return {
        topSimilarity: null, topRelevance: null, relevanceFloor: 2, belowFloor: false, abstained: false,
        calibration: { status: 'not_applicable' as const, version: 'v0', probes: 0, rows: 0, nullMedian: null, nullScale: null, scope: 'none' },
    };
}
function baseMeta(over: Partial<RetrieveMeta> = {}): RetrieveMeta {
    return {
        ...baseCalibration(),
        topScore: null, sourcesConsulted: 1, totalMatched: 0, truncated: false, droppedCount: 0, directMatches: 0,
        verbatimConsulted: false, scanCapHit: false, bm25Ranked: true, vectorLegSkipped: false,
        possibleStarvation: false, candidateWindow: 0, prefixStableUpTo: 0,
        ...over,
    };
}
const fakeGraph = {
    async getNode(id: string) { return fnode(id) as unknown as import('../packages/lore/src/providers/types.js').LoreNode; },
    async getLanguageBreakdown() { return {}; },
    async listNodes() { return []; },
};
const presParams = (over: Partial<RecallPresentationParams> = {}): RecallPresentationParams => ({
    topic: 'zzyzxd8b', responseMode: 'summary', searchMode: 'keyword', workspaceScope: 'd8b', ecosystemScope: '*',
    crossProject: false, ...over,
});

await (async () => {
    console.log('\nB. buildRecallResult presentation\n');

    await test('summary: no rerank meta -> _meta.rerank absent, hits[].rerank_score absent', async () => {
        const outcome: RetrieveOutcome = {
            results: [{ node: fnode('b1') as any, score: 1, matchedBy: ['bm25'], depth: 0, source: 'seed' }],
            related: [], meta: baseMeta({ totalMatched: 1, directMatches: 1 }),
        };
        const res = await buildRecallResult(presParams(), outcome, fakeGraph) as any;
        assert.equal(res._meta.rerank, undefined);
        assert.equal(res.hits[0].rerank_score, undefined);
    });

    await test('summary: rerank meta present -> _meta.rerank (snake_case) + hits[].rerank_score present', async () => {
        const outcome: RetrieveOutcome = {
            results: [
                { node: fnode('b1') as any, score: 1, matchedBy: ['bm25'], depth: 0, source: 'seed', rerankScore: 9 },
                { node: fnode('b2') as any, score: 0.5, matchedBy: ['bm25'], depth: 0, source: 'seed', rerankScore: 3 },
            ],
            related: [],
            meta: baseMeta({
                totalMatched: 2, directMatches: 2,
                rerank: { model: 'x/y', dtype: 'q8', k: 10, margin: 1, applied: true, gateHeld: false, replacedTop: true, latencyMs: 5, piecesScored: 2 },
            }),
        };
        const res = await buildRecallResult(presParams(), outcome, fakeGraph) as any;
        assert.deepEqual(res._meta.rerank, { model: 'x/y', applied: true, gate_held: false, replaced_top: true, k: 10, margin: 1, latency_ms: 5, pieces_scored: 2 });
        assert.equal(res.hits[0].rerank_score, 9);
        assert.equal(res.hits[1].rerank_score, 3);
    });

    await test('full: rerank meta present in _meta, knowledge[].rerank_score present, absent otherwise', async () => {
        const withRerank: RetrieveOutcome = {
            results: [{ node: fnode('f1') as any, score: 1, matchedBy: ['bm25'], depth: 0, source: 'seed', rerankScore: 7 }],
            related: [],
            meta: baseMeta({
                totalMatched: 1, directMatches: 1,
                rerank: { model: 'x/y', dtype: 'q8', k: 10, margin: 1, applied: true, gateHeld: false, replacedTop: false, latencyMs: 1, piecesScored: 1 },
            }),
        };
        const resWith = await buildRecallResult(presParams({ responseMode: 'full' }), withRerank, fakeGraph) as any;
        assert.equal(resWith._meta.rerank.model, 'x/y');
        assert.equal(resWith.knowledge[0].rerank_score, 7);

        const without: RetrieveOutcome = {
            results: [{ node: fnode('f2') as any, score: 1, matchedBy: ['bm25'], depth: 0, source: 'seed' }],
            related: [], meta: baseMeta({ totalMatched: 1, directMatches: 1 }),
        };
        const resWithout = await buildRecallResult(presParams({ responseMode: 'full' }), without, fakeGraph) as any;
        assert.equal(resWithout._meta.rerank, undefined);
        assert.equal(resWithout.knowledge[0].rerank_score, undefined);
    });

    await test('full: empty-result branch still surfaces _meta.rerank when the call had rerank meta (e.g. too_few_results)', async () => {
        const outcome: RetrieveOutcome = {
            results: [], related: [],
            meta: baseMeta({
                rerank: { model: 'x/y', dtype: 'q8', k: 10, margin: 1, applied: false, reason: 'too_few_results', gateHeld: false, replacedTop: false, latencyMs: 0, piecesScored: 0 },
            }),
        };
        const res = await buildRecallResult(presParams({ responseMode: 'full' }), outcome, fakeGraph) as any;
        assert.equal(res.knowledge.length, 0);
        assert.deepEqual(res._meta.rerank, { model: 'x/y', applied: false, reason: 'too_few_results', gate_held: false, replaced_top: false, k: 10, margin: 1, latency_ms: 0, pieces_scored: 0 });
    });

    await test('summary: auto_full follows the already-reranked outcome.results order (D8b guarantee) — retrieve.ts reorders BEFORE returning, so this presentation layer needs no reordering logic of its own', async () => {
        // Deliberately in REVERSED id order vs a hypothetical pre-rerank
        // order (r3 first) — buildRecallResult must NOT re-sort; it must
        // present outcome.results exactly as given, which is what proves
        // "the presentation layer trusts retrieve()'s already-reranked
        // order" rather than re-deriving order from score/similarity.
        const outcome: RetrieveOutcome = {
            results: [
                { node: fnode('r3', { content: 'body r3' }) as any, score: 0.4, matchedBy: ['bm25'], depth: 0, source: 'seed', similarity: 0.99, rerankScore: 9 },
                { node: fnode('r1', { content: 'body r1' }) as any, score: 0.9, matchedBy: ['bm25'], depth: 0, source: 'seed', similarity: 0.90, rerankScore: 5 },
                { node: fnode('r2', { content: 'body r2' }) as any, score: 0.6, matchedBy: ['bm25'], depth: 0, source: 'seed', similarity: 0.95, rerankScore: 1 },
            ],
            related: [],
            meta: baseMeta({
                totalMatched: 3, directMatches: 3, topScore: 0.99, // >= AUTO_ESCALATE_THRESHOLD (0.85) -> auto_full triggers
                rerank: { model: 'x/y', dtype: 'q8', k: 10, margin: 1, applied: true, gateHeld: false, replacedTop: true, latencyMs: 2, piecesScored: 3 },
            }),
        };
        const res = await buildRecallResult(presParams(), outcome, fakeGraph) as any;
        assert.deepEqual(res.hits.map((h: any) => h.id), ['r3', 'r1', 'r2'], 'hits must follow outcome.results order verbatim');
        assert.ok(res.auto_full, 'auto_full must be present (topScore 0.99 >= 0.85)');
        assert.deepEqual(res.auto_full.map((a: any) => a.id), ['r3', 'r1', 'r2'], 'auto_full must follow the SAME (reranked) order as hits — it slices the same `trimmed` array');
    });
})();

/* ════════════════════════════════════════════════════════════════════
 * C. MCP `recall` tool — reordering + meta shapes (summary/full/compact)
 * ════════════════════════════════════════════════════════════════════ */

const WORKSPACE = 'd8b-mcp-ws';
const NODES: Record<string, FNode> = {
    n1: fnode('n1', { project: WORKSPACE, content: 'zzyzxd8bmcp one' }),
    n2: fnode('n2', { project: WORKSPACE, content: 'zzyzxd8bmcp two' }),
    n3: fnode('n3', { project: WORKSPACE, content: 'zzyzxd8bmcp three' }),
};
// Fixed BM25 order (descending): n1 > n2 > n3 — mirrors rc321a-keyword-bm25-mcp-rest-unit.ts's fixture pattern.
const BM25_RANKED = [{ id: 'lore:n1', score: 9 }, { id: 'lore:n2', score: 6 }, { id: 'lore:n3', score: 3 }];

function buildMcpFixture() {
    const graph = {
        async search() { return []; }, // graph text leg unused — keyword mode goes through bm25Search
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, FNode>();
            for (const id of ids) { const x = NODES[id]; if (x) m.set(id, { ...x }); }
            return m;
        },
        async traverse() { return []; },
        async getNode(id: string) { const x = NODES[id]; return x ? { ...x } : null; },
        async listNodes() { return []; },
        async getLanguageBreakdown() { return {}; },
    };
    const store = {
        loreGraph: graph,
        loreVerbatim: {},
        sessionCache: { pushNode() { /* noop */ } },
        storageClient: {
            async verbatimCount() { return 3; },
            async verbatimSearch() { throw new Error('keyword mode must never call semantic'); },
            async verbatimBm25Search() { return { hits: BM25_RANKED.map((s) => ({ ...s })), ranked: true }; },
        },
    };
    const deps = { store, detectedScope: { workspace: WORKSPACE, ecosystem: '*' } } as unknown as Parameters<typeof registerRecallToolFn>[1];
    return { deps };
}

let registerRecallToolFn: typeof import('../packages/lore/src/mcp/tools/search/recallTool.js').registerRecallTool;

async function callMcpRecall(args: Record<string, unknown>): Promise<any> {
    const { registerRecallTool } = await import('../packages/lore/src/mcp/tools/search/recallTool.js');
    registerRecallToolFn = registerRecallTool;
    const { deps } = buildMcpFixture();
    let handler: ((a: Record<string, unknown>) => Promise<any>) | null = null;
    const fakeServer = { tool(_n: string, _d: string, _s: unknown, fn: (a: Record<string, unknown>) => Promise<any>) { handler = fn; } } as unknown as InstanceType<typeof McpServer>;
    registerRecallTool(fakeServer, deps);
    const res = await handler!({ topic: 'zzyzxd8bmcp', workspace: WORKSPACE, search_mode: 'keyword', ...args });
    assert.ok(!res.isError, `recall tool returned an error: ${res.content?.[0]?.text}`);
    return JSON.parse(res.content[0].text);
}

await (async () => {
    console.log('\nC. MCP `recall` tool\n');

    await test('D8d summary, rerank omitted: default-on attempts rerank; model not cached under this test LORE_HOME -> fail-open meta, baseline order n1,n2,n3', async () => {
        const out = await callMcpRecall({ mode: 'summary' });
        assert.deepEqual(out.hits.map((h: any) => h.id), ['n1', 'n2', 'n3']);
        assert.ok(out._meta.rerank, 'D8d default-on means an opinion-less call now reports rerank meta');
        assert.equal(out._meta.rerank.applied, false);
        assert.equal(out._meta.rerank.reason, 'model_absent');
        assert.equal(out.hits[0].rerank_score, undefined);
    });

    await test('summary, rerank:true with injected scorer: order reverses to n3,n2,n1; meta present', async () => {
        setRerankScorerForTest(reverseScorer);
        const out = await callMcpRecall({ mode: 'summary', rerank: true });
        assert.deepEqual(out.hits.map((h: any) => h.id), ['n3', 'n2', 'n1'], 'ascending-by-position scorer must reverse the 3-candidate baseline order');
        assert.equal(out._meta.rerank.applied, true);
        assert.equal(out._meta.rerank.replaced_top, true);
        assert.equal(out.hits[0].rerank_score, 2, 'the new #1 (originally last, piece index 2) must carry the scorer\'s score for that position');
    });

    await test('full: knowledge[] follows the same reranked order as summary hits', async () => {
        setRerankScorerForTest(reverseScorer);
        const out = await callMcpRecall({ mode: 'full', rerank: true });
        assert.deepEqual(out.knowledge.map((k: any) => k.id), ['n3', 'n2', 'n1']);
        assert.equal(out._meta.rerank.applied, true);
    });

    await test('compact: candidates[] reordered too, rerank_score present per candidate', async () => {
        setRerankScorerForTest(reverseScorer);
        const out = await callMcpRecall({ compact: true, rerank: true });
        assert.deepEqual(out.candidates.map((c: any) => c.id), ['n3', 'n2', 'n1']);
        assert.equal(out._meta.rerank.applied, true);
        assert.ok(out.candidates.every((c: any) => typeof c.rerank_score === 'number'));
    });

    await test('rerank:false explicit: order stays baseline even with a scorer installed (per-call off wins)', async () => {
        setRerankScorerForTest(reverseScorer);
        const out = await callMcpRecall({ mode: 'summary', rerank: false });
        assert.deepEqual(out.hits.map((h: any) => h.id), ['n1', 'n2', 'n3']);
        assert.equal(out._meta.rerank, undefined);
    });
})();

/* ════════════════════════════════════════════════════════════════════
 * D. REST GET /api/recall — reordering + meta (no mode:'full' on REST)
 * ════════════════════════════════════════════════════════════════════ */

async function callRestRecall(qs: string): Promise<any> {
    const { trySearchRoutes } = await import('../packages/lore/src/mcp/http/routes/search.js');
    const { deps } = buildMcpFixture();
    const searchDeps = { store: deps.store, detectedScope: deps.detectedScope, deploymentMode: 'local', dataplane: null, graphRegistry: undefined } as any;
    const url = `/api/recall?topic=zzyzxd8bmcp&workspace=${WORKSPACE}&search_mode=keyword${qs}`;
    let status = 0; let body = '';
    const req = { method: 'GET', url } as unknown as IncomingMessage;
    const res = { writeHead(s: number) { status = s; return this; }, end(chunk?: string) { body = chunk ?? ''; } } as unknown as ServerResponse;
    const handled = await trySearchRoutes(req, res, url, '/api/recall', searchDeps);
    assert.ok(handled, 'GET /api/recall was not handled');
    assert.equal(status, 200, `unexpected status ${status}: ${body}`);
    return JSON.parse(body);
}

await (async () => {
    console.log('\nD. REST GET /api/recall\n');

    await test('D8d no ?rerank param: default-on attempts rerank; model not cached -> fail-open meta, baseline order', async () => {
        const out = await callRestRecall('');
        assert.deepEqual(out.hits.map((h: any) => h.id), ['n1', 'n2', 'n3']);
        assert.ok(out._meta.rerank, 'D8d default-on means an opinion-less call now reports rerank meta');
        assert.equal(out._meta.rerank.applied, false);
        assert.equal(out._meta.rerank.reason, 'model_absent');
    });

    await test('?rerank=1 with injected scorer: order reverses, meta present', async () => {
        setRerankScorerForTest(reverseScorer);
        const out = await callRestRecall('&rerank=1');
        assert.deepEqual(out.hits.map((h: any) => h.id), ['n3', 'n2', 'n1']);
        assert.equal(out._meta.rerank.applied, true);
    });

    await test('?rerank=0 with injected scorer: order unchanged, no meta (explicit off wins)', async () => {
        setRerankScorerForTest(reverseScorer);
        const out = await callRestRecall('&rerank=0');
        assert.deepEqual(out.hits.map((h: any) => h.id), ['n1', 'n2', 'n3']);
        assert.equal(out._meta.rerank, undefined);
    });

    await test('N16: ?rerank=true (lowercase) with injected scorer behaves exactly like ?rerank=1', async () => {
        setRerankScorerForTest(reverseScorer);
        const out = await callRestRecall('&rerank=true');
        assert.deepEqual(out.hits.map((h: any) => h.id), ['n3', 'n2', 'n1']);
        assert.equal(out._meta.rerank.applied, true);
    });

    await test('N16: ?rerank=TRUE (uppercase) with injected scorer behaves exactly like ?rerank=1', async () => {
        setRerankScorerForTest(reverseScorer);
        const out = await callRestRecall('&rerank=TRUE');
        assert.deepEqual(out.hits.map((h: any) => h.id), ['n3', 'n2', 'n1']);
        assert.equal(out._meta.rerank.applied, true);
    });

    await test('N16: ?rerank=False (mixed case) with injected scorer behaves exactly like ?rerank=0', async () => {
        setRerankScorerForTest(reverseScorer);
        const out = await callRestRecall('&rerank=False');
        assert.deepEqual(out.hits.map((h: any) => h.id), ['n1', 'n2', 'n3']);
        assert.equal(out._meta.rerank, undefined);
    });

    await test('N16: ?rerank=yes (not a recognized alias) falls through to undefined, same as an absent param', async () => {
        setRerankScorerForTest(reverseScorer);
        const out = await callRestRecall('&rerank=yes');
        assert.ok(out._meta.rerank, 'D8d default-on: an unrecognized value must inherit the default opinion, not silently disable it');
        assert.equal(out._meta.rerank.applied, true, 'default-on + a real scorer installed -> applied');
    });
})();

/* ════════════════════════════════════════════════════════════════════
 * E. In-process lore.recall() — real embedded Lore instance
 * ════════════════════════════════════════════════════════════════════ */

await (async () => {
    console.log('\nE. in-process lore.recall()\n');

    await test('rerank:true reorders a real embedded keyword recall; rerank:false/omitted does not', async () => {
        const { createLore } = await import('../packages/lore/src/index.js');
        const { NullEmbeddingProvider } = await import('../packages/lore/src/providers/nullEmbeddingProvider.js');
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-d8b-inproc-'));
        const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
        try {
            await lore.bulkIngest([
                { id: 'ip-1', workspace: 'default', ecosystem: '*', nodeData: { id: 'ip-1', type: 'note', label: 'ip-1', content: 'zzyzxd8binproc alpha', project: 'default', ecosystem: '*' } },
                { id: 'ip-2', workspace: 'default', ecosystem: '*', nodeData: { id: 'ip-2', type: 'note', label: 'ip-2', content: 'zzyzxd8binproc beta', project: 'default', ecosystem: '*' } },
                { id: 'ip-3', workspace: 'default', ecosystem: '*', nodeData: { id: 'ip-3', type: 'note', label: 'ip-3', content: 'zzyzxd8binproc gamma', project: 'default', ecosystem: '*' } },
            ], { autolink: false, embed: 'sync' });

            const baseline = await lore.recall('zzyzxd8binproc', { workspace: 'default', mode: 'full', searchMode: 'keyword' }) as any;
            const baselineIds: string[] = baseline.knowledge.map((k: any) => k.id);
            assert.equal(baselineIds.length, 3, 'all 3 ingested nodes must match the shared keyword');
            // D8d: default-on means an opinion-less call still ATTEMPTS
            // rerank; this test's LORE_HOME never has the model cached, so
            // it fails open with reason:'model_absent' rather than omitting
            // meta entirely (that's the explicit-off contract, tested below).
            assert.ok(baseline._meta.rerank, 'D8d default-on: opinion-less call now reports rerank meta');
            assert.equal(baseline._meta.rerank.applied, false);
            assert.equal(baseline._meta.rerank.reason, 'model_absent');

            setRerankScorerForTest(reverseScorer);
            const reranked = await lore.recall('zzyzxd8binproc', { workspace: 'default', mode: 'full', searchMode: 'keyword', rerank: true }) as any;
            const rerankedIds: string[] = reranked.knowledge.map((k: any) => k.id);
            assert.deepEqual(rerankedIds, [...baselineIds].reverse(), 'rerank:true must reverse the 3-candidate baseline order');
            assert.equal(reranked._meta.rerank.applied, true);

            const explicitOff = await lore.recall('zzyzxd8binproc', { workspace: 'default', mode: 'full', searchMode: 'keyword', rerank: false }) as any;
            assert.deepEqual(explicitOff.knowledge.map((k: any) => k.id), baselineIds, 'rerank:false with a scorer installed must still keep baseline order');
            assert.equal(explicitOff._meta.rerank, undefined);
        } finally {
            setRerankScorerForTest(null);
            await lore.dispose();
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });
})();

/* ════════════════════════════════════════════════════════════════════
 * F. Cross-workspace recall (workspace:"*") — applied once, precedence
 *    collapses to per-call > env > off.
 * ════════════════════════════════════════════════════════════════════ */

await (async () => {
    console.log('\nF. cross-workspace recall (workspace:"*")\n');

    const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'd8b-cross-ws-'));
    process.env['LORE_HOME'] = TEST_HOME;
    function seedWorkspaces(home: string, names: string[]): void {
        const workspaces = names.map((name) => ({ name, path: path.join(home, 'workspaces', name), createdAt: '2026-06-15T00:00:00.000Z', graphEngine: 'surreal' as const }));
        fs.mkdirSync(home, { recursive: true });
        for (const w of workspaces) fs.mkdirSync(path.join(w.path, '.lore'), { recursive: true });
        fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({ active: names[0]!, workspaces }, null, 2));
    }
    seedWorkspaces(TEST_HOME, ['ws-x']);

    const XNODES: Record<string, FNode> = {
        x1: fnode('x1', { project: 'ws-x', content: 'body x1' }),
        x2: fnode('x2', { project: 'ws-x', content: 'body x2' }),
        x3: fnode('x3', { project: 'ws-x', content: 'body x3' }),
    };
    let scoreCallCount = 0;
    const countingReverseScorer: RerankScorer = async (q, passages) => { scoreCallCount++; return reverseScorer(q, passages); };

    const wsGraph = {
        async search(_topic: string, _limit: number, _project: string, _ecosystem: string, _excludeHidden: boolean, signals: { scanCapHit: boolean }) {
            void _topic; void _limit; void _project; void _ecosystem; void _excludeHidden;
            signals.scanCapHit = false;
            // Fixed order: x1, x2, x3 (descending synthetic rank via array order — kwHits order drives RRF).
            return [{ ...XNODES.x1 }, { ...XNODES.x2 }, { ...XNODES.x3 }];
        },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, FNode>();
            for (const id of ids) { const x = XNODES[id]; if (x) m.set(id, { ...x }); }
            return m;
        },
    };
    const registry = { async getGraphHandle(_ws: string) { void _ws; return wsGraph; }, homeDir() { return TEST_HOME; } };
    const verbatimStore = { async count() { return 0; }, async search() { return []; } };

    try {
        await (async () => {
            const { runCrossWorkspaceRecall } = await import('../packages/lore/src/mcp/tools/recallCrossWorkspace.js');

            await test('summary: rerank:true reorders the MERGED list and applies the scorer exactly ONCE (not per-workspace)', async () => {
                scoreCallCount = 0;
                setRerankScorerForTest(countingReverseScorer);
                const res = await runCrossWorkspaceRecall({
                    topic: 'q', depth: 0, includeSuperseded: false, registry: registry as any, verbatimStore: verbatimStore as any,
                    sessionCache: { pushNode() { /* noop */ } } as any, responseMode: 'summary', rerank: true,
                } as any);
                assert.ok(!res.isError, `runCrossWorkspaceRecall error: ${res.content?.[0]?.text}`);
                const out = JSON.parse(res.content[0]!.text);
                assert.deepEqual(out.hits.map((h: any) => h.id), ['x3', 'x2', 'x1']);
                assert.equal(out._meta.rerank.applied, true);
                assert.equal(scoreCallCount, 1, 'the scorer must be invoked exactly once, against the merged post-filter list — never per workspace');
            });

            await test('full: _meta.rerank present (full mode had NO _meta object at all pre-D8b) and knowledge[] reordered', async () => {
                setRerankScorerForTest(reverseScorer);
                const res = await runCrossWorkspaceRecall({
                    topic: 'q', depth: 0, includeSuperseded: false, registry: registry as any, verbatimStore: verbatimStore as any,
                    sessionCache: { pushNode() { /* noop */ } } as any, responseMode: 'full', rerank: true,
                } as any);
                assert.ok(!res.isError);
                const out = JSON.parse(res.content[0]!.text);
                assert.deepEqual(out.knowledge.map((k: any) => k.id), ['x3', 'x2', 'x1']);
                assert.equal(out._meta.rerank.applied, true);
            });

            await test('D8d no per-call rerank: default-on applies on the cross-workspace path too (precedence collapses to per-call > env > default-on — no single workspace to resolve against)', async () => {
                delete process.env['LORE_RECALL_RERANK'];
                setRerankScorerForTest(reverseScorer);
                const defaultRes = await runCrossWorkspaceRecall({
                    topic: 'q', depth: 0, includeSuperseded: false, registry: registry as any, verbatimStore: verbatimStore as any,
                    sessionCache: { pushNode() { /* noop */ } } as any, responseMode: 'summary',
                } as any);
                const defaultOut = JSON.parse(defaultRes.content[0]!.text);
                assert.equal(defaultOut._meta.rerank.applied, true, 'D8d: no per-call opinion, no env -> default ON applies on the cross-workspace path too');

                process.env['LORE_RECALL_RERANK'] = '0';
                const offRes = await runCrossWorkspaceRecall({
                    topic: 'q', depth: 0, includeSuperseded: false, registry: registry as any, verbatimStore: verbatimStore as any,
                    sessionCache: { pushNode() { /* noop */ } } as any, responseMode: 'summary',
                } as any);
                const offOut = JSON.parse(offRes.content[0]!.text);
                assert.equal(offOut._meta.rerank, undefined, 'env "0" alone must still disable rerank on the cross-workspace path (byte-identical-off)');
                delete process.env['LORE_RECALL_RERANK'];
            });
        })();
    } finally {
        setRerankScorerForTest(null);
        delete process.env['LORE_HOME'];
        fs.rmSync(TEST_HOME, { recursive: true, force: true });
    }
})();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
