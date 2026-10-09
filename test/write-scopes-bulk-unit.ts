#!/usr/bin/env tsx
/**
 * test/write-scopes-bulk-unit.ts — row-level security_scopes on the BULK write
 * paths (slice B): POST /api/nodes/bulk, /api/nodes/bulk-delete, /api/edges/bulk,
 * the importer (runImport, behind POST /api/import and MCP import_data) and
 * POST /api/load (+ cancel).
 *
 * Contract pinned here:
 *   - a bound actor's write on a hidden item answers exactly like a missing id
 *     and changes nothing;
 *   - a create/upsert with a caller-chosen id held by a hidden item gets
 *     id_unavailable (never "updated" / "skipped" / "exists");
 *   - unbound callers behave as before and cause no extra lookups;
 *   - bulk-load is operator-only for bound actors;
 *   - the bulk inline verbatim mirror carries the node's security_scopes.
 *
 * Run: npx tsx test/write-scopes-bulk-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { rowToLoreNode } from '../packages/lore/src/engines/loreNodeRow.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { runImport } from '../packages/lore/src/mcp/http/routes/import.js';
import { tryLoadRoutes } from '../packages/lore/src/mcp/http/routes/load.js';
import { LoadJobsStore } from '../packages/lore/src/storage/loadJobsStore.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { applyWriteTimeSupersedes } from '../packages/lore/src/core/supersessionPolicy.js';
import { ID_UNAVAILABLE } from '../packages/lore/src/security/writeTargetGate.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}

const bound = <T>(scopes: string[], fn: () => Promise<T>): Promise<T> => runWithActor({ portalUserId: 'u', scopes }, fn);
const mkTmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));

/* ---------- http fakes ---------- */

function postReq(body: string, method = 'POST'): IncomingMessage {
    let consumed = false;
    return {
        method,
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
type Res = ServerResponse & { _status: number; _body: string; _headers: Record<string, string> };
function fakeRes(): Res {
    const r = {
        _status: 0, _body: '', _headers: {} as Record<string, string>,
        writeHead(s: number, h?: Record<string, string>) { (this as { _status: number })._status = s; if (h) (this as { _headers: Record<string, string> })._headers = { ...h }; return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
    };
    return r as unknown as Res;
}

/* ---------- a real SQLite graph with scoped nodes ---------- */

const WS = 'wsb';
interface Rig { graph: SqliteGraph; outbox: FileOutboxStore; verbatimRows: Map<string, { security_scopes?: unknown }> }
async function rig(): Promise<Rig> {
    const graph = new SqliteGraph(mkTmp('wsb-g-'), { workspaceId: WS });
    await graph.initialize();
    const outbox = new FileOutboxStore(mkTmp('wsb-o-'));
    return { graph, outbox, verbatimRows: new Map() };
}
const node = (id: string, scopes?: string[], label = `L-${id}`) => ({
    id, type: 'note', label, content: `content ${id}`, tags: [], project: WS, ecosystem: '*',
    metadata: '{}', ...(scopes ? { security_scopes: scopes } : {}),
}) as never;
/** hid: scopes [y] (actor [x] cannot see it); vis: [x]; open: unscoped. */
async function seedNodes(r: Rig): Promise<void> {
    for (const n of [node('hid', ['y']), node('vis', ['x']), node('open')]) await r.graph.upsertNode(n);
    for (const id of ['a-hid', 'a-vis']) await r.graph.upsertNode(node(id, id === 'a-hid' ? ['y'] : ['x']));
}
const verbatimOf = (r: Rig) => ({
    async getById(id: string) { return r.verbatimRows.get(id) ?? null; },
    async store() { /* no-op */ },
    async tombstone() { /* no-op */ },
});

async function bulk(r: Rig, pathname: string, body: Record<string, unknown>, extraDeps: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = fakeRes();
    const handled = await tryBulkWriteRoutes(postReq(JSON.stringify({ workspace: WS, ...body })), res, pathname, pathname, {
        store: { loreGraph: r.graph, loreVerbatim: verbatimOf(r) } as never,
        auditLog: { log: () => undefined } as never,
        deploymentMode: 'local', dataplane: null, outboxStore: r.outbox, ...extraDeps,
    } as never);
    assert.equal(handled, true);
    return { status: res._status, body: JSON.parse(res._body) as Record<string, unknown> };
}
const outboxCount = async (r: Rig): Promise<number> => (await r.outbox.listPendingForWorkspace(WS, 10_000)).length;
const labelOf = async (r: Rig, id: string): Promise<unknown> => (await r.graph.getNode(id))?.label;
const scopesOf = async (r: Rig, id: string): Promise<unknown> => (await r.graph.getNode(id) as { security_scopes?: unknown } | null)?.security_scopes;
/** Replace the per-id echo so a hidden-id response can be compared to a missing-id response. */
const norm = (v: unknown, id: string): unknown => JSON.parse(JSON.stringify(v).split(id).join('<ID>'));

/* ========================= 1. POST /api/nodes/bulk ========================= */
console.log('\nPOST /api/nodes/bulk\n');

type BulkItem = { ok: boolean; id?: string; error?: string };
const upsertItems = (ids: string[]) => ids.map((id) => ({ id, type: 'note', label: `NEW-${id}`, content: `new ${id}` }));

await test('bound: hidden id → id_unavailable (per item), free id created, visible id upserted; hidden node unchanged', async () => {
    const r = await rig(); await seedNodes(r);
    const out = await bound(['x'], () => bulk(r, '/api/nodes/bulk', { nodes: upsertItems(['hid', 'fresh', 'vis']) }));
    const results = out.body.results as BulkItem[];
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(results[0]!.ok, false);
    assert.match(results[0]!.error!, new RegExp(`^${ID_UNAVAILABLE}: `));
    assert.doesNotMatch(results[0]!.error!, /scope|permission|hidden|denied|forbidden/i);
    assert.equal(results[1]!.ok, true);
    assert.equal(results[2]!.ok, true);
    assert.equal(await labelOf(r, 'hid'), 'L-hid', 'hidden node untouched');
    assert.deepEqual(await scopesOf(r, 'hid'), ['y']);
    assert.equal(await labelOf(r, 'fresh'), 'NEW-fresh');
    assert.equal(await labelOf(r, 'vis'), 'NEW-vis');
    assert.deepEqual(await scopesOf(r, 'vis'), ['x'], 'visible upsert keeps its scopes');
});

await test('bound: a refused id writes no outbox row', async () => {
    const r = await rig(); await seedNodes(r);
    const before = await outboxCount(r);
    await bound(['x'], () => bulk(r, '/api/nodes/bulk', { nodes: upsertItems(['hid']) }));
    assert.equal(await outboxCount(r), before);
});

await test('bound: id held only by a canonical verbatim row (node gone) is refused; free id is not', async () => {
    const r = await rig();
    r.verbatimRows.set('lore:ghost', { security_scopes: ['y'] });
    const out = await bound(['x'], () => bulk(r, '/api/nodes/bulk', { nodes: upsertItems(['ghost', 'fresh2']) }));
    const results = out.body.results as BulkItem[];
    assert.match(results[0]!.error!, new RegExp(`^${ID_UNAVAILABLE}: `));
    assert.equal(results[1]!.ok, true);
    assert.equal(await r.graph.getNode('ghost'), null);
});

await test('bound with matching scopes may overwrite its own verbatim-held id', async () => {
    const r = await rig();
    r.verbatimRows.set('lore:mine', { security_scopes: ['x'] });
    const out = await bound(['x'], () => bulk(r, '/api/nodes/bulk', { nodes: upsertItems(['mine']) }));
    assert.equal((out.body.results as BulkItem[])[0]!.ok, true);
});

await test('unbound: the same hidden id upserts as before', async () => {
    const r = await rig(); await seedNodes(r);
    const out = await bulk(r, '/api/nodes/bulk', { nodes: upsertItems(['hid', 'fresh']) });
    const results = out.body.results as BulkItem[];
    assert.ok(results.every((i) => i.ok), JSON.stringify(results));
    assert.equal(await labelOf(r, 'hid'), 'NEW-hid');
});

await test('unbound: zero visibility lookups (no verbatim read, no version read)', async () => {
    const r = await rig();
    let reads = 0;
    const v = { ...verbatimOf(r), async getById() { reads++; return null; } };
    const res = fakeRes();
    await tryBulkWriteRoutes(postReq(JSON.stringify({ workspace: WS, nodes: upsertItems(['a', 'b', 'c']) })), res, '/api/nodes/bulk', '/api/nodes/bulk', {
        store: { loreGraph: r.graph, loreVerbatim: v } as never, auditLog: { log: () => undefined } as never,
        deploymentMode: 'local', dataplane: null, outboxStore: r.outbox,
        versionStore: { getVersions: () => { reads++; return []; } },
    } as never);
    assert.equal(res._status, 200, res._body);
    assert.equal(reads, 0);
});

/* ========================= 2. POST /api/nodes/bulk-delete ========================= */
console.log('\nPOST /api/nodes/bulk-delete\n');

await test('bound: hidden id answers byte-for-byte like a missing id, and the node survives', async () => {
    const r = await rig(); await seedNodes(r);
    const before = await outboxCount(r);
    const hidden = await bound(['x'], () => bulk(r, '/api/nodes/bulk-delete', { ids: ['hid'] }));
    const missing = await bound(['x'], () => bulk(r, '/api/nodes/bulk-delete', { ids: ['nope'] }));
    assert.equal(hidden.status, 200);
    assert.deepEqual(norm(hidden.body, 'hid'), norm(missing.body, 'nope'));
    assert.equal(hidden.body.notFound, 1);
    assert.equal(hidden.body.deleted, 0);
    assert.equal(await labelOf(r, 'hid'), 'L-hid');
    assert.equal(await outboxCount(r), before, 'no outbox row for a hidden or missing id');
});

await test('bound: mixed batch deletes only the visible ids, counts the hidden one as notFound', async () => {
    const r = await rig(); await seedNodes(r);
    const out = await bound(['x'], () => bulk(r, '/api/nodes/bulk-delete', { ids: ['hid', 'vis', 'open', 'nope'] }));
    assert.equal(out.body.deleted, 2);
    assert.equal(out.body.notFound, 2);
    assert.equal(await r.graph.getNode('hid') !== null, true);
    assert.equal(await r.graph.getNode('vis'), null);
    assert.equal(await r.graph.getNode('open'), null);
});

await test('bound: a lore:-prefixed hidden id is also treated as missing', async () => {
    const r = await rig(); await seedNodes(r);
    const hidden = await bound(['x'], () => bulk(r, '/api/nodes/bulk-delete', { ids: ['lore:hid'] }));
    const missing = await bound(['x'], () => bulk(r, '/api/nodes/bulk-delete', { ids: ['lore:nope'] }));
    assert.deepEqual(norm(hidden.body, 'hid'), norm(missing.body, 'nope'));
    assert.notEqual(await r.graph.getNode('hid'), null);
});

await test('unbound: the same hidden id is deleted as before', async () => {
    const r = await rig(); await seedNodes(r);
    const out = await bulk(r, '/api/nodes/bulk-delete', { ids: ['hid'] });
    assert.equal(out.body.deleted, 1);
    assert.equal(await r.graph.getNode('hid'), null);
});

/* ========================= 3. POST /api/edges/bulk ========================= */
console.log('\nPOST /api/edges/bulk\n');

const edge = (s: string, t: string, extra: Record<string, unknown> = {}) => ({ sourceId: s, targetId: t, relation: 'rel', bidirectional: false, ...extra });
const edgeCount = async (r: Rig): Promise<number> => (await r.graph.queryEdges({ limit: 1000, offset: 0 } as never)).length;

await test('bound: edge with a hidden target answers exactly like one with a missing target; nothing written', async () => {
    const r = await rig(); await seedNodes(r);
    const before = await outboxCount(r);
    const hidden = await bound(['x'], () => bulk(r, '/api/edges/bulk', { edges: [edge('vis', 'hid')] }));
    const missing = await bound(['x'], () => bulk(r, '/api/edges/bulk', { edges: [edge('vis', 'nope')] }));
    assert.equal(hidden.status, 200);
    assert.deepEqual(norm(hidden.body, 'hid'), norm(missing.body, 'nope'));
    assert.equal((hidden.body.results as BulkItem[])[0]!.ok, false);
    assert.equal(await edgeCount(r), 0);
    assert.equal(await outboxCount(r), before);
});

await test("bound: the refusal is the engine's own missing-endpoint message (compared with the real engine's reply)", async () => {
    const r = await rig(); await seedNodes(r);
    const real = await bulk(r, '/api/edges/bulk', { edges: [edge('vis', 'nope')] }); // unbound: engine answers
    const hidden = await bound(['x'], () => bulk(r, '/api/edges/bulk', { edges: [edge('vis', 'hid')] }));
    const realErr = (real.body.results as BulkItem[])[0]!.error!;
    const hiddenErr = (hidden.body.results as BulkItem[])[0]!.error!;
    assert.equal(hiddenErr.replace('hid', 'nope'), realErr);
});

await test('bound: hidden source, hidden both, and a bidirectional edge are refused the same way', async () => {
    const r = await rig(); await seedNodes(r);
    const out = await bound(['x'], () => bulk(r, '/api/edges/bulk', { edges: [edge('hid', 'vis'), edge('hid', 'a-hid'), edge('vis', 'hid', { bidirectional: true })] }));
    assert.ok((out.body.results as BulkItem[]).every((i) => !i.ok));
    assert.equal(await edgeCount(r), 0);
});

await test('bound: an edge between two visible nodes is written as before', async () => {
    const r = await rig(); await seedNodes(r);
    const out = await bound(['x'], () => bulk(r, '/api/edges/bulk', { edges: [edge('vis', 'open'), edge('vis', 'hid')] }));
    const results = out.body.results as BulkItem[];
    assert.equal(results[0]!.ok, true, JSON.stringify(results));
    assert.equal(results[1]!.ok, false);
    assert.equal(await edgeCount(r), 1);
});

await test('unbound: an edge to the same hidden node is written as before', async () => {
    const r = await rig(); await seedNodes(r);
    const out = await bulk(r, '/api/edges/bulk', { edges: [edge('vis', 'hid')] });
    assert.equal((out.body.results as BulkItem[])[0]!.ok, true);
    assert.equal(await edgeCount(r), 1);
});

/* ========================= 4. importer ========================= */
console.log('\nrunImport (POST /api/import, MCP import_data)\n');

function importRig(existing: Record<string, string[] | undefined>) {
    const nodes = new Map<string, { id: string; security_scopes?: string[] }>();
    for (const [id, scopes] of Object.entries(existing)) nodes.set(id, { id, ...(scopes ? { security_scopes: scopes } : {}) });
    const verbatimRows = new Map<string, { security_scopes?: unknown }>();
    const graph = {
        getNode: async (id: string) => nodes.get(id) ?? null,
        upsertNode: async (n: Record<string, unknown>) => { nodes.set(String(n.id), n as never); return { id: String(n.id) }; },
    };
    const deps = {
        store: { loreGraph: graph, loreVerbatim: { getById: async (id: string) => verbatimRows.get(id) ?? null } },
        detectedScope: { workspace: WS, ecosystem: '*' }, deploymentMode: 'local' as const, dataplane: null,
    } as unknown as Parameters<typeof runImport>[0];
    return { nodes, verbatimRows, graph, deps };
}
const CSV = Buffer.from('Id,Name\n1,One\n2,Two\n3,Three\n', 'utf-8');
const impBody = (mode: 'upsert' | 'append') => ({
    format: 'csv' as const, filename: 't.csv', data: '', mode,
    mapping: { entityType: 'Item', idColumn: 'Id', fields: { Name: 'label' } },
}) as Parameters<typeof runImport>[2];
const runIt = (i: ReturnType<typeof importRig>, mode: 'upsert' | 'append') =>
    runImport(i.deps, CSV, impBody(mode), i.graph as never, WS);

await test('bound: a row whose id is held by a hidden node is rejected with id_unavailable, not counted skipped, not written', async () => {
    const i = importRig({ 'Item:2': ['y'] });
    const out = await bound(['x'], () => runIt(i, 'upsert'));
    assert.equal(out.imported, 2);
    assert.equal(out.skipped, 0);
    assert.equal(out.errored, 1);
    assert.equal(out.errors[0]!.row, 3);
    assert.match(out.errors[0]!.message, new RegExp(`^${ID_UNAVAILABLE}: `));
    assert.doesNotMatch(out.errors[0]!.message, /scope|permission|hidden|denied|forbidden/i);
    assert.deepEqual(i.nodes.get('Item:2')!.security_scopes, ['y'], 'hidden node untouched');
});

await test('bound + append: a hidden id is NOT counted as skipped (no existence oracle) — a visible existing id still is', async () => {
    const i = importRig({ 'Item:2': ['y'], 'Item:3': ['x'] });
    const out = await bound(['x'], () => runIt(i, 'append'));
    assert.equal(out.skipped, 1, 'only the visible existing id');
    assert.equal(out.errored, 1);
    assert.match(out.errors[0]!.message, new RegExp(`^${ID_UNAVAILABLE}: `));
    assert.equal(out.imported, 1);
});

await test('bound: id held only by a canonical verbatim row is rejected', async () => {
    const i = importRig({});
    i.verbatimRows.set('lore:Item:1', { security_scopes: ['y'] });
    const out = await bound(['x'], () => runIt(i, 'upsert'));
    assert.equal(out.errored, 1);
    assert.equal(out.imported, 2);
    assert.equal(i.nodes.has('Item:1'), false);
});

await test('bound: visible and free ids import as before', async () => {
    const i = importRig({ 'Item:1': ['x'] });
    const out = await bound(['x'], () => runIt(i, 'upsert'));
    assert.equal(out.imported, 3);
    assert.equal(out.errored, 0);
});

await test('unbound: the same hidden id imports as before; no lookups', async () => {
    const i = importRig({ 'Item:2': ['y'] });
    let looked = 0;
    const orig = i.graph.getNode;
    i.graph.getNode = async (id: string) => { looked++; return orig(id); };
    const out = await runIt(i, 'upsert');
    assert.equal(out.imported, 3);
    assert.equal(out.errored, 0);
    assert.equal(looked, 0);
});

await test('bound, no idColumn: ids are synthesised, nothing is looked up or refused', async () => {
    const i = importRig({});
    const body = { ...impBody('upsert'), mapping: { entityType: 'Item', fields: { Name: 'label' } } } as Parameters<typeof runImport>[2];
    const out = await bound(['x'], () => runImport(i.deps, CSV, body, i.graph as never, WS));
    assert.equal(out.imported, 3);
});

await test('a mapping target named security_scopes cannot set the node\'s row scopes', async () => {
    const i = importRig({});
    const body = { ...impBody('upsert'), mapping: { entityType: 'Item', idColumn: 'Id', fields: { Name: 'label', Id: 'security_scopes' } } } as Parameters<typeof runImport>[2];
    await runImport(i.deps, CSV, body, i.graph as never, WS);
    assert.equal((i.nodes.get('Item:1') as { security_scopes?: unknown }).security_scopes, undefined);
});

await test('replace mode is refused for a bound non-operator (defensive; the route 501s and the MCP enum excludes it)', async () => {
    const i = importRig({});
    const body = { ...impBody('upsert'), mode: 'replace' } as unknown as Parameters<typeof runImport>[2];
    await assert.rejects(() => bound(['x'], () => runImport(i.deps, CSV, body, i.graph as never, WS)), /administrators/);
    assert.equal(i.nodes.size, 0);
});

/* ========================= 5. POST /api/load (+ job cancel) ========================= */
console.log('\nPOST /api/load\n');

function loadReq(method: 'POST' | 'GET', chunks: Buffer[] = []): IncomingMessage {
    const handlers: Record<string, Array<(a?: unknown) => void>> = {};
    const req = { method, on(e: string, cb: (a?: unknown) => void) { (handlers[e] ??= []).push(cb); return this; } };
    setImmediate(() => { for (const c of chunks) for (const cb of handlers['data'] ?? []) cb(c); for (const cb of handlers['end'] ?? []) cb(); });
    return req as unknown as IncomingMessage;
}
const principal = (kind: Principal['kind']): Principal =>
    ({ kind, workspace: 'default', scopes: ['read', 'write'], label: 't', allowedWorkspaces: ['default'] }) as Principal;

async function loadRun(opts: { actor?: string[]; principalKind?: Principal['kind'] }) {
    const dir = mkTmp('wsb-load-');
    const store = new LoadJobsStore(dir);
    const records: unknown[] = [];
    const outboxStore = { async record(e: unknown) { records.push(e); }, async markStep() {}, async markCompleted() {}, async remove() {}, async listUnfinished() { return []; } };
    const res = fakeRes();
    const call = () => tryLoadRoutes(loadReq('POST', [Buffer.from('{"id":"a"}\n')]), res, '/api/load?workspace=default', '/api/load',
        { loreDir: dir, loadJobsStore: store, outboxStore: outboxStore as never, deploymentMode: 'local', dataplane: null });
    const withP = () => (opts.principalKind ? runWithPrincipal(principal(opts.principalKind), call) : call());
    await (opts.actor ? bound(opts.actor, withP) : withP());
    const jobs = await store.list('default');
    const files = fs.readdirSync(dir).filter((f) => !/\.(sqlite|db)/.test(f) && !f.startsWith('load-jobs'));
    store.close();
    return { res, records, jobs, files, dir };
}

await test('bound app-token actor: POST /api/load → 403 load_forbidden; no job row, no staged file, no outbox row', async () => {
    const o = await loadRun({ actor: ['x'], principalKind: 'app' });
    assert.equal(o.res._status, 403, o.res._body);
    assert.equal(JSON.parse(o.res._body).code, 'load_forbidden');
    assert.equal(o.jobs.length, 0);
    assert.equal(o.records.length, 0);
    assert.deepEqual(o.files, [], `staged files: ${o.files.join(',')}`);
});

await test('bound actor with no principal (Clerk-style) → 403 as well', async () => {
    const o = await loadRun({ actor: ['x'] });
    assert.equal(o.res._status, 403);
    assert.equal(o.jobs.length, 0);
});

await test('bound actor on the operator lane (bootstrap / shared-secret principal) → load accepted', async () => {
    for (const kind of ['bootstrap', 'shared-secret'] as const) {
        const o = await loadRun({ actor: ['x'], principalKind: kind });
        assert.equal(o.res._status, 200, `${kind}: ${o.res._body}`);
        assert.equal(o.jobs.length, 1);
        assert.equal(o.records.length, 1);
    }
});

await test('unbound caller: POST /api/load unchanged (with and without an app principal)', async () => {
    for (const kind of [undefined, 'app'] as const) {
        const o = await loadRun({ principalKind: kind });
        assert.equal(o.res._status, 200, `${kind}: ${o.res._body}`);
        assert.equal(o.jobs.length, 1);
    }
});

await test('cancel: bound non-operator → 403 for an existing AND an unknown job (cannot probe job ids); unbound unchanged', async () => {
    const dir = mkTmp('wsb-cancel-');
    const store = new LoadJobsStore(dir);
    await store.create({ jobId: 'jobA', workspace: 'default', format: 'jsonl', embedMode: 'skip', tempFilePath: path.join(dir, 'x.jsonl'), createdAt: new Date().toISOString() });
    const cancel = async (id: string, actor?: string[], kind?: Principal['kind']) => {
        const res = fakeRes();
        const call = () => tryLoadRoutes(loadReq('POST'), res, `/api/load/jobs/${id}/cancel`, `/api/load/jobs/${id}/cancel`,
            { loreDir: dir, loadJobsStore: store, deploymentMode: 'local', dataplane: null });
        const withP = () => (kind ? runWithPrincipal(principal(kind), call) : call());
        await (actor ? bound(actor, withP) : withP());
        return res;
    };
    const existing = await cancel('jobA', ['x'], 'app');
    const unknown = await cancel('nope', ['x'], 'app');
    assert.equal(existing._status, 403);
    assert.equal(unknown._status, 403);
    assert.equal(existing._body, unknown._body);
    assert.equal((await store.get('jobA'))!.status, 'received', 'job untouched');
    assert.equal((await cancel('nope', undefined, 'app'))._status, 404);
    assert.equal((await cancel('jobA', ['x'], 'bootstrap'))._status, 200);
    store.close();
});

/* ========================= 6. inline verbatim mirror carries the node's scopes ========================= */
console.log('\nbulk inline verbatim mirror\n');

async function inlineWrite(body: Record<string, unknown>) {
    const verbatimWrites: Array<{ id: string; metadata: Record<string, unknown> }> = [];
    const stored = new Map<string, Record<string, unknown>>();
    const methods = {
        async upsertNode(n: Record<string, unknown>) { stored.set(String(n.id), n); return rowToLoreNode(n) as never; },
        async bulkUpsertNodes(ns: Array<Record<string, unknown>>) { for (const n of ns) stored.set(String(n.id), n); return ns.map(() => ({ ok: true as const })); },
        async deleteNode() { /* no-op */ },
        async getNode(id: string) { return stored.get(id) ?? null; },
        getGraphContext() { return {}; },
    };
    const graph = Object.setPrototypeOf({ ...methods }, SurrealGraph.prototype);
    const verbatim = { async store(d: { id: string; metadata: Record<string, unknown> }) { verbatimWrites.push(d); }, async getById() { return null; } };
    const res = fakeRes();
    await tryBulkWriteRoutes(postReq(JSON.stringify(body)), res, '/api/nodes/bulk', '/api/nodes/bulk', {
        store: { loreGraph: graph, loreVerbatim: verbatim, storageClient: { async verbatimStore(d: never) { verbatimWrites.push(d); }, rawGraph: () => graph } } as never,
        auditLog: { log: () => undefined } as never, deploymentMode: 'local', dataplane: null,
        outboxStore: { async record() {}, async batchRecord() {}, async markStep() {}, async markCompleted() {}, async remove() {}, async listUnfinished() { return []; } },
    } as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { res, verbatimWrites, stored };
}

await test('a scoped node written with embed:inline gets a lore:<id> verbatim row carrying the SAME scopes', async () => {
    // The caller cannot supply security_scopes, so scope the node first by pre-existing it:
    // the inline path reads the prior row and must copy its scopes onto the verbatim mirror.
    const verbatimWrites: Array<{ id: string; metadata: Record<string, unknown> }> = [];
    const stored = new Map<string, Record<string, unknown>>([['sc', { id: 'sc', type: 'note', label: 'old', content: 'old', tags: [], project: WS, ecosystem: '*', metadata: '{}', security_scopes: ['x'] }]]);
    const graph = Object.setPrototypeOf({
        async upsertNode(n: Record<string, unknown>) { stored.set(String(n.id), { ...stored.get(String(n.id)), ...n }); return rowToLoreNode(stored.get(String(n.id))!) as never; },
        async bulkUpsertNodes(ns: Array<Record<string, unknown>>) { for (const n of ns) stored.set(String(n.id), { ...stored.get(String(n.id)), ...n }); return ns.map(() => ({ ok: true as const })); },
        async deleteNode() {},
        async getNode(id: string) { return stored.get(id) ?? null; },
        getGraphContext() { return {}; },
    }, SurrealGraph.prototype);
    const verbatim = { async store(d: { id: string; metadata: Record<string, unknown> }) { verbatimWrites.push(d); }, async getById() { return null; } };
    const res = fakeRes();
    await tryBulkWriteRoutes(postReq(JSON.stringify({ workspace: WS, embed: 'inline', nodes: [{ id: 'sc', type: 'note', label: 'new', content: 'new' }] })), res, '/api/nodes/bulk', '/api/nodes/bulk', {
        store: { loreGraph: graph, loreVerbatim: verbatim, storageClient: { async verbatimStore(d: never) { verbatimWrites.push(d); }, rawGraph: () => graph } } as never,
        auditLog: { log: () => undefined } as never, deploymentMode: 'local', dataplane: null,
        outboxStore: { async record() {}, async batchRecord() {}, async markStep() {}, async markCompleted() {}, async remove() {}, async listUnfinished() { return []; } },
    } as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(res._status, 200, res._body);
    const row = verbatimWrites.find((w) => w.id === 'lore:sc');
    assert.ok(row, 'inline verbatim row written');
    assert.deepEqual(row!.metadata.security_scopes, ['x'], 'mirror must carry the node scopes, not public');
});

await test('an unscoped node written inline carries no security_scopes on its verbatim row (unchanged)', async () => {
    const { res, verbatimWrites } = await inlineWrite({ workspace: WS, embed: 'inline', nodes: [{ id: 'pub', type: 'note', label: 'L', content: 'C' }] });
    assert.equal(res._status, 200, res._body);
    const row = verbatimWrites.find((w) => w.id === 'lore:pub')!;
    assert.equal(row.metadata.security_scopes === undefined || (Array.isArray(row.metadata.security_scopes) && (row.metadata.security_scopes as unknown[]).length === 0), true);
});

/* ========================= 7. `supersedes` on bulk upsert + import ========================= */
console.log('\nsupersedes (bulk upsert + import): a hidden id behaves like a missing one\n');

type SNode = { supersededBy?: string | null; supersededAt?: string | null } | null;
const sup = async (r: Rig, id: string): Promise<SNode> => (await r.graph.getNode(id)) as SNode;
const supersedesEdges = async (r: Rig): Promise<number> =>
    (await r.graph.queryEdges({ limit: 1000, offset: 0 } as never)).filter((e: { relation?: string }) => e.relation === 'supersedes').length;
/** A rig WITHOUT the hid node: what the hidden target would look like if it did not exist. */
async function rigWithout(id: string): Promise<Rig> {
    const r = await rig(); await seedNodes(r);
    await r.graph.deleteNode(id);
    return r;
}
const bulkSup = (r: Rig, target: string, extra: Record<string, unknown> = {}, type = 'note', deps: Record<string, unknown> = {}) =>
    bulk(r, '/api/nodes/bulk', { nodes: [{ id: 'fresh1', type, label: 'F1', content: 'c', supersedes: [target], ...extra }] }, deps);

await test('bulk: bound + supersedes:[hidden] answers deep-equal to supersedes:[missing] (no normalisation); hidden node, edges and outbox untouched', async () => {
    const a = await rig(); await seedNodes(a);
    const b = await rigWithout('hid');
    const hid = await bound(['x'], () => bulkSup(a, 'hid'));
    const mis = await bound(['x'], () => bulkSup(b, 'hid'));
    assert.deepEqual(hid, mis);
    assert.equal((hid.body.results as BulkItem[])[0]!.ok, false);
    const h = await sup(a, 'hid');
    assert.ok(!h!.supersededBy && !h!.supersededAt, 'hidden node not superseded');
    assert.equal(await supersedesEdges(a), 0);
    assert.equal(await outboxCount(a), 0, 'no outbox row for the refused item');
    assert.equal(await a.graph.getNode('fresh1'), null, 'nothing written');
});

await test('bulk: bound + visible supersedes target still supersedes; edge + outbox written', async () => {
    const r = await rig(); await seedNodes(r);
    const out = await bound(['x'], () => bulkSup(r, 'vis'));
    assert.equal((out.body.results as BulkItem[])[0]!.ok, true, JSON.stringify(out.body));
    assert.equal((await sup(r, 'vis'))!.supersededBy, 'fresh1');
    assert.equal(await supersedesEdges(r), 1);
});

await test('bulk: unbound + hidden supersedes target still supersedes (unchanged behaviour)', async () => {
    const r = await rig(); await seedNodes(r);
    const out = await bulkSup(r, 'hid');
    assert.equal((out.body.results as BulkItem[])[0]!.ok, true, JSON.stringify(out.body));
    assert.equal((await sup(r, 'hid'))!.supersededBy, 'fresh1');
    assert.equal(await supersedesEdges(r), 1);
});

await test('bulk: unbound makes no visibility lookups for supersedes (verbatim store never read)', async () => {
    const r = await rig(); await seedNodes(r);
    let reads = 0;
    const counting = { ...verbatimOf(r), async getById(id: string) { reads++; return r.verbatimRows.get(id) ?? null; } };
    await bulk(r, '/api/nodes/bulk', { nodes: [{ id: 'fresh1', type: 'note', label: 'F1', content: 'c', supersedes: ['hid'] }] }, { store: { loreGraph: r.graph, loreVerbatim: counting } });
    assert.equal(reads, 0);
});

await test('bulk: a hidden near-duplicate hit is not echoed as unlisted_near_duplicate (same response as no hit)', async () => {
    const mk = async (withHidden: boolean) => {
        const r = withHidden ? await rig() : await rigWithout('hid');
        if (withHidden) await seedNodes(r);
        // hid must be a live decision for the hit to qualify as a duplicate.
        if (withHidden) await r.graph.upsertNode(node('hid', ['y']) as never);
        return r;
    };
    const dupDeps = (r: Rig) => ({
        supersessionEnforceDefault: true,
        store: { loreGraph: r.graph, loreVerbatim: verbatimOf(r), storageClient: { verbatimSearch: async () => [{ id: 'lore:hid', score: 0.95 }] } },
    });
    const a = await mk(true); const b = await mk(false);
    // make hid a decision so it is in the enforced family
    await a.graph.upsertNode({ ...(node('hid', ['y']) as object), type: 'decision' } as never);
    const sans = async (r: Rig) => bound(['x'], () => bulk(r, '/api/nodes/bulk', { nodes: [{ id: 'fresh1', type: 'decision', label: 'F1', content: 'c', supersedes: [] }] }, dupDeps(r)));
    const hidden = await sans(a);
    const missing = await sans(b);
    assert.deepEqual(hidden, missing);
    assert.doesNotMatch(JSON.stringify(hidden.body), /unlisted_near_duplicate/);
    // control: unbound sees the near-duplicate for the same setup (the hook is what hides it)
    const unb = await bulk(a, '/api/nodes/bulk', { nodes: [{ id: 'fresh2', type: 'decision', label: 'F2', content: 'c', supersedes: [] }] }, dupDeps(a));
    assert.match(JSON.stringify(unb.body), /unlisted_near_duplicate/);
});

await test('applyWriteTimeSupersedes (defence in depth): an id the hook rejects is reported unapplied like a missing one — no mutation, no edge, no outbox row', async () => {
    const r = await rig(); await seedNodes(r);
    await r.graph.upsertNode(node('newer') as never);
    const out = await applyWriteTimeSupersedes({
        targetGraph: r.graph as never, supersedes: ['hid', 'vis'], newId: 'newer', workspace: WS, initiator: 'test',
        outboxStore: r.outbox, logPrefix: '[t]', isVisible: async (id) => id !== 'hid',
    });
    assert.equal(out.ok, false);
    assert.deepEqual(out.ok === false && 'unapplied' in out ? out.unapplied : undefined, [{ id: 'hid', reason: 'old-not-found' }], 'same as the engine answers for a missing id');
    assert.ok(!(await sup(r, 'hid'))!.supersededBy, 'hidden untouched');
    assert.equal((await sup(r, 'vis'))!.supersededBy, 'newer');
    assert.equal(await supersedesEdges(r), 1);
    assert.equal(await outboxCount(r), 1, 'only the visible id wrote an outbox row');
});

function supImport(r: Rig, target: string, mode: 'upsert' | 'append' = 'upsert', extraDeps: Record<string, unknown> = {}, entityType = 'Item') {
    const deps = { store: { loreGraph: r.graph, loreVerbatim: verbatimOf(r) }, detectedScope: { workspace: WS, ecosystem: '*' }, deploymentMode: 'local', dataplane: null, auditLog: { log: () => undefined }, ...extraDeps } as unknown as Parameters<typeof runImport>[0];
    const csv = Buffer.from(`Id,Name,Sup\n9,Nine,${target}\n`, 'utf-8');
    const body = { format: 'csv', filename: 't.csv', data: '', mode, mapping: { entityType, idColumn: 'Id', fields: { Name: 'label', Sup: 'supersedes' } } } as unknown as Parameters<typeof runImport>[2];
    return runImport(deps, csv, body, r.graph as never, WS);
}

await test('import: bound + supersedes:[hidden] answers deep-equal to supersedes:[missing]; hidden node and edges untouched', async () => {
    const a = await rig(); await seedNodes(a);
    const b = await rigWithout('hid');
    const hid = await bound(['x'], () => supImport(a, 'hid'));
    const mis = await bound(['x'], () => supImport(b, 'hid'));
    assert.deepEqual(hid, mis);
    assert.equal(hid.imported, 0);
    assert.ok(!(await sup(a, 'hid'))!.supersededBy);
    assert.equal(await supersedesEdges(a), 0);
    assert.equal(await a.graph.getNode('Item:9'), null, 'row not written');
});

await test('import: bound + visible target still supersedes; unbound + hidden target still supersedes', async () => {
    const a = await rig(); await seedNodes(a);
    const out = await bound(['x'], () => supImport(a, 'vis'));
    assert.equal(out.imported, 1, JSON.stringify(out));
    assert.equal((await sup(a, 'vis'))!.supersededBy, 'Item:9');
    const u = await rig(); await seedNodes(u);
    const outU = await supImport(u, 'hid');
    assert.equal(outU.imported, 1, JSON.stringify(outU));
    assert.equal((await sup(u, 'hid'))!.supersededBy, 'Item:9');
});

await test('import: a hidden near-duplicate hit is not echoed (same response as no hit); unbound control sees it', async () => {
    const a = await rig(); await seedNodes(a);
    await a.graph.upsertNode({ ...(node('hid', ['y']) as object), type: 'decision' } as never);
    const b = await rigWithout('hid');
    const deps = (r: Rig) => ({ supersessionEnforceDefault: true, store: { loreGraph: r.graph, loreVerbatim: verbatimOf(r), storageClient: { verbatimSearch: async () => [{ id: 'lore:hid', score: 0.95 }] } } });
    // no `Sup` value: the row would need to list the duplicate, which only a visible one may be told about
    const run = (r: Rig) => bound(['x'], () => supImport(r, '', 'upsert', deps(r), 'decision'));
    const hidden = await run(a);
    const missing = await run(b);
    assert.deepEqual(hidden, missing);
    assert.doesNotMatch(JSON.stringify(hidden), /unlisted_near_duplicate/);
    const unb = await supImport(a, '', 'upsert', deps(a), 'decision');
    assert.match(JSON.stringify(unb), /unlisted_near_duplicate/);
});

/* ========================= 8. Arcade/cloud upsertOne: no scope reset ========================= */
console.log('\nbulk upsertOne (graph without bulkUpsertNodes — Arcade/cloud)\n');

async function arcadeShapedWrite(returned: Record<string, unknown> | null) {
    const verbatimWrites: Array<{ id: string; metadata: Record<string, unknown> }> = [];
    const stored = new Map<string, Record<string, unknown>>();
    // No bulkListProjected / queryEdges => isWorkspaceGraph() is false => the route takes upsertOne.
    const graph = {
        async upsertNode(n: Record<string, unknown>) { stored.set(String(n.id), n); return rowToLoreNode({ ...n, ...(returned ?? {}) }) as never; },
        async deleteNode() { /* no-op */ },
        async getNode(id: string) { return stored.get(id) ?? null; },
        getGraphContext() { return {}; },
    };
    const verbatim = { async store(d: { id: string; metadata: Record<string, unknown> }) { verbatimWrites.push(d); }, async getById() { return null; } };
    const res = fakeRes();
    await tryBulkWriteRoutes(postReq(JSON.stringify({ workspace: WS, embed: 'inline', nodes: [{ id: 'cn1', type: 'note', label: 'L', content: 'c' }] })), res, '/api/nodes/bulk', '/api/nodes/bulk', {
        store: { loreGraph: graph, loreVerbatim: verbatim, storageClient: { async upsertNode(n: never) { return graph.upsertNode(n); }, async verbatimStore(d: never) { verbatimWrites.push(d); }, rawGraph: () => graph } } as never,
        auditLog: { log: () => undefined } as never, deploymentMode: 'local', dataplane: null,
        outboxStore: { async record() {}, async batchRecord() {}, async markStep() {}, async markCompleted() {}, async remove() {}, async listUnfinished() { return []; } },
    } as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { res, verbatimWrites };
}

await test('upsertOne (Arcade shape): graph reports no scopes => the verbatim write omits security_scopes (existing canonical scopes are kept, not reset to [])', async () => {
    const { res, verbatimWrites } = await arcadeShapedWrite(null);
    assert.equal(res._status, 200, res._body);
    assert.equal(verbatimWrites.length, 1);
    assert.equal('security_scopes' in verbatimWrites[0]!.metadata, false, JSON.stringify(verbatimWrites[0]));
});

await test('upsertOne: a graph that really reports scopes still has them mirrored onto the verbatim row', async () => {
    const { res, verbatimWrites } = await arcadeShapedWrite({ security_scopes: ['finance'] });
    assert.equal(res._status, 200, res._body);
    assert.deepEqual(verbatimWrites[0]!.metadata.security_scopes, ['finance']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
