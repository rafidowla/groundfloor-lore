#!/usr/bin/env tsx
/**
 * audit-ra2-readgates-unit.ts — re-audit 2026-06-25-reaudit2 (security).
 *
 * Several GET routes returned workspace-scoped state with NO read-scope gate, so
 * a write-only token could read it: /api/schema + /api/schema/summary (#38),
 * /api/sync/status (#37), and the schema-governance reads (#28). A write-only
 * token must be 403'd; a read token passes; a null principal (legacy/local)
 * bypasses.
 *
 * Wave 4.2 — the schema read gate moved UP from the individual sub-routes
 * (reads.ts / governance.ts) into the family dispatcher trySchemaRoutes
 * (bindRouteTarget, intent='read' for a GET). So this test now drives the schema
 * rows through trySchemaRoutes (the real entry point) with schemaWorkspace='beta'
 * (matching the principal's workspace, so the 4.2 confinement 409 is not what
 * we're asserting) — the read-scope verdict is unchanged: write-only → 403.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { trySchemaRoutes } from '../packages/lore/src/mcp/http/routes/schema.js';
import { trySyncRoutes } from '../packages/lore/src/mcp/http/routes/sync.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

type Scope = 'read' | 'write' | 'cross-workspace-read' | 'cross-workspace-write';
const appPrincipal = (scopes: Scope[]): Principal => ({ kind: 'app', workspace: 'beta', scopes, label: 't', allowedWorkspaces: ['beta'] });
const reqOf = (method: string): IncomingMessage => ({ method, on() { return this; } } as unknown as IncomingMessage);
function res(): ServerResponse & { _status: number } {
    const r = { _status: 0, writeHead(s: number) { (this as { _status: number })._status = s; return this; }, end() {} };
    return r as unknown as ServerResponse & { _status: number };
}

// Stub deps — the gate runs before any dep access on the 403 path; the "not 403"
// path may touch these (and may 500), which is fine: we only assert !== 403.
// schemaWorkspace='beta' matches the principal's workspace so the Wave-4.2
// confinement 409 never fires — this test isolates the read-scope verdict.
const schemaDeps = { schemaLoader: { getV2: () => ({}) }, phaseA: { schemaAuthoring: { listHistory: () => [] } }, schemaWorkspace: 'beta' } as never;
const syncDeps = { getSyncEngine: () => ({ getStatus: () => ({ ok: true }) }) } as never;

async function withP<T>(p: Principal | null, fn: () => T | Promise<T>): Promise<T> {
    return p ? runWithPrincipal(p, fn) : fn();
}

console.log('RA2 — read-scope gates reject write-only tokens');

for (const [name, run] of [
    ['GET /api/schema', (p: Principal | null) => withP(p, async () => { const r = res(); await trySchemaRoutes(reqOf('GET'), r, '/api/schema', '/api/schema', schemaDeps); return r; })],
    ['GET /api/sync/status', (p: Principal | null) => withP(p, async () => { const r = res(); await trySyncRoutes(reqOf('GET'), r, '/api/sync/status', '/api/sync/status', syncDeps); return r; })],
    ['GET /api/schema/history', (p: Principal | null) => withP(p, async () => { const r = res(); await trySchemaRoutes(reqOf('GET'), r, '/api/schema/history', '/api/schema/history', schemaDeps); return r; })],
] as const) {
    await test(`${name} — write-only token → 403`, async () => {
        const r = await run(appPrincipal(['write']));
        assert.equal(r._status, 403, `expected 403, got ${r._status}`);
    });
    await test(`${name} — read token → not 403`, async () => {
        const r = await run(appPrincipal(['read']));
        assert.notEqual(r._status, 403);
    });
    await test(`${name} — null principal → not 403 (legacy bypass)`, async () => {
        const r = await run(null);
        assert.notEqual(r._status, 403);
    });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
