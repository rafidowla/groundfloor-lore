#!/usr/bin/env tsx
/**
 * test/scopes-export-arcade-unit.ts
 *
 * Two row-level security_scopes fixes on top of the direct-read gate:
 *
 *   A. Whole-workspace exports are admin-only for BOUND actors.
 *      GET /api/workspaces/:name/export (NDJSON bundle) and GET /api/export/html
 *      are not row-filtered, so a bound actor is refused with 403 `export_forbidden`
 *      unless the request principal is a daemon operator (bootstrap / shared-secret
 *      — the kinds bindDaemonOperatorLane treats as operators). Unbound callers are
 *      unchanged. The MCP twin `export_snapshot` is already row-filtered and is
 *      untouched.
 *
 *   B. Arcade verbatim getById returns `security_scopes` (string[]), read from the
 *      stored comma-joined column. Before the fix a verbatim-only Arcade document
 *      resolved to `unknown` in resolveItemScopes and was hidden from EVERY bound
 *      actor (functional regression in cloud mode).
 *
 * Arcade: REAL ArcadeVectorStore + ScopedArcadeVectorHandle; only the HTTP
 * transport is faked (ArcadeHttp.prototype.query/command patched to an in-memory
 * table that honours the SELECTed column list, so a SELECT that omits
 * security_scopes really returns no scopes). No ArcadeDB container needed.
 *
 * Run: npx tsx test/scopes-export-arcade-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sea-home-'));
process.env['LORE_HOME'] = HOME;
process.env['LORE_MODEL_SERVER'] = '0';
delete process.env['LORE_SEARCH_WORKER'];

const { ArcadeHttp } = await import('../packages/lore/src/engines/arcade/arcadeHttp.js');
const { ArcadeVectorStore } = await import('../packages/lore/src/engines/arcade/arcadeVectorStore.js');
const { resolveStoredScopes } = await import('../packages/lore/src/engines/arcade/arcadeVectorStore.js');
const { ScopedArcadeVectorHandle } = await import('../packages/lore/src/engines/arcade/arcadeScopedHandle.js');
const { tryRetentionRoutes } = await import('../packages/lore/src/mcp/http/routes/retention.js');
const { tryWorkspaceExportRoutes } = await import('../packages/lore/src/mcp/http/routes/workspaceExport.js');
const { tryStaticRoutes } = await import('../packages/lore/src/mcp/http/routes/static.js');
const { registerVerbatimTools } = await import('../packages/lore/src/mcp/tools/verbatim.js');
const { runWithActor } = await import('../packages/lore/src/security/actorContext.js');
const { runWithPrincipal } = await import('../packages/lore/src/auth/principal.js');
const { exportAllowedForCurrentActor } = await import('../packages/lore/src/security/exportGate.js');
type Principal = import('../packages/lore/src/auth/principal.js').Principal;
type EmbeddingProvider = import('../packages/lore/src/providers/types.js').EmbeddingProvider;

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

function fakeReq(url: string): IncomingMessage {
    return { method: 'GET', url, on: () => undefined } as unknown as IncomingMessage;
}
interface FakeRes { _status: number; _body: string; _headers: Record<string, unknown> }
function fakeRes(): ServerResponse & FakeRes {
    const r = {
        _status: 0, _body: '', _headers: {} as Record<string, unknown>,
        writeHead(s: number, h?: Record<string, unknown>) { (this as FakeRes)._status = s; (this as FakeRes)._headers = h ?? {}; return this; },
        write(b: string) { (this as FakeRes)._body += b; return true; },
        end(b?: string) { (this as FakeRes)._body += b ?? ''; },
    };
    return r as unknown as ServerResponse & FakeRes;
}
interface Out { status: number; body: string }

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'sea-det';
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

// ── fake ArcadeDB transport (honours the SELECTed column list) ──────────────
const table = new Map<string, Record<string, unknown>>();
const origQuery = ArcadeHttp.prototype.query;
const origCommand = ArcadeHttp.prototype.command;
ArcadeHttp.prototype.query = async function (_db: string, sql: string, params: Record<string, unknown> = {}) {
    const m = /^SELECT\s+(.+?)\s+FROM\s+LoreVerbatim\s+WHERE\s+id\s*=\s*:id/is.exec(sql.trim());
    if (!m) return { result: [] };
    const row = table.get(String(params['id']));
    if (!row) return { result: [] };
    const cols = m[1]!.split(',').map((c) => c.replace(/`/g, '').trim());
    const out: Record<string, unknown> = {};
    for (const c of cols) if (c in row) out[c] = row[c];
    return { result: [out] };
};
ArcadeHttp.prototype.command = async function (_db: string, sql: string, params: Record<string, unknown> = {}) {
    if (/UPSERT\s+WHERE\s+id/i.test(sql)) table.set(String(params['id']), { ...params });
    return { result: [] };
};

// ── principals / actors ─────────────────────────────────────────────────────
const WS = 'sea-ws';
const mk = (kind: Principal['kind']): Principal => ({ kind, workspace: WS, scopes: ['read', 'write', 'cross-workspace-read', 'cross-workspace-write'], label: kind });
type Actor = 'unbound' | string[];
function as<T>(actor: Actor, principal: Principal | null, fn: () => Promise<T>): Promise<T> {
    const inner = (): Promise<T> => (actor === 'unbound' ? fn() : runWithActor({ portalUserId: 'u', scopes: actor }, fn));
    return principal ? runWithPrincipal(principal, inner) : inner();
}
const APP: Principal = { kind: 'app', workspace: WS, scopes: ['read'], label: 'app-read' };
const sales = ['sales'], finance = ['finance'], none: string[] = [];

// ════════════════════════════════════════════════════════════════════════════
// B. Arcade getById scopes
// ════════════════════════════════════════════════════════════════════════════
console.log('arcade verbatim getById security_scopes');
{
    const vector = new ArcadeVectorStore({ tenantDb: 'db_sea', http: new ArcadeHttp({ user: 'u', pass: 'p' }), embedder: new DetEmbedProvider() });
    const scoped = new ScopedArcadeVectorHandle(vector as never, ['read']);
    const ts = '2026-10-06T00:00:00.000Z';
    const put = (id: string, scopes: string[]): Promise<void> =>
        vector.store({ id, text: `${id} text`, metadata: { type: 'note', label: id, tags: '', project: WS, ecosystem: '*', updatedAt: ts, security_scopes: scopes } });
    await put('lore:vopub', []);            // verbatim-only, public
    await put('lore:vofin', ['finance']);   // verbatim-only, finance
    await put('lore:vomulti', ['a', 'b']);
    await put('lore:pubn', []);             // graph node public
    await put('lore:finn', []);             // graph node finance, verbatim row public (graph wins)

    const nodes = new Map<string, Record<string, unknown>>([
        ['pubn', { id: 'pubn', security_scopes: [] }],
        ['finn', { id: 'finn', security_scopes: ['finance'] }],
    ]);
    const store = { loreVerbatim: scoped, loreGraph: { getNode: async (id: string) => nodes.get(id) ?? null } };
    const retentionDeps = {
        deploymentMode: 'local', dataplane: null, // gateRoute is a no-op here; the store under test is the real Arcade one
        store, versionStore: undefined,
        auditLog: { log: () => undefined }, runRetentionSweep: async () => ({}),
        detectedScope: { workspace: WS, ecosystem: '*' },
    } as unknown as Parameters<typeof tryRetentionRoutes>[4];
    const tools = new Map<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    registerVerbatimTools({ tool: (n: string, _d: string, _s: unknown, h: never) => { tools.set(n, h); } } as never, { store: store as never });

    const restGet = async (actor: Actor, id: string): Promise<Out> => {
        const res = fakeRes(); const u = `/api/verbatim/get?id=${encodeURIComponent(id)}`;
        await as(actor, mk('app'), () => tryRetentionRoutes(fakeReq(u), res, u, '/api/verbatim/get', retentionDeps));
        return { status: res._status, body: res._body };
    };
    const restHist = async (actor: Actor, id: string): Promise<Out> => {
        const res = fakeRes(); const u = `/api/verbatim/history?id=${encodeURIComponent(id)}`;
        await as(actor, mk('app'), () => tryRetentionRoutes(fakeReq(u), res, u, '/api/verbatim/history', retentionDeps));
        return { status: res._status, body: res._body };
    };
    const mcpGet = async (actor: Actor, id: string): Promise<unknown> => {
        const r = await as(actor, mk('app'), () => tools.get('get_verbatim')!({ id, workspace: WS }));
        return (JSON.parse(r.content[0]!.text) as { row: unknown }).row;
    };

    await test('getById returns security_scopes as string[] (public -> [], scoped, multi), like Lance/SQLite', async () => {
        assert.deepEqual((await vector.getById('lore:vopub'))?.security_scopes, []);
        assert.deepEqual((await vector.getById('lore:vofin'))?.security_scopes, ['finance']);
        assert.deepEqual((await vector.getById('lore:vomulti'))?.security_scopes, ['a', 'b']);
        assert.equal(await vector.getById('lore:ghost'), null);
        assert.deepEqual((await scoped.getById('lore:vofin'))?.security_scopes, ['finance'], 'scoped wrapper passes it through');
        assert.equal((await vector.getById('lore:vopub'))?.text, 'lore:vopub text');
    });

    await test('REST verbatim get (arcade): public verbatim-only doc visible to bound actors; finance doc only to finance; hidden == missing', async () => {
        for (const a of [sales, finance, none]) assert.equal((await restGet(a, 'lore:vopub')).status, 200, `public doc visible to ${JSON.stringify(a)}`);
        assert.equal((await restGet(finance, 'lore:vofin')).status, 200);
        const missing = await restGet(sales, 'lore:ghost');
        assert.equal(missing.status, 404);
        for (const a of [sales, none]) {
            const h = await restGet(a, 'lore:vofin');
            assert.deepEqual({ ...h, body: h.body.split('lore:vofin').join('<ID>') }, { ...missing, body: missing.body.split('lore:ghost').join('<ID>') });
        }
        assert.equal((await restGet(['a', 'b'], 'lore:vomulti')).status, 200);
        assert.equal((await restGet(['a'], 'lore:vomulti')).status, 200, 'any intersecting scope allows');
        assert.equal((await restGet(sales, 'lore:vomulti')).status, 404);
        for (const id of ['lore:vopub', 'lore:vofin']) assert.equal((await restGet('unbound', id)).status, 200, `${id} unbound unchanged`);
    });

    await test('REST verbatim get (arcade): graph-node-backed docs still resolve through the graph labels', async () => {
        assert.equal((await restGet(none, 'lore:pubn')).status, 200);
        assert.equal((await restGet(sales, 'lore:finn')).status, 404, 'graph node finance wins over a public row');
        assert.equal((await restGet(finance, 'lore:finn')).status, 200);
    });

    await test('MCP get_verbatim (arcade): same matrix', async () => {
        for (const a of [sales, finance, none]) assert.ok(await mcpGet(a, 'lore:vopub'), `public visible to ${JSON.stringify(a)}`);
        assert.ok(await mcpGet(finance, 'lore:vofin'));
        assert.equal(await mcpGet(sales, 'lore:vofin'), null);
        assert.equal(await mcpGet(none, 'lore:vofin'), null);
        assert.ok(await mcpGet('unbound', 'lore:vofin'));
    });

    await test('REST verbatim history (arcade): backend has no history -> 501 for every caller (documented limitation, not a scope leak)', async () => {
        for (const a of [sales, finance, none, 'unbound' as Actor]) assert.equal((await restHist(a, 'lore:vofin')).status, 501);
    });
}

// ════════════════════════════════════════════════════════════════════════════
// A. Export gate
// ════════════════════════════════════════════════════════════════════════════
console.log('\nworkspace export is admin-only for bound actors');
{
    const node = { id: 'n1', type: 'note', label: 'secret', content: 'finance only', project: WS, ecosystem: '*', security_scopes: ['finance'] };
    const exportDeps = {
        graphRegistry: { getGraphHandle: async () => ({ listNodes: async () => [node], queryEdges: async () => [] }) },
        verbatimResolver: { getOrOpen: async () => ({ exportRows: async () => ({ modelId: 'm', dim: 4, rows: [] }) }) },
    } as unknown as Parameters<typeof tryWorkspaceExportRoutes>[3];
    const exportPath = `/api/workspaces/${WS}/export`;
    const doExport = async (actor: Actor, principal: Principal | null): Promise<Out & { headers: Record<string, unknown> }> => {
        const res = fakeRes();
        const handled = await as(actor, principal, () => tryWorkspaceExportRoutes(fakeReq(exportPath), res, exportPath, exportDeps));
        assert.equal(handled, true);
        return { status: res._status, body: res._body, headers: res._headers };
    };
    const staticDeps = { store: { loreGraph: { getTopology: async () => ({ nodes: [{ id: 'n1', label: 'secret' }], edges: [] }) } }, deploymentMode: 'local' } as unknown as Parameters<typeof tryStaticRoutes>[4];
    const htmlUrl = `/api/export/html?workspace=${WS}`;
    const doHtml = async (actor: Actor, principal: Principal | null): Promise<Out> => {
        const res = fakeRes();
        await as(actor, principal, () => tryStaticRoutes(fakeReq(htmlUrl), res, htmlUrl, '/api/export/html', staticDeps));
        return { status: res._status, body: res._body };
    };

    await test('bound restricted actor -> 403 export_forbidden with the usual {code,message} envelope, no data written', async () => {
        for (const a of [sales, finance, none]) {
            for (const p of [APP, null]) { // workspace app token, or Clerk-style user (no principal)
                const o = await doExport(a, p);
                assert.equal(o.status, 403, `${JSON.stringify(a)}/${p?.kind ?? 'no-principal'}`);
                const body = JSON.parse(o.body) as { code: string; message: string };
                assert.equal(body.code, 'export_forbidden');
                assert.ok(body.message.length > 0);
                assert.ok(!o.body.includes('finance only') && !o.body.includes('secret'), 'no row content in the refusal');
            }
        }
    });

    await test('unbound caller is unchanged (NDJSON bundle streamed, with and without a principal)', async () => {
        for (const p of [null, APP, mk('bootstrap')]) {
            const o = await doExport('unbound', p);
            assert.equal(o.status, 200, p?.kind ?? 'no-principal');
            assert.equal(o.headers['Content-Type'], 'application/x-ndjson');
            const lines = o.body.trim().split('\n').map((l) => JSON.parse(l) as { kind: string });
            assert.equal(lines[0]!.kind, 'manifest');
            assert.ok(lines.some((l) => l.kind === 'node'));
        }
    });

    await test('daemon operator (bootstrap / shared-secret principal) with a bound actor -> allowed (operator.json local operator)', async () => {
        for (const k of ['bootstrap', 'shared-secret'] as const) {
            const o = await doExport(finance, mk(k));
            assert.equal(o.status, 200, k);
            assert.match(o.body, /"kind":"node"/);
        }
        assert.equal(exportAllowedForCurrentActor(), true, 'outside any actor: allowed');
        assert.equal(await as(sales, mk('bootstrap'), async () => exportAllowedForCurrentActor()), true);
        assert.equal(await as(sales, APP, async () => exportAllowedForCurrentActor()), false);
        assert.equal(await as(sales, null, async () => exportAllowedForCurrentActor()), false);
    });

    await test('HTML graph export twin: bound restricted -> 403; unbound and operator unchanged', async () => {
        for (const a of [sales, finance, none]) {
            const o = await doHtml(a, null);
            assert.equal(o.status, 403);
            assert.equal((JSON.parse(o.body) as { code: string }).code, 'export_forbidden');
            assert.equal((await doHtml(a, APP)).status, 403);
        }
        assert.equal((await doHtml('unbound', null)).status, 200);
        assert.equal((await doHtml('unbound', APP)).status, 200);
        assert.equal((await doHtml(finance, mk('bootstrap'))).status, 200);
    });
}

// ════════════════════════════════════════════════════════════════════════════
// C. Arcade rewrite keeps scopes (parity with Lance / SQLite)
// ════════════════════════════════════════════════════════════════════════════
console.log('\narcade verbatim rewrite scope semantics');
{
    const vector = new ArcadeVectorStore({ tenantDb: 'db_sea2', http: new ArcadeHttp({ user: 'u', pass: 'p' }), embedder: new DetEmbedProvider() });
    const ts = '2026-10-06T00:00:00.000Z';
    const meta = (scopes?: string[]) => ({ type: 'note', label: 'x', tags: '', project: WS, ecosystem: '*', updatedAt: ts, ...(scopes ? { security_scopes: scopes } : {}) });
    const stored = (id: string): unknown => table.get(id)?.['security_scopes'];

    await test('resolveStoredScopes: explicit array (incl. []) wins; absent keeps existing; new row = public; unreadable existing throws', async () => {
        assert.equal(resolveStoredScopes(['a', 'b'], 'x'), 'a,b');
        assert.equal(resolveStoredScopes([], 'x'), '');
        assert.equal(resolveStoredScopes(undefined, 'finance,sales'), 'finance,sales');
        assert.equal(resolveStoredScopes(undefined, ['finance']), 'finance');
        assert.equal(resolveStoredScopes(undefined, undefined), '');
        assert.equal(resolveStoredScopes(undefined, null), '');
        assert.throws(() => resolveStoredScopes(undefined, { weird: true }), /unreadable/);
    });

    await test('store: a rewrite WITHOUT scopes keeps the existing row scopes (not reset to public)', async () => {
        await vector.store({ id: 'lore:c1', text: 'one', metadata: meta(['finance']) });
        assert.equal(stored('lore:c1'), 'finance');
        await vector.store({ id: 'lore:c1', text: 'one changed', metadata: meta() });
        assert.equal(stored('lore:c1'), 'finance');
        assert.deepEqual((await vector.getById('lore:c1'))?.security_scopes, ['finance']);
    });

    await test('store: an explicit [] still makes the row public; an explicit array replaces', async () => {
        await vector.store({ id: 'lore:c2', text: 'two', metadata: meta(['finance']) });
        await vector.store({ id: 'lore:c2', text: 'two', metadata: meta([]) });
        assert.equal(stored('lore:c2'), '');
        await vector.store({ id: 'lore:c3', text: 'three', metadata: meta(['a']) });
        await vector.store({ id: 'lore:c3', text: 'three', metadata: meta(['b', 'c']) });
        assert.equal(stored('lore:c3'), 'b,c');
    });

    await test('store: a brand-new row without scopes is public (unchanged)', async () => {
        await vector.store({ id: 'lore:c4', text: 'four', metadata: meta() });
        assert.equal(stored('lore:c4'), '');
    });

    await test('store: an unreadable existing row aborts the write (fail closed) — the prior row is untouched', async () => {
        await vector.store({ id: 'lore:c5', text: 'five', metadata: meta(['finance']) });
        const before = table.get('lore:c5');
        const q = ArcadeHttp.prototype.query;
        ArcadeHttp.prototype.query = async () => { throw new Error('arcade down'); };
        try { await assert.rejects(() => vector.store({ id: 'lore:c5', text: 'five v2', metadata: meta() }), /arcade down/); }
        finally { ArcadeHttp.prototype.query = q; }
        assert.equal(table.get('lore:c5'), before, 'no write happened');
        // an existing value of an uninterpretable type also aborts instead of publishing
        table.set('lore:c6', { ...table.get('lore:c5')!, id: 'lore:c6', security_scopes: { weird: true } });
        await assert.rejects(() => vector.store({ id: 'lore:c6', text: 'six', metadata: meta() }), /unreadable/);
        assert.deepEqual(table.get('lore:c6')?.['security_scopes'], { weird: true });
    });

    await test('storePrebuilt (batch/migration path): same semantics — absent keeps, explicit wins, failed read aborts', async () => {
        const emb = new DetEmbedProvider().dimension;
        const vec = new Array(emb).fill(0.1);
        const row = (id: string, scopes?: string[]) => ({ id, text: id, embedding: vec, metadata: meta(scopes) });
        await vector.storePrebuilt([row('lore:p1', ['finance']), row('lore:p2', ['finance'])]);
        await vector.storePrebuilt([row('lore:p1'), row('lore:p2', []), row('lore:p3')]);
        assert.equal(stored('lore:p1'), 'finance', 'absent keeps');
        assert.equal(stored('lore:p2'), '', 'explicit [] wins');
        assert.equal(stored('lore:p3'), '', 'new row public');
        const q = ArcadeHttp.prototype.query;
        ArcadeHttp.prototype.query = async () => { throw new Error('arcade down'); };
        try { await assert.rejects(() => vector.storePrebuilt([row('lore:p1')]), /arcade down/); }
        finally { ArcadeHttp.prototype.query = q; }
        assert.equal(stored('lore:p1'), 'finance');
    });
}

ArcadeHttp.prototype.query = origQuery;
ArcadeHttp.prototype.command = origCommand;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
