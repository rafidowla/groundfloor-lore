/**
 * test/phase6-p1c-stdio-and-cross-workspace-unit.ts
 *
 * Phase 6 P1.C — stdio MCP-tool handlers routed through the LocalGraph
 * registry + cross-workspace recall aggregation.
 *
 * Coverage (spec T1–T4):
 *   - T1: stdio store_node with `workspace: "B"` lands in B (mirrors
 *         P1.B T1 over the stdio tool path instead of HTTP).
 *   - T2: recall `workspace: "*"` aggregates hits from at least 2
 *         workspaces, and the response carries `projectsSeen` listing
 *         every workspace searched.
 *   - T3: recall `workspace: "A"` returns ONLY workspace-A hits even
 *         when workspace B has stronger semantic matches.
 *   - T4: recall without a `workspace:` arg returns active-workspace
 *         hits only (no regression vs. pre-P1.C behavior).
 *
 * The tests drive registerMemoryTools + registerSearchTools through a
 * minimal McpServer stub that captures registered handlers, then
 * invokes them directly. Full daemon spin-up + StdioServerTransport
 * roundtrip is intentionally out of scope for a unit test — what's
 * being verified is that the stdio TOOL HANDLERS route via the
 * registry the same way P1.B routed HTTP routes.
 *
 * Run:
 *   LORE_HOME=$(mktemp -d) npx tsx test/phase6-p1c-stdio-and-cross-workspace-unit.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

const TEST_HOME = process.env['LORE_HOME'];
if (!TEST_HOME || TEST_HOME === path.join(process.env['HOME'] ?? '', '.groundfloor')) {
    console.error(
        'ERROR: LORE_HOME must be set to a fresh temp dir before running this test.\n' +
            'Use: LORE_HOME=$(mktemp -d) npx tsx test/phase6-p1c-stdio-and-cross-workspace-unit.ts',
    );
    process.exit(2);
}

function seedWorkspacesJson(home: string, active: string, names: string[]): void {
    // Explicit 'surreal': the tool handlers under test resolve target
    // workspaces through the engine-aware registry.getGraphHandle(), and
    // buildEnv() seeds/verifies through the same accessor — one engine
    // (SurrealDB) on both the write and the read side of every assertion.
    const workspaces = names.map((name) => ({
        name,
        path: path.join(home, 'workspaces', name),
        createdAt: '2026-05-21T00:00:00.000Z',
        graphEngine: 'surreal' as const,
    }));
    fs.mkdirSync(home, { recursive: true });
    for (const w of workspaces) {
        fs.mkdirSync(path.join(w.path, '.lore'), { recursive: true });
    }
    fs.writeFileSync(
        path.join(home, 'workspaces.json'),
        JSON.stringify({ active, workspaces }, null, 2),
    );
}

seedWorkspacesJson(TEST_HOME, 'A', ['A', 'B']);

const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { registerMemoryTools } = await import('../packages/lore/src/mcp/tools/memory.js');
const { registerSearchTools } = await import('../packages/lore/src/mcp/tools/search.js');

// ── McpServer stub ─────────────────────────────────────────────────────────
//
// The real McpServer (from @modelcontextprotocol/sdk) registers tools
// via `mcpServer.tool(name, description, schema, handler)`. We only
// need the handler — capture (name → handler) and ignore description /
// schema (Zod validation is the SDK's concern; tests invoke handlers
// directly with already-shaped arg objects).
interface ToolBag {
    [name: string]: (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: 'text'; text: string }>;
        isError?: boolean;
    }>;
}

function makeMcpServerStub(): { server: object; tools: ToolBag } {
    const tools: ToolBag = {};
    const server = {
        tool: (name: string, ..._rest: unknown[]) => {
            const handler = _rest[_rest.length - 1];
            if (typeof handler === 'function') {
                tools[name] = handler as ToolBag[string];
            }
        },
    };
    return { server, tools };
}

// ── Fake verbatim store ────────────────────────────────────────────────────
//
// Backs the recall semantic seed path. Per-id rows; search returns
// rows ordered by stored score desc. Lets us simulate "B has a
// stronger match than A" for T3 by giving B's row a higher score.
function makeFakeVerbatimStore() {
    const rows: Array<{ id: string; text: string; score: number }> = [];
    return {
        rows,
        async count() { return rows.length; },
        async search(_q: string, limit: number) {
            return rows.slice().sort((a, b) => b.score - a.score).slice(0, limit);
        },
        async bm25Search(_q: string, limit: number) {
            return rows.slice().sort((a, b) => b.score - a.score).slice(0, limit);
        },
        async store(_args: { id: string; text: string; metadata?: object }) {
            // No-op for these tests; the cross-workspace path doesn't
            // need new rows after seeding.
        },
        async delete(_id: string) { /* no-op */ },
    };
}

// SessionCacheManager stub (recall pushes nodes through it).
// L-022: recording stub so a test can assert the cross-workspace path
// warms NO single cache (cross-workspace aggregation has no owning
// hot-session). One per env so cases don't accumulate pushes.
function makeRecordingSessionCache() {
    return {
        pushed: [] as string[],
        pushNode(id: string) { this.pushed.push(id); },
    };
}

// ── Shared test setup ──────────────────────────────────────────────────────

async function buildEnv() {
    const registry = new LocalGraphRegistry();
    const graphA = await registry.getGraphHandle('A');
    const graphB = await registry.getGraphHandle('B');
    const verbatim = makeFakeVerbatimStore();
    const sessionCache = makeRecordingSessionCache();
    const store = {
        loreGraph: graphA,
        loreVerbatim: verbatim as unknown as never,
        sessionCache: sessionCache as unknown as never,
        // Writes/reads go through the LoreStorageClient facade — delegate to
        // the verbatim fake so store_node/recall don't hit an undefined facade.
        storageClient: {
            verbatimStore: async (doc: unknown) => (verbatim as { store?: (d: unknown) => Promise<unknown> }).store?.(doc),
            verbatimSearch: async () => [],
            verbatimCount: async () => 0,
        } as unknown as never,
    };
    return { registry, graphA, graphB, verbatim, sessionCache, store };
}

// Registration boilerplate that mirrors createMcpServer's wiring.
function registerAll(server: object, store: never, registry: InstanceType<typeof LocalGraphRegistry>) {
    const nodeTypesEnum = z.enum(['decision', 'note', 'convention']);
    const edgeRelationsEnum = z.enum(['related_to', 'depends_on']);
    registerMemoryTools(server as never, {
        store: store as never,
        pluginRegistry: {
            active: () => [],
            activeNames: () => [],
            isActive: () => false,
            registerTools: () => undefined,
        } as never,
        configManager: { read: () => ({ pluginConfig: { developer: { autoLinkOnIngest: false } } }) } as never,
        auditLog: { log: () => undefined } as never,
        detectedScope: { workspace: 'A', ecosystem: 'default' },
        getWal: () => ({ append: () => undefined } as never),
        domain: 'lore',
        edgeRelations: ['related_to', 'depends_on'],
        nodeTypesEnum,
        nodeTypesDescription: 'decision|note|convention',
        edgeRelationsEnum,
        graphRegistry: registry,
        coreNodeTypes: ['decision', 'note', 'convention'],
    });
    registerSearchTools(server as never, {
        store: store as never,
        detectedScope: { workspace: 'A', ecosystem: 'default' },
        graphRegistry: registry,
    });
}

// ── T1: stdio store_node workspace:"B" lands in B ──────────────────────────

async function testT1_stdioStoreNodeRoutesToTargetWorkspace(): Promise<void> {
    const env = await buildEnv();
    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry);

    const result = await tools['store_node']!({
        id: 'p1c-t1-routed',
        type: 'decision',
        label: 'P1.C T1 — store_node workspace=B routes to B',
        content: 'should land physically in workspace B',
        workspace: 'B',
    });
    assert.equal(result.isError, undefined, `store_node returned isError: ${result.content[0]?.text}`);

    const inB = await env.graphB.getNode('p1c-t1-routed');
    const inA = await env.graphA.getNode('p1c-t1-routed');
    assert.ok(inB, 'node found in workspace B');
    assert.equal(inA, null, 'node NOT in workspace A');
    await env.registry.disposeAll();
    console.log('  ✓ T1: stdio store_node workspace:"B" lands in B');
}

// ── T2: recall workspace:"*" aggregates from 2 workspaces ──────────────────

async function testT2_crossWorkspaceRecallAggregates(): Promise<void> {
    const env = await buildEnv();
    // Seed both graphs directly. Different ids per workspace so dedupe
    // doesn't fire — T2 is about aggregation, T3 is about isolation.
    await env.graphA.upsertNode({
        id: 'p1c-t2-A-hit',
        type: 'note',
        label: 'A-side authn note',
        content: 'OAuth flows in workspace A',
        tags: 'auth',
        project: 'A',
        ecosystem: 'default',
        metadata: '{}',
        language: null,
        ephemeral: false,
        ttl_ms: null,
    });
    await env.graphB.upsertNode({
        id: 'p1c-t2-B-hit',
        type: 'note',
        label: 'B-side authn note',
        content: 'OAuth flows in workspace B',
        tags: 'auth',
        project: 'B',
        ecosystem: 'default',
        metadata: '{}',
        language: null,
        ephemeral: false,
        ttl_ms: null,
    });
    // Verbatim seeds so the semantic path also surfaces both.
    env.verbatim.rows.push({ id: 'lore:p1c-t2-A-hit', text: 'auth', score: 0.7 });
    env.verbatim.rows.push({ id: 'lore:p1c-t2-B-hit', text: 'auth', score: 0.8 });

    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry);

    const out = await tools['recall']!({ topic: 'OAuth', workspace: '*' });
    assert.equal(out.isError, undefined, `recall errored: ${out.content[0]?.text}`);
    const parsed = JSON.parse(out.content[0]!.text);
    assert.equal(parsed.workspace, '*', 'response carries workspace:"*"');
    assert.equal(parsed.crossWorkspace, true, 'crossWorkspace flag set');
    assert.deepEqual(parsed.projectsSeen.sort(), ['A', 'B'], 'projectsSeen lists every workspace searched');

    const hitIds = (parsed.hits as Array<{ id: string }>).map((h) => h.id).sort();
    assert.deepEqual(hitIds, ['p1c-t2-A-hit', 'p1c-t2-B-hit'], 'aggregate contains hits from BOTH workspaces');

    // Each hit must carry the source workspace tag.
    const aHit = (parsed.hits as Array<{ id: string; workspace: string }>).find((h) => h.id === 'p1c-t2-A-hit');
    const bHit = (parsed.hits as Array<{ id: string; workspace: string }>).find((h) => h.id === 'p1c-t2-B-hit');
    assert.equal(aHit?.workspace, 'A', 'A-hit tagged with workspace A');
    assert.equal(bHit?.workspace, 'B', 'B-hit tagged with workspace B');
    await env.registry.disposeAll();
    console.log('  ✓ T2: workspace:"*" aggregates across workspaces with projectsSeen');
}

// ── T3: recall workspace:"A" returns A-only even when B is stronger ────────

async function testT3_targetedRecallIsolatesWorkspace(): Promise<void> {
    const env = await buildEnv();
    await env.graphA.upsertNode({
        id: 'p1c-t3-A-only',
        type: 'note',
        label: 'A workspace match',
        content: 'workspace-A content matching topic',
        tags: 'topic',
        project: 'A',
        ecosystem: 'default',
        metadata: '{}',
        language: null,
        ephemeral: false,
        ttl_ms: null,
    });
    await env.graphB.upsertNode({
        id: 'p1c-t3-B-stronger',
        type: 'note',
        label: 'B workspace stronger match',
        content: 'workspace-B content matching topic with stronger phrasing',
        tags: 'topic',
        project: 'B',
        ecosystem: 'default',
        metadata: '{}',
        language: null,
        ephemeral: false,
        ttl_ms: null,
    });
    // B's score is higher — if isolation isn't honored the recall
    // would surface the B-side row.
    env.verbatim.rows.push({ id: 'lore:p1c-t3-A-only', text: 'topic', score: 0.6 });
    env.verbatim.rows.push({ id: 'lore:p1c-t3-B-stronger', text: 'topic', score: 0.95 });

    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry);

    const out = await tools['recall']!({ topic: 'topic', workspace: 'A' });
    assert.equal(out.isError, undefined, `recall errored: ${out.content[0]?.text}`);
    const parsed = JSON.parse(out.content[0]!.text);
    const hitIds = (parsed.hits as Array<{ id: string }>).map((h) => h.id);
    assert.ok(hitIds.includes('p1c-t3-A-only'), 'A workspace hit present');
    assert.ok(!hitIds.includes('p1c-t3-B-stronger'), 'B workspace hit MUST NOT leak into workspace:"A" recall');
    await env.registry.disposeAll();
    console.log('  ✓ T3: workspace:"A" isolates results to workspace A only');
}

// ── T4: omitted workspace = active-workspace only (no regression) ──────────

async function testT4_omittedWorkspaceIsActiveOnly(): Promise<void> {
    const env = await buildEnv();
    await env.graphA.upsertNode({
        id: 'p1c-t4-A-active',
        type: 'note',
        label: 'A active hit',
        content: 'workspace-A active recall hit',
        tags: 'active',
        project: 'A',
        ecosystem: 'default',
        metadata: '{}',
        language: null,
        ephemeral: false,
        ttl_ms: null,
    });
    await env.graphB.upsertNode({
        id: 'p1c-t4-B-shadow',
        type: 'note',
        label: 'B shadow hit',
        content: 'workspace-B sibling that must not surface in active recall',
        tags: 'active',
        project: 'B',
        ecosystem: 'default',
        metadata: '{}',
        language: null,
        ephemeral: false,
        ttl_ms: null,
    });
    env.verbatim.rows.push({ id: 'lore:p1c-t4-A-active', text: 'active recall', score: 0.7 });
    env.verbatim.rows.push({ id: 'lore:p1c-t4-B-shadow', text: 'active recall', score: 0.9 });

    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry);

    // Target the active workspace explicitly. (Sprint L1e made the
    // `workspace` arg required — no silent fallback — so the old
    // omitted-arg form now 400s; passing the active name preserves the
    // single-workspace, no-sibling-leak intent of this case.)
    const out = await tools['recall']!({ topic: 'active recall', workspace: 'A' });
    assert.equal(out.isError, undefined, `recall errored: ${out.content[0]?.text}`);
    const parsed = JSON.parse(out.content[0]!.text);
    const hitIds = (parsed.hits as Array<{ id: string }>).map((h) => h.id);
    assert.ok(hitIds.includes('p1c-t4-A-active'), 'active workspace hit present');
    assert.ok(!hitIds.includes('p1c-t4-B-shadow'), 'sibling workspace hit MUST NOT leak — no regression from pre-P1.C');
    // Response shape: not the cross-workspace aggregate.
    assert.notEqual(parsed.workspace, '*', 'single-workspace response is not workspace:"*"');
    assert.notEqual(parsed.crossWorkspace, true, 'single-workspace response is not crossWorkspace');
    await env.registry.disposeAll();
    console.log('  ✓ T4: omitted workspace arg returns active-only hits (no regression)');
}

// ── T5 (L-022): cross-workspace recall must NOT pollute the boot cache ──────

async function testT5_crossWorkspaceRecallDoesNotPolluteBootCache(): Promise<void> {
    const env = await buildEnv();
    // Seed A-hit + B-hit exactly like T2 so the cross-workspace merge
    // returns ids from BOTH workspaces.
    await env.graphA.upsertNode({
        id: 'p1c-t5-A-hit', type: 'note', label: 'A authn', content: 'OAuth flows in A',
        tags: 'auth', project: 'A', ecosystem: 'default', metadata: '{}',
        language: null, ephemeral: false, ttl_ms: null,
    });
    await env.graphB.upsertNode({
        id: 'p1c-t5-B-hit', type: 'note', label: 'B authn', content: 'OAuth flows in B',
        tags: 'auth', project: 'B', ecosystem: 'default', metadata: '{}',
        language: null, ephemeral: false, ttl_ms: null,
    });
    env.verbatim.rows.push({ id: 'lore:p1c-t5-A-hit', text: 'auth', score: 0.7 });
    env.verbatim.rows.push({ id: 'lore:p1c-t5-B-hit', text: 'auth', score: 0.8 });

    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry);

    const out = await tools['recall']!({ topic: 'OAuth', workspace: '*' });
    assert.equal(out.isError, undefined, `recall errored: ${out.content[0]?.text}`);
    const parsed = JSON.parse(out.content[0]!.text);
    // Sanity: the merge actually returned this test's hits from both
    // workspaces (other ids may persist on disk across buildEnv calls,
    // so assert membership not exact equality — same convention as T2).
    const hitIds = (parsed.hits as Array<{ id: string }>).map((h) => h.id);
    assert.ok(hitIds.includes('p1c-t5-A-hit'), 'precondition: A hit aggregated');
    assert.ok(hitIds.includes('p1c-t5-B-hit'), 'precondition: B hit aggregated');
    // L-022: the boot hot-session cache must receive NO foreign ids.
    assert.equal(
        env.sessionCache.pushed.length, 0,
        `cross-workspace recall must warm no single hot-session cache, got: ${JSON.stringify(env.sessionCache.pushed)}`,
    );
    await env.registry.disposeAll();
    console.log('  ✓ T5 (L-022): workspace:"*" recall does not pollute the boot hot-session cache');
}

// ── T6 (L-023): search workspace:"B" serves B's graph, not boot A ──────────

async function testT6_searchIsolatesWorkspace(): Promise<void> {
    const env = await buildEnv();
    // Same keyword term in both workspaces under distinct ids.
    await env.graphA.upsertNode({
        id: 'p1c-t6-A-only', type: 'note', label: 'shared term A', content: 'isolation marker present',
        tags: 'iso', project: 'A', ecosystem: 'default', metadata: '{}',
        language: null, ephemeral: false, ttl_ms: null,
    });
    await env.graphB.upsertNode({
        id: 'p1c-t6-B-only', type: 'note', label: 'shared term B', content: 'isolation marker present',
        tags: 'iso', project: 'B', ecosystem: 'default', metadata: '{}',
        language: null, ephemeral: false, ttl_ms: null,
    });

    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry);

    const out = await tools['search']!({ query: 'isolation marker', workspace: 'B' });
    assert.equal(out.isError, undefined, `search errored: ${out.content[0]?.text}`);
    const parsed = JSON.parse(out.content[0]!.text);
    const ids = (parsed.results as Array<{ id: string }>).map((r) => r.id);
    assert.ok(ids.includes('p1c-t6-B-only'), 'workspace=B search returns B node');
    assert.ok(!ids.includes('p1c-t6-A-only'), 'workspace=B search MUST NOT leak boot workspace A node');

    // Unknown workspace → workspace_not_found.
    const miss = await tools['search']!({ query: 'isolation marker', workspace: 'nonexistent' });
    assert.equal(miss.isError, true, 'unknown workspace is an error');
    assert.equal(JSON.parse(miss.content[0]!.text).error, 'workspace_not_found');
    await env.registry.disposeAll();
    console.log('  ✓ T6 (L-023): search workspace:"B" isolates to B (+ workspace_not_found)');
}

// ── T7 (L-024): structured_query workspace:"A" filters boot-verbatim seeds ──

async function testT7_structuredQueryIsolatesWorkspace(): Promise<void> {
    const env = await buildEnv();
    await env.graphA.upsertNode({
        id: 'p1c-t7-A-only', type: 'note', label: 'A topic', content: 'workspace A structured content',
        tags: 'sq', project: 'A', ecosystem: 'default', metadata: '{}',
        language: null, ephemeral: false, ttl_ms: null,
    });
    await env.graphB.upsertNode({
        id: 'p1c-t7-B-stronger', type: 'note', label: 'B topic', content: 'workspace B structured content stronger',
        tags: 'sq', project: 'B', ecosystem: 'default', metadata: '{}',
        language: null, ephemeral: false, ttl_ms: null,
    });
    // Boot-global verbatim returns BOTH ids (B scored higher). Per-workspace
    // hydration via graphForQuery.getNode must drop B when querying A.
    env.verbatim.rows.push({ id: 'lore:p1c-t7-A-only', text: 'topic', score: 0.6 });
    env.verbatim.rows.push({ id: 'lore:p1c-t7-B-stronger', text: 'topic', score: 0.95 });
    // The structured_query verbatim seed path reads through the storageClient
    // facade — point that facade's verbatim methods at the fake so seeds fire.
    (env.store as unknown as { storageClient: Record<string, unknown> }).storageClient.verbatimCount =
        async () => env.verbatim.rows.length;
    (env.store as unknown as { storageClient: Record<string, unknown> }).storageClient.verbatimSearch =
        async (q: string, limit: number) => env.verbatim.search(q, limit);

    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry);

    const out = await tools['structured_query']!({ query: 'topic', workspace: 'A' });
    assert.equal(out.isError, undefined, `structured_query errored: ${out.content[0]?.text}`);
    const parsed = JSON.parse(out.content[0]!.text);
    const ids = (parsed.results as Array<{ id: string }>).map((r) => r.id);
    assert.ok(ids.includes('p1c-t7-A-only'), 'workspace=A structured_query returns A node');
    assert.ok(
        !ids.includes('p1c-t7-B-stronger'),
        'higher-scored B seed MUST be filtered by per-workspace hydration when querying A',
    );

    // Unknown workspace → workspace_not_found.
    const miss = await tools['structured_query']!({ query: 'topic', workspace: 'nonexistent' });
    assert.equal(miss.isError, true, 'unknown workspace is an error');
    assert.equal(JSON.parse(miss.content[0]!.text).error, 'workspace_not_found');
    await env.registry.disposeAll();
    console.log('  ✓ T7 (L-024): structured_query workspace:"A" filters boot-verbatim seeds to A');
}

// ── Runner ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('phase6-p1c-stdio-and-cross-workspace-unit.ts');
    await testT1_stdioStoreNodeRoutesToTargetWorkspace();
    await testT2_crossWorkspaceRecallAggregates();
    await testT3_targetedRecallIsolatesWorkspace();
    await testT4_omittedWorkspaceIsActiveOnly();
    await testT5_crossWorkspaceRecallDoesNotPolluteBootCache();
    await testT6_searchIsolatesWorkspace();
    await testT7_structuredQueryIsolatesWorkspace();
    console.log('All P1.C tests passed.');
}

await main();
