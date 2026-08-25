#!/usr/bin/env tsx
/**
 * r4-write-scope-unit.ts — R4 audit #1 + #2. Two write routes gated
 * requireWriteToWorkspace(principal, undefined) — which resolves to the
 * principal's OWN workspace and ALWAYS passes — while actually writing to a
 * BODY/changeset-supplied workspace. So a workspace-A token could write/mutate
 * (and, for changesets, DELETE nodes in) workspace B. Fixed by re-gating on the
 * real target (parsed.workspace / cs.workspace).
 *
 * Run: npm run test:unit:r4-write-scope
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { tryOutcomesRoutes } from '../packages/lore/src/mcp/http/routes/outcomes.js';
import { tryVersioningRoutes } from '../packages/lore/src/mcp/http/routes/versioning.js';

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

const fakeGraph = { async getNode(id: string) { return { id, type: 'note', label: 'n', content: 'c', tags: [], project: 'x', ecosystem: '*' }; }, async upsertNode(n: unknown) { return n; } } as never;
const auxStore = { recordOutcome() {}, getOutcomeCount() { return { success: 1, failure: 0, partial: 0 }; }, incrementCounter() {} } as never;
const outcomesDeps = { store: { loreGraph: fakeGraph }, auxStore, deploymentMode: 'local', dataplane: null, graphRegistry: { getOrOpen: async () => fakeGraph, getGraphHandle: async () => fakeGraph } } as never;

const versioningDeps = (csWorkspace: string) => ({
    versionStore: { createChangeset: () => 'cs1', getChangeset: () => ({ id: 'cs1', workspace: csWorkspace, status: 'open' }) },
    store: { loreGraph: fakeGraph }, deploymentMode: 'local', dataplane: null,
    graphRegistry: { getOrOpen: async () => fakeGraph, getGraphHandle: async () => fakeGraph },
} as never);

console.log('R4 #1/#2 — write routes gate on the REAL target workspace');

/* ── #1 outcomes ── */
async function outcomes(p: Principal | null, bodyWs: string) {
    const r = res();
    const run = () => tryOutcomesRoutes(req('POST', JSON.stringify({ workspace: bodyWs, status: 'success', notes: 'x' })), r, '/api/nodes/n0/outcomes', '/api/nodes/n0/outcomes', outcomesDeps);
    await (p ? runWithPrincipal(p, run) : run());
    return r;
}
await test('#1 beta token → POST outcomes{workspace:alpha} → 403', async () => {
    const r = await outcomes(appPrincipal('beta', ['read', 'write']), 'alpha');
    assert.equal(r._status, 403, r._body);
    assert.match(r._body, /workspace_forbidden/);
});
await test('#1 alpha token → POST outcomes{workspace:alpha} → not 403', async () => {
    const r = await outcomes(appPrincipal('alpha', ['read', 'write']), 'alpha');
    assert.notEqual(r._status, 403, r._body);
});
await test('#1 cross-workspace-write token → POST outcomes{workspace:alpha} → not 403', async () => {
    const r = await outcomes(appPrincipal('beta', ['read', 'write', 'cross-workspace-write']), 'alpha');
    assert.notEqual(r._status, 403, r._body);
});
await test('#1 null principal → POST outcomes → not 403 (legacy bypass)', async () => {
    const r = await outcomes(null, 'alpha');
    assert.notEqual(r._status, 403, r._body);
});

/* ── #2 changeset create + commit ── */
await test('#2 beta token → POST /api/changesets{workspace:alpha} → 403', async () => {
    const r = res();
    await runWithPrincipal(appPrincipal('beta', ['read', 'write']), () =>
        tryVersioningRoutes(req('POST', JSON.stringify({ workspace: 'alpha' })), r, '/api/changesets', '/api/changesets', versioningDeps('alpha')));
    assert.equal(r._status, 403, r._body);
    assert.match(r._body, /workspace_forbidden/);
});
await test('#2 alpha token → POST /api/changesets{workspace:alpha} → not 403', async () => {
    const r = res();
    await runWithPrincipal(appPrincipal('alpha', ['read', 'write']), () =>
        tryVersioningRoutes(req('POST', JSON.stringify({ workspace: 'alpha' })), r, '/api/changesets', '/api/changesets', versioningDeps('alpha')));
    assert.notEqual(r._status, 403, r._body);
});
await test('#2 alpha token → commit a changeset bound to beta → 403 (no cross-ws DELETE)', async () => {
    const r = res();
    await runWithPrincipal(appPrincipal('alpha', ['read', 'write']), () =>
        tryVersioningRoutes(req('POST', '{}'), r, '/api/changesets/cs1/commit', '/api/changesets/cs1/commit', versioningDeps('beta')));
    assert.equal(r._status, 403, r._body);
    assert.match(r._body, /workspace_forbidden/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
