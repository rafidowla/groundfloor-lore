#!/usr/bin/env tsx
/**
 * test/prune-stale-snapshot-race-unit.ts — QA A2 finding 1 regression
 * (2026-09-03).
 *
 * `prune_nodes`' soft-archive path (mcp/tools/lifecycle.ts) and its REST twin
 * (mcp/http/routes/lifecycle.ts) build `matched` from a bulk `graph.listNodes()`
 * snapshot taken ONCE before the per-node loop starts, then — inside the
 * per-(workspace,id) lock `nodeUpsert` also holds (core/nodeWriteLock.ts) —
 * wrote `{ ...staleSnapshotNode, status: 'archived' }` straight back to the
 * graph. The lock serializes ACCESS to the id; it does nothing to refresh a
 * snapshot taken before the lock was ever requested. So a concurrent
 * store_node upsert landing on the same id AFTER the snapshot but BEFORE
 * prune's loop reaches it (no contention needed — prune may be iterating
 * thousands of other ids first, so there's plenty of elapsed wall-clock time)
 * was silently REVERTED by the archive write: the graph went back to the
 * pre-loop content while the verbatim mirror kept the concurrent write's new
 * content — a lost update, and the exact graph/verbatim split-brain shape the
 * original nodeWriteLock fix (b2e19a08) targeted, just reached through a stale
 * in-memory snapshot instead of a race for the lock itself.
 *
 * Fix: re-read the node with `graph.getNode(id)` INSIDE the lock and re-check
 * the SAME eligibility filters that built `matched` (status/classification/
 * age/tags); skip if it no longer qualifies or is gone, and patch status onto
 * the FRESH read. `restore_node` in the same files already did this correctly
 * (getNode inside the lock) — this brings prune_nodes' archive AND hard_delete
 * branches in line.
 *
 * Shape: the real production stack, no mocks — a real `SurrealGraph`, a real
 * `VerbatimStore`, the REAL `registerLifecycleTools` handler (captured via a
 * FakeMcpServer, the pattern test/final-audit-fixes-unit.ts established) and
 * the REAL `tryLifecycleRoutes` HTTP handler (fake req/res, the pattern
 * test/approvals-routes-unit.ts established). `graph.listNodes` is wrapped so
 * the concurrent upsert is awaited to full completion BETWEEN the real
 * `listNodes()` call returning its result and that result reaching the
 * caller — deterministically placing the race in the exact window the finding
 * describes, without timing hacks.
 *
 * Run: npx tsx test/prune-stale-snapshot-race-unit.ts
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
import { registerLifecycleTools, type LifecycleDeps } from '../packages/lore/src/mcp/tools/lifecycle.js';
import { tryLifecycleRoutes, type LifecycleRouteDeps } from '../packages/lore/src/mcp/http/routes/lifecycle.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import type { StorageBundle } from '../packages/lore/src/mcp/services.js';

class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'prune-race-unit-const'; }
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

// `loadWorkspaces()` (mcp/tools & mcp/http/routes lifecycle.ts both call it
// directly, not via a test seam) auto-creates a workspace named 'default' on
// first call in this test process's isolated per-pid LORE_HOME (see
// config/loreHome.ts's isTestProcess) — using that name avoids needing to
// hand-write a workspaces.json fixture.
const WORKSPACE = 'default';

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

function seed(stack: Stack, id: string, label: string): Promise<{ ok: boolean }> {
    return nodeUpsert(
        {
            id, workspace: WORKSPACE, ecosystem: '*', initiator: `test:${label}`,
            nodeData: {
                id, type: 'note', label, content: `content-${label}`,
                tags: ['t'], security_scopes: [] as string[],
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
 * Wraps a real SurrealGraph so its `listNodes()` — the bulk pre-loop snapshot
 * read `prune_nodes` takes — awaits `onSnapshotTaken` to full completion
 * exactly once, AFTER the real read resolves but BEFORE the (unchanged)
 * result reaches the caller. That deterministically places a concurrent write
 * in the window between "snapshot taken" and "loop reaches this id", which is
 * the race window the finding describes — no sleep/timing hacks.
 */
function raceOnListNodes(real: SurrealGraph, onSnapshotTaken: () => Promise<unknown>) {
    let fired = false;
    return {
        initialize: () => real.initialize(),
        getNode: (id: string) => real.getNode(id),
        upsertNode: (n: unknown) => real.upsertNode(n as never),
        deleteNode: (id: string) => real.deleteNode(id),
        listNodes: async (...args: unknown[]) => {
            const result = await (real.listNodes as (...a: unknown[]) => Promise<unknown>)(...args);
            if (!fired) { fired = true; await onSnapshotTaken(); }
            return result;
        },
    };
}

function fakeAuxStore() {
    const jobs = new Map<string, unknown>();
    let n = 0;
    return {
        createPruneJob: (workspace: string, opts: unknown) => {
            const id = `job-${++n}`;
            jobs.set(id, { id, workspace, status: 'running', options: opts });
            return id;
        },
        updatePruneJob: (id: string, patch: unknown) => {
            jobs.set(id, { ...(jobs.get(id) as object), ...(patch as object) });
        },
        getPruneJob: (id: string) => jobs.get(id) ?? null,
        incrementCounter: () => undefined,
    };
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

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

console.log('\nprune_nodes stale-snapshot race — regression (A2 finding 1)\n');

/* ─── MCP surface: mcp/tools/lifecycle.ts ──────────────────────────── */

test('MCP prune_nodes (archive): concurrent store_node between snapshot and lock is NOT reverted', async () => {
    const stack = await openStack('lore-prune-mcp-archive');
    try {
        const id = 'race-node';
        const seeded = await seed(stack, id, 'A');
        assert.equal(seeded.ok, true);

        const raceGraph = raceOnListNodes(stack.graph, async () => {
            const up = await seed(stack, id, 'B-NEW');
            assert.equal(up.ok, true, 'concurrent upsert must succeed');
        });

        const srv = new FakeMcpServer();
        const deps: LifecycleDeps = {
            store: { loreGraph: raceGraph, loreVerbatim: stack.store, storageClient: { verbatimDelete: async () => undefined } } as unknown as StorageBundle,
            auxStore: fakeAuxStore() as unknown as LifecycleDeps['auxStore'],
            detectedScope: { workspace: WORKSPACE },
        };
        registerLifecycleTools(srv as never, deps);
        const prune = srv.tools.find((t) => t.name === 'prune_nodes')!;

        const result = parseResult(await prune.handler({ workspace: WORKSPACE, dry_run: false, hard_delete: false }));
        assert.equal(result['archived'], 1, `expected 1 archived, got ${JSON.stringify(result)}`);

        const finalNode = await stack.graph.getNode(id);
        assert.equal(finalNode?.status, 'archived', 'node must be archived');
        assert.equal(finalNode?.content, 'content-B-NEW', 'BUG: archive reverted the concurrent write to its stale pre-loop content');
    } finally {
        await stack.close();
    }
});

test('MCP prune_nodes (archive): node deleted between snapshot and lock is skipped, not resurrected', async () => {
    const stack = await openStack('lore-prune-mcp-gone');
    try {
        const id = 'vanish-node';
        const seeded = await seed(stack, id, 'A');
        assert.equal(seeded.ok, true);

        const raceGraph = raceOnListNodes(stack.graph, async () => {
            const ok = await stack.graph.deleteNode(id);
            assert.equal(ok, true, 'concurrent delete must succeed');
        });

        const srv = new FakeMcpServer();
        const deps: LifecycleDeps = {
            store: { loreGraph: raceGraph, loreVerbatim: stack.store, storageClient: { verbatimDelete: async () => undefined } } as unknown as StorageBundle,
            auxStore: fakeAuxStore() as unknown as LifecycleDeps['auxStore'],
            detectedScope: { workspace: WORKSPACE },
        };
        registerLifecycleTools(srv as never, deps);
        const prune = srv.tools.find((t) => t.name === 'prune_nodes')!;

        const result = parseResult(await prune.handler({ workspace: WORKSPACE, dry_run: false, hard_delete: false }));
        assert.equal(result['archived'], 0, `must not report an archive for a since-deleted node, got ${JSON.stringify(result)}`);
        assert.equal(result['skipped'], 1, `must count the vanished node as skipped, got ${JSON.stringify(result)}`);

        const finalNode = await stack.graph.getNode(id);
        assert.equal(finalNode, null, 'BUG: prune resurrected a node deleted between the snapshot and the lock');
    } finally {
        await stack.close();
    }
});

/* ─── REST surface: mcp/http/routes/lifecycle.ts ───────────────────── */

test('HTTP POST /api/nodes/prune (archive): concurrent store_node between snapshot and lock is NOT reverted', async () => {
    const stack = await openStack('lore-prune-http-archive');
    try {
        const id = 'race-node-http';
        const seeded = await seed(stack, id, 'A');
        assert.equal(seeded.ok, true);

        const raceGraph = raceOnListNodes(stack.graph, async () => {
            const up = await seed(stack, id, 'B-NEW');
            assert.equal(up.ok, true, 'concurrent upsert must succeed');
        });

        const deps: LifecycleRouteDeps = {
            store: { loreGraph: raceGraph, loreVerbatim: stack.store, storageClient: { verbatimDelete: async () => undefined } } as unknown as StorageBundle,
            auxStore: fakeAuxStore() as unknown as LifecycleRouteDeps['auxStore'],
            deploymentMode: 'local',
            dataplane: null,
        };

        const res = fakeRes();
        const body = JSON.stringify({ workspace: WORKSPACE, dry_run: false, hard_delete: false });
        const handled = await tryLifecycleRoutes(fakeReq(body), res, '/api/nodes/prune', '/api/nodes/prune', deps);
        assert.equal(handled, true);
        const result = JSON.parse(res._body) as Record<string, unknown>;
        assert.equal(result['archived'], 1, `expected 1 archived, got ${res._body}`);

        const finalNode = await stack.graph.getNode(id);
        assert.equal(finalNode?.status, 'archived', 'node must be archived');
        assert.equal(finalNode?.content, 'content-B-NEW', 'BUG: archive reverted the concurrent write to its stale pre-loop content');
    } finally {
        await stack.close();
    }
});

/* ─── hard_delete branch through the SAME race (QA A2 round-2) ─────────
 *
 * The fresh-read + eligibility-recheck fix above applies to BOTH the
 * archive AND hard_delete branches (they share the same `withNodeLock`
 * callback — see mcp/tools/lifecycle.ts). These two tests drive the
 * hard_delete branch through the identical race window the archive tests
 * above exercise, using their OWN isolated LORE_HOME/workspaces.json (with
 * allowHardDelete:true) so they don't disturb the shared 'default'
 * workspace the tests above rely on.
 *
 * BARRIER: `loadWorkspaces()` reads `process.env.LORE_HOME` fresh on every
 * call (config/loreHome.ts), and the tests above rely on the process-wide
 * per-pid default home while these two temporarily point LORE_HOME
 * elsewhere. Awaiting the earlier batch to completion BEFORE these run
 * (rather than firing everything concurrently via one `pending` array)
 * keeps that env mutation from being visible to a still-in-flight test
 * above — a real hazard given this file's normal concurrent-test pattern.
 */
await Promise.all(pending);
if (failed > 0) {
    console.log(`\n${passed} passed, ${failed} failed (stopping before hard_delete race tests)\n`);
    process.exit(1);
}

async function withHardDeleteWorkspace<T>(fn: (ws: string) => Promise<T>): Promise<T> {
    const priorLoreHome = process.env['LORE_HOME'];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-prune-hd-race-home-'));
    process.env['LORE_HOME'] = home;
    const ws = 'ws-hd-race';
    try {
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(
            path.join(home, 'workspaces.json'),
            JSON.stringify({ active: ws, workspaces: [{ name: ws, path: path.join(home, ws), allowHardDelete: true }] }),
            'utf8',
        );
        return await fn(ws);
    } finally {
        if (priorLoreHome === undefined) delete process.env['LORE_HOME'];
        else process.env['LORE_HOME'] = priorLoreHome;
        fs.rmSync(home, { recursive: true, force: true });
    }
}

test('MCP prune_nodes (hard_delete): node deleted between snapshot and lock is skipped, not double-deleted', async () => {
    await withHardDeleteWorkspace(async (ws) => {
        const stack = await openStack('lore-prune-mcp-hd-gone');
        try {
            const id = 'hd-vanish-node';
            const seeded = await nodeUpsert(
                { id, workspace: ws, ecosystem: '*', initiator: 'test:A',
                  nodeData: { id, type: 'note', label: 'A', content: 'content-A', tags: ['t'], security_scopes: [] as string[] },
                  targetGraph: stack.graph },
                { outboxStore: stack.outboxStore, inlineVerbatim: { verbatimStore: (w) => stack.store.store(w) } },
            );
            assert.equal(seeded.ok, true);

            const raceGraph = raceOnListNodes(stack.graph, async () => {
                const ok = await stack.graph.deleteNode(id);
                assert.equal(ok, true, 'concurrent delete must succeed');
            });

            const srv = new FakeMcpServer();
            const deps: LifecycleDeps = {
                store: { loreGraph: raceGraph, loreVerbatim: stack.store, storageClient: { verbatimDelete: async () => undefined } } as unknown as StorageBundle,
                auxStore: fakeAuxStore() as unknown as LifecycleDeps['auxStore'],
                detectedScope: { workspace: ws },
            };
            registerLifecycleTools(srv as never, deps);
            const prune = srv.tools.find((t) => t.name === 'prune_nodes')!;

            const result = parseResult(await prune.handler({ workspace: ws, dry_run: false, hard_delete: true }));
            assert.equal(result['hard_deleted'], 0, `must not report a hard-delete for a since-deleted node, got ${JSON.stringify(result)}`);
            assert.equal(result['skipped'], 1, `must count the vanished node as skipped, got ${JSON.stringify(result)}`);

            const finalNode = await stack.graph.getNode(id);
            assert.equal(finalNode, null, 'BUG: hard_delete resurrected a node deleted between the snapshot and the lock');
        } finally {
            await stack.close();
        }
    });
});

test('MCP prune_nodes (hard_delete): tags changed between snapshot and lock so the node no longer matches the tag filter is skipped, not hard-deleted', async () => {
    await withHardDeleteWorkspace(async (ws) => {
        const stack = await openStack('lore-prune-mcp-hd-retag');
        try {
            const id = 'hd-retag-node';
            const seeded = await nodeUpsert(
                { id, workspace: ws, ecosystem: '*', initiator: 'test:A',
                  nodeData: { id, type: 'note', label: 'A', content: 'content-A', tags: ['t'], security_scopes: [] as string[] },
                  targetGraph: stack.graph },
                { outboxStore: stack.outboxStore, inlineVerbatim: { verbatimStore: (w) => stack.store.store(w) } },
            );
            assert.equal(seeded.ok, true);

            // Concurrent write drops the tag the prune call filters on — the
            // fresh-read eligibility recheck inside the lock must see THIS,
            // not the stale pre-loop snapshot that still had tag 't'.
            const raceGraph = raceOnListNodes(stack.graph, async () => {
                const up = await nodeUpsert(
                    { id, workspace: ws, ecosystem: '*', initiator: 'test:retag',
                      nodeData: { id, type: 'note', label: 'A', content: 'content-A', tags: ['other'], security_scopes: [] as string[] },
                      targetGraph: stack.graph },
                    { outboxStore: stack.outboxStore, inlineVerbatim: { verbatimStore: (w) => stack.store.store(w) } },
                );
                assert.equal(up.ok, true, 'concurrent retag must succeed');
            });

            const srv = new FakeMcpServer();
            const deps: LifecycleDeps = {
                store: { loreGraph: raceGraph, loreVerbatim: stack.store, storageClient: { verbatimDelete: async () => undefined } } as unknown as StorageBundle,
                auxStore: fakeAuxStore() as unknown as LifecycleDeps['auxStore'],
                detectedScope: { workspace: ws },
            };
            registerLifecycleTools(srv as never, deps);
            const prune = srv.tools.find((t) => t.name === 'prune_nodes')!;

            const result = parseResult(await prune.handler({ workspace: ws, dry_run: false, hard_delete: true, tags: 't' }));
            assert.equal(result['hard_deleted'], 0, `must not hard-delete a node that lost the filtered tag, got ${JSON.stringify(result)}`);
            assert.equal(result['skipped'], 1, `must count the re-tagged node as skipped, got ${JSON.stringify(result)}`);

            const finalNode = await stack.graph.getNode(id);
            assert.ok(finalNode, 'BUG: hard_delete removed a node that no longer matched the tag filter at delete time');
            assert.deepEqual(finalNode?.tags, ['other'], 'node must keep the concurrent write\'s tags — not the stale snapshot\'s');
        } finally {
            await stack.close();
        }
    });
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
