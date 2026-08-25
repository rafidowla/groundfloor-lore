#!/usr/bin/env tsx
/**
 * nw3a-supersede-workspace-unit.ts — NW-3a regression for
 * api-001-supersede-ignores-workspace.
 *
 * Pre-fix bug:
 *   supersede_node (MCP tool) and POST /api/node/supersede + /unsupersede
 *   (REST routes) accept a `workspace` argument but never thread it into
 *   the storage call. The write always lands in the boot-bound graph,
 *   regardless of which workspace the caller asked for.
 *
 * Adversarial cases this file covers (per SWARM_QUEUE_2 NW-3a):
 *   A1. MCP supersede_node({id:'X', workspace:'B'}) where X lives in B
 *       → supersede MUST land in B (verify via direct B-graph read).
 *       Nothing supersedes in A.
 *   A2. MCP supersede_node({old_id:'X', workspace:'A'}) where X lives ONLY in B
 *       → returns ok:false reason 'old-not-found'. Mirrors store_node's
 *       "missing node in named workspace" rejection semantics — the
 *       resolver opens A and the underlying supersedeNode reports the
 *       node is not present.
 *   A3. MCP supersede_node({workspace:''}) → workspace_required envelope.
 *   A4. MCP supersede_node({workspace:'no-such-ws'}) → workspace_not_found
 *       envelope (registry rejects unknown ws).
 *   B1. REST POST /api/node/supersede {oldId, newId, workspace:'B'}
 *       → write lands in B (verify via direct B-graph read).
 *   B2. REST POST /api/node/supersede with workspace:'A' but X only in B
 *       → result.ok=false reason 'old-not-found', nothing changes in B.
 *   B3. REST POST /api/node/unsupersede {id, workspace:'B'}
 *       → reverses the supersession in B, not the boot-bound graph.
 *
 * Drives the tool/route handlers directly with a real LocalGraphRegistry
 * holding two LocalGraphs (no daemon spin-up). Mirrors the harness used
 * by phase6-p2-strict-schema-and-vocab-unit.ts.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

// LORE_HOME MUST be a fresh dir before any import that transitively loads
// workspaces.ts evaluates CONTROL_FILE.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nw3a-supersede-'));
process.env['LORE_HOME'] = TEST_HOME;

function seedWorkspaces(home: string, names: string[]): void {
    // Explicit 'surreal': graphA/graphB below are opened via the
    // engine-aware getGraphHandle(), and the MCP/REST supersede resolvers
    // route by the SAME declared engine — so seeding and verifying must
    // go through the SurrealGraph the supersede path writes, not a
    // second, engine-mismatched handle on the same workspace.
    const workspaces = names.map((name) => ({
        name,
        path: path.join(home, 'workspaces', name),
        createdAt: '2026-06-15T00:00:00.000Z',
        graphEngine: 'surreal' as const,
    }));
    fs.mkdirSync(home, { recursive: true });
    for (const w of workspaces) fs.mkdirSync(path.join(w.path, '.lore'), { recursive: true });
    fs.writeFileSync(
        path.join(home, 'workspaces.json'),
        JSON.stringify({ active: names[0]!, workspaces }, null, 2),
    );
}
seedWorkspaces(TEST_HOME, ['ws-a', 'ws-b']);

const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { registerMemoryTools } = await import('../packages/lore/src/mcp/tools/memory.js');
const { handleSupersede, handleUnsupersede } = await import('../packages/lore/src/mcp/http/routes/nodes/supersede.js');
const { LoreStorageClient } = await import('../packages/lore/src/storage/loreStorageClient.js');

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

function makeFakeVerbatim() {
    return {
        async count() { return 0; },
        async search(_q: string, _l: number) { return []; },
        async bm25Search(_q: string, _l: number) { return []; },
        async store(_a: { id: string; text: string; metadata?: object }) {},
        async delete(_id: string) {},
    };
}

function makePluginRegistry() {
    return {
        activeNames: () => [],
        isActive: () => false,
        active: () => [],
        registerTools: () => undefined,
    };
}

// ── shared resources ─────────────────────────────────────────────────────────

const registry = new LocalGraphRegistry();
const graphA = await registry.getGraphHandle('ws-a');
const graphB = await registry.getGraphHandle('ws-b');

// The boot-bound graph in the StorageBundle is ws-a (the "active"). The
// regression check is whether supersede in ws-b actually lands in graphB,
// not graphA.
const verbatim = makeFakeVerbatim();
const storageClient = LoreStorageClient.fromLocal({
    graph: graphA as never,
    verbatim: verbatim as never,
});
const storeBundle = {
    loreGraph: graphA,
    loreVerbatim: verbatim,
    storageClient,
    sessionCache: { pushNode: () => undefined },
};

// Seed node 'X' in ws-b ONLY (the bug: pre-fix, supersede({workspace:'B'})
// would call the boot-bound graphA, where X does not exist, returning
// old-not-found — falsely suggesting the node is missing even though
// the caller's workspace argument said otherwise).
const nowTs = new Date().toISOString();
async function seedNode(graph: { upsertNode: (n: Record<string, unknown>) => Promise<unknown> }, id: string, project: string): Promise<void> {
    await graph.upsertNode({
        id, type: 'decision', label: id, content: '', tags: '',
        project, ecosystem: '*', metadata: '{}',
        createdAt: nowTs, updatedAt: nowTs, syncedAt: null,
    });
}
await seedNode(graphB, 'X', 'ws-b');
await seedNode(graphB, 'X-new', 'ws-b');
// Seed a DIFFERENT pair in ws-a so cross-workspace contamination is visible.
await seedNode(graphA, 'a-old', 'ws-a');
await seedNode(graphA, 'a-new', 'ws-a');

// ── MCP tool registration ────────────────────────────────────────────────────

function registerSupersedeOnly(server: object) {
    const nodeTypesEnum = z.enum(['decision', 'note']);
    const edgeRelationsEnum = z.enum(['related_to', 'supersedes']);
    registerMemoryTools(server as never, {
        store: storeBundle as never,
        pluginRegistry: makePluginRegistry() as never,
        configManager: { read: () => ({ pluginConfig: {} }) } as never,
        auditLog: { log: () => undefined } as never,
        detectedScope: { workspace: 'ws-a', ecosystem: '*' },
        getWal: () => ({ append: () => undefined } as never),
        domain: 'lore',
        edgeRelations: ['related_to', 'supersedes'],
        nodeTypesEnum,
        nodeTypesDescription: 'decision|note',
        edgeRelationsEnum,
        graphRegistry: registry,
        coreNodeTypes: ['decision', 'note'],
    });
}

const { server, tools } = makeMcpServerStub();
registerSupersedeOnly(server);

// ── test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
// Serialize tests — the two workspace graphs are shared mutable state
// and the assertions read back what earlier cases wrote; running the
// cases concurrently would interleave those reads and writes.
const cases: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
    cases.push({ name, fn });
}
async function runAll(): Promise<void> {
    for (const c of cases) {
        try { await c.fn(); console.log(`  ✓ ${c.name}`); passed++; }
        catch (err) { console.error(`  ✗ ${c.name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    }
}

// ── A. MCP supersede_node ────────────────────────────────────────────────────

test('A1: MCP supersede_node({workspace:"ws-b"}) — write lands in ws-b graph', async () => {
    const res = await tools['supersede_node']!({
        old_id: 'X', new_id: 'X-new', reason: 'NW-3a A1', workspace: 'ws-b',
    });
    assert.ok(!res.isError, `expected ok, got: ${res.content[0]?.text}`);
    const body = JSON.parse(res.content[0]!.text) as { success: boolean };
    assert.equal(body.success, true);

    // Direct B-graph read: X is now superseded by X-new.
    const xInB = await graphB.getNode('X');
    assert.ok(xInB, 'X must still exist in ws-b');
    assert.equal(xInB.supersededBy, 'X-new', `X.supersededBy in ws-b should be 'X-new', got '${xInB.supersededBy}'`);

    // ws-a was NOT touched — its own a-old node still un-superseded.
    const aOldInA = await graphA.getNode('a-old');
    assert.ok(aOldInA, 'a-old must exist in ws-a');
    assert.equal(aOldInA.supersededBy ?? '', '', 'a-old in ws-a must NOT have been superseded by the ws-b call');
});

test('A2: MCP supersede_node({workspace:"ws-a"}) for id only in ws-b → old-not-found', async () => {
    // Pre-fix this would have FOUND X (because the write went to the
    // boot-bound graph which == graphA). Post-fix the resolver routes
    // to graphA, X is absent there, supersedeNode returns old-not-found.
    const res = await tools['supersede_node']!({
        old_id: 'X', new_id: 'X-new', workspace: 'ws-a',
    });
    assert.ok(res.isError, `expected isError (old-not-found in ws-a), got ok: ${res.content[0]?.text}`);
    const body = JSON.parse(res.content[0]!.text) as { success: boolean; reason: string };
    assert.equal(body.success, false);
    assert.equal(body.reason, 'old-not-found', `expected reason 'old-not-found', got '${body.reason}'`);
});

test('A3: MCP supersede_node({workspace:""}) → workspace_required', async () => {
    const res = await tools['supersede_node']!({
        old_id: 'X', new_id: 'X-new', workspace: '',
    });
    assert.ok(res.isError, 'expected error envelope');
    const body = JSON.parse(res.content[0]!.text) as { error: string };
    assert.equal(body.error, 'workspace_required');
});

test('A4: MCP supersede_node({workspace:"no-such-ws"}) → workspace_not_found', async () => {
    const res = await tools['supersede_node']!({
        old_id: 'X', new_id: 'X-new', workspace: 'no-such-ws',
    });
    assert.ok(res.isError, `expected error envelope, got ok: ${res.content[0]?.text}`);
    const body = JSON.parse(res.content[0]!.text) as { error: string; requested: string };
    assert.equal(body.error, 'workspace_not_found');
    assert.equal(body.requested, 'no-such-ws');
});

// ── B. REST POST /api/node/supersede + /unsupersede ──────────────────────────

class MockResponse {
    statusCode = 0;
    headers: Record<string, string> = {};
    body = '';
    writeHead(code: number, headers?: Record<string, string>) {
        this.statusCode = code;
        if (headers) Object.assign(this.headers, headers);
    }
    end(payload?: string) { this.body = payload ?? ''; }
}

function makeReq(body: object): { req: { on: (e: string, cb: (b?: Buffer) => void) => unknown; pause: () => void }; raw: string } {
    const raw = JSON.stringify(body);
    let dataCb: ((chunk: Buffer) => void) | null = null;
    let endCb: (() => void) | null = null;
    const req = {
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data') dataCb = cb as (c: Buffer) => void;
            if (event === 'end') endCb = cb as () => void;
            // Once both data + end are registered, fire them on next tick.
            if (dataCb && endCb) {
                queueMicrotask(() => {
                    dataCb!(Buffer.from(raw));
                    endCb!();
                });
            }
            return req;
        },
        pause() { /* no-op for test */ },
    };
    return { req, raw };
}

function makeRestDeps() {
    return {
        store: storeBundle,
        auditLog: { log: () => undefined },
        deploymentMode: 'local' as const,
        dataplane: null,
        graphRegistry: registry,
    };
}

test('B1: REST POST /api/node/supersede {workspace:"ws-b"} — write lands in ws-b', async () => {
    // Reset: seed a fresh pair for B1 in ws-b.
    await seedNode(graphB, 'rB1-old', 'ws-b');
    await seedNode(graphB, 'rB1-new', 'ws-b');
    const { req } = makeReq({ oldId: 'rB1-old', newId: 'rB1-new', workspace: 'ws-b' });
    const res = new MockResponse();
    await handleSupersede(req as never, res as never, '/api/node/supersede', makeRestDeps() as never);
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean };
    assert.equal(body.ok, true);
    const inB = await graphB.getNode('rB1-old');
    assert.equal(inB?.supersededBy, 'rB1-new', 'rB1-old in ws-b must be superseded');
});

test('B2: REST supersede with mismatched workspace → old-not-found, nothing changes', async () => {
    await seedNode(graphB, 'rB2-old', 'ws-b');
    await seedNode(graphB, 'rB2-new', 'ws-b');
    // ws-a does NOT have rB2-old. The route resolves the target to ws-a's
    // graph and supersedeNode reports old-not-found.
    const { req } = makeReq({ oldId: 'rB2-old', newId: 'rB2-new', workspace: 'ws-a' });
    const res = new MockResponse();
    await handleSupersede(req as never, res as never, '/api/node/supersede', makeRestDeps() as never);
    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'old-not-found');
    // And rB2-old in ws-b is still pristine.
    const inB = await graphB.getNode('rB2-old');
    assert.equal(inB?.supersededBy ?? '', '', 'rB2-old in ws-b must NOT have been superseded by the misrouted call');
});

test('B3: REST unsupersede {workspace:"ws-b"} reverses in ws-b', async () => {
    await seedNode(graphB, 'rB3-old', 'ws-b');
    await seedNode(graphB, 'rB3-new', 'ws-b');
    // First supersede in ws-b.
    const sup = makeReq({ oldId: 'rB3-old', newId: 'rB3-new', workspace: 'ws-b' });
    const supRes = new MockResponse();
    await handleSupersede(sup.req as never, supRes as never, '/api/node/supersede', makeRestDeps() as never);
    assert.equal(supRes.statusCode, 200, `supersede setup failed: ${supRes.body}`);

    // Now unsupersede in ws-b.
    const uns = makeReq({ id: 'rB3-old', workspace: 'ws-b' });
    const unsRes = new MockResponse();
    await handleUnsupersede(uns.req as never, unsRes as never, '/api/node/unsupersede', makeRestDeps() as never);
    assert.equal(unsRes.statusCode, 200, `expected 200, got ${unsRes.statusCode}: ${unsRes.body}`);
    const body = JSON.parse(unsRes.body) as { ok: boolean };
    assert.equal(body.ok, true);
    const inB = await graphB.getNode('rB3-old');
    assert.equal(inB?.supersededBy ?? '', '', 'rB3-old in ws-b must be unsupersded');
});

// ── runner ───────────────────────────────────────────────────────────────────

console.log('\n=== NW-3a: supersede_node workspace threading (api-001) ===\n');
await runAll();
console.log(`\n${passed} passed, ${failed} failed`);

// Best-effort cleanup of opened graphs.
try { await graphA.close(); } catch { /* ignore */ }
try { await graphB.close(); } catch { /* ignore */ }

process.exit(failed > 0 ? 1 : 0);
