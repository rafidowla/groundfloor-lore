#!/usr/bin/env tsx
/**
 * test/direct-read-scopes-history-unit.ts
 *
 * Row-level security_scopes on the direct-read and history paths the
 * 2026-08-17 remediation missed:
 *   1. GET /api/verbatim/get          + MCP get_verbatim
 *   2. GET /api/verbatim/history
 *   3. GET /api/nodes/:id/history     + MCP node_history
 *   4. GET /api/workspaces/:name/diff + MCP diff_workspace
 *
 * Real verbatim stores (Lance AND SQLite), a real VersionStore, a Map-backed
 * graph. For each path: hidden item == missing item (no existence oracle);
 * allowed actor sees full content and the FULL history; unbound actor is
 * unchanged; public item visible to a scope-less bound actor. Deleted nodes
 * resolve their labels via the version log; a damaged ('undefined') canonical
 * row with no graph node and no version rows is hidden from bound actors.
 *
 * Run: npx tsx test/direct-read-scopes-history-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-drsh-home-'));
process.env['LORE_HOME'] = HOME;
process.env['LORE_MODEL_SERVER'] = '0';
delete process.env['LORE_SEARCH_WORKER'];

const { createWorkspace, loadWorkspaces } = await import('../packages/lore/src/config/workspaces.js');
const { VerbatimStore } = await import('../packages/lore/src/engines/verbatimStore.js');
const { SqliteVerbatimStore } = await import('../packages/lore/src/engines/sqliteVerbatimStore.js');
const { VersionStore } = await import('../packages/lore/src/outbox/versionStore.js');
const { tryRetentionRoutes } = await import('../packages/lore/src/mcp/http/routes/retention.js');
const { tryVersioningRoutes } = await import('../packages/lore/src/mcp/http/routes/versioning.js');
const { registerVerbatimTools } = await import('../packages/lore/src/mcp/tools/verbatim.js');
const { registerVersioningTools } = await import('../packages/lore/src/mcp/tools/versioning.js');
const { runWithActor } = await import('../packages/lore/src/security/actorContext.js');
const { runWithPrincipal } = await import('../packages/lore/src/auth/principal.js');
const { resolveItemScopes, isDamagedScopes, baseNodeId } = await import('../packages/lore/src/security/itemScopes.js');
type Principal = import('../packages/lore/src/auth/principal.js').Principal;
type EmbeddingProvider = import('../packages/lore/src/providers/types.js').EmbeddingProvider;

const WS = 'drsh-ws';
const PRINCIPAL: Principal = { kind: 'app', workspace: WS, scopes: ['read'], label: 'app-read' };

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'drsh-det';
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

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

function fakeReq(url: string): IncomingMessage {
    return { method: 'GET', url, on: () => undefined } as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(s: number) { (this as { _status: number })._status = s; return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

interface Out { status: number; body: string }
type Actor = 'unbound' | string[];
function asActor<T>(actor: Actor, fn: () => Promise<T>): Promise<T> {
    return runWithPrincipal(PRINCIPAL, () =>
        actor === 'unbound' ? fn() : runWithActor({ portalUserId: 'u', scopes: actor }, fn));
}

const TS = (n: number): string => `2026-10-0${n}T00:00:00.000Z`;
const META = (scopes: string[], n = 1) => ({ type: 'note', label: 'l', tags: '', project: WS, ecosystem: '*', updatedAt: TS(n), security_scopes: scopes });

async function run(engine: 'lance' | 'sqlite'): Promise<void> {
    console.log(`\n=== engine: ${engine} ===`);
    loadWorkspaces(HOME);
    const entry = createWorkspace(`${WS}-${engine}`, {}, HOME);
    const provider = new DetEmbedProvider();
    const verbatim = engine === 'lance' ? new VerbatimStore(entry.path, provider) : new SqliteVerbatimStore(entry.path, provider);
    await verbatim.initialize();
    const versionStore = VersionStore.open(fs.mkdtempSync(path.join(os.tmpdir(), 'lore-drsh-ver-')));

    const nodes = new Map<string, Record<string, unknown>>();
    const graph = { getNode: async (id: string) => nodes.get(id) ?? null };
    const addNode = (id: string, scopes: string[]): void => { nodes.set(id, { id, type: 'note', label: id, project: WS, security_scopes: scopes, content: `body of ${id}` }); };

    // 3 revisions of a canonical verbatim row = canonical + 2 #rev snapshots.
    const writeVerbatim = async (id: string, scopes: string[]): Promise<void> => {
        for (let i = 1; i <= 3; i++) await verbatim.store({ id: `lore:${id}`, text: `${id} revision ${i} text`, metadata: META(scopes, i) });
    };
    const recordVersions = async (id: string, scopes: string[], base: number, del = false): Promise<void> => {
        for (let i = 0; i < 3; i++) {
            const state = { id, type: 'note', label: id, security_scopes: scopes, content: `${id} v${i}` };
            await versionStore.recordVersion({
                versionId: `${id}-v${i}`, nodeId: id, workspace: WS, timestamp: TS(base + i), principal: 'mcp',
                operation: 'upsert', previousState: i === 0 ? null : { ...state, content: `${id} v${i - 1}` }, newState: state, changesetId: null,
            });
        }
        if (del) {
            await versionStore.recordVersion({
                versionId: `${id}-del`, nodeId: id, workspace: WS, timestamp: TS(base + 3), principal: 'mcp',
                operation: 'delete', previousState: { id, type: 'note', label: id, security_scopes: scopes, content: `${id} v2` }, newState: null, changesetId: null,
            });
        }
    };

    // pub: public graph node. sec: finance graph node. del: finance node, DELETED (versions only).
    addNode('pub', []); await writeVerbatim('pub', []); await recordVersions('pub', [], 1);
    addNode('sec', ['finance']); await writeVerbatim('sec', ['finance']); await recordVersions('sec', ['finance'], 1);
    await writeVerbatim('del', ['finance']); await recordVersions('del', ['finance'], 1, true);
    // verbatim-only rows (no graph node, no version rows).
    await writeVerbatim('vo', ['hr']);
    await writeVerbatim('vopub', []);
    // graph node public but the verbatim row's own scopes are 'hr' -> deny if EITHER denies.
    addNode('rowhr', []); await writeVerbatim('rowhr', ['hr']);
    // graph node scoped, verbatim row public -> item scopes deny.
    addNode('graphfin', ['finance']); await writeVerbatim('graphfin', []);
    // damaged pre-3.28 canonical row: scopes ['undefined'], no graph node, no versions.
    await verbatim.store({ id: 'lore:dmg', text: 'dmg text', metadata: META(['undefined']) });
    assert.ok(isDamagedScopes((await verbatim.getById('lore:dmg'))?.security_scopes), 'fixture: damaged row stored');

    const store = { loreVerbatim: verbatim, loreGraph: graph };
    const retentionDeps = {
        deploymentMode: 'local', dataplane: null, store, versionStore,
        auditLog: { log: () => undefined }, runRetentionSweep: async () => ({}),
        detectedScope: { workspace: WS, ecosystem: '*' },
    } as unknown as Parameters<typeof tryRetentionRoutes>[4];
    const versioningDeps = { versionStore, store, deploymentMode: 'local', dataplane: null } as unknown as Parameters<typeof tryVersioningRoutes>[4];

    // MCP harness
    const tools = new Map<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    const fake = { tool: (n: string, _d: string, _s: unknown, h: never) => { tools.set(n, h); } };
    registerVerbatimTools(fake as never, { store: store as never, versionStore });
    registerVersioningTools(fake as never, { versionStore, store: store as never, detectedScope: { workspace: WS, ecosystem: '*' } } as never);

    const restGet = async (actor: Actor, id: string): Promise<Out> => {
        const res = fakeRes(); const u = `/api/verbatim/get?id=${encodeURIComponent(id)}`;
        await asActor(actor, () => tryRetentionRoutes(fakeReq(u), res, u, '/api/verbatim/get', retentionDeps));
        return { status: res._status, body: res._body };
    };
    const restVerbHistory = async (actor: Actor, id: string): Promise<Out> => {
        const res = fakeRes(); const u = `/api/verbatim/history?id=${encodeURIComponent(id)}`;
        await asActor(actor, () => tryRetentionRoutes(fakeReq(u), res, u, '/api/verbatim/history', retentionDeps));
        return { status: res._status, body: res._body };
    };
    const restNodeHistory = async (actor: Actor, id: string): Promise<Out> => {
        const res = fakeRes(); const p = `/api/nodes/${encodeURIComponent(id)}/history`; const u = `${p}?workspace=${WS}`;
        await asActor(actor, () => tryVersioningRoutes(fakeReq(u), res, u, p, versioningDeps));
        return { status: res._status, body: res._body };
    };
    const restDiff = async (actor: Actor): Promise<Out> => {
        const res = fakeRes(); const p = `/api/workspaces/${WS}/diff`; const u = `${p}?since=2000-01-01T00:00:00.000Z`;
        await asActor(actor, () => tryVersioningRoutes(fakeReq(u), res, u, p, versioningDeps));
        return { status: res._status, body: res._body };
    };
    const mcp = async (actor: Actor, tool: string, args: Record<string, unknown>): Promise<Out> => {
        const r = await asActor(actor, () => tools.get(tool)!(args));
        return { status: r.isError ? 500 : 200, body: r.content[0]!.text };
    };
    const norm = (o: Out, id: string): Out => ({ status: o.status, body: o.body.split(id).join('<ID>') });
    const sales = ['sales'], finance = ['finance'], none: string[] = [];

    // ---- 1. verbatim get (REST + MCP) ----
    await test('verbatim get REST: scoped item + actor lacking scope == missing id; with scope full; unbound unchanged; public visible to scope-less', async () => {
        const missing = norm(await restGet(sales, 'lore:ghost'), 'lore:ghost');
        assert.equal(missing.status, 404);
        for (const id of ['lore:sec', 'lore:del', 'lore:vo', 'lore:rowhr', 'lore:graphfin']) {
            assert.deepEqual(norm(await restGet(sales, id), id), missing, `${id} hidden from sales exactly like a missing id`);
        }
        const ok = await restGet(finance, 'lore:sec');
        assert.equal(ok.status, 200); assert.match(JSON.parse(ok.body).text as string, /sec revision 3/);
        assert.equal((await restGet(finance, 'lore:del')).status, 200, 'deleted node: allowed via version log');
        assert.equal((await restGet(['hr'], 'lore:vo')).status, 200, 'verbatim-only row uses its own scopes');
        assert.equal((await restGet(['hr'], 'lore:rowhr')).status, 200);
        assert.equal((await restGet(finance, 'lore:rowhr')).status, 404, 'row own scopes also deny');
        assert.equal((await restGet(['hr'], 'lore:graphfin')).status, 404, 'graph scopes deny even though the row is public');
        for (const id of ['lore:sec', 'lore:del', 'lore:vo', 'lore:dmg']) assert.equal((await restGet('unbound', id)).status, 200, `${id} unbound unchanged`);
        assert.equal((await restGet(none, 'lore:pub')).status, 200, 'public visible to scope-less bound actor');
        assert.equal((await restGet(none, 'lore:vopub')).status, 200);
        assert.equal((await restGet(none, 'lore:sec')).status, 404, 'scope-less actor does not see scoped rows');
    });

    await test('verbatim get MCP: same matrix', async () => {
        const g = (actor: Actor, id: string) => mcp(actor, 'get_verbatim', { id, workspace: WS });
        const missing = norm(await g(sales, 'lore:ghost'), 'lore:ghost');
        assert.equal(JSON.parse(missing.body).row, null);
        for (const id of ['lore:sec', 'lore:del', 'lore:vo', 'lore:rowhr', 'lore:graphfin']) {
            assert.deepEqual(norm(await g(sales, id), id), missing, `${id} hidden`);
        }
        assert.match(JSON.parse((await g(finance, 'lore:sec')).body).row.text, /sec revision 3/);
        assert.ok(JSON.parse((await g(finance, 'lore:del')).body).row);
        assert.ok(JSON.parse((await g(['hr'], 'lore:vo')).body).row);
        assert.equal(JSON.parse((await g(finance, 'lore:rowhr')).body).row, null);
        assert.ok(JSON.parse((await g('unbound', 'lore:sec')).body).row, 'unbound unchanged');
        assert.ok(JSON.parse((await g('unbound', 'lore:dmg')).body).row);
        assert.ok(JSON.parse((await g(none, 'lore:pub')).body).row, 'public visible');
    });

    await test('damaged tombstone canonical (no graph node, no versions): hidden from bound actors, visible unbound; resolves unknown', async () => {
        for (const a of [sales, finance, none]) {
            assert.equal((await restGet(a, 'lore:dmg')).status, 404);
            assert.equal(JSON.parse((await mcp(a, 'get_verbatim', { id: 'lore:dmg', workspace: WS })).body).row, null);
            assert.equal(JSON.parse((await restVerbHistory(a, 'lore:dmg')).body).count, 0);
        }
        assert.equal((await restGet('unbound', 'lore:dmg')).status, 200);
        assert.ok(JSON.parse((await restVerbHistory('unbound', 'lore:dmg')).body).count >= 1);
        const r = await resolveItemScopes('lore:dmg', { workspace: WS, getGraphNode: async () => null, versionStore, getVerbatimRow: (id) => verbatim.getById(id) });
        assert.deepEqual(r, { unknown: true });
        assert.deepEqual(await resolveItemScopes('lore:vo', { workspace: WS, getGraphNode: async () => null, versionStore, getVerbatimRow: (id) => verbatim.getById(id) }), { scopes: ['hr'] });
        assert.equal(baseNodeId('lore:abc#rev2026-10-01T00:00:00.000Z'), 'abc');
    });

    // ---- 2. verbatim history ----
    await test('verbatim history REST: hidden == missing; allowed sees FULL history (revision count unchanged); unbound/public', async () => {
        const missing = norm(await restVerbHistory(sales, 'lore:ghost'), 'lore:ghost');
        assert.equal(JSON.parse(missing.body).count, 0);
        for (const id of ['lore:sec', 'lore:del', 'lore:vo', 'lore:rowhr', 'lore:graphfin']) {
            assert.deepEqual(norm(await restVerbHistory(sales, id), id), missing, `${id} history hidden`);
        }
        const full = JSON.parse((await restVerbHistory('unbound', 'lore:sec')).body) as { count: number };
        assert.equal(full.count, 3, 'canonical + 2 #rev snapshots');
        assert.equal(JSON.parse((await restVerbHistory(finance, 'lore:sec')).body).count, full.count, 'allowed actor: every revision');
        assert.equal(JSON.parse((await restVerbHistory(finance, 'lore:del')).body).count, 3);
        assert.equal(JSON.parse((await restVerbHistory(['hr'], 'lore:vo')).body).count, 3);
        assert.equal(JSON.parse((await restVerbHistory(none, 'lore:pub')).body).count, 3, 'public visible to scope-less actor');
        assert.equal(JSON.parse((await restVerbHistory('unbound', 'lore:del')).body).count, 3);
        // history rows themselves are untouched by reads
        assert.equal((await verbatim.getHistory('lore:sec')).length, 3);
    });

    // ---- 3. node history (REST + MCP) ----
    await test('node history REST + MCP: hidden == missing; allowed full (3 / 4 for deleted); deleted via version log; unbound; public', async () => {
        const rMissing = norm(await restNodeHistory(sales, 'ghost'), 'ghost');
        assert.equal(JSON.parse(rMissing.body).count, 0);
        const mMissing = norm(await mcp(sales, 'node_history', { node_id: 'ghost', workspace: WS }), 'ghost');
        for (const id of ['sec', 'del']) {
            assert.deepEqual(norm(await restNodeHistory(sales, id), id), rMissing, `REST ${id} hidden`);
            assert.deepEqual(norm(await mcp(sales, 'node_history', { node_id: id, workspace: WS }), id), mMissing, `MCP ${id} hidden`);
        }
        assert.equal(JSON.parse((await restNodeHistory(finance, 'sec')).body).count, 3);
        assert.equal(JSON.parse((await restNodeHistory(finance, 'del')).body).count, 4, 'deleted node history (incl. delete row) via version log');
        assert.equal(JSON.parse((await mcp(finance, 'node_history', { node_id: 'del', workspace: WS })).body).count, 4);
        assert.equal(JSON.parse((await mcp(finance, 'node_history', { node_id: 'sec', workspace: WS })).body).versions.length, 3);
        assert.equal(JSON.parse((await restNodeHistory('unbound', 'sec')).body).count, 3);
        assert.equal(JSON.parse((await mcp('unbound', 'node_history', { node_id: 'del', workspace: WS })).body).count, 4);
        assert.equal(JSON.parse((await restNodeHistory(none, 'pub')).body).count, 3, 'public visible to scope-less actor');
        assert.equal(JSON.parse((await mcp(none, 'node_history', { node_id: 'pub', workspace: WS })).body).count, 3);
        assert.equal(JSON.parse((await restNodeHistory(none, 'sec')).body).count, 0);
    });

    // ---- 4. workspace diff (REST + MCP) ----
    await test('workspace diff REST + MCP: drops hidden nodes only; allowed/unbound see everything', async () => {
        const nodeIds = (o: Out): string[] => [...new Set((JSON.parse(o.body) as { changes: Array<{ nodeId: string }> }).changes.map((c) => c.nodeId))].sort();
        const total = (o: Out): number => (JSON.parse(o.body) as { total: number }).total;
        const full = await restDiff('unbound');
        assert.deepEqual(nodeIds(full), ['del', 'pub', 'sec']);
        assert.equal(total(full), 10);
        const forSales = await restDiff(sales);
        assert.deepEqual(nodeIds(forSales), ['pub']);
        assert.equal(total(forSales), 3, 'counts reflect only visible rows');
        assert.equal(forSales.status, 200, 'whole response is not failed');
        assert.deepEqual(nodeIds(await restDiff(finance)), ['del', 'pub', 'sec']);
        assert.equal(total(await restDiff(finance)), 10, 'allowed actor sees every revision');
        assert.deepEqual(nodeIds(await restDiff(none)), ['pub']);
        const mArgs = { workspace: WS, since: '2000-01-01T00:00:00.000Z' };
        assert.deepEqual(nodeIds(await mcp(sales, 'diff_workspace', mArgs)), ['pub']);
        assert.deepEqual(nodeIds(await mcp(finance, 'diff_workspace', mArgs)), ['del', 'pub', 'sec']);
        assert.deepEqual(nodeIds(await mcp('unbound', 'diff_workspace', mArgs)), ['del', 'pub', 'sec']);
        assert.equal(total(await mcp('unbound', 'diff_workspace', mArgs)), 10);
        assert.equal((versionStore.getDiff(WS, '2000-01-01T00:00:00.000Z')).length, 10, 'store itself is unfiltered');
    });

    await verbatim.close();
}

console.log('direct-read + history security_scopes');
await run('lance');
await run('sqlite');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
