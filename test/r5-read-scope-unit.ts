#!/usr/bin/env tsx
/**
 * r5-read-scope-unit.ts — R5 audit #1 + #2. Two pure-read routes resolved a
 * caller-supplied workspace and returned its data with NO requireReadFromWorkspace
 * gate (gateRoute('read') is a no-op for the workspace boundary in local mode):
 *   #1 GET /api/nodes/:id/anchors → another workspace's anchors (source URLs).
 *   #2 GET /api/prune-jobs/:id    → another workspace's prune-job record.
 * Fixed by gating on the requested workspace (#1) / the fetched job.workspace (#2).
 *
 * Run: npm run test:unit:r5-read-scope
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { tryAnchorsRoutes } from '../packages/lore/src/mcp/http/routes/anchors.js';
import { tryLifecycleRoutes } from '../packages/lore/src/mcp/http/routes/lifecycle.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

type Scope = 'read' | 'write' | 'cross-workspace-read' | 'cross-workspace-write';
const principal = (ws: string, scopes: Scope[] = ['read']): Principal =>
    ({ kind: 'app', workspace: ws, scopes, label: 't', allowedWorkspaces: [ws] });

function req(method: string, url: string): IncomingMessage {
    return { method, url, on: () => undefined } as unknown as IncomingMessage;
}
function res(): ServerResponse & { _status: number; _body: string } {
    const r = { _status: 0, _body: '', writeHead(s: number) { (this as { _status: number })._status = s; return this; }, end(b?: string) { (this as { _body: string })._body = b ?? ''; } };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

const fakeGraph = { async initialize() {}, async getNode() { return { id: 'n1', label: 'L', anchors: '[{"type":"url","ref":"https://secret.example/A"}]', anchor_stale: false }; } } as never;
const anchorsDeps = { store: { loreGraph: fakeGraph }, deploymentMode: 'local', dataplane: null, graphRegistry: { getOrOpen: async () => fakeGraph, getGraphHandle: async () => fakeGraph } } as never;
const lifecycleDeps = { deploymentMode: 'local', dataplane: null, auxStore: { getPruneJob: (id: string) => ({ job_id: id, workspace: 'alpha', options: {}, result: { archived: 3, hardDeleted: 0, skipped: 0, protectedCount: 1 } }) } } as never;

console.log('R5 #1/#2 — cross-workspace read gates on anchors + prune-jobs');

async function anchors(p: Principal | null) {
    const r = res();
    const url = '/api/nodes/n1/anchors?workspace=alpha';
    const run = () => tryAnchorsRoutes(req('GET', url), r, url, '/api/nodes/n1/anchors', anchorsDeps);
    await (p ? runWithPrincipal(p, run) : run());
    return r;
}
await test('#1 beta token → GET anchors?workspace=alpha → 403 (no foreign anchor/source-URL read)', async () => {
    const r = await anchors(principal('beta'));
    assert.equal(r._status, 403, r._body);
    assert.match(r._body, /workspace_forbidden/);
    assert.ok(!r._body.includes('secret.example'), 'foreign anchor URL must not leak');
});
await test('#1 alpha token → GET anchors?workspace=alpha → not 403 (own workspace)', async () => {
    assert.notEqual((await anchors(principal('alpha')))._status, 403);
});
await test('#1 cross-workspace-read token → not 403', async () => {
    assert.notEqual((await anchors(principal('beta', ['read', 'cross-workspace-read'])))._status, 403);
});
await test('#1 null principal → not 403 (legacy bypass)', async () => {
    assert.notEqual((await anchors(null))._status, 403);
});

async function pruneJob(p: Principal | null) {
    const r = res();
    const url = '/api/prune-jobs/j1';
    const run = () => tryLifecycleRoutes(req('GET', url), r, url, '/api/prune-jobs/j1', lifecycleDeps);
    await (p ? runWithPrincipal(p, run) : run());
    return r;
}
await test('#2 beta token → GET /api/prune-jobs/j1 (job.workspace=alpha) → 403', async () => {
    const r = await pruneJob(principal('beta'));
    assert.equal(r._status, 403, r._body);
    assert.match(r._body, /workspace_forbidden/);
});
await test('#2 alpha token → GET /api/prune-jobs/j1 → not 403 (own workspace)', async () => {
    assert.notEqual((await pruneJob(principal('alpha')))._status, 403);
});
await test('#2 null principal → not 403 (legacy bypass)', async () => {
    assert.notEqual((await pruneJob(null))._status, 403);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
