#!/usr/bin/env tsx
/**
 * audit-wave1-authz-unit.ts — regression tests for the 2026-06-27 fresh-audit
 * Wave-1 authz fixes that don't already have dedicated coverage:
 *
 *   F-B3 — workspace mutations gate on the SPECIFIC target workspace (URL/body),
 *          not the token's own. An app token bound to ws-A must NOT be able to
 *          delete/rename/create ws-B; the bootstrap operator still may.
 *   F-B1 — the pending-op decider is bound to the AUTHENTICATED principal; a
 *          caller-supplied `decidedBy` in the body is ignored when a principal
 *          is bound (so a single principal can't approve its own op by spoofing
 *          a different decidedBy — the store's initiator!==decidedBy guard then
 *          blocks self-approval).
 *
 * (F-A1/F-A2 are covered in schema-routes-unit.ts; the store-level
 *  self-approval guard is covered in pending-ops-store-unit.ts.)
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryWorkspaceMgmtRoutes } from '../packages/lore/src/mcp/http/routes/workspaces/workspaceMgmt.js';
import { handleDecide } from '../packages/lore/src/mcp/http/routes/approvals.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

function fakeReq(method: string, url: string): IncomingMessage {
    return { method, url, on: () => { /* no body needed for the gated-deny path */ } } as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(s: number) { (this as { _status: number })._status = s; return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

// Local mode → gateRoute is a no-op, so the per-token denyWorkspaceMutation gate is what's exercised.
const wsDeps = () => ({ deploymentMode: 'local' as const, dataplane: null, auditLog: { log() { /* */ } } as never });
const APP_A: Principal = { kind: 'app', workspace: 'ws-a', scopes: ['read', 'write'], label: 'app-a' };
const BOOTSTRAP: Principal = { kind: 'bootstrap', workspace: 'ws-a', scopes: ['read', 'write'], label: 'bootstrap' };

(async () => {
    console.log('Wave-1 authz regressions (F-B3 workspace target gate, F-B1 decider binding)\n');

    // ── F-B3 ────────────────────────────────────────────────────────────────
    await test('F-B3: app token bound to ws-a CANNOT DELETE ws-b (403 workspace_forbidden, before any deletion)', async () => {
        const res = fakeRes();
        await runWithPrincipal(APP_A, () =>
            tryWorkspaceMgmtRoutes(fakeReq('DELETE', '/api/workspaces/ws-b'), res, '/api/workspaces/ws-b', '/api/workspaces/ws-b', wsDeps()),
        );
        assert.equal(res._status, 403, `expected 403, got ${res._status}: ${res._body}`);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('F-B3: app token bound to ws-a CANNOT create ws-b (403)', async () => {
        // create reads the body for {name}; supply it via a one-shot req stub.
        const body = JSON.stringify({ name: 'ws-b' });
        const req = {
            method: 'POST', url: '/api/workspaces',
            on(ev: string, cb: (chunk?: unknown) => void) { if (ev === 'data') cb(Buffer.from(body)); if (ev === 'end') cb(); return this; },
        } as unknown as IncomingMessage;
        const res = fakeRes();
        await runWithPrincipal(APP_A, () =>
            tryWorkspaceMgmtRoutes(req, res, '/api/workspaces', '/api/workspaces', wsDeps()),
        );
        assert.equal(res._status, 403, `expected 403, got ${res._status}: ${res._body}`);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('F-B3: bootstrap operator is NOT blocked by the target gate (passes it; no workspace_forbidden)', async () => {
        const res = fakeRes();
        await runWithPrincipal(BOOTSTRAP, () =>
            tryWorkspaceMgmtRoutes(fakeReq('DELETE', '/api/workspaces/ws-b'), res, '/api/workspaces/ws-b', '/api/workspaces/ws-b', wsDeps()),
        );
        // Bootstrap clears the gate; the deletion itself may then 200/400 depending on
        // config, but it must NOT be the 403 workspace_forbidden the app token hit.
        assert.doesNotMatch(res._body, /workspace_forbidden/, `bootstrap must pass the target gate; got ${res._status}: ${res._body}`);
    });

    // ── F-B1 ────────────────────────────────────────────────────────────────
    await test('F-B1: handleDecide binds decidedBy to the principal label, IGNORING a spoofed body.decidedBy', async () => {
        let recordedDecidedBy: string | undefined;
        const store = {
            async decide(input: { id: string; decision: string; decidedBy: string; reason?: string }) {
                recordedDecidedBy = input.decidedBy;
                return { id: input.id, status: 'approved', decision: input.decision, decidedBy: input.decidedBy };
            },
        } as never;
        const r = await handleDecide(
            store, 'op-1',
            { decision: 'approved', decidedBy: 'attacker-supplied' } as never,
            null,            // no Clerk actor
            null,            // no replay registry → returns the row
            'operator-principal',  // F-B1 — the authenticated principal label
        );
        assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal(recordedDecidedBy, 'operator-principal', 'decider must be the authenticated principal, not the body value');
    });

    await test('F-B1: with NO principal (local/legacy), body.decidedBy is still accepted (back-compat)', async () => {
        let recordedDecidedBy: string | undefined;
        const store = {
            async decide(input: { id: string; decision: string; decidedBy: string }) {
                recordedDecidedBy = input.decidedBy;
                return { id: input.id, status: 'approved', decision: input.decision, decidedBy: input.decidedBy };
            },
        } as never;
        const r = await handleDecide(store, 'op-2', { decision: 'approved', decidedBy: 'local-operator' } as never, null, null, null);
        assert.equal(r.status, 200);
        assert.equal(recordedDecidedBy, 'local-operator', 'no principal → body.decidedBy preserved (legacy/local path)');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
