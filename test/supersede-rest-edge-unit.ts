#!/usr/bin/env tsx
/**
 * supersede-rest-edge-unit.ts — regression for the audit finding
 * "[low] The supersedes edge is created only by the MCP supersede_node tool;
 *  the REST route and the CLI produce no edge, so traverse/subgraph silently
 *  show no supersession for the same operation"
 * (packages/lore/src/mcp/http/routes/nodes/supersede.ts).
 *
 * Pre-fix bug:
 *   POST /api/node/supersede set only the denormalized supersededBy field.
 *   The semantic `supersedes` graph edge (newId -> oldId) was written ONLY
 *   by the supersede_node MCP tool, so a REST-driven supersession was
 *   invisible to traverse()/subgraph.
 *
 * Cases:
 *   1. REST POST /api/node/supersede on a real SurrealGraph → a 'supersedes'
 *      edge (sourceId=newId, targetId=oldId) exists afterwards, verified via
 *      the graph's own queryEdges().
 *   2. The same call records an outbox edge.upsert row BEFORE the substrate
 *      write (outbox-first parity with the MCP tool's C-R3-02 block).
 *   3. REST supersede that FAILS (oldId missing) writes NO edge.
 *   4. MCP supersede_node still writes the edge (parity anchor — guards
 *      against a future refactor dropping it from the tool while the REST
 *      route keeps its own copy).
 *
 * Harness mirrors nw3a-supersede-workspace-unit.ts: real LocalGraphRegistry
 * (engine-aware getGraphHandle over a Surreal-backed workspace) under a tmp
 * LORE_HOME, mock req/res, no daemon.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

// LORE_HOME MUST be a fresh dir before any import that transitively loads
// workspaces.ts evaluates CONTROL_FILE.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'supersede-rest-edge-'));
process.env['LORE_HOME'] = TEST_HOME;

const WS = 'ws-edge';
{
    const wsPath = path.join(TEST_HOME, 'workspaces', WS);
    fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
    fs.writeFileSync(
        path.join(TEST_HOME, 'workspaces.json'),
        JSON.stringify({
            active: WS,
            workspaces: [{
                name: WS,
                path: wsPath,
                createdAt: '2026-08-17T00:00:00.000Z',
                graphEngine: 'surreal' as const,
            }],
        }, null, 2),
    );
}

const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { registerMemoryTools } = await import('../packages/lore/src/mcp/tools/memory.js');
const { handleSupersede } = await import('../packages/lore/src/mcp/http/routes/nodes/supersede.js');
const { LoreStorageClient } = await import('../packages/lore/src/storage/loreStorageClient.js');

// ── shared resources ─────────────────────────────────────────────────────────

const registry = new LocalGraphRegistry();
// getGraphHandle honours the workspace's declared engine ('surreal' above) —
// getOrOpen is the Kùzu-only substrate accessor. The route and the MCP tool
// resolve the same cached handle, so seeds and assertions see one graph.
const graph = await registry.getGraphHandle(WS);

const verbatim = {
    async count() { return 0; },
    async search(_q: string, _l: number) { return []; },
    async bm25Search(_q: string, _l: number) { return []; },
    async store(_a: { id: string; text: string; metadata?: object }) {},
    async delete(_id: string) {},
};
const storageClient = LoreStorageClient.fromLocal({
    graph: graph as never,
    verbatim: verbatim as never,
});
const storeBundle = {
    loreGraph: graph,
    loreVerbatim: verbatim,
    storageClient,
    sessionCache: { pushNode: () => undefined },
};

const nowTs = new Date().toISOString();
async function seedNode(id: string): Promise<void> {
    await graph.upsertNode({
        id, type: 'decision', label: id, content: '', tags: [],
        project: WS, ecosystem: '*', metadata: '{}',
    });
}

/** Outbox mock capturing record() calls (recordHotWrite's only store call). */
interface RecordedEntry {
    operationKind?: string;
    workspace?: string;
    payload?: Record<string, unknown>;
    initiator?: string;
}
const outboxEntries: RecordedEntry[] = [];
const mockOutbox = {
    async record(entry: RecordedEntry) { outboxEntries.push(entry); },
    async markStep() {},
    async remove() {},
    async listUnfinished() { return []; },
};

// ── mock req/res (from nw3a-supersede-workspace-unit.ts) ────────────────────

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

function makeReq(body: object) {
    const raw = JSON.stringify(body);
    let dataCb: ((chunk: Buffer) => void) | null = null;
    let endCb: (() => void) | null = null;
    const req = {
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data') dataCb = cb as (c: Buffer) => void;
            if (event === 'end') endCb = cb as () => void;
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
        outboxStore: mockOutbox,
    };
}

// ── MCP tool registration (for the parity-anchor case) ──────────────────────

interface ToolBag {
    [name: string]: (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: 'text'; text: string }>;
        isError?: boolean;
    }>;
}
const mcpTools: ToolBag = {};
{
    const stubServer = {
        tool: (name: string, ...rest: unknown[]) => {
            const handler = rest[rest.length - 1];
            if (typeof handler === 'function') mcpTools[name] = handler as ToolBag[string];
        },
    };
    registerMemoryTools(stubServer as never, {
        store: storeBundle as never,
        pluginRegistry: {
            activeNames: () => [], isActive: () => false,
            active: () => [], registerTools: () => undefined,
        } as never,
        configManager: { read: () => ({ pluginConfig: {} }) } as never,
        auditLog: { log: () => undefined } as never,
        detectedScope: { workspace: WS, ecosystem: '*' },
        getWal: () => ({ append: () => undefined } as never),
        domain: 'lore',
        edgeRelations: ['related_to', 'supersedes'],
        nodeTypesEnum: z.enum(['decision', 'note']),
        nodeTypesDescription: 'decision|note',
        edgeRelationsEnum: z.enum(['related_to', 'supersedes']),
        graphRegistry: registry,
        coreNodeTypes: ['decision', 'note'],
    } as never);
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function supersedesEdges(sourceId: string): Promise<Array<{ sourceId: string; targetId: string; relation: string }>> {
    return (await graph.queryEdges({ source: sourceId, relation: 'supersedes', limit: 100, offset: 0 }))
        .map((e) => ({ sourceId: e.sourceId, targetId: e.targetId, relation: e.relation }));
}

// ── runner ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) { cases.push({ name, fn }); }

test('1: REST POST /api/node/supersede writes a supersedes edge (new -> old)', async () => {
    await seedNode('rest-old');
    await seedNode('rest-new');
    const { req } = makeReq({ oldId: 'rest-old', newId: 'rest-new', reason: 'edge parity', workspace: WS });
    const res = new MockResponse();
    await handleSupersede(req as never, res as never, '/api/node/supersede', makeRestDeps() as never);
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal((JSON.parse(res.body) as { ok: boolean }).ok, true);

    const edges = await supersedesEdges('rest-new');
    assert.deepEqual(
        edges,
        [{ sourceId: 'rest-new', targetId: 'rest-old', relation: 'supersedes' }],
        `expected exactly one supersedes edge rest-new -> rest-old, got ${JSON.stringify(edges)}`,
    );

    // Denormalized field still set (unchanged behavior).
    const oldNode = await graph.getNode('rest-old');
    assert.equal(oldNode?.supersededBy, 'rest-new');
});

test('2: REST supersede records an outbox edge.upsert row (outbox-first)', async () => {
    await seedNode('ob-old');
    await seedNode('ob-new');
    const before = outboxEntries.length;
    const { req } = makeReq({ oldId: 'ob-old', newId: 'ob-new', workspace: WS });
    const res = new MockResponse();
    await handleSupersede(req as never, res as never, '/api/node/supersede', makeRestDeps() as never);
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);

    const newEntries = outboxEntries.slice(before);
    assert.equal(newEntries.length, 1, `expected exactly 1 outbox row, got ${newEntries.length}`);
    const row = newEntries[0]!;
    assert.equal(row.operationKind, 'edge.upsert');
    assert.equal(row.workspace, WS);
    assert.equal(row.initiator, 'http:POST /api/node/supersede');
    assert.deepEqual(
        { sourceId: row.payload?.['sourceId'], targetId: row.payload?.['targetId'], relation: row.payload?.['relation'] },
        { sourceId: 'ob-new', targetId: 'ob-old', relation: 'supersedes' },
    );

    const edges = await supersedesEdges('ob-new');
    assert.equal(edges.length, 1, 'edge must also exist in the graph after the outbox row');
});

test('3: failed REST supersede (oldId missing) writes no edge and no outbox row', async () => {
    await seedNode('only-new');
    const before = outboxEntries.length;
    const { req } = makeReq({ oldId: 'ghost-old', newId: 'only-new', workspace: WS });
    const res = new MockResponse();
    await handleSupersede(req as never, res as never, '/api/node/supersede', makeRestDeps() as never);
    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    assert.equal((JSON.parse(res.body) as { ok: boolean }).ok, false);
    assert.equal(outboxEntries.length, before, 'no outbox row on a failed supersede');
    assert.equal((await supersedesEdges('only-new')).length, 0, 'no edge on a failed supersede');
});

test('4: MCP supersede_node still writes the supersedes edge (parity anchor)', async () => {
    await seedNode('mcp-old');
    await seedNode('mcp-new');
    const res = await mcpTools['supersede_node']!({
        old_id: 'mcp-old', new_id: 'mcp-new', reason: 'parity', workspace: WS,
    });
    assert.ok(!res.isError, `expected ok, got: ${res.content[0]?.text}`);
    const edges = await supersedesEdges('mcp-new');
    assert.deepEqual(
        edges,
        [{ sourceId: 'mcp-new', targetId: 'mcp-old', relation: 'supersedes' }],
        `MCP tool must still write the supersedes edge, got ${JSON.stringify(edges)}`,
    );
});

console.log('\n=== REST supersede writes supersedes edge (functional-correctness audit) ===\n');
for (const c of cases) {
    try { await c.fn(); console.log(`  ✓ ${c.name}`); passed++; }
    catch (err) { console.error(`  ✗ ${c.name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);

try { await graph.close(); } catch { /* ignore */ }
process.exit(failed > 0 ? 1 : 0);
