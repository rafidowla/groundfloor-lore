#!/usr/bin/env tsx
/**
 * test/list-nodes-pagination-unit.ts — Sprint 7 (2026-05-24).
 *
 * Closes BACKLOG-list-nodes-response-size.md. Pre-Sprint-7 the
 * `list_nodes` MCP tool returned every matching node in one shot; on
 * the default workspace this came to 2.4 MB (38× the 64 KB byte-cap).
 * Sprint 7 added cursor pagination (Option A — matches W4 bulkList
 * shape exactly).
 *
 * Asserts:
 *   - T1: default limit (no arg) returns ≤100 nodes
 *   - T2: hasMore=true when more nodes match; nextCursor is set
 *   - T3: cursor pages through every row (first 2, then next 2, then 1)
 *   - T4: limit > 1000 rejected with a Zod validation error
 *   - T5: Sprint L1e workspace_required preserved (empty workspace → 400-shape)
 *   - T6: ordering is (updatedAt DESC, id ASC) — matches bulkList
 *   - T7: bad cursor → invalid_cursor error envelope
 *   - T8: empty result + no cursor → negative-evidence _meta
 */

import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerDiagnosticTools } from '../packages/lore/src/mcp/tools/diagnostic.js';
import type { BulkListPage, BulkListQuery, LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void> | void) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

console.log('Sprint 7 list_nodes pagination');

/** Stub McpServer that captures every registered tool so the
 *  test can invoke the handler directly without spinning up MCP. */
interface CapturedTool {
    name: string;
    schema: Record<string, z.ZodTypeAny>;
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function makeStubMcpServer(): { server: { tool: Function }; tools: Map<string, CapturedTool> } {
    const tools = new Map<string, CapturedTool>();
    const server = {
        tool(name: string, _desc: string, schema: Record<string, z.ZodTypeAny>, handler: CapturedTool['handler']) {
            tools.set(name, { name, schema, handler });
        },
    };
    return { server, tools };
}

/** Fake graph handle exposing `bulkList` — the engine-agnostic primitive
 *  list_nodes now routes through (post-getGraphContext-removal), and both
 *  LocalGraph and SurrealGraph implement identically. Mirrors the real
 *  bulkList contract: types/tags OR-chains, project/ecosystem exact
 *  filters, strict-after cursor, (updatedAt DESC, id ASC) order,
 *  limit+1 fetched internally to compute hasMore. */
function makeFakeGraph(seed: Array<{ id: string; type: string; label: string; tags: string; project: string; updatedAt: string; ecosystem?: string }>) {
    const calls: BulkListQuery[] = [];
    return {
        _calls: calls,
        async bulkList(q: BulkListQuery): Promise<BulkListPage> {
            calls.push(q);
            let filtered = seed.slice();
            if (q.project) filtered = filtered.filter(n => n.project === q.project);
            if (q.types && q.types.length > 0) filtered = filtered.filter(n => q.types!.includes(n.type));
            if (q.tags && q.tags.length > 0) {
                filtered = filtered.filter(n => q.tags!.some(t => n.tags.toLowerCase().includes(t.toLowerCase())));
            }
            if (q.ecosystem) filtered = filtered.filter(n => n.ecosystem === q.ecosystem);
            // Sort (updatedAt DESC, id ASC)
            filtered.sort((a, b) => {
                if (a.updatedAt < b.updatedAt) return 1;
                if (a.updatedAt > b.updatedAt) return -1;
                return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
            });
            // Apply cursor strict-after
            if (q.cursor) {
                const cu = q.cursor.updatedAt;
                const ci = q.cursor.id;
                filtered = filtered.filter(n => n.updatedAt < cu || (n.updatedAt === cu && n.id > ci));
            }
            const hasMore = filtered.length > q.limit;
            const page = hasMore ? filtered.slice(0, q.limit) : filtered;
            const last = page.length > 0 ? page[page.length - 1]! : null;
            return {
                nodes: page as unknown as Array<Record<string, unknown>>,
                hasMore,
                nextCursor: hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null,
            };
        },
        listNodes: async () => seed as unknown as LoreNode[],
        getStats: async () => ({ totalNodes: seed.length, typeBreakdown: {} }),
        getLanguageBreakdown: async () => ({}),
    };
}

function makeDeps(graph: ReturnType<typeof makeFakeGraph>, workspace = 'default') {
    return {
        store: { loreGraph: graph as never, loreVerbatim: {} as never } as never,
        pluginRegistry: { collectPluginStats: async () => ({}) } as never,
        detectedScope: { workspace, ecosystem: '*' },
        deploymentMode: 'local' as const,
        graphBasePath: '/tmp/lore-sprint7-fixture',
        nodeTypesEnum: z.enum(['decision', 'architecture', 'convention', 'bug_pattern'] as [string, ...string[]]),
    };
}

function registerAndGet(graph: ReturnType<typeof makeFakeGraph>, workspace = 'default'): CapturedTool {
    const stub = makeStubMcpServer();
    registerDiagnosticTools(stub.server as never, makeDeps(graph, workspace) as never);
    const tool = stub.tools.get('list_nodes');
    if (!tool) throw new Error('list_nodes tool was not registered');
    return tool;
}

/** Validate args with the tool's schema, then call the handler.
 *  This mirrors what the MCP SDK does (Zod parse + dispatch) so that
 *  validation errors (e.g., limit > 1000) surface the same way. */
async function invoke(tool: CapturedTool, args: Record<string, unknown>) {
    const shape = z.object(tool.schema as Record<string, z.ZodTypeAny>);
    const parsed = shape.parse(args);
    return tool.handler(parsed as Record<string, unknown>);
}

function parseResponse(resp: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
    return { body: JSON.parse(resp.content[0]!.text), isError: resp.isError === true };
}

function makeSeed(count: number, project = 'default'): Array<{ id: string; type: string; label: string; tags: string; project: string; updatedAt: string }> {
    const out = [];
    for (let i = 0; i < count; i++) {
        const ts = `2026-05-${String(20 + Math.floor(i / 50)).padStart(2, '0')}T${String(10 - Math.floor(i / 10) % 10).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`;
        out.push({ id: `n${String(i).padStart(4, '0')}`, type: 'decision', label: `Node ${i}`, tags: 'auth', project, updatedAt: ts });
    }
    return out;
}

/* ---------- T1: default limit ---------- */

test('T1 default limit returns ≤100 nodes', async () => {
    const graph = makeFakeGraph(makeSeed(150));
    const tool = registerAndGet(graph);
    const resp = await invoke(tool, { workspace: 'default', type: 'decision' });
    const { body, isError } = parseResponse(resp);
    assert.equal(isError, false, `expected success; got: ${JSON.stringify(body)}`);
    assert.ok(body.count <= 100, `expected count ≤100; got ${body.count}`);
    assert.equal(body.count, 100);
    assert.equal(body.hasMore, true);
    assert.ok(body.nextCursor, 'nextCursor must be set when hasMore=true');
});

/* ---------- T2: hasMore + nextCursor when more available ---------- */

test('T2 hasMore=true + nextCursor populated when more match', async () => {
    const graph = makeFakeGraph(makeSeed(5));
    const tool = registerAndGet(graph);
    const resp = await invoke(tool, { workspace: 'default', type: 'decision', limit: 2 });
    const { body } = parseResponse(resp);
    assert.equal(body.count, 2);
    assert.equal(body.hasMore, true);
    assert.ok(body.nextCursor);
});

test('T2 hasMore=false when all match fits in one page', async () => {
    const graph = makeFakeGraph(makeSeed(3));
    const tool = registerAndGet(graph);
    const resp = await invoke(tool, { workspace: 'default', type: 'decision', limit: 100 });
    const { body } = parseResponse(resp);
    assert.equal(body.count, 3);
    assert.equal(body.hasMore, false);
    assert.equal(body.nextCursor, undefined);
});

/* ---------- T3: cursor paginates through every row ---------- */

test('T3 nextCursor pages correctly through all rows', async () => {
    const graph = makeFakeGraph(makeSeed(5));
    const tool = registerAndGet(graph);
    const collected: string[] = [];
    let cursor: string | undefined = undefined;
    let pageCount = 0;
    while (pageCount < 10) {
        pageCount++;
        const args: Record<string, unknown> = { workspace: 'default', type: 'decision', limit: 2 };
        if (cursor) args.cursor = cursor;
        const resp = await invoke(tool, args);
        const { body } = parseResponse(resp);
        for (const n of body.nodes) collected.push(n.id);
        if (!body.hasMore) break;
        cursor = body.nextCursor;
        assert.ok(cursor, 'hasMore=true but nextCursor missing');
    }
    assert.equal(collected.length, 5, `paged ${collected.length}/5 (in ${pageCount} pages)`);
    // No duplicates
    assert.equal(new Set(collected).size, 5, 'pagination produced duplicates');
});

/* ---------- T4: limit > 1000 rejected ---------- */

test('T4 limit > 1000 rejected by Zod schema', async () => {
    const graph = makeFakeGraph(makeSeed(1));
    const tool = registerAndGet(graph);
    await assert.rejects(
        async () => invoke(tool, { workspace: 'default', limit: 1001 }),
        (err: Error) => /Number must be less than or equal to 1000|too_big|1000/i.test(err.message),
    );
});

test('T4 limit < 1 rejected by Zod schema', async () => {
    const graph = makeFakeGraph(makeSeed(1));
    const tool = registerAndGet(graph);
    await assert.rejects(
        async () => invoke(tool, { workspace: 'default', limit: 0 }),
    );
});

/* ---------- T5: Sprint L1e workspace_required preserved ---------- */

test('T5 Sprint L workspace_required preserved — empty workspace → Zod min(1)', async () => {
    const graph = makeFakeGraph(makeSeed(1));
    const tool = registerAndGet(graph);
    await assert.rejects(
        async () => invoke(tool, { workspace: '' }),
        (err: Error) => /workspace|String must contain at least 1|too_small/i.test(err.message),
    );
});

/* ---------- T6: ordering matches bulkList ---------- */

test('T6 ordering is (updatedAt DESC, id ASC) — same as W4 bulkList', async () => {
    // Two nodes with identical updatedAt; id ASC should tiebreak.
    const seed = [
        { id: 'aaa', type: 'decision', label: 'A', tags: '', project: 'default', updatedAt: '2026-05-23T10:00:00Z' },
        { id: 'bbb', type: 'decision', label: 'B', tags: '', project: 'default', updatedAt: '2026-05-23T10:00:00Z' },
        { id: 'ccc', type: 'decision', label: 'C', tags: '', project: 'default', updatedAt: '2026-05-23T09:00:00Z' },
    ];
    const graph = makeFakeGraph(seed);
    const tool = registerAndGet(graph);
    const resp = await invoke(tool, { workspace: 'default', type: 'decision', limit: 10 });
    const { body } = parseResponse(resp);
    // Same updatedAt → id ASC; older updatedAt last.
    assert.deepEqual(body.nodes.map((n: { id: string }) => n.id), ['aaa', 'bbb', 'ccc']);
});

/* ---------- T7: bad cursor → invalid_cursor envelope ---------- */

test('T7 malformed cursor → isError=true + invalid_cursor', async () => {
    const graph = makeFakeGraph(makeSeed(1));
    const tool = registerAndGet(graph);
    const resp = await invoke(tool, { workspace: 'default', cursor: 'not-a-base64-json-thing!!!' });
    const { body, isError } = parseResponse(resp);
    assert.equal(isError, true);
    assert.equal(body.error, 'invalid_cursor');
});

test('T7 cursor with valid base64 but wrong payload → invalid_cursor', async () => {
    const graph = makeFakeGraph(makeSeed(1));
    const tool = registerAndGet(graph);
    const badCursor = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
    const resp = await invoke(tool, { workspace: 'default', cursor: badCursor });
    const { body, isError } = parseResponse(resp);
    assert.equal(isError, true);
    assert.equal(body.error, 'invalid_cursor');
});

/* ---------- T8: empty result negative-evidence ---------- */

test('T8 empty result (no cursor) → negative-evidence _meta', async () => {
    const graph = makeFakeGraph([]);
    const tool = registerAndGet(graph);
    const resp = await invoke(tool, { workspace: 'default', type: 'decision' });
    const { body } = parseResponse(resp);
    assert.equal(body.count, 0);
    assert.equal(body.hasMore, false);
    assert.equal(body._meta.confidence, 0);
    assert.match(body._meta.negative_evidence, /No nodes match/);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
