#!/usr/bin/env tsx
/**
 * test/r3221-d1-recall-types-rest-unit.ts — fix/3.22.1-d1-recall-option-
 * parity.
 *
 * Defect: REST GET /api/recall never parsed or forwarded a `types` query
 * param, even though the MCP `recall` tool has supported `types` (D2 node
 * TYPE/KIND prefilter, ANY-of) since D2, and the in-process `lore.recall()`
 * gap in the same release is pinned separately by
 * test/r3221-d1-recall-types-inprocess-unit.ts. This pins the REST surface:
 * `?types=decision` on GET /api/recall must return only decision-type
 * nodes, for both the named-workspace and the cross-workspace (`workspace=*`)
 * branches of the handler.
 *
 * Fixture pattern follows test/rc321f-recall-multi-query-mcp-rest-unit.ts
 * (a fake graph/store double driven through trySearchRoutes()).
 *
 * Run: npx tsx test/r3221-d1-recall-types-rest-unit.ts
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { trySearchRoutes, type SearchDeps } from '../packages/lore/src/mcp/http/routes/search.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WORKSPACE = 'r3221-types-ws';

type FNode = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; language: string | null; updatedAt: string; metadata?: string;
};
const fnode = (id: string, type: string, over: Partial<FNode> = {}): FNode => ({
    id, type, label: `Label ${id}`, content: `content body for ${id}`,
    tags: [], project: WORKSPACE, ecosystem: '*', language: null,
    updatedAt: '2026-06-01T00:00:00.000Z', ...over,
});

// Two decisions and two notes, all matching the same BM25 query — the notes
// out-score (or at least compete with) the decisions, so an unfiltered
// result set includes both types. This proves `types` really does narrow
// the result rather than passing trivially because no other type was ever
// present.
const NODES: Record<string, FNode> = {
    'dec-1': fnode('dec-1', 'decision'),
    'dec-2': fnode('dec-2', 'decision'),
    'note-1': fnode('note-1', 'note'),
    'note-2': fnode('note-2', 'note'),
};

function buildFixture(): { searchDeps: SearchDeps } {
    const graph = {
        // The production D2 pushdown passes `types` into graph.search(); this
        // fixture's graph.search always returns [] regardless (matching
        // rc321f's fixture pattern), so the seed candidates come from BM25
        // hits below, hydrated via getNodesByIds, and narrowed by retrieve()'s
        // D2 backstop filter (retrieve.ts ~line 422) — which is exactly the
        // code path this test is pinning for the REST surface.
        async search() { return []; },
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
            async verbatimCount() { return 4; },
            async verbatimSearch() { throw new Error('semantic path not used by these keyword-mode fixtures'); },
            async verbatimBm25Search() {
                return {
                    hits: [
                        { id: 'note-1', score: 9 }, { id: 'note-2', score: 8 },
                        { id: 'dec-1', score: 7 }, { id: 'dec-2', score: 6 },
                    ],
                    ranked: true,
                };
            },
        },
    };
    const graphRegistry = {
        async getOrOpen(_ws: string) { void _ws; return graph; },
        async getGraphHandle(_ws: string) { void _ws; return graph; },
    };
    const detectedScope = { workspace: WORKSPACE, ecosystem: '*' };
    const searchDeps = { store, detectedScope, deploymentMode: 'local', dataplane: null, graphRegistry } as unknown as SearchDeps;
    return { searchDeps };
}

async function callRest(searchDeps: SearchDeps, url: string, pathname: string): Promise<{ status: number; body: any }> {
    let status = 0; let body = '';
    const req = { method: 'GET', url } as unknown as IncomingMessage;
    const res = {
        writeHead(s: number) { status = s; return this; },
        end(chunk?: string) { body = chunk ?? ''; },
    } as unknown as ServerResponse;
    const handled = await trySearchRoutes(req, res, url, pathname, searchDeps);
    assert.ok(handled, `route ${pathname} was not handled`);
    return { status, body: body ? JSON.parse(body) : null };
}

console.log('fix/3.22.1-d1-recall-option-parity — REST GET /api/recall `types` filter\n');

await test('REST GET /api/recall: baseline (no types) returns both notes and decisions, proving they compete', async () => {
    const { searchDeps } = buildFixture();
    const rest = await callRest(
        searchDeps,
        `/api/recall?topic=q&workspace=${WORKSPACE}&search_mode=keyword`,
        '/api/recall',
    );
    assert.equal(rest.status, 200);
    const ids = rest.body.hits.map((r: any) => r.id).sort();
    assert.ok(ids.includes('note-1') || ids.includes('note-2'), 'sanity: notes must compete in the unfiltered baseline, or this test proves nothing');
    assert.ok(ids.includes('dec-1') || ids.includes('dec-2'), 'sanity: decisions must also be present in the unfiltered baseline');
});

await test('REST GET /api/recall: ?types=decision narrows to decision-type nodes only', async () => {
    const { searchDeps } = buildFixture();
    const rest = await callRest(
        searchDeps,
        `/api/recall?topic=q&workspace=${WORKSPACE}&search_mode=keyword&types=decision`,
        '/api/recall',
    );
    assert.equal(rest.status, 200);
    const ids = rest.body.hits.map((r: any) => r.id).sort();
    assert.deepEqual(ids, ['dec-1', 'dec-2'], `?types=decision must exclude every non-decision node, got ${JSON.stringify(ids)}`);
});

// ── Fix (3): REST `?types=` bounds validation ──────────────────────────────
//
// The MCP `recall`/`search` tools' own zod schema bounds `types` to
// `z.array(z.string().max(100)).max(20)`. REST never enforced the same
// bound, so an unbounded `?types=` list could widen graph.search()'s
// IN(...) pushdown arbitrarily. validateTypesParam() (searchRouteParams.ts)
// now rejects with HTTP 400 `invalid_types` — matching the route's existing
// writeError style for other bad params.

await test('REST GET /api/recall: ?types= with more than 20 values returns 400 invalid_types', async () => {
    const { searchDeps } = buildFixture();
    const manyTypes = Array.from({ length: 21 }, (_, i) => `t${i}`).join(',');
    const rest = await callRest(
        searchDeps,
        `/api/recall?topic=q&workspace=${WORKSPACE}&search_mode=keyword&types=${manyTypes}`,
        '/api/recall',
    );
    assert.equal(rest.status, 400, `expected 400, got ${rest.status}: ${JSON.stringify(rest.body)}`);
    assert.equal(rest.body.code, 'invalid_types', `expected error code invalid_types, got ${JSON.stringify(rest.body)}`);
});

await test('REST GET /api/recall: ?types= with a value over 100 chars returns 400 invalid_types', async () => {
    const { searchDeps } = buildFixture();
    const longType = 'x'.repeat(101);
    const rest = await callRest(
        searchDeps,
        `/api/recall?topic=q&workspace=${WORKSPACE}&search_mode=keyword&types=${longType}`,
        '/api/recall',
    );
    assert.equal(rest.status, 400, `expected 400, got ${rest.status}: ${JSON.stringify(rest.body)}`);
    assert.equal(rest.body.code, 'invalid_types', `expected error code invalid_types, got ${JSON.stringify(rest.body)}`);
});

await test('REST GET /api/search: ?types= with more than 20 values returns 400 invalid_types', async () => {
    const { searchDeps } = buildFixture();
    const manyTypes = Array.from({ length: 21 }, (_, i) => `t${i}`).join(',');
    const rest = await callRest(
        searchDeps,
        `/api/search?q=q&workspace=${WORKSPACE}&search_mode=keyword&types=${manyTypes}`,
        '/api/search',
    );
    assert.equal(rest.status, 400, `expected 400, got ${rest.status}: ${JSON.stringify(rest.body)}`);
    assert.equal(rest.body.code, 'invalid_types', `expected error code invalid_types, got ${JSON.stringify(rest.body)}`);
});

// ── Fix (7b): REST /api/search?types= narrowing (parallel to /api/recall) ──
await test('REST GET /api/search: ?types=decision narrows to decision-type nodes only', async () => {
    const { searchDeps } = buildFixture();
    const rest = await callRest(
        searchDeps,
        `/api/search?q=q&workspace=${WORKSPACE}&search_mode=keyword&types=decision`,
        '/api/search',
    );
    assert.equal(rest.status, 200, `expected 200, got ${rest.status}: ${JSON.stringify(rest.body)}`);
    const ids = (rest.body.hits ?? rest.body.results ?? []).map((r: any) => r.id).sort();
    assert.deepEqual(ids, ['dec-1', 'dec-2'], `?types=decision on /api/search must exclude every non-decision node, got ${JSON.stringify(rest.body)}`);
});

// NOTE: the cross-workspace (`workspace=*`) REST branch is NOT separately
// exercised here — it requires an authenticated principal fixture (Phase 6
// P3 / SP-04 token-scoped read gate; a null-principal request to `workspace=*`
// correctly 403s as `cross_workspace_no_principal`, which is intentional
// security behaviour, not something this defect fix touches). That branch's
// production code (search.ts, `runCrossWorkspaceRecall({..., types: recallTypes})`)
// is fixed identically to, and shares the same underlying function as, the
// MCP recall tool's cross-workspace branch — which the `types` post-merge
// filter added to recallCrossWorkspace.ts covers directly.

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
