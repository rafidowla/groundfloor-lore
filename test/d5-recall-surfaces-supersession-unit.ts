#!/usr/bin/env tsx
/**
 * d5-recall-surfaces-supersession-unit.ts — D5 #5 round-5 coverage.
 *
 * d5-supersedes-corrects-unit.ts already covers `retrieve()`'s own
 * successor-replacement + `corrects` adjacency (the shared core). This file
 * covers the OTHER surfaces round-5 routed through the same
 * `recall/supersessionRecall.ts` helpers, which previously only HIDE a
 * superseded node (`!n.supersededAt` filter) instead of replacing it with
 * its live successor:
 *
 *  - POST /api/query (routes/search.ts, via apiQueryHydration.ts) — a
 *    "raw exact-match" surface that gets successor REPLACEMENT only, no
 *    `corrects` adjacency (see apiQueryHydration.ts's doc comment for why).
 *  - MCP `search` tool's legacy `workspace:"*"` fallback branch
 *    (searchTool.ts) — same replacement-only contract.
 *  - Cross-workspace recall (`runCrossWorkspaceRecall`,
 *    recallCrossWorkspace.ts) — per-workspace successor replacement across
 *    a real multi-workspace registry.
 *
 * Every case here reproduces main's pre-D5-round-5 bug: the superseded
 * node's stale slot either vanished from the result set entirely, or (for
 * /api/query specifically) was returned with its stale content unchanged.
 *
 * Run: npx tsx test/d5-recall-surfaces-supersession-unit.ts (no npm script
 * wrapper needed — mirrors d5-write-paths-refusal-unit.ts / import-routes-
 * unit.ts / fc1-changeset-verbatim-unit.ts).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

type FNode = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; language: string | null; updatedAt: string;
    supersededBy?: string; status?: string;
};
const fnode = (id: string, over: Partial<FNode> = {}): FNode => ({
    id, type: 'note', label: `Label ${id}`, content: `content body for ${id}`,
    tags: [], project: 'ws', ecosystem: '*', language: null,
    updatedAt: '2026-06-01T00:00:00.000Z', ...over,
});

/* ─── Part 1: POST /api/query — successor replacement ─────────────────── */

await (async () => {
    console.log('D5 round-5 #5 — POST /api/query successor replacement');

    const { trySearchRoutes } = await import('../packages/lore/src/mcp/http/routes/search.js');
    type SearchDeps = import('../packages/lore/src/mcp/http/routes/search.js').SearchDeps;

    const NODES: Record<string, FNode> = {
        old: fnode('old', { supersededBy: 'new' }),
        new: fnode('new'),
    };

    function buildDeps(): SearchDeps {
        const graph = {
            async search(_q: string, _limit: number, _project: string, _ecosystem: string, _excludeHidden: boolean, signals: { scanCapHit: boolean }) {
                void _q; void _limit; void _project; void _ecosystem; void _excludeHidden;
                signals.scanCapHit = false;
                return [{ ...NODES.old }];
            },
            async getNodesByIds(ids: string[]) {
                const m = new Map<string, FNode>();
                for (const id of ids) { const x = NODES[id]; if (x) m.set(id, { ...x }); }
                return m;
            },
            async getNode(id: string) { const x = NODES[id]; return x ? { ...x } : null; },
        };
        const store = {
            loreGraph: graph,
            sessionCache: { pushNode() { /* noop */ } },
            storageClient: {
                async verbatimCount() { return 0; },
                async verbatimSearch() { return []; },
                async verbatimBm25Search() { return { hits: [], ranked: false }; },
            },
        };
        const graphRegistry = { async getGraphHandle(_ws: string) { void _ws; return graph; } };
        const detectedScope = { workspace: 'ws', ecosystem: '*' };
        return { store, detectedScope, deploymentMode: 'local', dataplane: null, graphRegistry } as unknown as SearchDeps;
    }

    async function postQuery(deps: SearchDeps, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
        let status = 0; let out = '';
        const bodyStr = JSON.stringify(body);
        const req = Readable.from([Buffer.from(bodyStr)]) as unknown as IncomingMessage;
        (req as unknown as { method: string }).method = 'POST';
        (req as unknown as { url: string }).url = '/api/query';
        (req as unknown as { headers: Record<string, string> }).headers = { 'content-length': String(bodyStr.length) };
        const res = {
            writeHead(s: number) { status = s; return this; },
            end(chunk?: string) { out = chunk ?? ''; },
        } as unknown as ServerResponse;
        const handled = await trySearchRoutes(req, res, '/api/query', '/api/query', deps);
        assert.ok(handled, 'POST /api/query was not handled');
        return { status, json: out ? JSON.parse(out) : null };
    }

    await test('POST /api/query mode=search: a superseded seed is replaced by its live successor, not hidden', async () => {
        const deps = buildDeps();
        const { status, json } = await postQuery(deps, { query: 'q', workspace: 'ws', mode: 'search' });
        assert.equal(status, 200);
        const ids = json.results.map((r: any) => r.id);
        assert.deepEqual(ids, ['new'], `expected the live successor "new" in place of superseded "old", got ${JSON.stringify(ids)}`);
    });

    await test('POST /api/query mode=search: successor already collapses onto an existing distinct id (no duplicate)', async () => {
        const deps = buildDeps();
        // Both "old" (superseded → new) and "new" itself match the raw scan —
        // the resolved list must not contain "new" twice.
        const graph = (deps as any).store.loreGraph;
        graph.search = async (_q: string, _limit: number, _project: string, _ecosystem: string, _excludeHidden: boolean, signals: { scanCapHit: boolean }) => {
            void _q; void _limit; void _project; void _ecosystem; void _excludeHidden;
            signals.scanCapHit = false;
            return [{ ...NODES.old }, { ...NODES.new }];
        };
        const { json } = await postQuery(deps, { query: 'q', workspace: 'ws', mode: 'search' });
        const ids = json.results.map((r: any) => r.id);
        assert.deepEqual(ids, ['new'], `expected exactly one "new", got ${JSON.stringify(ids)}`);
    });
})();

/* ─── Part 2: MCP `search` tool, workspace="*" legacy branch ──────────── */

await (async () => {
    console.log('\nD5 round-5 #5 — MCP `search` workspace="*" successor replacement');

    const { registerSearchTool } = await import('../packages/lore/src/mcp/tools/search/searchTool.js');

    const NODES: Record<string, FNode> = {
        old: fnode('old', { supersededBy: 'new' }),
        new: fnode('new'),
    };

    function buildToolDeps() {
        const graph = {
            async search(_q: string, _limit: number, _project: string, _ecosystem: string, _excludeHidden: boolean, signals: { scanCapHit: boolean }) {
                void _q; void _limit; void _project; void _ecosystem; void _excludeHidden;
                signals.scanCapHit = false;
                return [{ ...NODES.old }];
            },
            async getNodesByIds(ids: string[]) {
                const m = new Map<string, FNode>();
                for (const id of ids) { const x = NODES[id]; if (x) m.set(id, { ...x }); }
                return m;
            },
            async getNode(id: string) { const x = NODES[id]; return x ? { ...x } : null; },
        };
        const store = {
            loreGraph: graph,
            storageClient: {
                async verbatimSearch() { return []; },
            },
        };
        const detectedScope = { workspace: 'default', ecosystem: '*' };
        return { store, detectedScope, graphRegistry: { async getGraphHandle() { return graph; } } } as unknown as import('../packages/lore/src/mcp/tools/search/types.js').SearchToolsDeps;
    }

    function captureTool(toolDeps: ReturnType<typeof buildToolDeps>) {
        let handler: ((args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) | null = null;
        const fake = { tool(_name: string, _desc: string, _schema: unknown, h: typeof handler) { void _name; void _desc; void _schema; handler = h; } };
        registerSearchTool(fake as unknown as McpServer, toolDeps);
        return handler!;
    }

    await test('MCP `search` workspace="*": a superseded hit is replaced by its live successor, not hidden', async () => {
        const toolDeps = buildToolDeps();
        const handler = captureTool(toolDeps);
        const res = await handler({ query: 'q', workspace: '*', search_mode: 'keyword' });
        assert.ok(!res.isError, `search returned an error: ${res.content?.[0]?.text}`);
        const out = JSON.parse(res.content[0]!.text);
        const ids = (out.results ?? out.knowledge ?? []).map((r: any) => r.id ?? r.node?.id);
        assert.deepEqual(ids, ['new'], `expected the live successor "new" in place of superseded "old", got ${JSON.stringify(ids)}`);
    });
})();

/* ─── Part 3: cross-workspace recall — per-workspace replacement ──────── */

await (async () => {
    console.log('\nD5 round-5 #5 — cross-workspace recall successor replacement');

    const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'd5-cross-ws-'));
    process.env['LORE_HOME'] = TEST_HOME;

    function seedWorkspaces(home: string, names: string[]): void {
        const workspaces = names.map((name) => ({
            name, path: path.join(home, 'workspaces', name),
            createdAt: '2026-06-15T00:00:00.000Z', graphEngine: 'surreal' as const,
        }));
        fs.mkdirSync(home, { recursive: true });
        for (const w of workspaces) fs.mkdirSync(path.join(w.path, '.lore'), { recursive: true });
        fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({ active: names[0]!, workspaces }, null, 2));
    }
    seedWorkspaces(TEST_HOME, ['ws-a']);

    const { runCrossWorkspaceRecall } = await import('../packages/lore/src/mcp/tools/recallCrossWorkspace.js');

    const NODES: Record<string, FNode> = {
        old: fnode('old', { supersededBy: 'new', project: 'ws-a' }),
        new: fnode('new', { project: 'ws-a' }),
    };

    const wsGraph = {
        async search(_topic: string, _limit: number, _project: string, _ecosystem: string, _excludeHidden: boolean, signals: { scanCapHit: boolean }) {
            void _topic; void _limit; void _project; void _ecosystem; void _excludeHidden;
            signals.scanCapHit = false;
            return [{ ...NODES.old }];
        },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, FNode>();
            for (const id of ids) { const x = NODES[id]; if (x) m.set(id, { ...x }); }
            return m;
        },
    };
    const registry = {
        async getGraphHandle(_ws: string) { void _ws; return wsGraph; },
        homeDir() { return TEST_HOME; },
    };
    const verbatimStore = { async count() { return 0; }, async search() { return []; } };

    await test('cross-workspace recall: a superseded per-workspace hit is replaced by its live successor', async () => {
        const res = await runCrossWorkspaceRecall({
            topic: 'q',
            registry: registry as any,
            verbatimStore: verbatimStore as any,
            sessionCache: { pushNode() { /* noop */ } } as any,
            responseMode: 'full',
        } as any);
        assert.ok(!res.isError, `runCrossWorkspaceRecall returned an error: ${res.content?.[0]?.text}`);
        const out = JSON.parse(res.content[0]!.text);
        const ids: string[] = (out.knowledge ?? out.results ?? []).map((r: any) => r.id ?? r.node?.id);
        assert.ok(ids.includes('new'), `expected live successor "new" among results, got ${JSON.stringify(ids)}`);
        assert.ok(!ids.includes('old'), `superseded "old" should not appear directly, got ${JSON.stringify(ids)}`);
    });

    // Semantic-only path: "old" is a vector hit, "new" (its successor) does
    // NOT match the query on its own (keyword scan returns nothing). Before
    // the fix the per-workspace RRF still looked up "old"'s id, missed, and
    // dropped the slot — neither node came back.
    const kwMissGraph = { ...wsGraph, async search(_t: string, _l: number, _p: string, _e: string, _x: boolean, signals: { scanCapHit: boolean }) {
        void _t; void _l; void _p; void _e; void _x; signals.scanCapHit = false; return [];
    } };
    const kwMissRegistry = { ...registry, async getGraphHandle(_ws: string) { void _ws; return kwMissGraph; } };
    const semStore = { async count() { return 1; }, async search() { return [{ id: 'lore:old', score: 0.9 }]; } };
    const resultIds = (res: any): string[] => {
        assert.ok(!res.isError, `runCrossWorkspaceRecall returned an error: ${res.content?.[0]?.text}`);
        const out = JSON.parse(res.content[0]!.text);
        return (out.knowledge ?? out.results ?? []).map((r: any) => r.id ?? r.node?.id);
    };
    const base = { topic: 'q', sessionCache: { pushNode() { /* noop */ } }, responseMode: 'full' };

    await test('cross-workspace recall (boot-store seeds): superseded semantic-only hit → successor in its slot', async () => {
        const ids = resultIds(await runCrossWorkspaceRecall({ ...base, registry: kwMissRegistry, verbatimStore: semStore } as any));
        assert.deepEqual(ids, ['new'], `expected ["new"], got ${JSON.stringify(ids)}`);
    });
    await test('cross-workspace recall (per-workspace seeds): superseded semantic-only hit → successor in its slot', async () => {
        const ids = resultIds(await runCrossWorkspaceRecall({
            ...base, registry: kwMissRegistry, verbatimStore,
            workspaceVerbatimResolver: { async getOrOpen() { return semStore; } },
        } as any));
        assert.deepEqual(ids, ['new'], `expected ["new"], got ${JSON.stringify(ids)}`);
    });

    fs.rmSync(TEST_HOME, { recursive: true, force: true });
})();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
