#!/usr/bin/env tsx
/**
 * sp23-rest-routes-unit.ts — SP-23 regression: test coverage for REST routes.
 *
 * Routes covered:
 *   A. orchestrations — 503 (no orchestrator), 400 (invalid body), 201 (create),
 *                       404 (tick unknown id), 200 (abort)
 *   B. storeNodeGates — unknown field → 400 + hint; legacy "project" → "workspace" hint;
 *                       vocab reject → 400; hitl without pendingOpsStore → 503
 *
 * Same dynamic-import-after-LORE_HOME pattern as sp23-mcp-tools-unit.ts so
 * workspaces.ts CONTROL_FILE points at our tmpdir.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── MUST precede any dynamic import that loads workspaces.ts ──
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sp23-rest-'));
process.env['LORE_HOME'] = TEST_HOME;

function seedWorkspaces(home: string, names: string[]): void {
    const workspaces = names.map((name) => ({
        name,
        path: path.join(home, 'workspaces', name),
        createdAt: '2026-06-10T00:00:00.000Z',
    }));
    fs.mkdirSync(home, { recursive: true });
    for (const ws of workspaces) fs.mkdirSync(path.join(ws.path, '.lore'), { recursive: true });
    fs.writeFileSync(
        path.join(home, 'workspaces.json'),
        JSON.stringify({ active: names[0]!, workspaces }, null, 2),
    );
}
seedWorkspaces(TEST_HOME, ['ws-test']);

// Dynamic imports
const { tryOrchestrationsRoutes } = await import('../packages/lore/src/mcp/http/routes/orchestrations.js');
// C1 side-door fix (prior session) — orchestration create/tick/abort now require
// a write-scoped principal (as production always binds via the dispatcher); bind
// one for the mutating-route tests below.
//
// Wave 4 sweep — tryOrchestrationsRoutes now self-gates via bindRouteTarget +
// a boot-workspace 409 (mirrors trySchemaRoutes; closes the Wave-4 adversarial-
// review HIGH finding: the route used to gate with requireWriteToWorkspace/
// requireReadFromWorkspace(principal, undefined), which always resolved to the
// token's OWN workspace and could never confine a cross-workspace request).
// Every deps object below now passes schemaWorkspace: 'ws-test' matching the
// principals' workspace, so the family's boot-workspace check passes and the
// route falls through to the handler-level assertions these tests exercise.
const { runWithPrincipal } = await import('../packages/lore/src/auth/principal.js');
const WRITE_PRINCIPAL = { kind: 'app', workspace: 'ws-test', scopes: ['read', 'write'], label: 'app-write' } as Parameters<typeof runWithPrincipal>[0];
// re-audit 2026-06-25 — a write-only token (no 'read') must NOT read orchestrations.
const WRITE_ONLY_PRINCIPAL = { kind: 'app', workspace: 'ws-test', scopes: ['write'], label: 'app-write-only' } as Parameters<typeof runWithPrincipal>[0];
// F-M04 — orchestration tick/abort drive destructive migrate phases, so they
// now require the HUMAN OPERATOR (kind:'bootstrap'); an app token is 403'd.
const OPERATOR_PRINCIPAL = { kind: 'bootstrap', workspace: 'ws-test', scopes: ['read', 'write'], label: 'bootstrap' } as Parameters<typeof runWithPrincipal>[0];
const { enforceStrictFields, enforceVocabPolicy } = await import('../packages/lore/src/mcp/http/routes/storeNodeGates.js');
const { setWorkspaceVocabPolicy } = await import('../packages/lore/src/config/workspaces.js');

// ── test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];

function test(name: string, fn: () => Promise<void> | void) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

// ── HTTP mock helpers ────────────────────────────────────────────────────────

function makeReqWithBody(body: string, method = 'POST', url = '/'): IncomingMessage {
    let consumed = false;
    return {
        method, url,
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; return this; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

const PREFIX = '/api/schema/orchestrations';

// ── A. orchestrations REST routes ────────────────────────────────────────────

interface FakeState { id: string; status: string; phases: unknown[]; currentPhaseIndex: number }

function makeMockOrchestrator(state: FakeState) {
    return {
        create(_plan: unknown, _opts: unknown): FakeState { return state; },
        async tick(id: string): Promise<FakeState> {
            if (id !== state.id) throw new Error(`no orchestration with id '${id}'`);
            return { ...state, status: 'running' };
        },
        listAll(): FakeState[] { return [state]; },
        get(id: string): FakeState | null { return id === state.id ? state : null; },
        abort(id: string, reason?: string): FakeState {
            if (id !== state.id) throw new Error(`no orchestration with id '${id}'`);
            return { ...state, status: 'aborted', ...(reason ? { note: reason } : {}) };
        },
    };
}

const fakeState: FakeState = {
    id: 'orch-1',
    status: 'running',
    phases: [{ kind: 'field.added', status: 'pending' }],
    currentPhaseIndex: 0,
};

const validPlan = {
    decomposedPlan: {
        phases: [{ kind: 'field.added', operations: [], rationale: 'test' }],
        rationale: 'test',
        originalRequest: { changeType: 'field.added', description: 'test', field: {} },
    },
    proposedBy: 'human:test',
    approvedBy: 'human:approver',
    soakSeconds: 0,
};

test('orchestrations: no orchestrator wired → 503', async () => {
    const req = makeReqWithBody('{}');
    const res = fakeRes();
    const handled = await tryOrchestrationsRoutes(req, res, PREFIX, PREFIX, { orchestrator: undefined });
    assert.ok(handled, 'route must claim the request');
    assert.equal(res._status, 503);
    const body = JSON.parse(res._body) as { code: string };
    assert.equal(body.code, 'orchestrator_unavailable');
});

test('orchestrations: invalid body (missing decomposedPlan) → 400', async () => {
    const req = makeReqWithBody(JSON.stringify({ proposedBy: 'human:x', approvedBy: 'human:y' }));
    const res = fakeRes();
    // D2-orch-1: create runs the first migrate tick → operator-gated like tick/abort.
    await runWithPrincipal(OPERATOR_PRINCIPAL, () => tryOrchestrationsRoutes(req, res, PREFIX, PREFIX, { orchestrator: makeMockOrchestrator(fakeState) as never, schemaWorkspace: 'ws-test' }));
    assert.equal(res._status, 400);
    const body = JSON.parse(res._body) as { code: string };
    assert.equal(body.code, 'invalid_orchestration_body');
});

test('orchestrations: create valid plan → 201 with initial state', async () => {
    const req = makeReqWithBody(JSON.stringify(validPlan));
    const res = fakeRes();
    // D2-orch-1: create runs the first migrate tick → operator-gated like tick/abort.
    await runWithPrincipal(OPERATOR_PRINCIPAL, () => tryOrchestrationsRoutes(req, res, PREFIX, PREFIX, { orchestrator: makeMockOrchestrator(fakeState) as never, schemaWorkspace: 'ws-test' }));
    assert.equal(res._status, 201, `expected 201 got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body) as { id: string; status: string };
    assert.equal(body.id, 'orch-1');
});

test('D2-orch-1: create with an app token is REJECTED (create runs the first migrate tick)', async () => {
    const req = makeReqWithBody(JSON.stringify(validPlan));
    const res = fakeRes();
    // An app/shared-secret token self-attesting approvedBy:"human:" must NOT be
    // able to drive a destructive orchestration via create — only the operator.
    await runWithPrincipal(WRITE_PRINCIPAL, () => tryOrchestrationsRoutes(req, res, PREFIX, PREFIX, { orchestrator: makeMockOrchestrator(fakeState) as never, schemaWorkspace: 'ws-test' }));
    assert.equal(res._status, 403, `expected 403 got ${res._status}: ${res._body}`);
    assert.equal((JSON.parse(res._body) as { code: string }).code, 'destructive_orchestration_requires_human');
});

test('orchestrations: tick unknown id → 404', async () => {
    const tickUrl = `${PREFIX}/orch-999/tick`;
    const req = makeReqWithBody('{}', 'POST', tickUrl);
    const res = fakeRes();
    await runWithPrincipal(OPERATOR_PRINCIPAL, () => tryOrchestrationsRoutes(req, res, tickUrl, tickUrl, { orchestrator: makeMockOrchestrator(fakeState) as never, schemaWorkspace: 'ws-test' }));
    assert.equal(res._status, 404, `expected 404 got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body) as { code: string };
    assert.equal(body.code, 'tick_failed');
});

test('orchestrations: abort → 200 with aborted state', async () => {
    const abortUrl = `${PREFIX}/orch-1/abort`;
    const req = makeReqWithBody(JSON.stringify({ reason: 'test abort' }), 'POST', abortUrl);
    const res = fakeRes();
    await runWithPrincipal(OPERATOR_PRINCIPAL, () => tryOrchestrationsRoutes(req, res, abortUrl, abortUrl, { orchestrator: makeMockOrchestrator(fakeState) as never, schemaWorkspace: 'ws-test' }));
    assert.equal(res._status, 200, `expected 200 got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body) as { status: string };
    assert.equal(body.status, 'aborted');
});

test('orchestrations: GET list with a read token → 200 (re-audit 2026-06-25)', async () => {
    const req = makeReqWithBody('', 'GET', PREFIX);
    const res = fakeRes();
    await runWithPrincipal(WRITE_PRINCIPAL, () => tryOrchestrationsRoutes(req, res, PREFIX, PREFIX, { orchestrator: makeMockOrchestrator(fakeState) as never, schemaWorkspace: 'ws-test' }));
    assert.equal(res._status, 200, `expected 200 got ${res._status}: ${res._body}`);
});

test('orchestrations: GET list with a WRITE-ONLY token → 403 scope_missing', async () => {
    const req = makeReqWithBody('', 'GET', PREFIX);
    const res = fakeRes();
    await runWithPrincipal(WRITE_ONLY_PRINCIPAL, () => tryOrchestrationsRoutes(req, res, PREFIX, PREFIX, { orchestrator: makeMockOrchestrator(fakeState) as never, schemaWorkspace: 'ws-test' }));
    assert.equal(res._status, 403, `expected 403 got ${res._status}: ${res._body}`);
    // Wave 5 — the denial comes from bindRouteTarget's writeDenial, now the
    // single canonical {code, message} envelope (was {error, reason}). The
    // machine code string is unchanged.
    assert.equal((JSON.parse(res._body) as { code: string }).code, 'scope_missing');
});

test('orchestrations: GET one with a WRITE-ONLY token → 403 (no read leak)', async () => {
    const url = `${PREFIX}/orch-1`;
    const req = makeReqWithBody('', 'GET', url);
    const res = fakeRes();
    await runWithPrincipal(WRITE_ONLY_PRINCIPAL, () => tryOrchestrationsRoutes(req, res, url, url, { orchestrator: makeMockOrchestrator(fakeState) as never, schemaWorkspace: 'ws-test' }));
    assert.equal(res._status, 403, `expected 403 got ${res._status}: ${res._body}`);
});

// ── B. storeNodeGates ────────────────────────────────────────────────────────

test('storeNodeGates: unknown field → 400 with rejected list', () => {
    const res = fakeRes();
    const result = enforceStrictFields({ id: 'x', type: 'note', label: 'x', unknownField: 'oops' }, res);
    assert.ok(result.handled, 'should handle (write response) on unknown field');
    assert.equal(res._status, 400);
    const body = JSON.parse(res._body) as { code: string; rejected: string[] };
    assert.equal(body.code, 'unknown_field');
    assert.ok(body.rejected.includes('unknownField'), `expected rejected to include unknownField, got: ${JSON.stringify(body.rejected)}`);
});

test('storeNodeGates: legacy "project" field → hint points to "workspace"', () => {
    const res = fakeRes();
    const result = enforceStrictFields({ id: 'x', type: 'note', project: 'legacy' }, res);
    assert.ok(result.handled);
    assert.equal(res._status, 400);
    const body = JSON.parse(res._body) as { hint: string };
    assert.equal(body.hint, 'workspace', `expected hint "workspace", got "${body.hint}"`);
});

test('storeNodeGates: vocab reject → 400 type_not_allowed', async () => {
    // Set up reject policy on ws-test workspace
    setWorkspaceVocabPolicy('ws-test', { mode: 'allowlist', types: ['decision'], onMismatch: 'reject' });
    const res = fakeRes();
    const result = await enforceVocabPolicy(
        { type: 'domain_event', workspace: 'ws-test' },
        res,
        { activeWorkspace: 'ws-test', coreNodeTypes: ['decision'] },
    );
    assert.ok(result.handled, 'should handle (write response) on vocab reject');
    assert.equal(res._status, 400, `expected 400 got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body) as { code: string };
    assert.equal(body.code, 'type_not_allowed');
});

test('storeNodeGates: hitl without pendingOpsStore → 503', async () => {
    // Set up hitl policy on ws-test workspace
    setWorkspaceVocabPolicy('ws-test', { mode: 'allowlist', types: ['decision'], onMismatch: 'hitl' });
    const res = fakeRes();
    const result = await enforceVocabPolicy(
        { type: 'domain_event', workspace: 'ws-test' },
        res,
        { activeWorkspace: 'ws-test', coreNodeTypes: ['decision'] },
    );
    assert.ok(result.handled, 'should handle on vocab hitl with no pendingOpsStore');
    assert.equal(res._status, 503, `expected 503 got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body) as { code: string };
    assert.equal(body.code, 'hitl_unavailable');
});

// ── runner ───────────────────────────────────────────────────────────────────

console.log('\n=== SP-23 REST routes: orchestrations + storeNodeGates ===\n');
await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
