#!/usr/bin/env tsx
/**
 * test/wal-delete-node-unit.ts — ITEM X-walnode regression (2026-09-03,
 * exploratory-adjacent finding from audit/verification-2026-09-03).
 *
 * `store_node` (core/nodeService.ts:627, `upsert_node`) and `store_edge`
 * (mcp/tools/memory/storeEdge.ts, `add_edge`) both append to the sync WAL.
 * No node-delete path did — despite `engines/syncEngine.ts`'s
 * `pushPendingInner` already consuming `delete_node` WAL entries (SW-02,
 * see test/sw02-wal-dataloss-unit.ts, which only ever hand-writes the entry
 * rather than exercising a real producer). So once WAL push is wired
 * (`mcp/walPushBridge.ts` is NOT wired into production today — this bug is
 * currently dormant, not user-visible), a hard node delete would never
 * reach the WAL and the sync engine would never learn about it — the
 * deleted node would resurrect on the remote's next full sync.
 *
 * Fix: every node-delete path now appends a `delete_node` WAL entry, inside
 * the SAME per-(workspace,id) lock the delete + verbatim tombstone ran
 * under, gated the same way each file already gates its own
 * active-workspace concept (mirrors the `upsert_node` append's gating):
 *   - mcp/tools/memory/deleteNode.ts       — `resolvedDel.isActive`
 *   - mcp/http/routes/nodes-delete.ts      — `targetGraph === store.loreGraph`
 *   - mcp/changesetWrite.ts (applyChangesetDelete)
 *                                          — `workspace === activeWorkspace`
 *   - mcp/tools/lifecycle.ts (prune hard_delete)
 *                                          — `resolved.isActive`
 *   - mcp/http/routes/lifecycle.ts (prune hard_delete)
 *                                          — `graphRes.isActive`
 * `bulkWriteEdgesDelete.ts` and every edge file are OUT OF SCOPE here
 * (owned by a sibling worker adding the append inside `handleBulkDelete`).
 *
 * Shape: the real production stack, no mocks for the substrates — a real
 * `SurrealGraph`, a real `VerbatimStore` (constant-vector embedder, no model
 * load), a real `WriteAheadLog` — mirroring the harness
 * test/verbatim-tombstone-outbox-replay-unit.ts established for these same
 * five delete paths. The outbox is a small order-tracking fake (not
 * `FileOutboxStore`) because what these tests need to prove about the
 * outbox is ORDERING relative to the WAL append, not outbox durability
 * semantics (already pinned elsewhere).
 *
 * FAILS before the fix (no path ever appends `delete_node`); PASSES after.
 *
 * Run: npx tsx test/wal-delete-node-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { registerDeleteNodeTool } from '../packages/lore/src/mcp/tools/memory/deleteNode.js';
import type { MemoryToolsDeps } from '../packages/lore/src/mcp/tools/memory/types.js';
import { tryNodeDeleteRoute } from '../packages/lore/src/mcp/http/routes/nodes-delete.js';
import { applyChangesetDelete } from '../packages/lore/src/mcp/changesetWrite.js';
import { registerLifecycleTools } from '../packages/lore/src/mcp/tools/lifecycle.js';
import { tryLifecycleRoutes } from '../packages/lore/src/mcp/http/routes/lifecycle.js';
import { loreHome } from '../packages/lore/src/config/loreHome.js';
import {
    SyncEngine,
    WriteAheadLog,
    type SyncAdapter,
    type SyncResult,
} from '../packages/lore/src/engines/syncEngine.js';
import type { OutboxStore, OutboxEntry } from '../packages/lore/src/outbox/types.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'wal-delete-node-const'; }
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

/** Order-tracking outbox fake — proves the WAL append happens AFTER the
 *  node.delete outbox row is recorded, without needing FileOutboxStore's
 *  on-disk durability machinery (pinned separately). */
function makeOrderingOutbox(order: string[]): OutboxStore {
    return {
        async record(entry: OutboxEntry) { order.push(`outbox:${entry.operationKind}`); },
        async markStep() { /* no-op */ },
        async markCompleted() { /* no-op */ },
        async remove() { /* no-op */ },
        async listUnfinished() { return []; },
        async batchRecord(entries: OutboxEntry[]) { for (const e of entries) order.push(`outbox:${e.operationKind}`); },
    };
}

/** Wraps a real WriteAheadLog so every `append()` also lands a marker in the
 *  shared `order` array (for ordering assertions), while every other method
 *  (readPending, etc.) delegates untouched to the real instance. */
function orderTrackingWal(wal: WriteAheadLog, order: string[]): WriteAheadLog {
    return new Proxy(wal, {
        get(target, prop, receiver) {
            if (prop === 'append') {
                return (op: string, data: Record<string, unknown>) => {
                    order.push(`wal:${op}:${String(data['id'])}`);
                    return target.append(op, data);
                };
            }
            return Reflect.get(target, prop, receiver);
        },
    });
}

let passed = 0, failed = 0;
// Sequential, not fire-and-forget: two tests below mutate the GLOBAL
// process.env['LORE_HOME'] (prune_nodes needs loadWorkspaces() to see a
// fixture workspaces.json). Running them concurrently races that mutation
// and corrupts both. All tests execute strictly one-at-a-time.
const runners: Array<() => Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    runners.push(async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    });
}

console.log('\nITEM X-walnode — delete_node WAL append (dormant until WAL push is wired)\n');

interface RecordedTool { name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>; }
class FakeMcpServer {
    public tools: RecordedTool[] = [];
    tool(name: string, _d: string, _s: unknown, handler: RecordedTool['handler']) { this.tools.push({ name, handler }); }
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
function fakeReq(method: string): IncomingMessage {
    return { method, on: () => undefined } as unknown as IncomingMessage;
}

async function seedNode(graph: SurrealGraph, store: VerbatimStore, id: string, workspace: string, content: string) {
    const seed = await nodeUpsert(
        {
            id, workspace, ecosystem: '*', initiator: 'test:seed',
            nodeData: { id, type: 'note', label: 'seed', content, tags: ['t'], security_scopes: [] as string[] },
            targetGraph: graph,
        },
        { inlineVerbatim: { verbatimStore: (w) => store.store(w) } },
    );
    assert.equal(seed.ok, true, 'seed write must succeed');
}

/* ─── 1. delete_node (MCP tool) ─────────────────────────────────────── */

test('delete_node (MCP) appends exactly one delete_node WAL entry, after its node.delete outbox row', async () => {
    const g = mkTmp('lore-walnode-mcp-g-');
    const v = mkTmp('lore-walnode-mcp-v-');
    const w = mkTmp('lore-walnode-mcp-w-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    await graph.initialize();
    await store.initialize();
    try {
        const id = 'walnode-mcp';
        const ws = 'w-mcp';
        await seedNode(graph, store, id, ws, 'mcp-content');

        const order: string[] = [];
        const outboxStore = makeOrderingOutbox(order);
        const wal = new WriteAheadLog(w.dir);

        const srv = new FakeMcpServer();
        const deps = {
            store: { loreGraph: graph, loreVerbatim: store, storageClient: { verbatimDelete: async () => undefined } },
            detectedScope: { workspace: ws, ecosystem: '*' },
            outboxStore,
            auditLog: { log: () => undefined },
            getWal: () => orderTrackingWal(wal, order),
        } as unknown as MemoryToolsDeps;
        registerDeleteNodeTool(srv as never, deps);
        const del = srv.tools.find((t) => t.name === 'delete_node')!;
        const result = JSON.parse((await del.handler({ id, workspace: ws })).content[0]!.text) as { deleted: boolean };
        assert.equal(result.deleted, true, 'delete_node must report success');

        const walEntries = wal.readPending().filter((e) => e.op === 'delete_node');
        assert.equal(walEntries.length, 1, `expected exactly 1 delete_node WAL entry, got ${walEntries.length}`);
        assert.equal(walEntries[0]!.data['id'], id, 'WAL entry must carry the deleted node id');

        const deleteIdx = order.indexOf('outbox:node.delete');
        const walIdx = order.indexOf(`wal:delete_node:${id}`);
        assert.ok(deleteIdx >= 0, `node.delete outbox row must be recorded — order: ${JSON.stringify(order)}`);
        assert.ok(walIdx > deleteIdx, `WAL delete_node must be appended AFTER the node.delete outbox row — order: ${JSON.stringify(order)}`);
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); w.cleanup();
    }
});

/* ─── 2. DELETE /api/node/:id (REST) ────────────────────────────────── */

test('DELETE /api/node/:id (REST) appends exactly one delete_node WAL entry, after its node.delete outbox row', async () => {
    const g = mkTmp('lore-walnode-rest-g-');
    const v = mkTmp('lore-walnode-rest-v-');
    const w = mkTmp('lore-walnode-rest-w-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    await graph.initialize();
    await store.initialize();
    try {
        const id = 'walnode-rest';
        const ws = 'w-rest';
        await seedNode(graph, store, id, ws, 'rest-content');

        const order: string[] = [];
        const outboxStore = makeOrderingOutbox(order);
        const wal = new WriteAheadLog(w.dir);

        const res = fakeRes();
        const handled = await tryNodeDeleteRoute(
            fakeReq('DELETE'), res, `/api/node/${id}?workspace=${ws}`, `/api/node/${id}`,
            {
                deploymentMode: 'local', dataplane: null,
                store: { loreGraph: graph, loreVerbatim: store } as never,
                auditLog: { log: () => undefined } as never,
                outboxStore,
                getWal: () => orderTrackingWal(wal, order),
            },
        );
        assert.equal(handled, true);
        assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);

        const walEntries = wal.readPending().filter((e) => e.op === 'delete_node');
        assert.equal(walEntries.length, 1, `expected exactly 1 delete_node WAL entry, got ${walEntries.length}`);
        assert.equal(walEntries[0]!.data['id'], id, 'WAL entry must carry the deleted node id');

        const deleteIdx = order.indexOf('outbox:node.delete');
        const walIdx = order.indexOf(`wal:delete_node:${id}`);
        assert.ok(deleteIdx >= 0, `node.delete outbox row must be recorded — order: ${JSON.stringify(order)}`);
        assert.ok(walIdx > deleteIdx, `WAL delete_node must be appended AFTER the node.delete outbox row — order: ${JSON.stringify(order)}`);
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); w.cleanup();
    }
});

/* ─── 3. changeset delete (applyChangesetDelete) ────────────────────── */

test('changeset delete (applyChangesetDelete) appends exactly one delete_node WAL entry, after its node.delete outbox row', async () => {
    const g = mkTmp('lore-walnode-cs-g-');
    const v = mkTmp('lore-walnode-cs-v-');
    const w = mkTmp('lore-walnode-cs-w-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    await graph.initialize();
    await store.initialize();
    try {
        const id = 'walnode-cs';
        const ws = 'w-cs';
        await seedNode(graph, store, id, ws, 'cs-content');

        const order: string[] = [];
        const outboxStore = makeOrderingOutbox(order);
        const wal = new WriteAheadLog(w.dir);

        await applyChangesetDelete(
            {
                outboxStore, embedQueue: undefined, verbatim: store as never,
                workspaceVerbatimResolver: undefined, bootVerbatim: store,
                activeWorkspace: ws, initiator: 'mcp:rollback_changeset',
                getWal: () => orderTrackingWal(wal, order),
            },
            graph as never,
            ws,
            id,
            'changeset delete',
        );

        const walEntries = wal.readPending().filter((e) => e.op === 'delete_node');
        assert.equal(walEntries.length, 1, `expected exactly 1 delete_node WAL entry, got ${walEntries.length}`);
        assert.equal(walEntries[0]!.data['id'], id, 'WAL entry must carry the deleted node id');

        const deleteIdx = order.indexOf('outbox:node.delete');
        const walIdx = order.indexOf(`wal:delete_node:${id}`);
        assert.ok(deleteIdx >= 0, `node.delete outbox row must be recorded — order: ${JSON.stringify(order)}`);
        assert.ok(walIdx > deleteIdx, `WAL delete_node must be appended AFTER the node.delete outbox row — order: ${JSON.stringify(order)}`);

        // Non-active workspace must NOT append (mirrors applyChangesetUpsert's
        // isActiveWorkspace gate — `workspace === activeWorkspace`). Fresh WAL
        // dir — `w.dir` above already holds the first case's delete_node entry.
        const id2 = 'walnode-cs-inactive';
        await seedNode(graph, store, id2, ws, 'cs-content-2');
        const w2 = mkTmp('lore-walnode-cs-w2-');
        const order2: string[] = [];
        const wal2 = new WriteAheadLog(w2.dir);
        try {
            await applyChangesetDelete(
                {
                    outboxStore: makeOrderingOutbox(order2), embedQueue: undefined, verbatim: store as never,
                    workspaceVerbatimResolver: undefined, bootVerbatim: store,
                    activeWorkspace: 'some-other-workspace', initiator: 'mcp:rollback_changeset',
                    getWal: () => orderTrackingWal(wal2, order2),
                },
                graph as never,
                ws,
                id2,
                'changeset delete non-active',
            );
            assert.equal(wal2.readPending().filter((e) => e.op === 'delete_node').length, 0, 'non-active-workspace changeset delete must NOT append to the WAL');
        } finally {
            w2.cleanup();
        }
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); w.cleanup();
    }
});

/* ─── 4. prune_nodes hard_delete (MCP) ──────────────────────────────── */

interface RecordedLifecycleTool { name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>; }
class FakeLifecycleMcpServer {
    public tools: RecordedLifecycleTool[] = [];
    tool(name: string, _d: string, _s: unknown, handler: RecordedLifecycleTool['handler']) { this.tools.push({ name, handler }); }
}
function fakeAuxStore() {
    const jobs = new Map<string, unknown>();
    let n = 0;
    return {
        createPruneJob: (workspace: string, opts: unknown) => { const id = `job-${++n}`; jobs.set(id, { id, workspace, status: 'running', options: opts }); return id; },
        updatePruneJob: (id: string, patch: unknown) => { jobs.set(id, { ...(jobs.get(id) as object), ...(patch as object) }); },
        getPruneJob: (id: string) => jobs.get(id) ?? null,
        incrementCounter: () => undefined,
    };
}

test('prune_nodes hard_delete (MCP) appends exactly one delete_node WAL entry, after its node.delete outbox row', async () => {
    const priorLoreHome = process.env['LORE_HOME'];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-walnode-prune-home-'));
    process.env['LORE_HOME'] = home;
    const ws = 'ws-walnode-prune';
    try {
        fs.mkdirSync(loreHome(), { recursive: true });
        fs.writeFileSync(
            path.join(loreHome(), 'workspaces.json'),
            JSON.stringify({ active: ws, workspaces: [{ name: ws, path: path.join(loreHome(), ws), allowHardDelete: true }] }),
            'utf8',
        );

        const g = mkTmp('lore-walnode-prune-g-');
        const v = mkTmp('lore-walnode-prune-v-');
        const w = mkTmp('lore-walnode-prune-w-');
        const graph = new SurrealGraph(g.dir);
        const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
        await graph.initialize();
        await store.initialize();
        try {
            const id = 'walnode-prune';
            await seedNode(graph, store, id, ws, 'prune-content');

            const order: string[] = [];
            const outboxStore = makeOrderingOutbox(order);
            const wal = new WriteAheadLog(w.dir);

            const srv = new FakeLifecycleMcpServer();
            registerLifecycleTools(srv as never, {
                store: { loreGraph: graph, loreVerbatim: store } as never,
                auxStore: fakeAuxStore() as never,
                detectedScope: { workspace: ws },
                outboxStore,
                getWal: () => orderTrackingWal(wal, order),
            } as never);
            const prune = srv.tools.find((t) => t.name === 'prune_nodes')!;
            const result = JSON.parse((await prune.handler({ workspace: ws, dry_run: false, hard_delete: true })).content[0]!.text) as { hard_deleted: number };
            assert.equal(result.hard_deleted, 1, 'must report 1 hard-deleted');

            const walEntries = wal.readPending().filter((e) => e.op === 'delete_node');
            assert.equal(walEntries.length, 1, `expected exactly 1 delete_node WAL entry, got ${walEntries.length}`);
            assert.equal(walEntries[0]!.data['id'], id, 'WAL entry must carry the deleted node id');

            const deleteIdx = order.indexOf('outbox:node.delete');
            const walIdx = order.indexOf(`wal:delete_node:${id}`);
            assert.ok(deleteIdx >= 0, `node.delete outbox row must be recorded — order: ${JSON.stringify(order)}`);
            assert.ok(walIdx > deleteIdx, `WAL delete_node must be appended AFTER the node.delete outbox row — order: ${JSON.stringify(order)}`);
        } finally {
            await store.close().catch(() => undefined);
            await graph.close().catch(() => undefined);
            g.cleanup(); v.cleanup(); w.cleanup();
        }
    } finally {
        if (priorLoreHome === undefined) delete process.env['LORE_HOME'];
        else process.env['LORE_HOME'] = priorLoreHome;
        fs.rmSync(home, { recursive: true, force: true });
    }
});

/* ─── 5. POST /api/nodes/prune hard_delete (REST) ───────────────────── */

test('POST /api/nodes/prune hard_delete (REST) appends exactly one delete_node WAL entry, after its node.delete outbox row', async () => {
    const priorLoreHome = process.env['LORE_HOME'];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-walnode-prune-rest-home-'));
    process.env['LORE_HOME'] = home;
    const ws = 'ws-walnode-prune-rest';
    try {
        fs.mkdirSync(loreHome(), { recursive: true });
        fs.writeFileSync(
            path.join(loreHome(), 'workspaces.json'),
            JSON.stringify({ active: ws, workspaces: [{ name: ws, path: path.join(loreHome(), ws), allowHardDelete: true }] }),
            'utf8',
        );

        const g = mkTmp('lore-walnode-prune-rest-g-');
        const v = mkTmp('lore-walnode-prune-rest-v-');
        const w = mkTmp('lore-walnode-prune-rest-w-');
        const graph = new SurrealGraph(g.dir);
        const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
        await graph.initialize();
        await store.initialize();
        try {
            const id = 'walnode-prune-rest';
            await seedNode(graph, store, id, ws, 'prune-rest-content');

            const order: string[] = [];
            const outboxStore = makeOrderingOutbox(order);
            const wal = new WriteAheadLog(w.dir);

            const res = fakeRes();
            const body = JSON.stringify({ workspace: ws, dry_run: false, hard_delete: true });
            const req = { method: 'POST', on: (event: string, cb: (chunk?: Buffer) => void) => {
                if (event === 'data') cb(Buffer.from(body));
                if (event === 'end') cb();
                return req;
            } } as unknown as IncomingMessage;

            const handled = await tryLifecycleRoutes(
                req, res, '/api/nodes/prune', '/api/nodes/prune',
                {
                    store: { loreGraph: graph, loreVerbatim: store } as never,
                    auxStore: fakeAuxStore() as never,
                    deploymentMode: 'local', dataplane: null,
                    outboxStore,
                    getWal: () => orderTrackingWal(wal, order),
                },
            );
            assert.equal(handled, true);
            assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
            const parsed = JSON.parse(res._body) as { hard_deleted: number };
            assert.equal(parsed.hard_deleted, 1, 'must report 1 hard-deleted');

            const walEntries = wal.readPending().filter((e) => e.op === 'delete_node');
            assert.equal(walEntries.length, 1, `expected exactly 1 delete_node WAL entry, got ${walEntries.length}`);
            assert.equal(walEntries[0]!.data['id'], id, 'WAL entry must carry the deleted node id');

            const deleteIdx = order.indexOf('outbox:node.delete');
            const walIdx = order.indexOf(`wal:delete_node:${id}`);
            assert.ok(deleteIdx >= 0, `node.delete outbox row must be recorded — order: ${JSON.stringify(order)}`);
            assert.ok(walIdx > deleteIdx, `WAL delete_node must be appended AFTER the node.delete outbox row — order: ${JSON.stringify(order)}`);
        } finally {
            await store.close().catch(() => undefined);
            await graph.close().catch(() => undefined);
            g.cleanup(); v.cleanup(); w.cleanup();
        }
    } finally {
        if (priorLoreHome === undefined) delete process.env['LORE_HOME'];
        else process.env['LORE_HOME'] = priorLoreHome;
        fs.rmSync(home, { recursive: true, force: true });
    }
});

/* ─── 6. upsert-then-delete leaves the WAL ending in delete_node ────── */

test('upsert-then-delete (nodeUpsert then delete_node MCP) leaves the WAL ending in delete_node', async () => {
    const g = mkTmp('lore-walnode-seq-g-');
    const v = mkTmp('lore-walnode-seq-v-');
    const w = mkTmp('lore-walnode-seq-w-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    await graph.initialize();
    await store.initialize();
    try {
        const id = 'walnode-seq';
        const ws = 'w-seq';
        const wal = new WriteAheadLog(w.dir);

        // Upsert through the SAME nodeService.ts:627 append the MCP
        // store_node tool uses (isActiveWorkspace + hooks.getWal).
        const upsertResult = await nodeUpsert(
            {
                id, workspace: ws, ecosystem: '*', initiator: 'test:seq-upsert',
                nodeData: { id, type: 'note', label: 'seq', content: 'seq-content', tags: ['t'], security_scopes: [] as string[] },
                targetGraph: graph,
                isActiveWorkspace: true,
            },
            {
                inlineVerbatim: { verbatimStore: (wsp) => store.store(wsp) },
                getWal: () => wal,
            },
        );
        assert.equal(upsertResult.ok, true);
        assert.deepEqual(wal.readPending().map((e) => e.op), ['upsert_node'], 'sanity: upsert must append upsert_node first');

        const srv = new FakeMcpServer();
        const deps = {
            store: { loreGraph: graph, loreVerbatim: store, storageClient: { verbatimDelete: async () => undefined } },
            detectedScope: { workspace: ws, ecosystem: '*' },
            auditLog: { log: () => undefined },
            getWal: () => wal,
        } as unknown as MemoryToolsDeps;
        registerDeleteNodeTool(srv as never, deps);
        const del = srv.tools.find((t) => t.name === 'delete_node')!;
        const delResult = JSON.parse((await del.handler({ id, workspace: ws })).content[0]!.text) as { deleted: boolean };
        assert.equal(delResult.deleted, true);

        const ops = wal.readPending().map((e) => e.op);
        assert.deepEqual(ops, ['upsert_node', 'delete_node'], `WAL must end in delete_node — got ${JSON.stringify(ops)}`);
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); w.cleanup();
    }
});

/* ─── 7. SyncEngine's consumer processes a producer-written entry ───── */
/* Mirrors test/sw02-wal-dataloss-unit.ts's B2 case, but the WAL entry here
 * comes from a REAL producer (delete_node) instead of a hand-written one. */

function baseAdapter(over: Partial<SyncAdapter> = {}): SyncAdapter {
    return {
        async push(): Promise<SyncResult> { return { nodesPushed: 0, edgesPushed: 0, failures: 0, errors: [] }; },
        async pull() { return { nodes: [], edges: [] }; },
        async isConnected() { return true; },
        async connect() { /* no-op */ },
        async disconnect() { /* no-op */ },
        ...over,
    };
}

test("SyncEngine.pushPending() consumes a delete_node entry the real delete_node tool produced", async () => {
    const g = mkTmp('lore-walnode-syncengine-g-');
    const v = mkTmp('lore-walnode-syncengine-v-');
    const w = mkTmp('lore-walnode-syncengine-w-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    await graph.initialize();
    await store.initialize();
    try {
        const id = 'walnode-syncengine';
        const ws = 'w-syncengine';
        await seedNode(graph, store, id, ws, 'syncengine-content');

        // The WAL instance the delete_node tool writes into lives at w.dir —
        // SAME directory (sync.wal) a SyncEngine constructed over w.dir will
        // read from, exactly like sw02's producer/consumer split.
        const producerWal = new WriteAheadLog(w.dir);
        const srv = new FakeMcpServer();
        const deps = {
            store: { loreGraph: graph, loreVerbatim: store, storageClient: { verbatimDelete: async () => undefined } },
            detectedScope: { workspace: ws, ecosystem: '*' },
            auditLog: { log: () => undefined },
            getWal: () => producerWal,
        } as unknown as MemoryToolsDeps;
        registerDeleteNodeTool(srv as never, deps);
        const del = srv.tools.find((t) => t.name === 'delete_node')!;
        const delResult = JSON.parse((await del.handler({ id, workspace: ws })).content[0]!.text) as { deleted: boolean };
        assert.equal(delResult.deleted, true);
        assert.equal(producerWal.readPending().length, 1, 'sanity: exactly one WAL entry after the delete');

        const seenDeletes: string[] = [];
        const adapter = baseAdapter({
            async pushDeletes(ids: string[]) {
                seenDeletes.push(...ids);
                return { nodesPushed: ids.length, edgesPushed: 0, failures: 0, errors: [] };
            },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const noopGraph = {} as any;
        const engine = new SyncEngine(noopGraph, w.dir, adapter);
        const result = await engine.pushPending();
        assert.equal(result.failures, 0, 'push should report no failures');
        assert.deepEqual(seenDeletes, [id], 'SyncEngine must forward the delete_node id to pushDeletes');
        assert.equal(producerWal.readPending().length, 0, 'the acked delete_node entry must be truncated from the WAL');
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); w.cleanup();
    }
});

for (const run of runners) await run();
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
