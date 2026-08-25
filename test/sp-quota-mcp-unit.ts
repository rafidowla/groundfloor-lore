#!/usr/bin/env tsx
/**
 * sp-quota-mcp-unit.ts — L-033: MCP store_node enforces the per-workspace
 * write quota (the same one POST /api/node enforces).
 *
 * THE GAP: the per-workspace write quota (security/workspaceQuota.ts) was
 * enforced ONLY on the HTTP POST /api/node hot path. The MCP store_node tool —
 * the PRIMARY ingestion path for agents — bypassed it entirely, so an app
 * principal could blow straight past workspace.maxNodes / maxStorageBytes by
 * writing via MCP, AND legitimate MCP writes never bumped the counter (leaving
 * the cap unenforceable in any mixed REST+MCP deployment).
 *
 * THE FIX: thread the SAME IWorkspaceQuotaStore + entry resolver into
 * MemoryToolsDeps; store_node calls checkWorkspaceQuota before the write and
 * bumpNodeWriteQuota after a successful write — mirroring postNode.ts.
 *
 * What this proves:
 *   - a write that would exceed maxNodes → isError envelope
 *     `workspace_quota_exceeded`, and the graph upsert is NEVER called.
 *   - a write under cap → succeeds AND the counter increments.
 *   - a second write that now exceeds the (incremented) cap → refused.
 *   - when quotaStore is unwired (cloud/tests) → no quota gate (back-compat).
 *
 * No LORE_HOME / disk: store.loreGraph is an in-memory stub.
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/sp-quota-mcp-unit.ts
 */

import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerStoreNodeTool } from '../packages/lore/src/mcp/tools/memory/storeNode.js';
import {
    InMemoryWorkspaceQuotaStore,
    checkWorkspaceQuota,
} from '../packages/lore/src/security/workspaceQuota.js';
import type { MemoryToolsDeps } from '../packages/lore/src/mcp/tools/memory/types.js';
import type { WorkspaceEntry } from '../packages/lore/src/config/workspaces.js';

interface RecordedTool {
    name: string;
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}
class FakeMcpServer {
    public tools: RecordedTool[] = [];
    tool(name: string, _desc: string, _schema: unknown, handler: RecordedTool['handler']) {
        this.tools.push({ name, handler });
    }
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

function classify(r: { content: Array<{ text: string }>; isError?: boolean }): { error?: string; current?: number; cap?: number } {
    try { return JSON.parse(r.content[0].text); } catch { return {}; }
}

/** Recording in-memory graph stub good enough for nodeUpsert's inline path. */
function makeFakeGraph() {
    const upsertCalls: string[] = [];
    return {
        upsertCalls,
        graph: {
            async upsertNode(n: { id: string; type: string; label: string; project: string; ecosystem: string }) {
                upsertCalls.push(n.id);
                return { ...n, updatedAt: new Date().toISOString() };
            },
            async getNode() { return null; },
        },
    };
}

function makeDeps(
    quotaStore: InMemoryWorkspaceQuotaStore | undefined,
    getWorkspaceEntryForQuota: ((ws: string) => WorkspaceEntry | undefined) | undefined,
): { deps: MemoryToolsDeps; graph: ReturnType<typeof makeFakeGraph> } {
    const graph = makeFakeGraph();
    const deps = {
        store: {
            loreGraph: graph.graph as never,
            loreVerbatim: {} as never,
            // inline verbatim path target (no outbox wired)
            storageClient: { verbatimStore: async () => undefined } as never,
        } as never,
        configManager: {} as never,
        auditLog: { log: () => undefined } as never,
        detectedScope: { workspace: 'dev', ecosystem: '*' },
        getWal: () => ({ append: () => undefined }) as never,
        domain: 'developer',
        edgeRelations: [],
        nodeTypesEnum: z.enum(['decision']) as never,
        nodeTypesDescription: 'decision',
        edgeRelationsEnum: z.enum(['related_to']) as never,
        coreNodeTypes: ['decision'],
        quotaStore,
        getWorkspaceEntryForQuota,
    } as unknown as MemoryToolsDeps;
    return { deps, graph };
}

function entry(maxNodes?: number, maxStorageBytes?: number): WorkspaceEntry {
    return { name: 'dev', path: '/tmp/dev', createdAt: 'x', ...(maxNodes !== undefined ? { maxNodes } : {}), ...(maxStorageBytes !== undefined ? { maxStorageBytes } : {}) } as WorkspaceEntry;
}

(async () => {
    console.log('sp-quota-mcp-unit.ts — L-033 MCP store_node write quota');

    /* ── pure decision sanity (shared with REST) ── */
    await test('checkWorkspaceQuota: pure decision matches REST shape', () => {
        const store = new InMemoryWorkspaceQuotaStore();
        store.reconcile('dev', { nodeCount: 1, storageBytes: 0 });
        const r = checkWorkspaceQuota({ store, getWorkspaceEntry: () => entry(1) }, 'dev', { nodes: 1 });
        assert.equal(r.allowed, false);
        assert.equal(r.dimension, 'maxNodes');
        assert.equal(r.current, 1);
        assert.equal(r.cap, 1);
    });

    /* ── store_node refused when the write would exceed maxNodes ── */
    await test('store_node: over maxNodes → workspace_quota_exceeded, graph NOT touched', async () => {
        const quotaStore = new InMemoryWorkspaceQuotaStore();
        quotaStore.reconcile('dev', { nodeCount: 1, storageBytes: 0 }); // already AT the cap
        const { deps, graph } = makeDeps(quotaStore, () => entry(1)); // maxNodes=1
        const srv = new FakeMcpServer();
        registerStoreNodeTool(srv as never, deps);
        const storeNode = srv.tools.find(t => t.name === 'store_node')!;
        const r = await storeNode.handler({ id: 'n1', type: 'decision', label: 'Over cap', workspace: 'dev' });
        assert.equal(r.isError, true, 'expected an error envelope');
        const body = classify(r);
        assert.equal(body.error, 'workspace_quota_exceeded');
        assert.equal(body.cap, 1);
        assert.equal(graph.upsertCalls.length, 0, 'refused write MUST NOT reach the graph');
    });

    /* ── under cap succeeds AND increments; second write then refused ── */
    await test('store_node: under cap succeeds + counter increments; next write refused', async () => {
        const quotaStore = new InMemoryWorkspaceQuotaStore();
        quotaStore.reconcile('dev', { nodeCount: 0, storageBytes: 0 });
        const { deps, graph } = makeDeps(quotaStore, () => entry(1)); // cap = 1 node
        const srv = new FakeMcpServer();
        registerStoreNodeTool(srv as never, deps);
        const storeNode = srv.tools.find(t => t.name === 'store_node')!;

        const r1 = await storeNode.handler({ id: 'n1', type: 'decision', label: 'First', content: 'body', workspace: 'dev' });
        assert.notEqual(r1.isError, true, `first write should succeed: ${JSON.stringify(r1)}`);
        assert.equal(graph.upsertCalls.length, 1, 'first write reached the graph');
        assert.equal(quotaStore.snapshot('dev').nodeCount, 1, 'counter incremented after successful write');

        // A second write now exceeds the cap (count 1, +1 → 2 > 1).
        const r2 = await storeNode.handler({ id: 'n2', type: 'decision', label: 'Second', workspace: 'dev' });
        assert.equal(r2.isError, true, 'second write must be refused (cap reached)');
        assert.equal(classify(r2).error, 'workspace_quota_exceeded');
        assert.equal(graph.upsertCalls.length, 1, 'refused second write MUST NOT reach the graph');
    });

    /* ── storage-bytes dimension ── */
    await test('store_node: over maxStorageBytes → refused on storage dimension', async () => {
        const quotaStore = new InMemoryWorkspaceQuotaStore();
        quotaStore.reconcile('dev', { nodeCount: 0, storageBytes: 0 });
        const { deps, graph } = makeDeps(quotaStore, () => entry(undefined, 4)); // 4-byte cap
        const srv = new FakeMcpServer();
        registerStoreNodeTool(srv as never, deps);
        const storeNode = srv.tools.find(t => t.name === 'store_node')!;
        // label 'big' (3) + content 'enough' (6) = 9 bytes > 4
        const r = await storeNode.handler({ id: 'b1', type: 'decision', label: 'big', content: 'enough', workspace: 'dev' });
        assert.equal(r.isError, true);
        assert.equal(classify(r).error, 'workspace_quota_exceeded');
        assert.equal(graph.upsertCalls.length, 0);
    });

    /* ── back-compat: no quotaStore wired → no gate ── */
    await test('store_node: no quotaStore wired → no quota gate (cloud/legacy)', async () => {
        const { deps, graph } = makeDeps(undefined, undefined);
        const srv = new FakeMcpServer();
        registerStoreNodeTool(srv as never, deps);
        const storeNode = srv.tools.find(t => t.name === 'store_node')!;
        const r = await storeNode.handler({ id: 'n1', type: 'decision', label: 'x', workspace: 'dev' });
        assert.notEqual(r.isError, true, `unwired quota must not block: ${JSON.stringify(r)}`);
        assert.equal(graph.upsertCalls.length, 1, 'write proceeds when quota unwired');
    });

    /* ── no cap configured (entry lacks maxNodes) → allowed ── */
    await test('store_node: workspace entry has no caps → allowed', async () => {
        const quotaStore = new InMemoryWorkspaceQuotaStore();
        const { deps, graph } = makeDeps(quotaStore, () => entry()); // no maxNodes/maxStorageBytes
        const srv = new FakeMcpServer();
        registerStoreNodeTool(srv as never, deps);
        const storeNode = srv.tools.find(t => t.name === 'store_node')!;
        const r = await storeNode.handler({ id: 'n1', type: 'decision', label: 'x', workspace: 'dev' });
        assert.notEqual(r.isError, true, `no cap → allowed: ${JSON.stringify(r)}`);
        assert.equal(graph.upsertCalls.length, 1);
        // Counter still bumps so a later-added cap reconciles correctly.
        assert.equal(quotaStore.snapshot('dev').nodeCount, 1);
    });

    console.log(`\nL-033: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
