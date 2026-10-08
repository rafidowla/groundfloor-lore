/**
 * test/arcade-wscope-doors.ts — case 8 of arcade-write-scopes-real-e2e.ts: every read door
 * (3.29 contract) and write door (3.30 contract) over the REAL ArcadeGraphStore +
 * ArcadeVectorStore the e2e already built. Imported only AFTER the e2e pinned LORE_HOME and the
 * ARCADE_* env, so this module has no container or env handling of its own.
 *
 * Contract per door: bound ['x'] vs a hidden node (scopes ['y']) gets exactly the missing-id
 * answer (ids normalised) and the node + its raw verbatim row are byte-identical afterwards; a
 * visible node (['x']) works; an unbound caller still works on the hidden node.
 *
 * Doors run through the real REST route handlers; store_node / delete_node / supersede_node /
 * mark_stale / store_edge / delete_edge also through the real MCP memory tools.
 *
 * NOT covered, and why:
 *   - node history rows (GET /api/nodes/:id/history): the version log is the outbox/SQLite
 *     version store, not an Arcade table, so a recording stand-in supplies the rows; only the
 *     LIVE node's visibility (decided from the Arcade vertex) is real.
 *   - changeset commit/rollback: needs the version store + a changeset log (not Arcade).
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithPrincipal } from '../packages/lore/src/auth/principal.js';
import { LoreStorageClient } from '../packages/lore/src/storage/loreStorageClient.js';
import { ID_UNAVAILABLE, ID_UNAVAILABLE_MESSAGE } from '../packages/lore/src/security/writeTargetGate.js';
import { tryNodesRoutes } from '../packages/lore/src/mcp/http/routes/nodes.js';
import { tryNodeDeleteRoute } from '../packages/lore/src/mcp/http/routes/nodes-delete.js';
import { handleSupersede, handleUnsupersede } from '../packages/lore/src/mcp/http/routes/nodes/supersede.js';
import { tryPolicyRoutes } from '../packages/lore/src/mcp/http/routes/retention/policy.js';
import { tryVerbatimRoutes } from '../packages/lore/src/mcp/http/routes/retention/verbatim.js';
import { tryEdgesRoutes } from '../packages/lore/src/mcp/http/routes/edges.js';
import { tryInspectRoutes } from '../packages/lore/src/mcp/http/routes/inspect.js';
import { tryBulkListRoutes } from '../packages/lore/src/mcp/http/routes/bulkList.js';
import { trySearchRoutes } from '../packages/lore/src/mcp/http/routes/search.js';
import { tryVersioningRoutes } from '../packages/lore/src/mcp/http/routes/versioning.js';
import { tryRecallOutcomeRoute } from '../packages/lore/src/mcp/http/routes/recallOutcome.js';
import { registerMemoryTools } from '../packages/lore/src/mcp/tools/memory.js';
import type { ArcadeGraphStore } from '../packages/lore/src/engines/arcade/arcadeGraphStore.js';
import type { ArcadeVectorStore } from '../packages/lore/src/engines/arcade/arcadeVectorStore.js';
import type { ArcadeHttp } from '../packages/lore/src/engines/arcade/arcadeHttp.js';

export interface DoorsCtx {
    graph: ArcadeGraphStore;
    vector: ArcadeVectorStore;
    http: ArcadeHttp;
    ws: string;
    test: (name: string, fn: () => Promise<void>) => Promise<void>;
    bulk: (pathname: string, body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
}

type Who = 'unbound' | 'x';
interface Out { status: number; body: string }
const X = ['x'];
const Y = ['y'];

export async function runDoors(c: DoorsCtx): Promise<void> {
    const { graph, vector, http, ws: WS, test } = c;
    const DB = 'wscope_e2e';

    /* ── harness ───────────────────────────────────────────────────────── */
    /** unbound = no actor; x = bound actor holding only ['x'] (plus an app principal for the workspace). */
    const as = <T>(who: Who, fn: () => Promise<T>): Promise<T> => who === 'unbound' ? fn()
        : runWithPrincipal({ kind: 'app', workspace: WS, scopes: ['read', 'write'], label: 't', allowedWorkspaces: [WS] } as never,
            () => runWithActor({ portalUserId: 'u-x', scopes: X }, fn));
    function req(method: string, body?: unknown): IncomingMessage {
        let consumed = false;
        const payload = body === undefined ? '' : JSON.stringify(body);
        return {
            method, headers: {},
            on(event: string, cb: (chunk?: Buffer) => void) {
                if (event === 'data' && !consumed && payload) { consumed = true; cb(Buffer.from(payload, 'utf8')); }
                if (event === 'end') setImmediate(() => cb());
                return this;
            },
        } as unknown as IncomingMessage;
    }
    function mkRes(): ServerResponse & Out {
        return {
            status: 0, body: '', statusCode: 0, headersSent: false,
            writeHead(s: number) { (this as Out).status = s; (this as { statusCode: number }).statusCode = s; return this; },
            setHeader() { return this; },
            end(b?: string) { (this as Out).body = b ?? ''; },
        } as unknown as ServerResponse & Out;
    }
    type Run = (rq: IncomingMessage, rs: ServerResponse, url: string, pathname: string) => Promise<unknown>;
    async function rest(who: Who, method: string, url: string, body: unknown, run: Run): Promise<Out> {
        const rs = mkRes();
        await as(who, () => run(req(method, body), rs, url, url.split('?')[0]!));
        return { status: rs.status, body: rs.body };
    }
    const jsonOf = (o: Out): Record<string, any> => { try { return JSON.parse(o.body); } catch { return {}; } };
    /** MCP errors pass through redactError, which hashes ids to `id#xxxxxxxx`: fold those too. */
    const norm = (s: string, id: string): string => s.split(id).join('<ID>').replace(/id#[0-9a-f]{8}/g, '<ID>');
    /** hidden-id answer must equal missing-id answer once each id is replaced by a placeholder. */
    function sameAsMissing(hidden: Out, hidId: string, missing: Out, missId: string, what: string): void {
        assert.equal(hidden.status, missing.status, `${what}: status ${hidden.body} vs ${missing.body}`);
        assert.equal(norm(hidden.body, hidId), norm(missing.body, missId), `${what}: body differs`);
    }

    const registry = { getOrOpen: async () => graph, getGraphHandle: async () => graph, activeName: () => WS };
    const storageClient = LoreStorageClient.fromLocal({ graph, verbatim: vector });
    const store = { loreGraph: graph, loreVerbatim: vector, storageClient, sessionCache: { pushNode: () => undefined } };
    const audit: Array<Record<string, unknown>> = [];
    const auditLog = { log: (e: Record<string, unknown>) => { audit.push(e); } };
    /** Stand-in version log: the SQLite/outbox store is not an Arcade table. */
    const versionRows = new Map<string, unknown[]>();
    const versionStore = {
        getVersions: async (id: string) => versionRows.get(id) ?? [],
        getEffectiveHistoryPolicy: () => ({}),
        getDiff: async () => [],
    };
    const restDeps = { store, auditLog, deploymentMode: 'local', dataplane: null, graphRegistry: registry,
        detectedScope: { workspace: WS, ecosystem: '*' }, versionStore } as never;

    const tools: Record<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>> = {};
    registerMemoryTools({ tool: (name: string, ...r: unknown[]) => { const h = r[r.length - 1]; if (typeof h === 'function') tools[name] = h as never; } } as never, {
        store, configManager: { read: () => ({ pluginConfig: {} }) }, auditLog,
        detectedScope: { workspace: WS, ecosystem: '*' }, getWal: () => ({ append: () => undefined }),
        domain: 'lore', edgeRelations: ['related_to', 'supersedes', 'depends_on'],
        nodeTypesEnum: z.enum(['decision', 'note']), nodeTypesDescription: 'decision|note',
        edgeRelationsEnum: z.enum(['related_to', 'supersedes', 'depends_on']),
        graphRegistry: registry, coreNodeTypes: ['decision', 'note'],
    } as never);
    async function mcp(who: Who, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; json: Record<string, any> }> {
        const r = await as(who, () => tools[name]!(args));
        let json: Record<string, any> = {};
        try { json = JSON.parse(r.content[0]!.text); } catch { /* non-JSON */ }
        return { text: r.content[0]!.text, isError: r.isError === true, json };
    }

    let tick = 0;
    const stamp = (): string => new Date(Date.UTC(2030, 0, 1) + (++tick) * 1000).toISOString();
    /** Seed a node the way the real write paths do: vertex + canonical lore:<id> row both carry the scopes. */
    async function seed(id: string, scopes: string[], extra: Record<string, unknown> = {}): Promise<void> {
        const at = stamp();
        const content = String(extra['content'] ?? `orig ${id}`);
        await graph.upsertNode({ id, type: 'note', label: `L-${id}`, content, tags: [], project: WS, ecosystem: '*', metadata: '{}',
            security_scopes: scopes, createdAt: at, updatedAt: at, ...extra } as never);
        await vector.store({ id: `lore:${id}`, text: `L-${id}\n${content}`,
            metadata: { type: 'note', label: `L-${id}`, tags: '', project: WS, ecosystem: '*', updatedAt: at, security_scopes: scopes } as never });
    }
    const rawRow = async (id: string): Promise<string> =>
        JSON.stringify((await http.query(DB, 'SELECT * FROM LoreVerbatim WHERE id = :id', { id })).result ?? null);
    /** The node (as stored) + its raw canonical row; equal strings = nothing was touched. */
    const snap = async (id: string): Promise<string> =>
        JSON.stringify({ node: await graph.getNode(id), row: await rawRow(`lore:${id}`) });
    const edge = (s: string, t: string) => ({ sourceId: s, targetId: t, relation: 'depends_on', confidence: 'extracted', confidenceScore: 1 });
    const edgeExists = async (s: string, t: string): Promise<boolean> =>
        (await graph.queryEdges({ source: s, target: t, limit: 10, offset: 0 } as never)).length > 0;
    const idsIn = (o: Out): string[] => {
        const arr = Object.values(jsonOf(o)).find((v) => Array.isArray(v)) as Array<{ id?: string }> | undefined;
        return (arr ?? []).map((n) => String(n.id));
    };

    /* ═══ READS (3.29 contract) ═══════════════════════════════════════════ */
    console.log('\nread doors over real Arcade (bound [x] / hidden [y])');

    const nodeRoutes: Array<[string, string]> = [['GET /api/node', '/api/node'], ['GET /api/node-full', '/api/node-full']];
    for (const [label, base] of nodeRoutes) {
        await test(`R ${label}: hidden == missing; visible works; unbound reads hidden; hidden neighbour/edge never leaks`, async () => {
            const pre = base.replace(/\W/g, '');
            await seed(`${pre}-vis`, X); await seed(`${pre}-vis2`, X); await seed(`${pre}-hid`, Y);
            await graph.addEdge(edge(`${pre}-vis`, `${pre}-vis2`) as never);
            await graph.addEdge(edge(`${pre}-vis`, `${pre}-hid`) as never);
            const get = (who: Who, id: string) => rest(who, 'GET', `${base}?id=${id}&workspace=${WS}`, undefined, (rq, rs, u, p) => tryNodesRoutes(rq, rs, u, p, restDeps));
            const before = await snap(`${pre}-hid`);
            const hidden = await get('x', `${pre}-hid`);
            const missing = await get('x', `${pre}-nope`);
            assert.equal(missing.status, 404, missing.body);
            sameAsMissing(hidden, `${pre}-hid`, missing, `${pre}-nope`, label);
            assert.equal(await snap(`${pre}-hid`), before);
            const vis = await get('x', `${pre}-vis`);
            assert.equal(vis.status, 200, vis.body);
            if (base === '/api/node') assert.match(vis.body, new RegExp(`${pre}-vis2`), 'visible neighbour present');
            assert.doesNotMatch(vis.body, new RegExp(`${pre}-hid`), 'hidden neighbour / edge / label must not leak');
            assert.equal((await get('unbound', `${pre}-hid`)).status, 200, 'unbound reads the hidden node');
            if (base === '/api/node') assert.match((await get('unbound', `${pre}-vis`)).body, new RegExp(`${pre}-hid`), 'unbound still sees the hidden neighbour');
        });
    }

    await test('R GET /api/node-list + POST /api/nodes/bulk-list: hidden rows absent, page still filled with visible rows', async () => {
        for (let i = 1; i <= 5; i++) await seed(`rl-v${i}`, X);
        for (let i = 1; i <= 3; i++) await seed(`rl-h${i}`, Y); // newest => the raw first page is mostly hidden
        const list = (who: Who) => rest(who, 'GET', `/api/node-list?workspace=${WS}&limit=4`, undefined, (rq, rs, u, p) => tryInspectRoutes(rq, rs, u, p, restDeps));
        const blist = (who: Who) => rest(who, 'POST', '/api/nodes/bulk-list', { workspace: WS, limit: 4 }, (rq, rs, u, p) => tryBulkListRoutes(rq, rs, u, p, restDeps));
        for (const [name, run] of [['node-list', list], ['bulk-list', blist]] as const) {
            const b = await run('x');
            assert.equal(b.status, 200, b.body);
            const ids = idsIn(b);
            assert.equal(ids.length, 4, `${name}: page filled to the limit with visible rows: ${b.body.slice(0, 400)}`);
            assert.ok(ids.every((i) => i.startsWith('rl-v')), `${name}: only visible rows: ${ids}`);
            assert.doesNotMatch(b.body, /rl-h\d/, `${name}: no hidden id/label anywhere in the body`);
            const u = idsIn(await run('unbound'));
            assert.ok(u.some((i) => i.startsWith('rl-h')), `${name}: unbound still lists the hidden rows: ${u}`);
        }
    });

    await test('R search: GET /api/search (keyword scan + hybrid retrieve) hides the node; unbound finds it', async () => {
        await seed('rs-vis', X, { content: 'zebraquux visible body' });
        await seed('rs-hid', Y, { content: 'zebraquux hidden body' });
        const search = (who: Who, workspace: string) => rest(who, 'GET', `/api/search?q=zebraquux&workspace=${encodeURIComponent(workspace)}`, undefined,
            (rq, rs, u, p) => trySearchRoutes(rq, rs, u, p, { ...(restDeps as object), workspaceVerbatimResolver: undefined } as never));
        // '*' = the keyword graph scan; a principal-free bound actor is how a cross-workspace read reaches it.
        const star = await runWithActor({ portalUserId: 'u-x', scopes: X }, () => rest('unbound', 'GET', '/api/search?q=zebraquux&workspace=*', undefined,
            (rq, rs, u, p) => trySearchRoutes(rq, rs, u, p, restDeps)));
        assert.equal(star.status, 200, star.body);
        assert.match(star.body, /rs-vis/); assert.doesNotMatch(star.body, /rs-hid|hidden body/);
        const named = await search('x', WS);
        assert.equal(named.status, 200, named.body);
        assert.doesNotMatch(named.body, /rs-hid|hidden body/, 'hybrid retrieve must not surface the hidden node');
        const unb = await search('unbound', WS);
        assert.match(unb.body, /rs-hid/, 'unbound caller finds the hidden node');
    });

    await test('R GET /api/edges: an edge with a hidden endpoint is absent; unbound lists it', async () => {
        await seed('re-vis', X); await seed('re-vis2', X); await seed('re-hid', Y);
        await graph.addEdge(edge('re-vis', 're-vis2') as never);
        await graph.addEdge(edge('re-vis', 're-hid') as never);
        await graph.addEdge(edge('re-hid', 're-vis2') as never);
        const edges = (who: Who) => rest(who, 'GET', `/api/edges?workspace=${WS}&limit=1000`, undefined, (rq, rs, u, p) => tryEdgesRoutes(rq, rs, u, p, restDeps));
        const b = await edges('x');
        assert.equal(b.status, 200, b.body);
        assert.match(b.body, /re-vis2/);
        assert.doesNotMatch(b.body, /re-hid/, 'no edge naming a hidden endpoint');
        assert.match((await edges('unbound')).body, /re-hid/);
    });

    await test('R GET /api/verbatim/get + /api/verbatim/history: hidden row == missing id; visible works; unbound reads', async () => {
        await seed('rv-vis', X); await seed('rv-hid', Y);
        await vector.store({ id: 'doc-rv-hid', text: 'bare hidden doc', metadata: { type: 'note', label: 'd', tags: '', project: WS, ecosystem: '*', updatedAt: stamp(), security_scopes: Y } as never });
        const v = (who: Who, route: string, id: string) => rest(who, 'GET', `/api/verbatim/${route}?id=${encodeURIComponent(id)}&workspace=${WS}`, undefined,
            (rq, rs, u, p) => tryVerbatimRoutes(rq, rs, u, restDeps, p));
        for (const hid of ['lore:rv-hid', 'doc-rv-hid']) {
            const before = await rawRow(hid);
            const hidden = await v('x', 'get', hid);
            const missing = await v('x', 'get', 'lore:rv-nope');
            assert.equal(missing.status, 404, missing.body);
            sameAsMissing(hidden, hid, missing, 'lore:rv-nope', `verbatim get ${hid}`);
            assert.equal(await rawRow(hid), before);
            const hh = await v('x', 'history', hid);
            const hm = await v('x', 'history', 'lore:rv-nope');
            if (hh.status !== 501) sameAsMissing(hh, hid, hm, 'lore:rv-nope', `verbatim history ${hid}`);
            assert.equal((await v('unbound', 'get', hid)).status, 200, `unbound reads ${hid}`);
        }
        assert.equal((await v('x', 'get', 'lore:rv-vis')).status, 200);
    });

    await test('R GET /api/nodes/:id/history: hidden live node == missing id (empty); visible and unbound get rows', async () => {
        await seed('rh-vis', X); await seed('rh-hid', Y);
        for (const id of ['rh-vis', 'rh-hid']) versionRows.set(id, [{ id: `${id}-v1`, nodeId: id, version: 1, newState: { id, content: 'secret' }, previousState: null }]);
        const hist = (who: Who, id: string) => rest(who, 'GET', `/api/nodes/${id}/history?workspace=${WS}`, undefined, (rq, rs, u, p) => tryVersioningRoutes(rq, rs, u, p, restDeps));
        const hidden = await hist('x', 'rh-hid');
        const missing = await hist('x', 'rh-nope');
        sameAsMissing(hidden, 'rh-hid', missing, 'rh-nope', 'history');
        assert.equal(jsonOf(hidden)['count'], 0);
        assert.equal(jsonOf(await hist('x', 'rh-vis'))['count'], 1);
        assert.equal(jsonOf(await hist('unbound', 'rh-hid'))['count'], 1);
    });

    /* ═══ WRITES (3.30 contract) ══════════════════════════════════════════ */
    console.log('\nwrite doors over real Arcade (bound [x] / hidden [y])');

    await test('W DELETE /api/node/:id: hidden == missing (status, body, audit row); untouched; visible + unbound delete', async () => {
        await seed('dl-hid', Y); await seed('dl-vis', X); await seed('dl-hid-unb', Y);
        const del = (who: Who, id: string) => rest(who, 'DELETE', `/api/node/${id}?workspace=${WS}`, undefined, (rq, rs, u, p) => tryNodeDeleteRoute(rq, rs, u, p, restDeps));
        const auditOf = (id: string): string => norm(JSON.stringify(audit.map((a) => ({ ...a, durationMs: 0 }))), id);
        const before = await snap('dl-hid');
        audit.length = 0; const missing = await del('x', 'dl-nope'); const missingAudit = auditOf('dl-nope');
        audit.length = 0; const hidden = await del('x', 'dl-hid'); const hiddenAudit = auditOf('dl-hid');
        assert.equal(missing.status, 404, missing.body);
        sameAsMissing(hidden, 'dl-hid', missing, 'dl-nope', 'delete');
        assert.equal(hiddenAudit, missingAudit, 'same audit row');
        assert.equal(await snap('dl-hid'), before);
        assert.equal((await del('x', 'dl-vis')).status, 200);
        assert.equal(await graph.getNode('dl-vis'), null);
        assert.equal((await del('unbound', 'dl-hid-unb')).status, 200);
        assert.equal(await graph.getNode('dl-hid-unb'), null);
    });
    await test('W MCP delete_node: hidden == missing; untouched; visible + unbound delete', async () => {
        await seed('dm-hid', Y); await seed('dm-vis', X); await seed('dm-hid-unb', Y);
        const before = await snap('dm-hid');
        const missing = await mcp('x', 'delete_node', { id: 'dm-nope', workspace: WS });
        const hidden = await mcp('x', 'delete_node', { id: 'dm-hid', workspace: WS });
        assert.equal(hidden.isError, missing.isError);
        assert.equal(norm(hidden.text, 'dm-hid'), norm(missing.text, 'dm-nope'));
        assert.equal(await snap('dm-hid'), before);
        assert.equal((await mcp('x', 'delete_node', { id: 'dm-vis', workspace: WS })).json['deleted'], true);
        assert.equal((await mcp('unbound', 'delete_node', { id: 'dm-hid-unb', workspace: WS })).json['deleted'], true);
        assert.equal(await graph.getNode('dm-hid-unb'), null);
    });

    const postNode = (who: Who, body: Record<string, unknown>) =>
        rest(who, 'POST', '/api/node', { type: 'note', label: 'L', workspace: WS, supersedes: [], ...body }, (rq, rs, u, p) => tryNodesRoutes(rq, rs, u, p, restDeps));
    await test('W POST /api/node: hidden id -> 409 id_unavailable (untouched); free id created; visible upserted; unbound upserts', async () => {
        await seed('pn-hid', Y); await seed('pn-vis', X); await seed('pn-hid-unb', Y);
        const before = await snap('pn-hid');
        const hid = await postNode('x', { id: 'pn-hid', content: 'overwrite' });
        assert.equal(hid.status, 409, hid.body);
        assert.equal(jsonOf(hid)['code'], ID_UNAVAILABLE);
        assert.ok(hid.body.includes(ID_UNAVAILABLE_MESSAGE));
        assert.doesNotMatch(hid.body, /scope|permission|hidden|denied/i);
        assert.equal(await snap('pn-hid'), before);
        assert.equal((await postNode('x', { id: 'pn-free', content: 'fresh' })).status, 201);
        assert.equal((await graph.getNode('pn-free'))?.content, 'fresh');
        assert.equal((await postNode('x', { id: 'pn-vis', content: 'changed' })).status, 200);
        assert.equal((await graph.getNode('pn-vis'))?.content, 'changed');
        assert.equal((await postNode('unbound', { id: 'pn-hid-unb', content: 'unbound overwrite' })).status, 200);
        assert.equal((await graph.getNode('pn-hid-unb'))?.content, 'unbound overwrite');
    });
    await test('W POST /api/node supersedes [hidden] == supersedes [missing]; nothing written; visible + unbound work', async () => {
        await seed('ps-hid', Y); await seed('ps-vis', X); await seed('ps-hid2', Y);
        const before = await snap('ps-hid');
        const missing = await postNode('x', { id: 'ps-new-a', content: 'n', supersedes: ['ps-nope'] });
        const hidden = await postNode('x', { id: 'ps-new-b', content: 'n', supersedes: ['ps-hid'] });
        assert.ok(missing.status >= 400, missing.body);
        assert.equal(hidden.status, missing.status);
        assert.equal(norm(norm(hidden.body, 'ps-hid'), 'ps-new-b'), norm(norm(missing.body, 'ps-nope'), 'ps-new-a'));
        assert.equal(await graph.getNode('ps-new-b'), null, 'the refused write created nothing');
        assert.equal(await snap('ps-hid'), before);
        assert.equal((await postNode('x', { id: 'ps-new-c', content: 'n', supersedes: ['ps-vis'] })).status, 201);
        assert.equal((await graph.getNode('ps-vis'))?.supersededBy, 'ps-new-c');
        assert.equal((await postNode('unbound', { id: 'ps-new-d', content: 'n', supersedes: ['ps-hid2'] })).status, 201);
        assert.equal((await graph.getNode('ps-hid2'))?.supersededBy, 'ps-new-d');
    });
    await test('W MCP store_node: hidden id -> isError id_unavailable (untouched); free id created; visible + unbound upsert', async () => {
        await seed('sn-hid', Y); await seed('sn-vis', X); await seed('sn-hid-unb', Y);
        const args = (o: Record<string, unknown>) => ({ type: 'note', label: 'L', workspace: WS, supersedes: [], ...o });
        const before = await snap('sn-hid');
        const hid = await mcp('x', 'store_node', args({ id: 'sn-hid', content: 'overwrite' }));
        assert.equal(hid.isError, true);
        assert.deepEqual(hid.json, { error: ID_UNAVAILABLE, message: ID_UNAVAILABLE_MESSAGE });
        assert.equal(await snap('sn-hid'), before);
        assert.equal((await mcp('x', 'store_node', args({ id: 'sn-free', content: 'fresh' }))).isError, false);
        assert.equal((await mcp('x', 'store_node', args({ id: 'sn-vis', content: 'changed' }))).isError, false);
        assert.equal((await graph.getNode('sn-vis'))?.content, 'changed');
        assert.equal((await mcp('unbound', 'store_node', args({ id: 'sn-hid-unb', content: 'u' }))).isError, false);
        assert.equal((await graph.getNode('sn-hid-unb'))?.content, 'u');
    });

    const sup = (who: Who, oldId: string, newId: string) =>
        rest(who, 'POST', '/api/node/supersede', { oldId, newId, reason: 'r', workspace: WS }, (rq, rs, u) => handleSupersede(rq, rs, u, restDeps));
    const unsup = (who: Who, id: string) =>
        rest(who, 'POST', '/api/node/unsupersede', { id, workspace: WS }, (rq, rs, u) => handleUnsupersede(rq, rs, u, restDeps));
    await test('W supersede (REST): old hidden / new hidden answer like missing ids; untouched; visible + unbound work', async () => {
        await seed('sp-hid', Y); await seed('sp-hid2', Y); await seed('sp-vis', X); await seed('sp-vis2', X);
        const b1 = await snap('sp-hid'), b2 = await snap('sp-vis');
        sameAsMissing(await sup('x', 'sp-hid', 'sp-vis'), 'sp-hid', await sup('x', 'sp-nope', 'sp-vis'), 'sp-nope', 'old hidden');
        sameAsMissing(await sup('x', 'sp-vis', 'sp-hid'), 'sp-hid', await sup('x', 'sp-vis', 'sp-nope2'), 'sp-nope2', 'new hidden');
        assert.equal(jsonOf(await sup('x', 'sp-hid', 'sp-hid2'))['reason'], 'old-not-found');
        assert.equal(await snap('sp-hid'), b1); assert.equal(await snap('sp-vis'), b2);
        assert.equal((await sup('x', 'sp-vis', 'sp-vis2')).status, 200);
        assert.equal((await graph.getNode('sp-vis'))?.supersededBy, 'sp-vis2');
        assert.equal((await sup('unbound', 'sp-hid', 'sp-hid2')).status, 200);
        assert.equal((await graph.getNode('sp-hid'))?.supersededBy, 'sp-hid2');
    });
    await test('W unsupersede (REST): hidden == missing; stays superseded; visible + unbound work', async () => {
        const sx = { supersededBy: 'x', supersededAt: stamp() };
        await seed('us-hid', Y, sx); await seed('us-vis', X, sx); await seed('us-hid-unb', Y, sx);
        const before = await snap('us-hid');
        sameAsMissing(await unsup('x', 'us-hid'), 'us-hid', await unsup('x', 'us-nope'), 'us-nope', 'unsupersede');
        assert.equal(await snap('us-hid'), before);
        assert.equal((await graph.getNode('us-hid'))?.supersededBy, 'x');
        assert.equal((await unsup('x', 'us-vis')).status, 200);
        assert.ok(!(await graph.getNode('us-vis'))?.supersededBy);
        assert.equal((await unsup('unbound', 'us-hid-unb')).status, 200);
        assert.ok(!(await graph.getNode('us-hid-unb'))?.supersededBy);
    });
    await test('W MCP supersede_node: old hidden / new hidden answer like missing ids; untouched; visible + unbound work', async () => {
        await seed('sm-hid', Y); await seed('sm-hid2', Y); await seed('sm-vis', X); await seed('sm-vis2', X);
        const s = (who: Who, o: string, n: string) => mcp(who, 'supersede_node', { old_id: o, new_id: n, reason: 'r', workspace: WS });
        const before = await snap('sm-hid');
        for (const [h, hid, m, mid] of [[await s('x', 'sm-hid', 'sm-vis'), 'sm-hid', await s('x', 'sm-nope', 'sm-vis'), 'sm-nope'],
            [await s('x', 'sm-vis', 'sm-hid'), 'sm-hid', await s('x', 'sm-vis', 'sm-nope2'), 'sm-nope2']] as const) {
            assert.equal(h.isError, m.isError);
            assert.equal(norm(h.text, hid), norm(m.text, mid));
        }
        assert.equal(await snap('sm-hid'), before);
        assert.equal((await s('x', 'sm-vis', 'sm-vis2')).isError, false);
        assert.equal((await graph.getNode('sm-vis'))?.supersededBy, 'sm-vis2');
        assert.equal((await s('unbound', 'sm-hid', 'sm-hid2')).isError, false);
        assert.equal((await graph.getNode('sm-hid'))?.supersededBy, 'sm-hid2');
    });

    await test('W mark-stale (REST + MCP): hidden nodes neither matched nor counted; unbound marks all', async () => {
        const mk = async (tag: string, ref: string) => {
            await seed(`${tag}-pub`, [], { tags: [tag] }); await seed(`${tag}-x`, X, { tags: [tag] }); await seed(`${tag}-fin`, Y, { tags: [tag] });
            await seed(`${ref}-a`, [], { tags: [ref] }); await seed(`${ref}-b`, X, { tags: [ref] });
        };
        await mk('tg-rest', 'tg-rest-ref'); await mk('tg-mcp', 'tg-mcp-ref');
        const rms = (who: Who, tags: string[]) => rest(who, 'POST', '/api/mark-stale', { tags, workspace: WS }, (rq, rs, _u, p) => tryPolicyRoutes(rq, rs, restDeps, p));
        const ref = await rms('x', ['tg-rest-ref']); const bound = await rms('x', ['tg-rest']);
        assert.equal(bound.status, 200, bound.body);
        assert.equal(jsonOf(bound)['marked'], 2, bound.body);
        assert.equal(jsonOf(bound)['marked'], jsonOf(ref)['marked']);
        assert.deepEqual(Object.keys(jsonOf(bound)).sort(), Object.keys(jsonOf(ref)).sort());
        assert.ok(!(await graph.getNode('tg-rest-fin'))?.stale, 'hidden node must not be marked');
        assert.equal(jsonOf(await rms('unbound', ['tg-rest']))['marked'], 3);
        assert.ok((await graph.getNode('tg-rest-fin'))?.stale);
        const mref = await mcp('x', 'mark_stale', { tags: ['tg-mcp-ref'], workspace: WS });
        const mb = await mcp('x', 'mark_stale', { tags: ['tg-mcp'], workspace: WS });
        assert.equal(mb.json['marked'], 2, mb.text);
        assert.equal(mb.json['marked'], mref.json['marked']);
        assert.ok(!(await graph.getNode('tg-mcp-fin'))?.stale, 'hidden node must not be marked');
        assert.equal((await mcp('unbound', 'mark_stale', { tags: ['tg-mcp'], workspace: WS })).json['marked'], 3);
    });

    const postEdge = (who: Who, s: string, t: string) => rest(who, 'POST', '/api/edge', { sourceId: s, targetId: t, relation: 'depends_on', workspace: WS }, (rq, rs, u, p) => tryEdgesRoutes(rq, rs, u, p, restDeps));
    const delEdge = (who: Who, s: string, t: string) => rest(who, 'DELETE', `/api/edge?sourceId=${s}&targetId=${t}&relation=depends_on&workspace=${WS}`, undefined, (rq, rs, u, p) => tryEdgesRoutes(rq, rs, u, p, restDeps));
    await test('W POST/DELETE /api/edge: hidden endpoint == missing endpoint; nothing written/removed; visible + unbound work', async () => {
        await seed('ed-src', X); await seed('ed-hid', Y); await seed('ed-vis', X); await seed('ed-hid-unb', Y);
        sameAsMissing(await postEdge('x', 'ed-src', 'ed-hid'), 'ed-hid', await postEdge('x', 'ed-src', 'ed-nope'), 'ed-nope', 'create, hidden target');
        sameAsMissing(await postEdge('x', 'ed-hid', 'ed-src'), 'ed-hid', await postEdge('x', 'ed-nope', 'ed-src'), 'ed-nope', 'create, hidden source');
        assert.equal(await edgeExists('ed-src', 'ed-hid'), false); assert.equal(await edgeExists('ed-hid', 'ed-src'), false);
        assert.equal((await postEdge('x', 'ed-src', 'ed-vis')).status, 200);
        assert.equal(await edgeExists('ed-src', 'ed-vis'), true);
        assert.equal((await postEdge('unbound', 'ed-src', 'ed-hid-unb')).status, 200);
        assert.equal(await edgeExists('ed-src', 'ed-hid-unb'), true);
        // delete: the edge to the hidden node exists, yet the answer equals "no such edge"
        sameAsMissing(await delEdge('x', 'ed-src', 'ed-hid-unb'), 'ed-hid-unb', await delEdge('x', 'ed-src', 'ed-nope'), 'ed-nope', 'delete, hidden endpoint');
        assert.equal(await edgeExists('ed-src', 'ed-hid-unb'), true, 'edge to the hidden node survived the bound delete');
        assert.equal((await delEdge('x', 'ed-src', 'ed-vis')).status, 200);
        assert.equal(await edgeExists('ed-src', 'ed-vis'), false);
        assert.equal((await delEdge('unbound', 'ed-src', 'ed-hid-unb')).status, 200);
        assert.equal(await edgeExists('ed-src', 'ed-hid-unb'), false);
    });
    await test('W MCP store_edge / delete_edge: hidden endpoint == missing endpoint; visible + unbound work', async () => {
        await seed('me-src', X); await seed('me-hid', Y); await seed('me-vis', X);
        const se = (who: Who, s: string, t: string) => mcp(who, 'store_edge', { sourceId: s, targetId: t, relation: 'depends_on', workspace: WS });
        const de = (who: Who, s: string, t: string) => mcp(who, 'delete_edge', { source_id: s, target_id: t, relation: 'depends_on', workspace: WS });
        const a = await se('x', 'me-src', 'me-hid'); const b = await se('x', 'me-src', 'me-nope');
        assert.equal(a.isError, b.isError); assert.equal(norm(a.text, 'me-hid'), norm(b.text, 'me-nope'));
        assert.equal(await edgeExists('me-src', 'me-hid'), false);
        assert.equal((await se('x', 'me-src', 'me-vis')).isError, false);
        assert.equal((await se('unbound', 'me-src', 'me-hid')).isError, false);
        assert.equal(await edgeExists('me-src', 'me-hid'), true);
        const d1 = await de('x', 'me-src', 'me-hid'); const d2 = await de('x', 'me-src', 'me-nope');
        assert.equal(d1.isError, d2.isError); assert.equal(norm(d1.text, 'me-hid'), norm(d2.text, 'me-nope'));
        assert.equal(await edgeExists('me-src', 'me-hid'), true, 'edge to the hidden node survived');
        assert.equal((await de('unbound', 'me-src', 'me-hid')).isError, false);
        assert.equal(await edgeExists('me-src', 'me-hid'), false);
    });

    await test('W POST /api/edges/bulk: hidden endpoint == missing endpoint per item; visible written; unbound writes', async () => {
        await seed('eb-src', X); await seed('eb-hid', Y); await seed('eb-vis', X);
        const e = (s: string, t: string) => ({ sourceId: s, targetId: t, relation: 'depends_on', bidirectional: false });
        const bnd = <T>(fn: () => Promise<T>) => as('x', fn);
        const hidden = await bnd(() => c.bulk('/api/edges/bulk', { edges: [e('eb-src', 'eb-hid')] }));
        const missing = await bnd(() => c.bulk('/api/edges/bulk', { edges: [e('eb-src', 'eb-nope')] }));
        assert.equal(hidden.status, missing.status);
        assert.equal(norm(JSON.stringify(hidden.body), 'eb-hid'), norm(JSON.stringify(missing.body), 'eb-nope'));
        assert.equal(await edgeExists('eb-src', 'eb-hid'), false);
        const mixed = await bnd(() => c.bulk('/api/edges/bulk', { edges: [e('eb-src', 'eb-vis'), e('eb-src', 'eb-hid')] }));
        assert.equal(await edgeExists('eb-src', 'eb-vis'), true, JSON.stringify(mixed.body));
        assert.equal(await edgeExists('eb-src', 'eb-hid'), false);
        await c.bulk('/api/edges/bulk', { edges: [e('eb-src', 'eb-hid')] });
        assert.equal(await edgeExists('eb-src', 'eb-hid'), true, 'unbound bulk writes the edge');
    });

    await test('W POST /api/nodes/bulk: hidden id -> per-item id_unavailable, node + row untouched; free id created', async () => {
        await seed('bn-hid', Y);
        const before = await snap('bn-hid');
        const out = await as('x', () => c.bulk('/api/nodes/bulk', { embed: 'inline', nodes: [
            { id: 'bn-hid', type: 'note', label: 'HACKED', content: 'hacked' }, { id: 'bn-free', type: 'note', label: 'F', content: 'f' }] }));
        const results = out.body['results'] as Array<{ ok: boolean; error?: string }>;
        assert.equal(results[0]!.ok, false);
        assert.match(results[0]!.error ?? '', new RegExp(`^${ID_UNAVAILABLE}: `));
        assert.equal(results[1]!.ok, true);
        assert.equal(await snap('bn-hid'), before);
    });

    const vpost = (who: Who, route: string, body: Record<string, unknown>) =>
        rest(who, 'POST', `/api/verbatim${route}`, { workspace: WS, ...body }, (rq, rs, u, p) => tryVerbatimRoutes(rq, rs, u, restDeps, p));
    await test('W POST /api/verbatim/tombstone: ArcadeVectorStore has no tombstone(): hidden == missing == 501, rows untouched', async () => {
        // SKIPPED on Arcade: the route answers 501 not_supported before any scope check because the
        // Arcade verbatim store does not implement tombstone(); the visible/unbound tombstone itself
        // cannot run here. What can be proven: the hidden answer is still identical to a missing id.
        await seed('vt-hid', Y);
        await vector.store({ id: 'doc-vt-hid', text: 'bare', metadata: { type: 'note', label: 'd', tags: '', project: WS, ecosystem: '*', updatedAt: stamp(), security_scopes: Y } as never });
        for (const hid of ['lore:vt-hid', 'doc-vt-hid']) {
            const before = await rawRow(hid);
            const hidden = await vpost('x', '/tombstone', { id: hid });
            assert.equal(hidden.status, 501, hidden.body);
            sameAsMissing(hidden, hid, await vpost('x', '/tombstone', { id: 'lore:vt-nope' }), 'lore:vt-nope', `tombstone ${hid}`);
            assert.equal(await rawRow(hid), before, `${hid} untouched`);
        }
    });
    await test('W POST /api/verbatim: hidden id -> 409 id_unavailable (row untouched); free id created; visible upserted', async () => {
        const doc = (id: string, scopes: string[]) => vector.store({ id, text: `orig ${id}`, metadata: { type: 'note', label: 'd', tags: '', project: WS, ecosystem: '*', updatedAt: stamp(), security_scopes: scopes } as never });
        await doc('doc-vc-hid', Y); await doc('doc-vc-vis', X);
        const before = await rawRow('doc-vc-hid');
        const hid = await vpost('x', '', { id: 'doc-vc-hid', text: 'overwrite' });
        assert.equal(hid.status, 409, hid.body);
        assert.equal(jsonOf(hid)['code'], ID_UNAVAILABLE);
        assert.doesNotMatch(hid.body, /scope|permission|hidden|denied/i);
        assert.equal(await rawRow('doc-vc-hid'), before);
        assert.equal((await vpost('x', '', { id: 'doc-vc-free', text: 'fresh' })).status, 200);
        assert.equal((await vector.getById('doc-vc-free'))?.text, 'fresh');
        assert.equal((await vpost('x', '', { id: 'doc-vc-vis', text: 'changed' })).status, 200);
        assert.equal((await vector.getById('doc-vc-vis'))?.text, 'changed');
        assert.equal((await vpost('unbound', '', { id: 'doc-vc-hid', text: 'unbound overwrite' })).status, 200);
        assert.equal((await vector.getById('doc-vc-hid'))?.text, 'unbound overwrite');
    });

    await test('W POST /api/recall/outcome: hidden node == missing node (nothing recorded); visible + unbound record', async () => {
        await seed('ro-hid', Y); await seed('ro-vis', X);
        const rows: unknown[] = [];
        const auxStore = { recordOutcome(o: unknown) { rows.push(o); }, getOutcomeCount: () => ({ success: rows.length, failure: 0, partial: 0 }), getOutcomes: () => [], incrementCounter() { /* */ } };
        const routeDeps = { store, deploymentMode: 'local', dataplane: null, graphRegistry: registry, auxStore } as never;
        const outc = (who: Who, id: string) => rest(who, 'POST', '/api/recall/outcome', { node_id: id, workspace: WS, outcome: 'success' }, (rq, rs, u, p) => tryRecallOutcomeRoute(rq, rs, u, p, routeDeps));
        const hidden = await outc('x', 'ro-hid'); const missing = await outc('x', 'ro-nope');
        assert.match(missing.body, /node_not_found/);
        sameAsMissing(hidden, 'ro-hid', missing, 'ro-nope', 'recall_outcome');
        assert.equal(rows.length, 0);
        assert.equal((await outc('x', 'ro-vis')).status, 200); assert.equal(rows.length, 1);
        assert.equal((await outc('unbound', 'ro-hid')).status, 200); assert.equal(rows.length, 2);
    });
}
