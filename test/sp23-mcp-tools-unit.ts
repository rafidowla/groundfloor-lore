#!/usr/bin/env tsx
/**
 * sp23-mcp-tools-unit.ts — SP-23 regression: test coverage for live MCP tools.
 *
 * Tools covered:
 *   A. traverse         — workspace_required, node_not_found, isolated_node, connected_node
 *   B. recallCrossWorkspace — dedup (same id → first/highest-scoring workspace wins),
 *                             no-double-count (different nodes from different workspaces)
 *   C. redact_evidence  — success path (audit trail + response), node_not_found error path
 *
 * Design: node built-in static imports only; all lore modules loaded via
 * dynamic import AFTER setting LORE_HOME, so workspaces.ts evaluates
 * CONTROL_FILE against our tmpdir (not the live daemon).
 *
 * Each traverse test gets its own independent handler registration to avoid
 * shared-mutable-state races in concurrent test execution.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── MUST precede any dynamic import that transitively loads workspaces.ts ──
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sp23-mcp-'));
process.env['LORE_HOME'] = TEST_HOME;

function seedWorkspaces(home: string, names: string[]): void {
    const workspaces = names.map((name) => ({
        name,
        path: path.join(home, 'workspaces', name),
        createdAt: '2026-06-10T00:00:00.000Z',
    }));
    fs.mkdirSync(home, { recursive: true });
    for (const ws of workspaces) fs.mkdirSync(path.join(ws.path, '.lore'), { recursive: true });
    fs.writeFileSync(
        path.join(home, 'workspaces.json'),
        JSON.stringify({ active: names[0]!, workspaces }, null, 2),
    );
}
seedWorkspaces(TEST_HOME, ['ws-a', 'ws-b']);

// Dynamic imports — workspaces.ts evaluates CONTROL_FILE now (LORE_HOME already set)
const { registerTraverseTool } = await import('../packages/lore/src/mcp/tools/traverse.js');
const { registerEvidenceTools } = await import('../packages/lore/src/mcp/tools/evidence.js');
const { runCrossWorkspaceRecall } = await import('../packages/lore/src/mcp/tools/recallCrossWorkspace.js');
const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');
const { AuditLog } = await import('../packages/lore/src/security/audit.js');

// ── test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];

function test(name: string, fn: () => Promise<void> | void) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

// ── shared helpers ────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

interface MockNode {
    id: string; type: string; label: string; content: string;
    tags: string; project: string; ecosystem: string; metadata: string;
    createdAt: string; updatedAt: string; syncedAt: null;
}

function makeNode(id: string): MockNode {
    return {
        id, type: 'note', label: id, content: '', tags: '',
        project: '*', ecosystem: '*', metadata: '{}',
        createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', syncedAt: null,
    };
}

function makeMcpStub(): { server: object; tools: Record<string, Handler> } {
    const tools: Record<string, Handler> = {};
    const server = {
        tool(name: string, _desc: string, _schema: unknown, fn: Handler) { tools[name] = fn; },
    };
    return { server, tools };
}

/** Build an isolated traverse handler with its own snapshot of nodeMap and traverseResults. */
function makeTraverseHandler(nodeMap: Record<string, MockNode>, traverseResults: unknown[]): Handler {
    const { server, tools } = makeMcpStub();
    const store = {
        storageClient: { getNode: async (id: string) => nodeMap[id] ?? null },
        // Postgres-model routing: traverse now resolves the requested workspace's
        // graph and reads the start node from IT (per-workspace isolation), so the
        // mock loreGraph must expose getNode too (was storageClient-only before).
        loreGraph: {
            getNode: async (id: string) => nodeMap[id] ?? null,
            traverse: async (_nodeId: string, _depth: number) => traverseResults,
        },
    };
    registerTraverseTool(server as never, { store: store as never });
    return tools['traverse']!;
}

// ── A. traverse ──────────────────────────────────────────────────────────────

test('traverse: empty workspace arg → workspace_required error', async () => {
    const handle = makeTraverseHandler({}, []);
    const result = await handle({ nodeId: 'x', workspace: '', depth: 2 }) as { isError: boolean; content: Array<{ text: string }> };
    assert.ok(result.isError, 'expected isError:true');
    const body = JSON.parse(result.content[0]!.text) as { error: string };
    assert.equal(body.error, 'workspace_required');
});

test('traverse: node not found → negative-evidence envelope (confidence 0)', async () => {
    const handle = makeTraverseHandler({}, []);
    const result = await handle({ nodeId: 'missing-node', workspace: 'ws-a', depth: 2 }) as { isError: boolean; content: Array<{ text: string }> };
    assert.ok(result.isError, 'expected isError:true for missing node');
    const body = JSON.parse(result.content[0]!.text) as { _meta: { confidence: number; negative_evidence: string } };
    assert.equal(body._meta.confidence, 0);
    assert.ok(body._meta.negative_evidence, 'expected negative_evidence message');
});

test('traverse: isolated node (no neighbours) → confidence 0, not isError', async () => {
    const handle = makeTraverseHandler({ isolated: makeNode('isolated') }, []);
    const result = await handle({ nodeId: 'isolated', workspace: 'ws-a', depth: 2 }) as { isError?: boolean; content: Array<{ text: string }> };
    assert.ok(!result.isError, 'isolated node should not be isError');
    const body = JSON.parse(result.content[0]!.text) as { connectedNodes: number; _meta: { confidence: number; negative_evidence: string } };
    assert.equal(body.connectedNodes, 0);
    assert.equal(body._meta.confidence, 0);
    assert.ok(body._meta.negative_evidence, 'expected negative_evidence for isolated node');
});

test('traverse: connected node returns results with confidence 1', async () => {
    const traverseResults = [
        { depth: 1, relation: 'related', node: makeNode('child-1') },
        { depth: 1, relation: 'related', node: makeNode('child-2') },
    ];
    const handle = makeTraverseHandler({ root: makeNode('root') }, traverseResults);
    const result = await handle({ nodeId: 'root', workspace: 'ws-a', depth: 1 }) as { isError?: boolean; content: Array<{ text: string }> };
    assert.ok(!result.isError, 'should not be isError');
    const body = JSON.parse(result.content[0]!.text) as { connectedNodes: number; _meta: { confidence: number } };
    assert.equal(body.connectedNodes, 2);
    assert.equal(body._meta.confidence, 1);
});

// ── B. recallCrossWorkspace ──────────────────────────────────────────────────

const n1 = makeNode('n1');
const n2 = makeNode('n2');
const mockSessionCache = {
    pushNode: (_id: string) => { /* no-op */ },
    getHotContext: () => ({ recent: [] }),
    flushNow: () => { /* no-op */ },
};

test('recallCrossWorkspace: dedup — same id in two workspaces → 1 result, first workspace wins', async () => {
    const semanticSeeds = [{ id: 'lore:n1', score: 0.9 }];
    const mockVerbatim = {
        count: async () => 1,
        search: async () => semanticSeeds,
    };
    // Both workspaces have node n1 — same score, ws-a is visited first
    // SW-16: recall now batch-hydrates seeds via getNodesByIds; the stub mirrors getNode.
    const wsGraphA = { getNode: async (id: string) => id === 'n1' ? n1 : null, getNodesByIds: async (ids: string[]) => new Map(ids.includes('n1') ? [['n1', n1]] : []), search: async () => [] };
    const wsGraphB = { getNode: async (id: string) => id === 'n1' ? { ...n1, project: 'ws-b-copy' } : null, getNodesByIds: async (ids: string[]) => new Map(ids.includes('n1') ? [['n1', { ...n1, project: 'ws-b-copy' }]] : []), search: async () => [] };
    // getGraphHandle, not getOrOpen: runCrossWorkspaceRecall resolves each
    // workspace's DECLARED engine now. The mock is cast `as never` below, so
    // naming the wrong method here fails at runtime, not at compile time.
    const mockRegistry = { getGraphHandle: async (ws: string) => ws === 'ws-a' ? wsGraphA : wsGraphB };

    const result = await runCrossWorkspaceRecall({
        topic: 'test', depth: 0, includeSuperseded: false,
        registry: mockRegistry as never,
        verbatimStore: mockVerbatim as never,
        sessionCache: mockSessionCache as never,
        responseMode: 'full',
    });

    const body = JSON.parse(result.content[0]!.text) as { knowledge: Array<{ id: string; workspace: string }> };
    const n1Hits = body.knowledge.filter((h) => h.id === 'n1');
    assert.equal(n1Hits.length, 1, `expected exactly 1 hit for n1, got ${n1Hits.length}`);
    assert.equal(n1Hits[0]!.workspace, 'ws-a', 'ws-a visited first → should win on equal score');
});

test('recallCrossWorkspace: no-double-count — different nodes from 2 workspaces both appear', async () => {
    const mockVerbatim = { count: async () => 0, search: async () => [] };
    // ws-a keyword returns n1, ws-b keyword returns n2
    const wsGraphA = { getNode: async () => null, getNodesByIds: async () => new Map(), search: async (_t: string, lim: number) => lim > 0 ? [n1] : [] };
    const wsGraphB = { getNode: async () => null, getNodesByIds: async () => new Map(), search: async (_t: string, lim: number) => lim > 0 ? [n2] : [] };
    // getGraphHandle, not getOrOpen: runCrossWorkspaceRecall resolves each
    // workspace's DECLARED engine now. The mock is cast `as never` below, so
    // naming the wrong method here fails at runtime, not at compile time.
    const mockRegistry = { getGraphHandle: async (ws: string) => ws === 'ws-a' ? wsGraphA : wsGraphB };

    const result = await runCrossWorkspaceRecall({
        topic: 'test', depth: 0, includeSuperseded: false,
        registry: mockRegistry as never,
        verbatimStore: mockVerbatim as never,
        sessionCache: mockSessionCache as never,
        responseMode: 'full',
    });

    const body = JSON.parse(result.content[0]!.text) as { knowledge: Array<{ id: string; workspace: string }> };
    assert.equal(body.knowledge.length, 2, `expected 2 hits, got ${body.knowledge.length}: ${JSON.stringify(body.knowledge.map((h) => h.id))}`);
    const ids = body.knowledge.map((h) => h.id).sort();
    assert.deepEqual(ids, ['n1', 'n2']);
});

test('recallCrossWorkspace: verbatim store unreadable → degrades to keyword-only, does not throw', async () => {
    // Simulates a corrupted/missing LanceDB fragment: count() reports vectors exist,
    // but search() throws. Recall must fall back to keyword-only and still answer,
    // not propagate the vector-store error and fail the whole call.
    const mockVerbatim = {
        count: async () => 5,
        search: async () => { throw new Error('lance error: Not found: data/deadbeef.lance'); },
    };
    const wsGraphA = { getNode: async () => null, getNodesByIds: async () => new Map(), search: async (_t: string, lim: number) => lim > 0 ? [n1] : [] };
    const wsGraphB = { getNode: async () => null, getNodesByIds: async () => new Map(), search: async (_t: string, lim: number) => lim > 0 ? [n2] : [] };
    // getGraphHandle, not getOrOpen: runCrossWorkspaceRecall resolves each
    // workspace's DECLARED engine now. The mock is cast `as never` below, so
    // naming the wrong method here fails at runtime, not at compile time.
    const mockRegistry = { getGraphHandle: async (ws: string) => ws === 'ws-a' ? wsGraphA : wsGraphB };

    const result = await runCrossWorkspaceRecall({
        topic: 'test', depth: 0, includeSuperseded: false,
        registry: mockRegistry as never,
        verbatimStore: mockVerbatim as never,
        sessionCache: mockSessionCache as never,
        responseMode: 'full',
    });

    assert.notEqual(result.isError, true, 'recall must not error when the verbatim store throws');
    const body = JSON.parse(result.content[0]!.text) as { knowledge: Array<{ id: string }> };
    const ids = body.knowledge.map((h) => h.id).sort();
    assert.deepEqual(ids, ['n1', 'n2'], 'keyword hits from both workspaces must still be returned after vector fallback');
});

// ── C. redact_evidence ───────────────────────────────────────────────────────

// Real graph engine needed: registerEvidenceTools resolves via
// resolveTargetGraph, which returns the engine-agnostic LoreGraphHandle
// (no instanceof-class check remains — see workspaceResolve.ts). SurrealGraph
// exercises the same redact_evidence path used in production.
const graphDir = path.join(TEST_HOME, 'evidence-graph');
fs.mkdirSync(graphDir, { recursive: true });
const realGraph = new SurrealGraph(graphDir);
await realGraph.initialize();

const auditFile = path.join(TEST_HOME, 'test-audit.jsonl');
const realAuditLog = new AuditLog({ path: auditFile });

const { server: evidServer, tools: evidTools } = makeMcpStub();
registerEvidenceTools(evidServer as never, { store: { loreGraph: realGraph } as never, auditLog: realAuditLog });

const nowTs = new Date().toISOString();
// Seed the node we'll redact
await realGraph.upsertNode({
    id: 'e-node-1', type: 'note', label: 'Evidence Test',
    content: 'some content', tags: '', project: '*', ecosystem: '*',
    metadata: '{}', createdAt: nowTs, updatedAt: nowTs, syncedAt: null,
} as never);

test('redact_evidence: success → returns success:true + non-error response + audit trail', async () => {
    const result = await evidTools['redact_evidence']!({ id: 'e-node-1', workspace: 'ws-a', reason: 'GDPR test' }) as { isError?: boolean; content: Array<{ text: string }> };
    assert.ok(!result.isError, `expected success, got: ${result.content[0]?.text}`);
    const body = JSON.parse(result.content[0]!.text) as { success: boolean; id: string; workspace: string };
    assert.ok(body.success, 'body.success must be true');
    assert.equal(body.id, 'e-node-1');
    assert.equal(body.workspace, 'ws-a');

    // Audit trail: wait for async fs.promises.appendFile to flush
    await new Promise((r) => setTimeout(r, 100));
    const auditEntries = realAuditLog.tail(20);
    const entry = auditEntries.find((e) => e.toolName === 'redact_evidence');
    assert.ok(entry, 'expected audit entry for redact_evidence');
    assert.equal(entry!.result, 'success');
    const args = entry!.args as { id: string; workspace: string; reason: string | null };
    assert.equal(args.id, 'e-node-1');
    assert.equal(args.reason, 'GDPR test');
});

test('redact_evidence: node not found → isError:true + error:node_not_found', async () => {
    const result = await evidTools['redact_evidence']!({ id: 'no-such-node', workspace: 'ws-a' }) as { isError: boolean; content: Array<{ text: string }> };
    assert.ok(result.isError, 'expected isError:true for missing node');
    const body = JSON.parse(result.content[0]!.text) as { error: string; id: string };
    assert.equal(body.error, 'node_not_found');
    assert.equal(body.id, 'no-such-node');
});

// ── runner ───────────────────────────────────────────────────────────────────

console.log('\n=== SP-23 MCP tools: traverse + recallCrossWorkspace + redact_evidence ===\n');
await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
