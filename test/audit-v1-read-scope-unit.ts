#!/usr/bin/env tsx
/**
 * audit-v1-read-scope-unit.ts — deep-audit 2026-06-25 (LOW, cross-workspace
 * read leak).
 *
 * The /v1 tabular surface gated WRITES (denyCollectionWrite, L-067) but not
 * READS. routeDeps() routes to the REQUESTED workspace (the X-Lore-Workspace
 * tenant header via getCurrentWorkspaceId()), so a workspace-A token presenting
 * an X-Lore-Workspace: B header could GET/query/count B's collection rows.
 * denyCollectionRead now gates GET single-row, POST /query, and POST /count
 * with requireReadFromWorkspace — mirroring the write gate.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';
import { tryCollectionsRoutes } from '../packages/lore/src/mcp/http/routes/collections.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

type Scope = 'read' | 'write' | 'cross-workspace-read' | 'cross-workspace-write';
function appPrincipal(workspace: string, scopes: Scope[]): Principal {
    return { kind: 'app', workspace, scopes, label: 't', allowedWorkspaces: [workspace] };
}

function req(method: string, body: string): IncomingMessage {
    let consumed = false;
    return {
        method,
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
function res(): ServerResponse & { _status: number; _body: string } {
    const r = { _status: 0, _body: '', writeHead(s: number) { (this as { _status: number })._status = s; return this; }, end(b?: string) { (this as { _body: string })._body = b ?? ''; } };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

// Minimal table storage — reads must never 403 from here; the gate runs first.
const stubStorage = {
    async getByKey() { return null; },
    async query() { return []; },
    async count() { return 0; },
} as never;
const deps = { tableStorage: stubStorage } as never;

async function read(path: string, method: string, p: Principal | null, requestedWs: string | null): Promise<ServerResponse & { _status: number; _body: string }> {
    const r = res();
    const run = () => tryCollectionsRoutes(req(method, '{}'), r, path, path, deps);
    const withWs = () => (requestedWs ? runWithWorkspace({ workspaceId: requestedWs }, run) : run());
    await (p ? runWithPrincipal(p, withWs) : withWs());
    return r;
}

console.log('AUDIT /v1 read-scope — tabular reads gate cross-workspace access');

await test('GET /v1/orders/o1 — beta token + workspace alpha → 403 workspace_forbidden', async () => {
    const r = await read('/v1/orders/o1', 'GET', appPrincipal('beta', ['read', 'write']), 'alpha');
    assert.equal(r._status, 403, r._body);
    assert.match(r._body, /workspace_forbidden/);
});

await test('POST /v1/orders/query — beta token + workspace alpha → 403', async () => {
    const r = await read('/v1/orders/query', 'POST', appPrincipal('beta', ['read', 'write']), 'alpha');
    assert.equal(r._status, 403, r._body);
    assert.match(r._body, /workspace_forbidden/);
});

await test('POST /v1/orders/count — beta token + workspace alpha → 403', async () => {
    const r = await read('/v1/orders/count', 'POST', appPrincipal('beta', ['read', 'write']), 'alpha');
    assert.equal(r._status, 403, r._body);
    assert.match(r._body, /workspace_forbidden/);
});

await test('RA2: GET /v1/schema/orders — beta token + workspace alpha → 403 (schema-meta read gate)', async () => {
    const r = await read('/v1/schema/orders', 'GET', appPrincipal('beta', ['read', 'write']), 'alpha');
    assert.equal(r._status, 403, r._body);
    assert.match(r._body, /workspace_forbidden/);
});

await test('GET own workspace → not 403 (beta token, workspace beta)', async () => {
    const r = await read('/v1/orders/o1', 'GET', appPrincipal('beta', ['read', 'write']), 'beta');
    assert.notEqual(r._status, 403, r._body);
});

await test('cross-workspace-read token → not 403 (beta token + workspace alpha)', async () => {
    const r = await read('/v1/orders/o1', 'GET', appPrincipal('beta', ['read', 'cross-workspace-read']), 'alpha');
    assert.notEqual(r._status, 403, r._body);
});

await test('null principal → not 403 (legacy/local bypass)', async () => {
    const r = await read('/v1/orders/o1', 'GET', null, 'alpha');
    assert.notEqual(r._status, 403, r._body);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
