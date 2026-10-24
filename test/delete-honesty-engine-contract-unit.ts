#!/usr/bin/env tsx
/**
 * delete-honesty-engine-contract-unit.ts - Lore 3.34.0 slice 2 (M3a, Nokshi must-fix 3a).
 *
 * The engine-neutral "honest delete" contract (engines/graphShared/deleteOutcome.ts): a delete never
 * answers `deleted:true` while its text may still be searchable. One case list runs against every
 * engine that has a graph handle here:
 *   - SQLite     real SqliteGraph over a temp dir
 *   - ArcadeDB   the real ArcadeGraphStore over an in-memory fake of the HTTP transport
 *   - Dataplane  the real DataplaneGraph over the mock Dataplane (test/helpers/mock-dataplane.ts)
 * The text store is an injected fake (the contract is "node + text"), so each engine proves its own
 * `isTransientDeleteError` classification drives the shared bounded retry.
 *
 * Then, for the engines that expose the optional integrity capability, the explicit answers
 * (`not_supported` for SQLite and Dataplane, supported for ArcadeDB), the ArcadeDB classifier cases
 * (including the 503 body captured live on 26.7.1), and the two HTTP delete routes (single and bulk)
 * over ArcadeDB and SQLite: success shapes unchanged, `delete_incomplete` on a persistent text failure.
 *
 * Run: npx tsx test/delete-honesty-engine-contract-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const LORE_HOME = path.join(os.tmpdir(), `delete-honesty-lorehome-${Date.now().toString(36)}${process.pid.toString(36)}`);
fs.mkdirSync(LORE_HOME, { recursive: true });
process.env['LORE_HOME'] = LORE_HOME;

import { ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { ArcadeGraphStore } from '../packages/lore/src/engines/arcade/arcadeGraphStore.js';
import { isArcadeTransientDeleteError } from '../packages/lore/src/engines/arcade/arcadeDeleteClassifier.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import {
    deleteNodeAndText, withBoundedRetry, deleteIncompleteMessage, isDeleteIncompleteResult, isSqliteTransientDeleteError,
    DELETE_INCOMPLETE_CODE, type DeleteGraphLike, type DeleteTextStore,
} from '../packages/lore/src/engines/graphShared/deleteOutcome.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { tryNodeDeleteRoute } from '../packages/lore/src/mcp/http/routes/nodes-delete.js';
import { handleBulkDelete } from '../packages/lore/src/mcp/http/routes/bulkWriteEdgesDelete.js';
import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { PostgresVerbatimStore } from '../packages/lore/src/engines/postgres/postgresVerbatimStore.js';
import type { Pool as PgPool } from 'pg';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { createGatePool, cleanupGateWorkspaces, closeGatePool, stampGateManifest } from './helpers/testPostgres.js';
import { startCloudFixture, type CloudFixture } from './helpers/cloud-stores-fixture.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const tmpDirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
const noWait = { backoffMs: () => 0 };

// ── fake ArcadeDB transport (just what a node delete touches) ─────────────

type Row = Record<string, unknown>;
class FakeArcade {
    nodes = new Map<string, Row>();
    /** Per-command failure injection: return an Error to throw INSTEAD of applying. */
    onCommand: ((sql: string) => Error | undefined) | null = null;
    deleteCommands = 0;
    async command(_db: string, sql: string, params: Row = {}): Promise<{ result: unknown[] }> {
        if (/^DELETE VERTEX FROM LoreNode WHERE id = :id$/.test(sql)) {
            this.deleteCommands++;
            const err = this.onCommand?.(sql);
            if (err) throw err;
            this.nodes.delete(String(params['id']));
        }
        return { result: [] };
    }
    async commandScript(): Promise<{ result: unknown[] }> { return { result: [] }; }
    async query(_db: string, sql: string, params: Row = {}): Promise<{ result: Row[] }> {
        if (/FROM LoreNode WHERE id = :id LIMIT 1$/.test(sql)) { const r = this.nodes.get(String(params['id'])); return { result: r ? [{ ...r }] : [] }; }
        return { result: [] };
    }
}
const arcadeRow = (id: string): Row => ({ id, type: 'note', label: id, content: `content ${id}`, tags: '[]', project: 'p', ecosystem: '*', metadata: '{}', createdAt: '2026-10-13T10:00:00.000Z', updatedAt: '2026-10-13T10:00:00.000Z', revision: 1 });
const seedNode = (id: string) => ({ id, type: 'note', label: id, content: `content ${id}`, tags: [] as string[], project: 'p', ecosystem: '*', metadata: '{}' });

/** An injected text store that can fail a set number of times with a chosen error. */
class FakeText implements DeleteTextStore {
    calls = 0;
    tombstoned: string[] = [];
    failures = 0;
    failWith: Error = new Error('text store down');
    async tombstone(id: string, _reason: string): Promise<void> {
        this.calls++;
        if (this.failures > 0) { this.failures--; throw this.failWith; }
        this.tombstoned.push(id);
    }
    async delete(id: string): Promise<void> { return this.tombstone(id, 'delete'); }
}

/** Wrap a graph so deleteNode fails `fails` times (then delegates); the classifier stays the engine's own. */
function flaky(graph: DeleteGraphLike, fails: { n: number; err: Error }): DeleteGraphLike & { attempts: number } {
    const w = {
        attempts: 0,
        async deleteNode(id: string): Promise<boolean> {
            w.attempts++;
            if (fails.n > 0) { fails.n--; throw fails.err; }
            return graph.deleteNode(id);
        },
        isTransientDeleteError: typeof graph.isTransientDeleteError === 'function' ? (e: unknown) => graph.isTransientDeleteError!(e) : undefined,
    };
    return w as DeleteGraphLike & { attempts: number };
}

interface EngineRig {
    name: string;
    graph: DeleteGraphLike;
    seed(id: string): Promise<void>;
    exists(id: string): Promise<boolean>;
    transientError(): Error;
}

const arcadeTransient = () => new ArcadeHttpError(503, '{"error":"Cannot execute command","detail":"Concurrent modification on page PageId(db/1/0). Please retry the operation (threadId=90)","exception":"com.arcadedb.exception.ConcurrentModificationException"}');

function sqliteRig(): EngineRig {
    const g = new SqliteGraph(mkTmp('dh-sqlite-'), { workspaceId: 'dh-ws' });
    return {
        name: 'sqlite', graph: g,
        seed: async (id) => { await g.upsertNode(seedNode(id)); },
        exists: async (id) => (await g.getNode(id)) !== null,
        transientError: () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
    };
}
function arcadeRig(): EngineRig & { fake: FakeArcade } {
    const fake = new FakeArcade();
    const g = new ArcadeGraphStore({ tenantDb: 't', http: fake as never });
    return {
        name: 'arcade', fake, graph: g,
        seed: async (id) => { fake.nodes.set(id, arcadeRow(id)); },
        exists: async (id) => fake.nodes.has(id),
        transientError: arcadeTransient,
    };
}
function dataplaneRig(fx: CloudFixture): EngineRig {
    const ws = 'dh-dp-ws';
    const graph: DeleteGraphLike = { deleteNode: (id) => fx.as(ws, () => fx.graph.deleteNode(id)) };
    return {
        name: 'dataplane', graph,
        seed: async (id) => { await fx.as(ws, () => fx.graph.upsertNode(seedNode(id))); },
        exists: async (id) => (await fx.as(ws, () => fx.graph.getNode(id))) !== null,
        // DataplaneGraph supplies no classifier: the shared default (the historical `transaction conflict` retry) applies.
        transientError: () => new Error('transaction conflict, please retry'),
    };
}

const fx = await startCloudFixture();

// ── postgres (real a real Postgres container; skips cleanly without LORE_PG_URL) ──
// The same contract() cases plus a direct-SQL honesty check: deleted means the
// text is gone from BOTH the nodes table and verbatim/fts — verified in the
// rig with raw SQL against the exact visibility filter the engine's own
// bm25Search uses (`is_canonical = 1 AND is_tombstone = 0`), not just the API.
console.log('\nM3a. postgres (real a real Postgres container; skips cleanly without LORE_PG_URL)\n');
const PG_WS = 'pg-gate-delete';
const pgPool = await createGatePool('delete-honesty/postgres');
if (pgPool) {
    // A previous crashed run may have skipped its cleanup: start clean.
    await cleanupGateWorkspaces(pgPool);
}

/** 4-dimension fixed embedder for the gate verbatim store (dimension comes from the stamped manifest). */
class GateEmbedder implements EmbeddingProvider {
    readonly dimension = 4;
    readonly modelId = 'pg-gate-fixed';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embedQuery(): Promise<number[]> { return [1, 0, 0, 0]; }
    async embed(t: string): Promise<number[]> { return this.embedDocument(t); }
    async embedDocument(_t?: string): Promise<number[]> { return [0.5, 0.5, 0.5, 0.5]; }
}

const pgTransient = (): Error => Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' });

function pgRig(): EngineRig {
    const g = new PostgresGraph(PG_WS, pgPool as PgPool);
    return {
        name: 'postgres', graph: g,
        seed: async (id) => { await g.upsertNode(seedNode(id)); },
        exists: async (id) => {
            // DIRECT SQL on the nodes table — the rig verifies deletion in the
            // database, not through the same API that performed it.
            const r = await (pgPool as PgPool).query('SELECT 1 FROM nodes WHERE workspace_id = $1 AND id = $2', [PG_WS, id]);
            return (r.rowCount ?? 0) > 0;
        },
        transientError: pgTransient,
    };
}

function contract(make: () => EngineRig): void {
    const name = make().name;
    const tag = (s: string) => `[${name}] ${s}`;

    void test(tag('deleted: node and text removed'), async () => {
        const r = make(); await r.seed('c1');
        const text = new FakeText();
        const o = await deleteNodeAndText({ graph: r.graph, text, nodeId: 'c1', textId: 'lore:c1', reason: 'r', retry: noWait });
        assert.deepEqual(o, { status: 'deleted', tombstoned: true });
        assert.equal(await r.exists('c1'), false);
        assert.deepEqual(text.tombstoned, ['lore:c1']);
    });
    void test(tag('not_found: nothing else is touched (idempotent)'), async () => {
        const r = make(); const text = new FakeText();
        const o = await deleteNodeAndText({ graph: r.graph, text, nodeId: 'ghost-id', textId: 'lore:ghost-id', reason: 'r', retry: noWait });
        assert.deepEqual(o, { status: 'not_found' });
        assert.equal(text.calls, 0, 'a missing node must not touch the text store');
    });
    void test(tag('no text store: deleted, tombstoned:false; delete-only store uses delete'), async () => {
        const r = make(); await r.seed('c2'); await r.seed('c3');
        assert.deepEqual(await deleteNodeAndText({ graph: r.graph, nodeId: 'c2', textId: 'lore:c2', reason: 'r', retry: noWait }), { status: 'deleted', tombstoned: false });
        const deleted: string[] = [];
        const o = await deleteNodeAndText({ graph: r.graph, text: { delete: async (id) => { deleted.push(id); } }, nodeId: 'c3', textId: 'lore:c3', reason: 'r', retry: noWait });
        assert.deepEqual(o, { status: 'deleted', tombstoned: false });
        assert.deepEqual(deleted, ['lore:c3']);
    });
    void test(tag('transient node-delete failures are retried, then deleted'), async () => {
        const r = make(); await r.seed('c4');
        const g = flaky(r.graph, { n: 2, err: r.transientError() });
        const o = await deleteNodeAndText({ graph: g, text: new FakeText(), nodeId: 'c4', textId: 'lore:c4', reason: 'r', retry: noWait });
        assert.equal(o.status, 'deleted');
        assert.equal(g.attempts, 3);
        assert.equal(await r.exists('c4'), false);
    });
    void test(tag('transient text failures are retried, then deleted'), async () => {
        const r = make(); await r.seed('c5');
        const text = new FakeText(); text.failures = 2; text.failWith = r.transientError();
        const o = await deleteNodeAndText({ graph: r.graph, text, nodeId: 'c5', textId: 'lore:c5', reason: 'r', retry: noWait });
        assert.equal(o.status, 'deleted');
        assert.equal(text.calls, 3);
        assert.deepEqual(text.tombstoned, ['lore:c5']);
    });
    void test(tag('persistent transient text failure: delete_incomplete after the bounded retries (never deleted)'), async () => {
        const r = make(); await r.seed('c6');
        const text = new FakeText(); text.failures = 99; text.failWith = r.transientError();
        const o = await deleteNodeAndText({ graph: r.graph, text, nodeId: 'c6', textId: 'lore:c6', reason: 'r', retry: noWait });
        assert.equal(o.status, 'delete_incomplete');
        assert.equal(text.calls, 5, 'bounded: 5 attempts, not unbounded');
        assert.equal(await r.exists('c6'), false, 'the node IS gone; the answer says the text may remain');
        assert.equal(text.tombstoned.length, 0);
        if (o.status === 'delete_incomplete') {
            const msg = deleteIncompleteMessage('c6', o.textError);
            assert.match(msg, new RegExp(`^${DELETE_INCOMPLETE_CODE}: `));
            assert.equal(isDeleteIncompleteResult({ ok: false, error: msg }), true);
            assert.equal(isDeleteIncompleteResult({ ok: true }), false);
        }
    });
    void test(tag('non-transient text failure: delete_incomplete after exactly one attempt'), async () => {
        const r = make(); await r.seed('c7');
        const text = new FakeText(); text.failures = 99; text.failWith = new Error('disk full');
        const o = await deleteNodeAndText({ graph: r.graph, text, nodeId: 'c7', textId: 'lore:c7', reason: 'r', retry: noWait });
        assert.equal(o.status, 'delete_incomplete');
        assert.equal(text.calls, 1);
    });
    void test(tag('non-transient node-delete failure is thrown unretried; nothing was applied'), async () => {
        const r = make(); await r.seed('c8');
        const g = flaky(r.graph, { n: 99, err: new Error('permission denied') });
        const text = new FakeText();
        await assert.rejects(deleteNodeAndText({ graph: g, text, nodeId: 'c8', textId: 'lore:c8', reason: 'r', retry: noWait }), /permission denied/);
        assert.equal(g.attempts, 1);
        assert.equal(text.calls, 0);
        assert.equal(await r.exists('c8'), true);
    });
    void test(tag('persistent transient node-delete failure: thrown after 5 attempts, text untouched'), async () => {
        const r = make(); await r.seed('c9');
        const g = flaky(r.graph, { n: 99, err: r.transientError() });
        const text = new FakeText();
        await assert.rejects(deleteNodeAndText({ graph: g, text, nodeId: 'c9', textId: 'lore:c9', reason: 'r', retry: noWait }));
        assert.equal(g.attempts, 5);
        assert.equal(text.calls, 0);
        assert.equal(await r.exists('c9'), true);
    });
}

console.log('\nM3a. honest delete: one contract over SQLite, ArcadeDB (fake transport) and Dataplane (mock)\n');
contract(sqliteRig);
contract(arcadeRig);
contract(() => dataplaneRig(fx));
if (pgPool) contract(pgRig);
await new Promise((r) => setTimeout(r, 0));
// The contract cases above were scheduled with `void test(...)`; make sure they all finished before moving on.
await test('contract cases drained', async () => { await new Promise((r) => setTimeout(r, 1500)); });

if (pgPool) {
    await test('[postgres] deleted means the text is gone from BOTH the nodes table and verbatim/fts (direct SQL, not just the API)', async () => {
        const base = mkTmp('dh-pg-verb-');
        stampGateManifest(base, 'pg-gate-fixed', 4);
        const store = new PostgresVerbatimStore(base, pgPool, PG_WS, new GateEmbedder());
        await store.initialize();
        const g = new PostgresGraph(PG_WS, pgPool);
        await g.initialize();
        await g.upsertNode(seedNode('t1'));
        await store.store({ id: 'lore:t1', text: 'quantum marmalade syndrome honesty probe', metadata: { type: 'note' } });
        // What the engine's own bm25Search can see: `is_canonical = 1 AND is_tombstone = 0`.
        const visible = 'is_canonical = 1 AND is_tombstone = 0';
        const count = async (sql: string, params: string[]): Promise<number> =>
            Number((await pgPool.query(`SELECT count(*)::int AS c FROM ${sql}`, params)).rows[0]?.c ?? 0);
        assert.equal(await count(`nodes WHERE workspace_id = $1 AND id = $2`, [PG_WS, 't1']), 1, 'pre: node row present');
        assert.equal(await count(`verbatim WHERE workspace_id = $1 AND id = $2 AND ${visible}`, [PG_WS, 'lore:t1']), 1, 'pre: canonical verbatim row present');
        assert.equal(await count(`verbatim WHERE workspace_id = $1 AND text_tsv @@ phraseto_tsquery('simple', 'marmalade') AND ${visible}`, [PG_WS]), 1, 'pre: the text is fts-searchable');

        const o = await deleteNodeAndText({ graph: g, text: store, nodeId: 't1', textId: 'lore:t1', reason: 'r', retry: noWait });
        assert.deepEqual(o, { status: 'deleted', tombstoned: true });

        assert.equal(await count(`nodes WHERE workspace_id = $1 AND id = $2`, [PG_WS, 't1']), 0, 'node row GONE from the nodes table (direct SQL)');
        assert.equal(await count(`verbatim WHERE workspace_id = $1 AND id = $2 AND ${visible}`, [PG_WS, 'lore:t1']), 0, 'no canonical, non-tombstone verbatim row remains (direct SQL)');
        assert.equal(await count(`verbatim WHERE workspace_id = $1 AND text_tsv @@ phraseto_tsquery('simple', 'marmalade') AND ${visible}`, [PG_WS]), 0, 'the text is GONE from fts (direct SQL)');
    });
}

console.log('\nM3a. engine classifiers and the shared retry helper\n');

await test('arcade classifier: 503 and the live concurrent-modification body are transient; client errors, timeouts, others are not', () => {
    assert.equal(isArcadeTransientDeleteError(arcadeTransient()), true);
    assert.equal(isArcadeTransientDeleteError(new ArcadeHttpError(503, 'whatever')), true);
    assert.equal(isArcadeTransientDeleteError(new ArcadeHttpError(500, '{"exception":"com.arcadedb.exception.NeedRetryException"}')), true);
    assert.equal(isArcadeTransientDeleteError(new ArcadeHttpError(500, 'Concurrent modification on page. Please retry the operation')), true);
    assert.equal(isArcadeTransientDeleteError(new ArcadeHttpError(400, 'bad sql')), false);
    assert.equal(isArcadeTransientDeleteError(new ArcadeHttpError(404, 'no such database')), false);
    assert.equal(isArcadeTransientDeleteError(new Error('[ArcadeHttp] request timeout after 30000ms')), false, 'a timeout is an unknown outcome, not a retry');
    assert.equal(isArcadeTransientDeleteError(new Error('transaction conflict')), true, 'the historical wording still retries');
    assert.equal(isArcadeTransientDeleteError(null), false);
});
await test('sqlite classifier: SQLITE_BUSY / LOCKED and the historical conflict wording only', () => {
    assert.equal(isSqliteTransientDeleteError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' })), true);
    assert.equal(isSqliteTransientDeleteError(Object.assign(new Error('x'), { code: 'SQLITE_LOCKED_SHAREDCACHE' })), true);
    assert.equal(isSqliteTransientDeleteError(new Error('database is locked')), true);
    assert.equal(isSqliteTransientDeleteError(new Error('transaction conflict')), true);
    assert.equal(isSqliteTransientDeleteError(Object.assign(new Error('constraint'), { code: 'SQLITE_CONSTRAINT' })), false);
    assert.equal(isSqliteTransientDeleteError(undefined), false);
});
await test('withBoundedRetry: stops at maxAttempts, never retries a non-transient error, rethrows the last error', async () => {
    let n = 0;
    await assert.rejects(withBoundedRetry(async () => { n++; throw new Error('boom ' + n); }, { isTransient: () => true, maxAttempts: 3, backoffMs: () => 0 }), /boom 3/);
    assert.equal(n, 3);
    n = 0;
    await assert.rejects(withBoundedRetry(async () => { n++; throw new Error('perm'); }, { isTransient: () => false, backoffMs: () => 0 }), /perm/);
    assert.equal(n, 1);
    n = 0;
    assert.equal(await withBoundedRetry(async () => { n++; if (n < 3) throw new Error('t'); return 'ok'; }, { isTransient: () => true, backoffMs: () => 0 }), 'ok');
});
await test('the real arcade graph retries a 503 on the DELETE command itself (HTTP level)', async () => {
    const r = arcadeRig(); await r.seed('h1');
    let fails = 2;
    r.fake.onCommand = () => (fails-- > 0 ? arcadeTransient() : undefined);
    const o = await deleteNodeAndText({ graph: r.graph, text: new FakeText(), nodeId: 'h1', textId: 'lore:h1', reason: 'r', retry: noWait });
    assert.equal(o.status, 'deleted');
    assert.equal(r.fake.deleteCommands, 3);
    assert.equal(r.fake.nodes.has('h1'), false);
});

console.log('\n3.34.0 integrity capability: explicit answers per engine\n');

await test('SQLite and Dataplane answer not_supported (with a reason) for scan and remove; ArcadeDB declares the capability', async () => {
    const s = sqliteRig().graph as unknown as { integrityScan: () => Promise<Record<string, unknown>>; integrityRemove: (r: string[]) => Promise<Record<string, unknown>> };
    const d = fx.graph as unknown as typeof s;
    for (const g of [s, d]) {
        const scan = await g.integrityScan();
        assert.equal(scan['supported'], false);
        assert.equal(scan['status'], 'not_supported');
        assert.ok(typeof scan['reason'] === 'string' && (scan['reason'] as string).length > 20);
        const rm = await g.integrityRemove(['#1:1']);
        assert.equal(rm['supported'], false);
        assert.equal(rm['status'], 'not_supported');
    }
    const a = arcadeRig().graph as unknown as { integrityScan?: unknown; integrityRemove?: unknown };
    assert.equal(typeof a.integrityScan, 'function');
    assert.equal(typeof a.integrityRemove, 'function');
});

// ── the two HTTP delete routes ──────────────────────────────────────────

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = { _status: 0, _body: '', writeHead(s: number) { (this as { _status: number })._status = s; return this; }, end(b?: string) { (this as { _body: string })._body = b ?? ''; } };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
const delReq = (): IncomingMessage => ({ method: 'DELETE', on: () => undefined }) as unknown as IncomingMessage;
const WS = 'dh-routes';
const audit = { log: () => undefined } as never;

interface RouteRig { exists(id: string): Promise<boolean>; graph: DeleteGraphLike; seed(id: string): Promise<void>; text: FakeText; outbox: FileOutboxStore }
type RouteEngine = 'arcade' | 'sqlite' | 'postgres';
function routeRig(engine: RouteEngine): RouteRig {
    if (engine === 'postgres') {
        const r = pgRig();
        return { exists: r.exists, graph: r.graph, seed: r.seed, text: new FakeText(), outbox: new FileOutboxStore(mkTmp('dh-outbox-')) };
    }
    const r = engine === 'arcade' ? arcadeRig() : sqliteRig();
    return { exists: r.exists, graph: r.graph, seed: r.seed, text: new FakeText(), outbox: new FileOutboxStore(mkTmp('dh-outbox-')) };
}
const store = (rig: RouteRig) => ({ loreGraph: rig.graph, loreVerbatim: rig.text }) as never;

async function single(rig: RouteRig, id: string) {
    const res = fakeRes();
    await tryNodeDeleteRoute(delReq(), res, `/api/node/${id}?workspace=${WS}`, `/api/node/${id}`,
        { deploymentMode: 'local', dataplane: null, store: store(rig), auditLog: audit, outboxStore: rig.outbox });
    return { status: res._status, body: JSON.parse(res._body) as Record<string, unknown> };
}
async function bulk(rig: RouteRig, ids: string[]) {
    const res = fakeRes();
    await handleBulkDelete(res, { ids, workspace: WS }, { store: store(rig), auditLog: audit, deploymentMode: 'local', dataplane: null, outboxStore: rig.outbox } as never);
    return { status: res._status, body: JSON.parse(res._body) as { ok: boolean; deleted: number; notFound: number; deleteIncomplete?: number; results: Array<Record<string, unknown>> } };
}

const routeEngines: RouteEngine[] = pgPool ? ['arcade', 'sqlite', 'postgres'] : ['arcade', 'sqlite'];
for (const engine of routeEngines) {
    console.log(`\nM3a. HTTP delete routes over ${engine}\n`);

    await test(`[${engine}] single DELETE: success shape unchanged (200 {ok,id,tombstoned})`, async () => {
        const rig = routeRig(engine); await rig.seed('s1');
        const { status, body } = await single(rig, 's1');
        assert.equal(status, 200);
        assert.deepEqual(body, { ok: true, id: 's1', tombstoned: true });
        assert.equal(await rig.exists('s1'), false);
    });
    await test(`[${engine}] single DELETE: missing node is the existing 404 node_not_found`, async () => {
        const rig = routeRig(engine);
        const { status, body } = await single(rig, 'nope');
        assert.equal(status, 404);
        assert.equal(body['code'], 'node_not_found');
        assert.equal(rig.text.calls, 0);
    });
    await test(`[${engine}] single DELETE: persistent text failure is a 500 delete_incomplete with nodeDeleted:true, never ok; the tombstone outbox row is still queued`, async () => {
        const rig = routeRig(engine); await rig.seed('s2');
        rig.text.failures = 99; rig.text.failWith = new Error('text store down');
        const { status, body } = await single(rig, 's2');
        assert.equal(status, 500);
        assert.equal(body['code'], DELETE_INCOMPLETE_CODE);
        assert.equal(body['nodeDeleted'], true);
        assert.equal(body['ok'], undefined);
        assert.match(String(body['message']), /^delete_incomplete: /);
        assert.equal(await rig.exists('s2'), false);
        const kinds = (await rig.outbox.listPendingForWorkspace(WS, 100)).map((e) => e.operationKind);
        assert.ok(kinds.includes('node.delete') && kinds.includes('verbatim.tombstone'), `outbox converges the text: ${kinds.join(',')}`);
        // Retry: the node is gone, so the repeat is a plain 404 and does not touch the text store again.
        const callsBefore = rig.text.calls;
        assert.equal((await single(rig, 's2')).status, 404);
        assert.equal(rig.text.calls, callsBefore);
    });
    await test(`[${engine}] single DELETE: transient text failures are absorbed by the retry (200)`, async () => {
        const rig = routeRig(engine); await rig.seed('s3');
        // sqlite retries SQLITE_BUSY; postgres retries its own serialization-failure shape; the arcade classifier does not retry a plain SQLITE_BUSY text error
        rig.text.failures = 2;
        rig.text.failWith = engine === 'postgres' ? pgTransient() : Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        const wrapped = engine !== 'arcade';
        const { status } = await single(rig, 's3');
        if (wrapped) assert.equal(status, 200);
        else assert.equal(status, 500);
    });
    await test(`[${engine}] bulk delete: success shape unchanged; not-found stays ok:true deleted:false`, async () => {
        const rig = routeRig(engine); await rig.seed('b1'); await rig.seed('b2');
        const { status, body } = await bulk(rig, ['b1', 'b2', 'gone']);
        assert.equal(status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.deleted, 2);
        assert.equal(body.notFound, 1);
        assert.equal(body.deleteIncomplete, undefined, 'the new field is absent unless something was incomplete');
        assert.deepEqual(body.results, [{ id: 'b1', ok: true, deleted: true }, { id: 'b2', ok: true, deleted: true }, { id: 'gone', ok: true, deleted: false }]);
    });
    await test(`[${engine}] bulk delete: a persistent text failure is an item delete_incomplete (ok:false, deleted:false, nodeDeleted:true), counted out of deleted`, async () => {
        const rig = routeRig(engine); await rig.seed('b3'); await rig.seed('b4');
        let n = 0;
        const realTomb = rig.text.tombstone.bind(rig.text);
        rig.text.tombstone = async (id, reason) => { if (id === 'lore:b3') { n++; throw new Error('text store down'); } return realTomb(id, reason); };
        const { status, body } = await bulk(rig, ['b3', 'b4']);
        assert.equal(status, 200);
        assert.equal(body.ok, false, 'the response is not ok while any text may remain searchable');
        assert.equal(body.deleted, 1);
        assert.equal(body.deleteIncomplete, 1);
        const [i3, i4] = body.results;
        assert.equal(i3!['ok'], false);
        assert.equal(i3!['deleted'], false);
        assert.equal(i3!['nodeDeleted'], true);
        assert.match(String(i3!['error']), /^delete_incomplete: /);
        assert.deepEqual(i4, { id: 'b4', ok: true, deleted: true });
        assert.ok(n >= 1);
        assert.equal(await rig.exists('b3'), false);
        const kinds = (await rig.outbox.listPendingForWorkspace(WS, 100)).filter((e) => e.operationKind === 'verbatim.tombstone');
        assert.equal(kinds.length, 2, 'both ids queue the tombstone row, including the one whose inline delete failed');
    });
}

await fx.close();
if (pgPool) {
    await cleanupGateWorkspaces(pgPool);
    await closeGatePool(pgPool);
}
for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
fs.rmSync(LORE_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
