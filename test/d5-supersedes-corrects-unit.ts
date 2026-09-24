#!/usr/bin/env tsx
/**
 * d5-supersedes-corrects-unit.ts — D5: write-time supersession enforcement
 * + recall-time supersession replacement + `corrects` adjacency.
 *
 * Part 1 (mocked retrieve() core, no DB — follows audit-ra2-retrieve-core-
 * unit.ts's pattern): supersession replacement and `corrects` adjacency at
 * the recall layer.
 *
 * Part 2 (real LocalGraphRegistry + registerMemoryTools, no daemon — follows
 * nw3a-supersede-workspace-unit.ts's pattern): write-time policy enforcement
 * via the store_node MCP tool — missing-field rejection, prose-mismatch
 * rejection, near-duplicate rejection, and enforcement-OFF leaving today's
 * behaviour unchanged.
 *
 * Every case here was proven FAILING on main (pre-D5) before the fix: main
 * has no `supersedes`/`force` write fields (write-time enforcement did not
 * exist, so a near-dup or prose-mismatch write always succeeded) and
 * retrieve.ts hid superseded nodes outright with no `corrects` relation at
 * all (results.ts had no replacement/adjacency step to test).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

/* ─── Part 1: recall-time (mocked retrieve() core) ────────────────────── */

const { retrieve } = await import('../packages/lore/src/recall/retrieve.js');
type RetrieveContext = Awaited<ReturnType<typeof retrieve>> extends never ? never : Parameters<typeof retrieve>[0];

type Node = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; updatedAt: string;
    supersededBy?: string | null; correctedBy?: string;
};
const mkNode = (id: string, over: Partial<Node> = {}): Node => ({
    id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'w', ecosystem: '*',
    updatedAt: '2026-06-01T00:00:00.000Z', ...over,
});

interface MockCfg {
    semantic?: Array<{ id: string; score?: number }>;
    nodes?: Record<string, Node>;
    edges?: Array<{ sourceId: string; targetId: string; relation: string }>;
}
function mockCtx(cfg: MockCfg): RetrieveContext {
    const graph = {
        async search() { return []; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, Node>();
            for (const id of ids) { const n = cfg.nodes?.[id]; if (n) m.set(id, n); }
            return m;
        },
        async traverse() { return []; },
        async queryEdges(q: { source?: string; relation?: string }) {
            return (cfg.edges ?? []).filter((e) => (!q.source || e.sourceId === q.source) && (!q.relation || e.relation === q.relation));
        },
    };
    return {
        store: {
            loreGraph: graph,
            sessionCache: { pushNode() {} },
            storageClient: {
                async verbatimCount() { return 1; },
                async verbatimSearch() { return (cfg.semantic ?? []).map((s) => ({ ...s, id: `lore:${s.id}` })); },
                async verbatimBm25Search() { return { hits: [], ranked: false }; },
            },
        },
    } as unknown as RetrieveContext;
}

console.log('D5 — recall-time supersession replacement + corrects adjacency');

await test('supersession replacement: a live successor takes the superseded node\'s slot', async () => {
    const ctx = mockCtx({
        semantic: [{ id: 'old', score: 0.9 }],
        nodes: { old: mkNode('old', { supersededBy: 'new' }), new: mkNode('new') },
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0 });
    assert.deepEqual(out.results.map((r) => r.node.id), ['new'], 'successor replaces the slot, old is gone');
});

await test('supersession replacement: no duplication when the successor is already present', async () => {
    const ctx = mockCtx({
        semantic: [{ id: 'old', score: 0.95 }, { id: 'new', score: 0.5 }],
        nodes: { old: mkNode('old', { supersededBy: 'new' }), new: mkNode('new') },
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0 });
    assert.deepEqual(out.results.map((r) => r.node.id), ['new'], 'exactly one "new" entry, no duplicate slot');
});

await test('supersession replacement: unresolved successor drops the slot rather than showing the stale node', async () => {
    const ctx = mockCtx({
        semantic: [{ id: 'old', score: 0.9 }],
        nodes: { old: mkNode('old', { supersededBy: 'ghost' }) }, // 'ghost' not resolvable
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0 });
    assert.deepEqual(out.results.map((r) => r.node.id), [], 'stale superseded node never surfaces');
});

await test('supersession replacement: includeSuperseded:true leaves the superseded node visible, unreplaced', async () => {
    const ctx = mockCtx({
        semantic: [{ id: 'old', score: 0.9 }],
        nodes: { old: mkNode('old', { supersededBy: 'new' }), new: mkNode('new') },
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, includeSuperseded: true });
    assert.deepEqual(out.results.map((r) => r.node.id), ['old'], 'enforcement OFF (includeSuperseded) — unchanged pre-D5 behaviour');
});

await test('corrects adjacency: the corrected node rides in right after its correction, flagged correctedBy', async () => {
    const ctx = mockCtx({
        semantic: [{ id: 'correction', score: 0.9 }],
        nodes: { correction: mkNode('correction'), corrected: mkNode('corrected') },
        edges: [{ sourceId: 'correction', targetId: 'corrected', relation: 'corrects' }],
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0 });
    // integ/d-all (D4 x D5): a corrects target that did NOT itself match the
    // query is edge-reached context, so it rides in `related` (relation
    // 'corrects', via the correcting node) — never in the ranked/counted
    // `results` (D4 contract).
    assert.deepEqual(out.results.map((r) => r.node.id), ['correction'], 'only the query match is ranked');
    assert.equal(out.meta.totalMatched, 1, 'injected corrects target is not counted');
    assert.deepEqual(out.related.map((r) => [r.node.id, r.via, r.relation]), [['corrected', 'correction', 'corrects']], 'corrected rides in related, via its correction');
    assert.equal((out.related[0]!.node as Node).correctedBy, 'correction', 'corrected node is flagged with the correcting id');
});

await test('corrects adjacency: no duplicate when the corrected node is already an independent match', async () => {
    const ctx = mockCtx({
        semantic: [{ id: 'correction', score: 0.9 }, { id: 'corrected', score: 0.4 }],
        nodes: { correction: mkNode('correction'), corrected: mkNode('corrected') },
        edges: [{ sourceId: 'correction', targetId: 'corrected', relation: 'corrects' }],
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0 });
    assert.equal(out.results.filter((r) => r.node.id === 'corrected').length, 1, 'exactly one "corrected" entry');
});

/* ─── integ/d-all: D5 x D1/D2/D4 interaction ───────────────────────────── */

console.log('integ/d-all — D5 supersession vs D1 relevance, D2 types, D4 related');

await test('D5 x D1: a successor that took a slot carries its OWN similarity, not the superseded node\'s', async () => {
    const ctx = mockCtx({
        semantic: [{ id: 'old', score: 0.9 }, { id: 'plain', score: 0.5 }],
        nodes: { old: mkNode('old', { supersededBy: 'new' }), new: mkNode('new'), plain: mkNode('plain') },
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0 });
    const byId = new Map(out.results.map((r) => [r.node.id, r]));
    assert.ok(byId.has('new') && !byId.has('old'), 'successor replaced the slot');
    assert.equal(byId.get('new')!.similarity, undefined, 'successor was never a vector hit — no inherited similarity');
    assert.equal(byId.get('plain')!.similarity, 0.5, 'a plain seed keeps its own similarity');
});

await test('D5 x D2: a successor outside the `types` filter is not admitted', async () => {
    const ctx = mockCtx({
        semantic: [{ id: 'old', score: 0.9 }],
        nodes: { old: mkNode('old', { supersededBy: 'new' }), new: mkNode('new', { type: 'decision' }) },
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, types: ['note'] });
    assert.deepEqual(out.results.map((r) => r.node.id), [], 'off-type successor dropped, stale node not shown');
});

await test('D5 x D4: a superseded traversal hop is replaced by its successor inside `related`, never ranked', async () => {
    const ctx = mockCtx({
        semantic: [{ id: 'a', score: 0.9 }],
        nodes: { a: mkNode('a'), hopOld: mkNode('hopOld', { supersededBy: 'hopNew' }), hopNew: mkNode('hopNew') },
    });
    (ctx.store.loreGraph as unknown as { traverse: unknown }).traverse = async (id: string) =>
        id === 'a' ? [{ node: mkNode('hopOld', { supersededBy: 'hopNew' }), depth: 1, relation: 'related_to' }] : [];
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 1 });
    assert.deepEqual(out.results.map((r) => r.node.id), ['a'], 'only the direct match is ranked');
    assert.deepEqual(out.related.map((r) => [r.node.id, r.via, r.relation]), [['hopNew', 'a', 'related_to']], 'live successor in related');
    assert.equal(out.meta.totalMatched, 1);
});

/* ─── Part 2: write-time enforcement (real registry, MCP store_node) ──── */

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'd5-write-'));
process.env['LORE_HOME'] = TEST_HOME;

function seedWorkspace(home: string, name: string, enforce: boolean): void {
    const ws = {
        name, path: path.join(home, 'workspaces', name), createdAt: '2026-06-15T00:00:00.000Z',
        graphEngine: 'surreal' as const,
        ...(enforce ? { supersessionPolicy: { enforce: true } } : {}),
    };
    fs.mkdirSync(path.join(ws.path, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({ active: name, workspaces: [ws] }, null, 2));
}

/**
 * Round 3 (#2, host switch) — a workspace with NO `supersessionPolicy` key
 * at all (as opposed to `seedWorkspace(..., false)`, which is also "no
 * key" today but reads as "explicit off" at the call site). Named
 * separately so Part 3's host-default tests read as "this workspace has no
 * opinion" rather than "this workspace explicitly disabled it" — both
 * currently produce the same JSON shape, but the distinction is what's
 * under test.
 */
function seedWorkspaceNoPolicy(home: string, name: string): void {
    seedWorkspace(home, name, false);
}

/** Explicit per-workspace policy — used to prove it outranks the host default. */
function seedWorkspaceExplicitOff(home: string, name: string): void {
    const ws = {
        name, path: path.join(home, 'workspaces', name), createdAt: '2026-06-15T00:00:00.000Z',
        graphEngine: 'surreal' as const,
        supersessionPolicy: { enforce: false },
    };
    fs.mkdirSync(path.join(ws.path, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({ active: name, workspaces: [ws] }, null, 2));
}

const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { registerMemoryTools } = await import('../packages/lore/src/mcp/tools/memory.js');
const { LoreStorageClient } = await import('../packages/lore/src/storage/loreStorageClient.js');

interface ToolBag {
    [name: string]: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
}
function makeMcpServerStub(): { server: object; tools: ToolBag } {
    const tools: ToolBag = {};
    const server = { tool: (name: string, ..._rest: unknown[]) => {
        const handler = _rest[_rest.length - 1];
        if (typeof handler === 'function') tools[name] = handler as ToolBag[string];
    } };
    return { server, tools };
}

/** Near-dup search result the test controls per-call. */
let nextDupHit: { id: string; score: number } | null = null;
function makeFakeVerbatim() {
    return {
        async initialize() {},
        async count() { return 0; },
        async search(_q: string, _l: number) { return nextDupHit ? [{ id: nextDupHit.id, score: nextDupHit.score, text: '', metadata: {} }] : []; },
        async bm25Search(_q: string, _l: number) { return []; },
        async store(_a: { id: string; text: string; metadata?: object }) {},
        async delete(_id: string) {},
    };
}
// Every graph opened by buildTools() is tracked here and closed in the
// runner's finally block below — each call makes its OWN LocalGraphRegistry
// (mirroring nw3a's per-workspace-pair setup, but one registry per test
// case here since each case wants its own enforcement policy), and an
// unclosed SurrealGraph handle is exactly the kind of leaked handle that
// keeps the process alive past a passing assertion run (see the explicit
// `graphA.close()`/`graphB.close()` + `process.exit()` at the end of
// nw3a-supersede-workspace-unit.ts, the reference this file follows).
const openGraphs: Array<{ close(): Promise<void> }> = [];

async function buildTools(workspace: string, enforce: boolean, supersessionEnforceDefault?: boolean): Promise<ToolBag> {
    seedWorkspace(TEST_HOME, workspace, enforce);
    return buildToolsForSeededWorkspace(workspace, supersessionEnforceDefault);
}

/**
 * Round 3 (#2, host switch) — same as buildTools() but the caller has
 * ALREADY seeded (or deliberately not seeded) the workspace, and supplies
 * `supersessionEnforceDefault` to thread through to registerMemoryTools's
 * new field (mirrors createMcpServer.ts's `deps.supersessionEnforceDefault`
 * wiring, minus the createLore()/env-var resolution step itself — that
 * part is covered by the standalone resolveHostSupersessionDefault()/
 * envSupersessionEnforceDefault() tests below).
 */
async function buildToolsForSeededWorkspace(workspace: string, supersessionEnforceDefault?: boolean): Promise<ToolBag> {
    const registry = new LocalGraphRegistry();
    const graph = await registry.getGraphHandle(workspace);
    openGraphs.push(graph as unknown as { close(): Promise<void> });
    const verbatim = makeFakeVerbatim();
    const storageClient = LoreStorageClient.fromLocal({ graph: graph as never, verbatim: verbatim as never });
    const storeBundle = { loreGraph: graph, loreVerbatim: verbatim, storageClient, sessionCache: { pushNode: () => undefined } };
    const nodeTypesEnum = z.enum(['decision', 'note']);
    const edgeRelationsEnum = z.enum(['related_to', 'supersedes', 'corrects']);
    const { server, tools } = makeMcpServerStub();
    registerMemoryTools(server as never, {
        store: storeBundle as never,
        configManager: { read: () => ({ pluginConfig: {} }) } as never,
        auditLog: { log: () => undefined } as never,
        detectedScope: { workspace, ecosystem: '*' },
        getWal: () => ({ append: () => undefined } as never),
        domain: 'lore',
        edgeRelations: ['related_to', 'supersedes', 'corrects'],
        nodeTypesEnum,
        nodeTypesDescription: 'decision|note',
        edgeRelationsEnum,
        graphRegistry: registry,
        coreNodeTypes: ['decision', 'note'],
        supersessionEnforceDefault,
    });
    return tools;
}

function errorCode(res: { content: Array<{ type: 'text'; text: string }> }): string | undefined {
    try { return (JSON.parse(res.content[0]!.text) as { error?: string }).error; } catch { return undefined; }
}

console.log('D5 — write-time supersession enforcement (store_node)');

await test('enforcement ON: a decision write with no supersedes field is rejected (missing_supersedes_field)', async () => {
    nextDupHit = null;
    const tools = await buildTools('ws-missing-field', true);
    const res = await tools['store_node']!({ type: 'decision', id: 'dec-1', label: 'D1', content: 'body', workspace: 'ws-missing-field' });
    assert.equal(res.isError, true);
    assert.equal(errorCode(res), 'missing_supersedes_field');
});

await test('enforcement ON: prose "SUPERSEDES <id>" not listed in supersedes is rejected (prose_supersedes_mismatch)', async () => {
    nextDupHit = null;
    const tools = await buildTools('ws-prose', true);
    const res = await tools['store_node']!({
        type: 'decision', id: 'dec-2', label: 'D2', content: 'This SUPERSEDES dec-old for real.',
        workspace: 'ws-prose', supersedes: [],
    });
    assert.equal(res.isError, true);
    assert.equal(errorCode(res), 'prose_supersedes_mismatch');
});

await test('enforcement ON: an unlisted near-duplicate is rejected (unlisted_near_duplicate)', async () => {
    nextDupHit = { id: 'dec-existing', score: 0.95 };
    const tools = await buildTools('ws-dup', true);
    const res = await tools['store_node']!({
        type: 'decision', id: 'dec-3', label: 'D3', content: 'a plain write', workspace: 'ws-dup', supersedes: [],
    });
    assert.equal(res.isError, true);
    assert.equal(errorCode(res), 'unlisted_near_duplicate');
});

await test('enforcement ON: force:true bypasses the near-duplicate check', async () => {
    nextDupHit = { id: 'dec-existing', score: 0.95 };
    const tools = await buildTools('ws-force', true);
    const res = await tools['store_node']!({
        type: 'decision', id: 'dec-4', label: 'D4', content: 'a plain write', workspace: 'ws-force', supersedes: [], force: true,
    });
    assert.equal(res.isError, undefined, JSON.stringify(res.content));
});

await test('enforcement ON: a listed supersedes id is accepted and applied', async () => {
    nextDupHit = null;
    const tools = await buildTools('ws-apply', true);
    const seedRes = await tools['store_node']!({ type: 'decision', id: 'dec-old', label: 'Old', content: 'the old call', workspace: 'ws-apply', supersedes: [] });
    assert.equal(seedRes.isError, undefined, JSON.stringify(seedRes.content));
    const res = await tools['store_node']!({
        type: 'decision', id: 'dec-new', label: 'New', content: 'the new call', workspace: 'ws-apply', supersedes: ['dec-old'],
    });
    assert.equal(res.isError, undefined, JSON.stringify(res.content));
});

await test('enforcement OFF (default): a decision write with no supersedes field succeeds unchanged', async () => {
    nextDupHit = { id: 'dec-existing', score: 0.99 }; // even a "near-dup" is irrelevant when enforcement is off
    const tools = await buildTools('ws-off', false);
    const res = await tools['store_node']!({ type: 'decision', id: 'dec-5', label: 'D5', content: 'no supersedes here', workspace: 'ws-off' });
    assert.equal(res.isError, undefined, JSON.stringify(res.content));
});

/* ─── Part 3: host-level enforcement switch (round 3, finding #2) ──────── */

const { envSupersessionEnforceDefault, resolveHostSupersessionDefault } =
    await import('../packages/lore/src/core/supersessionPolicy.js');
const { getWorkspaceSupersessionPolicy } = await import('../packages/lore/src/config/workspaces.js');

console.log('\nD5 round 3 — host-level supersession-enforce default (finding #2)');

const ENV_KEY = 'LORE_SUPERSESSION_ENFORCE';
const savedEnv = process.env[ENV_KEY];
function restoreEnv(): void {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
}

await test('envSupersessionEnforceDefault(): unset env is undefined (not false)', async () => {
    delete process.env[ENV_KEY];
    assert.equal(envSupersessionEnforceDefault(), undefined);
});

await test('envSupersessionEnforceDefault(): "1" and "true" (any case) are true', async () => {
    process.env[ENV_KEY] = '1';
    assert.equal(envSupersessionEnforceDefault(), true);
    process.env[ENV_KEY] = 'true';
    assert.equal(envSupersessionEnforceDefault(), true);
    process.env[ENV_KEY] = 'TRUE';
    assert.equal(envSupersessionEnforceDefault(), true);
});

await test('envSupersessionEnforceDefault(): any other value ("0", "false", "yes") is false', async () => {
    for (const v of ['0', 'false', 'yes', 'on']) {
        process.env[ENV_KEY] = v;
        assert.equal(envSupersessionEnforceDefault(), false, `value ${v}`);
    }
    restoreEnv();
});

await test('resolveHostSupersessionDefault(): createLore() option wins over env when BOTH are set', async () => {
    process.env[ENV_KEY] = '0';
    assert.equal(resolveHostSupersessionDefault(true), true);
    process.env[ENV_KEY] = '1';
    assert.equal(resolveHostSupersessionDefault(false), false);
    restoreEnv();
});

await test('resolveHostSupersessionDefault(): falls through to env when the option is omitted', async () => {
    process.env[ENV_KEY] = '1';
    assert.equal(resolveHostSupersessionDefault(undefined), true);
    delete process.env[ENV_KEY];
    assert.equal(resolveHostSupersessionDefault(undefined), undefined);
    restoreEnv();
});

await test('getWorkspaceSupersessionPolicy(): a workspace with NO explicit policy takes the host default', async () => {
    seedWorkspaceNoPolicy(TEST_HOME, 'ws-host-default-on');
    assert.equal(getWorkspaceSupersessionPolicy('ws-host-default-on', TEST_HOME, true).enforce, true);
    seedWorkspaceNoPolicy(TEST_HOME, 'ws-host-default-off');
    assert.equal(getWorkspaceSupersessionPolicy('ws-host-default-off', TEST_HOME, false).enforce, false);
    assert.equal(getWorkspaceSupersessionPolicy('ws-host-default-off', TEST_HOME, undefined).enforce, false);
});

await test('getWorkspaceSupersessionPolicy(): an EXPLICIT per-workspace policy outranks the host default', async () => {
    seedWorkspaceExplicitOff(TEST_HOME, 'ws-explicit-off');
    assert.equal(getWorkspaceSupersessionPolicy('ws-explicit-off', TEST_HOME, true).enforce, false,
        'explicit enforce:false must win even though the host default is true');
});

await test('host switch end-to-end: a workspace with no explicit policy is enforced when supersessionEnforceDefault is threaded through store_node', async () => {
    nextDupHit = null;
    seedWorkspaceNoPolicy(TEST_HOME, 'ws-e2e-host-on');
    const tools = await buildToolsForSeededWorkspace('ws-e2e-host-on', true);
    const res = await tools['store_node']!({ type: 'decision', id: 'dec-host-1', label: 'H1', content: 'body', workspace: 'ws-e2e-host-on' });
    assert.equal(res.isError, true);
    assert.equal(errorCode(res), 'missing_supersedes_field');
});

await test('host switch end-to-end: supersessionEnforceDefault absent (undefined) leaves a no-policy workspace unenforced (unchanged default)', async () => {
    nextDupHit = null;
    seedWorkspaceNoPolicy(TEST_HOME, 'ws-e2e-host-absent');
    const tools = await buildToolsForSeededWorkspace('ws-e2e-host-absent', undefined);
    const res = await tools['store_node']!({ type: 'decision', id: 'dec-host-2', label: 'H2', content: 'body', workspace: 'ws-e2e-host-absent' });
    assert.equal(res.isError, undefined, JSON.stringify(res.content));
});

await test('host switch end-to-end: an explicit per-workspace policy still overrides supersessionEnforceDefault via store_node', async () => {
    nextDupHit = null;
    seedWorkspaceExplicitOff(TEST_HOME, 'ws-e2e-explicit-wins');
    const tools = await buildToolsForSeededWorkspace('ws-e2e-explicit-wins', true);
    const res = await tools['store_node']!({ type: 'decision', id: 'dec-host-3', label: 'H3', content: 'body', workspace: 'ws-e2e-explicit-wins' });
    assert.equal(res.isError, undefined,
        `${JSON.stringify(res.content)} — workspace explicitly set enforce:false, so the host default of true must NOT apply`);
});

/* ─── Part 4: round 4 (#4) — pre-write all-or-nothing `supersedes` validation ── */

console.log('\nD5 round 4 (#4) — all-or-nothing multi-id `supersedes` validation (store_node)');

await test('round 4 (#4): a cycle (A supersedes B, then B supersedes A) is refused, nothing written', async () => {
    nextDupHit = null;
    const tools = await buildTools('ws-cycle', true);
    const a = await tools['store_node']!({ type: 'decision', id: 'dec-cyc-a', label: 'A', content: 'node A', workspace: 'ws-cycle', supersedes: [] });
    assert.equal(a.isError, undefined, JSON.stringify(a.content));
    const b = await tools['store_node']!({ type: 'decision', id: 'dec-cyc-b', label: 'B', content: 'node B', workspace: 'ws-cycle', supersedes: ['dec-cyc-a'] });
    assert.equal(b.isError, undefined, JSON.stringify(b.content)); // A supersedes... wait, B supersedes A: dec-cyc-a.supersededBy = 'dec-cyc-b'
    // Re-upsert dec-cyc-a claiming it supersedes dec-cyc-b — dec-cyc-a's own
    // supersededBy chain already contains dec-cyc-b, so this must be refused
    // as a cycle instead of silently creating a 2-node loop.
    const cyclic = await tools['store_node']!({ type: 'decision', id: 'dec-cyc-a', label: 'A v2', content: 'node A revised', workspace: 'ws-cycle', supersedes: ['dec-cyc-b'] });
    assert.equal(cyclic.isError, true, 'a cycle-forming supersedes must be refused');
    assert.equal(errorCode(cyclic), 'supersedes_apply_failed');
});

await test('round 4 (#4): a mixed valid/invalid supersedes list refuses the WHOLE write (nothing applied, not even the valid id)', async () => {
    nextDupHit = null;
    const tools = await buildTools('ws-mixed', true);
    const valid = await tools['store_node']!({ type: 'decision', id: 'dec-mix-valid', label: 'Valid target', content: 'a live node', workspace: 'ws-mixed', supersedes: [] });
    assert.equal(valid.isError, undefined, JSON.stringify(valid.content));

    const mixed = await tools['store_node']!({
        type: 'decision', id: 'dec-mix-new', label: 'Mixed', content: 'claims two targets',
        workspace: 'ws-mixed', supersedes: ['dec-mix-valid', 'dec-mix-nonexistent'],
    });
    assert.equal(mixed.isError, true, 'an unknown id anywhere in the list must refuse the entire write');
    assert.equal(errorCode(mixed), 'supersedes_apply_failed');

    // Proof the valid id was NOT partially applied: a later write that
    // supersedes ONLY the valid id must still succeed (if dec-mix-valid had
    // already been superseded or the earlier write had partially landed,
    // this would either fail as a duplicate-supersede or behave oddly).
    const followUp = await tools['store_node']!({
        type: 'decision', id: 'dec-mix-follow', label: 'Follow-up', content: 'supersedes only the valid target',
        workspace: 'ws-mixed', supersedes: ['dec-mix-valid'],
    });
    assert.equal(followUp.isError, undefined, `dec-mix-valid must still be a clean, unsuperseded target: ${JSON.stringify(followUp.content)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);

// Best-effort cleanup of every graph opened across buildTools() calls, then
// an explicit exit — same precedent as nw3a-supersede-workspace-unit.ts.
// Without the explicit exit, a handle left open by any one of the several
// LocalGraphRegistry instances this file creates (one per test case) keeps
// the process alive well past the last assertion.
for (const g of openGraphs) {
    try { await g.close(); } catch { /* ignore */ }
}
process.exit(failed > 0 ? 1 : 0);
