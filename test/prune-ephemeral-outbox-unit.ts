#!/usr/bin/env tsx
/**
 * test/prune-ephemeral-outbox-unit.ts — ITEM X-pruneeph regression
 * (2026-09-03).
 *
 * `pruneEphemeralNodes` (engines/surrealGraph.ts, ~:539-578) called
 * `this.deleteNode(id)` directly for every expired ephemeral node. That path
 * is reached from POST /api/prune-ephemeral (mcp/http/routes/retention/
 * policy.ts) and the `prune_ephemeral` MCP tool (mcp/tools/governance.ts) —
 * BOTH bypass every discipline `prune_nodes` hard_delete and `delete_node`
 * already go through: no `nodeWriteLock`, no `node.delete` / `verbatim.
 * tombstone` outbox rows, and no verbatim tombstone at all. That orphans the
 * LanceDB vector row (content stays semantically recallable after the graph
 * node is gone) and leaves the outbox blind to the delete (a replay of a
 * still-pending `verbatim.upsert` from the original create can resurrect the
 * tombstoned — or here, never-tombstoned — content).
 *
 * Fix: SurrealGraph now exposes a query-only `listExpiredEphemeralNodeIds()`
 * (the expiry-math half of the old `pruneEphemeralNodes`, extracted so it can
 * be reused without the unsafe per-node delete). The two safety-critical
 * callers use it and do the delete themselves: per-id `withNodeLock`,
 * re-check the node is STILL ephemeral + STILL expired inside the lock
 * (a concurrent upsert may have refreshed its TTL), record `node.delete`
 * then delete the graph node, tombstone the verbatim row (awaited) and
 * record `verbatim.tombstone` — the exact shape `prune_nodes` hard_delete
 * uses (mcp/tools/lifecycle.ts). `pruneEphemeralNodes` itself is UNCHANGED
 * (still used by the daemon's non-fatal boot-time prune, mcp/server.ts).
 *
 * Shape: the real production stack, no mocks — a real `SurrealGraph`, a real
 * `VerbatimStore`, a real `FileOutboxStore`, the REAL `prune_ephemeral` MCP
 * tool handler (captured via a FakeMcpServer, the pattern
 * test/prune-stale-snapshot-race-unit.ts and test/verbatim-tombstone-outbox-
 * replay-unit.ts established) and the REAL `tryPolicyRoutes` HTTP handler
 * (fake req/res). The race test wraps the real SurrealGraph so a concurrent
 * TTL-refreshing upsert is awaited to full completion BETWEEN the real
 * `listExpiredEphemeralNodeIds()` call returning its result and that result
 * reaching the caller — deterministically placing the race in the exact
 * window the fix's in-lock re-check must catch, without timing hacks.
 *
 * Run: npx tsx test/prune-ephemeral-outbox-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { registerGovernanceTools, type GovernanceToolsDeps } from '../packages/lore/src/mcp/tools/governance.js';
import { tryPolicyRoutes } from '../packages/lore/src/mcp/http/routes/retention/policy.js';
import type { RetentionDeps } from '../packages/lore/src/mcp/http/routes/retention/shared.js';
import { dispatch, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import type { StorageBundle } from '../packages/lore/src/mcp/services.js';
import { runBootEphemeralPrune } from '../packages/lore/src/mcp/bootEphemeralPrune.js';

class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'prune-ephemeral-unit-const'; }
    get dimension() { return 8; }
    async initialize() { /* no-op */ }
    private vec() { return new Array(8).fill(0.1); }
    async embed() { return this.vec(); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}

function mkTmp(prefix: string): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

interface Stack {
    graph: SurrealGraph;
    store: VerbatimStore;
    outboxStore: FileOutboxStore;
    close: () => Promise<void>;
}

async function openStack(prefix: string): Promise<Stack> {
    const g = mkTmp(`${prefix}-g-`);
    const v = mkTmp(`${prefix}-v-`);
    const o = mkTmp(`${prefix}-o-`);
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    return {
        graph, store, outboxStore,
        close: async () => {
            await store.close().catch(() => undefined);
            await graph.close().catch(() => undefined);
            g.cleanup(); v.cleanup(); o.cleanup();
        },
    };
}

/** Seed an ephemeral node — real create through nodeUpsert, so it leaves the
 *  normal node.upsert + verbatim.upsert outbox rows pending (matches how a
 *  real caller creates one; the pruner is what's under test, not creation). */
function seedEphemeral(stack: Stack, workspace: string, id: string, ttlMs: number): Promise<{ ok: boolean }> {
    return nodeUpsert(
        {
            id, workspace, ecosystem: '*', initiator: 'test:seed',
            nodeData: {
                id, type: 'note', label: 'scratch', content: `secret-content-${id}`,
                tags: ['t'], security_scopes: [] as string[],
                ephemeral: true, ttl_ms: ttlMs,
            },
            targetGraph: stack.graph,
        },
        {
            outboxStore: stack.outboxStore,
            inlineVerbatim: { verbatimStore: (w) => stack.store.store(w) },
        },
    );
}

/**
 * Wraps a real SurrealGraph so its `listExpiredEphemeralNodeIds()` — the
 * query snapshot the safety-critical callers now take before their per-id
 * lock loop — awaits `onListed` to full completion exactly once, AFTER the
 * real query resolves but BEFORE the (unchanged) result reaches the caller.
 * That deterministically places a concurrent TTL-refreshing upsert in the
 * window between "expired-ids snapshot taken" and "loop reaches this id" —
 * the exact race window the in-lock re-check must catch.
 */
function raceOnListExpired(real: SurrealGraph, onListed: () => Promise<unknown>) {
    let fired = false;
    return {
        initialize: () => real.initialize(),
        getNode: (id: string) => real.getNode(id),
        deleteNode: (id: string) => real.deleteNode(id),
        listExpiredEphemeralNodeIds: async (ttlMs: number) => {
            const result = await real.listExpiredEphemeralNodeIds(ttlMs);
            if (!fired) { fired = true; await onListed(); }
            return result;
        },
    };
}

function realDispatchSubstrates(graph: SurrealGraph, store: VerbatimStore): DispatcherSubstrates {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-prune-ephemeral-wiring-'));
    const wiring = wireOutbox({
        loreDir: tmp,
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => graph as never,
        getVerbatim: () => store,
    });
    return (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
}

interface RecordedTool { name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>; }
class FakeMcpServer {
    public tools: RecordedTool[] = [];
    tool(name: string, _d: string, _s: unknown, handler: RecordedTool['handler']) { this.tools.push({ name, handler }); }
}

function parseResult(r: { content: Array<{ text: string }> }): Record<string, unknown> {
    return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

function fakeReq(body: string): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST',
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

console.log('\nprune_ephemeral outbox/tombstone/lock discipline — regression (ITEM X-pruneeph)\n');

/* ─── MCP surface: mcp/tools/governance.ts ─────────────────────────── */

test('MCP prune_ephemeral: expired node with a verbatim row — graph gone, verbatim tombstoned, node.delete + verbatim.tombstone recorded, replay converges', async () => {
    const stack = await openStack('lore-pruneeph-mcp');
    const ws = 'w-mcp';
    try {
        const id = 'eph-mcp-1';
        const seeded = await seedEphemeral(stack, ws, id, 1);
        assert.equal(seeded.ok, true);
        await sleep(20); // past the 1ms ttl

        const rowsAfterCreate = await stack.outboxStore.listPendingForWorkspace(ws, 1000);
        assert.deepEqual(
            rowsAfterCreate.map((r) => r.operationKind),
            ['node.upsert', 'verbatim.upsert'],
            'sanity: seeding leaves exactly these two rows pending',
        );

        const srv = new FakeMcpServer();
        const deps: GovernanceToolsDeps = {
            store: { loreGraph: stack.graph, loreVerbatim: stack.store, storageClient: { verbatimDelete: async () => undefined } } as unknown as StorageBundle,
            getSyncEngine: () => ({} as never),
            detectedScope: { workspace: ws, ecosystem: '*' },
            outboxStore: stack.outboxStore,
        };
        registerGovernanceTools(srv as never, deps);
        const prune = srv.tools.find((t) => t.name === 'prune_ephemeral')!;

        const result = parseResult(await prune.handler({ workspace: ws, defaultTtlMs: 3_600_000 }));
        assert.equal(result['deleted'], 1, `expected 1 deleted, got ${JSON.stringify(result)}`);

        const graphAfter = await stack.graph.getNode(id);
        assert.equal(graphAfter, null, 'BUG: pruned node still readable in the graph');

        const verbatimAfter = await stack.store.getById(`lore:${id}`);
        assert.ok(verbatimAfter?.text?.startsWith('[TOMBSTONED'), `BUG: verbatim row was not tombstoned — got ${JSON.stringify(verbatimAfter?.text?.slice(0, 60))}`);

        const rowsAfterPrune = await stack.outboxStore.listPendingForWorkspace(ws, 1000);
        assert.deepEqual(
            rowsAfterPrune.map((r) => r.operationKind),
            ['node.upsert', 'verbatim.upsert', 'node.delete', 'verbatim.tombstone'],
            `BUG: prune must record node.delete then verbatim.tombstone — got ${JSON.stringify(rowsAfterPrune.map((r) => r.operationKind))}`,
        );

        // Replay convergence: a crash-recovery replay / replicator tick that
        // walks ALL pending rows in commit order must not resurrect the
        // pruned node or its content.
        const substrates = realDispatchSubstrates(stack.graph, stack.store);
        for (const entry of rowsAfterPrune) await dispatch(entry, substrates);
        const graphFinal = await stack.graph.getNode(id);
        const verbatimFinal = await stack.store.getById(`lore:${id}`);
        assert.equal(graphFinal, null, 'BUG: replay resurrected the pruned node in the graph');
        assert.ok(verbatimFinal?.text?.startsWith('[TOMBSTONED'), 'BUG: replay resurrected the pruned verbatim content');
    } finally {
        await stack.close();
    }
});

test('MCP prune_ephemeral: a concurrent upsert that refreshes the TTL between the query and the per-id lock is NOT deleted', async () => {
    const stack = await openStack('lore-pruneeph-mcp-race');
    const ws = 'w-mcp-race';
    try {
        const id = 'eph-mcp-race-1';
        const seeded = await seedEphemeral(stack, ws, id, 1);
        assert.equal(seeded.ok, true);
        await sleep(20); // past the 1ms ttl, so the initial query sees it as expired

        const raceGraph = raceOnListExpired(stack.graph, async () => {
            // Concurrent upsert on the SAME id, refreshing createdAt (via a
            // new upsert) and widening ttl_ms — simulates an in-flight task
            // touching its own scratch node between the prune's query and
            // its turn in the per-id lock loop.
            const refreshed = await nodeUpsert(
                {
                    id, workspace: ws, ecosystem: '*', initiator: 'test:refresh',
                    nodeData: {
                        id, type: 'note', label: 'scratch', content: 'still-in-use',
                        tags: ['t'], security_scopes: [] as string[],
                        ephemeral: true, ttl_ms: 3_600_000,
                    },
                    targetGraph: stack.graph,
                },
                { outboxStore: stack.outboxStore, inlineVerbatim: { verbatimStore: (w) => stack.store.store(w) } },
            );
            assert.equal(refreshed.ok, true, 'concurrent TTL-refreshing upsert must succeed');
        });

        const srv = new FakeMcpServer();
        const deps: GovernanceToolsDeps = {
            store: { loreGraph: raceGraph, loreVerbatim: stack.store, storageClient: { verbatimDelete: async () => undefined } } as unknown as StorageBundle,
            getSyncEngine: () => ({} as never),
            detectedScope: { workspace: ws, ecosystem: '*' },
            outboxStore: stack.outboxStore,
        };
        registerGovernanceTools(srv as never, deps);
        const prune = srv.tools.find((t) => t.name === 'prune_ephemeral')!;

        const result = parseResult(await prune.handler({ workspace: ws, defaultTtlMs: 3_600_000 }));
        assert.equal(result['deleted'], 0, `BUG: must not report a delete for a node whose TTL was refreshed mid-prune, got ${JSON.stringify(result)}`);

        const finalNode = await stack.graph.getNode(id);
        assert.ok(finalNode, 'BUG: prune deleted a node whose TTL was refreshed between the query and the lock');
        assert.equal(finalNode?.content, 'still-in-use', 'node must keep the concurrent write\'s content');
    } finally {
        await stack.close();
    }
});

/* ─── REST surface: mcp/http/routes/retention/policy.ts ────────────── */

test('HTTP POST /api/prune-ephemeral: expired node with a verbatim row — graph gone, verbatim tombstoned, node.delete + verbatim.tombstone recorded, replay converges', async () => {
    const stack = await openStack('lore-pruneeph-http');
    const ws = 'w-http';
    try {
        const id = 'eph-http-1';
        const seeded = await seedEphemeral(stack, ws, id, 1);
        assert.equal(seeded.ok, true);
        await sleep(20);

        const deps: RetentionDeps = {
            store: { loreGraph: stack.graph, loreVerbatim: stack.store, storageClient: { verbatimDelete: async () => undefined } } as unknown as StorageBundle,
            auditLog: { log: () => undefined } as unknown as RetentionDeps['auditLog'],
            runRetentionSweep: async () => { throw new Error('not used by this route'); },
            deploymentMode: 'local',
            dataplane: null,
            detectedScope: { workspace: ws, ecosystem: '*' },
            outboxStore: stack.outboxStore,
        };

        const res = fakeRes();
        const body = JSON.stringify({ defaultTtlMs: 3_600_000 });
        const handled = await tryPolicyRoutes(fakeReq(body), res, deps, '/api/prune-ephemeral');
        assert.equal(handled, true);
        const result = JSON.parse(res._body) as Record<string, unknown>;
        assert.equal(result['deleted'], 1, `expected 1 deleted, got ${res._body}`);

        const graphAfter = await stack.graph.getNode(id);
        assert.equal(graphAfter, null, 'BUG: pruned node still readable in the graph');

        const verbatimAfter = await stack.store.getById(`lore:${id}`);
        assert.ok(verbatimAfter?.text?.startsWith('[TOMBSTONED'), `BUG: verbatim row was not tombstoned — got ${JSON.stringify(verbatimAfter?.text?.slice(0, 60))}`);

        const rowsAfterPrune = await stack.outboxStore.listPendingForWorkspace(ws, 1000);
        assert.deepEqual(
            rowsAfterPrune.map((r) => r.operationKind),
            ['node.upsert', 'verbatim.upsert', 'node.delete', 'verbatim.tombstone'],
            `BUG: prune must record node.delete then verbatim.tombstone — got ${JSON.stringify(rowsAfterPrune.map((r) => r.operationKind))}`,
        );

        const substrates = realDispatchSubstrates(stack.graph, stack.store);
        for (const entry of rowsAfterPrune) await dispatch(entry, substrates);
        const graphFinal = await stack.graph.getNode(id);
        const verbatimFinal = await stack.store.getById(`lore:${id}`);
        assert.equal(graphFinal, null, 'BUG: replay resurrected the pruned node in the graph');
        assert.ok(verbatimFinal?.text?.startsWith('[TOMBSTONED'), 'BUG: replay resurrected the pruned verbatim content');
    } finally {
        await stack.close();
    }
});

test('HTTP POST /api/prune-ephemeral: a concurrent upsert that refreshes the TTL between the query and the per-id lock is NOT deleted', async () => {
    const stack = await openStack('lore-pruneeph-http-race');
    const ws = 'w-http-race';
    try {
        const id = 'eph-http-race-1';
        const seeded = await seedEphemeral(stack, ws, id, 1);
        assert.equal(seeded.ok, true);
        await sleep(20);

        const raceGraph = raceOnListExpired(stack.graph, async () => {
            const refreshed = await nodeUpsert(
                {
                    id, workspace: ws, ecosystem: '*', initiator: 'test:refresh',
                    nodeData: {
                        id, type: 'note', label: 'scratch', content: 'still-in-use',
                        tags: ['t'], security_scopes: [] as string[],
                        ephemeral: true, ttl_ms: 3_600_000,
                    },
                    targetGraph: stack.graph,
                },
                { outboxStore: stack.outboxStore, inlineVerbatim: { verbatimStore: (w) => stack.store.store(w) } },
            );
            assert.equal(refreshed.ok, true, 'concurrent TTL-refreshing upsert must succeed');
        });

        const deps: RetentionDeps = {
            store: { loreGraph: raceGraph, loreVerbatim: stack.store, storageClient: { verbatimDelete: async () => undefined } } as unknown as StorageBundle,
            auditLog: { log: () => undefined } as unknown as RetentionDeps['auditLog'],
            runRetentionSweep: async () => { throw new Error('not used by this route'); },
            deploymentMode: 'local',
            dataplane: null,
            detectedScope: { workspace: ws, ecosystem: '*' },
            outboxStore: stack.outboxStore,
        };

        const res = fakeRes();
        const body = JSON.stringify({ defaultTtlMs: 3_600_000 });
        const handled = await tryPolicyRoutes(fakeReq(body), res, deps, '/api/prune-ephemeral');
        assert.equal(handled, true);
        const result = JSON.parse(res._body) as Record<string, unknown>;
        assert.equal(result['deleted'], 0, `BUG: must not report a delete for a node whose TTL was refreshed mid-prune, got ${res._body}`);

        const finalNode = await stack.graph.getNode(id);
        assert.ok(finalNode, 'BUG: prune deleted a node whose TTL was refreshed between the query and the lock');
        assert.equal(finalNode?.content, 'still-in-use', 'node must keep the concurrent write\'s content');
    } finally {
        await stack.close();
    }
});

/* ─── Boot path: mcp/server.ts's daemon-startup prune ──────────────── */

test('Boot-time prune (mcp/server.ts): expired node with a verbatim row — graph gone, verbatim tombstoned, node.delete + verbatim.tombstone recorded', async () => {
    // ITEM boot-pruneeph — mcp/server.ts's startup prune used to call
    // `store.storageClient.pruneEphemeralNodes()` directly, bypassing the
    // nodeWriteLock / outbox / verbatim-tombstone discipline this file
    // already covers for the HTTP route and the MCP tool. It now calls
    // `runBootEphemeralPrune` (mcp/bootEphemeralPrune.ts) — the EXACT
    // function mcp/server.ts's boot path calls — which wraps the SAME
    // `safePruneEphemeralNodes` shared function the HTTP route and MCP tool
    // use (see engines/safeEphemeralPrune.ts). No workspaceVerbatimResolver
    // here, so it falls back to the boot VerbatimStore instance directly —
    // matches mcp/server.ts's own fallback ternary.
    const stack = await openStack('lore-pruneeph-boot');
    const ws = 'w-boot';
    try {
        const id = 'eph-boot-1';
        const seeded = await seedEphemeral(stack, ws, id, 1);
        assert.equal(seeded.ok, true);
        await sleep(20); // past the 1ms ttl

        const rowsAfterCreate = await stack.outboxStore.listPendingForWorkspace(ws, 1000);
        assert.deepEqual(
            rowsAfterCreate.map((r) => r.operationKind),
            ['node.upsert', 'verbatim.upsert'],
            'sanity: seeding leaves exactly these two rows pending',
        );

        await runBootEphemeralPrune({
            graph: stack.graph,
            workspace: ws,
            outboxStore: stack.outboxStore,
            workspaceVerbatimResolver: undefined,
            verbatimStore: stack.store,
        });

        const graphAfter = await stack.graph.getNode(id);
        assert.equal(graphAfter, null, 'BUG: pruned node still readable in the graph');

        const verbatimAfter = await stack.store.getById(`lore:${id}`);
        assert.ok(verbatimAfter?.text?.startsWith('[TOMBSTONED'), `BUG: verbatim row was not tombstoned — got ${JSON.stringify(verbatimAfter?.text?.slice(0, 60))}`);

        const rowsAfterPrune = await stack.outboxStore.listPendingForWorkspace(ws, 1000);
        assert.deepEqual(
            rowsAfterPrune.map((r) => r.operationKind),
            ['node.upsert', 'verbatim.upsert', 'node.delete', 'verbatim.tombstone'],
            `BUG: boot-time prune must record node.delete then verbatim.tombstone — got ${JSON.stringify(rowsAfterPrune.map((r) => r.operationKind))}`,
        );
    } finally {
        await stack.close();
    }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
