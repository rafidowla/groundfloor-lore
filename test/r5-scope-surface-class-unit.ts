#!/usr/bin/env tsx
/**
 * r5-scope-surface-class-unit.ts — round 5: the surfaces DEC-SCOPE-HONESTY's
 * own "remaining surfaces" enumeration missed, and the ratchets that no longer
 * depend on such an enumeration being complete.
 *
 * Three consecutive rounds have now ended the same way: a round enumerates the
 * call sites it fixed, and the NEXT reviewer — not the enumeration — finds the
 * one it forgot. Round 4's ratchet (r4 G3) greps six NAMED files for the
 * literal `listNodes(…, workspace, …)`; the bug that survived it was
 * `bulkList({project: …})` in a seventh file. So the ratchets here key on the
 * CALL SHAPE across every file under `packages/lore/src`, not on a list of
 * names.
 *
 *   R1/R2 — MCP `list_nodes` passed `project: res.resolvedWorkspace` into
 *       `bulkList()`. Every engine turns `project` into a strict
 *       `n.project = $project` (graphBulkList.ts), so a node living in this
 *       workspace but carrying an explicit `project` (Atlas stores
 *       project='v3' inside workspace='default') was silently dropped. This is
 *       the tool DECISIONS.md and core/ecosystemMatch.ts BOTH name as the
 *       motivating consumer of the widened bulkList pushdown — read twice that
 *       round, edited neither time.
 *
 *   R3/R4 — `list_nodes` also had NO `ecosystem` argument at all, so its
 *       boot-derived default was not overridable and therefore not a
 *       "default". It is an ENUMERATION surface (DEC-SCOPE-SURFACE-CLASS):
 *       default '*', caller states the scope, response states what it enforced.
 *
 *   R5/R6/R7 — GET /api/node-list, whose own comment calls it the "list_nodes
 *       REST sibling" and points at POST /api/nodes/bulk-list for "the same
 *       cursor format", was missed on BOTH axes while its two siblings were
 *       corrected. One primitive, one cursor format, three scoping behaviours.
 *
 *   R8/R9 — MCP `search` reported `deps.detectedScope.workspace` — the boot
 *       cwd — as the workspace it had searched. Round 4 fixed the `ecosystem`
 *       half of that same object literal and left the workspace half, so a
 *       zero-result search against a non-active workspace told the agent that
 *       a DIFFERENT workspace was empty.
 *
 *   R10/R11/R12 — GET /api/subgraph, the REST twin of MCP `traverse`, ran the
 *       same multi-hop BFS over the same LoreEdge rows with NO ecosystem
 *       predicate anywhere. `traverse` gained a per-hop filter for exactly the
 *       reason that applies verbatim here: edges carry no ecosystem, and
 *       autolink drew cross-ecosystem ones.
 *
 *   R13/R14 — `isUnscopedEcosystem` counts FOUR unscoped spellings ('*', '',
 *       undefined, null). Two pushdowns written last round omitted the null
 *       spelling their own siblings carry, so they dropped a row the JS filter
 *       keeps — the fail-closed the settlement exists to prevent, on a
 *       narrower input class.
 *
 *   R15/R16 — the stale rationales: nodeService.ts justified its write-side
 *       `project = workspace` default by asserting that reads filter on it, in
 *       the same uncommitted batch that deleted those filters; providers/
 *       types.ts still documented `ecosystem` as "(exact match)".
 *
 * Every case drives the REAL entry point (registered MCP handler / route
 * handler / engine query builder) or greps the REAL source. Each assertion
 * fails on the pre-fix source.
 *
 * ─── WHAT THE RATCHETS HERE DO AND DO NOT COVER (R6 #6) ──────────────────────
 * Both fire under mutation (reverting `project: undefined` fails R1+R2;
 * stripping `OR ecosystem = NONE` fails R13a+R14), but their advertised scope
 * was overstated, so it is written down instead:
 *
 *   - R2 covers the `bulkList` call shape in three forms: the inline literal,
 *     the `: BulkListQuery` annotated local, and — added in R6 — the
 *     UNANNOTATED local (`const q = {…}; graph.bulkList(q)`). R2c self-tests
 *     that third anchor. It still resolves the local by NAME within one file,
 *     so a query object built in a helper and returned, or spread from
 *     elsewhere, escapes it.
 *   - R2/R2b cover the `bulkList` and `listNodes` families only. A THIRD
 *     scoping primitive would need its own ratchet; nothing here would notice.
 *   - R14 matches a one-line SQL predicate `ecosystem = $ecosystem` under
 *     `engines/`. It cannot see a differently-named bind parameter, a
 *     predicate split across lines, or a filter outside `engines/`. R14b (R6)
 *     closes the fourth gap — the map-shaped pushdown, which is how the ONE
 *     documented exemption (`dataplaneGraph.ts`) is written — by requiring an
 *     explicit allowlist entry with a stale-entry check.
 *
 * License: original work for groundfloor-lore.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerDiagnosticTools } from '../packages/lore/src/mcp/tools/diagnostic.js';
import { registerSearchTool } from '../packages/lore/src/mcp/tools/search/searchTool.js';
import { tryInspectRoutes, type InspectRouteDeps } from '../packages/lore/src/mcp/http/routes/inspect.js';
import { handleSubgraph } from '../packages/lore/src/mcp/http/routes/nodes/subgraph.js';
import type { NodesDeps } from '../packages/lore/src/mcp/http/routes/nodes/types.js';
import { bulkList as surrealBulkList } from '../packages/lore/src/engines/surreal/surrealGraphAggregates.js';
import { bulkListArcadeNodes } from '../packages/lore/src/engines/arcade/arcadeGraphReads.js';
import { ecosystemMatches } from '../packages/lore/src/core/ecosystemMatch.js';
import type { SearchToolsDeps } from '../packages/lore/src/mcp/tools/search/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WORKSPACE = 'shared-ws';
const BOOT_WS = 'boot-ws';
const MINE = 'tenant-alpha';
const THEIRS = 'tenant-beta';

type FNode = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; updatedAt: string; createdAt: string;
};
const fnode = (id: string, ecosystem: string, project = WORKSPACE): FNode => ({
    id, type: 'decision', label: `Label ${id}`, content: `SECRET body for ${id} about auth tokens`,
    tags: ['auth'], project, ecosystem,
    updatedAt: '2026-06-01T00:00:00.000Z', createdAt: '2026-06-01T00:00:00.000Z',
});

/* ─── shared fakes ────────────────────────────────────────────────────── */

/** A graph whose `bulkList` honours the query EXACTLY as every real engine
 *  does: `project` is a strict equality, `ecosystem` is the widened wildcard
 *  predicate. Records the query it was handed. */
function bulkListGraph(rows: FNode[]): {
    graph: { bulkList: (q: Record<string, unknown>) => Promise<unknown> };
    seen: Array<Record<string, unknown>>;
} {
    const seen: Array<Record<string, unknown>> = [];
    const graph = {
        async bulkList(q: Record<string, unknown>) {
            seen.push(q);
            const nodes = rows
                .filter((n) => q['project'] === undefined || n.project === q['project'])
                .filter((n) => ecosystemMatches(n.ecosystem, (q['ecosystem'] as string) ?? '*'))
                .map((n) => ({ ...n }));
            return { nodes, hasMore: false, nextCursor: null };
        },
    };
    return { graph, seen };
}

type McpHandler = (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
type Captured = { handlers: Map<string, McpHandler>; schemas: Map<string, Record<string, unknown>> };
function captureTools(register: (s: McpServer, d: never) => void, deps: unknown): Captured {
    const handlers = new Map<string, McpHandler>();
    const schemas = new Map<string, Record<string, unknown>>();
    const fake = {
        tool(name: string, _d: string, schema: Record<string, unknown>, h: McpHandler) {
            handlers.set(name, h); schemas.set(name, schema);
        },
    };
    register(fake as unknown as McpServer, deps as never);
    return { handlers, schemas };
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

const idsOf = (rows: unknown): string[] => (rows as Array<{ id: string }>).map((r) => r.id);

/* ─── source-tree helpers for the shape ratchets ──────────────────────── */

const SRC_ROOT = join(process.cwd(), 'packages/lore/src');
function walkTs(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walkTs(p, out);
        else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
}
const SRC_FILES = walkTs(SRC_ROOT);
const rel = (p: string): string => p.slice(process.cwd().length + 1);

/** The object literal starting at the first `{` at or after `from`. */
function balancedLiteral(src: string, from: number): string {
    const open = src.indexOf('{', from);
    if (open < 0) return '';
    let depth = 0, i = open;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    return src.slice(open, i + 1);
}

/** Every object literal that reaches `bulkList()`, extracted by brace
 *  balancing rather than by line regex — so a multi-line, comment-heavy
 *  literal is still seen whole. Three anchors:
 *
 *    1. `.bulkList({ … })`            — the inline literal;
 *    2. `: BulkListQuery = { … }`     — the annotated local;
 *    3. `.bulkList(q)` + `const q = { … }` — the UNANNOTATED local, which is
 *       how the bug would most naturally reappear and which the first two
 *       anchors missed entirely (R6 #6a). Resolved by name within the file. */
function bulkListQueryLiterals(src: string): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(/\.bulkList\(\s*\{/g)) out.push(balancedLiteral(src, m.index ?? 0));
    for (const m of src.matchAll(/:\s*BulkListQuery\s*=\s*\{/g)) out.push(balancedLiteral(src, m.index ?? 0));
    for (const m of src.matchAll(/\.bulkList\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
        const name = m[1]!;
        const decl = new RegExp(`(?:const|let|var)\\s+${name}\\b[^=]*=\\s*\\{`).exec(src);
        if (decl) out.push(balancedLiteral(src, decl.index));
    }
    return out;
}

console.log('\nR5 — the surfaces the "remaining surfaces" list missed\n');

/* ─── R1..R4: the MCP `list_nodes` tool ───────────────────────────────── */

function listNodesDeps(rows: FNode[], detectedEcosystem: string) {
    const { graph, seen } = bulkListGraph(rows);
    const deps = {
        store: { loreGraph: graph },
        graphRegistry: { async getGraphHandle() { return graph; }, async getOrOpen() { return graph; } },
        detectedScope: { workspace: BOOT_WS, ecosystem: detectedEcosystem },
        nodeTypesEnum: { optional: () => ({ describe: () => ({}) }) },
        deploymentMode: 'local',
        dataplane: null,
    };
    return { deps, seen };
}
function listNodesTool(rows: FNode[], detectedEcosystem: string) {
    const { deps, seen } = listNodesDeps(rows, detectedEcosystem);
    const cap = captureTools(registerDiagnosticTools as never, deps);
    return { handler: cap.handlers.get('list_nodes')!, schema: cap.schemas.get('list_nodes')!, seen };
}

await test('R1: `list_nodes` returns a node whose `project` differs from the workspace', async () => {
    // atlas-1 lives in THIS workspace but carries project='v3' — the Atlas
    // shape retrieve.ts:314-321 names by name.
    const { handler, seen } = listNodesTool(
        [fnode('mine-1', MINE), fnode('atlas-1', MINE, 'v3')], MINE,
    );
    const out = JSON.parse((await handler({ workspace: WORKSPACE, limit: 100 })).content[0]!.text);
    assert.equal(seen[0]!['project'], undefined,
        `the workspace name was pushed down as the \`project\` filter: ${JSON.stringify(seen[0])}`);
    assert.ok(
        idsOf(out.nodes).includes('atlas-1'),
        `a node in this workspace was dropped because project !== workspace: ${idsOf(out.nodes).join(', ')}`,
    );
});

await test('R2 (ratchet): no bulkList call passes anything but `undefined` as `project`', () => {
    // Shape-based, over EVERY file — r4's ratchet greps six NAMED files for
    // the `listNodes(…, workspace, …)` shape, and the bug that survived it was
    // `bulkList({project: …})` in a seventh file.
    const offenders: string[] = [];
    for (const f of SRC_FILES) {
        for (const lit of bulkListQueryLiterals(readFileSync(f, 'utf8'))) {
            const m = lit.match(/(?:^|[\s,{])project:\s*([^,\n]+)/);
            if (!m) continue; // absent is fine — no project filter at all
            const value = m[1]!.trim().replace(/,$/, '');
            if (value !== 'undefined') offenders.push(`${rel(f)} → project: ${value}`);
        }
    }
    assert.deepEqual(offenders, [],
        `\`project\` is a caller-owned node field, never the workspace name:\n  ${offenders.join('\n  ')}`);
});

await test('R2c (ratchet self-test): the extractor sees an UNANNOTATED local, not just inline literals', () => {
    // R6 #6a — the round that shipped R2 claimed it ends a three-round
    // recurrence, but it anchored only on `.bulkList({` and
    // `: BulkListQuery = {`. `const q = {project: workspace}; graph.bulkList(q)`
    // — the most natural way for the same bug to come back — walked straight
    // through it. A ratchet's advertised scope is a claim like any other, so
    // it gets a test.
    const synthetic = `
        const q = {
            types: undefined,
            project: workspace,   // the bug, laundered through a local
            limit: 50,
        };
        const page = await targetGraph.bulkList(q);
    `;
    const lits = bulkListQueryLiterals(synthetic);
    assert.equal(lits.length, 1, `the unannotated local was invisible to the extractor: ${JSON.stringify(lits)}`);
    assert.match(lits[0]!, /project:\s*workspace/);
});

await test('R2b (ratchet): no call passes the workspace positionally as listNodes\' `project`', () => {
    // Same rule, the other primitive — but over the whole tree instead of the
    // six file names r4 G3 hard-codes.
    const offenders: string[] = [];
    for (const f of SRC_FILES) {
        const src = readFileSync(f, 'utf8');
        if (/listNodes\(\s*[^)]*?,\s*[^,)]*,\s*workspace\s*,/.test(src)) offenders.push(rel(f));
        if (/forEachNodePage\(\s*\w+\s*,\s*workspace\s*,/.test(src)) offenders.push(`${rel(f)} (forEachNodePage)`);
    }
    assert.deepEqual(offenders, [],
        `workspace name still passed as the \`project\` filter:\n  ${offenders.join('\n  ')}`);
});

await test('R3: `list_nodes` exposes an `ecosystem` argument and enforces it', async () => {
    const { handler, schema } = listNodesTool([fnode('mine-1', MINE), fnode('theirs-1', THEIRS)], MINE);
    assert.ok('ecosystem' in schema,
        'a boot-derived scope that the caller cannot override is not a "default" — it is a boundary');
    const out = JSON.parse((await handler({ workspace: WORKSPACE, limit: 100, ecosystem: THEIRS })).content[0]!.text);
    const ids = idsOf(out.nodes);
    assert.deepEqual(ids, ['theirs-1'], `the caller's scope was ignored: ${ids.join(', ')}`);
    assert.equal((out.scope as { ecosystem: string }).ecosystem, THEIRS,
        'the response must report the scope it ENFORCED, not the boot-detected one');
});

await test("R4: `list_nodes` defaults to '*', like its two bulkList siblings", async () => {
    // Enumeration surfaces share ONE primitive and ONE cursor format, so their
    // cursors compose — and cursors composing across surfaces with different
    // default filters silently changes the row set between page 1 and page 2.
    const { handler } = listNodesTool([fnode('mine-1', MINE), fnode('theirs-1', THEIRS)], MINE);
    const out = JSON.parse((await handler({ workspace: WORKSPACE, limit: 100 })).content[0]!.text);
    const ids = idsOf(out.nodes);
    assert.ok(ids.includes('mine-1') && ids.includes('theirs-1'),
        `the boot cwd still decided visibility on an enumeration surface: ${ids.join(', ')}`);
    assert.equal((out.scope as { ecosystem: string }).ecosystem, '*');
});

/* ─── R5..R7: GET /api/node-list, the third member of the triple ──────── */

function inspectDeps(rows: FNode[]): { deps: InspectRouteDeps; seen: Array<Record<string, unknown>> } {
    const { graph, seen } = bulkListGraph(rows);
    return {
        deps: {
            store: { loreGraph: graph },
            detectedScope: { workspace: BOOT_WS, ecosystem: MINE },
            deploymentMode: 'local',
            dataplane: null,
            graphRegistry: { async getGraphHandle() { return graph; } },
        } as unknown as InspectRouteDeps,
        seen,
    };
}
async function callNodeList(deps: InspectRouteDeps, url: string): Promise<Record<string, unknown>> {
    const res = fakeRes();
    const handled = await tryInspectRoutes(
        { method: 'GET', url } as unknown as IncomingMessage, res, url, '/api/node-list', deps,
    );
    assert.ok(handled, 'node-list route not handled');
    assert.equal(res._status, 200, `node-list -> ${res._status}: ${res._body}`);
    return JSON.parse(res._body) as Record<string, unknown>;
}

await test('R5: GET /api/node-list returns a node whose `project` differs from the workspace', async () => {
    const { deps, seen } = inspectDeps([fnode('mine-1', MINE), fnode('atlas-1', MINE, 'v3')]);
    const body = await callNodeList(deps, `/api/node-list?workspace=${WORKSPACE}`);
    assert.equal(seen[0]!['project'], undefined,
        `the workspace name was pushed down as the \`project\` filter: ${JSON.stringify(seen[0])}`);
    assert.ok(
        idsOf(body.nodes).includes('atlas-1'),
        `this workspace's own row was dropped because project !== workspace: ${idsOf(body.nodes).join(', ')}`,
    );
});

await test('R6: GET /api/node-list?ecosystem= confines the page and states the scope', async () => {
    const { deps } = inspectDeps([fnode('mine-1', MINE), fnode('theirs-1', THEIRS)]);
    const body = await callNodeList(deps, `/api/node-list?workspace=${WORKSPACE}&ecosystem=${MINE}`);
    assert.deepEqual(idsOf(body.nodes), ['mine-1'],
        `up to 1000 rows/page of every other tenant's labels, types and tags: ${JSON.stringify(body.nodes)}`);
    assert.equal(body.ecosystem, MINE, 'the response must state the scope it enforced');
});

await test("R7: GET /api/node-list without ?ecosystem= is unconfined, like its POST sibling", async () => {
    const { deps } = inspectDeps([fnode('mine-1', MINE), fnode('theirs-1', THEIRS)]);
    const body = await callNodeList(deps, `/api/node-list?workspace=${WORKSPACE}`);
    const ids = idsOf(body.nodes);
    assert.ok(ids.includes('mine-1') && ids.includes('theirs-1'), `default must stay unconfined: ${ids.join(', ')}`);
    assert.equal(body.ecosystem, '*');
});

/* ─── R8/R9: MCP `search` reports the workspace it actually searched ──── */

function searchToolDeps(): SearchToolsDeps {
    const graph = {
        async search() { return []; },
        async getNodesByIds() { return new Map(); },
        async traverse() { return []; },
        async getNode() { return null; },
        async listNodes() { return []; },
        async getLanguageBreakdown() { return {}; },
    };
    return {
        store: {
            loreGraph: graph,
            loreVerbatim: {},
            sessionCache: { pushNode() { /* noop */ } },
            storageClient: {
                async verbatimCount() { return 0; },
                async verbatimSearch() { return []; },
                async verbatimBm25Search() { return { hits: [], ranked: true }; },
            },
        },
        // The boot cwd resolved to a DIFFERENT workspace than the one the
        // caller is searching — the documented `local` mode (one daemon,
        // several apps).
        detectedScope: { workspace: BOOT_WS, ecosystem: '*' },
        graphRegistry: { async getOrOpen() { return graph; }, async getGraphHandle() { return graph; } },
    } as unknown as SearchToolsDeps;
}

await test('R8: `search` reports the REQUESTED workspace, not the boot-detected one', async () => {
    const cap = captureTools(registerSearchTool as never, searchToolDeps());
    const out = JSON.parse((await cap.handlers.get('search')!({ query: 'auth', workspace: 'other-ws' })).content[0]!.text);
    // The KEY moved from `project` to `workspace` in R6 #3 — it always held a
    // workspace name, and `search` enforces no project filter at all
    // (retrieve.ts runs with workspaceScope='*'). The assertion below is the
    // same one: the reported value is the REQUESTED workspace.
    assert.equal(
        (out.scope as { workspace: string }).workspace, 'other-ws',
        `the reported scope named the daemon's boot directory, not the search: ${JSON.stringify(out.scope)}`,
    );
});

await test('R9: a zero-result `search` does not report the wrong workspace as empty', async () => {
    const cap = captureTools(registerSearchTool as never, searchToolDeps());
    const out = JSON.parse((await cap.handlers.get('search')!({ query: 'auth', workspace: 'other-ws' })).content[0]!.text);
    const ev = String((out._meta as { negative_evidence: string }).negative_evidence);
    assert.ok(ev.includes('other-ws'), `negative evidence must name the workspace that was searched: ${ev}`);
    assert.ok(!ev.includes(BOOT_WS), `negative evidence told the agent a DIFFERENT workspace is empty: ${ev}`);
});

/* ─── R10..R12: GET /api/subgraph, the REST twin of `traverse` ────────── */

type FEdge = { sourceId: string; targetId: string; relation: string; confidence: string };
function subgraphDeps(): NodesDeps {
    // c-1 --(extracted)--> mine-2   (same ecosystem)
    // c-1 --(extracted)--> theirs-2 (autolink drew this across ecosystems)
    // mine-2 --(extracted)--> theirs-2
    const nodes: Record<string, FNode> = {
        'c-1': fnode('c-1', MINE),
        'mine-2': fnode('mine-2', MINE),
        'theirs-2': fnode('theirs-2', THEIRS),
    };
    const edges: FEdge[] = [
        { sourceId: 'c-1', targetId: 'mine-2', relation: 'relates_to', confidence: 'extracted' },
        { sourceId: 'c-1', targetId: 'theirs-2', relation: 'relates_to', confidence: 'extracted' },
        { sourceId: 'mine-2', targetId: 'theirs-2', relation: 'relates_to', confidence: 'extracted' },
    ];
    const graph = {
        async getNode(id: string) { const n = nodes[id]; return n ? { ...n } : null; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, FNode>();
            for (const id of ids) { const n = nodes[id]; if (n) m.set(id, { ...n }); }
            return m;
        },
        async queryEdges(q: { source?: string; target?: string }) {
            return edges
                .filter((e) => (q.source ? e.sourceId === q.source : true))
                .filter((e) => (q.target ? e.targetId === q.target : true))
                .map((e) => ({ ...e }));
        },
    };
    return {
        store: { loreGraph: graph },
        deploymentMode: 'local',
        dataplane: null,
        graphRegistry: { async getGraphHandle() { return graph; }, async getOrOpen() { return graph; } },
    } as unknown as NodesDeps;
}
async function callSubgraph(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = fakeRes();
    await handleSubgraph(res, url, subgraphDeps());
    return { status: res._status, body: JSON.parse(res._body) as Record<string, unknown> };
}

await test('R10: GET /api/subgraph confines the BFS to the requested ecosystem', async () => {
    const { status, body } = await callSubgraph(`/api/subgraph?id=c-1&workspace=${WORKSPACE}&depth=2&ecosystem=${MINE}`);
    assert.equal(status, 200);
    const ids = idsOf(body.nodes);
    assert.ok(ids.includes('mine-2'), `own-ecosystem neighbour must still be walked: ${ids.join(', ')}`);
    assert.ok(
        !ids.includes('theirs-2'),
        `the walk crossed an autolink edge into another ecosystem: ${ids.join(', ')}`,
    );
    const edges = body.edges as Array<{ source: string; target: string }>;
    assert.ok(
        edges.every((e) => e.source !== 'theirs-2' && e.target !== 'theirs-2'),
        `another tenant's edge topology crossed the boundary: ${JSON.stringify(edges)}`,
    );
    assert.equal(body.ecosystem, MINE, 'the response must state the scope it enforced');
});

await test('R11: a centre node outside the scope is a SCOPE result, not "not found"', async () => {
    const { status, body } = await callSubgraph(`/api/subgraph?id=theirs-2&workspace=${WORKSPACE}&ecosystem=${MINE}`);
    assert.equal(status, 404);
    assert.equal(
        body.code, 'node_outside_ecosystem',
        `entering the walk from a foreign node is the same crossing as ending on one: ${JSON.stringify(body)}`,
    );
    assert.doesNotMatch(String(body.message), /not found/i,
        'the row exists and GET /api/node returns it — saying "not found" is untrue');
});

await test('R12: GET /api/subgraph without ?ecosystem= walks everything (unchanged)', async () => {
    const { status, body } = await callSubgraph(`/api/subgraph?id=c-1&workspace=${WORKSPACE}&depth=2`);
    assert.equal(status, 200);
    const ids = idsOf(body.nodes);
    assert.ok(ids.includes('mine-2') && ids.includes('theirs-2'), `default must stay unconfined: ${ids.join(', ')}`);
});

/* ─── R13/R14: all FOUR unscoped spellings in every pushdown ──────────── */

function recordingRows(): { fn: (sql: string, params?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>; calls: Array<{ sql: string; params: Record<string, unknown> }> } {
    const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
    return {
        calls,
        fn: async (sql: string, params?: Record<string, unknown>) => { calls.push({ sql, params: params ?? {} }); return []; },
    };
}

/** `isUnscopedEcosystem` counts FOUR spellings. A pushdown that accepts three
 *  of them drops a row the JS filter keeps, which is precisely the thing the
 *  settlement says a pushdown can never do. */
function assertAllFourSpellings(column: string, sql: string, nullSpelling: RegExp): void {
    // `column` arrives regex-escaped ('ecosystem' / 'n\\.ecosystem').
    const arms: Array<[string, RegExp]> = [
        ['the bound scope', new RegExp(`${column}\\s*=\\s*[$:]ecosystem`)],
        ["'*'", new RegExp(`${column}\\s*=\\s*'\\*'`)],
        ["''", new RegExp(`${column}\\s*=\\s*''`)],
    ];
    for (const [name, re] of arms) {
        assert.match(sql, re, `pushdown is missing the ${name} arm:\n${sql}`);
    }
    assert.match(sql, nullSpelling,
        `pushdown drops a row whose ecosystem is unset — isUnscopedEcosystem() keeps it:\n${sql}`);
}

await test('R13a: Surreal bulkList accepts the NONE spelling its three siblings accept', async () => {
    const rec = recordingRows();
    await surrealBulkList(rec.fn as never, { limit: 10, ecosystem: MINE });
    assertAllFourSpellings('ecosystem', rec.calls[0]!.sql, /ecosystem\s*=\s*NONE/);
});

await test('R13b: Arcade bulkList accepts the NULL spelling its two siblings accept', async () => {
    const calls: Array<{ sql: string }> = [];
    const http = {
        async query(_db: string, sql: string) { calls.push({ sql }); return { result: [] }; },
    };
    await bulkListArcadeNodes('db', http as never, 'LoreNode', { limit: 10, ecosystem: MINE });
    assertAllFourSpellings('ecosystem', calls[0]!.sql, /ecosystem\s+IS\s+NULL/);
});


await test('R14 (ratchet): every engine ecosystem READ predicate carries all four arms', () => {
    // Shape-based across every engine file under `packages/lore/src/engines/`.
    //
    // ADVERTISED SCOPE, precisely (R6 #6b — the previous comment claimed this
    // catches any new backend shipping a strict-equality pushdown, which it
    // does not): it matches a SQL/Cypher predicate written as
    // `ecosystem = $ecosystem` / `= :ecosystem` on ONE line, inside
    // `engines/`. It CANNOT see a predicate that binds the parameter under
    // another name, splits across lines, lives outside `engines/`, or is
    // expressed as a filter MAP rather than SQL. R14b below closes the last of
    // those; the first three remain open and are stated in DECISIONS.md rather
    // than claimed closed.
    //
    // Write statements (`SET … ecosystem = $ecosystem, …`) are excluded by the
    // trailing comma; a read predicate is never followed by one.
    const offenders: string[] = [];
    for (const f of SRC_FILES.filter((p) => p.includes(`${join('packages/lore/src', 'engines')}`) || rel(p).startsWith('packages/lore/src/engines/'))) {
        const src = readFileSync(f, 'utf8');
        for (const line of src.split('\n')) {
            const hit = /(?:\w+\.)?ecosystem\s*=\s*[$:]ecosystem(?!\s*,)/.exec(line);
            if (!hit) continue;
            const group = /\(([^()]*(?:\w+\.)?ecosystem\s*=\s*[$:]ecosystem[^()]*)\)/.exec(line);
            if (!group) { offenders.push(`${rel(f)}: unparenthesised predicate → ${line.trim().slice(0, 100)}`); continue; }
            const g = group[1]!;
            const missing: string[] = [];
            if (!/=\s*'\*'/.test(g)) missing.push("'*'");
            if (!/=\s*''/.test(g)) missing.push("''");
            if (!/(IS\s+NULL|=\s*NONE)/.test(g)) missing.push('null/NONE');
            if (missing.length > 0) offenders.push(`${rel(f)}: missing ${missing.join(' + ')} → ${g.slice(0, 110)}`);
        }
    }
    assert.deepEqual(offenders, [],
        `a pushdown that drops a row ecosystemMatches() keeps is not an optimisation:\n  ${offenders.join('\n  ')}`);
});

await test('R14b (ratchet): a non-SQL ecosystem equality pushdown must be an ALLOWLISTED exemption', () => {
    // R6 #6b — `engines/dataplaneGraph.ts` writes its pushdown as a filter map
    // (`filter['ecosystem'] = q.ecosystem`), which is a strict equality that
    // R14's SQL-shaped regex cannot see. It is the ONE documented exemption
    // (core/ecosystemMatch.ts: the SDK filter cannot express the OR, cloud is
    // deferred, no local/embedded read reaches it) — but to R14 it was
    // indistinguishable from an accident, which is the same "documented
    // invariant the ratchet does not actually hold" shape this whole round is
    // about. Now a NEW backend adding the map form fails until it is either
    // widened or written down here.
    const ALLOWED = new Set(['packages/lore/src/engines/dataplaneGraph.ts']);
    const offenders: string[] = [];
    for (const f of SRC_FILES.filter((p) => rel(p).startsWith('packages/lore/src/engines/'))) {
        const src = readFileSync(f, 'utf8');
        for (const line of src.split('\n')) {
            // `filter['ecosystem'] = X` / `filter.ecosystem = X` / `{ ecosystem: X }`
            // inside something named like a filter/where/query bag.
            if (!/(?:filter|where|query|criteria)\s*(?:\[\s*['"]ecosystem['"]\s*\]|\.ecosystem)\s*=[^=]/.test(line)) continue;
            if (ALLOWED.has(rel(f))) continue;
            offenders.push(`${rel(f)}: ${line.trim().slice(0, 110)}`);
        }
    }
    assert.deepEqual(offenders, [],
        `a map-shaped ecosystem equality is still a strict equality — widen it or add it to the documented exemption list:\n  ${offenders.join('\n  ')}`);
    // Stale-entry ratchet, the same discipline D-021's allowlist uses: an
    // exemption that no longer violates must be REMOVED, or the list rots into
    // a permanent excuse.
    for (const entry of ALLOWED) {
        const src = readFileSync(join(process.cwd(), entry), 'utf8');
        assert.match(src, /(?:filter|where|query|criteria)\s*(?:\[\s*['"]ecosystem['"]\s*\]|\.ecosystem)\s*=[^=]/,
            `${entry} is allowlisted but no longer carries a map-shaped ecosystem pushdown — drop the entry`);
    }
});

/* ─── R15/R16: the rationales that outlived the code they cited ───────── */

await test('R15: nodeService.ts no longer justifies its write default by a read filter that was deleted', () => {
    const src = readFileSync(join(SRC_ROOT, 'core/nodeService.ts'), 'utf8');
    assert.ok(
        !/all filter `n\.project = <workspace>`/.test(src),
        'the same batch that wrote this sentence removed that filter from seven call sites; a stale rationale gets cited as authority in a later round',
    );
});

await test('R16: providers/types.ts no longer documents `ecosystem` as an exact match', () => {
    const src = readFileSync(join(SRC_ROOT, 'providers/types.ts'), 'utf8');
    assert.ok(
        !/@param ecosystem[^\n]*\(exact match\)/.test(src),
        "'*'/''/unset are WILDCARDS on both sides (DEC-ECOSYSTEM-WILDCARD) — the contract doc still said exact match",
    );
});

await test('R17: DECISIONS.md states which default each surface CLASS takes', () => {
    const src = readFileSync(join(process.cwd(), 'DECISIONS.md'), 'utf8');
    assert.match(src, /DEC-SCOPE-SURFACE-CLASS/,
        'rule 3 asserted an invariant four surfaces did not hold, with no stated rule for picking a default');
    assert.match(src, /NARROWED same-day by DEC-SCOPE-SURFACE-CLASS/,
        'the superseded rule must carry the link forward rather than being edited into agreement');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
