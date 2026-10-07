#!/usr/bin/env tsx
/**
 * test/write-scopes-nodes-unit.ts — row-level security_scopes on single-node
 * WRITE paths (slice A of the write-path scope fix).
 *
 * Contract: a BOUND actor (getCurrentActorScopes() !== undefined) who targets a
 * node hidden from them gets EXACTLY the response a missing id gets, and the
 * hidden node is untouched. A create whose caller-chosen id is held by a hidden
 * node gets 409 / isError `id_unavailable`. UNBOUND callers behave as before.
 *
 *   1. POST /api/node + store_node     create / upsert id, `supersedes` hidden == missing,
 *                                      near-duplicate hit on a hidden node is skipped
 *   2. DELETE /api/node/:id + delete_node
 *   3. supersede / unsupersede         REST + MCP supersede_node (old hidden / new hidden)
 *   4. mark_stale + POST /api/mark-stale   hidden ids are not matched, not counted
 *
 * Real LocalGraphRegistry (surreal) + the real routes/tools; every filesystem
 * touch lives under a temp LORE_HOME.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-write-scopes-nodes-'));
process.env['LORE_HOME'] = TMP_HOME;
const WS = 'ws';
const wsPath = path.join(TMP_HOME, 'workspaces', WS);
fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
function seedPolicy(enforce: boolean): void {
    fs.writeFileSync(path.join(TMP_HOME, 'workspaces.json'), JSON.stringify({
        active: WS,
        workspaces: [{
            name: WS, path: wsPath, createdAt: '2026-01-01T00:00:00Z', graphEngine: 'surreal',
            ...(enforce ? { supersessionPolicy: { enforce: true } } : {}),
        }],
    }, null, 2));
}
seedPolicy(false);

const { runWithActor } = await import('../packages/lore/src/security/actorContext.js');
const { runWithPrincipal } = await import('../packages/lore/src/auth/principal.js');
const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { LoreStorageClient } = await import('../packages/lore/src/storage/loreStorageClient.js');
const { registerMemoryTools } = await import('../packages/lore/src/mcp/tools/memory.js');
const { tryNodesRoutes } = await import('../packages/lore/src/mcp/http/routes/nodes.js');
const { tryNodeDeleteRoute } = await import('../packages/lore/src/mcp/http/routes/nodes-delete.js');
const { tryPolicyRoutes } = await import('../packages/lore/src/mcp/http/routes/retention/policy.js');
const { ID_UNAVAILABLE, ID_UNAVAILABLE_MESSAGE } = await import('../packages/lore/src/security/writeTargetGate.js');
const { nodeMutateVisible, nodeCreateIdBlocked } = await import('../packages/lore/src/security/nodeWriteGate.js');

/* ── harness ─────────────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>): void => { cases.push({ name, fn }); };
async function runAll(): Promise<void> {
    for (const c of cases) {
        try { await c.fn(); console.log(`  ✓ ${c.name}`); passed++; }
        catch (e) { console.error(`  ✗ ${c.name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
    }
}

type Who = 'unbound' | 'sales';
/** unbound = no actor; sales = bound actor holding the `sales` scope only. */
function as<T>(who: Who, fn: () => Promise<T>): Promise<T> {
    if (who === 'unbound') return fn();
    // A bound request carries the actor's scopes AND an app principal for the workspace.
    return runWithPrincipal({ kind: 'app', workspace: WS, scopes: ['read', 'write'], label: 't', allowedWorkspaces: [WS] } as never,
        () => runWithActor({ portalUserId: 'u-sales', scopes: ['sales'] }, fn));
}

function fakeReq(method: string, body?: unknown): IncomingMessage {
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
interface FakeRes { _status: number; _body: string }
function fakeRes(): ServerResponse & FakeRes {
    const r = {
        _status: 0, _body: '', statusCode: 0, headersSent: false,
        writeHead(status: number) { (this as FakeRes)._status = status; (this as { statusCode: number }).statusCode = status; return this; },
        setHeader() { return this; },
        end(body?: string) { (this as FakeRes)._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & FakeRes;
}
const jsonOf = (r: FakeRes): Record<string, any> => { try { return JSON.parse(r._body); } catch { return {}; } };

/* ── real stack ──────────────────────────────────────────────────────── */

let nextDupHit: { id: string; score: number } | null = null;
const verbatim = {
    async initialize() { /* */ },
    async count() { return 0; },
    async search() { return nextDupHit ? [{ id: nextDupHit.id, score: nextDupHit.score, text: '', metadata: {} }] : []; },
    async bm25Search() { return []; },
    async getById() { return null; },
    async store() { /* */ },
    async delete() { /* */ },
    async tombstone() { /* */ },
};

const registry = new LocalGraphRegistry();
const graph = await registry.getGraphHandle(WS) as unknown as {
    upsertNode(n: Record<string, unknown>): Promise<unknown>;
    getNode(id: string): Promise<Record<string, any> | null>;
    close(): Promise<void>;
};
const storageClient = LoreStorageClient.fromLocal({ graph: graph as never, verbatim: verbatim as never });
const store = { loreGraph: graph, loreVerbatim: verbatim, storageClient, sessionCache: { pushNode: () => undefined } } as never;
const audit: Array<Record<string, unknown>> = [];
const auditLog = { log: (e: Record<string, unknown>) => { audit.push(e); } } as never;

function toolsFor(enforceDefault?: boolean): Record<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>> {
    const tools: Record<string, any> = {};
    const server = { tool: (name: string, ..._r: unknown[]) => { const h = _r[_r.length - 1]; if (typeof h === 'function') tools[name] = h; } };
    registerMemoryTools(server as never, {
        store, configManager: { read: () => ({ pluginConfig: {} }) } as never, auditLog,
        detectedScope: { workspace: WS, ecosystem: '*' },
        getWal: () => ({ append: () => undefined } as never),
        domain: 'lore', edgeRelations: ['related_to', 'supersedes'],
        nodeTypesEnum: z.enum(['decision', 'note']), nodeTypesDescription: 'decision|note',
        edgeRelationsEnum: z.enum(['related_to', 'supersedes']),
        graphRegistry: registry, coreNodeTypes: ['decision', 'note'],
        supersessionEnforceDefault: enforceDefault,
    } as never);
    return tools;
}
const tools = toolsFor();
const restDeps = { store, auditLog, deploymentMode: 'local', dataplane: null, graphRegistry: registry, detectedScope: { workspace: WS, ecosystem: '*' } } as never;

async function mcp(name: string, args: Record<string, unknown>, t = tools) {
    const r = await t[name]!(args);
    let json: Record<string, any> = {};
    try { json = JSON.parse(r.content[0]!.text); } catch { /* non-JSON */ }
    return { text: r.content[0]!.text, isError: r.isError === true, json };
}

const now = new Date().toISOString();
async function seed(id: string, scopes: string[], extra: Record<string, unknown> = {}): Promise<void> {
    await graph.upsertNode({
        id, type: 'decision', label: `Label ${id}`, content: `orig ${id}`, tags: '', project: WS, ecosystem: '*',
        security_scopes: scopes, metadata: '{}', createdAt: now, updatedAt: now, syncedAt: null, ...extra,
    });
}
/** Replace a node's own id with a placeholder so a hidden-vs-missing pair compares byte-for-byte. */
const norm = (s: string, id: string): string => s.split(id).join('<ID>');
async function untouched(id: string, content: string): Promise<void> {
    const n = await graph.getNode(id);
    assert.ok(n, `${id} must still exist`);
    assert.equal(n!['content'], content, `${id} content must be unchanged`);
    assert.ok(!n!['supersededBy'], `${id} must not be superseded`);
}

/* ── 0. helper short-circuit ─────────────────────────────────────────── */
console.log('0. unbound short-circuit');
test('unbound callers: no lookups at all', async () => {
    const boom = new Proxy({}, { get() { throw new Error('lookup must not run'); } });
    const h = { workspace: WS, store: boom as never, graphRegistry: boom as never, versionStore: boom as never };
    assert.equal(await nodeMutateVisible('x', h), true);
    assert.equal(await nodeCreateIdBlocked('x', h), false);
});

/* ── 1a. POST /api/node ──────────────────────────────────────────────── */
console.log('1a. POST /api/node');
async function postNode(who: Who, body: Record<string, unknown>) {
    const res = fakeRes();
    const handled = await as(who, () => tryNodesRoutes(fakeReq('POST', { type: 'decision', label: 'L', workspace: WS, supersedes: [], ...body }), res, '/api/node', '/api/node', restDeps));
    assert.equal(handled, true);
    return res;
}
test('hidden id: 409 id_unavailable, node untouched; free id created; visible id upserted; unbound unchanged', async () => {
    await seed('pn-hid', ['finance']); await seed('pn-vis', ['sales']); await seed('pn-hid-unb', ['finance']);
    const hid = await postNode('sales', { id: 'pn-hid', content: 'overwrite' });
    assert.equal(hid._status, 409, hid._body);
    assert.equal(jsonOf(hid)['code'], ID_UNAVAILABLE);
    assert.ok(hid._body.includes(ID_UNAVAILABLE_MESSAGE));
    assert.doesNotMatch(hid._body, /scope|permission|hidden|finance/i);
    await untouched('pn-hid', 'orig pn-hid');
    const free = await postNode('sales', { id: 'pn-free', content: 'fresh' });
    assert.equal(free._status, 201, free._body);
    assert.equal((await graph.getNode('pn-free'))?.['content'], 'fresh');
    const vis = await postNode('sales', { id: 'pn-vis', content: 'changed' });
    assert.equal(vis._status, 200, vis._body);
    assert.equal((await graph.getNode('pn-vis'))?.['content'], 'changed');
    const unb = await postNode('unbound', { id: 'pn-hid-unb', content: 'unbound overwrite' });
    assert.equal(unb._status, 200, unb._body);
    assert.equal((await graph.getNode('pn-hid-unb'))?.['content'], 'unbound overwrite');
});
test('supersedes naming a hidden id answers exactly like a missing id; nothing written', async () => {
    await seed('ps-hid', ['finance']);
    const missing = await postNode('sales', { id: 'ps-new-a', content: 'n', supersedes: ['ps-nope'] });
    const hidden = await postNode('sales', { id: 'ps-new-b', content: 'n', supersedes: ['ps-hid'] });
    assert.ok(missing._status >= 400, `missing supersedes id must be refused: ${missing._body}`);
    assert.equal(hidden._status, missing._status);
    assert.equal(norm(norm(hidden._body, 'ps-hid'), 'ps-new-b'), norm(norm(missing._body, 'ps-nope'), 'ps-new-a'));
    assert.equal(await graph.getNode('ps-new-b'), null, 'the refused write created nothing');
    await untouched('ps-hid', 'orig ps-hid');
});
test('supersedes naming a visible id works; unbound can name a hidden id', async () => {
    await seed('ps-vis', ['sales']); await seed('ps-hid2', ['finance']);
    const ok = await postNode('sales', { id: 'ps-new-c', content: 'n', supersedes: ['ps-vis'] });
    assert.equal(ok._status, 201, ok._body);
    assert.equal((await graph.getNode('ps-vis'))?.['supersededBy'], 'ps-new-c');
    const unb = await postNode('unbound', { id: 'ps-new-d', content: 'n', supersedes: ['ps-hid2'] });
    assert.equal(unb._status, 201, unb._body);
    assert.equal((await graph.getNode('ps-hid2'))?.['supersededBy'], 'ps-new-d');
});

test('an id held only by a deleted hidden node (version log) is also refused; unbound is not', async () => {
    const versionStore = { getVersions: async (id: string, _ws: string) => id === 'pn-gone'
        ? [{ newState: null, previousState: { security_scopes: ['finance'] } }] : [] };
    const deps = { ...(restDeps as object), versionStore } as never;
    const post = async (who: Who) => {
        const res = fakeRes();
        await as(who, () => tryNodesRoutes(fakeReq('POST', { id: 'pn-gone', type: 'decision', label: 'L', content: 'c', workspace: WS, supersedes: [] }), res, '/api/node', '/api/node', deps));
        return res;
    };
    const bound = await post('sales');
    assert.equal(bound._status, 409, bound._body);
    assert.equal(jsonOf(bound)['code'], ID_UNAVAILABLE);
    assert.equal(await graph.getNode('pn-gone'), null);
    assert.equal((await post('unbound'))._status, 201);
});

/* ── 1b. store_node ──────────────────────────────────────────────────── */
console.log('1b. store_node');
const storeArgs = (o: Record<string, unknown>) => ({ type: 'decision', label: 'L', workspace: WS, supersedes: [], ...o });
test('hidden id: isError id_unavailable, node untouched; free id created; visible id upserted; unbound unchanged', async () => {
    await seed('sn-hid', ['finance']); await seed('sn-vis', ['sales']); await seed('sn-hid-unb', ['finance']);
    const hid = await as('sales', () => mcp('store_node', storeArgs({ id: 'sn-hid', content: 'overwrite' })));
    assert.equal(hid.isError, true);
    assert.deepEqual(hid.json, { error: ID_UNAVAILABLE, message: ID_UNAVAILABLE_MESSAGE });
    await untouched('sn-hid', 'orig sn-hid');
    const free = await as('sales', () => mcp('store_node', storeArgs({ id: 'sn-free', content: 'fresh' })));
    assert.equal(free.isError, false, free.text);
    assert.equal((await graph.getNode('sn-free'))?.['content'], 'fresh');
    const vis = await as('sales', () => mcp('store_node', storeArgs({ id: 'sn-vis', content: 'changed' })));
    assert.equal(vis.isError, false, vis.text);
    assert.equal((await graph.getNode('sn-vis'))?.['content'], 'changed');
    const unb = await as('unbound', () => mcp('store_node', storeArgs({ id: 'sn-hid-unb', content: 'unbound overwrite' })));
    assert.equal(unb.isError, false, unb.text);
    assert.equal((await graph.getNode('sn-hid-unb'))?.['content'], 'unbound overwrite');
});
test('supersedes naming a hidden id answers exactly like a missing id; nothing written', async () => {
    await seed('ss-hid', ['finance']);
    const missing = await as('sales', () => mcp('store_node', storeArgs({ id: 'ss-new-a', content: 'n', supersedes: ['ss-nope'] })));
    const hidden = await as('sales', () => mcp('store_node', storeArgs({ id: 'ss-new-b', content: 'n', supersedes: ['ss-hid'] })));
    assert.equal(missing.isError, true, missing.text);
    assert.equal(hidden.isError, true);
    assert.equal(norm(norm(hidden.text, 'ss-hid'), 'ss-new-b'), norm(norm(missing.text, 'ss-nope'), 'ss-new-a'));
    assert.equal(await graph.getNode('ss-new-b'), null);
    await untouched('ss-hid', 'orig ss-hid');
});
test('supersedes naming a visible id works; unbound can name a hidden id', async () => {
    await seed('ss-vis', ['sales']); await seed('ss-hid2', ['finance']);
    const ok = await as('sales', () => mcp('store_node', storeArgs({ id: 'ss-new-c', content: 'n', supersedes: ['ss-vis'] })));
    assert.equal(ok.isError, false, ok.text);
    assert.equal((await graph.getNode('ss-vis'))?.['supersededBy'], 'ss-new-c');
    const unb = await as('unbound', () => mcp('store_node', storeArgs({ id: 'ss-new-d', content: 'n', supersedes: ['ss-hid2'] })));
    assert.equal(unb.isError, false, unb.text);
    assert.equal((await graph.getNode('ss-hid2'))?.['supersededBy'], 'ss-new-d');
});
test('near-duplicate hit on a hidden node is skipped for a bound actor only (enforce on)', async () => {
    seedPolicy(true);
    const enforced = toolsFor(true);
    await seed('nd-hid', ['finance']); await seed('nd-vis', ['sales']);
    try {
        nextDupHit = { id: 'nd-hid', score: 0.95 };
        const bound = await as('sales', () => mcp('store_node', storeArgs({ id: 'nd-new-a', content: 'x' }), enforced));
        assert.notEqual(bound.json['error'], 'unlisted_near_duplicate', 'a hidden near-dup must not be reported');
        const unbound = await as('unbound', () => mcp('store_node', storeArgs({ id: 'nd-new-b', content: 'x' }), enforced));
        assert.equal(unbound.json['error'], 'unlisted_near_duplicate', 'unbound still sees the hit');
        nextDupHit = { id: 'nd-vis', score: 0.95 };
        const visible = await as('sales', () => mcp('store_node', storeArgs({ id: 'nd-new-c', content: 'x' }), enforced));
        assert.equal(visible.json['error'], 'unlisted_near_duplicate', 'a visible near-dup is still reported');
    } finally { nextDupHit = null; seedPolicy(false); }
});

/* ── 2. delete ───────────────────────────────────────────────────────── */
console.log('2. delete');
async function restDelete(who: Who, id: string) {
    const res = fakeRes();
    const handled = await as(who, () => tryNodeDeleteRoute(fakeReq('DELETE'), res, `/api/node/${id}?workspace=${WS}`, `/api/node/${id}`, restDeps));
    assert.equal(handled, true);
    return res;
}
test('REST: hidden == missing (status, body, audit row); node survives; visible deleted; unbound deleted', async () => {
    await seed('dl-hid', ['finance']); await seed('dl-vis', ['sales']); await seed('dl-hid-unb', ['finance']);
    audit.length = 0;
    const missing = await restDelete('sales', 'dl-nope');
    const missingAudit = JSON.stringify(audit.map((a) => ({ ...a, durationMs: 0 }))).split('dl-nope').join('<ID>');
    audit.length = 0;
    const hidden = await restDelete('sales', 'dl-hid');
    const hiddenAudit = JSON.stringify(audit.map((a) => ({ ...a, durationMs: 0 }))).split('dl-hid').join('<ID>');
    assert.equal(missing._status, 404);
    assert.equal(hidden._status, 404);
    assert.equal(norm(hidden._body, 'dl-hid'), norm(missing._body, 'dl-nope'));
    assert.equal(hiddenAudit, missingAudit, 'same audit row');
    await untouched('dl-hid', 'orig dl-hid');
    assert.equal((await restDelete('sales', 'dl-vis'))._status, 200);
    assert.equal(await graph.getNode('dl-vis'), null);
    assert.equal((await restDelete('unbound', 'dl-hid-unb'))._status, 200);
    assert.equal(await graph.getNode('dl-hid-unb'), null);
});
test('MCP: hidden == missing; node survives; visible deleted; unbound deleted', async () => {
    await seed('dm-hid', ['finance']); await seed('dm-vis', ['sales']); await seed('dm-hid-unb', ['finance']);
    const missing = await as('sales', () => mcp('delete_node', { id: 'dm-nope', workspace: WS }));
    const hidden = await as('sales', () => mcp('delete_node', { id: 'dm-hid', workspace: WS }));
    assert.equal(hidden.isError, missing.isError);
    assert.equal(norm(hidden.text, 'dm-hid'), norm(missing.text, 'dm-nope'));
    await untouched('dm-hid', 'orig dm-hid');
    const vis = await as('sales', () => mcp('delete_node', { id: 'dm-vis', workspace: WS }));
    assert.equal(vis.json['deleted'], true, vis.text);
    assert.equal(await graph.getNode('dm-vis'), null);
    const unb = await as('unbound', () => mcp('delete_node', { id: 'dm-hid-unb', workspace: WS }));
    assert.equal(unb.json['deleted'], true, unb.text);
    assert.equal(await graph.getNode('dm-hid-unb'), null);
});

/* ── 3. supersede / unsupersede ──────────────────────────────────────── */
console.log('3. supersede / unsupersede');
async function restSupersede(who: Who, oldId: string, newId: string) {
    const { handleSupersede } = await import('../packages/lore/src/mcp/http/routes/nodes/supersede.js');
    const res = fakeRes();
    await as(who, () => handleSupersede(fakeReq('POST', { oldId, newId, reason: 'r', workspace: WS }), res, '/api/node/supersede', restDeps));
    return res;
}
async function restUnsupersede(who: Who, id: string) {
    const { handleUnsupersede } = await import('../packages/lore/src/mcp/http/routes/nodes/supersede.js');
    const res = fakeRes();
    await as(who, () => handleUnsupersede(fakeReq('POST', { id, workspace: WS }), res, '/api/node/unsupersede', restDeps));
    return res;
}
test('REST supersede: old hidden / new hidden / both missing answer like missing ids; visible works; unbound works', async () => {
    await seed('sp-hid', ['finance']); await seed('sp-vis', ['sales']); await seed('sp-vis2', ['sales']);
    await seed('sp-hid2', ['finance']);
    // old hidden == old missing
    const oldMissing = await restSupersede('sales', 'sp-nope', 'sp-vis');
    const oldHidden = await restSupersede('sales', 'sp-hid', 'sp-vis');
    assert.equal(oldHidden._status, oldMissing._status);
    assert.equal(norm(oldHidden._body, 'sp-hid'), norm(oldMissing._body, 'sp-nope'));
    assert.equal(jsonOf(oldHidden)['reason'], 'old-not-found');
    // new hidden == new missing
    const newMissing = await restSupersede('sales', 'sp-vis', 'sp-nope2');
    const newHidden = await restSupersede('sales', 'sp-vis', 'sp-hid');
    assert.equal(newHidden._status, newMissing._status);
    assert.equal(norm(newHidden._body, 'sp-hid'), norm(newMissing._body, 'sp-nope2'));
    assert.equal(jsonOf(newHidden)['reason'], 'new-not-found');
    // both hidden == both missing (old is checked first)
    const bothHidden = await restSupersede('sales', 'sp-hid', 'sp-hid2');
    assert.equal(jsonOf(bothHidden)['reason'], 'old-not-found');
    await untouched('sp-hid', 'orig sp-hid'); await untouched('sp-vis', 'orig sp-vis'); await untouched('sp-hid2', 'orig sp-hid2');
    // visible works
    const ok = await restSupersede('sales', 'sp-vis', 'sp-vis2');
    assert.equal(ok._status, 200, ok._body);
    assert.equal((await graph.getNode('sp-vis'))?.['supersededBy'], 'sp-vis2');
    // unbound can supersede a hidden node
    const unb = await restSupersede('unbound', 'sp-hid', 'sp-hid2');
    assert.equal(unb._status, 200, unb._body);
    assert.equal((await graph.getNode('sp-hid'))?.['supersededBy'], 'sp-hid2');
});
test('REST unsupersede: hidden == missing (404, no write); visible works; unbound works', async () => {
    await seed('us-hid', ['finance'], { supersededBy: 'x', supersededAt: now });
    await seed('us-vis', ['sales'], { supersededBy: 'x', supersededAt: now });
    await seed('us-hid-unb', ['finance'], { supersededBy: 'x', supersededAt: now });
    const missing = await restUnsupersede('sales', 'us-nope');
    const hidden = await restUnsupersede('sales', 'us-hid');
    assert.equal(hidden._status, missing._status);
    assert.equal(norm(hidden._body, 'us-hid'), norm(missing._body, 'us-nope'));
    assert.equal((await graph.getNode('us-hid'))?.['supersededBy'], 'x', 'hidden node stays superseded');
    assert.equal((await restUnsupersede('sales', 'us-vis'))._status, 200);
    assert.ok(!(await graph.getNode('us-vis'))?.['supersededBy']);
    assert.equal((await restUnsupersede('unbound', 'us-hid-unb'))._status, 200);
    assert.ok(!(await graph.getNode('us-hid-unb'))?.['supersededBy']);
});
test('MCP supersede_node: old hidden / new hidden answer like missing ids; visible works; unbound works', async () => {
    await seed('sm-hid', ['finance']); await seed('sm-hid2', ['finance']); await seed('sm-vis', ['sales']); await seed('sm-vis2', ['sales']);
    const sup = (o: string, n: string, who: Who = 'sales') => as(who, () => mcp('supersede_node', { old_id: o, new_id: n, reason: 'r', workspace: WS }));
    const oldMissing = await sup('sm-nope', 'sm-vis');
    const oldHidden = await sup('sm-hid', 'sm-vis');
    assert.equal(oldHidden.isError, oldMissing.isError);
    assert.equal(norm(oldHidden.text, 'sm-hid'), norm(oldMissing.text, 'sm-nope'));
    const newMissing = await sup('sm-vis', 'sm-nope2');
    const newHidden = await sup('sm-vis', 'sm-hid');
    assert.equal(newHidden.isError, newMissing.isError);
    assert.equal(norm(newHidden.text, 'sm-hid'), norm(newMissing.text, 'sm-nope2'));
    assert.equal(newHidden.json['reason'], 'new-not-found');
    await untouched('sm-hid', 'orig sm-hid'); await untouched('sm-vis', 'orig sm-vis');
    const ok = await sup('sm-vis', 'sm-vis2');
    assert.equal(ok.isError, false, ok.text);
    assert.equal((await graph.getNode('sm-vis'))?.['supersededBy'], 'sm-vis2');
    const unb = await sup('sm-hid', 'sm-hid2', 'unbound');
    assert.equal(unb.isError, false, unb.text);
    assert.equal((await graph.getNode('sm-hid'))?.['supersededBy'], 'sm-hid2');
});

/* ── 4. mark-stale ───────────────────────────────────────────────────── */
console.log('4. mark-stale');
async function restMarkStale(who: Who, tags: string[]) {
    const res = fakeRes();
    await as(who, () => tryPolicyRoutes(fakeReq('POST', { tags }), res, restDeps as never, '/api/mark-stale'));
    return res;
}
test('MCP mark_stale: hidden nodes are neither matched nor counted; unbound marks all', async () => {
    await seed('ms-pub', [], { tags: 'tg-mcp' }); await seed('ms-sal', ['sales'], { tags: 'tg-mcp' }); await seed('ms-fin', ['finance'], { tags: 'tg-mcp' });
    await seed('ref-a', [], { tags: 'tg-mcp-ref' }); await seed('ref-b', ['sales'], { tags: 'tg-mcp-ref' });
    const ref = await as('sales', () => mcp('mark_stale', { tags: ['tg-mcp-ref'], workspace: WS }));
    const bound = await as('sales', () => mcp('mark_stale', { tags: ['tg-mcp'], workspace: WS }));
    assert.equal(bound.json['marked'], 2, bound.text);
    assert.equal(bound.json['marked'], ref.json['marked'], 'count equals a tag set with only visible nodes');
    assert.deepEqual(Object.keys(bound.json).sort(), Object.keys(ref.json).sort());
    assert.ok((await graph.getNode('ms-pub'))?.['stale']);
    assert.ok(!(await graph.getNode('ms-fin'))?.['stale'], 'hidden node must not be marked');
    const unb = await as('unbound', () => mcp('mark_stale', { tags: ['tg-mcp'], workspace: WS }));
    assert.equal(unb.json['marked'], 3, unb.text);
    assert.ok((await graph.getNode('ms-fin'))?.['stale']);
});
test('REST /api/mark-stale: hidden nodes are neither matched nor counted; unbound marks all', async () => {
    await seed('mr-pub', [], { tags: 'tg-rest' }); await seed('mr-sal', ['sales'], { tags: 'tg-rest' }); await seed('mr-fin', ['finance'], { tags: 'tg-rest' });
    await seed('refr-a', [], { tags: 'tg-rest-ref' }); await seed('refr-b', ['sales'], { tags: 'tg-rest-ref' });
    const ref = await restMarkStale('sales', ['tg-rest-ref']);
    const bound = await restMarkStale('sales', ['tg-rest']);
    assert.equal(bound._status, 200, bound._body);
    assert.equal(jsonOf(bound)['marked'], 2, bound._body);
    assert.equal(jsonOf(bound)['marked'], jsonOf(ref)['marked']);
    assert.equal(jsonOf(bound)['ok'], jsonOf(ref)['ok']);
    assert.ok(!(await graph.getNode('mr-fin'))?.['stale'], 'hidden node must not be marked');
    const unb = await restMarkStale('unbound', ['tg-rest']);
    assert.equal(jsonOf(unb)['marked'], 3, unb._body);
    assert.ok((await graph.getNode('mr-fin'))?.['stale']);
});

/* ── runner ──────────────────────────────────────────────────────────── */
try { await runAll(); } finally {
    try { await graph.close(); } catch { /* */ }
    try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* */ }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
