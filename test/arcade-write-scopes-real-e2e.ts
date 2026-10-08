#!/usr/bin/env tsx
/**
 * test/arcade-write-scopes-real-e2e.ts — Lore 3.30.0 write-path row scopes against a
 * REAL ArcadeDB (throwaway Docker container), not the fake-HTTP harness the unit
 * tests (scopes-export-arcade-unit.ts, write-scopes-*-unit.ts) use.
 *
 * NEEDS DOCKER. Deliberately NOT part of the default `npm test` chain.
 * Run: npm run test:e2e:arcade-write-scopes-real   (Node 22)
 *
 * Container: own name `lore-arcade-wscope-e2e`, image ARCADE_STABLE_TAG, host port
 * 127.0.0.1:${LORE_ARCADE_WSCOPE_PORT:-2490}. It never touches any other container and
 * is always removed in a finally block. LORE_HOME is a temp dir under the repo;
 * ~/.groundfloor and :3847 are never used. A deterministic 8-dim embedder replaces the
 * ONNX model (no model files are read).
 *
 * Cases
 *   1. verbatim row stored with ['a']; re-stored WITHOUT scopes -> still ['a']
 *   2. re-stored with explicit [] -> [] (public)
 *   3. re-stored with ['b'] -> ['b']
 *   4. getById returns security_scopes (array)
 *   4b. storePrebuilt (batch/migration path) has the same keep/explicit semantics
 *   5. POST /api/nodes/bulk (real route, real ArcadeGraphStore + ArcadeVectorStore):
 *        a. inline verbatim mirror of an existing scoped node keeps its scopes;
 *        b. question-alias outbox rows carry the node's scopes, and replaying one
 *           through the real store writes a row carrying them.
 *   6. bound actor (runWithActor) on the real route:
 *        a. bulk upsert of a hidden id -> id_unavailable, node + verbatim row untouched;
 *        b. bulk-delete of a hidden id answers exactly like a missing id, row survives;
 *        c. a free id still writes.
 *
 *   7. schema v3 -> v4 upgrade on a real cell (db wscope_v3_e2e): a v3 cell (no
 *      LoreNode.security_scopes property) holds legacy nodes; the v4 DDL + backfill gives each
 *      node its canonical verbatim row's labels (damaged / absent verbatim -> []), reports
 *      counts, is idempotent, and a bound actor then cannot bulk-delete the hidden node.
 *
 *   8. every other read door (3.29 contract) and write door (3.30 contract) over the same real
 *      stores: see test/arcade-wscope-doors.ts (imported below, same container + stores).
 *
 * HISTORY: against 3.30.0 cases 6b and 6b2 FAILED on purpose - Arcade node rows had no
 * security_scopes column (they read back []), and security/itemScopes.ts resolveItemScopes()
 * returns on the FIRST source that has the item (the live graph node), so the canonical
 * lore:<id> verbatim row that held the scopes was never consulted. Arcade schema v4 stores
 * the labels on the LoreNode vertex, so the nodes below are seeded WITH their scopes (as
 * the real write paths now do) and 6b / 6b2 pass.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

const PORT = process.env['LORE_ARCADE_WSCOPE_PORT'] ?? '2490';
const CONTAINER = 'lore-arcade-wscope-e2e';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT_PW = 'WscopeRoot123!';

// Everything below is pinned BEFORE any product import resolves loreHomePath()/ARCADE_BASE_URL.
const LORE_HOME = fs.mkdtempSync(path.join(process.cwd(), '.tmp-arcade-wscope-e2e-'));
process.env['LORE_HOME'] = LORE_HOME;
process.env['ARCADE_BASE_URL'] = BASE_URL;
process.env['ARCADE_ROOT_PASSWORD'] = ROOT_PW;
delete process.env['LORE_SEARCH_WORKER'];

const { ARCADE_STABLE_TAG } = await import('./spike-arcadedb-helpers.js');
const { ArcadeHttp } = await import('../packages/lore/src/engines/arcade/arcadeHttp.js');
const { ArcadeVectorStore } = await import('../packages/lore/src/engines/arcade/arcadeVectorStore.js');
const { ArcadeGraphStore } = await import('../packages/lore/src/engines/arcade/arcadeGraphStore.js');
const { LoreStorageClient } = await import('../packages/lore/src/storage/loreStorageClient.js');
const { tryBulkWriteRoutes } = await import('../packages/lore/src/mcp/http/routes/bulkWrite.js');
const { FileOutboxStore } = await import('../packages/lore/src/outbox/store.js');
const { runWithActor } = await import('../packages/lore/src/security/actorContext.js');
const { graphSchemaDdl, verbatimSchemaDdl } = await import('../packages/lore/src/engines/arcade/arcadeSchema.js');
const { upgradeNodeScopes } = await import('../packages/lore/src/engines/arcade/arcadeNodeScopes.js');
const { spikeArcadeUpgradeNodeScopes } = await import('../packages/lore/src/engines/arcade/arcadeRootTransport.js');
const { ID_UNAVAILABLE } = await import('../packages/lore/src/security/writeTargetGate.js');
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'wscope-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[(i * 7 + text.charCodeAt(i)) % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(t: string): Promise<number[]> { return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> { return this.vec(t); }
}

// ── docker lifecycle (own container only) ───────────────────────────────────
function docker(args: string[]): { status: number | null; out: string } {
    const r = spawnSync('docker', args, { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function removeOwnContainer(): void { docker(['rm', '-f', CONTAINER]); }
function startContainer(): void {
    removeOwnContainer(); // only ever our own name
    const run = docker([
        'run', '-d', '--name', CONTAINER, '-p', `127.0.0.1:${PORT}:2480`,
        '-e', `JAVA_OPTS=-Darcadedb.server.rootPassword=${ROOT_PW}`, ARCADE_STABLE_TAG,
    ]);
    if (run.status !== 0) throw new Error(`docker run failed: ${run.out}`);
}
async function waitReady(timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${BASE_URL}/api/v1/ready`, { headers: { Authorization: 'Basic ' + Buffer.from(`root:${ROOT_PW}`).toString('base64') } });
            if (res.ok || res.status === 204) return;
        } catch (e) { last = e; }
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`ArcadeDB not ready in ${timeoutMs}ms: ${String(last)}`);
}

// ── http fakes for the bulk route (same shapes as write-scopes-bulk-unit.ts) ──
function postReq(body: string): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST',
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
type Res = ServerResponse & { _status: number; _body: string };
function fakeRes(): Res {
    return {
        _status: 0, _body: '',
        writeHead(s: number) { (this as { _status: number })._status = s; return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
    } as unknown as Res;
}

const WS = 'wscope';
const TS = '2026-10-07T00:00:00.000Z';

async function main(): Promise<void> {
    startContainer();
    await waitReady();
    console.log(`ArcadeDB ${ARCADE_STABLE_TAG} up in ${CONTAINER} on ${BASE_URL}`);

    const root = new ArcadeHttp({ user: 'root', pass: ROOT_PW }, BASE_URL);
    await root.serverCommand('create database wscope_e2e');
    const http = new ArcadeHttp({ user: 'root', pass: ROOT_PW }, BASE_URL);
    const embedder = new DetEmbedProvider();
    const vector = new ArcadeVectorStore({ tenantDb: 'wscope_e2e', http, embedder });
    const graph = new ArcadeGraphStore({ tenantDb: 'wscope_e2e', http });
    await vector.initialize();
    await graph.initialize();

    const meta = (scopes?: string[]) => ({ type: 'note', label: 'x', tags: '', project: WS, ecosystem: '*', updatedAt: TS, ...(scopes ? { security_scopes: scopes } : {}) });
    /** Raw column straight from the DB (not via the store under test). */
    const rawScopes = async (id: string): Promise<unknown> => {
        const r = await http.query('wscope_e2e', 'SELECT security_scopes FROM LoreVerbatim WHERE id = :id LIMIT 1', { id });
        return (r.result?.[0] as { security_scopes?: unknown } | undefined)?.security_scopes;
    };
    const rowCount = async (id: string): Promise<number> => {
        const r = await http.query('wscope_e2e', 'SELECT count(*) AS n FROM LoreVerbatim WHERE id = :id', { id });
        return Number((r.result?.[0] as { n?: number } | undefined)?.n ?? -1);
    };

    // ── cases 1-4: store-level rewrite semantics ─────────────────────────────
    console.log('\nArcadeVectorStore.store rewrite semantics (real ArcadeDB)');
    await test('1. store ["a"]; re-store WITHOUT scopes -> still ["a"] (raw column + getById)', async () => {
        await vector.store({ id: 'lore:r1', text: 'one', metadata: meta(['a']) });
        assert.equal(await rawScopes('lore:r1'), 'a');
        await vector.store({ id: 'lore:r1', text: 'one changed', metadata: meta() });
        assert.equal(await rawScopes('lore:r1'), 'a');
        assert.deepEqual((await vector.getById('lore:r1'))?.security_scopes, ['a']);
        assert.equal((await vector.getById('lore:r1'))?.text, 'one changed', 'the rewrite itself did land');
    });
    await test('2. re-store with explicit [] -> [] (public)', async () => {
        await vector.store({ id: 'lore:r1', text: 'one', metadata: meta([]) });
        assert.equal(await rawScopes('lore:r1'), '');
        assert.deepEqual((await vector.getById('lore:r1'))?.security_scopes, []);
    });
    await test('3. re-store with ["b"] -> ["b"]; multi-scope round-trips', async () => {
        await vector.store({ id: 'lore:r1', text: 'one', metadata: meta(['b']) });
        assert.deepEqual((await vector.getById('lore:r1'))?.security_scopes, ['b']);
        await vector.store({ id: 'lore:r1', text: 'one', metadata: meta(['b', 'c']) });
        assert.deepEqual((await vector.getById('lore:r1'))?.security_scopes, ['b', 'c']);
        await vector.store({ id: 'lore:r1', text: 'one v3', metadata: meta() });
        assert.deepEqual((await vector.getById('lore:r1'))?.security_scopes, ['b', 'c'], 'absent keeps a multi-scope value');
    });
    await test('4. getById returns security_scopes; brand-new row without scopes is public; missing id -> null', async () => {
        await vector.store({ id: 'lore:r4', text: 'four', metadata: meta() });
        assert.deepEqual((await vector.getById('lore:r4'))?.security_scopes, []);
        await vector.store({ id: 'lore:r4b', text: 'four b', metadata: meta(['finance']) });
        assert.deepEqual((await vector.getById('lore:r4b'))?.security_scopes, ['finance']);
        assert.equal(await vector.getById('lore:nope'), null);
    });
    await test('4b. storePrebuilt: absent keeps, explicit [] wins, new row public', async () => {
        const vec = new Array(embedder.dimension).fill(0.1);
        const row = (id: string, scopes?: string[]) => ({ id, text: id, embedding: vec, metadata: meta(scopes) });
        await vector.storePrebuilt([row('lore:p1', ['finance']), row('lore:p2', ['finance'])]);
        await vector.storePrebuilt([row('lore:p1'), row('lore:p2', []), row('lore:p3')]);
        assert.equal(await rawScopes('lore:p1'), 'finance');
        assert.equal(await rawScopes('lore:p2'), '');
        assert.equal(await rawScopes('lore:p3'), '');
    });
    await test('store: a re-store of unchanged text (embedding reuse branch) with no scopes also keeps them', async () => {
        await vector.store({ id: 'lore:r5', text: 'same text', metadata: meta(['a']) });
        await vector.store({ id: 'lore:r5', text: 'same text', metadata: meta() });
        assert.equal(await rawScopes('lore:r5'), 'a');
    });

    // ── cases 5-6: the real bulk route over the real stores ──────────────────
    const outbox = new FileOutboxStore(path.join(LORE_HOME, 'outbox'));
    const storageClient = LoreStorageClient.fromLocal({ graph, verbatim: vector });
    const deps = {
        store: { loreGraph: graph, loreVerbatim: vector, storageClient },
        auditLog: { log: () => undefined },
        deploymentMode: 'local', dataplane: null, outboxStore: outbox,
    };
    async function bulk(pathname: string, body: Record<string, unknown>, d: unknown = deps): Promise<{ status: number; body: Record<string, unknown> }> {
        const res = fakeRes();
        const handled = await tryBulkWriteRoutes(postReq(JSON.stringify({ workspace: WS, ...body })), res, pathname, pathname, d as never);
        assert.equal(handled, true);
        return { status: res._status, body: JSON.parse(res._body) as Record<string, unknown> };
    }
    const bound = <T>(scopes: string[], fn: () => Promise<T>): Promise<T> => runWithActor({ portalUserId: 'u', scopes }, fn);
    type Item = { ok: boolean; id?: string; error?: string };

    console.log('\nPOST /api/nodes/bulk over real ArcadeGraphStore + ArcadeVectorStore');
    const isolatedPending = async (): Promise<Array<{ operationKind?: string; payload?: Record<string, unknown> }>> =>
        (await outbox.listPendingForWorkspace(WS, 10_000)) as never;

    await test('5a. inline mirror of a scoped node keeps the scopes (node + canonical row)', async () => {
        // The node and its canonical verbatim row both hold ['y'].
        await graph.upsertNode({ id: 'n5', type: 'note', label: 'L5', content: 'c5', tags: [], project: WS, ecosystem: '*', metadata: '{}', security_scopes: ['y'] } as never);
        await vector.store({ id: 'lore:n5', text: 'L5\nc5', metadata: meta(['y']) });
        const out = await bulk('/api/nodes/bulk', { embed: 'inline', nodes: [{ id: 'n5', type: 'note', label: 'L5 v2', content: 'c5 v2' }] });
        assert.equal(out.status, 200, JSON.stringify(out.body));
        assert.equal((out.body['results'] as Item[])[0]!.ok, true, JSON.stringify(out.body));
        const row = await vector.getById('lore:n5');
        assert.match(row?.text ?? '', /c5 v2/, 'mirror was rewritten');
        assert.deepEqual(row?.security_scopes, ['y'], 'scopes survived the bulk rewrite');
        assert.deepEqual((await graph.getNode('n5'))?.security_scopes, ['y'], 'node vertex scopes survived the bulk rewrite');
    });

    await test('5b. question-alias rows are written with the node scopes (outbox payload + real replay)', async () => {
        const out = await bulk('/api/nodes/bulk', { embed: 'inline', nodes: [{ id: 'n5', type: 'note', label: 'L5 v3', content: 'c5 v3', questions: ['What is n5?'] }] });
        assert.equal(out.status, 200, JSON.stringify(out.body));
        assert.equal((out.body['results'] as Item[])[0]!.ok, true, JSON.stringify(out.body));
        const pending = await isolatedPending();
        const alias = pending.filter((e) => /alias|#q|verbatim/i.test(JSON.stringify(e.payload ?? {})) && /verbatim\.upsert/.test(String(e.operationKind)) && JSON.stringify(e.payload).includes('What is n5?'));
        assert.ok(alias.length >= 1, `an alias verbatim.upsert outbox row exists; pending kinds=${pending.map((e) => e.operationKind).join(',')}`);
        const p = alias[0]!.payload as { id?: string; text?: string; metadata?: Record<string, unknown> };
        assert.deepEqual(p.metadata?.['security_scopes'], ['y'], `alias payload carries the node scopes: ${JSON.stringify(p)}`);
        // Replay the alias payload through the REAL Arcade store, exactly as the replicator would.
        await vector.store({ id: String(p.id), text: String(p.text), metadata: p.metadata as never });
        assert.deepEqual((await vector.getById(String(p.id)))?.security_scopes, ['y']);
    });

    console.log('\nbound actor (row-scope write gate) over the real stores');
    await test('6a. bound ["x"]: bulk upsert of a hidden id -> id_unavailable; nothing written; free id still created', async () => {
        await graph.upsertNode({ id: 'hid', type: 'note', label: 'L-hid', content: 'c', tags: [], project: WS, ecosystem: '*', metadata: '{}', security_scopes: ['y'] } as never);
        await vector.store({ id: 'lore:hid', text: 'L-hid\nc', metadata: meta(['y']) });
        const before = await vector.getById('lore:hid');
        const out = await bound(['x'], () => bulk('/api/nodes/bulk', { embed: 'inline', nodes: [
            { id: 'hid', type: 'note', label: 'HACKED', content: 'hacked' },
            { id: 'fresh6', type: 'note', label: 'F6', content: 'f6' },
        ] }));
        const results = out.body['results'] as Item[];
        assert.equal(out.status, 200, JSON.stringify(out.body));
        assert.equal(results[0]!.ok, false, JSON.stringify(results));
        assert.match(results[0]!.error ?? '', new RegExp(`^${ID_UNAVAILABLE}: `));
        assert.doesNotMatch(results[0]!.error ?? '', /scope|permission|hidden|denied|forbidden/i);
        assert.equal(results[1]!.ok, true, JSON.stringify(results));
        assert.equal((await graph.getNode('hid'))?.label, 'L-hid', 'graph node untouched');
        assert.deepEqual(await vector.getById('lore:hid'), before, 'verbatim row untouched');
        assert.equal(await rowCount('lore:hid'), 1);
        assert.equal((await graph.getNode('fresh6'))?.label, 'F6');
    });
    const seedHidden = async (id: string, scopes: string[]): Promise<void> => {
        await graph.upsertNode({ id, type: 'note', label: `L-${id}`, content: 'c', tags: [], project: WS, ecosystem: '*', metadata: '{}', security_scopes: scopes } as never);
        await vector.store({ id: `lore:${id}`, text: `L-${id}\nc`, metadata: meta(scopes) });
    };
    await test('6b. bound ["x"]: bulk-delete of a hidden id answers exactly like a missing id', async () => {
        await seedHidden('hid2', ['y']);
        const hidden = await bound(['x'], () => bulk('/api/nodes/bulk-delete', { ids: ['hid2'] }));
        const missing = await bound(['x'], () => bulk('/api/nodes/bulk-delete', { ids: ['no-such-node'] }));
        const norm = (v: unknown, id: string): unknown => JSON.parse(JSON.stringify(v).split(id).join('<ID>'));
        assert.equal(hidden.status, missing.status, JSON.stringify(hidden.body));
        assert.deepEqual(norm(hidden.body, 'hid2'), norm(missing.body, 'no-such-node'));
    });
    await test('6b2. bound ["x"]: after that bulk-delete the hidden node and its scoped verbatim row still exist', async () => {
        await seedHidden('hid3', ['y']);
        await bound(['x'], () => bulk('/api/nodes/bulk-delete', { ids: ['hid3'] }));
        const state = { graphNodeExists: !!(await graph.getNode('hid3')), verbatimRows: await rowCount('lore:hid3'), verbatimScopes: (await vector.getById('lore:hid3'))?.security_scopes ?? null };
        assert.deepEqual(state, { graphNodeExists: true, verbatimRows: 1, verbatimScopes: ['y'] }, 'hidden item must be untouched');
    });
    await test('6c. bound ["y"] (the owner scope) may upsert its node; the scopes stay ["y"]', async () => {
        await seedHidden('own6', ['y']);
        const out = await bound(['y'], () => bulk('/api/nodes/bulk', { embed: 'inline', nodes: [{ id: 'own6', type: 'note', label: 'L-own6 v2', content: 'c2' }] }));
        const results = out.body['results'] as Item[];
        assert.equal(results[0]!.ok, true, JSON.stringify(out.body));
        assert.match((await vector.getById('lore:own6'))?.text ?? '', /c2/);
        assert.deepEqual((await vector.getById('lore:own6'))?.security_scopes, ['y']);
        assert.deepEqual((await graph.getNode('own6'))?.security_scopes, ['y'], 'node vertex keeps ["y"] too');
    });

    // ── case 8: every other read + write door, same container and stores ─────
    const { runDoors } = await import('./arcade-wscope-doors.js');
    await runDoors({ graph, vector, http, ws: WS, test, bulk });

    // ── case 7: v3 -> v4 upgrade + backfill on a real cell ───────────────────
    console.log('\nschema v3 -> v4 upgrade and backfill (real ArcadeDB)');
    const V3DB = 'wscope_v3_e2e';
    const nodeNullCount = async (): Promise<number> => {
        const r = await http.query(V3DB, 'SELECT count(*) AS n FROM LoreNode WHERE security_scopes IS NULL');
        return Number((r.result?.[0] as { n?: number } | undefined)?.n ?? -1);
    };
    const rawNodeScopes = async (id: string): Promise<unknown> => {
        const r = await http.query(V3DB, 'SELECT security_scopes FROM LoreNode WHERE id = :id LIMIT 1', { id });
        return (r.result?.[0] as { security_scopes?: unknown } | undefined)?.security_scopes;
    };
    let v3Vector: InstanceType<typeof ArcadeVectorStore>;
    let v3Graph: InstanceType<typeof ArcadeGraphStore>;
    await test('7a. a v3 cell (no LoreNode.security_scopes) holds legacy nodes that read as NULL', async () => {
        await root.serverCommand(`create database ${V3DB}`);
        // Exactly the v3 graph DDL: every statement except the v4 property.
        for (const stmt of graphSchemaDdl().filter((x) => !x.includes('security_scopes'))) await http.command(V3DB, stmt);
        for (const stmt of verbatimSchemaDdl(embedder.dimension)) await http.command(V3DB, stmt);
        const props = await http.query(V3DB, "SELECT properties.name AS names FROM schema:types WHERE name = 'LoreNode'");
        assert.ok(!JSON.stringify(props.result).includes('security_scopes'), 'v3 cell has no security_scopes property yet');
        v3Vector = new ArcadeVectorStore({ tenantDb: V3DB, http, embedder });
        await v3Vector.initialize();
        const legacy = ['v3-hid', 'v3-pub', 'v3-none', 'v3-dmg'];
        for (const id of legacy) {
            await http.command(V3DB,
                'UPDATE LoreNode SET id = :id, type = :t, label = :l, content = :c, tags = :tags, project = :p, ecosystem = :e, metadata = :m, createdAt = :ts, updatedAt = :ts UPSERT WHERE id = :id',
                { id, t: 'note', l: `L-${id}`, c: 'c', tags: '[]', p: WS, e: '*', m: '{}', ts: TS });
        }
        await v3Vector.store({ id: 'lore:v3-hid', text: 'L-v3-hid\nc', metadata: meta(['y', 'z']) });
        await v3Vector.store({ id: 'lore:v3-pub', text: 'L-v3-pub\nc', metadata: meta([]) });
        await v3Vector.store({ id: 'lore:v3-dmg', text: 'L-v3-dmg\nc', metadata: meta(['q']) });
        await http.command(V3DB, "UPDATE LoreVerbatim SET security_scopes = 'undefined' WHERE id = 'lore:v3-dmg'");
        // v3-none has no verbatim row at all.
        // The v4 DDL is additive: the property now exists but every legacy row is NULL.
        for (const stmt of graphSchemaDdl()) await http.command(V3DB, stmt);
        assert.equal(await nodeNullCount(), 4, 'IS NULL matches nodes whose property was never set');
    });
    await test('7b. upgradeNodeScopes backfills from the verbatim row (damaged copied as-is), defaults [] otherwise, reports counts', async () => {
        const r = await upgradeNodeScopes(V3DB, http);
        assert.deepEqual(r, { backfilledFromVerbatim: 2, defaultedPublic: 1, damagedVerbatim: 1 });
        assert.equal(await nodeNullCount(), 0);
        assert.equal(await rawNodeScopes('v3-hid'), '["y","z"]');
        assert.equal(await rawNodeScopes('v3-pub'), '[]');
        assert.equal(await rawNodeScopes('v3-none'), '[]');
        assert.equal(await rawNodeScopes('v3-dmg'), '["undefined"]', 'a damaged verbatim label stays fail-closed, never widened to []');
    });
    await test('7c. re-running is a no-op (through the provisioner root transport too) and never overwrites', async () => {
        const again = await spikeArcadeUpgradeNodeScopes(V3DB);
        assert.deepEqual(again, { backfilledFromVerbatim: 0, defaultedPublic: 0, damagedVerbatim: 0 });
        assert.equal(await rawNodeScopes('v3-hid'), '["y","z"]');
    });
    await test('7d. the upgraded cell serves the labels and a bound actor cannot bulk-delete the hidden node', async () => {
        v3Graph = new ArcadeGraphStore({ tenantDb: V3DB, http });
        await v3Graph.initialize(); // replays the DDL + the (now empty) backfill
        assert.deepEqual((await v3Graph.getNode('v3-hid'))?.security_scopes, ['y', 'z']);
        assert.deepEqual((await v3Graph.getNode('v3-pub'))?.security_scopes, []);
        const page = await v3Graph.bulkList({ limit: 10 } as never);
        assert.deepEqual(page.nodes.find((n) => n.id === 'v3-hid')?.security_scopes, ['y', 'z']);
        const v3Deps = {
            store: { loreGraph: v3Graph, loreVerbatim: v3Vector, storageClient: LoreStorageClient.fromLocal({ graph: v3Graph, verbatim: v3Vector }) },
            auditLog: { log: () => undefined },
            deploymentMode: 'local', dataplane: null, outboxStore: outbox,
        };
        const hidden = await bound(['x'], () => bulk('/api/nodes/bulk-delete', { ids: ['v3-hid'] }, v3Deps));
        const missing = await bound(['x'], () => bulk('/api/nodes/bulk-delete', { ids: ['no-such-v3'] }, v3Deps));
        const norm = (v: unknown, id: string): unknown => JSON.parse(JSON.stringify(v).split(id).join('<ID>'));
        assert.equal(hidden.status, missing.status);
        assert.deepEqual(norm(hidden.body, 'v3-hid'), norm(missing.body, 'no-such-v3'));
        assert.ok(await v3Graph.getNode('v3-hid'), 'hidden node survived the bound delete');
        assert.equal(await v3Vector.getById('lore:v3-hid') !== null, true, 'its verbatim row survived too');
        // An unbound caller (local mode) still deletes it, exactly as before.
        await bulk('/api/nodes/bulk-delete', { ids: ['v3-pub'] }, v3Deps);
        assert.equal(await v3Graph.getNode('v3-pub'), null, 'unbound delete of a public node works');
    });
    await test('7e. paging: 450 more legacy nodes (> 2 pages of 200) backfill in one upgrade, half from a verbatim row', async () => {
        const params: Record<string, unknown> = {};
        const stmts: string[] = [];
        for (let i = 0; i < 450; i++) {
            params[`i${i}`] = `bulk-${i}`;
            stmts.push(`UPDATE LoreNode SET id = :i${i}, type = 'note', label = 'b', content = 'c', tags = '[]', project = '${WS}', ecosystem = '*', metadata = '{}', createdAt = '${TS}', updatedAt = '${TS}' UPSERT WHERE id = :i${i};`);
        }
        await http.commandScript(V3DB, stmts.join('\n'), params);
        for (let i = 0; i < 450; i += 2) await v3Vector.store({ id: `lore:bulk-${i}`, text: `b${i}`, metadata: meta(['pg']) });
        assert.equal(await nodeNullCount(), 450);
        const r = await upgradeNodeScopes(V3DB, http);
        assert.deepEqual(r, { backfilledFromVerbatim: 225, defaultedPublic: 225, damagedVerbatim: 0 });
        assert.equal(await nodeNullCount(), 0);
        assert.equal(await rawNodeScopes('bulk-0'), '["pg"]');
        assert.equal(await rawNodeScopes('bulk-1'), '[]');
        assert.deepEqual((await upgradeNodeScopes(V3DB, http)), { backfilledFromVerbatim: 0, defaultedPublic: 0, damagedVerbatim: 0 });
    });
}

let exitCode = 0;
try {
    await main();
} catch (err) {
    console.error(`\nFATAL: ${(err as Error).stack ?? (err as Error).message}`);
    exitCode = 1;
} finally {
    removeOwnContainer();
    const left = docker(['ps', '-a', '--filter', `name=^/${CONTAINER}$`, '--format', '{{.Names}}']);
    if (left.out.trim()) { console.error(`container ${CONTAINER} still present after rm -f`); exitCode = 1; }
    fs.rmSync(LORE_HOME, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(exitCode || (failed === 0 ? 0 : 1));
