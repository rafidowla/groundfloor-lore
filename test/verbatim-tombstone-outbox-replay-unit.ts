#!/usr/bin/env tsx
/**
 * test/verbatim-tombstone-outbox-replay-unit.ts — QA A2 finding 2 regression
 * (2026-09-03).
 *
 * `nodeUpsert()` (core/nodeService.ts + nodeServiceVerbatim.ts) records
 * `node.upsert` + `verbatim.upsert` outbox rows on every create, but never
 * marks them 'replicated' on the synchronous path — they stay 'pending' by
 * design (the SAME outbox row is what a cloud/remote lane would later push;
 * the replicator's own tick is a second, redundant, idempotent consumer of
 * the same durable row). Every node-delete path (MCP `delete_node`, REST
 * `DELETE /api/node/:id`, `/api/nodes/bulk-delete`, changeset delete,
 * `prune_nodes` hard_delete) tombstoned the verbatim mirror INLINE but
 * recorded NO outbox row for that fact. So a later replicator tick (the
 * 250 ms idle poll) or a crash-recovery replay on restart would walk the
 * workspace's pending rows in commit order, reach the stale `verbatim.upsert`
 * from the ORIGINAL create, and re-store its content — resurrecting deleted
 * content into LanceDB while the graph correctly stayed deleted. Durable,
 * silent, and systemic (every delete path shared the gap).
 *
 * Fix: every delete path now ALSO records a `verbatim.tombstone` outbox row
 * (outbox/types.ts), sequenced AFTER its `node.delete` row, mapped by the
 * dispatcher (outbox/dispatcher.ts) to `verbatimStore.tombstone(id, reason)`
 * and wired in outbox/wiring.ts. It cross-supersedes `verbatim.upsert` on the
 * same id in the RA-6 guard (outbox/supersession.ts), mirroring the existing
 * node.upsert/node.delete pairing. Replaying the FULL row set in commit order
 * now converges to graph-absent + verbatim-tombstoned regardless of what
 * stale rows precede the tombstone.
 *
 * Shape: the real production stack, no mocks — a real `SurrealGraph`, a real
 * `VerbatimStore`, a real `FileOutboxStore`, the REAL `delete_node` MCP tool
 * handler (captured via a FakeMcpServer, mirroring
 * test/final-audit-fixes-unit.ts) for steps 1-2, and the REAL `dispatch()`
 * (outbox/dispatcher.ts) driven by the REAL substrates `wireOutbox()`
 * (outbox/wiring.ts) builds — extracted from the replicator instance, the
 * pattern test/sp-f3-workspace-replay-routing-unit.ts established — for the
 * replay step. The replay step constructs its OWN fresh wiring/replicator
 * against the same on-disk outbox + graph + verbatim directories, so it
 * exercises the same code path a crash-recovery replay on restart would (no
 * in-memory state carried over from the live write path).
 *
 * Run: npx tsx test/verbatim-tombstone-outbox-replay-unit.ts
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
import { registerDeleteNodeTool } from '../packages/lore/src/mcp/tools/memory/deleteNode.js';
import type { MemoryToolsDeps } from '../packages/lore/src/mcp/tools/memory/types.js';
import { dispatch, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { tryNodeDeleteRoute } from '../packages/lore/src/mcp/http/routes/nodes-delete.js';
import { handleBulkDelete } from '../packages/lore/src/mcp/http/routes/bulkWriteEdgesDelete.js';
import { applyChangesetDelete } from '../packages/lore/src/mcp/changesetWrite.js';
import { registerLifecycleTools } from '../packages/lore/src/mcp/tools/lifecycle.js';
import { loreHome } from '../packages/lore/src/config/loreHome.js';
// ITEM X-walnode (2026-09-03) — MemoryToolsDeps.getWal is a REQUIRED field
// (mcp/tools/memory/types.ts); delete_node now calls it unconditionally
// when the delete lands in the active workspace, mirroring store_node /
// store_edge. Every fixture below that builds a MemoryToolsDeps needs a
// real WriteAheadLog so that call doesn't throw.
import { WriteAheadLog } from '../packages/lore/src/engines/syncEngine.js';

class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'tombstone-replay-const'; }
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

const WORKSPACE = 'w';

interface RecordedTool { name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>; }
class FakeMcpServer {
    public tools: RecordedTool[] = [];
    tool(name: string, _d: string, _s: unknown, handler: RecordedTool['handler']) { this.tools.push({ name, handler }); }
}

/**
 * Builds the REAL dispatcher substrates via `wireOutbox()` (mirrors
 * test/sp-f3-workspace-replay-routing-unit.ts's `substratesFromWiring`), so
 * the replay step below drives the SAME `tombstoneVerbatim` closure
 * production boot wires — not a hand-rolled stand-in. A fresh wiring/outbox
 * temp dir per call: the replay's own outbox bookkeeping (replication
 * cursors) must not need anything from the write path's in-memory state.
 */
function realDispatchSubstrates(graph: SurrealGraph, store: VerbatimStore): DispatcherSubstrates {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-tombstone-replay-wiring-'));
    const wiring = wireOutbox({
        loreDir: tmp,
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => graph as never,
        getVerbatim: () => store,
    });
    return (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
}

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

console.log('\nverbatim.tombstone outbox replay — regression (A2 finding 2)\n');

test('delete_node (MCP) then a full replicator-shaped replay: graph absent AND verbatim tombstoned, not resurrected', async () => {
    const g = mkTmp('lore-tombreplay-g-');
    const v = mkTmp('lore-tombreplay-v-');
    const o = mkTmp('lore-tombreplay-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    try {
        const id = 'resurrect-node-unit';

        // Step 1: real create — leaves node.upsert + verbatim.upsert PENDING
        // (never marked replicated on the synchronous path — see nodeService
        // + nodeServiceVerbatim; that is by design, not the bug).
        const seed = await nodeUpsert(
            {
                id, workspace: WORKSPACE, ecosystem: '*', initiator: 'test:seed',
                nodeData: { id, type: 'note', label: 'seed', content: 'content-seed', tags: ['t'], security_scopes: [] as string[] },
                targetGraph: graph,
            },
            { outboxStore, inlineVerbatim: { verbatimStore: (w) => store.store(w) } },
        );
        assert.equal(seed.ok, true, 'seed write must succeed');
        const rowsAfterCreate = await outboxStore.listPendingForWorkspace(WORKSPACE, 1000);
        assert.deepEqual(
            rowsAfterCreate.map((r) => r.operationKind),
            ['node.upsert', 'verbatim.upsert'],
            'sanity: create leaves exactly these two rows pending',
        );

        // Step 2: the REAL delete_node MCP tool, run to full completion (not
        // concurrent with anything). Only the fields the handler's runtime
        // path actually touches are supplied — the rest of MemoryToolsDeps
        // is irrelevant to this tool and is cast away.
        const srv = new FakeMcpServer();
        const wal = new WriteAheadLog(o.dir);
        const deps = {
            store: { loreGraph: graph, loreVerbatim: store, storageClient: { verbatimDelete: async () => undefined } },
            detectedScope: { workspace: WORKSPACE, ecosystem: '*' },
            outboxStore,
            auditLog: { log: () => undefined },
            getWal: () => wal,
        } as unknown as MemoryToolsDeps;
        registerDeleteNodeTool(srv as never, deps);
        const del = srv.tools.find((t) => t.name === 'delete_node')!;
        const delResult = JSON.parse((await del.handler({ id, workspace: WORKSPACE })).content[0]!.text) as { deleted: boolean };
        assert.equal(delResult.deleted, true, 'delete_node must report success');

        const graphAfterDelete = await graph.getNode(id);
        const rowAfterDelete = await store.getById(`lore:${id}`);
        assert.equal(graphAfterDelete, null, 'graph must be empty right after delete');
        assert.ok(rowAfterDelete?.text?.startsWith('[TOMBSTONED'), 'verbatim must be tombstoned right after delete');

        const rowsAfterDelete = await outboxStore.listPendingForWorkspace(WORKSPACE, 1000);
        assert.deepEqual(
            rowsAfterDelete.map((r) => r.operationKind),
            ['node.upsert', 'verbatim.upsert', 'node.delete', 'verbatim.tombstone'],
            `delete must record a verbatim.tombstone row AFTER node.delete — got ${JSON.stringify(rowsAfterDelete.map((r) => r.operationKind))}`,
        );

        // Step 3: simulate a replicator tick / crash-recovery replay — dispatch
        // ALL pending rows for the workspace, in commit order, through the
        // REAL production substrates (fresh wiring instance, same on-disk
        // graph + verbatim — nothing carried over from the write path above).
        const substrates = realDispatchSubstrates(graph, store);
        const pendingRows = await outboxStore.listPendingForWorkspace(WORKSPACE, 1000);
        for (const entry of pendingRows) {
            await dispatch(entry, substrates);
        }

        const graphFinal = await graph.getNode(id);
        const verbatimFinal = await store.getById(`lore:${id}`);
        assert.equal(graphFinal, null, 'BUG: replay resurrected the node in the graph');
        assert.ok(
            verbatimFinal?.text?.startsWith('[TOMBSTONED'),
            `BUG: replay resurrected the verbatim content — got text=${JSON.stringify(verbatimFinal?.text?.slice(0, 60))}`,
        );
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

// ─────────────────────────────────────────────────────────────────────────
// QA A2 round-2 (2026-09-03) — the SAME three-step shape above (create →
// delete via a SPECIFIC surface → full replicator-shaped replay), driven
// against every remaining delete path so no surface is left with the gap
// the round-2 refuter found: prune_nodes hard_delete (mcp/tools/lifecycle.ts
// + its HTTP twin) and changeset delete (mcp/changesetWrite.ts) called
// graph.deleteNode directly with NO node.delete outbox row, so a still-
// pending node.upsert from the original create had nothing in the 'node'
// outbox family to supersede it — a replay resurrected the node in the
// GRAPH itself (worse than the verbatim-only bug this file's first test
// pins). DELETE /api/node/:id and bulk-delete were already correct (their
// node.delete row predates this round) and are included here for
// completeness/parity, not because they were broken.
// ─────────────────────────────────────────────────────────────────────────

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
function fakeReq(): IncomingMessage {
    return { method: 'DELETE', on: () => undefined } as unknown as IncomingMessage;
}

test('REST DELETE /api/node/:id then a full replay: graph absent AND verbatim tombstoned', async () => {
    const g = mkTmp('lore-tombreplay-rest-g-');
    const v = mkTmp('lore-tombreplay-rest-v-');
    const o = mkTmp('lore-tombreplay-rest-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    const ws = 'w-rest';
    try {
        const id = 'rest-resurrect-node';
        const seed = await nodeUpsert(
            { id, workspace: ws, ecosystem: '*', initiator: 'test:seed',
              nodeData: { id, type: 'note', label: 'seed', content: 'rest-content', tags: ['t'], security_scopes: [] as string[] },
              targetGraph: graph },
            { outboxStore, inlineVerbatim: { verbatimStore: (w) => store.store(w) } },
        );
        assert.equal(seed.ok, true);

        const res = fakeRes();
        const handled = await tryNodeDeleteRoute(
            fakeReq(), res, `/api/node/${id}?workspace=${ws}`, `/api/node/${id}`,
            {
                deploymentMode: 'local', dataplane: null,
                store: { loreGraph: graph, loreVerbatim: store } as never,
                auditLog: { log: () => undefined } as never,
                outboxStore,
            },
        );
        assert.equal(handled, true);
        assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);

        const rowsAfterDelete = await outboxStore.listPendingForWorkspace(ws, 1000);
        assert.deepEqual(
            rowsAfterDelete.map((r) => r.operationKind),
            ['node.upsert', 'verbatim.upsert', 'node.delete', 'verbatim.tombstone'],
            `got ${JSON.stringify(rowsAfterDelete.map((r) => r.operationKind))}`,
        );

        const substrates = realDispatchSubstrates(graph, store);
        for (const entry of rowsAfterDelete) await dispatch(entry, substrates);

        assert.equal(await graph.getNode(id), null, 'BUG: replay resurrected the node in the graph');
        const verbatimFinal = await store.getById(`lore:${id}`);
        assert.ok(verbatimFinal?.text?.startsWith('[TOMBSTONED'), 'BUG: replay resurrected the verbatim content');
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

test('bulk-delete (/api/nodes/bulk-delete) then a full replay: graph absent AND verbatim tombstoned', async () => {
    const g = mkTmp('lore-tombreplay-bulk-g-');
    const v = mkTmp('lore-tombreplay-bulk-v-');
    const o = mkTmp('lore-tombreplay-bulk-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    const ws = 'w-bulk';
    try {
        const id = 'bulk-resurrect-node';
        const seed = await nodeUpsert(
            { id, workspace: ws, ecosystem: '*', initiator: 'test:seed',
              nodeData: { id, type: 'note', label: 'seed', content: 'bulk-content', tags: ['t'], security_scopes: [] as string[] },
              targetGraph: graph },
            { outboxStore, inlineVerbatim: { verbatimStore: (w) => store.store(w) } },
        );
        assert.equal(seed.ok, true);

        const res = fakeRes();
        const handled = await handleBulkDelete(
            res,
            { ids: [id], workspace: ws },
            {
                store: { loreGraph: graph, loreVerbatim: store } as never,
                auditLog: { log: () => undefined } as never,
                deploymentMode: 'local', dataplane: null,
                outboxStore,
            },
        );
        assert.equal(handled, true);
        assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);

        const rowsAfterDelete = await outboxStore.listPendingForWorkspace(ws, 1000);
        assert.deepEqual(
            rowsAfterDelete.map((r) => r.operationKind),
            ['node.upsert', 'verbatim.upsert', 'node.delete', 'verbatim.tombstone'],
            `got ${JSON.stringify(rowsAfterDelete.map((r) => r.operationKind))}`,
        );

        const substrates = realDispatchSubstrates(graph, store);
        for (const entry of rowsAfterDelete) await dispatch(entry, substrates);

        assert.equal(await graph.getNode(id), null, 'BUG: replay resurrected the node in the graph');
        const verbatimFinal = await store.getById(`lore:${id}`);
        assert.ok(verbatimFinal?.text?.startsWith('[TOMBSTONED'), 'BUG: replay resurrected the verbatim content');
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

test('changeset delete (applyChangesetDelete) then a full replay: graph absent AND verbatim tombstoned (QA A2 round-2 finding 2 — failed before the fix)', async () => {
    const g = mkTmp('lore-tombreplay-cs-g-');
    const v = mkTmp('lore-tombreplay-cs-v-');
    const o = mkTmp('lore-tombreplay-cs-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    const ws = 'w-cs';
    try {
        const id = 'cs-resurrect-node';
        const seed = await nodeUpsert(
            { id, workspace: ws, ecosystem: '*', initiator: 'test:seed',
              nodeData: { id, type: 'note', label: 'seed', content: 'cs-content', tags: ['t'], security_scopes: [] as string[] },
              targetGraph: graph },
            { outboxStore, inlineVerbatim: { verbatimStore: (w) => store.store(w) } },
        );
        assert.equal(seed.ok, true);

        await applyChangesetDelete(
            {
                outboxStore, embedQueue: undefined, verbatim: store as never,
                workspaceVerbatimResolver: undefined, bootVerbatim: store,
                activeWorkspace: ws, initiator: 'mcp:rollback_changeset',
            },
            graph as never,
            ws,
            id,
            'changeset delete',
        );

        const rowsAfterDelete = await outboxStore.listPendingForWorkspace(ws, 1000);
        assert.deepEqual(
            rowsAfterDelete.map((r) => r.operationKind),
            ['node.upsert', 'verbatim.upsert', 'node.delete', 'verbatim.tombstone'],
            `QA A2 round-2 finding 2: changeset delete must record node.delete then verbatim.tombstone — got ${JSON.stringify(rowsAfterDelete.map((r) => r.operationKind))}`,
        );

        const substrates = realDispatchSubstrates(graph, store);
        for (const entry of rowsAfterDelete) await dispatch(entry, substrates);

        assert.equal(await graph.getNode(id), null, 'BUG: replay resurrected the changeset-deleted node in the graph');
        const verbatimFinal = await store.getById(`lore:${id}`);
        assert.ok(verbatimFinal?.text?.startsWith('[TOMBSTONED'), 'BUG: replay resurrected the verbatim content');
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

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

test('prune_nodes hard_delete (MCP) then a full replay: graph absent AND verbatim tombstoned (QA A2 round-2 finding 1 — failed before the fix)', async () => {
    const priorLoreHome = process.env['LORE_HOME'];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-tombreplay-prune-home-'));
    process.env['LORE_HOME'] = home;
    const ws = 'ws-prune-hd';
    try {
        fs.mkdirSync(loreHome(), { recursive: true });
        fs.writeFileSync(
            path.join(loreHome(), 'workspaces.json'),
            JSON.stringify({ active: ws, workspaces: [{ name: ws, path: path.join(loreHome(), ws), allowHardDelete: true }] }),
            'utf8',
        );

        const g = mkTmp('lore-tombreplay-prune-g-');
        const v = mkTmp('lore-tombreplay-prune-v-');
        const o = mkTmp('lore-tombreplay-prune-o-');
        const graph = new SurrealGraph(g.dir);
        const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
        const outboxStore = new FileOutboxStore(o.dir);
        await graph.initialize();
        await store.initialize();
        try {
            const id = 'prune-resurrect-node';
            const seed = await nodeUpsert(
                { id, workspace: ws, ecosystem: '*', initiator: 'test:seed',
                  nodeData: { id, type: 'note', label: 'seed', content: 'prune-content', tags: ['t'], security_scopes: [] as string[] },
                  targetGraph: graph },
                { outboxStore, inlineVerbatim: { verbatimStore: (w) => store.store(w) } },
            );
            assert.equal(seed.ok, true);

            const srv = new FakeLifecycleMcpServer();
            registerLifecycleTools(srv as never, {
                store: { loreGraph: graph, loreVerbatim: store } as never,
                auxStore: fakeAuxStore() as never,
                detectedScope: { workspace: ws },
                outboxStore,
            } as never);
            const prune = srv.tools.find((t) => t.name === 'prune_nodes')!;
            const pruneResult = JSON.parse((await prune.handler({ workspace: ws, dry_run: false, hard_delete: true })).content[0]!.text) as { hard_deleted: number };
            assert.equal(pruneResult.hard_deleted, 1, 'must report 1 hard-deleted');

            const rowsAfterDelete = await outboxStore.listPendingForWorkspace(ws, 1000);
            assert.deepEqual(
                rowsAfterDelete.map((r) => r.operationKind),
                ['node.upsert', 'verbatim.upsert', 'node.delete', 'verbatim.tombstone'],
                `QA A2 round-2 finding 1: prune_nodes hard_delete must record node.delete then verbatim.tombstone — got ${JSON.stringify(rowsAfterDelete.map((r) => r.operationKind))}`,
            );

            const substrates = realDispatchSubstrates(graph, store);
            for (const entry of rowsAfterDelete) await dispatch(entry, substrates);

            assert.equal(await graph.getNode(id), null, 'BUG: replay resurrected the hard-deleted node in the graph');
            const verbatimFinal = await store.getById(`lore:${id}`);
            assert.ok(verbatimFinal?.text?.startsWith('[TOMBSTONED'), 'BUG: replay resurrected the verbatim content');
        } finally {
            await store.close().catch(() => undefined);
            await graph.close().catch(() => undefined);
            g.cleanup(); v.cleanup(); o.cleanup();
        }
    } finally {
        if (priorLoreHome === undefined) delete process.env['LORE_HOME'];
        else process.env['LORE_HOME'] = priorLoreHome;
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
