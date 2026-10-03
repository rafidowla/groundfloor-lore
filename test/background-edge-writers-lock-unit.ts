#!/usr/bin/env tsx
/**
 * test/background-edge-writers-lock-unit.ts — 3.26.0.
 *
 * The failed-write undo of a single edge (mcp/edgeWriteRollback.ts) reads the
 * edge, writes, and on failure puts the graph back as the read found it. That
 * is only sound when every writer of the same triple holds the per-edge lock
 * (core/nodeWriteLock.ts `withEdgeLock`) for its write. Three in-daemon
 * writers did not:
 *
 *   - sync pull            engines/syncEngine.ts `pullRemote()`
 *   - reconnect            engines/reconnect.ts `reconnectGraph` and
 *                          `reconnectOneNode` (inferred `semantic_neighbor`)
 *   - ArcadeDB replay lane engines/arcade/arcadeOutboxWiring.ts `addEdge` and
 *                          `deleteEdge`
 *
 * An edge one of them wrote between a failed call's pre-read and its undo was
 * removed by that undo.
 *
 * Method: hold the triple's edge lock, start the REAL writer, and check its
 * graph write has not happened; release, and check it then happens. Each case
 * fails against the pre-fix source (the write lands while the lock is held).
 * The "no lock workspace" cases pin the unlocked fallback a CLI run relies on.
 *
 * Run: npx tsx test/background-edge-writers-lock-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// LORE_HOME must be pinned BEFORE any provisioner import resolves
// loreHomePath() (mirrors test/arcade-delete-outbox-dispatch-unit.ts).
const RUN_TAG = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const LORE_HOME = path.join(os.tmpdir(), `bg-edge-lock-lorehome-${RUN_TAG}`);
fs.mkdirSync(LORE_HOME, { recursive: true });
process.env['LORE_HOME'] = LORE_HOME;

import { withEdgeLock } from '../packages/lore/src/core/nodeWriteLock.js';
import { SyncEngine, type SyncAdapter, type SyncResult } from '../packages/lore/src/engines/syncEngine.js';
import { reconnectGraph, reconnectOneNode, type ReconnectableGraph } from '../packages/lore/src/engines/reconnect.js';
import type { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { ArcadeHttp, type ArcadeCommandResult } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { wireArcadeReplicator } from '../packages/lore/src/engines/arcade/arcadeOutboxWiring.js';
import { arcadeCellKey } from '../packages/lore/src/engines/arcade/arcadeOutboxLane.js';
import { openRegistryDb, upsertTenantAppRow } from '../packages/lore/src/engines/arcade/arcadeRegistryStore.js';
import { secretRefFor } from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type { EmbeddingProvider, LoreEdge } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
// Sequential on purpose: the ArcadeDB cases patch ArcadeHttp.prototype.
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

const tmpDir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// A writer that must wait is watched for HOLD_MS; one that must NOT wait gets
// up to LAND_MS to land (the poll returns as soon as it does), so a loaded
// machine cannot turn "not blocked" into a false failure.
const HOLD_MS = 250;
const LAND_MS = 5000;

console.log('\nbackground edge writers hold the per-edge lock (3.26.0)\n');

/**
 * Hold the edge lock for (ws, s, t, r); start `run`; report whether the write
 * `wrote()` observes happened while the lock was held (watched for up to
 * `watchMs`) and whether it happened once the lock was released.
 */
async function raceAgainstHeldLock(
    key: { ws: string; s: string; t: string; r: string },
    run: () => Promise<unknown>,
    wrote: () => boolean,
    watchMs: number = HOLD_MS,
): Promise<{ whileHeld: boolean; afterRelease: boolean }> {
    let whileHeld = false;
    let running: Promise<unknown> = Promise.resolve();
    await withEdgeLock(key.ws, key.s, key.t, key.r, async () => {
        running = run();
        const until = Date.now() + watchMs;
        while (!wrote() && Date.now() < until) await delay(10);
        whileHeld = wrote();
    });
    await running;
    return { whileHeld, afterRelease: wrote() };
}

/** For a writer that must NOT be held by the lock the test takes. */
const raceUnheld: typeof raceAgainstHeldLock = (key, run, wrote) => raceAgainstHeldLock(key, run, wrote, LAND_MS);

/* ---------- sync pull ---------- */

function pullAdapter(edges: LoreEdge[]): SyncAdapter {
    let served = false;
    return {
        async push(): Promise<SyncResult> { return { nodesPushed: 0, edgesPushed: 0, failures: 0, errors: [] }; },
        async pull() {
            if (served) return { nodes: [], edges: [] };
            served = true;
            return { nodes: [], edges };
        },
        async isConnected() { return true; },
        async connect() { /* no-op */ },
        async disconnect() { /* no-op */ },
    };
}

function edgeSpyGraph() {
    const added: string[] = [];
    const graph = {
        added,
        async addEdge(e: { sourceId: string; targetId: string; relation: string }): Promise<void> {
            added.push(`${e.sourceId}>${e.targetId}:${e.relation}`);
        },
    };
    return graph;
}

const PULLED: LoreEdge = { sourceId: 'a', targetId: 'b', relation: 'depends_on' } as LoreEdge;

await test('sync pull: a pulled edge waits for that triple\'s edge lock', async () => {
    const graph = edgeSpyGraph();
    const engine = new SyncEngine(graph as never, tmpDir('bg-lock-sync-'), pullAdapter([PULLED]), null, null, null, 'ws1');
    const r = await raceAgainstHeldLock(
        { ws: 'ws1', s: 'a', t: 'b', r: 'depends_on' },
        () => engine.pullRemote(),
        () => graph.added.length > 0,
    );
    assert.equal(r.whileHeld, false, 'the pulled edge was written while the edge lock was held');
    assert.deepEqual(graph.added, ['a>b:depends_on']);
});

await test('sync pull: the lock workspace may be a getter, read per edge', async () => {
    const graph = edgeSpyGraph();
    let asked = 0;
    const engine = new SyncEngine(graph as never, tmpDir('bg-lock-sync-'), pullAdapter([PULLED]), null, null, null,
        () => { asked++; return 'ws-active'; });
    const r = await raceAgainstHeldLock(
        { ws: 'ws-active', s: 'a', t: 'b', r: 'depends_on' },
        () => engine.pullRemote(),
        () => graph.added.length > 0,
    );
    assert.equal(r.whileHeld, false, 'the pulled edge was written while the edge lock was held');
    assert.equal(r.afterRelease, true);
    assert.ok(asked >= 1, 'the workspace getter was never consulted');
});

await test('sync pull: a lock on another workspace or another triple does not hold the write', async () => {
    for (const key of [
        { ws: 'other', s: 'a', t: 'b', r: 'depends_on' },
        { ws: 'ws1', s: 'a', t: 'c', r: 'depends_on' },
    ]) {
        const graph = edgeSpyGraph();
        const engine = new SyncEngine(graph as never, tmpDir('bg-lock-sync-'), pullAdapter([PULLED]), null, null, null, 'ws1');
        const r = await raceUnheld(key, () => engine.pullRemote(), () => graph.added.length > 0);
        assert.equal(r.whileHeld, true, `an unrelated lock (${key.ws}/${key.t}) delayed the pulled edge`);
    }
});

await test('sync pull: with no lock workspace (CLI) the edge is written without the lock', async () => {
    const graph = edgeSpyGraph();
    const engine = new SyncEngine(graph as never, tmpDir('bg-lock-sync-'), pullAdapter([PULLED]));
    const r = await raceUnheld(
        { ws: '', s: 'a', t: 'b', r: 'depends_on' },
        () => engine.pullRemote(),
        () => graph.added.length > 0,
    );
    assert.equal(r.whileHeld, true, 'an engine built without a lock workspace must not take the edge lock');
});

await test('sync pull: an edge that fails under the lock is still dead-lettered, and the lock is released', async () => {
    const graph = { async addEdge(): Promise<void> { throw new Error('boom'); } };
    const engine = new SyncEngine(graph as never, tmpDir('bg-lock-sync-'), pullAdapter([PULLED]), null, null, null, 'ws1');
    const res = await engine.pullRemote();
    assert.equal(res.edgesDeadLettered, 1);
    let reacquired = false;
    await withEdgeLock('ws1', 'a', 'b', 'depends_on', async () => { reacquired = true; });
    assert.equal(reacquired, true);
});

/* ---------- reconnect ---------- */

type ReconnectNode = Parameters<typeof reconnectOneNode>[2];
const NODE_A: ReconnectNode = { id: 'a', type: 'lore', label: 'node a', content: 'content of a', tags: ['x'], project: 'ws1', ecosystem: '' };
const NODE_B: ReconnectNode = { id: 'b', type: 'lore', label: 'node b', content: 'content of b', tags: ['x'], project: 'ws1', ecosystem: '' };

/** Verbatim fake: every search returns both nodes as close neighbours. */
function neighbourVerbatim(): VerbatimStore {
    const store = {
        async initialize() { /* no-op */ },
        async getContentHashesByIds() { return new Map<string, string>(); },
        async storeBatch() { /* no-op */ },
        async store() { /* no-op */ },
        async search() { return [{ id: 'lore:a', score: 0.9 }, { id: 'lore:b', score: 0.9 }]; },
    };
    return store as unknown as VerbatimStore;
}

function reconnectSpyGraph() {
    const added: string[] = [];
    const nodes = [
        { ...NODE_A, updatedAt: '2026-10-02T00:00:00.000Z', security_scopes: [] },
        { ...NODE_B, updatedAt: '2026-10-02T00:00:01.000Z', security_scopes: [] },
    ];
    const graph = {
        async bulkList() { return { nodes: nodes as unknown as Array<Record<string, unknown>>, hasMore: false, nextCursor: null }; },
        async listNodes() { return nodes as unknown[]; },
        async getNode(id: string) { return nodes.find((n) => n.id === id) ?? null; },
        async addEdge(e: { sourceId: string; targetId: string; relation: string }) {
            added.push(`${e.sourceId}>${e.targetId}:${e.relation}`);
        },
        async pruneInferredLoreEdges() { return 0; },
    };
    return { added, graph: graph as unknown as ReconnectableGraph };
}

const NEIGHBOUR = { s: 'a', t: 'b', r: 'semantic_neighbor' };

await test('reconnectOneNode: an inferred edge waits for that triple\'s edge lock', async () => {
    const { added, graph } = reconnectSpyGraph();
    const r = await raceAgainstHeldLock(
        { ws: 'ws1', ...NEIGHBOUR },
        () => reconnectOneNode(graph, neighbourVerbatim(), NODE_A, { skipStore: true, lockWorkspace: 'ws1' }),
        () => added.length > 0,
    );
    assert.equal(r.whileHeld, false, 'the inferred edge was written while the edge lock was held');
    assert.deepEqual(added, ['a>b:semantic_neighbor']);
});

await test('reconnectOneNode: with no lock workspace the edge is written without the lock', async () => {
    const { added, graph } = reconnectSpyGraph();
    const r = await raceUnheld(
        { ws: '', ...NEIGHBOUR },
        () => reconnectOneNode(graph, neighbourVerbatim(), NODE_A, { skipStore: true }),
        () => added.length > 0,
    );
    assert.equal(r.whileHeld, true, 'a call without a lock workspace must not take the edge lock');
});

await test('reconnectGraph: an inferred edge waits for that triple\'s edge lock', async () => {
    const { added, graph } = reconnectSpyGraph();
    const r = await raceAgainstHeldLock(
        { ws: 'ws1', ...NEIGHBOUR },
        () => reconnectGraph(graph, neighbourVerbatim(), { dryRun: false, lockWorkspace: 'ws1' }),
        () => added.length > 0,
    );
    assert.equal(r.whileHeld, false, 'the inferred edge was written while the edge lock was held');
    assert.ok(added.includes('a>b:semantic_neighbor'), `expected the a>b neighbour edge; got ${JSON.stringify(added)}`);
});

await test('reconnectGraph: with no lock workspace (CLI) the edge is written without the lock', async () => {
    const { added, graph } = reconnectSpyGraph();
    const r = await raceUnheld(
        { ws: '', ...NEIGHBOUR },
        () => reconnectGraph(graph, neighbourVerbatim(), { dryRun: false }),
        () => added.length > 0,
    );
    assert.equal(r.whileHeld, true, 'a sweep without a lock workspace must not take the edge lock');
});

/* ---------- production wire-up: the save path's auto-link ---------- */

/** Deterministic embedder: identical text embeds identically (similarity 1). */
class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 16;
    readonly modelId = 'bg-edge-lock-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(text: string): Promise<number[]> { return this.vec(text); }
    async embedQuery(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocument(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocumentBatch(texts: string[]): Promise<number[][]> { return texts.map((t) => this.vec(t)); }
}

await test('createLore().nodeUpsert: the auto-link edge of a real save waits for the edge lock of its workspace', async () => {
    const { createLore } = await import('../packages/lore/src/index.js');
    const lore = await createLore({ dataDir: tmpDir('bg-lock-lore-'), deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider() });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = (lore as any).store;
    const settle = async () => {
        await delay(300);
        await internals?.autolinkTracker?.drain?.(5000);
        await lore.awaitEmbeds?.();
    };
    const neighbourEdges = async (): Promise<number> => (await internals.loreGraph.queryEdges({
        source: 'bgl-a', target: 'bgl-b', relation: 'semantic_neighbor', limit: 10, offset: 0,
    })).length;
    const save = (id: string) => lore.nodeUpsert({
        id, workspace: 'default', ecosystem: '*',
        nodeData: { id, type: 'note', label: 'same label', content: 'the very same content in both nodes', project: 'default', ecosystem: '*' },
    } as never);
    try {
        assert.equal((await save('bgl-a')).ok, true);
        await settle();
        let whileHeld = -1;
        await withEdgeLock('default', 'bgl-a', 'bgl-b', 'semantic_neighbor', async () => {
            assert.equal((await save('bgl-b')).ok, true);
            await delay(600);
            whileHeld = await neighbourEdges();
        });
        await settle();
        assert.equal(whileHeld, 0, 'the auto-link edge was written while its edge lock was held');
        assert.equal(await neighbourEdges(), 1, 'the auto-link edge was never written after the lock was released');
    } finally {
        await lore.dispose('done');
    }
});

/* ---------- production wire-up: which name the callers lock on ---------- */

await test('wire-up: the boot sync engine of a real instance locks on the name its graph is opened under', async () => {
    const { createLore } = await import('../packages/lore/src/index.js');
    const lore = await createLore({ dataDir: tmpDir('bg-lock-wire-'), deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider() });
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const key = ((lore as any)._daemon.getSyncEngine() as { lockWorkspace: unknown }).lockWorkspace;
        // A fixed string: the engine's graph does not follow a later
        // active-workspace change, so a live getter would diverge from it.
        assert.equal(key, 'default');
    } finally {
        await lore.dispose('done');
    }
});

await test('wire-up: no in-daemon caller locks on the detected scope (it can be "*") or on the live active name', async () => {
    const src = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'packages/lore/src', rel), 'utf8');
    const server = src('mcp/server.ts');
    assert.equal(/lockWorkspace:\s*detectedScope\.workspace/.test(server), false, 'server.ts locks on detectedScope.workspace');
    assert.match(server, /sweepTracker, lockWorkspace: getActiveWorkspaceName\(dataHome\)/, 'boot-time background reconnect lock name');
    assert.match(server, /outboxWiring\.store, null, bootWorkspaceName\);/, 'boot sync engine lock name');
    assert.match(server, /lockWorkspace: bootWorkspaceName, getSyncWorkspace:/, 'keychain-upgrade sync engine lock name');
    assert.match(src('mcp/services.ts'), /deps\.lockWorkspace, \/\/ pulled edges hold/, 'services.ts must pass the fixed lock name');
});

/* ---------- ArcadeDB replay lane ---------- */

class NoopEmbedder implements EmbeddingProvider {
    get modelId() { return 'bg-edge-lock-noop'; }
    get dimension() { return 4; }
    async initialize() { /* no-op */ }
    private vec() { return [0, 0, 0, 0]; }
    async embed() { return this.vec(); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}

/** Fake transport: counts every statement that reaches ArcadeDB and keeps the
 *  commands. Node lookups find a node, so addEdge's endpoint preflight passes;
 *  every other read is empty. */
let httpCalls = 0;
let commands: string[] = [];
const originalQuery = ArcadeHttp.prototype.query;
const originalCommand = ArcadeHttp.prototype.command;
function installFakeArcadeHttp(): void {
    httpCalls = 0;
    commands = [];
    ArcadeHttp.prototype.query = async function (
        _db: string, sql: string, params: Record<string, unknown> = {},
    ): Promise<ArcadeCommandResult> {
        httpCalls++;
        if (/FROM\s+LoreNode\b/i.test(sql) && typeof params['id'] === 'string') {
            return { result: [{
                id: params['id'], type: 'note', label: 'n', content: 'c', tags: '[]', project: '', ecosystem: '*',
                metadata: '{}', createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
            }] };
        }
        return { result: [] };
    };
    ArcadeHttp.prototype.command = async function (_db: string, sql: string): Promise<ArcadeCommandResult> {
        httpCalls++;
        commands.push(sql.trim());
        return { result: [] };
    };
}
function uninstallFakeArcadeHttp(): void {
    ArcadeHttp.prototype.query = originalQuery;
    ArcadeHttp.prototype.command = originalCommand;
}

function arcadeSubstrates(tenantId: string, appId: string): { substrates: DispatcherSubstrates; cellKey: string } {
    upsertTenantAppRow(openRegistryDb(), {
        tenantId, appId, dbName: `db_${tenantId}_${appId}`, dbUser: 'svc_user', dbPass: 'svc_pass',
        secretRef: secretRefFor(tenantId, appId), status: 'active', createdAt: new Date().toISOString(),
    });
    const wiring = wireArcadeReplicator({ store: new SqliteOutboxStore(tmpDir('bg-lock-arcade-')), embedder: new NoopEmbedder() });
    return {
        substrates: (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates,
        cellKey: arcadeCellKey(tenantId, appId),
    };
}

const ARCADE_EDGE = { sourceId: 'a', targetId: 'b', relation: 'depends_on' };

for (const kind of ['addEdge', 'deleteEdge'] as const) {
    await test(`ArcadeDB replay: ${kind} waits for that triple's edge lock, keyed on the cell's appId`, async () => {
        installFakeArcadeHttp();
        try {
            const { substrates, cellKey } = arcadeSubstrates('tlock1', 'applock1');
            // The request-path writers lock on the appId (arcadeData.ts
            // `cellWorkspace`), not on the `arcade:<t>:<a>` lane key.
            const r = await raceAgainstHeldLock(
                { ws: 'applock1', s: 'a', t: 'b', r: 'depends_on' },
                () => substrates[kind]!(ARCADE_EDGE as never, cellKey),
                () => httpCalls > 0,
            );
            assert.equal(r.whileHeld, false, `${kind} reached ArcadeDB while the edge lock was held`);
            assert.equal(r.afterRelease, true, `${kind} never reached ArcadeDB`);
            const wanted = kind === 'addEdge' ? /^CREATE EDGE/i : /^DELETE/i;
            assert.ok(commands.some((c) => wanted.test(c)), `${kind} issued no edge statement; got ${JSON.stringify(commands)}`);
        } finally {
            uninstallFakeArcadeHttp();
        }
    });

    await test(`ArcadeDB replay: ${kind} is not held by a lock on the lane key or on another triple`, async () => {
        for (const key of [
            { ws: arcadeCellKey('tlock2', 'applock2'), s: 'a', t: 'b', r: 'depends_on' },
            { ws: 'applock2', s: 'a', t: 'c', r: 'depends_on' },
        ]) {
            installFakeArcadeHttp();
            try {
                const { substrates, cellKey } = arcadeSubstrates('tlock2', 'applock2');
                const r = await raceUnheld(key, () => substrates[kind]!(ARCADE_EDGE as never, cellKey), () => httpCalls > 0);
                assert.equal(r.whileHeld, true, `an unrelated lock (${key.ws}/${key.t}) delayed ${kind}`);
            } finally {
                uninstallFakeArcadeHttp();
            }
        }
    });
}

await test('ArcadeDB replay: a row with no arcade-shaped workspace key is still refused before any lock or write', async () => {
    installFakeArcadeHttp();
    try {
        const { substrates } = arcadeSubstrates('tlock3', 'applock3');
        await assert.rejects(() => substrates.addEdge!(ARCADE_EDGE as never, 'ws-local'), /non-arcade-keyed/);
        await assert.rejects(() => substrates.deleteEdge!(ARCADE_EDGE as never, undefined), /no workspace key/);
        assert.equal(httpCalls, 0);
    } finally {
        uninstallFakeArcadeHttp();
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(LORE_HOME, { recursive: true, force: true }); } catch { /* scratch dir */ }
process.exit(failed > 0 ? 1 : 0);
