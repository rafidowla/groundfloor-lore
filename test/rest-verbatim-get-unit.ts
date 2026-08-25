#!/usr/bin/env tsx
/**
 * test/rest-verbatim-get-unit.ts — V2 (Sprint V) GET /api/verbatim/get
 *
 * Symmetric REST counterpart of the MCP `get_verbatim` tool. Returns a
 * single canonical verbatim row by id. Differs from /api/verbatim/history
 * (full revision chain) — this one is the "current text" read.
 *
 * Spec pins (V0 audit P1 #5):
 *   T1: GET /api/verbatim/get?id=existing → 200 with {found:true, text, contentHash}
 *   T2: GET /api/verbatim/get?id=missing → 404 {found:false, id}
 *   T3: GET /api/verbatim/get (no id) → 400
 *   T4: Backend without getById → 501
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryRetentionRoutes } from '../packages/lore/src/mcp/http/routes/retention.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';

let passed = 0;
let failed = 0;
const test = (name: string, fn: () => Promise<void> | void) => {
    void Promise.resolve(fn())
        .then(() => { console.log(`  ✓ ${name}`); passed++; })
        .catch((e: Error) => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; });
};

console.log('V2 GET /api/verbatim/get');

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(s: number) { (this as { _status: number })._status = s; return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

function makeDeps(verbatim: unknown): Parameters<typeof tryRetentionRoutes>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: { loreVerbatim: verbatim as never } as never,
        auditLog: { log: () => undefined } as never,
        runRetentionSweep: async () => ({ removed: 0, archived: 0, errors: [] } as never),
    };
}

function makeReq(): IncomingMessage {
    return { method: 'GET', on: () => undefined } as unknown as IncomingMessage;
}

test('T1 existing id → 200 with text + contentHash', async () => {
    const verbatim = {
        async getById(id: string) {
            if (id === 'lore:existing') return { text: 'hello world', contentHash: 'sha256:abc' };
            return null;
        },
    };
    const res = fakeRes();
    const handled = await tryRetentionRoutes(makeReq(), res,
        '/api/verbatim/get?id=lore%3Aexisting', '/api/verbatim/get', makeDeps(verbatim));
    assert.equal(handled, true);
    assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body);
    assert.equal(body.found, true);
    assert.equal(body.id, 'lore:existing');
    assert.equal(body.text, 'hello world');
    assert.equal(body.contentHash, 'sha256:abc');
});

test('T2 missing id → 404 with {found:false, id}', async () => {
    const verbatim = {
        async getById() { return null; },
    };
    const res = fakeRes();
    await tryRetentionRoutes(makeReq(), res,
        '/api/verbatim/get?id=lore%3Aghost', '/api/verbatim/get', makeDeps(verbatim));
    assert.equal(res._status, 404);
    const body = JSON.parse(res._body);
    assert.equal(body.found, false);
    assert.equal(body.id, 'lore:ghost');
});

test('T3 no id query param → 400', async () => {
    const verbatim = { async getById() { return null; } };
    const res = fakeRes();
    await tryRetentionRoutes(makeReq(), res,
        '/api/verbatim/get', '/api/verbatim/get', makeDeps(verbatim));
    assert.equal(res._status, 400);
    assert.match(res._body, /required/);
});

test('T4 backend without getById → 501', async () => {
    // Simulate DataplaneVectorStore: no getById method
    const verbatim = {};
    const res = fakeRes();
    await tryRetentionRoutes(makeReq(), res,
        '/api/verbatim/get?id=lore%3Awhatever', '/api/verbatim/get', makeDeps(verbatim));
    assert.equal(res._status, 501);
    assert.match(res._body, /not supported/);
});

/* ---- R3 audit #1 — cross-workspace read gate on verbatim READ routes ---- */
const secretVerbatim = {
    async getById(id: string) { return { id, text: 'SECRET-alpha', contentHash: 'h' }; },
    async getHistory() { return []; },
    async search() { return []; },
};
// alpha is the active/boot workspace these routes read.
const depsAlphaActive = () => ({ ...makeDeps(secretVerbatim), detectedScope: { workspace: 'alpha' } } as Parameters<typeof tryRetentionRoutes>[4]);
const tokenFor = (ws: string): Principal => ({ kind: 'app', workspace: ws, scopes: ['read'], label: 't', allowedWorkspaces: [ws] });
const callVerbatim = (url: string, pathname: string) => {
    const res = fakeRes();
    return { res, run: (p?: Principal) => p
        ? runWithPrincipal(p, () => tryRetentionRoutes(makeReq(), res, url, pathname, depsAlphaActive()))
        : tryRetentionRoutes(makeReq(), res, url, pathname, depsAlphaActive()) };
};

test('R3#1 beta token → GET /api/verbatim/get (active=alpha) → 403 (no cross-ws verbatim read)', async () => {
    const c = callVerbatim('/api/verbatim/get?id=lore%3Ax', '/api/verbatim/get');
    await c.run(tokenFor('beta'));
    assert.equal(c.res._status, 403, c.res._body);
});
test('R3#1 alpha token → GET /api/verbatim/get → not 403 (own workspace)', async () => {
    const c = callVerbatim('/api/verbatim/get?id=lore%3Ax', '/api/verbatim/get');
    await c.run(tokenFor('alpha'));
    assert.notEqual(c.res._status, 403, c.res._body);
});
test('R3#1 null principal → GET /api/verbatim/get → not 403 (legacy bypass)', async () => {
    const c = callVerbatim('/api/verbatim/get?id=lore%3Ax', '/api/verbatim/get');
    await c.run();
    assert.notEqual(c.res._status, 403, c.res._body);
});
test('R3#1 beta token → GET /api/verbatim/history (active=alpha) → 403', async () => {
    const c = callVerbatim('/api/verbatim/history?id=lore%3Ax', '/api/verbatim/history');
    await c.run(tokenFor('beta'));
    assert.equal(c.res._status, 403, c.res._body);
});
test('R3#1 beta token → GET /api/verbatim/search?workspace=alpha → 403', async () => {
    const c = callVerbatim('/api/verbatim/search?q=x&workspace=alpha', '/api/verbatim/search');
    await c.run(tokenFor('beta'));
    assert.equal(c.res._status, 403, c.res._body);
});
test('R3#1 beta token → GET /api/verbatim/search?workspace=beta → not 403 (own workspace)', async () => {
    const c = callVerbatim('/api/verbatim/search?q=x&workspace=beta', '/api/verbatim/search');
    await c.run(tokenFor('beta'));
    assert.notEqual(c.res._status, 403, c.res._body);
});

// Allow async tests to settle before printing the summary.
await new Promise<void>((r) => setTimeout(r, 80));
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
