#!/usr/bin/env tsx
/**
 * test/r3221-d1-recall-option-parity-unit.ts — fix/3.22.1-d1-recall-option-
 * parity.
 *
 * Structural parity test: asserts that the SET of RetrieveOptions keys the
 * in-process `lore.recall()` surface (inProcessRecall.ts) passes into the
 * shared retrieve() core is the same as the set the `recall` MCP tool
 * (recallTool.ts) passes in, modulo a short, EXPLICIT, documented list of
 * intentional exceptions. This is what actually caught the `types` gap this
 * defect report is about (RC321i already pinned queries/entities/topics/
 * project parity, one release earlier, but nothing pinned parity as an
 * invariant going forward — a NEW key added to one surface and not the
 * other would keep silently drifting).
 *
 * Seam: retrieve.ts exports a test-only `setRetrieveOptionsSpy()` hook
 * (null in every real path) that lets us capture the raw `opts` object each
 * caller builds, without mocking modules or touching the seed-store layer.
 * `Object.keys(opts)` on that raw object reports every key the call-site
 * OBJECT LITERAL declared, including ones explicitly set to `undefined` —
 * which is exactly "did this call site thread this option through", not
 * "did it end up non-empty".
 *
 * Intentional exceptions (documented here, not silently allowed elsewhere):
 *   - `signal`      — AbortSignal; the MCP stdio transport has no per-call
 *                      cancellation source to plumb one from. In-process only.
 *   - `candidateFloor` / `lexicalBase` — D3 §3.1/§3.6 per-call overrides.
 *                      RetrieveOptions' own JSDoc says these are deliberately
 *                      NOT extended to MCP tool schemas / REST — the env
 *                      knobs (LORE_RECALL_CANDIDATE_FLOOR /
 *                      LORE_RECALL_LEXICAL_BASE) cover those surfaces.
 *   - `abstainTermCoverage` — has an env fallback
 *                      (LORE_RECALL_ABSTAIN_TERM_COVERAGE) already covering
 *                      MCP/REST; not exposed as a discrete tool arg to avoid
 *                      recallTool.ts schema churn (a separate branch is
 *                      already extending that file's `max` arg).
 * Any OTHER divergence — including a future key that lands on one surface
 * and not the other — fails this test, by construction (it's a whole-set
 * comparison, not an allowlist you update to keep it green).
 *
 * Run: npx tsx test/r3221-d1-recall-option-parity-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setRetrieveOptionsSpy, type RetrieveOptions } from '../packages/lore/src/recall/retrieve.js';
import { setBuildRecallResultParamsSpy, type RecallPresentationParams } from '../packages/lore/src/recall/recallPreset.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
    finally { setRetrieveOptionsSpy(null); setBuildRecallResultParamsSpy(null); }
}

console.log('fix/3.22.1-d1-recall-option-parity — in-process vs MCP recall tool option-key parity\n');

// Exceptions that are ALLOWED to differ, with the reason baked into the name
// so a diff shows which bucket a stray key fell into.
const IN_PROCESS_ONLY = new Set(['signal', 'candidateFloor', 'lexicalBase']);
const NEITHER_EXTRA = new Set(['abstainTermCoverage']); // present on in-process, intentionally absent on MCP (env fallback covers MCP/REST)

function captureInProcessKeys(): Promise<Set<string>> {
    return new Promise((resolve) => {
        setRetrieveOptionsSpy((opts: RetrieveOptions) => resolve(new Set(Object.keys(opts))));
    });
}

async function runInProcessCapture(): Promise<Set<string>> {
    const { createLore } = await import('../packages/lore/src/index.js');
    const { NullEmbeddingProvider } = await import('../packages/lore/src/providers/nullEmbeddingProvider.js');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-parity-inproc-'));
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        const capture = captureInProcessKeys();
        // Pass every RecallOpts field this surface declares, so nothing that
        // COULD be threaded is left as `undefined` merely because the call
        // site never bothered — that would hide a real gap the same way the
        // `types` defect did (RecallOpts declared it isn't the bug; not
        // threading it through was). Errors AFTER the spy fires (e.g. from a
        // minimal fixture store) are irrelevant to this test — only the
        // captured key set matters.
        lore.recall('zzyzxparity', {
            workspace: 'default', ecosystem: '*', depth: 1, mode: 'summary',
            crossProject: false, includeSuperseded: false, tags: ['t'], types: ['note'],
            maxTokens: 1000, includeArchived: false, searchMode: 'keyword',
            queryLanguage: 'en', filePaths: [], max: 5, queries: ['q'],
            entities: ['e'], topics: ['t'], project: 'p',
            abstain: false, relevanceFloor: 2, abstainTermCoverage: false,
            candidateFloor: 0, lexicalBase: 'rrf',
        }).catch(() => {});
        return await capture;
    } finally {
        await lore.dispose();
        // fix/3.22.1-recall-parity review fix (6) — every mkdtempSync() must
        // be rmSync'd in a `finally`, or a failed assertion (which throws
        // before cleanup) leaks a real tmp directory per run.
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

async function runMcpToolCapture(): Promise<Set<string>> {
    const { registerRecallTool } = await import('../packages/lore/src/mcp/tools/search/recallTool.js');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

    let handler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
    const fakeServer = {
        tool(_name: string, _desc: string, _schema: unknown, fn: (args: Record<string, unknown>) => Promise<unknown>) {
            handler = fn;
        },
    } as unknown as InstanceType<typeof McpServer>;

    // Minimal deps: a graph/store double that never actually gets read,
    // because the spy resolves (and the assertion happens) before retrieve()
    // touches any store method.
    const fakeGraph = {
        async search() { return []; },
        async getNodesByIds() { return new Map(); },
        async traverse() { return []; },
        async getNode() { return null; },
    };
    const deps = {
        store: { loreGraph: fakeGraph, loreVerbatim: { count: async () => 0, search: async () => [], bm25Search: async () => ({ hits: [], ranked: true }) }, sessionCache: { get: () => undefined, set: () => {} } },
        detectedScope: { workspace: 'default', ecosystem: '*' },
    } as unknown as Parameters<typeof registerRecallTool>[1];

    registerRecallTool(fakeServer, deps);
    assert.ok(handler, 'registerRecallTool must have registered a handler');

    const capture = captureInProcessKeys(); // same spy — retrieve() is the one shared function
    // Pass every zod-schema arg the `recall` tool declares. Errors AFTER the
    // spy fires (from the minimal fixture graph) are irrelevant — only the
    // captured key set matters.
    (handler as (args: Record<string, unknown>) => Promise<unknown>)({
        topic: 'zzyzxparity', depth: 1, queryLanguage: 'en', filePaths: [],
        mode: 'summary', crossProject: false, includeSuperseded: false,
        tags: ['t'], queries: ['q'], entities: ['e'], topics: ['t'], project: 'p',
        types: ['note'], workspace: 'default', ecosystem: '*', max_tokens: 1000,
        include_archived: false, search_mode: 'keyword', compact: false,
        abstain: false, relevance_floor: 2,
    }).catch(() => {});
    return await capture;
}

await test('every RetrieveOptions key threaded by in-process lore.recall() is either threaded by the MCP recall tool too, or a documented exception', async () => {
    const inProcessKeys = await runInProcessCapture();
    const mcpKeys = await runMcpToolCapture();

    const inProcessOnly = [...inProcessKeys].filter((k) => !mcpKeys.has(k));
    const unexplained = inProcessOnly.filter((k) => !IN_PROCESS_ONLY.has(k) && !NEITHER_EXTRA.has(k));
    assert.deepEqual(
        unexplained, [],
        `in-process lore.recall() threads these retrieve() options that the MCP recall tool does NOT, with no documented exception: ${unexplained.join(', ')}. ` +
        `(in-process keys: ${[...inProcessKeys].sort().join(',')}; mcp keys: ${[...mcpKeys].sort().join(',')})`,
    );
});

await test('every RetrieveOptions key threaded by the MCP recall tool is also threaded by in-process lore.recall()', async () => {
    const inProcessKeys = await runInProcessCapture();
    const mcpKeys = await runMcpToolCapture();

    const mcpOnly = [...mcpKeys].filter((k) => !inProcessKeys.has(k));
    assert.deepEqual(
        mcpOnly, [],
        `the MCP recall tool threads these retrieve() options that in-process lore.recall() does NOT: ${mcpOnly.join(', ')}. ` +
        `(in-process keys: ${[...inProcessKeys].sort().join(',')}; mcp keys: ${[...mcpKeys].sort().join(',')})`,
    );
});

// fix/3.22.1-recall-parity review fix (5) — the two tests above only compare
// KEY SETS (did this surface thread the option at all), which is exactly
// what would have missed the `maxHits` defect: `inProcessRecall.ts` DID
// thread a `max` key into RetrieveOptions (so the key-set tests above stay
// green), the bug was that it never passed `maxHits` into the separate
// buildRecallResult() presentation call. This test compares the ACTUAL
// VALUE `buildRecallResult` receives for `maxHits` across both surfaces,
// given the identical input `max: 37` on each, via a spy on
// buildRecallResult's own params (not retrieve()'s).
function captureBuildRecallResultMaxHits(): Promise<number | undefined> {
    return new Promise((resolve) => {
        setBuildRecallResultParamsSpy((params: RecallPresentationParams) => resolve(params.maxHits));
    });
}

async function runInProcessMaxHits(): Promise<number | undefined> {
    const { createLore } = await import('../packages/lore/src/index.js');
    const { NullEmbeddingProvider } = await import('../packages/lore/src/providers/nullEmbeddingProvider.js');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-parity-maxhits-'));
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        // At least one node must exist: buildRecallResult's spy is the LAST
        // step of a successful recall — an empty workspace can throw earlier
        // in the pipeline (before the presentation layer is ever reached),
        // which would leave `capture` unsettled forever.
        await lore.bulkIngest([
            { id: 'mh-1', workspace: 'default', ecosystem: '*', nodeData: { id: 'mh-1', type: 'note', label: 'mh-1', content: 'zzyzxmaxhits seed', project: 'default', ecosystem: '*' } },
        ], { autolink: false, embed: 'sync' });
        const capture = captureBuildRecallResultMaxHits();
        lore.recall('zzyzxmaxhits', { workspace: 'default', mode: 'summary', searchMode: 'keyword', max: 37 }).catch(() => {});
        return await capture;
    } finally {
        await lore.dispose();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

async function runMcpToolMaxHits(): Promise<number | undefined> {
    const { registerRecallTool } = await import('../packages/lore/src/mcp/tools/search/recallTool.js');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

    let handler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
    const fakeServer = {
        tool(_name: string, _desc: string, _schema: unknown, fn: (args: Record<string, unknown>) => Promise<unknown>) {
            handler = fn;
        },
    } as unknown as InstanceType<typeof McpServer>;

    // Unlike runMcpToolCapture() above (whose fixture only needs to survive
    // long enough for retrieveOptionsSpy to fire, at the TOP of retrieve()),
    // this fixture must reach buildRecallResult() — the LAST step of a
    // successful call — so it needs a fixture that actually resolves a hit:
    // `storageClient.verbatimCount` (not the older `loreVerbatim.count`
    // shape) to cleanly skip the semantic leg, `sessionCache.pushNode`, and
    // one real node from `graph.search()` for the keyword leg to find.
    const MCP_NODE = { id: 'mh-mcp-1', type: 'note', label: 'mh-mcp-1', content: 'zzyzxmaxhits mcp seed', tags: [], project: 'default', ecosystem: '*', language: null, updatedAt: '2026-06-01T00:00:00.000Z' };
    const fakeGraph = {
        async search() { return [MCP_NODE]; },
        async getNodesByIds(ids: string[]) { const m = new Map(); for (const id of ids) if (id === MCP_NODE.id) m.set(id, MCP_NODE); return m; },
        async traverse() { return []; },
        async getNode(id: string) { return id === MCP_NODE.id ? MCP_NODE : null; },
        async listNodes() { return []; },
        async getLanguageBreakdown() { return {}; },
    };
    const deps = {
        store: {
            loreGraph: fakeGraph,
            loreVerbatim: {},
            storageClient: {
                async verbatimCount() { return 0; },
                async verbatimSearch() { throw new Error('semantic path not used by this keyword-mode fixture'); },
                async verbatimBm25Search() { throw new Error('semantic path not used by this keyword-mode fixture'); },
            },
            sessionCache: { get: () => undefined, set: () => {}, pushNode() {} },
        },
        detectedScope: { workspace: 'default', ecosystem: '*' },
    } as unknown as Parameters<typeof registerRecallTool>[1];

    registerRecallTool(fakeServer, deps);
    assert.ok(handler, 'registerRecallTool must have registered a handler');

    const capture = captureBuildRecallResultMaxHits();
    (handler as (args: Record<string, unknown>) => Promise<unknown>)({
        topic: 'zzyzxmaxhits', mode: 'summary', search_mode: 'keyword', workspace: 'default', ecosystem: '*', max: 37, depth: 0,
    }).catch(() => {});
    return await capture;
}

await test('in-process lore.recall({max:37}) and the MCP recall tool({max:37}) pass the SAME maxHits value into buildRecallResult (not just the same key set)', async () => {
    const inProcessMaxHits = await runInProcessMaxHits();
    const mcpMaxHits = await runMcpToolMaxHits();
    assert.equal(inProcessMaxHits, 37, `in-process buildRecallResult() must receive maxHits:37, got ${inProcessMaxHits}`);
    assert.equal(mcpMaxHits, 37, `MCP recall tool's buildRecallResult() must receive maxHits:37, got ${mcpMaxHits}`);
    assert.equal(inProcessMaxHits, mcpMaxHits, `maxHits must match across surfaces: in-process=${inProcessMaxHits}, mcp=${mcpMaxHits}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
